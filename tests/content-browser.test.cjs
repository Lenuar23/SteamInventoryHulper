const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const OWNER = '76561198012345678';
const OTHER_OWNER = '76561198087654321';
const DEFAULT_ITEMS = [
    { assetid: '100', marketHashName: 'Same Name', priceCents: '250' },
    { assetid: '101', marketHashName: 'Same Name', priceCents: '999' }
];
const INVENTORY = [
    { assetId: '100', name: 'Same Name' },
    { assetId: '101', name: 'Same Name' },
    { assetId: '102', name: 'No Price' },
    { assetId: '103', name: "Collector's Cache 2020", isCache: true }
];
const HTML = `<!doctype html><html><head><title>Steam inventory fixture</title>
<style>.item {position:relative;width:96px;height:96px;display:inline-block} #inventories {min-height:150px}</style>
</head><body><div class="inventory_header">Inventory</div><div id="inventories">
<div class="itemHolder"><div class="item" id="item570_2_100"><img alt="Same Name"></div></div>
<div class="itemHolder"><div class="item" id="item570_2_101"><img alt="Same Name"></div></div>
<div class="itemHolder"><div class="item" id="item570_2_102"><img alt="No Price"></div></div>
<div class="itemHolder"><div class="item" id="item570_2_103"><img alt="Collector's Cache 2020"></div></div>
<div class="itemHolder"><div class="item" id="item730_2_100"><img alt="Same Name"></div></div>
</div></body></html>`;
let browser;

before(async () => {
    browser = await chromium.launch({
        executablePath: process.env.SIH_CHROMIUM_PATH || '/usr/lib/chromium/chromium',
        headless: true,
        args: ['--no-sandbox']
    });
});
after(async () => { if (browser) await browser.close(); });

async function openFixture(t, options = {}) {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    t.after(() => assert.deepEqual(pageErrors, [], 'content script raised a browser error'));
    await page.route('https://steamcommunity.com/**', route => route.fulfill({
        status: 200, contentType: 'text/html', body: HTML
    }));
    await context.route('https://steamprice.com/**', route => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!doctype html><title>Color viewer fixture</title>'
    }));
    await page.goto(`https://steamcommunity.com/profiles/${OWNER}/inventory/`);
    await page.evaluate(config => {
        window.__chromeRequests = [];
        window.__pendingResponses = [];
        window.__sortRequests = [];
        window.__filterRequests = [];
        window.__stateRequests = 0;
        window.__nativeState = { steamId: config.owner, appId: config.appId, contextId: '2',
            order: 'original', gemFilter: 'all', items: config.inventory };
        window.__nativeItemSelections = 0;
        window.__sortReply = config.sortReply || { success: true, count: 4 };
        window.__filterReply = config.filterReply || { success: true, count: 2 };
        for (const item of config.inventory) {
            let slot = document.getElementById(`item570_2_${item.assetId}`);
            if (!slot) {
                const holder = document.createElement('div'); holder.className = 'itemHolder';
                slot = document.createElement('div'); slot.className = 'item'; slot.id = `item570_2_${item.assetId}`;
                slot.appendChild(document.createElement('img')); holder.appendChild(slot);
                document.getElementById('inventories').appendChild(holder);
            }
            slot.querySelector('img').alt = item.name || '';
        }
        for (const slot of document.querySelectorAll('.item')) {
            slot.addEventListener('click', () => window.__nativeItemSelections++);
        }
        const callCounts = new Map();
        const defaultResponses = {
            fetchPrices: { success: true, data: { items: config.items } },
            fetchProfile: { success: true, data: { totalValueCents: config.totalValueCents } }
        };
        window.chrome = { runtime: {
            lastError: undefined,
            sendMessage(request, callback) {
                window.__chromeRequests.push(request);
                const key = `${request.steamId}:${request.action}`;
                const plans = config.plans?.[key] || config.plans?.[request.action];
                const index = callCounts.get(key) || 0;
                callCounts.set(key, index + 1);
                const response = plans ? plans[Math.min(index, plans.length - 1)] : defaultResponses[request.action];
                if (response?.hold) window.__pendingResponses.push({ request, callback });
                else setTimeout(() => callback(response), 0);
            }
        } };
        window.addEventListener('message', event => {
            const message = event.data;
            if (event.source !== window || message?.source !== 'SIH_LITE_CONTENT') return;
            if (message.type === 'STATE_REQUEST') {
                window.__stateRequests++;
                const current = window.__nativeState;
                window.postMessage({ source: 'SIH_LITE_PAGE', type: 'STATE', steamId: current.steamId,
                    appId: current.appId, contextId: current.contextId, order: current.order,
                    gemFilter: current.gemFilter }, location.origin);
                window.postMessage({ source: 'SIH_LITE_PAGE', type: 'INVENTORY', steamId: current.steamId,
                    appId: current.appId, contextId: current.contextId, items: current.items }, location.origin);
            } else if (message.type === 'SORT') {
                window.__sortRequests.push(message);
                if (!window.__sortReply.hold) {
                    setTimeout(() => {
                        if (window.__sortReply.success) window.__nativeState.order = message.order;
                        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'SORT_RESULT',
                            requestId: message.requestId, ...window.__sortReply }, location.origin);
                    }, 0);
                }
            } else if (message.type === 'FILTER_GEMS') {
                window.__filterRequests.push(message);
                if (!window.__filterReply.hold) {
                    setTimeout(() => {
                        if (window.__filterReply.success) window.__nativeState.gemFilter = message.mode;
                        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'FILTER_RESULT',
                            requestId: message.requestId, ...window.__filterReply }, location.origin);
                    }, 0);
                }
            }
        });
    }, {
        owner: options.owner || OWNER,
        appId: options.appId || '570',
        items: options.items || DEFAULT_ITEMS,
        inventory: options.inventory || INVENTORY,
        totalValueCents: options.totalValueCents ?? '12345',
        plans: options.plans,
        sortReply: options.sortReply,
        filterReply: options.filterReply
    });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'gems.js') });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'content.js') });
    await page.locator('#sih-lite-ui-container').waitFor({ state: 'attached' });
    return page;
}

