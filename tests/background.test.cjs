const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const steamId = '76561198012345678';
const ok = data => ({ ok: true, status: 200, json: async () => data });
const collectionCatalog = (priceCents = 613) => ({ collections: [{
    id: 29, name: 'WEATHER', priceSource: 'steam', kind: 'regular', owned: 1, total: 2,
    items: [
        { id: 601, itemName: 'Genuine Weather Rain', steamPriceCents: 0, cashPriceCents: priceCents,
            owned: true, ownedAssetid: '31985914724', ownedItemName: 'Genuine Weather Rain',
            disablePrices: false, fullSet: false, unpackHint: false, dotagiftx: false, itemType: 'Misc', slot: 'Weather',
            collectorLowestAskCents: null, collectorAvgSaleCents: null },
        { id: 598, itemName: 'Genuine Weather Aurora', steamPriceCents: 0, cashPriceCents: 92,
            owned: false, ownedAssetid: null, disablePrices: false, fullSet: false, unpackHint: false, dotagiftx: false,
            itemType: 'Misc', slot: 'Weather', collectorLowestAskCents: null, collectorAvgSaleCents: null }
    ]
}], overallOwned: 1, overallTotal: 2 });

function setup(fetchImpl, options = {}) {
    let listener;
    const requests = [];
    const requestTimes = [];
    const requestOptions = [];
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
    const imports = [];
    const context = vm.createContext({
        AbortController,
        Date: TestDate,
        CompressionStream,
        DecompressionStream,
        Response,
        Blob,
        atob,
        btoa,
        importScripts(filename) {
            assert.ok(['collection-prices.js', 'market-prices.js'].includes(filename));
            imports.push(filename);
            vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, { filename });
        },
        fetch: async (url, init) => {
            requests.push(url);
            requestTimes.push(now);
            requestOptions.push(init);
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
    });
    vm.runInContext(source, context, { filename: 'background.js' });
    return {
        requests,
        requestTimes,
        requestOptions,
        tabs,
        timers,
        imports,
        storage,
        stored,
        get currentTime() { return now; },
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

for (const action of ['fetchProfile', 'fetchPrices', 'fetchCollection']) {
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
        const data = action === 'fetchProfile' ? { totalValueCents: '100' }
            : action === 'fetchCollection' ? collectionCatalog() : { items: [{ assetid: '1' }], totalPages: 1 };
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

test('collection action returns Weather cash quotes and never transfers collection ownership or opens a scan', async () => {
    const catalog = collectionCatalog();
    catalog.collections[0].items[0].image = 'x'.repeat(100000);
    const env = setup(async () => ok(catalog));
    const result = await env.send('fetchCollection', steamId, { scan: true });
    assert.equal(result.success, true);
    assert.equal(result.cached, false);
    assert.equal(result.needsScan, undefined);
    assert.equal(result.scanned, undefined);
    assert.deepEqual(env.imports, ['collection-prices.js', 'market-prices.js']);
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
        items: [
            { marketHashName: 'Genuine Weather Rain', priceCents: 613 },
            { marketHashName: 'Genuine Weather Aurora', priceCents: 92 }
        ], collectionCount: 1, itemCount: 2
    });
    assert.deepEqual(env.requests, [`https://steamprice.com/api/dota2/collection/${steamId}`]);
    assert.deepEqual(env.tabs, { created: [], removed: [] });
    await env.flush();
    const saved = env.stored[cacheKey].entries[`fetchCollection:${steamId}`];
    assert.equal(saved.data.items[0].assetid, undefined);
    assert.equal(saved.data.items[0].ownedAssetid, undefined);
    assert.equal(saved.data.items[0].owned, undefined);
    assert.equal(saved.data.items[0].image, undefined);
    assert.ok(JSON.stringify(saved.data).length < 300);
});

test('an empty collection catalog is cached without triggering an inventory scan', async () => {
    const env = setup(async () => ok({ collections: [] }));
    const first = await env.send('fetchCollection');
    const second = await env.send('fetchCollection');
    assert.equal(first.success, true);
    assert.deepEqual(JSON.parse(JSON.stringify(first.data)), { items: [], collectionCount: 0, itemCount: 0 });
    assert.equal(second.cached, true);
    assert.equal(second.needsScan, undefined);
    assert.equal(env.requests.length, 1);
    assert.equal(env.tabs.created.length, 0);
});

test('collection requests validate the viewer ID before contacting the public API', async () => {
    const env = setup(async () => { throw new Error('Must not fetch'); });
    for (const id of ['../collection', '7656119801234567', 76561198012345678, null]) {
        const result = await env.send('fetchCollection', id);
        assert.equal(result.success, false);
        assert.match(result.error, /SteamID64/);
    }
    assert.equal(env.requests.length, 0);
    assert.equal(env.tabs.created.length, 0);
});

test('persisted collection catalogs stay separate from asset prices, profile totals, and other viewers', async () => {
    const stored = { unrelatedPreference: 'keep' };
    const first = setup(async url => ok(url.includes('/collection/') ? collectionCatalog()
        : url.includes('/profile/') ? { totalValueCents: 12345 }
            : { items: [{ assetid: '123', marketHashName: 'Genuine Weather Rain', priceCents: 777 }], totalPages: 1 }), { stored });
    await Promise.all(['fetchProfile', 'fetchPrices', 'fetchCollection'].map(action => first.send(action)));
    await first.flush();
    const restarted = setup(async () => ok(collectionCatalog(500)), { stored, now: first.currentTime });
    const cached = await restarted.send('fetchCollection');
    assert.equal(cached.cached, true);
    assert.equal(cached.data.items[0].priceCents, 613);
    assert.equal((await restarted.send('fetchPrices')).data.items[0].priceCents, 777);
    assert.equal((await restarted.send('fetchProfile')).data.totalValueCents, 12345);
    assert.equal(restarted.requests.length, 0);
    const other = await restarted.send('fetchCollection', owner(1));
    assert.equal(other.cached, false);
    assert.equal(other.data.items[0].priceCents, 500);
    assert.equal(restarted.requests.length, 1);
    assert.equal(stored.unrelatedPreference, 'keep');
});

test('collection outages return only a labeled unexpired last complete catalog', async () => {
    let outage = false;
    const env = setup(async () => outage ? http(502) : ok(collectionCatalog()));
    const initial = await env.send('fetchCollection');
    env.advance(90000);
    outage = true;
    const stale = await env.send('fetchCollection');
    assert.equal(stale.success, true);
    assert.equal(stale.cached, true);
    assert.equal(initial.success, true);
    assert.equal(stale.cachedAt, 1800000000000);
    assert.equal(stale.data.items[0].priceCents, 613);
    assert.match(stale.error, /502/);
    assert.equal(env.requests.length, 4);
    env.advance(24 * 60 * 60 * 1000);
    const expired = await env.send('fetchCollection');
    assert.equal(expired.success, false);
    assert.equal(expired.data, undefined);
    assert.equal(env.tabs.created.length, 0);
});

test('invalid collection payloads and HTTP 403 cannot masquerade as a cached successful valuation', async () => {
    for (const failure of [http(403), ok([]), ok({}), ok({ collections: [{}] }), ok({ success: false, error: 'Unavailable catalog' })]) {
        let fail = false;
        const env = setup(async () => fail ? failure : ok(collectionCatalog()));
        await env.send('fetchCollection');
        env.advance(90000);
        fail = true;
        const result = await env.send('fetchCollection');
        assert.equal(result.success, false);
        assert.equal(result.data, undefined);
        assert.equal(env.requests.length, 2);
        assert.equal(env.tabs.created.length, 0);
    }
});

test('collection response decoding shares the single paced GET gate with inventory and profile loading', async () => {
    let release;
    const env = setup(async url => url.includes('/collection/')
        ? { ok: true, status: 200, json: () => new Promise(resolve => { release = () => resolve(collectionCatalog()); }) }
        : ok(url.includes('/profile/') ? { totalValueCents: 123 } : { items: [{ assetid: '123' }], totalPages: 1 }));
    const collection = env.send('fetchCollection');
    await env.flush();
    const profile = env.send('fetchProfile', owner(1));
    const prices = env.send('fetchPrices', owner(2), { scan: false });
    await env.flush();
    assert.equal(env.requests.length, 1, 'The collection body retains the GET slot while decoding');
    release();
    const results = await Promise.all([collection, profile, prices]);
    assert.ok(results.every(result => result.success));
    assert.equal(env.requests.length, 3);
    for (let index = 1; index < env.requestTimes.length; index++) {
        assert.ok(env.requestTimes[index] - env.requestTimes[index - 1] >= 350);
    }
    assert.equal(env.tabs.created.length, 0);
});

test('corrupt compact collection cache entries are rejected while extra raw ownership is discarded', async () => {
    const now = 1800000000000;
    const compact = { items: [{ marketHashName: 'Genuine Weather Rain', priceCents: 613 }], collectionCount: 1, itemCount: 1 };
    for (const data of [
        { ...compact, itemCount: 2 },
        { ...compact, collectionCount: 1001 },
        { ...compact, items: [{ marketHashName: 'Genuine Weather Rain', priceCents: 0 }] },
        { ...compact, items: [{ marketHashName: '', priceCents: 10 }] }
    ]) {
        const stored = { [cacheKey]: { version: 1, entries: {
            [`fetchCollection:${steamId}`]: { action: 'fetchCollection', steamId, cachedAt: now, data }
        } } };
        const env = setup(async () => ok(collectionCatalog(500)), { stored, now });
        const result = await env.send('fetchCollection');
        assert.equal(result.cached, false);
        assert.equal(result.data.items[0].priceCents, 500);
        assert.equal(env.requests.length, 1);
    }
    const contaminated = { ...compact, items: [{ ...compact.items[0], ownedAssetid: '123', assetid: '456', image: 'x'.repeat(10000) }] };
    const stored = { [cacheKey]: { version: 1, entries: {
        [`fetchCollection:${steamId}`]: { action: 'fetchCollection', steamId, cachedAt: now, data: contaminated }
    } } };
    const env = setup(async () => { throw new Error('Fresh cache should avoid a GET'); }, { stored, now });
    const result = await env.send('fetchCollection');
    assert.equal(result.cached, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), compact);
    assert.equal(env.requests.length, 0);
});

