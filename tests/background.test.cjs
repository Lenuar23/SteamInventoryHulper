const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const steamId = '76561198012345678';
const ok = data => ({ ok: true, status: 200, json: async () => data });

function setup(fetchImpl, options = {}) {
    let listener;
    const requests = [];
    const requestTimes = [];
    const tabs = { created: [], removed: [] };
    const runtime = {
        onMessage: { addListener(callback) { listener = callback; } },
        lastError: undefined
    };
    let now = options.now ?? 1800000000000;
    class TestDate extends Date { static now() { return now; } }
    const stored = options.stored || {};
    const storage = { gets: [], sets: [] };
    const timers = [];
    vm.runInNewContext(source, {
        AbortController,
        Date: TestDate,
        CompressionStream,
        DecompressionStream,
        Response,
        Blob,
        atob,
        btoa,
        fetch: async (url, init) => {
            requests.push(url);
            requestTimes.push(now);
            return fetchImpl(url, init, requests.length);
        },
        setTimeout: (callback, ms) => {
            timers.push(ms);
            const chosenDelay = options.timerDelay?.(ms);
            const fastForward = ms <= 7000 || (options.immediateTimeout && ms === 15000);
            return setTimeout(() => {
                if (fastForward) now += ms;
                callback();
            }, chosenDelay ?? (fastForward ? 0 : ms));
        },
        clearTimeout,
        chrome: {
            runtime,
            storage: options.storage === false ? undefined : { local: {
                get(key, callback) {
                    storage.gets.push(key);
                    if (options.getError) throw new Error('Storage unavailable');
                    callback({ [key]: stored[key] });
                },
                set(data, callback) {
                    storage.sets.push(data);
                    if (options.setError) runtime.lastError = { message: 'Storage quota exceeded' };
                    else Object.assign(stored, structuredClone(data));
                    callback();
                    runtime.lastError = undefined;
                }
            } },
            tabs: {
                create(info, callback) {
                    tabs.created.push(info);
                    if (options.scanError) runtime.lastError = { message: options.scanError };
                    callback(options.scanError ? undefined : { id: 42 });
                    runtime.lastError = undefined;
                },
                remove(id, callback) {
                    tabs.removed.push(id);
                    callback();
                }
            }
        }
    }, { filename: 'background.js' });
    return {
        requests,
        requestTimes,
        tabs,
        timers,
        storage,
        stored,
        advance(ms) { now += ms; },
        send(action, id = steamId, extra = {}) {
            return new Promise(resolve => listener({ action, steamId: id, ...extra }, {}, resolve));
        },
        async flush() {
            for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setTimeout(resolve, 0));
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

for (const value of [12345, '12345', 0, '0', ' 12345 ']) {
    test(`profile normalizes ${JSON.stringify(value)} as cents`, async () => {
        const env = setup(async () => ok({ totalValueCents: value, name: 'Inventory owner' }));
        const response = await env.send('fetchProfile');
        assert.equal(response.success, true);
        assert.equal(response.data.totalValueCents, Number(value));
        assert.equal(response.data.name, 'Inventory owner');
        assert.match(env.requests[0], /\/api\/dota2\/profile\/76561198012345678$/);
    });
}

test('invalid or missing totals are explicit errors, not zero', async () => {
    for (const value of [undefined, null, '', 'invalid', -1, 1.5, '1e3', Number.MAX_SAFE_INTEGER + 1]) {
        const env = setup(async () => ok({ totalValueCents: value }));
        const response = await env.send('fetchProfile');
        assert.equal(response.success, false, `accepted ${String(value)}`);
        assert.match(response.error, /totalValueCents/);
        assert.equal(response.data, undefined);
    }
});

test('rejects invalid SteamIDs before contacting API', async () => {
    const env = setup(async () => { throw new Error('must not fetch'); });
    for (const id of ['../other/profile', '7656119801234567', 76561198012345678, undefined]) {
        const response = await env.send('fetchPrices', id === undefined ? null : id);
        assert.equal(response.success, false);
        assert.match(response.error, /SteamID64/);
    }
    assert.equal(env.requests.length, 0);
    assert.equal(env.tabs.created.length, 0);
});

test('profile HTTP, JSON, and service errors are surfaced', async () => {
    const cases = [
        { fetchImpl: async () => ({ ok: false, status: 503 }), message: /503/ },
        { fetchImpl: async () => ok([]), message: /invalid JSON/ },
        { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }), message: /Invalid JSON/ },
        { fetchImpl: async () => ok({ success: false, error: 'Private inventory' }), message: /Private inventory/ }
    ];
    for (const { fetchImpl, message } of cases) {
        const env = setup(fetchImpl);
        const response = await env.send('fetchProfile');
        assert.equal(response.success, false);
        assert.match(response.error, message);
    }
});