const badge = (page, assetId = '100') => page.locator(`#item570_2_${assetId} .sih-lite-badge`);
const sortButton = (page, order) => page.locator(`.sih-lite-sort-btn[data-order="${order}"]`);

async function waitText(locator, expected) {
    await locator.filter({ hasText: expected }).waitFor({ state: 'visible' });
    assert.equal(await locator.textContent(), expected);
}

async function state(page, owner, appId = '570', inventory = INVENTORY, extra = {}) {
    await page.evaluate(({ id, app, items, stateFields }) => {
        const sameOwner = window.__nativeState.steamId === id;
        window.__nativeState = { ...window.__nativeState, steamId: id, appId: app, contextId: '2', items,
            ...(sameOwner ? {} : { order: 'original', gemFilter: 'all' }), ...stateFields };
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'STATE', steamId: id, appId: app, contextId: '2', ...stateFields }, location.origin);
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'INVENTORY', steamId: id, appId: app, contextId: '2', items }, location.origin);
    }, { id: owner, app: appId, items: inventory, stateFields: extra });
}

async function settleRender(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('numeric-string total is cents and exact asset prices take precedence over shared names', async t => {
    const page = await openFixture(t);
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $123.45');
    await waitText(badge(page, '100'), '$2.50');
    await waitText(badge(page, '101'), '$9.99');
    assert.equal(await badge(page, '102').count(), 0);
    await waitText(badge(page, '103'), 'Cache');
    assert.equal(await page.locator('#item730_2_100 .sih-lite-badge').count(), 0);
    assert.equal(await sortButton(page, 'desc').isEnabled(), true);
});

test('zero total and zero item prices display as $0.00', async t => {
    const page = await openFixture(t, {
        totalValueCents: '0',
        items: [{ assetid: '100', marketHashName: 'Free Item', priceCents: '0' }]
    });
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $0.00');
    await waitText(badge(page), '$0.00');
    assert.equal(await sortButton(page, 'desc').isEnabled(), true);
});

test('malformed generic record IDs, empty cleaned names and invalid prices do not poison sort messages', async t => {
    const page = await openFixture(t, { items: [
        ...DEFAULT_ITEMS,
        { id: 'price-row-uuid', name: 'Unusual ', priceCents: 1 },
        { assetid: '102', name: 'No Price', priceCents: true },
        { assetid: '103', name: "Collector's Cache 2020", priceCents: ' ' }
    ] });
    await waitText(badge(page), '$2.50');
    assert.equal(await badge(page, '102').count(), 0);
    await waitText(badge(page, '103'), 'Cache');
    await sortButton(page, 'desc').click();
    await page.waitForFunction(() => window.__sortRequests.length === 1);
    const prices = await page.evaluate(() => window.__sortRequests[0].prices);
    assert.deepEqual(prices.assetPrices, [['100', 250], ['101', 999]]);
    assert.ok(prices.namePrices.every(([name]) => name.length > 0));
    assert.ok(prices.namePrices.every(([name]) => name !== 'no price' && name !== "collector's cache 2020"));
});

test('all sort buttons work when profile total fails and send complete known price maps', async t => {
    const page = await openFixture(t, {
        plans: { fetchProfile: [{ success: false, error: 'Profile total unavailable' }] }
    });
    await waitText(page.locator('#sih-lite-total-text'), 'Inventory value unavailable');
    await waitText(badge(page), '$2.50');
    for (const order of ['desc', 'asc', 'original']) {
        await sortButton(page, order).click();
        await page.waitForFunction(orderValue => document.querySelector(`[data-order="${orderValue}"]`)?.getAttribute('aria-pressed') === 'true', order);
        assert.equal(await sortButton(page, order).isEnabled(), true);
    }
    const requests = await page.evaluate(() => window.__sortRequests);
    assert.deepEqual(requests.map(request => request.order), ['desc', 'asc', 'original']);
    assert.ok(requests.every(request => request.steamId === OWNER));
    assert.deepEqual(requests[0].prices.assetPrices, [['100', 250], ['101', 999]]);
    assert.ok(requests[0].prices.namePrices.some(([name, price]) => name === 'same name' && price === 999));
    assert.equal(await page.locator('#sih-lite-status').textContent(), 'Profile total unavailable Steam order restored.');
});

test('retry recovers price and profile failures and enables price sorting', async t => {
    const page = await openFixture(t, {
        plans: {
            fetchPrices: [
                { success: false, error: 'Price service unavailable' },
                { success: true, data: { items: DEFAULT_ITEMS } }
            ],
            fetchProfile: [
                { success: false, error: 'Total service unavailable' },
                { success: true, data: { totalValueCents: '9876' } }
            ]
        }
    });
    await page.waitForFunction(() => document.querySelector('#sih-lite-status')?.textContent.includes('Price service unavailable') &&
        document.querySelector('#sih-lite-status')?.textContent.includes('Total service unavailable'));
    assert.equal(await sortButton(page, 'desc').isEnabled(), false);
    await page.locator('#sih-lite-retry').click();
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $98.76');
    await waitText(badge(page), '$2.50');
    assert.equal(await sortButton(page, 'desc').isEnabled(), true);
    assert.equal(await page.locator('#sih-lite-retry').isVisible(), false);
    assert.equal(await page.locator('#sih-lite-status').textContent(), '');
    const calls = await page.evaluate(() => window.__chromeRequests);
    assert.equal(calls.filter(request => request.action === 'fetchPrices').length, 2);
    assert.ok(calls.filter(request => request.action === 'fetchProfile').length >= 2);
});

test('failed inventory sorting displays the failure and permits another attempt', async t => {
    const page = await openFixture(t, { sortReply: { success: false, error: 'Inventory loading failed' } });
    await waitText(badge(page), '$2.50');
    await sortButton(page, 'desc').click();
    await waitText(page.locator('#sih-lite-status'), 'Inventory loading failed');
    assert.equal(await sortButton(page, 'desc').isEnabled(), true);
    assert.equal(await sortButton(page, 'desc').getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => { window.__sortReply = { success: true, count: 4 }; });
    await sortButton(page, 'desc').click();
    await waitText(page.locator('#sih-lite-status'), 'Sorted 4 items. Unpriced items are shown last.');
    assert.equal(await sortButton(page, 'desc').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.__sortRequests.length), 2);
});