test('large collection catalogs cache only compact prices and survive compressed worker restarts', async () => {
    const catalog = collectionCatalog();
    const template = catalog.collections[0].items[1];
    catalog.collections[0].items = Array.from({ length: 1000 }, (_, index) => ({
        ...template, itemName: `Ordinary collection item ${index}`, cashPriceCents: 100 + index, image: 'x'.repeat(1000)
    }));
    const stored = {};
    const env = setup(async () => ok(catalog), { stored });
    const initial = await env.send('fetchCollection');
    assert.equal(initial.data.itemCount, 1000);
    for (let attempt = 0; attempt < 30 && stored[cacheKey]?.encoding !== 'gzip'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stored[cacheKey]?.encoding, 'gzip');
    const restarted = setup(async () => { throw new Error('Must use the compressed catalog cache'); }, { stored });
    const restored = await restarted.send('fetchCollection');
    assert.equal(restored.cached, true);
    assert.equal(restored.data.collectionCount, 1);
    assert.equal(restored.data.itemCount, 1000);
    assert.equal(restored.data.items[999].priceCents, 1099);
    assert.equal(restored.data.items[999].image, undefined);
    assert.equal(restarted.requests.length, 0);
});

const marketStorageKey = 'sih-lite-market-quotes-v1';
const MARKET_NAME = 'Inscribed Mecha Boots of Travel Mk III';
const marketOk = (price = '$1.10') => ok({ success: true, lowest_price: price, median_price: '$99.99', volume: '500' });
const marketSend = (env, names = [MARKET_NAME], extra = {}) => env.send('fetchMarketQuotes', null, { names, ...extra });

