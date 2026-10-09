const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const fixtureDir = process.env.SIH_STEAM_FIXTURES || path.resolve(__dirname, '../../.sih-test-fixtures');
// Official Steam scripts live outside the checkout. This runner performs no network requests.
// Source: https://steamcommunity.com/public/javascript/{prototype-1.7.js,jquery-1.11.1.min.js,economy_v2.js}
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SIH_CHROMIUM_PATH || '/usr/lib/chromium/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <div id="filter_control"><input id="filter_input"><button id="filter_clear_btn"></button></div>
      <div id="filter_options"></div><div id="inventories"></div>
      <div id="active_inventory_page"></div><div id="empty_filtered_inventory_page"></div>
      <div id="inventory_pagecontrols"><button id="pagebtn_previous"></button><span id="pagecontrol_cur"></span><span id="pagecontrol_max"></span><button id="pagebtn_next"></button></div>
      </body></html>` }));
    await page.goto('https://steamcommunity.com/profiles/76561198000000000/inventory/');
    await page.addScriptTag({ content: fs.readFileSync(path.join(fixtureDir, 'prototype-1.7.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(fixtureDir, 'jquery-1.11.1.min.js'), 'utf8') });
    await page.evaluate(() => { window.$J = window.jQuery.noConflict(); });
    await page.addScriptTag({ content: fs.readFileSync(path.join(fixtureDir, 'economy_v2.js'), 'utf8') });
    await page.evaluate(() => {
      window.INVENTORY_PAGE_ITEMS = 25;
      window.g_bIsInventoryPage = true;
      window.v_numberformat = value => String(value);
      window.v_trim = value => value.trim();
      window.ImageURL = () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      window.UpdateReactItemInfo = () => {};
      window.fixtureItems = Array(200).fill(null).map((_, index) => ({ assetid: String(1000 + index), classid: String(2000 + index), instanceid: '0', appid: '570', contextid: '2', amount: '1' }));
      window.fixtureDescriptions = fixtureItems.map((asset, index) => ({
        classid: asset.classid, instanceid: '0', name: index === 0 ? 'Unusual Platinum Baby Roshan' : `Item ${index}`,
        market_hash_name: index === 0 ? 'Unusual Platinum Baby Roshan' : `Item ${index}`,
        type: 'Rare Wearable',
        tags: index % 4 === 0 ? [{ category: 'rarity', internal_name: 'rare', localized_tag_name: 'Rare', localized_category_name: 'Rarity' }] : [],
        descriptions: index % 3 === 0 ? [{ type: 'html', value:
          `<div style="white-space: nowrap; margin: 9px"><div style="white-space: nowrap; padding: 3px"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/${index % 6 === 0 ? 'gem_color' : 'gem_kinetic'}.png)"></div><div><span style="font-size: 18px; color: rgb(161,255,89)">${index % 6 === 0 ? 'Bright Green' : 'Fireborn Assault'}</span><br><span style="font-size: 12px">${index % 6 === 0 ? 'Prismatic Gem' : 'Kinetic Gem'}</span></div></div></div>`
        }] : []
      }));
      // Actual Russian socket shape and RGB verified from Steam market SSR:
      // /market/listings/570/Unusual%20Baby%20Roshan?l=russian (Deep Blue).
      // Renamed items retain canonical market_hash_name despite custom name.
      fixtureDescriptions[6].name = '«Мои переименованные рога»';
      fixtureDescriptions[6].market_name = 'Fractal Horns of Inner Abysm';
      fixtureDescriptions[6].market_hash_name = 'Fractal Horns of Inner Abysm';
      fixtureDescriptions[6].type = 'Демонические рога, Arcana';
      fixtureDescriptions[6].descriptions = [{ type: 'html', value:
        '<div style="white-space: nowrap; margin: 9px"><div style="white-space: nowrap; padding: 3px"><div style="border: 2px solid rgb(61, 104, 196)"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color.991870a920f3defab3c5a1b4c77fb747e8dfca1d.png)"></div><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color_mask.d6a50dcfd6ef4220c0935872ab03b1b0f464fefa.png)"></div></div><div><span style="font-size: 18px; white-space: normal; color: rgb(61, 104, 196)">Глубокий синий</span><br><span style="font-size: 12px">Призматический самоцвет</span></div></div></div>'
      }];
      const owner = { GetSteamId: () => '76561198000000000', ShowLoadingIndicator() {}, HideLoadingIndicator() {} };
      window.g_ActiveInventory = new CInventory(owner, 570, '2', { asset_count: 200 });
      window.fixtureInventory = g_ActiveInventory;
      window.fixtureSelections = [];
      g_ActiveInventory.SelectItem = (event, element, item) => { fixtureSelections.push(item.assetid); event?.preventDefault(); };
      g_ActiveInventory.EnsureItemHoldersCreated();
      g_ActiveInventory.AddInventoryData({ assets: fixtureItems.slice(0, 75), descriptions: fixtureDescriptions, total_inventory_count: 200, more_items: 1, last_assetid: '1074' });
      g_ActiveInventory.m_bPerformedInitialLoad = true;
      window.fixtureRequests = [];
      $J.get = (url, params) => {
        fixtureRequests.push({ url, params });
        const deferred = $J.Deferred();
        setTimeout(() => {
          const start = params.start_assetid ? fixtureItems.findIndex(item => item.assetid === params.start_assetid) + 1 : 0;
          const assets = fixtureItems.slice(start, start + 30);
          deferred.resolve({ assets, descriptions: fixtureDescriptions, total_inventory_count: 200, more_items: start + assets.length < 200 ? 1 : 0, last_assetid: assets[assets.length - 1]?.assetid });
        }, 20);
        return deferred.promise();
      };
      g_ActiveInventory.m_bActive = true;
      document.getElementById('inventories').append(g_ActiveInventory.m_$Inventory[0]);
      g_ActiveInventory.LayoutPages();
      Filter.InitFilter(document.getElementById('filter_input'));
      window.fixtureMessages = [];
      addEventListener('message', event => { if (event.data?.source === 'SIH_LITE_PAGE') fixtureMessages.push(event.data); });
    });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'gems.js') });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'inject.js') });
    async function sort(order, id) {
      await page.evaluate(({ order, id }) => postMessage({ source: 'SIH_LITE_CONTENT', type: 'SORT', requestId: id, steamId: '76561198000000000', order, prices: { assetPrices: fixtureItems.map((asset, index) => [asset.assetid, index]), namePrices: [] } }, location.origin), { order, id });
      await page.waitForFunction(id => fixtureMessages.some(message => message.type === 'SORT_RESULT' && message.requestId === id), id);
      return page.evaluate(id => fixtureMessages.find(message => message.type === 'SORT_RESULT' && message.requestId === id), id);
    }
    async function gemFilter(mode, id, coloredAssetIds = []) {
      await page.evaluate(({ mode, id, coloredAssetIds }) => postMessage({ source: 'SIH_LITE_CONTENT', type: 'FILTER_GEMS', requestId: id, steamId: '76561198000000000', mode, gemAssetIds: [], coloredAssetIds }, location.origin), { mode, id, coloredAssetIds });
      await page.waitForFunction(id => fixtureMessages.some(message => message.type === 'FILTER_RESULT' && message.requestId === id), id);
      return page.evaluate(id => fixtureMessages.find(message => message.type === 'FILTER_RESULT' && message.requestId === id), id);
    }
    async function visibleIds() {
      return page.evaluate(() => g_ActiveInventory.m_$Inventory.find('.itemHolder').filter(function () { return !this.filtered && this.rgItem; }).map(function () { return this.rgItem.assetid; }).get());
    }
    const initialGems = await gemFilter('colored', 'load-colored', ['1199']);
    assert.equal(initialGems.success, true);
    assert.equal(initialGems.count, 35, 'Colored sockets plus explicit Steamprice evidence; kinetic gems excluded');
    assert.equal(await page.evaluate(() => fixtureRequests.length), 5);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_bFullyLoaded), true);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_cPages), 2);
    assert.ok((await visibleIds()).includes('1199'), 'Matching items on initially unloaded pages are included');
    assert.equal(await page.evaluate(() => $J(g_ActiveInventory.m_rgAssets['1199'].homeElement).data('iPage')), 1, 'Gem filter updates native item page metadata before any sort');
    assert.equal((await gemFilter('all', 'restore-all')).success, true);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_cPages), 8);
    assert.equal((await sort('desc', 'first')).success, true);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.map(holder => holder[0].rgItem.assetid)), Array.from({ length: 200 }, (_, i) => String(1199 - i)));
    assert.equal(await page.evaluate(() => fixtureRequests.length), 5);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_$Inventory.find('.inventory_page').length), 2, 'Only the active and next page should have been created');
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgItemElements[199].data('iPage')), 7);
    await page.evaluate(() => $J(g_ActiveInventory.m_rgItemElements[0][0]).find('.inventory_item_link').trigger('click'));
    assert.equal(await page.evaluate(() => fixtureSelections.at(-1)), '1199');
    await page.evaluate(() => { g_ActiveInventory.SetActivePage(7); });
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgPages[7].GetElement().find('.item').first()[0].rgItem.assetid), '1024');
    assert.equal((await gemFilter('colored', 'sorted-colored', ['1199'])).success, true);
    assert.deepEqual(await visibleIds(), ['1199', ...Array.from({ length: 34 }, (_, index) => String(1198 - index * 6))]);
    assert.equal((await gemFilter('colored', 'repeated-colored', ['1199'])).count, 35);
    assert.equal((await sort('asc', 'colored-asc')).success, true);
    assert.deepEqual(await visibleIds(), [...Array.from({ length: 34 }, (_, index) => String(1000 + index * 6)), '1199']);
    assert.equal((await sort('desc', 'colored-desc')).success, true);
    assert.equal(await page.evaluate(() => Filter.elFilter.value), '');
    assert.deepEqual(await page.evaluate(() => Filter.rgCurrentTags), {}, 'The synthetic gem category does not leak into native tags');
    await page.evaluate(() => { Filter.elFilter.value = 'Item 10'; Filter.OnFilterChange(); });
    assert.deepEqual(await visibleIds(), ['1108', '1102']);
    await page.evaluate(() => Filter.UpdateTagFiltering({ Rarity: ['rare'] }));
    assert.deepEqual(await visibleIds(), ['1108']);
    await page.evaluate(() => Filter.ClearTextFilter());
    assert.equal((await visibleIds()).length, 17, 'Clearing text keeps native tags and gem predicate');
    assert.equal((await gemFilter('all', 'remove-gems-preserve-tags')).success, true);
    assert.equal((await visibleIds()).length, 50, 'Turning off gem filter preserves native tags');
    await page.evaluate(() => Filter.UpdateTagFiltering({}));
    assert.equal((await visibleIds()).length, 200);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.map(holder => holder[0].rgItem.assetid)), Array.from({ length: 200 }, (_, i) => String(1199 - i)), 'Gem filtering preserves the current price order');
    await page.evaluate(() => {
      Filter.elFilter.value = 'Item 10';
      Filter.OnFilterChange();
    });
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_cPages), 1);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgPages[0].GetElement().children('.itemHolder').filter(function () { return !this.filtered && this.rgItem; }).map(function () { return this.rgItem.assetid; }).get()), ['1110','1109','1108','1107','1106','1105','1104','1103','1102','1101','1100','1010']);
    assert.equal((await sort('asc', 'filtered')).success, true);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgPages[0].GetElement().children('.itemHolder').filter(function () { return !this.filtered && this.rgItem; }).map(function () { return this.rgItem.assetid; }).get()), ['1010','1100','1101','1102','1103','1104','1105','1106','1107','1108','1109','1110']);
    await page.evaluate(() => Filter.ClearTextFilter());
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_cPages), 8);
    assert.equal((await sort('original', 'restore')).success, true);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.map(holder => holder[0].rgItem.assetid)), Array.from({ length: 200 }, (_, i) => String(1000 + i)));
    await page.evaluate(() => { window.g_bEnableDynamicSizing = true; g_ActiveInventory.LayoutPages(); });
    assert.equal((await sort('desc', 'responsive')).success, true);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgPages[0].GetElement().find('.item').first()[0].rgItem.assetid), '1199');
    assert.equal((await sort('original', 'responsive-restore')).success, true);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgPages[0].GetElement().find('.item').first()[0].rgItem.assetid), '1000');
    await page.evaluate(() => { Filter.elFilter.value = 'Item 10'; Filter.OnFilterChange(); Filter.ClearTextFilter(); });
    await page.evaluate(() => $J(g_ActiveInventory.m_rgItemElements[0][0]).find('.inventory_item_link').trigger('click'));
    assert.equal(await page.evaluate(() => fixtureSelections.at(-1)), '1000', 'Native click handlers survive responsive filter clearing');
    assert.equal((await gemFilter('colored', 'responsive-colored')).success, true);
    await page.evaluate(() => { Filter.elFilter.value = 'Item 10'; Filter.OnFilterChange(); Filter.ClearTextFilter(); });
    assert.equal((await visibleIds()).length, 34);
    await page.evaluate(() => $J(g_ActiveInventory.m_rgItemElements[0][0]).find('.inventory_item_link').trigger('click'));
    assert.equal(await page.evaluate(() => fixtureSelections.at(-1)), '1000', 'Native clicks survive responsive gem-filter and text-filter clearing');
    assert.equal((await gemFilter('all', 'responsive-all')).success, true);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.filter(holder => !holder[0].filtered).length), 200, 'Responsive mode preserves native lazy DOM creation while restoring all items');

    // Exercise the actual deployment worlds: MAIN owns Steam and the bridge;
    // content runs in a distinct isolated world with only chrome.runtime mocked.
    await page.evaluate(() => { window.g_bEnableDynamicSizing = false; });
    assert.equal((await sort('original', 'isolated-world-reset')).success, true);
    const cdp = await page.context().newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'SIH extension smoke world'
    });
    const evaluateIsolated = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    assert.equal(await evaluateIsolated('typeof window.g_ActiveInventory'), 'undefined', 'Content cannot directly read MAIN-world Steam objects');
    const apiItems = Array.from({ length: 200 }, (_, index) => ({
      assetid: String(1000 + index), priceCents: index,
      marketHashName: index === 0 ? 'Unusual Platinum Baby Roshan' : `Item ${index}`
    }));
    await evaluateIsolated(`window.chrome = { runtime: {
      lastError: undefined,
      sendMessage(request, callback) {
        const data = request.action === 'fetchPrices' ? { items: ${JSON.stringify(apiItems)} } : { totalValueCents: 19900 };
        setTimeout(() => callback({ success: true, data }), 0);
      }
    }};`);
    await evaluateIsolated(fs.readFileSync(path.join(__dirname, '..', 'gems.js'), 'utf8'));
    await evaluateIsolated(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'));
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter')?.disabled === false && document.querySelector('#sih-lite-total-text')?.textContent === 'Dota 2 value: $199.00');
    await page.locator('#sih-lite-gem-filter').click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#sih-lite-gem-filter')?.disabled === false);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.filter(holder => !holder[0].filtered).length), 34, 'Isolated content button filters real native pages through MAIN bridge');
    const colorLink = page.locator('[id="570_2_1000"] .sih-lite-color-link');
    await colorLink.waitFor({ state: 'attached' });
    const colorUrl = new URL(await colorLink.getAttribute('href'));
    assert.equal(colorUrl.origin, 'https://steamprice.com');
    assert.equal(colorUrl.pathname, '/dota2/legacy');
    assert.equal(colorUrl.searchParams.get('model'), 'PBR');
    assert.equal(colorUrl.searchParams.get('r'), '161');
    assert.equal(colorUrl.searchParams.get('g'), '255');
    assert.equal(colorUrl.searchParams.get('b'), '89');
    const russianColorLink = page.locator('[id="570_2_1006"] .sih-lite-color-link');
    await russianColorLink.waitFor({ state: 'attached' });
    const russianColorUrl = new URL(await russianColorLink.getAttribute('href'));
    assert.equal(russianColorUrl.origin, 'https://steamprice.com');
    assert.equal(russianColorUrl.searchParams.get('model'), 'TB', 'Renamed Russian item resolves the viewer model from canonical market hash');
    assert.equal(russianColorUrl.searchParams.get('r'), '61');
    assert.equal(russianColorUrl.searchParams.get('g'), '104');
    assert.equal(russianColorUrl.searchParams.get('b'), '196');
    assert.equal(russianColorUrl.searchParams.get('kind'), 'regular', 'Native regular color produces a regular viewer URL');
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgAssets['1006'].homeElement.filtered), false, 'Russian regular gem survives native colored-gem filtering');
    const selectionsBeforeLink = await page.evaluate(() => fixtureSelections.length);
    await page.evaluate(() => {
      const link = document.querySelector('[id="570_2_1000"] .sih-lite-color-link');
      link.addEventListener('click', event => event.preventDefault(), { once: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    assert.equal(await page.evaluate(() => fixtureSelections.length), selectionsBeforeLink, 'Isolated-world color link click does not select native item');
    await page.locator('#sih-lite-gem-filter').click();
    await page.waitForFunction(() => document.querySelector('#sih-lite-gem-filter')?.getAttribute('aria-pressed') === 'false' && document.querySelector('#sih-lite-gem-filter')?.disabled === false);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.filter(holder => !holder[0].filtered).length), 200);
    await page.locator('[data-order="desc"]').click();
    await page.waitForFunction(() => document.querySelector('[data-order="desc"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-order="desc"]')?.disabled === false);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.map(holder => holder[0].rgItem.assetid)), Array.from({ length: 200 }, (_, index) => String(1199 - index)), 'Isolated-world price sort still uses native inventory');
    await cdp.detach();
    assert.deepEqual(errors, []);
    console.log('PASS: official Steam scripts in Chromium: complete loading, native filtering/sorting/responsive clicks, MAIN/isolated bridge, exact RGB and Russian regular-gem renamed-TB viewer.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