test('late price and total responses from a previous owner cannot replace the current inventory', async t => {
    const page = await openFixture(t, {
        items: [{ assetid: '100', marketHashName: 'Current Owner Item', priceCents: '300' }],
        totalValueCents: '2200',
        plans: {
            [`${OWNER}:fetchPrices`]: [{ hold: true }],
            [`${OWNER}:fetchProfile`]: [{ hold: true }]
        }
    });
    await page.waitForFunction(() => window.__pendingResponses.length === 2);
    await state(page, OTHER_OWNER);
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $22.00');
    await waitText(badge(page), '$3.00');
    await page.evaluate(oldOwner => {
        const pending = window.__pendingResponses.splice(0);
        for (const { request, callback } of pending) {
            if (request.steamId !== oldOwner) throw new Error('wrong pending owner');
            callback({ success: true, data: request.action === 'fetchPrices'
                ? { items: [{ assetid: '100', priceCents: 99900 }] }
                : { totalValueCents: 99900 } });
        }
    }, OWNER);
    await settleRender(page);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $22.00');
    assert.equal(await badge(page).textContent(), '$3.00');
    await sortButton(page, 'asc').click();
    await page.waitForFunction(() => window.__sortRequests.length === 1);
    assert.equal(await page.evaluate(() => window.__sortRequests[0].steamId), OTHER_OWNER);
});

test('a non-Dota inventory does not show the panel or badges and does not fetch Dota prices', async t => {
    const page = await openFixture(t, { appId: '730' });
    await settleRender(page);
    assert.equal(await page.locator('#sih-lite-ui-container').isVisible(), false);
    assert.equal(await page.locator('.sih-lite-badge').count(), 0);
    assert.equal(await page.evaluate(() => window.__chromeRequests.length), 0);
});

test('switching away from Dota hides the panel and removes badges, and switching back restores them', async t => {
    const page = await openFixture(t);
    await waitText(badge(page), '$2.50');
    assert.equal(await page.locator('#sih-lite-ui-container').isVisible(), true);
    await state(page, OWNER, '730');
    await page.waitForFunction(() => document.querySelector('#sih-lite-ui-container')?.hidden &&
        document.querySelectorAll('.sih-lite-badge').length === 0);
    assert.equal(await page.locator('#sih-lite-ui-container').isVisible(), false);
    assert.equal(await page.locator('#item730_2_100 .sih-lite-badge').count(), 0);
    await state(page, OWNER, '570');
    await waitText(badge(page), '$2.50');
    assert.equal(await page.locator('#sih-lite-ui-container').isVisible(), true);
    assert.equal(await page.locator('#item730_2_100 .sih-lite-badge').count(), 0);
});

const colorLink = (page, assetId = '100') => page.locator(`#item570_2_${assetId} .sih-lite-color-link`);
const gemButton = page => page.locator('#sih-lite-gem-filter');
const LEGACY_PBR = {
    assetid: '100', marketHashName: 'Platinum Baby Roshan', itemType: 'Courier',
    prismaticGems: ['Legacy (230, 155, 253)'],
    etherealGems: ['Ethereal Flame', 'Orbital Decay', 'Trail of the Amanita'],
    legacyRgb: { r: 230, g: 155, b: 253, sum: 638 }, isLegacy: true
};
const NATIVE_TB = {
    assetId: '100', name: 'Exalted Fractal Horns of Inner Abysm', hasGems: true, hasColoredGem: true,
    isLegacy: false, legacyRgb: null,
    gems: [
        { name: 'Bright Green', type: 'Prismatic Gem', color: { r: 161, g: 255, b: 89 } },
        { name: 'Diretide Corruption', type: 'Ethereal Gem', color: null }
    ],
    prismaticGems: [{ name: 'Bright Green', type: 'Prismatic Gem', color: { r: 161, g: 255, b: 89 } }],
    etherealGems: [{ name: 'Diretide Corruption', type: 'Ethereal Gem', color: null }]
};