test('loads more than 25 pages and respects server page size metadata', async () => {
    const env = setup(async url => {
        const page = Number(new URL(url).searchParams.get('page'));
        return ok({ items: [{ assetid: String(page), priceCents: page }], totalPages: '31' });
    });
    const response = await env.send('fetchPrices');
    assert.equal(response.success, true);
    assert.equal(response.data.items.length, 31);
    assert.equal(response.data.items[30].assetid, '31');
    assert.equal(env.requests.length, 31);
    assert.equal(env.tabs.created.length, 0);
});

test('without metadata reads a full page through the final short page', async () => {
    const env = setup(async (_, __, count) => ok({
        items: count === 1 ? Array.from({ length: 200 }, (_, id) => ({ assetid: String(id) })) : [{ assetid: '200' }]
    }));
    const response = await env.send('fetchPrices');
    assert.equal(response.success, true);
    assert.equal(response.data.items.length, 201);
    assert.equal(env.requests.length, 2);
});

test('failed later pages never return partial prices or start a scan', async () => {
    for (const secondPage of [
        { ok: false, status: 429 },
        ok({ items: 'not an array', totalPages: 2 }),
        ok({ items: [], totalPages: 2 })
    ]) {
        const env = setup(async (_, __, count) => count === 1
            ? ok({ items: [{ assetid: '1' }], totalPages: 2 })
            : secondPage);
        const response = await env.send('fetchPrices');
        assert.equal(response.success, false);
        assert.equal(response.data, undefined);
        assert.equal(env.requests.length, secondPage.status === 429 ? 4 : 2);
        assert.equal(env.tabs.created.length, 0);
    }
});

test('malformed first page does not masquerade as an empty cache', async () => {
    for (const firstPage of [{}, { items: [null] }, { items: [{}], totalPages: 0 }]) {
        const env = setup(async () => ok(firstPage));
        const response = await env.send('fetchPrices');
        assert.equal(response.success, false);
        assert.equal(env.tabs.created.length, 0);
    }
});

test('only a legitimate empty cache triggers one background scan then a fresh fetch', async () => {
    const env = setup(async (_, __, count) => count === 1
        ? ok({ items: [], totalPages: 0 })
        : ok({ items: [{ assetid: 'loaded-after-scan' }], totalPages: 1 }));
    const response = await env.send('fetchPrices');
    assert.equal(response.success, true);
    assert.equal(response.data.items[0].assetid, 'loaded-after-scan');
    assert.equal(env.requests.length, 2);
    assert.equal(env.tabs.created.length, 1);
    assert.equal(env.tabs.created[0].active, false);
    assert.match(env.tabs.created[0].url, /inventory\/76561198012345678$/);
    assert.deepEqual(env.tabs.removed, [42]);
});

test('a genuinely empty inventory finishes after the scan without looping', async () => {
    const env = setup(async () => ok({ items: [], totalPages: 1 }));
    const response = await env.send('fetchPrices');
    assert.equal(response.success, true);
    assert.equal(response.data.items.length, 0);
    assert.equal(env.requests.length, 2);
    assert.equal(env.tabs.created.length, 1);
});

test('a failed scan is explicit and does not report partial success', async () => {
    const env = setup(async () => ok({ items: [] }), { scanError: 'Cannot create a tab' });
    const response = await env.send('fetchPrices');
    assert.equal(response.success, false);
    assert.match(response.error, /Cannot create a tab/);
    assert.equal(env.requests.length, 1);
    assert.equal(env.tabs.removed.length, 0);
});

test('HTTP failure on first price page does not trigger an inventory scan', async () => {
    const env = setup(async () => ({ ok: false, status: 403 }));
    const response = await env.send('fetchPrices');
    assert.equal(response.success, false);
    assert.match(response.error, /403/);
    assert.equal(env.tabs.created.length, 0);
});

test('pagination limits and changing metadata produce errors instead of truncation', async () => {
    const tooMany = setup(async () => ok({ items: [{ assetid: '1' }], totalPages: 1001 }));
    const tooManyResponse = await tooMany.send('fetchPrices');
    assert.equal(tooManyResponse.success, false);
    assert.match(tooManyResponse.error, /1000 price pages/);
    assert.equal(tooMany.requests.length, 1);

    const changing = setup(async (_, __, count) => ok({ items: [{ assetid: String(count) }], totalPages: count === 1 ? 2 : 1 }));
    const changedResponse = await changing.send('fetchPrices');
    assert.equal(changedResponse.success, false);
    assert.match(changedResponse.error, /changed during loading/);
});

