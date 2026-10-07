const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8');
const STEAM_ID = '76561198000000000';

function deferred() {
    let state = 'pending';
    const success = [];
    const failure = [];
    return {
        state: () => state,
        done(callback) { if (state === 'resolved') callback(); else success.push(callback); return this; },
        fail(callback) { if (state === 'rejected') callback(); else failure.push(callback); return this; },
        resolve() { if (state !== 'pending') return; state = 'resolved'; success.forEach(callback => callback()); },
        reject() { if (state !== 'pending') return; state = 'rejected'; failure.forEach(callback => callback()); }
    };
}

function holder(id, name) {
    const node = { rgItem: { assetid: String(id), description: { market_hash_name: name } }, filtered: false };
    const metadata = new Map();
    const result = {
        0: node,
        metadata,
        style: {},
        clickHandler() { return node.rgItem.assetid; },
        data(key, value) { if (arguments.length === 1) return metadata.get(key); metadata.set(key, value); return result; },
        css(key, value) { result.style[key] = value; return result; }
    };
    node.wrapper = result;
    return result;
}

// These doubles model Steam's native holder, promise, filter and page contracts.
// Real CInventory/CPage methods are additionally exercised in Chromium against
// https://steamcommunity.com/public/javascript/economy_v2.js during validation.
function inventory(holders, options = {}) {
    const load = deferred();
    const callbacks = new Set();
    const result = {
        appid: 570, m_appid: 570, contextid: '2', m_contextid: '2', m_steamid: STEAM_ID,
        m_rgItemElements: holders.slice(), m_cItems: options.total ?? holders.length,
        m_iNextEmptyItemElement: holders.length, m_bFullyLoaded: options.loaded !== false,
        m_iCurrentPage: 0, m_rgPages: [], layouts: 0, loadCalls: 0,
        m_$Inventory: { hasClass: () => Boolean(options.transition) },
        AddOnItemsLoadedCallback(callback) { callbacks.add(callback); },
        RemoveOnItemsLoadedCallback(callback) { callbacks.delete(callback); },
        LoadCompleteInventory() {
            this.loadCalls++;
            if (this.m_bFullyLoaded) return deferredResolved();
            if (!this.m_promiseLoadCompleteInventory) this.m_promiseLoadCompleteInventory = load;
            return this.m_promiseLoadCompleteInventory;
        },
        LayoutPages() {
            this.layouts++;
            const items = this.m_rgChildInventories ? this.m_rgChildInventories['2'].m_rgItemElements : this.m_rgItemElements;
            this.m_cPages = Math.max(1, Math.ceil(items.length / 25));
            this.m_rgPages = Array.from({ length: this.m_cPages }, (_, index) => ({
                m_iPage: index,
                m_$Page: { children: () => ({ each(callback) { items.slice(index * 25, (index + 1) * 25).forEach(item => callback.call(item[0])); } }) }
            }));
        },
        ShowPageControlsIfNeeded() {},
        finish(remaining = []) {
            this.m_rgItemElements.push(...remaining);
            this.m_iNextEmptyItemElement = this.m_rgItemElements.length;
            this.m_cItems = this.m_rgItemElements.length;
            this.m_bFullyLoaded = true;
            callbacks.forEach(callback => callback());
            load.resolve();
        },
        fail() { load.reject(); },
        load
    };
    return result;
}

function deferredResolved() {
    const result = deferred();
    result.resolve();
    return result;
}