async function filterReply(page, response) {
    await page.evaluate(result => {
        const request = window.__filterRequests.at(-1);
        if (result.success) window.__nativeState.gemFilter = request.mode;
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'FILTER_RESULT', requestId: request.requestId, ...result }, location.origin);
    }, response);
}

test('asset-specific legacy gem metadata creates an exact RGB viewer link without an item price', async t => {
    const page = await openFixture(t, {
        inventory: [
            { assetId: '100', name: 'Platinum Baby Roshan' },
            { assetId: '101', name: 'Platinum Baby Roshan' }
        ],
        items: [LEGACY_PBR, { ...LEGACY_PBR, assetid: '999' }]
    });
    const link = colorLink(page);
    await link.waitFor({ state: 'visible' });
    const url = new URL(await link.getAttribute('href'));
    assert.equal(url.origin + url.pathname, 'https://steamprice.com/dota2/legacy');
    assert.equal(url.searchParams.get('lv'), '1');
    assert.equal(url.searchParams.get('model'), 'PBR');
    assert.deepEqual(['r', 'g', 'b'].map(key => url.searchParams.get(key)), ['230', '155', '253']);
    assert.equal(url.searchParams.get('kind'), null);
    assert.equal(url.searchParams.get('effect'), null, 'unsupported effects must not appear as a selected preview effect');
    assert.equal(await link.textContent(), 'View color');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.deepEqual((await link.getAttribute('rel')).split(' ').sort(), ['noopener', 'noreferrer']);
    assert.equal(await badge(page).count(), 0, 'gem metadata does not require a price');
    assert.equal(await colorLink(page, '101').count(), 0, 'same-name items must not inherit another asset color');
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), url.href);
    assert.equal(await page.evaluate(() => window.__nativeItemSelections), 0, 'the color link must not select the native inventory item');
});

test('a regular TB color from native metadata works even when Steamprice prices and totals fail', async t => {
    const page = await openFixture(t, {
        inventory: [NATIVE_TB],
        plans: {
            fetchPrices: [{ success: false, error: 'Prices offline' }],
            fetchProfile: [{ success: false, error: 'Total offline' }]
        }
    });
    const link = colorLink(page);
    await link.waitFor({ state: 'visible' });
    const url = new URL(await link.getAttribute('href'));
    assert.equal(url.searchParams.get('model'), 'TB');
    assert.equal(url.searchParams.get('kind'), 'regular');
    assert.deepEqual(['r', 'g', 'b'].map(key => url.searchParams.get(key)), ['161', '255', '89']);
    assert.equal(await gemButton(page).isEnabled(), true);
    assert.equal(await sortButton(page, 'desc').isEnabled(), false);
    await gemButton(page).click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter')?.getAttribute('aria-pressed') === 'true');
    const message = await page.evaluate(() => window.__filterRequests[0]);
    assert.equal(message.mode, 'colored');
    assert.equal(message.steamId, OWNER);
    assert.deepEqual(message.coloredAssetIds, [], 'native gem matching is handled by the main-world inventory');
    assert.match(await page.locator('#sih-lite-status').textContent(), /2 items have colored gems/);
});

test('viewer buttons exclude loose gems, empty sockets, unsupported models, invalid RGB and other assets', async t => {
    const names = [
        'Platinum Baby Roshan', 'Prismatic: Legacy (1, 2, 3)', 'Baby Roshan',
        'Fractal Horns of Inner Abysm', 'Fractal Horns of Inner Abysm',
        'Platinum Baby Roshan', 'Fractal Horns of Inner Abysm', 'Fractal Horns of Inner Abysm'
    ];
    const inventory = names.map((name, index) => ({ assetId: String(100 + index), name }));
    const page = await openFixture(t, {
        inventory,
        items: [
            { assetid: '100', marketHashName: names[0], emptySockets: 2, prismaticGems: [], etherealGems: [] },
            { assetid: '101', marketHashName: names[1], itemType: 'Gem / Rune', prismaticGems: ['Legacy (1, 2, 3)'], legacyRgb: { r: 1, g: 2, b: 3 }, isLegacy: true },
            { assetid: '102', marketHashName: names[2], prismaticGems: ['Legacy (1, 2, 3)'], isLegacy: true },
            { assetid: '103', marketHashName: names[3], prismaticGems: ['Legacy (999, 2, 3)'], legacyRgb: { r: 999, g: 2, b: 3 }, isLegacy: true },
            { assetid: '999', marketHashName: names[4], prismaticGems: ['Legacy (1, 2, 3)'], isLegacy: true },
            { assetid: '105', marketHashName: names[5], etherealGems: ['Ionic Vapor'] },
            { assetid: '106', marketHashName: names[6], prismaticGems: ['Empty Socket'], legacyRgb: { r: 1, g: 2, b: 3 }, isLegacy: true },
            { assetid: '107', marketHashName: names[7], prismaticGems: ['Broken color'], legacyRgb: { r: true, g: '2', b: 3 }, isLegacy: true }
        ]
    });
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $123.45');
    await page.waitForFunction(() => !document.querySelector('[data-order="desc"]').disabled);
    await settleRender(page);
    assert.equal(await page.locator('.sih-lite-color-link').count(), 0);
    assert.equal(await page.locator('#item730_2_100 .sih-lite-color-link').count(), 0);
});