for (const action of ['fetchProfile', 'fetchPrices']) {
    test(`${action} aborts timed out requests and does not start a scan`, async () => {
        const env = setup(async (_, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
        }), { immediateTimeout: true });
        const response = await env.send(action);
        assert.equal(response.success, false);
        assert.match(response.error, /timed out/);
        assert.equal(env.tabs.created.length, 0);
    });

    test(`${action} shares in-flight work, caches success and permits a forced request`, async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const data = action === 'fetchProfile' ? { totalValueCents: '100' } : { items: [{ assetid: '1' }], totalPages: 1 };
        const env = setup(async () => { await gate; return ok(data); });
        const first = env.send(action);
        const second = env.send(action);
        await env.flush();
        assert.equal(env.requests.length, 1);
        release();
        const responses = await Promise.all([first, second]);
        assert.equal(responses[0].success, true);
        assert.equal(responses[1].success, true);
        assert.strictEqual(responses[0].data, responses[1].data);
        assert.equal(env.requests.length, 1);
        const fresh = await env.send(action);
        assert.equal(fresh.success, true);
        assert.equal(fresh.cached, true);
        assert.equal(env.requests.length, 1);
        const forced = await env.send(action, steamId, { force: true });
        assert.equal(forced.success, true);
        assert.equal(forced.cached, false);
        assert.equal(env.requests.length, 2);
    });
}

const http = (status, retryAfter) => ({
    ok: false, status, headers: { get: name => name === 'Retry-After' ? retryAfter : null }
});
const cacheKey = 'sih-lite-steamprice-cache-v1';
const owner = index => `76561198012345${String(index).padStart(3, '0')}`;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('temporary GET failures retry up to three attempts and a later success is live', async () => {
    for (const failures of [[http(502), http(503)], [http(504), http(429)], [new TypeError('Network unavailable')]]) {
        const env = setup(async (_, __, count) => {
            const response = failures[count - 1];
            if (response instanceof Error) throw response;
            return response || ok({ totalValueCents: '42' });
        });
        const result = await env.send('fetchProfile');
        assert.equal(result.success, true);
        assert.equal(result.cached, false);
        assert.equal(result.data.totalValueCents, 42);
        assert.equal(env.requests.length, failures.length + 1);
    }
    const failed = setup(async () => http(502));
    const result = await failed.send('fetchPrices');
    assert.equal(result.success, false);
    assert.match(result.error, /502/);
    assert.equal(failed.requests.length, 3);
    assert.equal(failed.tabs.created.length, 0);
});

test('permanent HTTP and malformed/service responses are never retried', async () => {
    for (const data of [http(400), http(401), http(403), http(404), http(500), ok([]), ok({ success: false, error: 'Private' }), ok({})]) {
        const env = setup(async () => data);
        assert.equal((await env.send('fetchProfile')).success, false);
        assert.equal(env.requests.length, 1);
    }
});

test('429 respects bounded Retry-After and does not retry ahead of a long cooldown', async () => {
    const env = setup(async (_, __, count) => count === 1 ? http(429, '2') : ok({ totalValueCents: 9 }), {
        timerDelay: ms => ms === 2000 ? 0 : undefined
    });
    assert.equal((await env.send('fetchProfile')).success, true);
    assert.equal(env.requests.length, 2);
    assert.ok(env.timers.includes(2000));
    const long = setup(async () => http(429, '120'));
    assert.equal((await long.send('fetchProfile')).success, false);
    assert.equal(long.requests.length, 1);
});

test('timeouts retry even when the fetch implementation ignores abort', async () => {
    const env = setup(async () => new Promise(() => {}), { immediateTimeout: true });
    const result = await env.send('fetchProfile');
    assert.equal(result.success, false);
    assert.match(result.error, /timed out/);
    assert.equal(env.requests.length, 3);
});

test('modern pagination uses row total, respects clamped page size, and ignores stacked item count', async () => {
    const env = setup(async url => {
        const page = Number(new URL(url).searchParams.get('page'));
        return ok({ items: [{ assetid: String(page), quantity: 250 }], total: '2', itemsCount: 500, page, pageSize: 1 });
    });
    const result = await env.send('fetchPrices');
    assert.equal(result.success, true);
    assert.equal(result.data.items.length, 2);
    assert.equal(env.requests.length, 2);
    const quantitiesOnly = setup(async () => ok({ items: [{ assetid: 'stack', quantity: 50 }], itemsCount: 50, pageSize: 200, totalPages: 1 }));
    assert.equal((await quantitiesOnly.send('fetchPrices')).success, true);
    assert.equal(quantitiesOnly.requests.length, 1);
});

