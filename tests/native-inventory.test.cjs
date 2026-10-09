const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8');
const gemSource = () => fs.readFileSync(path.join(__dirname, '..', 'gems.js'), 'utf8');
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
    const node = { rgItem: { assetid: String(id), appid: 570, description: { market_hash_name: name, type: 'Rare Wearable' } }, filtered: false };
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

function gemHolder(id, name, type = 'Prismatic Gem') {
    const result = holder(id, name);
    const icon = type === 'Ethereal Gem' ? 'gem_effect' : type === 'Kinetic Gem' ? 'gem_kinetic' : 'gem_color';
    result[0].rgItem.description.descriptions = [{ type: 'html', value:
        `<div><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/${icon}.png)"></div><div><span style="font-size: 18px; color: rgb(161,255,89)">Bright Green</span><br><span style="font-size: 12px">${type}</span></div></div>`
    }];
    return result;
}

function nativeFilter(window) {
    return {
        elFilter: { value: '' }, strLastFilter: '', rgCurrentTags: {}, rgLastTags: {},
        MatchItem(element, terms, categories) {
            const description = element?.rgItem?.description;
            if (!description) return false;
            if (terms && !terms.every(term => `${description.market_hash_name} ${description.name || ''}`.toLowerCase().includes(term))) return false;
            return !categories || Object.values(categories).every(tags =>
                tags.some(tag => (description.tags || []).some(item => item.internal_name === tag)));
        },
        ApplyFilter(value) {
            this.strLastFilter = value;
            const active = window.g_ActiveInventory;
            const items = active.m_rgChildInventories ? active.m_rgChildInventories['2'] : active;
            const terms = value.trim() ? value.toLowerCase().trim().split(/\s+/) : false;
            const categories = Object.keys(this.rgCurrentTags).length ? this.rgCurrentTags : null;
            const all = !terms && !categories;
            active.visible = [];
            for (const item of items.m_rgItemElements) {
                item[0].filtered = !(all || this.MatchItem(item[0], terms, categories));
                if (!item[0].filtered) active.visible.push(item);
            }
            active.bFilterApplied = !all;
            active.m_cPages = Math.max(1, Math.ceil(active.visible.length / 25));
            active.m_rgPages = Array.from({ length: active.m_cPages }, (_, index) => ({ m_iPage: index,
                m_$Page: { children: () => ({ each(callback) {
                    active.visible.slice(index * 25, (index + 1) * 25).forEach(item => callback.call(item[0]));
                } }) }
            }));
        },
        ReApplyFilter() { this.ApplyFilter(this.elFilter.value); },
        OnFilterChange() { this.ApplyFilter(this.elFilter.value); },
        ClearTextFilter() { this.elFilter.value = ''; this.OnFilterChange(); },
        UpdateTagFiltering(tags) { this.rgLastTags = this.rgCurrentTags; this.rgCurrentTags = tags; this.OnFilterChange(); }
    };
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
    window.Filter = nativeFilter(window);
    const context = vm.createContext({ window, console });
    vm.runInContext(gemSource(), context);
    window.SIHLiteGems = context.SIHLiteGems;
    vm.runInContext(source, context);
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
        async filter(mode, coloredAssetIds = [], gemAssetIds = [], overrides = {}) {
            const requestId = `request-${++nextId}`;
            this.post({ type: 'FILTER_GEMS', requestId, steamId: STEAM_ID, mode, coloredAssetIds, gemAssetIds, ...overrides });
            for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setImmediate(resolve));
                const response = messages.find(message => message.type === 'FILTER_RESULT' && message.requestId === requestId);
                if (response) return response;
            }
            throw new Error('Gem filter did not reply');
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

test('colored gem filter includes prismatic and ethereal sockets but excludes kinetic and loose gems', async () => {
    const prismatic = gemHolder(1, 'Courier');
    const ethereal = gemHolder(2, 'Other Courier', 'Ethereal Gem');
    const kinetic = gemHolder(3, 'Weapon', 'Kinetic Gem');
    const loose = holder(4, 'Prismatic: Bright Green');
    loose[0].rgItem.description.type = 'Prismatic Gem';
    const ordinary = holder(5, 'No Gem');
    const active = inventory([prismatic, ethereal, kinetic, loose, ordinary]);
    const app = harness(active);
    const reply = await app.filter('colored');
    assert.equal(reply.success, true);
    assert.equal(reply.count, 2);
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['1', '2']);
    assert.deepEqual(app.window.Filter.rgCurrentTags, {}, 'Hidden category must not leak to Steam');
    assert.equal(app.messages.findLast(message => message.type === 'STATE').gemFilter, 'colored');
    const snapshot = app.messages.findLast(message => message.type === 'INVENTORY');
    assert.equal(snapshot.items[0].hasGems, true);
    assert.equal(snapshot.items[0].hasColoredGem, true);
    assert.equal(snapshot.items[2].hasGems, true);
    assert.equal(snapshot.items[2].hasColoredGem, false);
    assert.equal(snapshot.items[3].hasColoredGem, false);
    app.dispose();
});