test('colored filter retries loading failures, keeps the grand total and ignores noncolored API gems', async t => {
    const page = await openFixture(t, {
        inventory: [
            { assetId: '100', name: 'Platinum Baby Roshan' },
            { assetId: '101', name: 'Prismatic: Blue' },
            { assetId: '102', name: 'Blade with kinetic gem' },
            { assetId: '103', name: 'Empty courier' }
        ],
        items: [
            { ...LEGACY_PBR, priceCents: 500 },
            { assetid: '101', marketHashName: 'Prismatic: Blue', itemType: 'Gem / Rune', prismaticGems: ['Blue'] },
            { assetid: '102', marketHashName: 'Blade with kinetic gem', kineticGems: ['Wraith Spin'] },
            { assetid: '103', marketHashName: 'Empty courier', emptySockets: 3, prismaticGems: [], etherealGems: [] }
        ],
        filterReply: { hold: true }
    });
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $123.45');
    await colorLink(page).waitFor({ state: 'visible' });
    await gemButton(page).click();
    await page.waitForFunction(() => window.__filterRequests.length === 1 && document.querySelector('#sih-lite-gem-filter').disabled);
    for (const order of ['desc', 'asc', 'original']) assert.equal(await sortButton(page, order).isEnabled(), false);
    const request = await page.evaluate(() => window.__filterRequests[0]);
    assert.deepEqual(request.coloredAssetIds, ['100']);
    assert.deepEqual(request.gemAssetIds, ['100', '102']);
    await filterReply(page, { success: false, error: 'Loading remaining pages failed' });
    await waitText(page.locator('#sih-lite-status'), 'Loading remaining pages failed');
    assert.equal(await gemButton(page).isEnabled(), true);
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'false');
    assert.equal(await sortButton(page, 'desc').isEnabled(), true);
    await page.evaluate(() => { window.__filterReply = { success: true, count: 1 }; });
    await gemButton(page).click();
    await waitText(page.locator('#sih-lite-status'), '1 items have colored gems. Steam text and tag filters still apply.');
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $123.45');
    await page.evaluate(() => { window.__filterReply = { success: false, error: 'Could not restore all items' }; });
    await gemButton(page).click();
    await waitText(page.locator('#sih-lite-status'), 'Could not restore all items');
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'true', 'failed disable retains the current filter');
    await page.evaluate(() => { window.__filterReply = { success: true, count: 4 }; });
    await gemButton(page).click();
    await waitText(page.locator('#sih-lite-status'), 'Showing all items. Steam text and tag filters still apply.');
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await page.evaluate(() => window.__filterRequests.map(message => message.mode)), ['colored', 'colored', 'all', 'all']);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $123.45');
});

test('price sorting and colored filtering coexist and disable each other only while working', async t => {
    const page = await openFixture(t, {
        inventory: [{ assetId: '100', name: 'Platinum Baby Roshan' }],
        items: [{ ...LEGACY_PBR, priceCents: 500 }],
        sortReply: { hold: true }, filterReply: { success: true, count: 1 }
    });
    await colorLink(page).waitFor({ state: 'visible' });
    await gemButton(page).click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter')?.getAttribute('aria-pressed') === 'true');
    await sortButton(page, 'asc').click();
    await page.waitForFunction(() => window.__sortRequests.length === 1 && document.querySelector('#sih-lite-gem-filter').disabled);
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'SORT_RESULT',
            requestId: window.__sortRequests[0].requestId, success: true, count: 4 }, location.origin);
    });
    await waitText(page.locator('#sih-lite-status'), 'Sorted 4 items. Unpriced items are shown last.');
    assert.equal(await gemButton(page).isEnabled(), true);
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'true');
    assert.equal(await sortButton(page, 'asc').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.__filterRequests.length), 1, 'sorting must not toggle the filter off');
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $123.45');
});

test('owner changes and late old-owner gem responses remove stale viewer links', async t => {
    const page = await openFixture(t, {
        inventory: [NATIVE_TB], items: [],
        plans: { [`${OWNER}:fetchPrices`]: [{ hold: true }] }
    });
    await colorLink(page).waitFor({ state: 'visible' });
    await state(page, OTHER_OWNER, '570', [{ assetId: '100', name: 'Item without a gem' }]);
    await page.waitForFunction(() => document.querySelectorAll('.sih-lite-color-link').length === 0 &&
        window.__chromeRequests.some(request => request.steamId !== '76561198012345678' && request.action === 'fetchPrices'));
    await page.evaluate(({ oldOwner, oldInventory, oldApiItem }) => {
        for (const { request, callback } of window.__pendingResponses.splice(0)) {
            callback({ success: true, data: { items: [oldApiItem] } });
        }
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'INVENTORY', steamId: oldOwner,
            appId: '570', contextId: '2', items: oldInventory }, location.origin);
    }, { oldOwner: OWNER, oldInventory: [NATIVE_TB], oldApiItem: LEGACY_PBR });
    await settleRender(page);
    assert.equal(await page.locator('.sih-lite-color-link').count(), 0);
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'false');
});