test('modern pagination rejects incomplete, inconsistent, changing and repeated pages', async () => {
    const cases = [
        page => ({ items: [{ assetid: String(page) }], total: 3, pageSize: 2, page }),
        page => ({ items: [{ assetid: String(page) }], total: 2, pageSize: 1, page: 1 }),
        page => ({ items: [{ assetid: String(page) }], total: page === 1 ? 2 : 3, pageSize: 1, page }),
        page => ({ items: [{ assetid: String(page) }], total: 2, pageSize: page === 1 ? 1 : 2, page }),
        page => ({ items: [{ assetid: String(page) }], ...(page === 1 ? { total: 2 } : {}), totalPages: 2, pageSize: 1, page }),
        page => ({ items: [{ assetid: String(page) }], total: 2, pageSize: 1, ...(page === 1 ? { page } : {}) }),
        page => ({ items: [{ assetid: 'repeated' }], total: 2, pageSize: 1, page }),
        page => ({ items: [{ assetid: String(page) }], total: 2, pageSize: 0, page }),
        page => ({ items: [{ assetid: String(page) }], total: 2, pageSize: 1, totalPages: 3, page })
    ];
    for (const responseForPage of cases) {
        const env = setup(async url => ok(responseForPage(Number(new URL(url).searchParams.get('page')))));
        const result = await env.send('fetchPrices');
        assert.equal(result.success, false);
        assert.equal(result.data, undefined);
        assert.equal(env.tabs.created.length, 0);
    }
});

test('only the failed GET page is retried and the complete final snapshot is cached', async () => {
    let secondAttempts = 0;
    const env = setup(async url => {
        const page = Number(new URL(url).searchParams.get('page'));
        if (page === 2 && ++secondAttempts < 3) return http(502);
        return ok({ items: [{ assetid: String(page) }], total: 2, pageSize: 1, page });
    });
    const result = await env.send('fetchPrices');
    assert.equal(result.success, true);
    assert.equal(result.data.items.length, 2);
    assert.deepEqual(env.requests.map(url => new URL(url).searchParams.get('page')), ['1', '2', '2', '2']);
    assert.equal((await env.send('fetchPrices')).cached, true);
});

test('fresh snapshots persist across worker restarts with action and owner isolation', async () => {
    const stored = { unrelatedSetting: { keep: true } };
    const first = setup(async () => ok({ totalValueCents: '88' }), { stored });
    const live = await first.send('fetchProfile');
    assert.equal(live.cached, false);
    await first.flush();
    assert.ok(stored[cacheKey]);
    const restarted = setup(async url => ok(url.includes('/profile/') ? { totalValueCents: 99 } : { items: [{ assetid: '1' }] }), { stored });
    const cached = await restarted.send('fetchProfile');
    assert.equal(cached.cached, true);
    assert.equal(cached.data.totalValueCents, 88);
    assert.equal(cached.cachedAt, 1800000000000);
    assert.equal(restarted.requests.length, 0);
    assert.equal((await restarted.send('fetchPrices')).cached, false);
    assert.equal((await restarted.send('fetchProfile', owner(1))).cached, false);
    assert.equal(restarted.requests.length, 2);
    assert.deepEqual(stored.unrelatedSetting, { keep: true });
});

test('force bypasses fresh cache and retains bounded safe GET retries', async () => {
    let fail = false;
    const env = setup(async (_, __, count) => fail && count < 4 ? http(503) : ok({ totalValueCents: count }));
    assert.equal((await env.send('fetchProfile')).data.totalValueCents, 1);
    fail = true;
    const result = await env.send('fetchProfile', steamId, { force: true });
    assert.equal(result.cached, false);
    assert.equal(result.data.totalValueCents, 4);
    assert.equal(env.requests.length, 4);
});

test('expired fresh cache falls back to complete stale data only on temporary outage', async () => {
    let outage = false;
    const env = setup(async () => outage ? http(502) : ok({ totalValueCents: 123 }));
    await env.send('fetchProfile');
    env.advance(90000);
    outage = true;
    const result = await env.send('fetchProfile');
    assert.equal(result.success, true);
    assert.equal(result.cached, true);
    assert.equal(result.cachedAt, 1800000000000);
    assert.equal(result.data.totalValueCents, 123);
    assert.match(result.error, /502/);
    assert.equal(env.requests.length, 4);
    env.advance(24 * 60 * 60 * 1000);
    const expired = await env.send('fetchProfile');
    assert.equal(expired.success, false);
    assert.equal(expired.data, undefined);
});

test('403 and malformed responses never use a stale snapshot as a successful result', async () => {
    for (const failure of [http(403), ok([]), ok({}), ok({ success: false, error: 'Private inventory' })]) {
        let fail = false;
        const env = setup(async () => fail ? failure : ok({ totalValueCents: 100 }));
        await env.send('fetchProfile');
        env.advance(90000);
        fail = true;
        const result = await env.send('fetchProfile');
        assert.equal(result.success, false);
        assert.equal(result.data, undefined);
        assert.equal(env.requests.length, 2);
    }
});

