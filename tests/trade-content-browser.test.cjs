const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const OWNER = '76561198012345678';
const PARTNER = '76561198087654321';
const THIRD_OWNER = '76561198011111111';
let browser;

before(async () => {
    browser = await chromium.launch({
        executablePath: process.env.SIH_CHROMIUM_PATH || '/usr/lib/chromium/chromium',
        headless: true,
        args: ['--no-sandbox']
    });
});
after(async () => { if (browser) await browser.close(); });

function item(ownerSteamId, assetId, name, amount = '1', extra = {}) {
    return { ownerSteamId, assetId, name, market_hash_name: name, appId: '570', contextId: '2', amount, ...extra };
}

function slot(record, side, location) {
    return `<div class="${location === 'inventory' ? 'itemHolder' : 'trade_slot'}"><div class="slot_inner"><div class="item"
        data-sih-trade-owner="${record.ownerSteamId}" data-sih-trade-asset="${record.assetId}"
        data-sih-trade-app="${record.appId}" data-sih-trade-context="${record.contextId}" data-sih-trade-side="${side}"
        id="${location}_${side}_${record.assetId}"><img alt="${record.name}"></div></div></div>`;
}

function editorSnapshot({ partner = PARTNER, me = [], them = [], mine = [], theirs = [], active = 'me', appId = '570' } = {}) {
    return {
        source: 'SIH_LITE_TRADE_PAGE', type: 'EDITOR', owners: { me: { steamId: OWNER }, them: { steamId: partner } },
        active: { side: active, ownerSteamId: active === 'me' ? OWNER : partner,
            appId, contextId: '2', supported: appId === '570', order: 'original', loading: false },
        inventories: [
            { side: 'me', ownerSteamId: OWNER, appId: '570', contextId: '2', items: mine },
            { side: 'them', ownerSteamId: partner, appId: '570', contextId: '2', items: theirs }
        ],
        offers: { me, them }
    };
}

function editorHtml(snapshot) {
    return `<!doctype html><html><head><title>Steam trade editor fixture</title><style>
        .item {position:relative;width:96px;height:96px;display:inline-block}
        .itemHolder,.trade_slot {display:inline-block} #inventories {min-height:100px}
        </style></head><body><div id="trade_area"><div id="inventory_box"><div id="inventory_select">
        <a id="inventory_select_your_inventory">Your inventory</a><a id="inventory_select_their_inventory">Their inventory</a>
        </div><div id="inventories">${snapshot.inventories.map(inventory =>
            `<div id="inventory_${inventory.side}">${inventory.items.map(record => slot(record, inventory.side, 'inventory')).join('')}</div>`).join('')}
        </div><div id="inventory_pagecontrols"></div></div><div id="trade_box">
        <div id="your_items"><div id="your_slots">${snapshot.offers.me.map(record => slot(record, 'me', 'offer')).join('')}</div></div>
        <div id="their_items"><div id="their_slots">${snapshot.offers.them.map(record => slot(record, 'them', 'offer')).join('')}</div></div>
        </div></div></body></html>`;
}