test('Market quotes validate bounded exact names before any API call without requiring an owner', async () => {
    const env = setup(async () => marketOk());
    for (const names of [null, 'Name', [null], [''], ['x'.repeat(513)], ['Bad\nName'], ['<b>Name</b>'], ['https://bad.example/'], Array(21).fill('Name')]) {
        const result = await marketSend(env, names);
        assert.equal(result.success, false, JSON.stringify(names));
    }
    assert.equal(env.requests.length, 0);
    const before = env.requests.length;
    const invalid = await env.send('fetchMarketQuotes', null);
    assert.equal(invalid.success, false);
    assert.equal(env.requests.length, before);
    const empty = await marketSend(env, []);
    assert.equal(empty.success, true);
    assert.equal(empty.data.items.length, 0);
    assert.equal(empty.data.currency, 'USD');
    assert.equal(env.requests.length, before);
});

test('Market request fixes Dota/USD/English, omits credentials, preserves quality and deduplicates exact names', async () => {
    const env = setup(async () => marketOk());
    const result = await marketSend(env, [` ${MARKET_NAME} `, MARKET_NAME, 'Autographed Wraithbinder']);
    assert.equal(result.success, true);
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.errors.length, 0);
    assert.equal(result.data.missingNames.length, 0);
    for (let index = 0; index < env.requests.length; index++) {
        const url = new URL(env.requests[index]);
        assert.equal(url.origin, 'https://steamcommunity.com');
        assert.equal(url.pathname, '/market/priceoverview/');
        assert.equal(url.searchParams.get('appid'), '570');
        assert.equal(url.searchParams.get('currency'), '1');
        assert.equal(url.searchParams.get('l'), 'english');
        assert.equal(env.requestOptions[index].credentials, 'omit');
        assert.equal(env.requestOptions[index].method, undefined);
    }
    assert.equal(new URL(env.requests[0]).searchParams.get('market_hash_name'), MARKET_NAME);
    assert.equal(new URL(env.requests[1]).searchParams.get('market_hash_name'), 'Autographed Wraithbinder');
    const quote = result.data.items[0];
    assert.equal(quote.marketHashName, MARKET_NAME);
    assert.equal(quote.priceCents, 110);
    assert.equal(quote.source, 'steam-market');
    assert.equal(quote.currency, 'USD');
    assert.equal(quote.estimateKind, 'market-name');
    assert.equal(quote.cached, false);
    assert.equal(quote.assetid, undefined);
    assert.ok(env.requestTimes[1] - env.requestTimes[0] >= 1500);
    assert.equal(env.tabs.created.length, 0);
});