test('failed later-page refresh returns the previous full snapshot and never stores partial data', async () => {
    let fail = false;
    const env = setup(async url => {
        const page = Number(new URL(url).searchParams.get('page'));
        if (fail && page === 2) return http(504);
        return ok({ items: [{ assetid: `${fail ? 'new' : 'old'}-${page}` }], total: 2, pageSize: 1, page });
    });
    await env.send('fetchPrices');
    await env.flush();
    const originalStorage = JSON.stringify(env.stored[cacheKey]);
    fail = true;
    const result = await env.send('fetchPrices', steamId, { force: true });
    assert.equal(result.cached, true);
    assert.match(result.error, /504/);
    assert.deepEqual(Array.from(result.data.items, item => item.assetid), ['old-1', 'old-2']);
    await env.flush();
    assert.equal(JSON.stringify(env.stored[cacheKey]), originalStorage);
    assert.equal(env.tabs.created.length, 0);
});

test('future, expired, malformed and wrong-owner persisted snapshots are ignored', async () => {
    const now = 1800000000000;
    for (const entry of [
        { cachedAt: now + 1, data: { totalValueCents: 1 } },
        { cachedAt: now - 86400001, data: { totalValueCents: 1 } },
        { cachedAt: now, data: { totalValueCents: false } },
        { cachedAt: now, data: { totalValueCents: 1 }, steamId: owner(1) }
    ]) {
        const stored = { [cacheKey]: { version: 1, entries: { [`fetchProfile:${steamId}`]: { action: 'fetchProfile', steamId, ...entry } } } };
        const env = setup(async () => ok({ totalValueCents: 5 }), { stored });
        const result = await env.send('fetchProfile');
        assert.equal(result.cached, false);
        assert.equal(result.data.totalValueCents, 5);
        assert.equal(env.requests.length, 1);
    }
});

test('missing storage, storage read errors and quota errors do not break successful GETs', async () => {
    for (const options of [{ storage: false }, { getError: true }, { setError: true }]) {
        const env = setup(async () => ok({ totalValueCents: 17 }), options);
        assert.equal((await env.send('fetchProfile')).cached, false);
        await env.flush();
        assert.equal((await env.send('fetchProfile')).cached, true);
        assert.equal(env.requests.length, 1);
    }
});

test('cache bucket is bounded to six recently used owners and preserves unrelated storage', async () => {
    const stored = { otherExtensionSetting: 'keep' };
    const env = setup(async () => ok({ totalValueCents: 1 }), { stored });
    for (let index = 0; index < 9; index++) {
        env.advance(1);
        await env.send('fetchProfile', owner(index));
    }
    await env.flush();
    const entries = stored[cacheKey].entries;
    assert.equal(Object.keys(entries).length, 6);
    assert.equal(entries[`fetchProfile:${owner(0)}`], undefined);
    assert.ok(entries[`fetchProfile:${owner(8)}`]);
    assert.equal(stored.otherExtensionSetting, 'keep');
    assert.ok(env.storage.sets.every(value => Object.keys(value).length === 1 && value[cacheKey]));
});

test('large compact snapshots are compressed and restored without losing pricing and gem metadata', async () => {
    const stored = {};
    const items = Array.from({ length: 200 }, (_, index) => ({
        assetid: String(index + 1), market_hash_name: 'Fractal Horns of Inner Abysm',
        priceCents: 100 + index, prismaticGems: ['Legacy (4, 90, 175)'],
        isLegacy: true, legacyRgb: { r: 4, g: 90, b: 175 },
        descriptions: Array(20).fill({ value: 'Redundant catalog text' })
    }));
    const first = setup(async () => ok({ items, totalPages: 1 }), { stored });
    await first.send('fetchPrices');
    for (let attempt = 0; attempt < 30 && stored[cacheKey]?.encoding !== 'gzip'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stored[cacheKey]?.encoding, 'gzip');
    const restarted = setup(async () => { throw new Error('Must load cache'); }, { stored });
    const result = await restarted.send('fetchPrices');
    assert.equal(result.cached, true);
    assert.equal(result.data.items.length, 200);
    assert.equal(result.data.items[0].descriptions, undefined);
    assert.equal(result.data.items[0].market_hash_name, items[0].market_hash_name);
    assert.deepEqual(Array.from(result.data.items[0].prismaticGems), items[0].prismaticGems);
    assert.equal(result.data.items[199].priceCents, items[199].priceCents);
    assert.equal(restarted.requests.length, 0);
});

test('scanning invalidates a pre-scan profile cache and marks the prices reply', async () => {
    let scanned = false;
    const env = setup(async url => {
        if (url.includes('/profile/')) return ok({ totalValueCents: scanned ? 900 : 0 });
        if (!scanned) { scanned = true; return ok({ items: [], total: 0, pageSize: 200, page: 1 }); }
        return ok({ items: [{ assetid: 'scanned-item' }], total: 1, pageSize: 200, page: 1 });
    });
    assert.equal((await env.send('fetchProfile')).data.totalValueCents, 0);
    const prices = await env.send('fetchPrices');
    assert.equal(prices.scanned, true);
    const profile = await env.send('fetchProfile');
    assert.equal(profile.cached, false);
    assert.equal(profile.data.totalValueCents, 900);
    assert.equal(env.requests.filter(url => url.includes('/profile/')).length, 2);
});