async function frames(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitText(locator, expected) {
    await locator.filter({ hasText: expected }).waitFor({ state: 'visible' });
    assert.equal(await locator.textContent(), expected);
}

const DEFAULT_PRICES = {
    [OWNER]: [
        { assetid: '100', marketHashName: 'Shared Item', priceCents: '250' },
        { assetid: '101', marketHashName: 'Free Item', priceCents: '0' },
        { assetid: '102', marketHashName: 'Ordinary Item', priceCents: '125' }
    ],
    [PARTNER]: [
        { assetid: '100', marketHashName: 'Shared Item', priceCents: '900' },
        { assetid: '103', marketHashName: 'Partner Item', priceCents: '200' }
    ],
    [THIRD_OWNER]: [{ assetid: '100', marketHashName: 'Shared Item', priceCents: '700' }]
};

async function openFixture(t, options = {}) {
    const snapshot = options.snapshot || editorSnapshot({
        me: [item(OWNER, '100', 'Shared Item', '2')], them: [item(PARTNER, '100', 'Shared Item')],
        mine: [item(OWNER, '101', 'Free Item'), item(OWNER, '102', 'Ordinary Item')],
        theirs: [item(PARTNER, '103', 'Partner Item')]
    });
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], 'trade content script raised a browser error'));
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: options.html || editorHtml(snapshot) }));
    await page.goto(options.url || 'https://steamcommunity.com/tradeoffer/new/?partner=123456');
    await page.evaluate(config => {
        window.__chromeRequests = [];
        window.__pendingResponses = [];
        window.__tradeRequests = [];
        window.__acceptRequests = [];
        window.__fetchRequests = [];
        window.__pendingFetches = [];
        window.__tradeSnapshot = config.snapshot;
        window.__sortReply = config.sortReply || { success: true, count: 4 };
        const callCounts = new Map();
        window.chrome = { runtime: {
            lastError: undefined,
            sendMessage(request, callback) {
                window.__chromeRequests.push(request);
                const key = `${request.steamId}:${request.action}`;
                const index = callCounts.get(key) || 0;
                callCounts.set(key, index + 1);
                const plans = config.plans?.[key] || config.plans?.[request.action];
                const response = plans ? plans[Math.min(index, plans.length - 1)] : {
                    success: true, data: request.action === 'fetchPrices'
                        ? { items: config.prices[request.steamId] || [] }
                        : { totalValueCents: config.totals[request.steamId] ?? '0' }
                };
                if (response?.hold) window.__pendingResponses.push({ request, callback });
                else setTimeout(() => callback(response), 0);
            }
        } };
        const fetchCounts = new Map();
        const fetchResponse = plan => ({
            ok: (plan.status ?? 200) >= 200 && (plan.status ?? 200) < 300,
            status: plan.status ?? 200,
            json: async () => plan.data,
            text: async () => plan.text || JSON.stringify(plan.data)
        });
        window.fetch = async (url, init = {}) => {
            window.__fetchRequests.push({ url: String(url), method: init.method || 'GET', body: String(init.body || '') });
            const plans = config.fetchPlans?.[String(url)];
            if (plans) {
                const index = fetchCounts.get(String(url)) || 0;
                fetchCounts.set(String(url), index + 1);
                const plan = plans[Math.min(index, plans.length - 1)];
                if (plan.hold) return new Promise(resolve => window.__pendingFetches.push({ url: String(url),
                    resolve: response => resolve(fetchResponse(response)) }));
                if (plan.reject) throw new Error(plan.reject);
                return fetchResponse(plan);
            }
            throw new Error('Unexpected fetch: trade browser fixtures never send requests.');
        };
        if (config.sessionId) document.cookie = `sessionid=${config.sessionId}; path=/; secure`;
        window.addEventListener('message', event => {
            const message = event.data;
            if (event.source !== window || message?.source !== 'SIH_LITE_TRADE_CONTENT') return;
            window.__tradeRequests.push(message);
            if (message.type === 'STATE_REQUEST') {
                window.postMessage(window.__tradeSnapshot, location.origin);
            } else if (message.type === 'SORT' && !window.__sortReply.hold) {
                setTimeout(() => {
                    if (window.__sortReply.success) window.__tradeSnapshot.active.order = message.order;
                    window.postMessage({ source: 'SIH_LITE_TRADE_PAGE', type: 'SORT_RESULT', requestId: message.requestId,
                        ownerSteamId: message.ownerSteamId, ...window.__sortReply }, location.origin);
                }, 0);
            }
        });
    }, {
        snapshot, prices: options.prices || DEFAULT_PRICES,
        totals: options.totals || { [OWNER]: '12345', [PARTNER]: '67890', [THIRD_OWNER]: '54321' },
        plans: options.plans, sortReply: options.sortReply,
        fetchPlans: options.fetchPlans, sessionId: options.sessionId === undefined ? 'fixture_session_123' : options.sessionId
    });
    for (const file of ['gems.js', 'trade-prices.js', 'trade-offers.js', 'trade-accept.js', 'trade-content.js']) {
        await page.addScriptTag({ path: path.join(__dirname, '..', file) });
    }
    await page.locator(options.panel || '#sih-lite-trade-editor-summary').first().waitFor({ state: 'attached' });
    return page;
}

async function sendSnapshot(page, snapshot, { replaceHtml = false } = {}) {
    await page.evaluate(({ next, html }) => {
        window.__tradeSnapshot = next;
        if (html) document.body.innerHTML = html;
        window.postMessage(next, location.origin);
    }, { next: snapshot, html: replaceHtml ? editorHtml(snapshot).split('<body>')[1].split('</body>')[0] : null });
    await frames(page);
}

const summary = page => page.locator('#sih-lite-trade-editor-summary');
const role = (page, name) => summary(page).locator(`[data-role="${name}"]`);
const panel = page => page.locator('#sih-lite-trade-inventory-panel');
const sortButton = (page, order) => page.locator(`[data-trade-order="${order}"]`);
const badge = (page, side, assetId, location = 'offer') => page.locator(`#${location}_${side}_${assetId} .sih-lite-trade-price`);

