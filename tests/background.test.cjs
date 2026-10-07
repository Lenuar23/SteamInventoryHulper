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
    const tabs = { created: [], removed: [] };
    const runtime = {
        onMessage: { addListener(callback) { listener = callback; } },
        lastError: undefined
    };
    vm.runInNewContext(source, {
        AbortController,
        fetch: async (url, init) => {
            requests.push(url);
            return fetchImpl(url, init, requests.length);
        },
        setTimeout: (callback, ms) => setTimeout(callback,
            [5000, 7000].includes(ms) || (options.immediateTimeout && ms === 15000) ? 0 : ms),
        clearTimeout,
        chrome: {
            runtime,
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
        tabs,
        send(action, id = steamId) {
            return new Promise(resolve => listener({ action, steamId: id }, {}, resolve));
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
        assert.equal(env.requests.length, 2);
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

    test(`${action} shares in-flight work and permits a later fresh request`, async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const data = action === 'fetchProfile' ? { totalValueCents: '100' } : { items: [{ assetid: '1' }], totalPages: 1 };
        const env = setup(async () => { await gate; return ok(data); });
        const first = env.send(action);
        const second = env.send(action);
        assert.equal(env.requests.length, 1);
        release();
        const responses = await Promise.all([first, second]);
        assert.equal(responses[0].success, true);
        assert.equal(responses[1].success, true);
        assert.strictEqual(responses[0].data, responses[1].data);
        assert.equal(env.requests.length, 1);
        const fresh = await env.send(action);
        assert.equal(fresh.success, true);
        assert.equal(env.requests.length, 2);
    });
}