test('serial loading does not let a pre-scan profile remain fresh after inventory scanning', async () => {
    let release;
    let scanned = false;
    let profiles = 0;
    const env = setup(async url => {
        if (url.includes('/profile/')) {
            if (++profiles === 1) return new Promise(resolve => { release = () => resolve(ok({ totalValueCents: 0 })); });
            return ok({ totalValueCents: 300 });
        }
        if (!scanned) { scanned = true; return ok({ items: [], totalPages: 0 }); }
        return ok({ items: [{ assetid: 'after-scan' }], totalPages: 1 });
    });
    const initial = env.send('fetchProfile');
    await env.flush();
    const prices = env.send('fetchPrices');
    await env.flush();
    assert.equal(env.requests.length, 1);
    release();
    await initial;
    await prices;
    const current = await env.send('fetchProfile');
    assert.equal(current.cached, false);
    assert.equal(current.data.totalValueCents, 300);
    assert.equal(profiles, 2);
});

test('global limiter serializes GETs across owners and actions with paced starts', async () => {
    let active = 0;
    let maximum = 0;
    const releases = [];
    const env = setup(async url => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => releases.push(() => { active--; resolve(); }));
        return ok(url.includes('/profile/') ? { totalValueCents: 1 } : { items: [{ assetid: '1' }] });
    });
    const operations = Array.from({ length: 6 }, (_, index) => env.send(index % 2 ? 'fetchPrices' : 'fetchProfile', owner(index)));
    await env.flush();
    assert.equal(env.requests.length, 1);
    assert.equal(active, 1);
    for (let count = 0; count < 6; count++) {
        assert.ok(releases[count]);
        releases[count]();
        await env.flush();
    }
    assert.ok((await Promise.all(operations)).every(result => result.success));
    assert.equal(maximum, 1);
    assert.equal(env.requests.length, 6);
    for (let index = 1; index < env.requestTimes.length; index++) {
        assert.ok(env.requestTimes[index] - env.requestTimes[index - 1] >= 350);
    }
});

test('retry backoff releases its GET slot so queued owners can load', async () => {
    const starts = [];
    let firstAttempts = 0;
    let releaseSecond;
    const env = setup(async url => {
        const id = url.match(/profile\/(\d+)/)[1];
        starts.push(id);
        if (id === owner(0) && ++firstAttempts === 1) return http(502);
        if (id === owner(1)) await new Promise(resolve => { releaseSecond = resolve; });
        return ok({ totalValueCents: 1 });
    }, { timerDelay: ms => ms === 600 ? 20 : undefined });
    const first = env.send('fetchProfile', owner(0));
    const second = env.send('fetchProfile', owner(1));
    const third = env.send('fetchProfile', owner(2));
    await env.flush();
    assert.deepEqual(starts.slice(0, 2), [owner(0), owner(1)]);
    assert.equal(starts.includes(owner(2)), false);
    releaseSecond();
    assert.ok((await Promise.all([first, second, third])).every(result => result.success));
    assert.equal(firstAttempts, 2);
});

test('queued GETs start their request timeout only after acquiring a slot', async () => {
    const releases = [];
    const env = setup(async () => {
        await new Promise(resolve => releases.push(resolve));
        return ok({ totalValueCents: 1 });
    });
    const calls = [0, 1, 2].map(index => env.send('fetchProfile', owner(index)));
    await env.flush();
    assert.equal(env.timers.filter(ms => ms === 15000).length, 1);
    releases[0]();
    await env.flush();
    assert.equal(env.timers.filter(ms => ms === 15000).length, 2);
    releases[1]();
    await env.flush();
    assert.equal(env.timers.filter(ms => ms === 15000).length, 3);
    releases[2]();
    assert.ok((await Promise.all(calls)).every(result => result.success));
});

test('forced and ordinary callers share one actual network refresh', async () => {
    let release;
    const env = setup(async () => new Promise(resolve => { release = () => resolve(ok({ totalValueCents: 12 })); }));
    const first = env.send('fetchProfile');
    const forced = env.send('fetchProfile', steamId, { force: true });
    await env.flush();
    assert.equal(env.requests.length, 1);
    release();
    const replies = await Promise.all([first, forced]);
    assert.equal(replies[0].cached, false);
    assert.equal(replies[1].cached, false);
    assert.equal(replies[0].data.totalValueCents, 12);
});