test('trade editor scopes item prices to each owner and totals stacks separately from complete inventory values', async t => {
    const page = await openFixture(t);
    await waitText(badge(page, 'them', '100'), '$9.00');
    await page.waitForFunction(() => document.querySelector('#sih-lite-trade-editor-summary [data-role="net"]')?.textContent.includes('4.00'));
    assert.match(await role(page, 'give').textContent(), /\$5\.00/);
    assert.match(await role(page, 'receive').textContent(), /\$9\.00/);
    assert.match(await role(page, 'net').textContent(), /Net gain.*\+\$4\.00/);
    assert.match(await badge(page, 'me', '100').textContent(), /\$2\.50|\$5\.00/);
    await waitText(badge(page, 'me', '101', 'inventory'), '$0.00');
    await waitText(badge(page, 'them', '103', 'inventory'), '$2.00');
    assert.match(await panel(page).locator('[data-role="inventory-me"]').textContent(), /\$123\.45/);
    assert.match(await panel(page).locator('[data-role="inventory-them"]').textContent(), /\$678\.90/);
    const calls = await page.evaluate(() => window.__chromeRequests);
    assert.ok(calls.some(request => request.steamId === OWNER && request.action === 'fetchPrices'));
    assert.ok(calls.some(request => request.steamId === PARTNER && request.action === 'fetchPrices'));
    assert.deepEqual(await page.evaluate(() => window.__fetchRequests), []);
});

test('zero-priced items count as known and an empty receiving side produces an exact loss', async t => {
    const page = await openFixture(t, { snapshot: editorSnapshot({
        me: [item(OWNER, '100', 'Shared Item'), item(OWNER, '101', 'Free Item')], them: []
    }) });
    await waitText(badge(page, 'me', '101'), '$0.00');
    assert.match(await role(page, 'give').textContent(), /\$2\.50/);
    assert.match(await role(page, 'receive').textContent(), /\$0\.00/);
    assert.match(await role(page, 'net').textContent(), /Net loss.*[−-]\$2\.50/);
});

test('unknown gem prices show known partial values without reporting a confident gain or loss', async t => {
    const page = await openFixture(t, { snapshot: editorSnapshot({
        me: [item(OWNER, '100', 'Shared Item'), item(OWNER, '999', 'Fractal Horns of Inner Abysm', '1', { hasGems: true })],
        them: [item(PARTNER, '100', 'Shared Item')]
    }) });
    await waitText(badge(page, 'them', '100'), '$9.00');
    assert.match(await role(page, 'give').textContent(), /\$2\.50/);
    assert.match(await role(page, 'net').textContent(), /Known difference/);
    assert.doesNotMatch(await role(page, 'net').textContent(), /Net gain|Net loss|Even/);
    assert.equal(await badge(page, 'me', '999').count(), 0);
    assert.match(await summary(page).textContent(), /unknown|unpriced|partial|missing/i);
});

test('non-Dota items prevent a complete trade valuation and never borrow Dota asset prices', async t => {
    const page = await openFixture(t, { snapshot: editorSnapshot({
        me: [item(OWNER, '100', 'Shared Item')],
        them: [item(PARTNER, '100', 'CS item', '1', { appId: '730' })]
    }) });
    await page.waitForFunction(() => document.querySelector('#sih-lite-trade-editor-summary [data-role="give"]')?.textContent.includes('$2.50'));
    assert.equal(await badge(page, 'them', '100').count(), 0);
    assert.match(await role(page, 'net').textContent(), /Known difference/);
    assert.doesNotMatch(await role(page, 'net').textContent(), /Net gain|Net loss|Even/);
});

test('unresolved empty offer details remain incomplete until the native snapshot confirms both sides', async t => {
    const snapshot = editorSnapshot();
    snapshot.offersComplete = { me: false, them: false };
    const page = await openFixture(t, { snapshot });
    assert.match(await role(page, 'net').textContent(), /Known difference.*\$0\.00/);
    assert.doesNotMatch(await role(page, 'net').textContent(), /Even|Net gain|Net loss/);
    assert.match(await role(page, 'status').textContent(), /Trade item details are incomplete/);
    await sendSnapshot(page, { ...snapshot, offersComplete: { me: true, them: true } });
    assert.equal(await role(page, 'net').textContent(), 'Even: $0.00');
    assert.doesNotMatch(await role(page, 'status').textContent(), /incomplete/);
});

test('offer edits recalculate both sides while full inventory totals stay unchanged', async t => {
    const page = await openFixture(t);
    await waitText(badge(page, 'them', '100'), '$9.00');
    await sendSnapshot(page, editorSnapshot({ me: [item(OWNER, '101', 'Free Item')], them: [],
        mine: [item(OWNER, '102', 'Ordinary Item')], theirs: [item(PARTNER, '103', 'Partner Item')] }), { replaceHtml: true });
    await waitText(badge(page, 'me', '101'), '$0.00');
    assert.match(await role(page, 'net').textContent(), /Even.*\$0\.00/);
    assert.match(await panel(page).locator('[data-role="inventory-me"]').textContent(), /\$123\.45/);
    assert.match(await panel(page).locator('[data-role="inventory-them"]').textContent(), /\$678\.90/);
    assert.equal(await badge(page, 'them', '100').count(), 0);
});