test('Market no-quote and invalid USD fields remain missing and never use median or volume', async () => {
    const responses = [{ success: false }, { success: true, median_price: '$5.00', volume: '90' },
        { success: true, lowest_price: '€1.10' }, { success: true, lowest_price: '$0.00' },
        { success: true, lowest_price: '$1,23.45' }, { success: true, lowest_price: '$1,234.56', currency: 'EUR' }, null];
    for (const payload of responses) {
        const env = setup(async () => ok(payload));
        const result = await marketSend(env);
        assert.equal(result.success, true);
        assert.equal(result.data.items.length, 0);
        assert.deepEqual(Array.from(result.data.missingNames), [MARKET_NAME]);
        assert.equal(result.data.errors.length, 0);
        assert.equal(env.requests.length, 1);
    }
    const env = setup(async () => marketOk('$1,234.56'));
    assert.equal((await marketSend(env)).data.items[0].priceCents, 123456);
});

test('Market batches preserve successful quotes alongside missing names and permanent errors', async () => {
    const env = setup(async url => {
        const name = new URL(url).searchParams.get('market_hash_name');
        return name === 'Good' ? marketOk('$2.50') : name === 'Unlisted' ? ok({ success: false }) : http(403);
    });
    const result = await marketSend(env, ['Good', 'Unlisted', 'Unavailable']);
    assert.equal(result.success, true);
    assert.deepEqual(Array.from(result.data.items, quote => quote.marketHashName), ['Good']);
    assert.deepEqual(Array.from(result.data.missingNames), ['Unlisted']);
    assert.equal(result.data.errors.length, 1);
    assert.equal(result.data.errors[0].marketHashName, 'Unavailable');
    assert.match(result.data.errors[0].error, /Steam Market.*403/);
    assert.equal(env.requests.length, 3);
});

test('Market GET retries are bounded, paced, and keep successful batch rows', async () => {
    let attempts = 0;
    const env = setup(async url => {
        const name = new URL(url).searchParams.get('market_hash_name');
        if (name === MARKET_NAME && ++attempts < 3) return attempts === 1 ? http(502) : http(504);
        return marketOk();
    });
    const result = await marketSend(env, [MARKET_NAME, 'Second Item']);
    assert.equal(result.data.items.length, 2);
    assert.equal(attempts, 3);
    assert.equal(env.requests.length, 4);
    for (let index = 1; index < env.requests.length; index++) assert.ok(env.requestTimes[index] - env.requestTimes[index - 1] >= 1500);
    const failed = setup(async () => http(503));
    const failure = await marketSend(failed);
    assert.equal(failure.success, true);
    assert.equal(failure.data.items.length, 0);
    assert.match(failure.data.errors[0].error, /Steam Market.*503/);
    assert.equal(failed.requests.length, 3);
});