test('profile invalidation retains the last complete total for labeled outage fallback', async () => {
    let scanned = false;
    const env = setup(async url => {
        if (url.includes('/profile/')) return scanned ? http(502) : ok({ totalValueCents: 100 });
        if (!scanned) { scanned = true; return ok({ items: [], totalPages: 0 }); }
        return ok({ items: [{ assetid: 'new-item' }], totalPages: 1 });
    });
    const initial = await env.send('fetchProfile');
    await env.send('fetchPrices');
    const current = await env.send('fetchProfile');
    assert.equal(current.success, true);
    assert.equal(current.cached, true);
    assert.equal(current.data.totalValueCents, 100);
    assert.equal(current.cachedAt, 1800000000000);
    assert.match(current.error, /502/);
    assert.equal(env.requests.filter(url => url.includes('/profile/')).length, 4);
    assert.equal(initial.data.totalValueCents, 100);
});

test('queued operation deadlines fail explicitly and release no phantom slots', async () => {
    const releases = [];
    let expireQueued = true;
    const env = setup(async () => {
        await new Promise(resolve => releases.push(resolve));
        return ok({ totalValueCents: 1 });
    }, { timerDelay: ms => expireQueued && ms === 180000 ? 0 : undefined });
    const first = env.send('fetchProfile', owner(0));
    const second = env.send('fetchProfile', owner(1));
    const queued = env.send('fetchProfile', owner(2));
    const failed = await queued;
    assert.equal(failed.success, false);
    assert.match(failed.error, /timed out/);
    assert.equal(env.requests.length, 1);
    releases[0]();
    await Promise.all([first, second]);
    expireQueued = false;
    const next = env.send('fetchProfile', owner(3));
    await env.flush();
    assert.equal(env.requests.length, 2);
    releases[1]();
    assert.equal((await next).success, true);
});

test('price records retain valuation and gem-variant identity while discarding large catalog payloads', async () => {
    const item = {
        assetid: '123', appid: 570, contextid: '2', quantity: 2, classid: '456', instanceid: '0',
        marketHashName: 'Exalted Fractal Horns of Inner Abysm',
        collectorAvgSaleCents: null, collectorLowestAskCents: '12345', priceCents: 999,
        price_cents: 888, scmPriceCents: 777, basePriceCents: 666, price: '$12.34', lowest_price: '$11', cost: 1, value: 2,
        itemType: 'Demonic Horns', assetQuality: 'Exalted', quality: 'Exalted',
        rawTags: [
            { category: 'Quality', internal_name: 'exalted', localized_tag_name: 'Localized quality', color: 'ABCDEF' },
            { category: 'Type', internal_name: 'misc', localized_tag_name: 'Demonic Horns' },
            { category: 'Rarity', internal_name: 'arcana', color: 'ABCDEF' },
            { category: 'Other', internal_name: 'socket_gem', localized_tag_name: 'Localized gem' }
        ],
        prismaticGems: ['Legacy (4, 90, 175)'], etherealGems: [], kineticGems: [], unusualEffectGems: [],
        isLegacy: true, legacyRgb: { r: 4, g: 90, b: 175 }, emptySockets: 0,
        allStylesUnlocked: false, styleTotal: null, styleUnlocked: null, isBuggedEthereal: false,
        isOtherBug: true, isGolden: false, isCrimson: false, emptyEthereal: false, emptyPrismatic: false,
        gem: null, paintSeed: null, wearRating: null, stickers: null, infuser: null, spectatorGames: 0,
        legacyPricing: { isDupe: false, dupeCount: 0, family: 'INDIGO', detail: Array(2000).fill('Redundant pricing analysis') },
        image: 'x'.repeat(100000), buggedNoticeTexts: { en: 'y'.repeat(100000) },
        descriptions: Array(100).fill({ value: 'Catalog text' })
    };
    const env = setup(async () => ok({ items: [item], totalPages: 1 }));
    const response = await env.send('fetchPrices');
    assert.equal(response.success, true);
    const compact = response.data.items[0];
    for (const key of ['assetid', 'appid', 'contextid', 'quantity', 'classid', 'instanceid', 'marketHashName',
        'collectorAvgSaleCents', 'collectorLowestAskCents', 'priceCents', 'price_cents', 'scmPriceCents', 'basePriceCents',
        'price', 'lowest_price', 'cost', 'value', 'quality', 'assetQuality', 'emptySockets', 'allStylesUnlocked',
        'styleTotal', 'styleUnlocked', 'isBuggedEthereal', 'isOtherBug', 'isGolden', 'isCrimson',
        'emptyEthereal', 'emptyPrismatic', 'gem', 'paintSeed', 'wearRating', 'stickers', 'infuser', 'spectatorGames']) {
        assert.equal(compact[key], item[key], key);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(compact.prismaticGems)), item.prismaticGems);
    assert.deepEqual(JSON.parse(JSON.stringify(compact.legacyRgb)), item.legacyRgb);
    assert.deepEqual(JSON.parse(JSON.stringify(compact.legacyPricing)), { isDupe: false, dupeCount: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(compact.rawTags)), [
        { category: 'Quality', internal_name: 'exalted' },
        { category: 'Type', internal_name: 'misc', localized_tag_name: 'Demonic Horns' },
        { category: 'Other', internal_name: 'socket_gem' }
    ]);
    assert.equal(compact.image, undefined);
    assert.equal(compact.descriptions, undefined);
    assert.equal(compact.buggedNoticeTexts, undefined);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(item).length / 20);
});

