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
    await page.goto(`https://steamcommunity.com/profiles/${OWNER}/inventory/`);
    await page.evaluate(config => {
        window.__chromeRequests = [];
        window.__pendingResponses = [];
        window.__sortRequests = [];
        window.__sortReply = config.sortReply || { success: true, count: 4 };
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
                window.postMessage({ source: 'SIH_LITE_PAGE', type: 'STATE', steamId: config.owner,
                    appId: config.appId, contextId: '2' }, location.origin);
                window.postMessage({ source: 'SIH_LITE_PAGE', type: 'INVENTORY', steamId: config.owner,
                    appId: config.appId, contextId: '2', items: config.inventory }, location.origin);
            } else if (message.type === 'SORT') {
                window.__sortRequests.push(message);
                setTimeout(() => window.postMessage({ source: 'SIH_LITE_PAGE', type: 'SORT_RESULT',
                    requestId: message.requestId, ...window.__sortReply }, location.origin), 0);
            }
        });
    }, {
        owner: options.owner || OWNER,
        appId: options.appId || '570',
        items: options.items || DEFAULT_ITEMS,
        inventory: INVENTORY,
        totalValueCents: options.totalValueCents ?? '12345',
        plans: options.plans,
        sortReply: options.sortReply
    });
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

async function state(page, owner, appId = '570') {
    await page.evaluate(({ id, app, items }) => {
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'STATE', steamId: id, appId: app, contextId: '2' }, location.origin);
        window.postMessage({ source: 'SIH_LITE_PAGE', type: 'INVENTORY', steamId: id, appId: app, contextId: '2', items }, location.origin);
    }, { id: owner, app: appId, items: INVENTORY });
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