test('partner inventory sorting uses the partner price map and preserves both inventory values', async t => {
    const snapshot = editorSnapshot({ active: 'them', me: [item(OWNER, '100', 'Shared Item')],
        them: [item(PARTNER, '100', 'Shared Item')], theirs: [item(PARTNER, '103', 'Partner Item')] });
    const page = await openFixture(t, { snapshot });
    await waitText(badge(page, 'them', '100'), '$9.00');
    await sortButton(page, 'desc').click();
    await page.waitForFunction(() => window.__tradeRequests.some(request => request.type === 'SORT'));
    const request = await page.evaluate(() => window.__tradeRequests.find(request => request.type === 'SORT'));
    assert.equal(request.ownerSteamId, PARTNER);
    assert.equal(request.side, 'them');
    assert.equal(request.appId, '570');
    assert.equal(request.contextId, '2');
    assert.equal(request.order, 'desc');
    assert.deepEqual(request.prices.assetPrices, [['100', 900], ['103', 200]]);
    assert.match(await panel(page).locator('[data-role="inventory-me"]').textContent(), /\$123\.45/);
    assert.match(await panel(page).locator('[data-role="inventory-them"]').textContent(), /\$678\.90/);
});

test('sorting keeps gem asset prices separate and excludes their shared name from native fallback aliases', async t => {
    const gemName = 'Fractal Horns of Inner Abysm';
    const page = await openFixture(t, {
        snapshot: editorSnapshot({
            mine: [item(OWNER, '100', gemName, '1', { hasGems: true }), item(OWNER, '999', gemName, '1', { hasGems: true })],
            me: [item(OWNER, '999', gemName, '1', { hasGems: true })]
        }),
        prices: { ...DEFAULT_PRICES, [OWNER]: [
            { assetid: '100', marketHashName: gemName, priceCents: 10000, prismaticGems: ['Deep Blue'] },
            { assetid: '102', marketHashName: 'Ordinary Item', priceCents: 125 }
        ] }
    });
    await waitText(badge(page, 'me', '100', 'inventory'), '$100.00');
    assert.equal(await badge(page, 'me', '999', 'inventory').count(), 0);
    assert.equal(await badge(page, 'me', '999').count(), 0);
    assert.match(await role(page, 'net').textContent(), /Known difference/);
    await sortButton(page, 'desc').click();
    await page.waitForFunction(() => window.__tradeRequests.some(request => request.type === 'SORT'));
    const prices = await page.evaluate(() => window.__tradeRequests.find(request => request.type === 'SORT').prices);
    assert.deepEqual(prices.assetPrices, [['100', 10000], ['102', 125]]);
    assert.deepEqual(prices.namePrices, [['ordinary item', 125]]);
});

test('a failed editor sort reports the error and allows a later retry', async t => {
    const page = await openFixture(t, { sortReply: { success: false, error: 'Partner inventory could not load.' } });
    await waitText(badge(page, 'them', '100'), '$9.00');
    await sortButton(page, 'desc').click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-trade-inventory-panel')?.textContent.includes('Partner inventory could not load.'));
    await page.waitForFunction(() => !document.querySelector('[data-trade-order="desc"]').disabled);
    await page.evaluate(() => { window.__sortReply = { success: true, count: 4 }; });
    await sortButton(page, 'asc').click();
    await page.waitForFunction(() => window.__tradeRequests.filter(request => request.type === 'SORT').length === 2);
    assert.deepEqual(await page.evaluate(() => window.__tradeRequests.filter(request => request.type === 'SORT').map(request => request.order)), ['desc', 'asc']);
});

test('late responses from a previous partner cannot price the replacement partner inventory or offer', async t => {
    const page = await openFixture(t, { plans: {
        [`${PARTNER}:fetchPrices`]: [{ hold: true }], [`${PARTNER}:fetchProfile`]: [{ hold: true }]
    } });
    await page.waitForFunction(() => window.__pendingResponses.length >= 2);
    await sendSnapshot(page, editorSnapshot({ partner: THIRD_OWNER, active: 'them',
        me: [item(OWNER, '100', 'Shared Item')], them: [item(THIRD_OWNER, '100', 'Shared Item')] }), { replaceHtml: true });
    await waitText(badge(page, 'them', '100'), '$7.00');
    await page.evaluate(() => {
        for (const pending of window.__pendingResponses.splice(0)) pending.callback({ success: true,
            data: pending.request.action === 'fetchPrices'
                ? { items: [{ assetid: '100', marketHashName: 'Shared Item', priceCents: 9900 }] }
                : { totalValueCents: 999999 } });
    });
    await frames(page);
    assert.equal(await badge(page, 'them', '100').textContent(), '$7.00');
    assert.match(await panel(page).locator('[data-role="inventory-them"]').textContent(), /\$543\.21/);
    assert.doesNotMatch(await panel(page).textContent(), /9,999\.99|9999\.99/);
});