test('an older uncompressed cache is compacted before its first runtime reply and retains missing variant fields', async () => {
    const now = 1800000000000;
    const raw = { assetid: '123', priceCents: 42, marketHashName: 'Fractal Horns of Inner Abysm',
        prismaticGems: ['Deep Blue'], image: 'x'.repeat(100000), legacyPricing: null };
    const stored = { [cacheKey]: { version: 1, entries: {
        [`fetchPrices:${steamId}`]: { action: 'fetchPrices', steamId, cachedAt: now, data: { items: [raw] } }
    } } };
    const env = setup(async () => { throw new Error('Fresh cache should avoid network'); }, { stored, now });
    const response = await env.send('fetchPrices');
    assert.equal(response.cached, true);
    assert.equal(response.data.items[0].assetid, '123');
    assert.equal(response.data.items[0].priceCents, 42);
    assert.equal(response.data.items[0].image, undefined);
    assert.equal(response.data.items[0].legacyPricing, null);
    assert.equal(Object.hasOwn(response.data.items[0], 'isBuggedEthereal'), false);
    assert.equal(env.requests.length, 0);
});

test('trade callers can disable hidden scans for cold empty inventories without caching a false fresh snapshot', async () => {
    let empty = true;
    const env = setup(async () => ok(empty ? { items: [], totalPages: 0 }
        : { items: [{ assetid: '123', priceCents: 42 }], totalPages: 1 }));
    const first = await env.send('fetchPrices', steamId, { scan: false });
    assert.equal(first.success, true);
    assert.equal(first.needsScan, true);
    assert.equal(first.cached, false);
    assert.equal(first.scanned, undefined);
    assert.equal(first.data.items.length, 0);
    assert.equal(env.requests.length, 1);
    assert.equal(env.tabs.created.length, 0);
    assert.equal(env.tabs.removed.length, 0);
    await env.flush();
    assert.equal(env.storage.sets.length, 0);
    empty = false;
    const next = await env.send('fetchPrices', steamId, { scan: false });
    assert.equal(next.cached, false);
    assert.equal(next.needsScan, undefined);
    assert.equal(next.data.items[0].priceCents, 42);
    assert.equal(env.requests.length, 2);
});

test('scan-disabled and inventory callers have separate in-flight operations', async () => {
    const env = setup(async (_, __, count) => ok(count < 3 ? { items: [], totalPages: 0 }
        : { items: [{ assetid: '123', priceCents: 42 }], totalPages: 1 }));
    const noScan = env.send('fetchPrices', steamId, { scan: false });
    const inventory = env.send('fetchPrices');
    const [tradeReply, inventoryReply] = await Promise.all([noScan, inventory]);
    assert.equal(tradeReply.needsScan, true);
    assert.equal(tradeReply.data.items.length, 0);
    assert.equal(inventoryReply.scanned, true);
    assert.equal(inventoryReply.data.items[0].assetid, '123');
    assert.equal(env.requests.length, 3);
    assert.equal(env.tabs.created.length, 1);
});

test('an existing complete empty cache remains labeled for scan-disabled trade callers', async () => {
    const env = setup(async () => ok({ items: [], totalPages: 0 }));
    const inventoryReply = await env.send('fetchPrices');
    assert.equal(inventoryReply.scanned, true);
    const tradeReply = await env.send('fetchPrices', steamId, { scan: false });
    assert.equal(tradeReply.cached, true);
    assert.equal(tradeReply.needsScan, true);
    assert.equal(env.requests.length, 2);
    assert.equal(env.tabs.created.length, 1);
});

test('quick inventory pages are paced instead of producing a burst of GETs', async () => {
    const env = setup(async url => {
        const page = Number(new URL(url).searchParams.get('page'));
        return ok({ items: [{ assetid: String(page) }], total: 5, pageSize: 1, page });
    });
    assert.equal((await env.send('fetchPrices')).data.items.length, 5);
    assert.equal(env.requestTimes.length, 5);
    for (let index = 1; index < env.requestTimes.length; index++) {
        assert.ok(env.requestTimes[index] - env.requestTimes[index - 1] >= 350);
    }
});

test('a server Retry-After delays other owners too instead of moving a burst to another inventory', async () => {
    let failed = false;
    const env = setup(async url => {
        if (url.endsWith(owner(0)) && !failed) { failed = true; return http(429, '2'); }
        return ok({ totalValueCents: 1 });
    });
    const replies = await Promise.all([env.send('fetchProfile', owner(0)), env.send('fetchProfile', owner(1))]);
    assert.ok(replies.every(result => result.success));
    assert.ok(env.requestTimes[1] - env.requestTimes[0] >= 2000);
});