test('gem toggle waits for all pages before committing filter or reporting its count', async () => {
    const active = inventory([holder(1, 'Ordinary')], { loaded: false, total: 2 });
    const app = harness(active);
    app.post({ type: 'FILTER_GEMS', requestId: 'late-gem', steamId: STEAM_ID, mode: 'colored' });
    assert.equal(active.layouts, 0);
    assert.equal(app.messages.findLast(message => message.type === 'STATE').gemFilter, 'all');
    active.finish([gemHolder(2, 'Later Page Courier')]);
    await new Promise(resolve => setImmediate(resolve));
    const reply = app.messages.find(message => message.type === 'FILTER_RESULT');
    assert.equal(reply.success, true);
    assert.equal(reply.count, 1);
    assert.equal(reply.total, 2);
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['2']);
    assert.ok(app.messages.some(message => message.type === 'FILTER_PROGRESS' && message.loaded === 2));
    app.dispose();
});

test('gem filtering composes with native text and tag filters and preserves price sort', async () => {
    const all = [gemHolder(1, 'Red Courier'), holder(2, 'Red Weapon'), gemHolder(3, 'Blue Courier'), gemHolder(4, 'Red Courier')];
    all[0][0].rgItem.description.tags = [{ internal_name: 'rare' }];
    all[2][0].rgItem.description.tags = [{ internal_name: 'rare' }];
    const active = inventory(all);
    const app = harness(active);
    assert.equal((await app.sort('desc', [['1', 10], ['2', 20], ['3', 30], ['4', 40]])).success, true);
    assert.equal((await app.filter('colored')).success, true);
    assert.deepEqual(ids(active), ['4', '3', '2', '1']);
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['4', '3', '1']);
    app.window.Filter.elFilter.value = 'Red';
    app.window.Filter.OnFilterChange();
    app.window.Filter.UpdateTagFiltering({ Rarity: ['rare'] });
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['1']);
    app.window.Filter.ClearTextFilter();
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['3', '1']);
    assert.equal((await app.filter('all')).success, true);
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['3', '1'], 'Native rarity tag survives gem toggle');
    app.window.Filter.UpdateTagFiltering({});
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['4', '3', '2', '1']);
    assert.equal((await app.sort('original')).success, true);
    assert.deepEqual(ids(active), ['1', '2', '3', '4']);
    assert.equal(active.m_rgItemElements[0].clickHandler(), '1');
    app.dispose();
});

test('explicit Steamprice colored identifiers are additive and gem-only mode remains separate', async () => {
    const active = inventory([gemHolder(1, 'Colored'), gemHolder(2, 'Kinetic', 'Kinetic Gem'), holder(3, 'API Colored')]);
    const app = harness(active);
    assert.equal((await app.filter('colored', ['3'])).count, 2);
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['1', '3']);
    assert.equal((await app.filter('gems', ['3'])).count, 3);
    app.dispose();
});

test('empty gem results use one native page and disabling restores all item holders', async () => {
    const active = inventory([holder(1, 'Ordinary'), holder(2, 'Ordinary 2')]);
    const app = harness(active);
    assert.equal((await app.filter('colored')).count, 0);
    assert.equal(active.m_cPages, 1);
    assert.deepEqual(active.visible, []);
    assert.equal((await app.filter('all')).count, 2);
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['1', '2']);
    assert.equal(active.m_rgItemElements[1].clickHandler(), '2');
    app.dispose();
});

test('failed gem load preserves current mode and malformed gem requests cannot load inventory', async () => {
    const active = inventory([holder(1, 'Ordinary')], { loaded: false, total: 2 });
    const app = harness(active);
    assert.equal((await app.filter('invalid')).success, false);
    assert.equal((await app.filter('colored', ['invalid-id'])).success, false);
    assert.equal((await app.filter('colored', [], [], { steamId: '76561198000000001' })).success, false);
    assert.equal(active.loadCalls, 0);
    app.post({ type: 'FILTER_GEMS', requestId: 'failed-gems', steamId: STEAM_ID, mode: 'colored' });
    active.fail();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.messages.find(message => message.type === 'FILTER_RESULT' && message.requestId === 'failed-gems').success, false);
    assert.equal(app.messages.findLast(message => message.type === 'STATE').gemFilter, 'all');
    assert.equal(active.layouts, 0);
    app.dispose();
});

test('gem mode stays with its native inventory and never leaks to another owner or game', async () => {
    const active = inventory([gemHolder(1, 'Gem'), holder(2, 'Ordinary')]);
    const app = harness(active);
    assert.equal((await app.filter('colored')).success, true);
    const other = inventory([holder(9, 'Other')]);
    other.m_steamid = '76561198000000001';
    app.window.g_ActiveInventory = other;
    app.tick();
    assert.equal(app.messages.findLast(message => message.type === 'STATE').gemFilter, 'all');
    app.window.Filter.ReApplyFilter();
    assert.deepEqual(other.visible.map(item => item[0].rgItem.assetid), ['9']);
    app.window.g_ActiveInventory = active;
    app.tick();
    app.window.Filter.ReApplyFilter();
    assert.equal(app.messages.findLast(message => message.type === 'STATE').gemFilter, 'colored');
    assert.deepEqual(active.visible.map(item => item[0].rgItem.assetid), ['1']);
    app.dispose();
});