test('retry recovers one owner without discarding the other owner prices and valuation', async t => {
    const page = await openFixture(t, { plans: {
        [`${OWNER}:fetchPrices`]: [{ success: false, error: 'Your prices offline.' }, { success: true, data: { items: DEFAULT_PRICES[OWNER] } }],
        [`${OWNER}:fetchProfile`]: [{ success: false, error: 'Your total offline.' }, { success: true, data: { totalValueCents: '12345' } }]
    } });
    await waitText(badge(page, 'them', '100'), '$9.00');
    await page.waitForFunction(() => document.querySelector('#sih-lite-trade-inventory-panel')?.textContent.includes('Your prices offline.'));
    await page.locator('#sih-lite-trade-retry').click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-trade-editor-summary [data-role="net"]')?.textContent.includes('4.00'));
    assert.match(await role(page, 'net').textContent(), /Net gain/);
    assert.match(await panel(page).locator('[data-role="inventory-me"]').textContent(), /\$123\.45/);
    assert.equal(await badge(page, 'them', '100').textContent(), '$9.00');
});

function listOffer(offerId = '500', { incoming = true, active = true,
    give = [item(OWNER, '100', 'Shared Item', '2')], receive = [item(PARTNER, '100', 'Shared Item')] } = {}) {
    return { offerId, partnerSteamId: PARTNER, incoming, active, canAccept: incoming && active, give, receive,
        slots: [
            ...give.map((record, index) => ({ key: `${offerId}:give:${index}`, side: 'give', item: record })),
            ...receive.map((record, index) => ({ key: `${offerId}:receive:${index}`, side: 'receive', item: record }))
        ] };
}

function listSnapshot(offers = [listOffer()]) {
    return { source: 'SIH_LITE_TRADE_PAGE', type: 'OFFERS', meSteamId: OWNER, offers };
}

function listHtml(snapshot) {
    const accountId = owner => String(BigInt(owner) - 76561197960265728n);
    const section = (offer, side, primary) => {
        const owner = side === 'give' ? OWNER : PARTNER;
        return `<div class="tradeoffer_items ${primary ? 'primary' : 'secondary'}">
            <a class="tradeoffer_avatar" href="https://steamcommunity.com/profiles/${owner}/" data-miniprofile="${accountId(owner)}"></a>
            <div class="tradeoffer_item_list">${offer[side].map((record, index) => {
                const key = `${offer.offerId}:${side}:${index}`;
                const economy = record.assetId ? `${record.appId}/${record.contextId}/${record.assetId}/${owner}/a:${record.amount}`
                    : `classinfo/${record.appId}/${record.classId || '1000'}/${record.instanceId || '0'}/a:${record.amount}`;
                return `<div class="trade_item" id="list_${offer.offerId}_${side}_${index}" data-sih-trade-key="${key}"
                    data-economy-item="${economy}"><img alt="${record.name || ''}"></div>`;
            }).join('')}</div></div>`;
    };
    return `<!doctype html><html><head><title>Steam trade offers fixture</title><style>
        .trade_item {position:relative;display:inline-block;width:96px;height:96px}
        </style></head><body><div class="tradeoffers">${snapshot.offers.map(offer => {
            const first = offer.incoming ? 'receive' : 'give', second = offer.incoming ? 'give' : 'receive';
            return `<div class="tradeoffer" id="tradeofferid_${offer.offerId}">
                <div class="tradeoffer_items_ctn ${offer.active ? 'active' : 'inactive'}">
                    ${section(offer, first, true)}${section(offer, second, false)}</div>
                ${offer.active ? '' : '<div class="tradeoffer_items_banner">Trade offer declined</div>'}
                <div class="tradeoffer_footer_actions"><a href="#" onclick="${offer.incoming ? 'DeclineTradeOffer' : 'CancelTradeOffer'}('${offer.offerId}');return false;">${offer.incoming ? 'Decline' : 'Cancel'}</a></div>
                </div>`;
        }).join('')}</div></body></html>`;
}

async function openList(t, options = {}) {
    const snapshot = options.snapshot || listSnapshot();
    return openFixture(t, { ...options, snapshot, html: listHtml(snapshot),
        url: `https://steamcommunity.com/profiles/${OWNER}/tradeoffers/${options.sent ? 'sent/' : ''}`,
        panel: '.sih-lite-trade-summary' });
}

const offerSummary = (page, offerId = '500') => page.locator(`.sih-lite-trade-summary[data-offer-id="${offerId}"]`);
const listBadge = (page, side, index = 0, offerId = '500') => page.locator(`#list_${offerId}_${side}_${index} .sih-lite-trade-price`);
const fastAccept = (page, offerId = '500') => offerSummary(page, offerId).locator('.sih-lite-fast-accept');
const acceptStatus = (page, offerId = '500') => offerSummary(page, offerId).locator('.sih-lite-trade-accept-status');