test('Market network timeouts and TypeErrors retry without producing fabricated quotes', async () => {
    for (const fetchImpl of [async () => { throw new TypeError('Offline'); }, async () => new Promise(() => {})]) {
        const env = setup(fetchImpl, { immediateTimeout: true });
        const result = await marketSend(env);
        assert.equal(result.data.items.length, 0);
        assert.equal(result.data.errors.length, 1);
        assert.match(result.data.errors[0].error, /Steam Market/);
        assert.equal(env.requests.length, 3);
    }
});

test('Market 429 establishes a shared cooldown without retrying or blocking Steamprice', async () => {
    for (const [retryAfter, cooldown] of [[undefined, 60000], ['10', 10000]]) {
        let marketCalls = 0;
        const env = setup(async url => {
            if (url.includes('/market/')) return ++marketCalls === 1 ? http(429, retryAfter) : marketOk();
            return ok({ totalValueCents: 50 });
        });
        const failed = await marketSend(env, [MARKET_NAME, 'Other Name', 'Third Name']);
        assert.equal(failed.data.items.length, 0);
        assert.equal(failed.data.errors.length, 3);
        assert.equal(marketCalls, 1);
        assert.match(failed.data.errors[0].error, /429/);
        assert.match(failed.data.errors[1].error, /rate limited/);
        const retry = await marketSend(env, [MARKET_NAME], { force: true });
        assert.equal(retry.data.errors.length, 1);
        assert.equal(marketCalls, 1);
        const profile = await env.send('fetchProfile');
        assert.equal(profile.success, true);
        assert.equal(profile.data.totalValueCents, 50);
        env.advance(cooldown + 1);
        assert.equal((await marketSend(env, [MARKET_NAME], { force: true })).data.items.length, 1);
        assert.equal(marketCalls, 2);
    }
});

test('Market batches share per-name in-flight work across callers and forced refreshes', async () => {
    let release;
    const env = setup(async () => new Promise(resolve => { release = () => resolve(marketOk()); }));
    const first = marketSend(env);
    const second = marketSend(env, [MARKET_NAME], { force: true });
    await env.flush();
    assert.equal(env.requests.length, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].data.items[0].priceCents, 110);
    assert.equal(results[1].data.items[0].priceCents, 110);
    assert.equal(env.requests.length, 1);
});

test('Market cache is fresh for 15 minutes, force bypasses it, and persistent rows survive worker restart', async () => {
    const stored = { unrelated: 'keep' };
    const env = setup(async (_, __, count) => marketOk(`$${count}.00`), { stored });
    const first = await marketSend(env);
    assert.equal(first.data.items[0].cached, false);
    const cachedAt = env.currentTime;
    env.advance(899999);
    const fresh = await marketSend(env);
    assert.equal(fresh.data.items[0].cached, true);
    assert.equal(fresh.data.items[0].cachedAt, cachedAt);
    assert.equal(env.requests.length, 1);
    const forced = await marketSend(env, [MARKET_NAME], { force: true });
    assert.equal(forced.data.items[0].cached, false);
    assert.equal(forced.data.items[0].priceCents, 200);
    await env.flush();
    const restarted = setup(async () => { throw new Error('Cache expected'); }, { stored, now: env.currentTime });
    const restored = await marketSend(restarted);
    assert.equal(restored.data.items[0].cached, true);
    assert.equal(restored.data.items[0].priceCents, 200);
    assert.equal(restarted.requests.length, 0);
    assert.equal(stored.unrelated, 'keep');
    assert.ok(stored[marketStorageKey]);
    assert.equal(stored[cacheKey], undefined);
});

test('unquoted Market names use only a short negative cache and force can refresh them', async () => {
    let available = false;
    const env = setup(async () => available ? marketOk() : ok({ success: false }));
    assert.equal((await marketSend(env)).data.missingNames.length, 1);
    available = true;
    assert.equal((await marketSend(env)).data.missingNames.length, 1);
    assert.equal(env.requests.length, 1);
    const forced = await marketSend(env, [MARKET_NAME], { force: true });
    assert.equal(forced.data.items.length, 1);
    assert.equal(env.requests.length, 2);
    const missing = setup(async () => ok({ success: false }));
    await marketSend(missing);
    missing.advance(90000);
    await marketSend(missing);
    assert.equal(missing.requests.length, 2);
});