test('switching inventory app or losing owner state hides stale gem links and controls', async t => {
    const page = await openFixture(t, { inventory: [NATIVE_TB] });
    await colorLink(page).waitFor({ state: 'visible' });
    await state(page, OWNER, '730', [NATIVE_TB]);
    await page.waitForFunction(() => document.querySelector('#sih-lite-ui-container').hidden &&
        document.querySelectorAll('.sih-lite-color-link').length === 0);
    assert.equal(await gemButton(page).isVisible(), false);
    await state(page, OWNER, '570', [NATIVE_TB]);
    await colorLink(page).waitFor({ state: 'visible' });
    await state(page, null, '570', [NATIVE_TB]);
    await page.waitForFunction(() => document.querySelector('#sih-lite-ui-container').hidden &&
        document.querySelectorAll('.sih-lite-color-link').length === 0);
    assert.equal(await gemButton(page).isVisible(), false);
});

test('gem metadata arriving during filtering reapplies the active filter with newly matched assets', async t => {
    const page = await openFixture(t, {
        inventory: [NATIVE_TB, { assetId: '101', name: 'Platinum Baby Roshan' }],
        plans: { fetchPrices: [{ hold: true }] },
        filterReply: { hold: true }
    });
    await colorLink(page).waitFor({ state: 'visible' });
    await gemButton(page).click();
    await page.waitForFunction(() => window.__filterRequests.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__filterRequests[0].coloredAssetIds), []);
    await page.evaluate(apiItem => {
        const pending = window.__pendingResponses.find(entry => entry.request.action === 'fetchPrices');
        pending.callback({ success: true, data: { items: [apiItem] } });
    }, { ...LEGACY_PBR, assetid: '101' });
    await colorLink(page, '101').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__filterRequests.length), 1, 'metadata loading must not overlap the running native filter');
    await filterReply(page, { success: true, count: 1 });
    await page.waitForFunction(() => window.__filterRequests.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__filterRequests[1].coloredAssetIds), ['101']);
    assert.equal(await gemButton(page).isEnabled(), false);
    await filterReply(page, { success: true, count: 2 });
    await waitText(page.locator('#sih-lite-status'), '2 items have colored gems. Steam text and tag filters still apply.');
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'true');
    assert.equal(await gemButton(page).isEnabled(), true);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $123.45');
});

test('native regular PBR color and effect take precedence over stale API legacy metadata', async t => {
    const nativeEffect = { name: 'Trail of Burning Doom', type: 'Ethereal Gem', color: null };
    const page = await openFixture(t, {
        inventory: [{
            ...NATIVE_TB,
            name: 'Platinum Baby Roshan',
            etherealGems: [nativeEffect],
            gems: [...NATIVE_TB.prismaticGems, nativeEffect]
        }],
        items: [{ ...LEGACY_PBR, etherealGems: ['Ionic Vapor'] }]
    });
    await page.waitForFunction(() => !document.querySelector('[data-order="desc"]').disabled);
    await settleRender(page);
    const url = new URL(await colorLink(page).getAttribute('href'));
    assert.equal(url.searchParams.get('model'), 'PBR');
    assert.deepEqual(['r', 'g', 'b'].map(key => url.searchParams.get(key)), ['161', '255', '89']);
    assert.equal(url.searchParams.get('kind'), 'regular');
    assert.equal(url.searchParams.get('effect'), 'TOBD');
});

test('a same-owner native refresh updates pressed order and gem controls during a failed operation', async t => {
    const page = await openFixture(t, { inventory: [NATIVE_TB] });
    await waitText(badge(page), '$2.50');
    await gemButton(page).click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter').getAttribute('aria-pressed') === 'true');
    await sortButton(page, 'asc').click();
    await page.waitForFunction(() => document.querySelector('[data-order="asc"]').getAttribute('aria-pressed') === 'true');
    await page.evaluate(() => { window.__sortReply = { hold: true }; });
    await sortButton(page, 'desc').click();
    await page.waitForFunction(() => window.__sortRequests.length === 2 && document.querySelector('#sih-lite-gem-filter').disabled);
    await state(page, OWNER, '570', [NATIVE_TB], { order: 'original', gemFilter: 'all' });
    await page.waitForFunction(() => document.querySelector('[data-order="original"]').getAttribute('aria-pressed') === 'true' &&
        document.querySelector('#sih-lite-gem-filter').getAttribute('aria-pressed') === 'false');
    assert.equal(await sortButton(page, 'asc').getAttribute('aria-pressed'), 'false');
    assert.equal(await gemButton(page).isEnabled(), false);
    assert.match(await page.locator('#sih-lite-status').textContent(), /Loading all inventory items/);
    await page.evaluate(() => window.postMessage({ source: 'SIH_LITE_PAGE', type: 'SORT_RESULT',
        requestId: window.__sortRequests.at(-1).requestId, success: false, error: 'Refresh interrupted the sort' }, location.origin));
    await waitText(page.locator('#sih-lite-status'), 'Refresh interrupted the sort');
    await page.waitForFunction(() => window.__stateRequests === 2);
    await settleRender(page);
    assert.equal(await sortButton(page, 'original').getAttribute('aria-pressed'), 'true');
    assert.equal(await sortButton(page, 'asc').getAttribute('aria-pressed'), 'false');
    assert.equal(await sortButton(page, 'desc').getAttribute('aria-pressed'), 'false');
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'false');
    assert.equal(await gemButton(page).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__filterRequests.length), 1, 'native reset must not reenable the gem filter');
});

