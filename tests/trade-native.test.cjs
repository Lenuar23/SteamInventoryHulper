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
        setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) };
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
    const messages = [], listeners = new Map(), timers = [];
    const me = { strSteamId: ME, rgContexts: { 570: { 2: {} } } };
    const them = { strSteamId: THEM, rgContexts: { 570: { 2: {} } } };
    const own = inventory(me, items), other = inventory(them, [asset(1, 'Plain')]);
    me.rgContexts[570][2].inventory = own;
    them.rgContexts[570][2].inventory = other;
    const slots = { your_slots: [], their_slots: [], your_slots_currency: [], their_slots_currency: [] };
    const document = { getElementById: id => id in slots ? { querySelectorAll: () => slots[id] } : null };
    const window = { location: { origin: 'https://steamcommunity.com' }, UserYou: me, UserThem: them,
        g_ActiveInventory: own, g_ActiveUser: me,
        g_rgCurrentTradeStatus: { me: { assets: [], currency: [] }, them: { assets: [], currency: [] } },
        postMessage: message => messages.push(JSON.parse(JSON.stringify(message))),
        addEventListener: (type, listener) => listeners.set(type, listener), setInterval() {},
        setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {},
        SIHLiteGems: { analyzeSteamAsset: item => ({ hasGems: Boolean(item.description?.insertedGems) }) } };
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
    return { window, me, them, own, other, slots, messages, timers, send,
        sort(data = {}) { send({ type: 'SORT', requestId: 'sort', ownerSteamId: ME, side: 'me',
            appId: '570', contextId: '2', order: 'desc', prices: { assetPrices: [], namePrices: [] }, ...data }); },
        state() { send({ type: 'STATE_REQUEST' }); return messages.filter(message => message.type === 'EDITOR').at(-1); } };
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