function harness(active) {
    const messages = [];
    const listeners = [];
    const intervals = [];
    const timers = new Set();
    const window = {
        g_ActiveInventory: active,
        location: { origin: 'https://steamcommunity.com' },
        INVENTORY_PAGE_ITEMS: 25,
        $J: node => node.wrapper,
        addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
        postMessage(message) { messages.push(message); },
        setInterval(callback) { intervals.push(callback); return intervals.length; },
        setTimeout(callback, delay) { const id = setTimeout(callback, delay); timers.add(id); return id; },
        clearTimeout(id) { clearTimeout(id); timers.delete(id); }
    };
    vm.runInNewContext(source, { window, console });
    let nextId = 0;
    return {
        window, messages,
        post(message, overrides = {}) {
            listeners.forEach(callback => callback({ source: window, origin: window.location.origin,
                data: { source: 'SIH_LITE_CONTENT', ...message }, ...overrides }));
        },
        async sort(order, assetPrices = [], namePrices = [], overrides = {}) {
            const requestId = `request-${++nextId}`;
            this.post({ type: 'SORT', requestId, steamId: STEAM_ID, order,
                prices: { assetPrices, namePrices }, ...overrides });
            for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setImmediate(resolve));
                const response = messages.find(message => message.type === 'SORT_RESULT' && message.requestId === requestId);
                if (response) return response;
            }
            throw new Error('Sort did not reply');
        },
        tick() { intervals.forEach(callback => callback()); },
        dispose() { timers.forEach(clearTimeout); }
    };
}

function ids(active) { return active.m_rgItemElements.map(item => item[0].rgItem.assetid); }

test('price sorts keep native holders and events, stable ties, zero prices and unknown items last', async () => {
    const holders = [holder(1, 'Unknown'), holder(2, 'Low'), holder(3, 'High'), holder(4, 'Free'), holder(5, 'Tie')];
    const active = inventory(holders);
    const app = harness(active);
    const prices = [['2', 100], ['3', 500], ['4', 0], ['5', 100]];
    assert.equal((await app.sort('asc', prices)).success, true);
    assert.deepEqual(ids(active), ['4', '2', '5', '3', '1']);
    assert.equal(active.m_rgItemElements[0], holders[3]);
    assert.equal(active.m_rgItemElements[0].clickHandler(), '4');
    assert.equal((await app.sort('desc', prices)).success, true);
    assert.deepEqual(ids(active), ['3', '2', '5', '4', '1']);
    assert.equal((await app.sort('original')).success, true);
    assert.deepEqual(ids(active), ['1', '2', '3', '4', '5']);
    app.dispose();
});

test('asset prices override exact names; cleaned names remain a fallback', async () => {
    const active = inventory([holder(1, 'Inscribed Sword Set'), holder(2, 'Sword'), holder(3, 'Sword')]);
    const app = harness(active);
    assert.equal((await app.sort('asc', [['2', 200]], [['sword', 500]])).success, true);
    assert.deepEqual(ids(active), ['2', '1', '3']);
    app.dispose();
});

test('sorting waits for the entire native inventory and updates every holder page index', async () => {
    const all = Array.from({ length: 80 }, (_, index) => holder(1000 + index, `Item ${index}`));
    const active = inventory(all.slice(0, 25), { loaded: false, total: 80 });
    const app = harness(active);
    app.post({ type: 'SORT', requestId: 'full', steamId: STEAM_ID, order: 'desc',
        prices: { assetPrices: all.map((item, i) => [item[0].rgItem.assetid, i]), namePrices: [] } });
    assert.equal(active.layouts, 0);
    assert.deepEqual(ids(active), all.slice(0, 25).map(item => item[0].rgItem.assetid));
    active.finish(all.slice(25));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.messages.find(message => message.type === 'SORT_RESULT').success, true);
    assert.deepEqual(ids(active), all.map(item => item[0].rgItem.assetid).reverse());
    assert.equal(active.m_rgItemElements[79].data('iPage'), 3);
    assert.ok(app.messages.some(message => message.type === 'SORT_PROGRESS' && message.loaded === 80));
    assert.equal(app.messages.findLast(message => message.type === 'INVENTORY').items.length, 80);
    app.dispose();
});

test('switching the active inventory while loading never reorders the previous inventory', async () => {
    const active = inventory([holder(1, 'First')], { loaded: false, total: 2 });
    const app = harness(active);
    app.post({ type: 'SORT', requestId: 'switch', steamId: STEAM_ID, order: 'desc',
        prices: { assetPrices: [['1', 0], ['2', 100]], namePrices: [] } });
    app.window.g_ActiveInventory = inventory([holder(9, 'Other')]);
    active.finish([holder(2, 'Second')]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.messages.find(message => message.type === 'SORT_RESULT').success, false);
    assert.deepEqual(ids(active), ['1', '2']);
    assert.equal(active.layouts, 0);
    app.dispose();
});

