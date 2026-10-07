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
      window.fixtureDescriptions = fixtureItems.map((asset, index) => ({ classid: asset.classid, instanceid: '0', name: `Item ${index}`, market_hash_name: `Item ${index}`, tags: [] }));
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
    await page.addScriptTag({ path: path.join(__dirname, '..', 'inject.js') });
    async function sort(order, id) {
      await page.evaluate(({ order, id }) => postMessage({ source: 'SIH_LITE_CONTENT', type: 'SORT', requestId: id, steamId: '76561198000000000', order, prices: { assetPrices: fixtureItems.map((asset, index) => [asset.assetid, index]), namePrices: [] } }, location.origin), { order, id });
      await page.waitForFunction(id => fixtureMessages.some(message => message.type === 'SORT_RESULT' && message.requestId === id), id);
      return page.evaluate(id => fixtureMessages.find(message => message.type === 'SORT_RESULT' && message.requestId === id), id);
    }
    assert.equal((await sort('desc', 'first')).success, true);
    assert.deepEqual(await page.evaluate(() => g_ActiveInventory.m_rgItemElements.map(holder => holder[0].rgItem.assetid)), Array.from({ length: 200 }, (_, i) => String(1199 - i)));
    assert.equal(await page.evaluate(() => fixtureRequests.length), 5);
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_$Inventory.find('.inventory_page').length), 2, 'Only the active and next page should have been created');
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgItemElements[199].data('iPage')), 7);
    await page.evaluate(() => $J(g_ActiveInventory.m_rgItemElements[0][0]).find('.inventory_item_link').trigger('click'));
    assert.equal(await page.evaluate(() => fixtureSelections.at(-1)), '1199');
    await page.evaluate(() => { g_ActiveInventory.SetActivePage(7); });
    assert.equal(await page.evaluate(() => g_ActiveInventory.m_rgPages[7].GetElement().find('.item').first()[0].rgItem.assetid), '1024');
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
    assert.deepEqual(errors, []);
    console.log('PASS: authoritative Steam economy_v2.js + Prototype + jQuery in Chromium: 200 items, 5 lazy batches, native pagination, filtering, responsive sorting/restoration and click-handler preservation.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