test('Market temporary outage returns a labeled last full quote but never an expired or permanent-error quote', async () => {
    let failure = null;
    const env = setup(async () => failure || marketOk());
    const live = await marketSend(env);
    const cachedAt = env.currentTime;
    env.advance(900000);
    failure = http(502);
    const stale = await marketSend(env);
    const quote = stale.data.items[0];
    assert.equal(quote.priceCents, live.data.items[0].priceCents);
    assert.equal(quote.cached, true);
    assert.equal(quote.cachedAt, cachedAt);
    assert.match(quote.error, /502/);
    assert.match(stale.data.errors[0].error, /502/);
    failure = http(403);
    assert.equal((await marketSend(env, [MARKET_NAME], { force: true })).data.items.length, 0);
    failure = http(502);
    env.advance(86400001);
    assert.equal((await marketSend(env)).data.items.length, 0);
});

test('a successful no-quote response clears an old Market quote rather than silently retaining it', async () => {
    let unavailable = false;
    const env = setup(async () => unavailable ? ok({ success: false }) : marketOk());
    await marketSend(env);
    unavailable = true;
    const result = await marketSend(env, [MARKET_NAME], { force: true });
    assert.equal(result.data.items.length, 0);
    assert.deepEqual(Array.from(result.data.missingNames), [MARKET_NAME]);
    assert.equal(result.data.errors.length, 0);
    assert.equal((await marketSend(env)).data.items.length, 0);
});

test('Market quote decoding shares one active GET slot with all Steamprice actions', async () => {
    let release;
    let active = 0;
    let maximum = 0;
    const env = setup(async url => {
        active++;
        maximum = Math.max(maximum, active);
        if (url.includes('/market/')) return { ok: true, status: 200, json: async () => {
            await new Promise(resolve => { release = resolve; });
            active--;
            return { success: true, lowest_price: '$1.10' };
        } };
        active--;
        return ok(url.includes('/profile/') ? { totalValueCents: 2 } : url.includes('/collection/') ? collectionCatalog() : { items: [{ assetid: '1' }] });
    });
    const market = marketSend(env);
    await env.flush();
    const others = [env.send('fetchProfile'), env.send('fetchPrices'), env.send('fetchCollection')];
    await env.flush();
    assert.equal(env.requests.length, 1);
    release();
    const results = await Promise.all([market, ...others]);
    assert.ok(results.every(result => result.success));
    assert.equal(maximum, 1);
    assert.equal(env.requests.length, 4);
});

test('Market cache is bounded to 128 exact names and never overwrites unrelated storage or Steamprice snapshots', async () => {
    const stored = { unrelated: 'keep', [cacheKey]: { version: 1, entries: {} } };
    const env = setup(async () => marketOk(), { stored });
    for (let start = 0; start < 140; start += 20) {
        await marketSend(env, Array.from({ length: 20 }, (_, index) => `Name ${start + index}`));
    }
    await env.flush();
    const entries = stored[marketStorageKey].entries;
    assert.equal(Object.keys(entries).length, 128);
    assert.equal(entries['Name 0'], undefined);
    assert.ok(entries['Name 139']);
    assert.equal(stored.unrelated, 'keep');
    assert.deepEqual(stored[cacheKey], { version: 1, entries: {} });
});

test('persisted Market cache rejects wrong source/currency/identity/timestamps and discards extra fields', async () => {
    const now = 1800000000000;
    const base = { quote: { marketHashName: MARKET_NAME, priceCents: 123, currency: 'USD', source: 'steam-market', estimateKind: 'market-name' }, cachedAt: now, usedAt: now };
    for (const patch of [{ cachedAt: now + 1 }, { cachedAt: now - 86400001 },
        { quote: { ...base.quote, currency: 'EUR' } }, { quote: { ...base.quote, source: 'steamprice' } },
        { quote: { ...base.quote, marketHashName: 'Mecha Boots of Travel Mk III' } },
        { quote: { ...base.quote, priceCents: 0 } }]) {
        const stored = { [marketStorageKey]: { version: 1, entries: { [MARKET_NAME]: { ...base, ...patch } } } };
        const env = setup(async () => marketOk(), { stored, now });
        assert.equal((await marketSend(env)).data.items[0].cached, false);
        assert.equal(env.requests.length, 1);
    }
    const stored = { [marketStorageKey]: { version: 1, entries: { [MARKET_NAME]: { ...base, quote: { ...base.quote, assetid: '123', cookie: 'not-real' } } } } };
    const env = setup(async () => { throw new Error('Must use sanitized cache'); }, { stored, now });
    const quote = (await marketSend(env)).data.items[0];
    assert.equal(quote.cached, true);
    assert.equal(quote.assetid, undefined);
    assert.equal(quote.cookie, undefined);
    assert.equal(env.requests.length, 0);
});