test('offer-list direction and owner-specific prices remain correct for incoming, outgoing and historical offers', async t => {
    const page = await openList(t, { snapshot: listSnapshot([
        listOffer('500'), listOffer('501', { incoming: false }), listOffer('502', { active: false })
    ]) });
    await waitText(listBadge(page, 'receive'), '$9.00');
    for (const id of ['500', '501', '502']) {
        await waitText(listBadge(page, 'give', 0, id), '$5.00');
        assert.match(await offerSummary(page, id).locator('[data-role="give"]').textContent(), /\$5\.00/);
        assert.match(await offerSummary(page, id).locator('[data-role="receive"]').textContent(), /\$9\.00/);
        assert.match(await offerSummary(page, id).locator('[data-role="net"]').textContent(), /Net gain.*\+\$4\.00/);
    }
    assert.equal(await fastAccept(page).count(), 1);
    assert.equal(await fastAccept(page, '501').count(), 0);
    assert.equal(await fastAccept(page, '502').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__fetchRequests), []);
});

test('class-only offer-list cards hydrate exact native assets without pretending a class ID is an asset ID', async t => {
    const snapshot = listSnapshot([listOffer('500', {
        give: [item(OWNER, null, 'Shared Item', '2', { classId: '1000', instanceId: '0' })],
        receive: [item(PARTNER, null, 'Shared Item', '1', { classId: '2000', instanceId: '0' })]
    })]);
    const details = `<script>var g_steamID = '${OWNER}'; var g_ulTradePartnerSteamID = '${PARTNER}';
        var g_rgCurrentTradeStatus = ${JSON.stringify({ me: { assets: [{ appid: 570, contextid: '2', assetid: '100', amount: '2', classid: '1000', instanceid: '0' }] },
            them: { assets: [{ appid: 570, contextid: '2', assetid: '100', amount: '1', classid: '2000', instanceid: '0' }] } })};
        BeginTradeOffer('500', false);</script>`;
    const page = await openList(t, { snapshot, fetchPlans: { 'https://steamcommunity.com/tradeoffer/500/': [{ text: details }] } });
    await waitText(listBadge(page, 'give'), '$5.00');
    await waitText(listBadge(page, 'receive'), '$9.00');
    assert.match(await offerSummary(page).locator('[data-role="net"]').textContent(), /Net gain.*\+\$4\.00/);
    const calls = await page.evaluate(() => window.__fetchRequests);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://steamcommunity.com/tradeoffer/500/');
    assert.equal(calls[0].method, 'GET');
});

test('native asset-only trade status hydrates class identities and matches reordered list cards by identity', async t => {
    const gemName = 'Fractal Horns of Inner Abysm';
    const snapshot = listSnapshot([listOffer('500', {
        give: [
            item(OWNER, null, gemName, '1', { classId: '1000', instanceId: '0' }),
            item(OWNER, null, gemName, '1', { classId: '1001', instanceId: '0' })
        ],
        receive: [item(PARTNER, null, gemName, '1', { classId: '2000', instanceId: '0' })]
    })]);
    // Steam's real trade status includes asset IDs, not class descriptions. Its
    // array order does not establish which class-only card represents an asset.
    const status = { me: { assets: [
        { appid: 570, contextid: '2', assetid: '102', amount: '1' },
        { appid: 570, contextid: '2', assetid: '100', amount: '1' }
    ] }, them: { assets: [{ appid: 570, contextid: '2', assetid: '100', amount: '1' }] } };
    const details = `<script>var g_steamID = '${OWNER}'; var g_ulTradePartnerSteamID = '${PARTNER}';
        var g_rgCurrentTradeStatus = ${JSON.stringify(status)}; BeginTradeOffer('500', false);</script>`;
    const inventory = records => ({ success: 1, more_items: false, assets: records.map(record => ({
        appid: 570, contextid: '2', assetid: record.assetid, classid: record.classid, instanceid: '0'
    })), descriptions: records.map(record => ({ appid: 570, classid: record.classid, instanceid: '0',
        market_hash_name: record.name })) });
    const page = await openList(t, { snapshot, prices: {
        [OWNER]: [{ assetid: '100', marketHashName: gemName, priceCents: 250 },
            { assetid: '102', marketHashName: gemName, priceCents: 125 }],
        [PARTNER]: [{ assetid: '100', marketHashName: gemName, priceCents: 900 }]
    }, fetchPlans: {
        'https://steamcommunity.com/tradeoffer/500/': [{ text: details }],
        [`https://steamcommunity.com/inventory/${OWNER}/570/2/?l=english&count=2000`]: [{ data: inventory([
            { assetid: '100', classid: '1000', name: gemName },
            { assetid: '102', classid: '1001', name: gemName }
        ]) }],
        [`https://steamcommunity.com/inventory/${PARTNER}/570/2/?l=english&count=2000`]: [{ data: inventory([
            { assetid: '100', classid: '2000', name: gemName }
        ]) }]
    } });
    await waitText(listBadge(page, 'give', 0), '$2.50');
    await waitText(listBadge(page, 'give', 1), '$1.25');
    await waitText(listBadge(page, 'receive'), '$9.00');
    assert.match(await offerSummary(page).locator('[data-role="give"]').textContent(), /\$3\.75/);
    assert.match(await offerSummary(page).locator('[data-role="net"]').textContent(), /Net gain.*\+\$5\.25/);
    const calls = await page.evaluate(() => window.__fetchRequests);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.method === 'GET'));
});