test('appwide child replacement emits a fresh snapshot even when owner and loaded count match', () => {
    const child = inventory([holder(1, 'Old')]);
    const active = inventory([]);
    active.contextid = active.m_contextid = '0';
    active.m_rgChildInventories = { 2: child };
    active.m_rgContextIds = ['2'];
    const app = harness(active);
    active.m_rgChildInventories['2'] = inventory([holder(2, 'New')]);
    app.tick();
    const snapshots = app.messages.filter(message => message.type === 'INVENTORY');
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1].items[0].assetId, '2');
    assert.equal(app.messages.findLast(message => message.type === 'STATE').contextId, '2');
    app.dispose();
});

test('appwide reload during an in-flight sort cannot reorder its replaced child', async () => {
    const child = inventory([holder(1, 'Old')], { loaded: false, total: 2 });
    const active = inventory([], { loaded: false });
    active.contextid = active.m_contextid = '0';
    active.m_rgChildInventories = { 2: child };
    active.m_rgContextIds = ['2'];
    active.LoadCompleteInventory = () => child.LoadCompleteInventory();
    const app = harness(active);
    app.post({ type: 'SORT', requestId: 'reload', steamId: STEAM_ID, order: 'asc',
        prices: { assetPrices: [['1', 200], ['2', 100]], namePrices: [] } });
    active.m_rgChildInventories['2'] = inventory([holder(9, 'New')]);
    child.finish([holder(2, 'Second')]);
    await new Promise(resolve => setImmediate(resolve));
    const reply = app.messages.find(message => message.type === 'SORT_RESULT');
    assert.equal(reply.success, false);
    assert.match(reply.error, /Inventory changed/);
    assert.deepEqual(ids(child), ['1', '2']);
    assert.equal(active.layouts, 0);
    app.dispose();
});

test('native load failures do not apply partial sorting and cached failures can be retried', async () => {
    const active = inventory([holder(1, 'A')], { loaded: false, total: 2 });
    const app = harness(active);
    app.post({ type: 'SORT', requestId: 'failure', steamId: STEAM_ID, order: 'asc',
        prices: { assetPrices: [], namePrices: [] } });
    active.fail();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.messages.find(message => message.type === 'SORT_RESULT').success, false);
    assert.equal(active.layouts, 0);
    let resetObserved = false;
    active.LoadCompleteInventory = function () {
        resetObserved = this.m_promiseLoadCompleteInventory === null;
        this.m_bFullyLoaded = true;
        return deferredResolved();
    };
    assert.equal((await app.sort('original')).success, true);
    assert.equal(resetObserved, true);
    app.dispose();
});

test('invalid prices, other owners and other games cannot trigger a load or sort', async () => {
    const active = inventory([holder(1, 'A')]);
    const app = harness(active);
    assert.equal((await app.sort('asc', [['1', -1]])).success, false);
    assert.equal((await app.sort('asc', [['1', 1.5]])).success, false);
    assert.equal((await app.sort('asc', [['bad-id', 5]])).success, false);
    assert.equal((await app.sort('asc', [], [], { steamId: '76561198000000001' })).success, false);
    active.appid = active.m_appid = 730;
    assert.equal((await app.sort('asc')).success, false);
    assert.equal(active.loadCalls, 0);
    assert.equal(active.layouts, 0);
    app.dispose();
});

test('another window cannot command the MAIN-world bridge', () => {
    const active = inventory([holder(1, 'A')]);
    const app = harness(active);
    app.post({ type: 'SORT', requestId: 'other-frame', steamId: STEAM_ID, order: 'original' }, { source: {} });
    assert.equal(active.loadCalls, 0);
    app.dispose();
});

test('INVENTORY cache classification requires a collector cache phrase', () => {
    const plain = holder(1, 'Weapon Cache');
    const actual = holder(2, 'Treasure');
    actual[0].rgItem.description.descriptions = [{ value: "Contents of the Collector's Cache" }];
    const app = harness(inventory([plain, actual]));
    const snapshot = app.messages.find(message => message.type === 'INVENTORY');
    assert.equal(snapshot.items[0].isCache, false);
    assert.equal(snapshot.items[1].isCache, true);
    app.dispose();
});