test('new API gem metadata during a failed sort refreshes a confirmed active filter once', async t => {
    const nativeItems = [NATIVE_TB, { assetId: '101', name: 'Platinum Baby Roshan' }];
    const page = await openFixture(t, {
        inventory: nativeItems,
        plans: { fetchPrices: [{ hold: true }] },
        sortReply: { hold: true }, filterReply: { success: true, count: 1 }
    });
    await colorLink(page).waitFor({ state: 'visible' });
    await gemButton(page).click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter').getAttribute('aria-pressed') === 'true');
    await sortButton(page, 'original').click();
    await page.waitForFunction(() => window.__sortRequests.length === 1 && document.querySelector('#sih-lite-gem-filter').disabled);
    await page.evaluate(apiItem => {
        window.__filterReply = { hold: true };
        const pending = window.__pendingResponses.find(entry => entry.request.action === 'fetchPrices');
        pending.callback({ success: true, data: { items: [apiItem] } });
    }, { ...LEGACY_PBR, assetid: '101' });
    await colorLink(page, '101').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__filterRequests.length), 1, 'metadata must not overlap the running sort');
    await page.evaluate(() => window.postMessage({ source: 'SIH_LITE_PAGE', type: 'SORT_RESULT',
        requestId: window.__sortRequests[0].requestId, success: false, error: 'Native sort failed' }, location.origin));
    await page.waitForFunction(() => window.__stateRequests === 2 && window.__filterRequests.length === 2);
    const updated = await page.evaluate(() => window.__filterRequests[1]);
    assert.equal(updated.mode, 'colored');
    assert.deepEqual(updated.coloredAssetIds, ['101']);
    assert.equal(await gemButton(page).isEnabled(), false);
    await state(page, OWNER, '570', nativeItems, { order: 'original', gemFilter: 'colored' });
    await settleRender(page);
    assert.equal(await page.evaluate(() => window.__filterRequests.length), 2, 'duplicate state must not start overlapping filter work');
    await filterReply(page, { success: true, count: 2 });
    await waitText(page.locator('#sih-lite-status'), '2 items have colored gems. Steam text and tag filters still apply.');
    await state(page, OWNER, '570', nativeItems, { order: 'original', gemFilter: 'colored' });
    await settleRender(page);
    assert.equal(await page.evaluate(() => window.__filterRequests.length), 2, 'state refresh must not loop after the updated filter finishes');
    assert.equal(await gemButton(page).getAttribute('aria-pressed'), 'true');
    assert.equal(await gemButton(page).isEnabled(), true);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $123.45');
});

test('Russian socket descriptions keep a renamed TB regular native color over cached legacy RGB', async t => {
    // MAIN-world parsing normally produces this snapshot before content.js sees it.
    // Socket icon paths and CSS RGB stay stable while Steam translates gem labels.
    const asset = {
        assetid: '100',
        description: {
            market_hash_name: 'Fractal Horns of Inner Abysm',
            name: '«Мій синій Terrorblade»',
            descriptions: [{ type: 'html', value:
                '<div style="white-space: nowrap; padding: 3px;"><div><div style="border: 2px solid rgb(61, 104, 196)">' +
                '<div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color.hash.png)"></div>' +
                '<div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color_mask.hash.png)"></div>' +
                '</div></div><div><span style="font-size: 18px; color: rgb(61, 104, 196)">Глубокий синий</span><br>' +
                '<span style="font-size: 12px">Призматический самоцвет</span></div></div>' }]
        }
    };
    const metadata = require('../gems.js').analyzeSteamAsset(asset);
    const page = await openFixture(t, {
        inventory: [{ assetId: asset.assetid, name: asset.description.market_hash_name, ...metadata }],
        items: [{
            assetid: '100', marketHashName: 'Fractal Horns of Inner Abysm', priceCents: 100,
            prismaticGems: ['Legacy (230, 155, 253)'], legacyRgb: { r: 230, g: 155, b: 253 }, isLegacy: true
        }]
    });
    await page.evaluate(displayName => {
        document.querySelector('#item570_2_100 img').alt = displayName;
        // Simulate a native redraw; the content script observes child changes.
        document.querySelector('#item570_2_100').appendChild(document.createElement('span'));
    }, asset.description.name);
    await page.waitForFunction(() => !document.querySelector('[data-order="desc"]').disabled);
    await settleRender(page);
    assert.equal(await colorLink(page).count(), 1);
    const url = new URL(await colorLink(page).getAttribute('href'));
    assert.equal(url.searchParams.get('model'), 'TB');
    assert.equal(url.searchParams.get('kind'), 'regular');
    assert.deepEqual(['r', 'g', 'b'].map(key => url.searchParams.get(key)), ['61', '104', '196']);
    assert.equal(await page.locator('#item570_2_100 img').getAttribute('alt'), asset.description.name);
    assert.equal(await colorLink(page).textContent(), 'View color');
});

const SAVED_CACHE_AT = Date.UTC(2026, 9, 9, 12, 34);
const CACHE_HTTP_ERROR = 'Steamprice returned HTTP 502.';
const cachedReply = data => ({ success: true, data, cached: true, cachedAt: SAVED_CACHE_AT, error: CACHE_HTTP_ERROR });