test('Market storage failures leave live quotes and their memory cache usable', async () => {
    for (const options of [{ storage: false }, { getError: true }, { setError: true }]) {
        const env = setup(async () => marketOk(), options);
        assert.equal((await marketSend(env)).data.items[0].cached, false);
        await env.flush();
        assert.equal((await marketSend(env)).data.items[0].cached, true);
        assert.equal(env.requests.length, 1);
    }
});

test('Market service Retry-After is respected without freezing cash loading or probing other names', async () => {
    let marketAttempts = 0;
    const env = setup(async url => url.includes('/market/')
        ? ++marketAttempts === 1 ? http(503, '2') : marketOk()
        : ok({ totalValueCents: 1 }));
    const successful = await marketSend(env);
    assert.equal(successful.data.items.length, 1);
    assert.ok(env.requestTimes[1] - env.requestTimes[0] >= 2000);
    const long = setup(async url => url.includes('/market/') ? http(503, '60') : ok({ totalValueCents: 2 }));
    const result = await marketSend(long, [MARKET_NAME, 'Another Item']);
    assert.equal(result.data.errors.length, 2);
    assert.equal(long.requests.length, 1);
    assert.match(result.data.errors[1].error, /temporarily unavailable/);
    assert.equal((await long.send('fetchProfile')).data.totalValueCents, 2);
});

test('a stale Market quote survives a queued operation deadline with explicit cache metadata', async () => {
    const now = 1800000000000;
    const stored = { [marketStorageKey]: { version: 1, entries: { [MARKET_NAME]: {
        quote: { marketHashName: MARKET_NAME, priceCents: 500, currency: 'USD', source: 'steam-market', estimateKind: 'market-name' },
        cachedAt: now - 1200000, usedAt: now - 1200000
    } } } };
    let release;
    const env = setup(async () => new Promise(resolve => { release = () => resolve(marketOk()); }), {
        stored, now, timerDelay: ms => ms === 180000 ? 0 : undefined
    });
    const held = marketSend(env, ['Held Item']);
    await env.flush();
    const result = await marketSend(env);
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].priceCents, 500);
    assert.equal(result.data.items[0].cached, true);
    assert.equal(result.data.items[0].cachedAt, now - 1200000);
    assert.match(result.data.items[0].error, /timed out/);
    assert.equal(result.data.errors.length, 1);
    assert.equal(env.requests.length, 1);
    release();
    await held;
    const refreshed = marketSend(env, [MARKET_NAME], { force: true });
    await env.flush();
    assert.equal(env.requests.length, 2);
    release();
    assert.equal((await refreshed).data.items[0].cached, false);
});

test('Steamprice Retry-After cannot block a healthy Market quote while all cash owners retain their cooldown', async () => {
    const env = setup(async url => url.includes('/market/') ? marketOk() : http(429, '120'), {
        timerDelay: ms => ms === 30000 ? 5 : undefined
    });
    const first = await env.send('fetchProfile');
    assert.equal(first.success, false);
    assert.equal(env.requests.length, 1);
    const queuedCash = env.send('fetchProfile', owner(1));
    const market = await marketSend(env);
    assert.equal(market.data.items.length, 1);
    const marketIndex = env.requests.findIndex(url => url.includes('/market/'));
    assert.equal(marketIndex, 1, 'ready Market request bypasses a cash owner in provider cooldown');
    assert.ok(env.requestTimes[marketIndex] - env.requestTimes[0] < 120000);
    env.advance(120000);
    const cash = await queuedCash;
    assert.equal(cash.success, false);
    assert.ok(env.requestTimes[2] - env.requestTimes[0] >= 120000);
});
