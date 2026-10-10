const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridge = fs.readFileSync(path.join(__dirname, '..', 'trade-inject.js'), 'utf8');
const ME = '76561198000000001';
const THEM = '76561198000000002';

function asset(id, hash, extra = {}) {
    const attributes = new Map();
    const item = { id: String(id), appid: 570, contextid: '2', market_hash_name: hash, amount: 1, ...extra };
    item.element = { nodeType: 1, rgItem: item,
        setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
        removeAttribute: name => attributes.delete(name) };
    item.homeElement = { nodeType: 1, rgItem: item, style: {}, filtered: false };
    return item;
}

function inventory(owner, items) {
    return { owner, appid: 570, contextid: '2', initialized: true,
        rgInventory: Object.fromEntries(items.map(item => [item.id, item])),
        rgItemElements: items.map(item => item.homeElement), BIsPendingInventory: () => false,
        LayoutPages() { this.layouts = (this.layouts || 0) + 1; }, SetActivePage(page) { this.pageCurrent = page; } };
}

function harness(items = [asset(1, 'Plain')], options = {}) {
    const messages = [], listeners = new Map(), timers = [], intervals = [];
    let gemReads = 0;
    const me = { strSteamId: ME, rgContexts: { 570: { 2: {} } } };
    const them = { strSteamId: THEM, rgContexts: { 570: { 2: {} } } };
    const own = inventory(me, items), other = inventory(them, options.otherItems || [asset(1, 'Plain')]);
    me.rgContexts[570][2].inventory = own;
    them.rgContexts[570][2].inventory = other;
    const slots = { your_slots: [], their_slots: [], your_slots_currency: [], their_slots_currency: [] };
    const document = { getElementById: id => id in slots ? { querySelectorAll: () => slots[id] } : null };
    const window = { location: { origin: 'https://steamcommunity.com' }, UserYou: me, UserThem: them,
        g_ActiveInventory: own, g_ActiveUser: me,
        g_rgCurrentTradeStatus: { me: { assets: [], currency: [] }, them: { assets: [], currency: [] } },
        postMessage: message => messages.push(JSON.parse(JSON.stringify(message))),
        addEventListener: (type, listener) => listeners.set(type, listener), setInterval(callback, delay) { intervals.push({ callback, delay }); },
        setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {},
        SIHLiteGems: { analyzeSteamAsset: item => { gemReads++; return { hasGems: Boolean(item.description?.insertedGems) }; } } };
    if (options.prototypeValues) {
        for (const side of ['me', 'them']) for (const kind of ['assets', 'currency']) {
            Object.setPrototypeOf(window.g_rgCurrentTradeStatus[side][kind], Object.assign(Object.create(Array.prototype), {
                fixtureEnumerablePrototypeMethod() {}
            }));
        }
    }
    const prototype = options.prototypeValues ? 'Object.values = function(object) { const result = []; for (const key in object) result.push(object[key]); return result; };' : '';
    vm.runInNewContext(prototype + bridge, { window, document, globalThis: window });
    const send = (data, event = {}) => listeners.get('message')({ source: window, origin: window.location.origin, ...event,
        data: { source: 'SIH_LITE_TRADE_CONTENT', ...data } });
    return { window, me, them, own, other, slots, messages, timers, intervals, send, gemReads: () => gemReads,
        sort(data = {}) { send({ type: 'SORT', requestId: 'sort', ownerSteamId: ME, side: 'me',
            appId: '570', contextId: '2', order: 'desc', prices: { assetPrices: [], namePrices: [] }, ...data }); },
        state() { send({ type: 'STATE_REQUEST' }); timers.pop()?.(); return messages.filter(message => message.type === 'EDITOR').at(-1); } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (h, id = 'sort') => h.messages.find(message => message.type === 'SORT_RESULT' && message.requestId === id);

test('owner-scoped exact prices, zero prices and ordinary aliases sort safely; gem variants remain unknown', async () => {
    const h = harness([asset(2, 'Shared Wearable', { insertedGems: true }), asset(3, 'Plain'),
        asset(4, 'Plain'), asset(1, 'Shared Wearable', { insertedGems: true }),
        asset(5, 'Inscribed Plain'), asset(6, '', { name: 'Plain' }), asset(7, 'Fractal Horns of Inner Abysm')]);
    const prices = { assetPrices: [['1', 3000], ['3', 0]],
        namePrices: [['shared wearable', 9999], ['plain', 100], ['inscribed plain', 9999], ['fractal horns of inner abysm', 9999]] };
    h.sort({ prices }); await flush();
    assert.equal(result(h).success, true);
    assert.deepEqual(h.own.rgItemElements.map(holder => holder.rgItem.id), ['1', '4', '3', '2', '5', '6', '7']);
    assert.deepEqual(h.other.rgItemElements.map(holder => holder.rgItem.id), ['1'], 'same ID belonging to partner is untouched');
    h.sort({ requestId: 'asc', order: 'asc', prices }); await flush();
    assert.deepEqual(h.own.rgItemElements.map(holder => holder.rgItem.id), ['3', '4', '1', '2', '5', '6', '7']);
    h.sort({ requestId: 'restore', order: 'original' }); await flush();
    assert.deepEqual(h.own.rgItemElements.map(holder => holder.rgItem.id), ['2', '3', '4', '1', '5', '6', '7']);
});

test('foreign owners, malformed prices and unsupported requests fail promptly with owner correlation', async () => {
    const h = harness();
    for (const [requestId, data] of [['owner', { ownerSteamId: THEM }], ['app', { appId: '730' }],
        ['prices', { prices: { assetPrices: [['1', -1]], namePrices: [] } }]]) {
        h.sort({ requestId, ...data }); await flush();
        assert.equal(result(h, requestId).success, false);
        assert.equal(result(h, requestId).ownerSteamId, data.ownerSteamId || ME);
    }
    assert.equal(h.own.layouts, undefined);
});

test('a conflicting cleaned alias cannot borrow a cheaper exact name price', async () => {
    const h = harness([asset(1, 'Exalted Blade'), asset(2, 'Blade'), asset(3, 'Genuine Blade'), asset(4, 'Frozen Sword')]);
    // Blade 100 and Genuine Blade 200 conflict on cleaned "blade". Root removes
    // that ambiguous alias but keeps both unambiguous canonical exact names.
    h.sort({ prices: { assetPrices: [], namePrices: [['blade', 100], ['genuine blade', 200]],
        cleanNamePrices: [['sword', 50]] } });
    await flush();
    assert.equal(result(h).success, true);
    assert.deepEqual(h.own.rgItemElements.map(holder => holder.rgItem.id), ['3', '2', '4', '1']);
});

test('pending native replacement loads fully, reports owner progress and rejects a concurrent sort', async () => {
    const h = harness();
    const pending = { owner: h.me, appid: 570, contextid: '2', BIsPendingInventory: () => true };
    h.me.rgContexts[570][2].inventory = h.window.g_ActiveInventory = pending;
    h.sort({ prices: { assetPrices: [['2', 100]], namePrices: [] } });
    assert.equal(h.messages.find(message => message.type === 'SORT_PROGRESS').ownerSteamId, ME);
    h.sort({ requestId: 'busy', ownerSteamId: THEM, side: 'them' });
    assert.equal(result(h, 'busy').ownerSteamId, THEM);
    assert.equal(result(h, 'busy').success, false);
    const loaded = inventory(h.me, [asset(1, 'Plain'), asset(2, 'Plain')]);
    h.me.rgContexts[570][2].inventory = h.window.g_ActiveInventory = loaded;
    h.timers.shift()(); await flush();
    assert.equal(result(h).success, true);
    assert.deepEqual(loaded.rgItemElements.map(holder => holder.rgItem.id), ['2', '1']);
});

test('switching owners or a failed native load aborts pending work without changing any holders', async () => {
    for (const failure of ['switch', 'load']) {
        const h = harness();
        const pending = { owner: h.me, appid: 570, contextid: '2', BIsPendingInventory: () => true };
        h.me.rgContexts[570][2].inventory = h.window.g_ActiveInventory = pending;
        h.sort();
        if (failure === 'switch') h.window.g_ActiveInventory = h.other;
        else h.me.rgContexts[570][2].inventory = null;
        h.timers.shift()(); await flush();
        assert.equal(result(h).success, false);
        assert.equal(result(h).ownerSteamId, ME);
        assert.equal(h.other.layouts, undefined);
    }
});

test('offer snapshots keep offered quantities, currencies, invalid records and incomplete native slots', () => {
    const h = harness([asset(1, 'Plain', { amount: 3 })]);
    h.window.g_rgCurrentTradeStatus.me.assets = [
        { appid: 570, contextid: '2', assetid: '1', amount: 2 },
        { appid: 570, contextid: '2', assetid: '2', amount: 'bad' }, { appid: 570, amount: 1 }];
    h.window.g_rgCurrentTradeStatus.me.currency = [{ appid: 440, contextid: '2', currencyid: '99', amount: 5 }];
    const snapshot = h.state();
    assert.equal(snapshot.offers.me[0].amount, 2);
    assert.equal(snapshot.offers.me[1].amount, 0);
    assert.equal(snapshot.offers.me[2].assetId, null);
    assert.equal(snapshot.offers.me[2].amount, 0);
    assert.equal(snapshot.offers.me[3].isCurrency, true);
    assert.equal(snapshot.offers.me[3].currencyId, '99');
    assert.equal(snapshot.offers.me[3].amount, 5);
    assert.equal(snapshot.offersComplete.me, false);
    assert.equal(snapshot.offersComplete.them, true);
    delete h.window.g_rgCurrentTradeStatus.them;
    h.slots.their_slots.push(asset(123, 'Plain').element);
    const orphan = h.state();
    assert.equal(orphan.offers.them[0].assetId, '123');
    assert.equal(orphan.offersComplete.them, false);
    assert.equal(h.slots.their_slots[0].getAttribute('data-sih-trade-owner'), THEM);
});

test('Prototype enumerable array methods never become unresolved offered items or currencies', () => {
    const h = harness(undefined, { prototypeValues: true });
    let snapshot = h.state();
    assert.deepEqual(snapshot.offers, { me: [], them: [] });
    assert.deepEqual(snapshot.offersComplete, { me: true, them: true });
    h.window.g_rgCurrentTradeStatus.me.assets.push({ appid: 570, contextid: '2', assetid: '1', amount: 1 });
    h.window.g_rgCurrentTradeStatus.them.currency.push({ appid: 440, contextid: '2', currencyid: '99', amount: 5 });
    snapshot = h.state();
    assert.equal(snapshot.offers.me.length, 1);
    assert.equal(snapshot.offers.me[0].assetId, '1');
    assert.equal(snapshot.offers.them.length, 1);
    assert.equal(snapshot.offers.them[0].currencyId, '99');
    h.window.g_rgCurrentTradeStatus.me.assets.pop();
    h.window.g_rgCurrentTradeStatus.them.currency.pop();
    snapshot = h.state();
    assert.deepEqual(snapshot.offers, { me: [], them: [] });
    assert.deepEqual(snapshot.offersComplete, { me: true, them: true });
});

test('cross-window and cross-origin messages cannot trigger sorting', () => {
    const h = harness();
    const originalCount = h.messages.length;
    h.send({ source: 'UNTRUSTED_PAGE', type: 'STATE_REQUEST' });
    h.send({ type: 'STATE_REQUEST' }, { source: {} });
    h.send({ type: 'STATE_REQUEST' }, { origin: 'https://example.com' });
    assert.equal(h.messages.length, originalCount);
});

test('large own and partner inventories emit one bounded native page without scanning hidden asset dictionaries', () => {
    const ownItems = Array.from({ length: 6000 }, (_, index) => asset(1000 + index, `Own ${index}`));
    const otherItems = Array.from({ length: 6000 }, (_, index) => asset(20000 + index, `Partner ${index}`));
    const h = harness(ownItems, { otherItems });
    assert.equal(h.gemReads(), 16, 'only the active page is analyzed, never the 12000 loaded assets');
    let snapshot = h.state();
    assert.equal(snapshot.inventories.length, 1);
    assert.equal(snapshot.inventories[0].scope, 'visible');
    assert.equal(snapshot.inventories[0].loadedCount, 6000);
    assert.equal(snapshot.inventories[0].items.length, 16);
    assert.equal(JSON.stringify(snapshot).length < 12000, true);
    // A Proxy makes any accidental whole-dictionary enumeration fail loudly.
    h.own.rgInventory = new Proxy(h.own.rgInventory, { ownKeys() { throw new Error('Full asset scan'); } });
    h.other.rgInventory = new Proxy(h.other.rgInventory, { ownKeys() { throw new Error('Hidden owner asset scan'); } });
    const before = h.messages.length;
    for (let index = 0; index < 25; index++) h.intervals[0].callback();
    assert.equal(h.intervals[0].delay, 1000);
    assert.equal(h.messages.length, before, 'unchanged polls send no duplicate payload');
    assert.equal(h.gemReads(), 16, 'unchanged polls do not rerun gem analysis');
    for (let index = 0; index < 30; index++) h.send({ type: 'STATE_REQUEST' });
    assert.equal(h.timers.length, 1, 'bursts of content requests are coalesced');
    h.timers.shift()();
    assert.equal(h.gemReads(), 16, 'forced bounded snapshots reuse metadata');
    h.own.pageCurrent = 2;
    snapshot = h.state();
    assert.deepEqual(snapshot.inventories[0].items.map(item => item.assetId), ownItems.slice(32, 48).map(item => item.id));
    assert.equal(ownItems[0].element.getAttribute('data-sih-trade-visible'), undefined);
    assert.equal(ownItems[32].element.getAttribute('data-sih-trade-visible'), 'true');
    h.window.g_ActiveInventory = h.other;
    snapshot = h.state();
    assert.equal(snapshot.inventories[0].side, 'them');
    assert.equal(snapshot.inventories[0].items.length, 16);
    assert.equal(ownItems[32].element.getAttribute('data-sih-trade-visible'), undefined);
    assert.equal(otherItems[0].element.getAttribute('data-sih-trade-visible'), 'true');
    assert.equal(h.gemReads(), 48);
});

test('mounted native pages cap metadata at 128 while retaining offered items outside that page', () => {
    const items = Array.from({ length: 2500 }, (_, index) => asset(1000 + index, `Item ${index}`));
    const h = harness(items);
    h.own.pageList = [{ nodeType: 1, querySelectorAll: () => items.map(item => item.element) }];
    h.window.g_rgCurrentTradeStatus.me.assets = [{ appid: 570, contextid: '2', assetid: '3499', amount: 2 }];
    h.slots.your_slots.push(items.at(-1).element);
    const snapshot = h.state();
    assert.equal(snapshot.inventories[0].items.length, 128);
    assert.equal(snapshot.offers.me[0].assetId, '3499');
    assert.equal(snapshot.offers.me[0].amount, 2);
    assert.equal(snapshot.offersComplete.me, true);
    assert.equal(items.at(-1).element.getAttribute('data-sih-trade-owner'), ME);
});

test('large price sorting yields between bounded batches while preserving native order until completion', async () => {
    const items = Array.from({ length: 6000 }, (_, index) => asset(1000 + index, `Item ${index}`));
    const h = harness(items);
    const before = h.own.rgItemElements;
    h.sort({ prices: { assetPrices: items.map((item, index) => [item.id, index]), namePrices: [] } });
    await flush();
    assert.equal(result(h), undefined, 'sorting pauses so the browser can paint before processing all 6000 records');
    let heartbeats = 0;
    while (!result(h) && heartbeats < 40) {
        assert.equal(h.own.rgItemElements, before, 'native holder order remains untouched between batches');
        assert.deepEqual(h.own.rgItemElements.map(holder => holder.rgItem.id), items.map(item => item.id));
        h.timers.shift()?.();
        heartbeats++;
        await flush();
    }
    assert.equal(result(h)?.success, true);
    assert.equal(heartbeats, 29, '6000 records yield after each 200-record batch except the last');
    const progress = h.messages.filter(message => message.type === 'SORT_PROGRESS' && message.phase === 'pricing');
    assert.equal(progress.length, 29);
    assert.deepEqual(progress.map(message => message.loaded), Array.from({ length: 29 }, (_, index) => (index + 1) * 200));
    assert.ok(progress.every(message => message.ownerSteamId === ME && message.total === 6000));
    assert.deepEqual(h.own.rgItemElements.map(holder => holder.rgItem.id), items.map(item => item.id).reverse());
});

test('switching owners or replacing inventory during price batches aborts without mutating either inventory', async () => {
    for (const change of ['owner', 'inventory', 'holders']) {
        const items = Array.from({ length: 501 }, (_, index) => asset(1000 + index, `Item ${index}`));
        const h = harness(items);
        const before = h.own.rgItemElements;
        h.sort({ prices: { assetPrices: items.map((item, index) => [item.id, index]), namePrices: [] } });
        await flush();
        assert.equal(h.timers.length, 1);
        h.sort({ requestId: 'conflicting' });
        assert.equal(result(h, 'conflicting').success, false, 'busy state persists across yields');
        if (change === 'owner') h.window.g_ActiveInventory = h.other;
        else if (change === 'inventory') {
            const replacement = inventory(h.me, [asset(999, 'Replacement')]);
            h.me.rgContexts[570][2].inventory = h.window.g_ActiveInventory = replacement;
        } else h.own.rgItemElements = before.slice();
        h.timers.shift()();
        await flush();
        assert.equal(result(h).success, false);
        assert.equal(result(h).ownerSteamId, ME);
        assert.deepEqual(before.map(holder => holder.rgItem.id), items.map(item => item.id));
        assert.deepEqual(h.other.rgItemElements.map(holder => holder.rgItem.id), ['1']);
        assert.equal(h.own.layouts, undefined);
    }
});