test('a failed class inventory lookup keeps exact trade totals and manual retry restores verified gem card prices', async t => {
    const gemName = 'Fractal Horns of Inner Abysm';
    const snapshot = listSnapshot([listOffer('500', {
        give: [item(OWNER, null, gemName, '2', { classId: '1000', instanceId: '0' })],
        receive: [item(PARTNER, null, gemName, '1', { classId: '2000', instanceId: '0' })]
    })]);
    const status = { me: { assets: [{ appid: 570, contextid: '2', assetid: '100', amount: '2' }] },
        them: { assets: [{ appid: 570, contextid: '2', assetid: '100', amount: '1' }] } };
    const details = `<script>var g_steamID = '${OWNER}'; var g_ulTradePartnerSteamID = '${PARTNER}';
        var g_rgCurrentTradeStatus = ${JSON.stringify(status)}; BeginTradeOffer('500', false);</script>`;
    const inventory = classId => ({ success: 1, more_items: false, assets: [
        { appid: 570, contextid: '2', assetid: '100', classid: classId, instanceid: '0' }
    ], descriptions: [{ appid: 570, classid: classId, instanceid: '0', market_hash_name: gemName }] });
    const ownInventoryUrl = `https://steamcommunity.com/inventory/${OWNER}/570/2/?l=english&count=2000`;
    const partnerInventoryUrl = `https://steamcommunity.com/inventory/${PARTNER}/570/2/?l=english&count=2000`;
    const page = await openList(t, { snapshot, prices: {
        [OWNER]: [{ assetid: '100', marketHashName: gemName, priceCents: 250 }],
        [PARTNER]: [{ assetid: '100', marketHashName: gemName, priceCents: 900 }]
    }, fetchPlans: {
        'https://steamcommunity.com/tradeoffer/500/': [{ text: details }],
        [ownInventoryUrl]: [{ status: 403, data: { success: false } }, { hold: true }],
        [partnerInventoryUrl]: [{ data: inventory('2000') }]
    } });
    try {
        await page.waitForFunction(() => document.querySelector('.sih-lite-trade-summary [data-role="status"]')?.textContent.includes('could not verify some item cards'));
    } catch (error) {
        const diagnostics = await page.evaluate(() => ({
            summary: document.querySelector('.sih-lite-trade-summary')?.textContent,
            requests: window.__fetchRequests.map(({ url, method }) => ({ url, method })),
            pendingRequests: window.__pendingFetches.map(({ url }) => url)
        }));
        error.message += '\nFixture diagnostics: ' + JSON.stringify(diagnostics);
        throw error;
    }
    assert.equal(await listBadge(page, 'give').count(), 0);
    await waitText(listBadge(page, 'receive'), '$9.00');
    assert.match(await offerSummary(page).locator('[data-role="give"]').textContent(), /\$5\.00/);
    assert.match(await offerSummary(page).locator('[data-role="receive"]').textContent(), /\$9\.00/);
    assert.equal(await offerSummary(page).locator('[data-role="net"]').textContent(), 'Net gain: +$4.00');
    const retry = offerSummary(page).locator('.sih-lite-trade-retry');
    assert.equal(await retry.isVisible(), true);
    await retry.click();
    await page.waitForFunction(() => window.__pendingFetches.length === 1);
    assert.equal(await offerSummary(page).locator('[data-role="net"]').textContent(), 'Net gain: +$4.00',
        'reloading class descriptions must retain the proven native asset totals');
    assert.equal(await listBadge(page, 'give').count(), 0);
    await page.evaluate(data => window.__pendingFetches.shift().resolve({ data }), inventory('1000'));
    await waitText(listBadge(page, 'give'), '$5.00');
    await waitText(listBadge(page, 'receive'), '$9.00');
    await page.waitForFunction(() => document.querySelector('.sih-lite-trade-retry')?.hidden === true);
    assert.doesNotMatch(await offerSummary(page).locator('[data-role="status"]').textContent(), /could not verify some item cards/);
    const calls = await page.evaluate(() => window.__fetchRequests);
    assert.equal(calls.filter(call => call.url === 'https://steamcommunity.com/tradeoffer/500/').length, 2);
    assert.equal(calls.filter(call => call.url === ownInventoryUrl).length, 2);
    assert.equal(calls.filter(call => call.url === partnerInventoryUrl).length, 1, 'successful partner classes are cached');
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.equal(await page.evaluate(() => window.__chromeRequests.filter(request => request.action === 'fetchPrices').length), 2,
        'retrying native class descriptions must reuse both owners’ valid Steamprice prices');
});

