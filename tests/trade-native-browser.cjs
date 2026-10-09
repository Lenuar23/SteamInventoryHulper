const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Downloaded official fixtures stay outside the checkout. This runner is offline.
// Sources: https://steamcommunity.com/public/javascript/{prototype-1.7.js,
// jquery-1.11.1.min.js,economy_common.js,economy.js,economy_trade.js,economy_tradeoffer.js}
const fixtureDir = process.env.SIH_STEAM_FIXTURES || path.resolve(__dirname, '../../.sih-test-fixtures');
const ME = '76561198000000001';
const THEM = '76561198000000002';
const HTML = `<!doctype html><html><head><style>
  .itemHolder { width: 96px; height: 96px; display: inline-block; position: relative }
  .item { width: 96px; height: 96px; position: relative }
  .inventory_page { width: 416px }
</style></head><body><div id="trade_area"><div id="inventory_box">
  <input id="filter_control"><button id="filter_clear_btn"></button>
  <button id="filter_tag_show"></button><button id="filter_tag_hide"></button>
  <div id="filter_options"></div><div id="inventories"></div>
  <div id="active_inventory_page"></div><div id="empty_filtered_inventory_page"></div>
  <div id="inventory_pagecontrols"><button id="pagebtn_previous"></button>
  <span id="pagecontrol_cur"></span><span id="pagecontrol_max"></span><button id="pagebtn_next"></button></div>
  <div id="appselect"></div><div id="appselect_you_options"></div><div id="appselect_them_options"></div>
  <div id="appselect_activeapp"></div><div id="trade_inventory_unavailable"></div>
  <div id="trade_inventory_failed"></div><div id="trade_inventory_pending"></div>
  <div id="trade_inventory_message_no_inventory"><span class="gamename"></span></div>
  <div id="trade_inventory_message_not_allowed"></div>
  </div><div id="trade_box"><div id="trade_yours"><div id="your_slots"></div><div id="your_slots_currency"></div></div>
  <div id="trade_theirs"><div id="their_slots"></div><div id="their_slots_currency"></div></div>
  </div></div><div id="log"></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SIH_CHROMIUM_PATH || '/usr/lib/chromium/chromium',
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
    await page.goto('https://steamcommunity.com/tradeoffer/new/?partner=2');
    for (const file of ['prototype-1.7.js', 'jquery-1.11.1.min.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(fixtureDir, file), 'utf8') });
    }
    await page.evaluate(() => { window.$J = window.jQuery.noConflict(); });
    for (const file of ['economy_common.js', 'economy.js', 'economy_trade.js', 'economy_tradeoffer.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(fixtureDir, file), 'utf8') });
    }
    await page.evaluate(({ me, them }) => {
      window.g_bIsTrading = true;
      window.g_bTradeOffer = true;
      window.g_bShowTradableItemsOnly = true;
      window.g_bReadOnly = false;
      window.g_bEnableDynamicSizing = false;
      window.g_sessionID = 'offline-test-session';
      window.g_strInventoryLoadURL = 'https://steamcommunity.com/inventory/';
      window.g_ulTradePartnerSteamID = them;
      window.g_strTradePartnerInventoryLoadURL = 'https://steamcommunity.com/tradeoffer/new/partnerinventory/';
      window.v_trim = value => String(value).trim();
      window.v_numberformat = value => String(value);
      window.ImageURL = () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      window.HideMenu = () => {};
      window.HideHover = () => {};
      window.SetCookie = () => {};
      window.Tutorial = { OnSelectedNonEmptyInventory() {}, OnUserAddedItemsToTrade() {} };
      window.fixtureDraggables = new Map();
      // Steam's native MakeItemDraggable and its native dblclick listener run unchanged.
      // Only Scriptaculous's drag engine is mocked, avoiding real pointer movement.
      window.Draggable = function(element, options) { fixtureDraggables.set(element, { element, options }); };
      window.Droppables = { add() {}, remove() {} };
      window.fixtureMessages = [];
      window.fixtureNativeCallbacks = { dblclick: OnDoubleClickItem, dropTrade: OnDropItemInTrade,
        dropInventory: OnDropItemInInventory, startDrag: StartDrag, endDrag: EndDrag };
      window.g_rgCurrentTradeStatus = { version: 1, newversion: true,
        me: { assets: [], currency: [] }, them: { assets: [], currency: [] } };
      window.fixtureNativeCalls = [];
      window.fixtureRedrawSlots = () => {
        UpdateSlots(g_rgCurrentTradeStatus.me.assets, [], true, UserYou, g_rgCurrentTradeStatus.version);
        UpdateSlots(g_rgCurrentTradeStatus.them.assets, [], false, UserThem, g_rgCurrentTradeStatus.version);
      };
      // The inventory completion callback normally also redraws ready/confirm
      // controls. This fixture keeps the actual slot update without those controls.
      window.RedrawCurrentTradeStatus = fixtureRedrawSlots;
      // The trade manager is local-only: native movement/slot functions perform the DOM work.
      // This harness cannot send, accept, confirm, or decline an offer.
      window.GTradeStateManager = {
        SetItemInTrade(item, slot, amount) {
          fixtureNativeCalls.push({ action: 'add', id: item.id, side: item.is_their_item ? 'them' : 'me' });
          const assets = g_rgCurrentTradeStatus[item.is_their_item ? 'them' : 'me'].assets;
          const existing = assets.find(asset => asset.assetid === item.id);
          if (existing) existing.amount = amount || 1;
          else assets.push({ appid: item.appid, contextid: item.contextid, assetid: item.id, amount: amount || 1 });
          g_rgCurrentTradeStatus.version++;
          fixtureRedrawSlots();
        },
        RemoveItemFromTrade(item) {
          fixtureNativeCalls.push({ action: 'remove', id: item.id, side: item.is_their_item ? 'them' : 'me' });
          const assets = g_rgCurrentTradeStatus[item.is_their_item ? 'them' : 'me'].assets;
          const index = assets.findIndex(asset => asset.assetid === item.id);
          if (index >= 0) assets.splice(index, 1);
          g_rgCurrentTradeStatus.version++;
          fixtureRedrawSlots();
        }
      };
      const apps = { 570: { name: 'Dota 2', icon: ImageURL(), secure_trades: false,
        rgContexts: { 2: { id: '2', name: 'Items', asset_count: 40 } } } };
      window.g_rgAppContextData = apps;
      UserYou.strSteamId = me;
      UserThem.strSteamId = them;
      UserYou.strProfileURL = `https://steamcommunity.com/profiles/${me}`;
      UserThem.strProfileURL = `https://steamcommunity.com/profiles/${them}`;
      UserYou.LoadContexts(structuredClone(apps));
      UserThem.LoadContexts(structuredClone(apps));
      window.fixtureMakeItems = (base, count) => Object.fromEntries(Array(count).fill(null).map((_, index) => {
        const id = String(base + index);
        return [id, { id, classid: String(base + 10000 + index), instanceid: '0', pos: index,
          name: `Item ${index}`, market_hash_name: `Item ${index}`, amount: index === 2 ? '5' : '1',
          tradable: 1, marketable: 1, type: 'Wearable', icon_url: '', descriptions: [],
          tags: index % 2 === 0 ? [{ category: 'rarity', internal_name: 'rare', name: 'Rare' }] : [] }];
      }));
      window.fixtureInventories = {};
      for (const [side, owner, base, count] of [['me', UserYou, 1000, 40], ['them', UserThem, 2000, 37]]) {
        const inventory = new CInventory(owner, 570, '2', fixtureMakeItems(base, count), {});
        owner.addInventory(inventory);
        inventory.Initialize();
        inventory.getInventoryElement().hide();
        $('inventories').appendChild(inventory.getInventoryElement());
        $('filter_options').appendChild(inventory.getTagContainer());
        fixtureInventories[side] = inventory;
      }
      Filter.InitFilter($('filter_control'));
      TradePageSelectInventory(UserYou, 570, '2');
      fixtureRedrawSlots();
      addEventListener('message', event => {
        if (event.data?.source === 'SIH_LITE_TRADE_PAGE') fixtureMessages.push(event.data);
      });
    }, { me: ME, them: THEM });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'gems.js') });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'trade-inject.js') });

    async function editor() {
      const messageCount = await page.evaluate(() => fixtureMessages.length);
      await page.evaluate(() => postMessage({ source: 'SIH_LITE_TRADE_CONTENT', type: 'STATE_REQUEST' }, location.origin));
      await page.waitForFunction(count => fixtureMessages.slice(count).some(message => message.type === 'EDITOR'), messageCount);
      return page.evaluate(() => fixtureMessages.filter(message => message.type === 'EDITOR').at(-1));
    }
    async function sort(side, order, requestId, contextId = '2') {
      await page.evaluate(({ side, order, requestId, ownerSteamId, contextId }) => {
        const inventory = fixtureInventories[side];
        const holders = inventory.rgItemElements || [];
        const assetPrices = holders.map(holder => [holder.rgItem.id, Number(holder.rgItem.pos) + 1]);
        postMessage({ source: 'SIH_LITE_TRADE_CONTENT', type: 'SORT', requestId,
          ownerSteamId, side, appId: '570', contextId, order,
          prices: { assetPrices, namePrices: [] } }, location.origin);
      }, { side, order, requestId, ownerSteamId: side === 'me' ? ME : THEM, contextId });
      await page.waitForFunction(id => fixtureMessages.some(message => message.type === 'SORT_RESULT' && message.requestId === id), requestId);
      return page.evaluate(id => fixtureMessages.find(message => message.type === 'SORT_RESULT' && message.requestId === id), requestId);
    }
    async function ids(side) {
      return page.evaluate(side => fixtureInventories[side].rgItemElements.map(holder => holder.rgItem.id), side);
    }
    async function visibleIds() {
      return page.evaluate(() => g_ActiveInventory.pageList.flatMap(page => page.childElements())
        .filter(holder => holder.rgItem && !holder.filtered).map(holder => holder.rgItem.id));
    }

    const initial = await editor();
    assert.equal(initial.owners.me.steamId, ME);
    assert.equal(initial.owners.them.steamId, THEM);
    assert.equal(initial.active.side, 'me');
    assert.equal(initial.active.supported, true);
    assert.equal(initial.inventories.find(inventory => inventory.side === 'me').items.length, 40);
    assert.equal(initial.inventories.find(inventory => inventory.side === 'them').items.length, 37);
    const firstSort = await sort('me', 'desc', 'me-desc');
    assert.equal(firstSort.success, true, firstSort.error);
    assert.deepEqual(await ids('me'), Array.from({ length: 40 }, (_, i) => String(1039 - i)));
    assert.equal(await page.evaluate(() => g_ActiveInventory.pageTotal), 3);
    await page.evaluate(() => g_ActiveInventory.SetActivePage(2));
    assert.equal(await page.evaluate(() => g_ActiveInventory.pageList[2].firstChild.rgItem.id), '1007');

    // Actual native double-click moves the original item node into the offer.
    await page.evaluate(() => {
      window.fixtureOfferedNode = fixtureInventories.me.rgInventory['1039'].element;
      window.fixtureOfferedHome = fixtureInventories.me.rgInventory['1039'].homeElement;
      fixtureOfferedNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    assert.equal(await page.evaluate(() => fixtureOfferedNode.parentElement.matches('#your_slots .slot_inner')), true);
    assert.equal((await sort('me', 'asc', 'offered-me-asc')).success, true);
    assert.equal(await page.evaluate(() => fixtureOfferedNode.parentElement.matches('#your_slots .slot_inner')), true,
      'Sorting native home holders must not steal an offered item back from its slot');
    assert.equal(await page.evaluate(() => fixtureInventories.me.rgInventory['1039'].homeElement === fixtureOfferedHome), true);
    const offered = await editor();
    assert.equal(offered.offers.me[0].assetId, '1039');
    assert.equal(offered.offers.me[0].ownerSteamId, ME);
    assert.equal(Number(offered.offers.me[0].amount), 1);
    assert.equal(await page.evaluate(() => fixtureOfferedNode.dataset.sihTradeOwner), ME);
    assert.equal(await page.evaluate(() => fixtureOfferedNode.dataset.sihTradeAsset), '1039');
    assert.equal(await page.evaluate(() => fixtureOfferedNode.dataset.sihTradeSide), 'me');
    await page.evaluate(() => fixtureOfferedNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => fixtureOfferedNode.parentNode === fixtureOfferedHome), true,
      'Native removal returns the same node to its sorted home holder');

    await page.evaluate(() => {
      Filter.elFilter.value = 'Item 1';
      Filter.OnFilterChange();
      Filter.UpdateTagFiltering({ rarity: ['rare'] });
    });
    assert.deepEqual(await visibleIds(), ['1010', '1012', '1014', '1016', '1018']);
    assert.equal((await sort('me', 'desc', 'filtered-me-desc')).success, true);
    assert.deepEqual(await visibleIds(), ['1018', '1016', '1014', '1012', '1010']);
    assert.equal(await page.evaluate(() => Filter.elFilter.value), 'Item 1');
    assert.deepEqual(await page.evaluate(() => Filter.rgCurrentTags), { rarity: ['rare'] });
    await page.evaluate(() => { Filter.ClearTextFilter(); Filter.UpdateTagFiltering({}); });
    assert.equal((await visibleIds()).length, 40);

    // Switch using Steam's own selection function, then independently sort the partner.
    await page.evaluate(() => TradePageSelectInventory(UserThem, 570, '2'));
    assert.equal((await editor()).active.side, 'them');
    assert.equal((await sort('them', 'desc', 'them-desc')).success, true);
    assert.deepEqual(await ids('them'), Array.from({ length: 37 }, (_, i) => String(2036 - i)));
    assert.deepEqual(await ids('me'), Array.from({ length: 40 }, (_, i) => String(1039 - i)),
      'Partner sorting preserves our independent inventory order');
    await page.evaluate(() => {
      window.fixtureTheirNode = fixtureInventories.them.rgInventory['2036'].element;
      window.fixtureTheirHome = fixtureInventories.them.rgInventory['2036'].homeElement;
      OnDropItemInTrade(fixtureTheirNode, $('trade_theirs'), null);
    });
    assert.equal(await page.evaluate(() => fixtureTheirNode.parentElement.matches('#their_slots .slot_inner')), true);
    assert.equal((await sort('them', 'asc', 'offered-them-asc')).success, true);
    assert.equal(await page.evaluate(() => fixtureTheirNode.parentElement.matches('#their_slots .slot_inner')), true);
    await page.evaluate(() => OnDropItemInInventory(fixtureTheirNode, $('inventories'), null));
    assert.equal(await page.evaluate(() => fixtureTheirNode.parentNode === fixtureTheirHome), true);

    // A stack's inventory amount becomes its remaining count; offered metadata must use
    // the actual status amount, not that remaining count or the original stack amount.
    await page.evaluate(() => {
      GTradeStateManager.SetItemInTrade(fixtureInventories.them.rgInventory['2002'], 0, 2);
    });
    const stack = (await editor()).offers.them.find(item => item.assetId === '2002');
    assert.equal(Number(stack.amount), 2);
    assert.equal(await page.evaluate(() => fixtureInventories.them.rgInventory['2002'].amount), 3);
    assert.equal((await sort('them', 'original', 'them-restore')).success, true);
    assert.deepEqual(await ids('them'), Array.from({ length: 37 }, (_, i) => String(2000 + i)));
    assert.equal(await page.evaluate(() => fixtureInventories.them.rgInventory['2002'].trade_stack.element.parentElement.matches('#their_slots .slot_inner')), true);
    await page.evaluate(() => {
      GTradeStateManager.RemoveItemFromTrade(fixtureInventories.them.rgInventory['2002']);
      TradePageSelectInventory(UserYou, 570, '2');
    });
    assert.equal((await editor()).active.order, 'desc');
    assert.equal((await sort('me', 'original', 'me-restore')).success, true);
    assert.deepEqual(await ids('me'), Array.from({ length: 40 }, (_, i) => String(1000 + i)));
    assert.equal(await page.evaluate(() =>
      fixtureNativeCallbacks.dblclick === OnDoubleClickItem &&
      fixtureNativeCallbacks.dropTrade === OnDropItemInTrade &&
      fixtureNativeCallbacks.dropInventory === OnDropItemInInventory &&
      fixtureDraggables.get(fixtureInventories.me.rgInventory['1000'].element).options.onStart === StartDrag &&
      fixtureDraggables.get(fixtureInventories.me.rgInventory['1000'].element).options.onEnd === EndDrag
    ), true, 'Native double-click and drag callback functions are retained');

    // Real native pagination continuation and Pending -> CInventory replacement.
    await page.evaluate(() => {
      const owner = UserThem;
      const oldInventory = fixtureInventories.them;
      owner.GetContext(570, '2').inventory = null;
      oldInventory.getInventoryElement().remove();
      window.fixtureRequests = [];
      window.fixturePendingPages = [];
      const allItems = fixtureMakeItems(3000, 35);
      for (const [id, gem, rgb] of [['3000', 'Bright Green', '161,255,89'], ['3001', 'Deep Blue', '61,104,196']]) {
        allItems[id].market_hash_name = 'Shared Wearable';
        allItems[id].descriptions = [{ type: 'html', value:
          `<div><div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color.png)"></div><div><span style="font-size:18px;color:rgb(${rgb})">${gem}</span><br><span>Prismatic Gem</span></div></div>` }];
      }
      const records = Object.values(allItems);
      Ajax.Request = function(url, options) {
        const start = Number(options.parameters?.start || 0);
        fixtureRequests.push({ url, start });
        fixturePendingPages.push(() => {
          const items = records.slice(start, start + 12);
          const descriptions = Object.fromEntries(items.map(item => [`${item.classid}_0`, {
            name: item.name, market_hash_name: item.market_hash_name, icon_url: '', type: item.type,
            tradable: 1, marketable: 1, tags: item.tags, descriptions: item.descriptions
          }]));
          options.onComplete({ responseJSON: { success: true,
            rgInventory: Object.fromEntries(items.map(item => [item.id, item])), rgCurrency: {},
            rgDescriptions: descriptions, more: start + 12 < records.length,
            more_start: start + 12 } });
        });
      };
      // Use actual CUserThem.loadInventory -> RequestFullInventory -> native callback.
      window.fixturePendingInventory = owner.getInventory(570, '2');
      TradePageSelectInventory(UserThem, 570, '2');
    });
    assert.equal(await page.evaluate(() => fixturePendingInventory.BIsPendingInventory()), true);
    assert.equal((await editor()).active.loading, true);
    await page.evaluate(({ ownerSteamId }) => {
      postMessage({ source: 'SIH_LITE_TRADE_CONTENT', type: 'SORT', requestId: 'pending-native-sort',
        ownerSteamId, side: 'them', appId: '570', contextId: '2', order: 'desc',
        prices: { assetPrices: Object.values(fixtureMakeItems(3000, 35)).map(item => [item.id, item.pos + 1]), namePrices: [] } }, location.origin);
    }, { ownerSteamId: THEM });
    await page.waitForFunction(() => fixtureMessages.some(message => message.type === 'SORT_PROGRESS' && message.requestId === 'pending-native-sort'));
    assert.equal(await page.evaluate(() => fixtureMessages.find(message => message.type === 'SORT_PROGRESS' && message.requestId === 'pending-native-sort').ownerSteamId), THEM);
    for (const expectedStart of [0, 12, 24]) {
      assert.equal(await page.evaluate(() => fixtureRequests.at(-1).start), expectedStart);
      await page.evaluate(() => fixturePendingPages.shift()());
      if (expectedStart < 24) assert.equal(await page.evaluate(() => UserThem.GetContext(570, '2').inventory === fixturePendingInventory), true);
    }
    await page.evaluate(() => { fixtureInventories.them = UserThem.GetContext(570, '2').inventory; });
    await page.waitForFunction(() => fixtureMessages.some(message => message.type === 'SORT_RESULT' && message.requestId === 'pending-native-sort'));
    assert.equal(await page.evaluate(() => fixtureMessages.find(message => message.type === 'SORT_RESULT' && message.requestId === 'pending-native-sort').success), true);
    assert.equal(await page.evaluate(() => fixtureInventories.them.BIsPendingInventory()), false);
    assert.equal(await page.evaluate(() => fixtureInventories.them === fixturePendingInventory), false);
    const fullyLoaded = await editor();
    assert.equal(fullyLoaded.active.loading, false);
    assert.equal(fullyLoaded.inventories.find(inventory => inventory.side === 'them').items.length, 35);
    assert.equal((await sort('them', 'desc', 'fully-loaded-desc')).success, true);
    assert.deepEqual(await ids('them'), Array.from({ length: 35 }, (_, i) => String(3034 - i)));

    // Real native flattened descriptions: known and unknown sockets share the
    // same market hash. A name alias must never borrow the other color's price.
    await page.evaluate(({ ownerSteamId }) => {
      postMessage({ source: 'SIH_LITE_TRADE_CONTENT', type: 'SORT', requestId: 'safe-gem-sort',
        ownerSteamId, side: 'them', appId: '570', contextId: '2', order: 'desc', prices: {
          assetPrices: Object.values(fixtureInventories.them.rgInventory).filter(item => item.id !== '3001')
            .map(item => [item.id, item.id === '3000' ? 3000 : 100]),
          namePrices: [['shared wearable', 99999]] } }, location.origin);
    }, { ownerSteamId: THEM });
    await page.waitForFunction(() => fixtureMessages.some(message => message.type === 'SORT_RESULT' && message.requestId === 'safe-gem-sort'));
    assert.equal(await page.evaluate(() => fixtureMessages.find(message => message.type === 'SORT_RESULT' && message.requestId === 'safe-gem-sort').success), true);
    const gemSnapshot = (await editor()).inventories.find(inventory => inventory.side === 'them');
    assert.equal(gemSnapshot.items.find(item => item.assetId === '3000').hasGems, true);
    assert.equal(gemSnapshot.items.find(item => item.assetId === '3001').hasGems, true);
    assert.equal((await ids('them'))[0], '3000');
    assert.equal((await ids('them')).at(-1), '3001', 'Unpriced gem remains last despite a shared name price');

    // Run the actual isolated content UI against MAIN's real legacy objects.
    // Runtime replies are offline, owner-specific prices/profile fixtures.
    const cdp = await page.context().newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'SIH trade extension smoke world'
    });
    const isolated = async expression => {
      const evaluation = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
      if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text);
      return evaluation.result.value;
    };
    assert.equal(await isolated('typeof window.g_ActiveInventory'), 'undefined');
    const priceData = {
      [ME]: Array.from({ length: 40 }, (_, index) => ({ assetid: String(1000 + index),
        marketHashName: `Item ${index}`, priceCents: (index + 1) * 100 })),
      [THEM]: Array.from({ length: 35 }, (_, index) => ({ assetid: String(3000 + index),
        marketHashName: index < 2 ? 'Shared Wearable' : `Item ${index}`, priceCents: index === 0 ? 3000 : 200 + index,
        ...(index === 0 ? { prismaticGems: ['Bright Green'] } : {}) })).filter(item => item.assetid !== '3001')
    };
    await isolated(`window.fixtureRuntimeRequests = []; window.chrome = { runtime: {
      sendMessage(request, callback) {
        fixtureRuntimeRequests.push(request);
        const prices = ${JSON.stringify(priceData)};
        const totals = ${JSON.stringify({ [ME]: 12345, [THEM]: 54321 })};
        const data = request.action === 'fetchPrices' ? { items: prices[request.steamId] || [] }
          : { totalValueCents: totals[request.steamId] };
        setTimeout(() => callback({ success: true, data }), 0);
      }
    }}; window.fetch = () => { throw new Error('Trade smoke must not call a real endpoint.'); };`);
    for (const file of ['gems.js', 'trade-prices.js', 'trade-offers.js', 'trade-accept.js', 'trade-content.js']) {
      await isolated(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    }
    await page.locator('#sih-lite-trade-inventory-panel [data-role="inventory-me"]').filter({ hasText: '$123.45' }).waitFor();
    await page.locator('#sih-lite-trade-inventory-panel [data-role="inventory-them"]').filter({ hasText: '$543.21' }).waitFor();
    assert.equal(await page.evaluate(() => document.getElementById('sih-lite-trade-inventory-panel').parentNode.id), 'inventory_box');
    const runtimeRequests = await isolated('fixtureRuntimeRequests');
    assert.deepEqual(runtimeRequests.filter(request => request.action === 'fetchPrices').map(request => request.steamId).sort(), [ME, THEM]);
    for (const owner of [ME, THEM]) assert.ok(runtimeRequests.some(request => request.action === 'fetchProfile' && request.steamId === owner));
    assert.ok(runtimeRequests.every(request => ['fetchPrices', 'fetchProfile'].includes(request.action)), 'Editor smoke performs only pricing/profile reads');
    assert.equal(await page.locator('.item[data-sih-trade-asset="3000"] .sih-lite-trade-price').textContent(), '$30.00');
    assert.equal(await page.locator('.item[data-sih-trade-asset="3001"] .sih-lite-trade-price').count(), 0);
    await page.evaluate(() => fixtureInventories.them.rgInventory['3000'].element.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    await page.locator('#sih-lite-trade-editor-summary [data-role="receive"]').filter({ hasText: '$30.00' }).waitFor();
    assert.equal(await page.locator('#their_slots .item[data-sih-trade-asset="3000"] .sih-lite-trade-price').textContent(), '$30.00');
    await page.evaluate(() => fixtureInventories.them.rgInventory['3000'].element.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    await page.locator('#sih-lite-trade-editor-summary [data-role="receive"]').filter({ hasText: '$0.00' }).waitFor();
    await page.evaluate(() => TradePageSelectInventory(UserYou, 570, '2'));
    await page.locator('#sih-lite-trade-inventory-panel [data-role="active-inventory"]').filter({ hasText: 'Sort your inventory:' }).waitFor();
    await page.locator('#sih-lite-trade-inventory-panel [data-trade-order="desc"]').click();
    await page.locator('#sih-lite-trade-inventory-panel [data-role="inventory-status"]').filter({ hasText: 'Sorted 40 items.' }).waitFor();
    assert.deepEqual(await ids('me'), Array.from({ length: 40 }, (_, i) => String(1039 - i)));
    await page.locator('#sih-lite-trade-inventory-panel [data-trade-order="original"]').click();
    await page.locator('#sih-lite-trade-inventory-panel [data-role="inventory-status"]').filter({ hasText: 'Steam order restored.' }).waitFor();
    assert.deepEqual(await ids('me'), Array.from({ length: 40 }, (_, i) => String(1000 + i)));

    assert.deepEqual(errors, [], 'Official native scripts and the bridge raised no browser errors');
    console.log('PASS: official legacy Steam trade scripts: both owners, native pagination/filtering/sort restoration, preserved drag/double-click callbacks, offered-node identity, stack amounts, pending sort with complete more/start loading, safe gem pricing; real isolated UI owner prices/profile, native offer updates and sort buttons.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