test('saved inventory prices and total show dated cache notices and a forced retry replaces them with fresh data', async t => {
    const savedPrices = cachedReply({ items: DEFAULT_ITEMS });
    const savedTotal = cachedReply({ totalValueCents: '12345' });
    const freshPrices = { success: true, data: { items: [{ assetid: '100', marketHashName: 'Same Name', priceCents: 300 }] } };
    const freshTotal = { success: true, data: { totalValueCents: '15000' } };
    const page = await openFixture(t, { plans: {
        fetchPrices: [savedPrices, freshPrices],
        fetchProfile: [savedTotal, freshTotal]
    } });
    await waitText(badge(page), '$2.50');
    await page.waitForFunction(() => document.querySelector('#sih-lite-total-text')?.textContent.includes('(cached)'));
    assert.match(await page.locator('#sih-lite-total-text').textContent(), /\$123\.45.*\(cached\)/);
    const status = await page.locator('#sih-lite-status').textContent();
    assert.match(status, /Cached prices/);
    assert.match(status, /2026/);
    assert.equal((status.match(/HTTP 502/g) || []).length, 1, 'the same upstream failure is shown once');
    assert.match(await badge(page).getAttribute('title'), /Cached/i);
    assert.equal(await page.locator('#sih-lite-retry').isVisible(), true);
    const before = await page.evaluate(() => window.__chromeRequests.length);
    await page.locator('#sih-lite-retry').click();
    await waitText(badge(page), '$3.00');
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $150.00');
    const forced = await page.evaluate(start => window.__chromeRequests.slice(start), before);
    assert.ok(forced.some(request => request.action === 'fetchPrices' && request.force === true));
    assert.ok(forced.some(request => request.action === 'fetchProfile' && request.force === true));
    assert.doesNotMatch(await page.locator('#sih-lite-status').textContent(), /Cached|HTTP 502/);
    assert.doesNotMatch(await badge(page).getAttribute('title') || '', /Cached/i);
});

test('a failed forced cache refresh retains known item prices and total while keeping retry available', async t => {
    const savedTotal = cachedReply({ totalValueCents: '12345' });
    const page = await openFixture(t, { plans: {
        fetchPrices: [cachedReply({ items: DEFAULT_ITEMS }), { success: false, error: CACHE_HTTP_ERROR }],
        fetchProfile: [savedTotal, { success: false, error: CACHE_HTTP_ERROR }]
    } });
    await waitText(badge(page), '$2.50');
    await page.waitForFunction(() => document.querySelector('#sih-lite-total-text')?.textContent.includes('(cached)'));
    await page.locator('#sih-lite-retry').click();
    await page.waitForFunction(() => window.__chromeRequests.filter(request => request.action === 'fetchPrices' && request.force).length === 1);
    await settleRender(page);
    assert.equal(await badge(page).textContent(), '$2.50');
    assert.match(await page.locator('#sih-lite-total-text').textContent(), /\$123\.45/);
    assert.match(await page.locator('#sih-lite-status').textContent(), /HTTP 502/);
    assert.match(await badge(page).getAttribute('title'), /Cached/i);
    assert.equal(await page.locator('#sih-lite-retry').isVisible(), true);
});

test('HTTP 502 with no saved inventory data stays unavailable after retry without fabricating zero prices', async t => {
    const page = await openFixture(t, { plans: {
        fetchPrices: [{ success: false, error: CACHE_HTTP_ERROR }],
        fetchProfile: [{ success: false, error: CACHE_HTTP_ERROR }]
    } });
    await page.waitForFunction(() => document.querySelector('#sih-lite-status')?.textContent.includes('HTTP 502'));
    assert.equal(await badge(page).count(), 0);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Inventory value unavailable');
    await page.locator('#sih-lite-retry').click();
    await page.waitForFunction(() => window.__chromeRequests.filter(request => request.force).length >= 2);
    await settleRender(page);
    assert.equal(await badge(page).count(), 0);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Inventory value unavailable');
    assert.match(await page.locator('#sih-lite-status').textContent(), /HTTP 502/);
    assert.doesNotMatch(await page.locator('#sih-lite-status').textContent(), /Cached/);
});

test('a late saved profile response cannot overwrite a successful forced refresh for the same inventory owner', async t => {
    const page = await openFixture(t, { plans: {
        fetchPrices: [cachedReply({ items: DEFAULT_ITEMS }),
            { success: true, data: { items: [{ assetid: '100', marketHashName: 'Same Name', priceCents: 300 }] } }],
        fetchProfile: [{ hold: true }, { success: true, data: { totalValueCents: '15000' } }, { hold: true }]
    } });
    await waitText(badge(page), '$2.50');
    await page.waitForFunction(() => window.__pendingResponses.some(entry => entry.request.action === 'fetchProfile'));
    await page.locator('#sih-lite-retry').click();
    await waitText(badge(page), '$3.00');
    await waitText(page.locator('#sih-lite-total-text'), 'Dota 2 value: $150.00');
    await page.evaluate(response => {
        const index = window.__pendingResponses.findIndex(entry => entry.request.action === 'fetchProfile' && !entry.request.force);
        window.__pendingResponses.splice(index, 1)[0].callback(response);
    }, cachedReply({ totalValueCents: '12345' }));
    await settleRender(page);
    assert.equal(await page.locator('#sih-lite-total-text').textContent(), 'Dota 2 value: $150.00');
    assert.equal(await badge(page).textContent(), '$3.00');
    assert.doesNotMatch(await page.locator('#sih-lite-status').textContent(), /Cached|HTTP 502/);
    assert.equal(await page.evaluate(() => window.__chromeRequests.filter(request => request.action === 'fetchProfile').length), 2,
        'an older price load must not start another profile request after the forced refresh');
});