test('Fast accept sends one authenticated request only after a trusted user click', async t => {
    const page = await openList(t, { fetchPlans: {
        'https://steamcommunity.com/tradeoffer/500/accept': [{ data: { tradeid: '987654321' } }]
    } });
    await fastAccept(page).waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window.__fetchRequests), []);
    await fastAccept(page).evaluate(button => button.click());
    await frames(page);
    assert.deepEqual(await page.evaluate(() => window.__fetchRequests), [], 'scripted clicks must not accept trades');
    await fastAccept(page).click();
    await waitText(acceptStatus(page), 'Trade accepted.');
    assert.equal(await fastAccept(page).isDisabled(), true);
    assert.equal(await fastAccept(page).textContent(), 'Accepted');
    const calls = await page.evaluate(() => window.__fetchRequests);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://steamcommunity.com/tradeoffer/500/accept');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), {
        sessionid: 'fixture_session_123', serverid: '1', tradeofferid: '500', partner: PARTNER, captcha: ''
    });
    assert.equal(page.url(), `https://steamcommunity.com/profiles/${OWNER}/tradeoffers/`);
});

for (const [name, data, message] of [
    ['Steam Guard', { needs_mobile_confirmation: true }, 'Confirm this trade in Steam Guard.'],
    ['email', { needs_email_confirmation: true }, 'Confirm this trade using the email sent by Steam.']
]) {
    test(`Fast accept preserves the ${name} confirmation requirement`, async t => {
        const page = await openList(t, { fetchPlans: { 'https://steamcommunity.com/tradeoffer/500/accept': [{ data }] } });
        await fastAccept(page).click();
        await waitText(acceptStatus(page), message);
        assert.equal(await fastAccept(page).isDisabled(), true);
        assert.doesNotMatch(await acceptStatus(page).textContent(), /Trade accepted/);
        assert.equal(await page.evaluate(() => window.__fetchRequests.length), 1);
    });
}

test('Fast accept displays Steam failures and retries only after another user click', async t => {
    const page = await openList(t, { fetchPlans: {
        'https://steamcommunity.com/tradeoffer/500/accept': [
            { status: 500, data: { strError: 'Steam could not accept this offer.' } },
            { data: { tradeid: '987654321' } }
        ]
    } });
    await fastAccept(page).click();
    await waitText(acceptStatus(page), 'Steam could not accept this offer.');
    assert.equal(await fastAccept(page).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__fetchRequests.length), 1);
    await frames(page);
    assert.equal(await page.evaluate(() => window.__fetchRequests.length), 1, 'failure must not trigger automatic acceptance retries');
    await fastAccept(page).click();
    await waitText(acceptStatus(page), 'Trade accepted.');
    assert.equal(await page.evaluate(() => window.__fetchRequests.length), 2);
});

test('an unknown Fast accept outcome requires a reload and never offers an automatic or repeated POST', async t => {
    const page = await openList(t, { fetchPlans: {
        'https://steamcommunity.com/tradeoffer/500/accept': [{ reject: 'Connection dropped after the request was sent.' }]
    } });
    await fastAccept(page).click();
    await waitText(acceptStatus(page), 'Could not contact Steam. Reload your offers to check their status.');
    assert.equal(await fastAccept(page).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__fetchRequests.length), 1);
    // Redrawing this offer preserves its uncertain outcome until a page reload.
    await page.evaluate(() => {
        document.querySelector('#tradeofferid_500').appendChild(document.createElement('span'));
    });
    await frames(page);
    assert.equal(await fastAccept(page).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__fetchRequests.length), 1);
});

test('Fast accept disables pending offers and does not send duplicate acceptance requests', async t => {
    const page = await openList(t, { fetchPlans: { 'https://steamcommunity.com/tradeoffer/500/accept': [{ hold: true }] } });
    await fastAccept(page).click();
    await page.waitForFunction(() => window.__pendingFetches.length === 1);
    await waitText(acceptStatus(page), 'Accepting this offer…');
    assert.equal(await fastAccept(page).isDisabled(), true);
    await fastAccept(page).evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await frames(page);
    assert.equal(await page.evaluate(() => window.__fetchRequests.length), 1);
    await page.evaluate(() => window.__pendingFetches.shift().resolve({ data: { tradeid: '987654321' } }));
    await waitText(acceptStatus(page), 'Trade accepted.');
});

test('Fast accept stops when the offer becomes inactive before the click is handled', async t => {
    const page = await openList(t);
    await fastAccept(page).evaluate(button => button.addEventListener('pointerdown', () => {
        const container = button.closest('.tradeoffer').querySelector('.tradeoffer_items_ctn');
        container.classList.remove('active'); container.classList.add('inactive');
    }, { once: true }));
    await fastAccept(page).click();
    await frames(page);
    assert.deepEqual(await page.evaluate(() => window.__fetchRequests), []);
    assert.equal(await fastAccept(page).count(), 0);
});

test('Fast accept reports a missing Steam session without sending a request', async t => {
    const page = await openList(t, { sessionId: '' });
    await fastAccept(page).click();
    await waitText(acceptStatus(page), 'The Steam session is unavailable. Reload this page and sign in.');
    assert.equal(await fastAccept(page).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__fetchRequests), []);
});
