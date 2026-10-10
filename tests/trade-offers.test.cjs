const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const Offers = require('../trade-offers.js');

const ME = '76561198000000001';
const PARTNER = '76561198000000002';
const meAccount = String(BigInt(ME) - 76561197960265728n);
const partnerAccount = String(BigInt(PARTNER) - 76561197960265728n);
const source = fs.readFileSync(path.join(__dirname, '../trade-offers.js'), 'utf8');
let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: '/usr/lib/chromium/chromium', headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });

function fixture({ incoming = true, historical = false, classOnly = false } = {}) {
  const first = incoming ? partnerAccount : meAccount;
  const second = incoming ? meAccount : partnerAccount;
  const firstOwner = incoming ? PARTNER : ME;
  const secondOwner = incoming ? ME : PARTNER;
  const firstKey = classOnly ? 'classinfo/570/700/0' : `570/2/100/${firstOwner}/a:2`;
  const secondKey = classOnly ? 'classinfo/570/701/0' : `570/2/101/${secondOwner}`;
  return `<div class="tradeoffer" id="tradeofferid_500">
    <a class="tradeoffer_partner" data-miniprofile="${partnerAccount}"></a>
    <div class="tradeoffer_items_ctn ${historical ? 'inactive' : 'active'}">
      <div class="tradeoffer_items primary"><a class="tradeoffer_avatar" data-miniprofile="${first}"></a>
        <div class="tradeoffer_item_list"><div class="trade_item" data-economy-item="${firstKey}"></div></div></div>
      <div class="tradeoffer_items secondary"><a class="tradeoffer_avatar" data-miniprofile="${second}"></a>
        <div class="tradeoffer_item_list"><div class="trade_item" data-economy-item="${secondKey}"></div></div></div>
      ${historical ? '<div class="tradeoffer_items_banner">Historical status</div>' : ''}
    </div><div class="tradeoffer_footer_actions"><a onclick="${incoming ? 'Decline' : 'Cancel'}TradeOffer('500')">Native action</a></div>
  </div>`;
}

async function inDocument(html, operation, data = {}) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.addScriptTag({ content: source });
    return await page.evaluate(operation, { me: ME, partner: PARTNER, ...data });
  } finally { await page.close(); }
}

test('real-asset hover keys preserve owner and amount; classinfo never becomes an asset ID', () => {
  assert.deepEqual(Offers.parseEconomyKey(`570/2/123/${ME}/a:4`), { appId: '570', contextId: '2', assetId: '123', amount: 4, ownerSteamId: ME });
  assert.deepEqual(Offers.parseEconomyKey('classinfo/570/123/0/a:2'), { appId: '570', contextId: null, assetId: null, classId: '123', instanceId: '0', amount: 2, ownerSteamId: null });
  assert.equal(Offers.parseEconomyKey('570/2/123/garbage'), null);
  assert.equal(Offers.parseEconomyKey(`570/2/123/${ME}/a:0`), null);
  assert.equal(Offers.parseEconomyKey('classinfo/570/123/not-a-number'), null);
  assert.equal(Offers.normalizeItem({ appid: 570, id: '123', classid: '123' }, ME).assetId, null);
});

test('incoming offers use avatar owners, so the primary partner items are received', async () => {
  const result = await inDocument(fixture(), ({ me }) => {
    const [offer] = SIHLiteTradeOffers.read(document, { meSteamId: me });
    return { incoming: offer.incoming, canAccept: offer.canAccept, give: offer.give, receive: offer.receive, sides: offer.slots.map(slot => slot.side) };
  });
  assert.equal(result.incoming, true);
  assert.equal(result.canAccept, true);
  assert.equal(result.give[0].assetId, '101');
  assert.equal(result.give[0].ownerSteamId, ME);
  assert.equal(result.receive[0].assetId, '100');
  assert.equal(result.receive[0].amount, 2);
  assert.deepEqual(result.sides, ['receive', 'give']);
});

test('outgoing and historical offers cannot be fast accepted', async () => {
  for (const options of [{ incoming: false }, { historical: true }, { incoming: false, historical: true }]) {
    const result = await inDocument(fixture(options), ({ me }) => {
      const [offer] = SIHLiteTradeOffers.read(document, { meSteamId: me });
      return { incoming: offer.incoming, canAccept: offer.canAccept, give: offer.give[0].assetId };
    });
    assert.equal(result.canAccept, false);
    assert.equal(result.incoming, options.incoming !== false);
    assert.equal(result.give, options.incoming === false ? '100' : '101');
  }
});

test('explicit hover ownership mismatches are retained as unpriced slots', async () => {
  const result = await inDocument(fixture().replace(`570/2/100/${PARTNER}`, `570/2/100/${ME}`), ({ me }) => {
    const [offer] = SIHLiteTradeOffers.read(document, { meSteamId: me });
    return { slots: offer.slots.length, received: offer.receive[0] };
  });
  assert.equal(result.slots, 2);
  assert.equal(result.received.assetId, null);
  assert.equal(result.received.ownerSteamId, PARTNER);
});

test('nested avatar profile metadata works without English labels', async () => {
  const html = fixture().replaceAll(/<a class="tradeoffer_avatar" data-miniprofile="(\d+)"><\/a>/g,
    '<div class="tradeoffer_avatar"><a data-miniprofile="$1" href="https://steamcommunity.com/id/localized-user/">Name</a></div>');
  const result = await inDocument(html, ({ me }) => SIHLiteTradeOffers.read(document, { meSteamId: me }).map(offer => ({ partner: offer.partnerSteamId, accept: offer.canAccept })));
  assert.deepEqual(result, [{ partner: PARTNER, accept: true }]);
});

test('class-only cards hydrate exact assets only for the same owner, partner, classes and amounts', async () => {
  const details = { offerId: '500', meSteamId: ME, partnerSteamId: PARTNER,
    give: [{ appid: 570, contextid: '2', assetid: '900', classid: '701', instanceid: '0', amount: '1' }],
    receive: [{ appid: 570, contextid: '2', assetid: '901', classid: '700', instanceid: '0', amount: '1' }] };
  const result = await inDocument(fixture({ classOnly: true }), ({ me, details }) => {
    const [offer] = SIHLiteTradeOffers.read(document, { meSteamId: me }, { '500': details });
    return { give: offer.slots.find(slot => slot.side === 'give').item.assetId, receive: offer.slots.find(slot => slot.side === 'receive').item.assetId };
  }, { details });
  assert.deepEqual(result, { give: '900', receive: '901' });
  for (const changed of [ { ...details, partnerSteamId: ME }, { ...details, meSteamId: PARTNER },
    { ...details, give: [{ ...details.give[0], classid: '999' }] },
    { ...details, give: [{ ...details.give[0], amount: 2 }] },
    { ...details, give: [] } ]) {
    const value = await inDocument(fixture({ classOnly: true }), ({ me, details }) => SIHLiteTradeOffers.read(document, { meSteamId: me }, { '500': details })[0].slots.find(slot => slot.side === 'give').item.assetId, { details: changed });
    assert.equal(value, null);
  }
});

test('class-only badges match class and instance identity when the native asset array is reordered', async () => {
  const html = fixture({ classOnly: true }).replace('data-economy-item="classinfo/570/700/0"></div>',
    'data-economy-item="classinfo/570/700/0"></div><div class="trade_item" data-economy-item="classinfo/570/800/99"></div>');
  const details = { offerId: '500', meSteamId: ME, partnerSteamId: PARTNER,
    give: [{ appid: 570, contextid: '2', assetid: '900', classid: '701', instanceid: '0', amount: '1' }],
    receive: [{ appid: 570, contextid: '2', assetid: '902', classid: '800', instanceid: '99', amount: '1' }, { appid: 570, contextid: '2', assetid: '901', classid: '700', instanceid: '0', amount: '1' }] };
  const result = await inDocument(html, ({ me, details }) => SIHLiteTradeOffers.read(document, { meSteamId: me }, { '500': details })[0].slots.filter(slot => slot.side === 'receive').map(slot => slot.item.assetId), { details });
  assert.deepEqual(result, ['901', '902']);
});

function detailsHtml({ owner = ME, offerId = '500', partner = PARTNER, status } = {}) {
  const trade = status || { me: { assets: [{ appid: 570, contextid: '2', assetid: '900', amount: '1' }] }, them: { assets: [{ appid: 570, contextid: '2', assetid: '901', amount: '2' }] }, note: 'JSON braces } and escaped "quotes"' };
  return `<script>var g_steamID = "${owner}"; var g_ulTradePartnerSteamID = '${partner}'; var g_rgCurrentTradeStatus = ${JSON.stringify(trade)}; BeginTradeOffer( '${offerId}', false );</script>`;
}

test('detail parsing reads safe native JSON and validates the signed-in owner and exact offer', () => {
  const details = Offers.parseDetails(detailsHtml(), '500', ME);
  assert.equal(details.offerId, '500');
  assert.equal(details.give[0].assetId, '900');
  assert.equal(details.receive[0].amount, 2);
  assert.equal(details.receive[0].ownerSteamId, PARTNER);
  assert.throws(() => Offers.parseDetails(detailsHtml({ owner: PARTNER }), '500', ME));
  assert.throws(() => Offers.parseDetails(detailsHtml({ offerId: '501' }), '500', ME));
  assert.throws(() => Offers.parseDetails('<html>Sign in</html>', '500', ME));
  assert.throws(() => Offers.parseDetails(detailsHtml({ status: { me: { assets: [{ appid: 570, classid: '123' }] }, them: { assets: [] } } }), '500', ME));
  assert.throws(() => Offers.parseDetails(detailsHtml().replace('"assets":', '"assets":globalThis.evil(),'), '500', ME));
});

test('native UserYou and UserThem bootstrap IDs validate the account without a global header identity', () => {
  const html = detailsHtml().replace(`var g_steamID = "${ME}";`, `var g_rgAppContextData = {}; UserYou.SetSteamId( '${ME}' );`)
    .replace(`var g_ulTradePartnerSteamID = '${PARTNER}';`, `UserThem.SetSteamId( "${PARTNER}" );`);
  const parsed = Offers.parseDetails(html, '500', ME);
  assert.equal(parsed.meSteamId, ME);
  assert.equal(parsed.partnerSteamId, PARTNER);
  assert.equal(parsed.give[0].assetId, '900');
  assert.throws(() => Offers.parseDetails(html, '500', PARTNER), /Steam account changed/);
  assert.throws(() => Offers.parseDetails(html.replace('var g_rgAppContextData = {};', `var g_rgAppContextData = {}; var g_steamID = "${PARTNER}";`), '500', ME), /inconsistent account/);
});

test('escaped JSON trade status and an assigned offer ID are parsed without executing JavaScript', () => {
  const status = { me: { assets: [{ appid: 570, contextid: '2', assetid: '900', amount: '1' }] }, them: { assets: [] }, note: 'Braces } escaped "quote" and backslash \\' };
  const html = `<script>var g_steamID = "${ME}"; var g_ulTradePartnerSteamID = "${PARTNER}";
    var g_rgCurrentTradeStatus = JSON.parse(${JSON.stringify(JSON.stringify(status))});
    var g_nTradeOfferId = '500'; BeginTradeOffer(g_nTradeOfferId, false);
  </script>`;
  const parsed = Offers.parseDetails(html, '500', ME);
  assert.equal(parsed.give[0].assetId, '900');
  assert.deepEqual(parsed.receive, []);
  assert.throws(() => Offers.parseDetails(html.replace('JSON.parse(', 'malicious.parse('), '500', ME));
  assert.throws(() => Offers.parseDetails(html.replace("var g_nTradeOfferId = '500'", "var g_nTradeOfferId = '501'"), '500', ME));
});

test('plain HTML text cannot impersonate native Steam account initialization', () => {
  const html = detailsHtml({ owner: PARTNER }).replace(`<script>var g_steamID = "${PARTNER}";`, `<div>g_steamID = "${ME}";</div><script>var g_steamID = "${PARTNER}";`);
  assert.throws(() => Offers.parseDetails(html, '500', ME), /Steam account changed/);
  const maliciousText = `<script>var note = ${JSON.stringify(`UserYou.SetSteamId('${ME}'); g_steamID = '${ME}';`)};
    /* UserYou.SetSteamId('${ME}'); */
  </script>`;
  assert.throws(() => Offers.parseDetails(maliciousText + detailsHtml({ owner: PARTNER }), '500', ME), /Steam account changed/);
});

test('a verified final offer URL replaces a missing BeginTradeOffer ID while owner and partner remain required', () => {
  const html = detailsHtml().replace("BeginTradeOffer( '500', false );", '');
  assert.equal(Offers.parseDetails(html, '500', ME, 'https://steamcommunity.com/tradeoffer/500/?partner=39734274').offerId, '500');
  assert.throws(() => Offers.parseDetails(html, '500', ME));
  assert.throws(() => Offers.parseDetails(html.replace(`var g_steamID = "${ME}";`, ''), '500', ME, 'https://steamcommunity.com/tradeoffer/500/'));
  assert.throws(() => Offers.parseDetails(html.replace(`var g_ulTradePartnerSteamID = '${PARTNER}';`, ''), '500', ME, 'https://steamcommunity.com/tradeoffer/500/'));
  assert.throws(() => Offers.parseDetails(detailsHtml({ offerId: '501' }), '500', ME, 'https://steamcommunity.com/tradeoffer/500/'), /different trade offer/);
  assert.throws(() => Offers.parseDetails(html, '500', ME, 'https://steamcommunity.com/tradeoffer/501/'), /different page/);
  assert.throws(() => Offers.parseDetails(html, '500', ME, 'https://steamcommunity.com/login/home/'), /Sign in to Steam/);
  assert.throws(() => Offers.parseDetails(html, '500', ME, 'https://attacker.invalid/tradeoffer/500/'), /different page/);
});

test('fetching uses the final response URL without weakening the signed-in owner check', async () => {
  const owner = '76561198000000009';
  const partner = '76561198000000010';
  const html = detailsHtml({ owner, partner }).replace("BeginTradeOffer( '500', false );", '');
  const result = await Offers.fetchDetails('500', owner, async () => ({ ok: true,
    url: 'https://steamcommunity.com/tradeoffer/500/', text: async () => html,
    json: async () => ({ success: 1, assets: [], descriptions: [] }) }));
  assert.equal(result.give[0].assetId, '900');
  await assert.rejects(Offers.fetchDetails('500', owner, async () => ({ ok: true, url: 'https://steamcommunity.com/login/home/', text: async () => '<html>Sign in</html>' })), /Sign in to Steam/);
});

function classHoverHtml({ appId = '570', classId = '82001', instanceId = '0', name = 'Ordinary item', descriptions = [] } = {}) {
  return `<script>var ignored = true; BuildHover( 'economy_item_random', ${JSON.stringify({ appid: appId, classid: classId, instanceid: instanceId, market_hash_name: name, descriptions })} );</script>`;
}

test('native BuildHover metadata supplies only verified class names and gem flags', async () => {
  const gemHtml = '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color.png)"><span style="color:rgb(61,104,196)">Deep Blue</span><br><span>Prismatic Gem</span></div>';
  const parsed = Offers.parseClassDescription(classHoverHtml(), '570', '82001', '0');
  assert.equal(parsed.market_hash_name, 'Ordinary item');
  assert.throws(() => Offers.parseClassDescription(classHoverHtml({ classId: '82002' }), '570', '82001', '0'));
  const offer = { offerId: '500', meSteamId: ME, partnerSteamId: PARTNER,
    give: [{ ownerSteamId: ME, appId: '570', classId: '82001', instanceId: '0', assetId: null, amount: 1 }],
    receive: [{ ownerSteamId: PARTNER, appId: '570', classId: '82002', instanceId: '7', assetId: null, amount: 1 }] };
  const data = await Offers.fetchClassDescriptions(offer, ME, async href => {
    assert.match(href, /^https:\/\/steamcommunity\.com\/economy\/itemclasshover\/570\//);
    const isGem = href.includes('/82002/7?');
    return { ok: true, text: async () => classHoverHtml({ classId: isGem ? '82002' : '82001', instanceId: isGem ? '7' : '0', name: isGem ? 'Fractal Horns of Inner Abysm' : 'Ordinary item', descriptions: isGem ? [{ type: 'html', value: gemHtml }] : [] }) };
  });
  assert.equal(data.classItems.length, 2);
  assert.equal(data.classItems.find(item => item.ownerSteamId === PARTNER).hasColoredGem, true);
  assert.equal(data.classItems.find(item => item.ownerSteamId === ME).hasGems, false);
  assert.ok(data.classItems.every(item => !Object.hasOwn(item, 'assetId')));
  await assert.rejects(Offers.fetchClassDescriptions(offer, PARTNER), /Invalid trade offer/);
});

test('class hover names attach to exact native classes and preserve unknown asset identities', async () => {
  const classData = { offerId: '500', meSteamId: ME, partnerSteamId: PARTNER, classItems: [
    { ownerSteamId: ME, appId: '570', classId: '701', instanceId: '0', market_hash_name: 'Ordinary item', hasGems: false },
    { ownerSteamId: PARTNER, appId: '570', classId: '700', instanceId: '0', market_hash_name: 'Fractal Horns of Inner Abysm', hasGems: true, hasColoredGem: true }
  ] };
  const result = await inDocument(fixture({ classOnly: true }), ({ me, classData }) => {
    const [offer] = SIHLiteTradeOffers.read(document, { meSteamId: me }, { '500': classData });
    return { give: offer.give, receive: offer.receive, slots: offer.slots.map(slot => slot.item) };
  }, { classData });
  assert.equal(result.give[0].market_hash_name, 'Ordinary item');
  assert.equal(Object.hasOwn(result.give[0], 'contextId'), false);
  assert.equal(result.receive[0].hasColoredGem, true);
  assert.equal(result.receive[0].assetId, null);
  assert.equal(result.slots[0].market_hash_name, 'Fractal Horns of Inner Abysm');
});

test('detail fetching makes only an authenticated GET and reports HTTP failures', async () => {
  const requests = [];
  const result = await Offers.fetchDetails('500', ME, async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://steamcommunity.com/tradeoffer/500/') return { ok: true, text: async () => detailsHtml() };
    const owner = url.includes(ME) ? ME : PARTNER;
    return { ok: true, json: async () => ({ success: 1, assets: [{ appid: 570, contextid: '2', assetid: owner === ME ? '900' : '901', classid: owner === ME ? '701' : '700', instanceid: '42' }], descriptions: [], more_items: false }) };
  });
  assert.equal(result.give.length, 1);
  assert.equal(requests[0].url, 'https://steamcommunity.com/tradeoffer/500/');
  assert.equal(result.give[0].classId, '701');
  assert.equal(result.give[0].instanceId, '42');
  assert.ok(requests.every(request => request.options.credentials === 'include' && request.options.method === undefined));
  await assert.rejects(Offers.fetchDetails('500', ME, async () => ({ ok: false, status: 429 })), /HTTP 429/);
});

test('native authenticated inventory pagination resolves offered classes and keeps session values out of results', async () => {
  const owner = '76561198000000003';
  const partner = '76561198000000004';
  const html = detailsHtml({ owner, partner }) + `<script>
    var g_sessionID = "localsessionfixture";
    var g_strInventoryLoadURL = "https://steamcommunity.com/profiles/${owner}/inventory/json/";
    var g_strTradePartnerInventoryLoadURL = "https://steamcommunity.com/tradeoffer/500/partnerinventory/";
  </script>`;
  const requests = [];
  const details = await Offers.fetchDetails('500', owner, async (href, options) => {
    requests.push(href);
    assert.equal(options.credentials, 'include');
    if (href === 'https://steamcommunity.com/tradeoffer/500/') return { ok: true, text: async () => html };
    const url = new URL(href);
    if (url.pathname.includes('/profiles/')) {
      assert.equal(url.pathname, `/profiles/${owner}/inventory/json/570/2/`);
      if (!url.searchParams.has('start')) return { ok: true, json: async () => ({ success: true, rgInventory: { '999': { id: '999', classid: '710', instanceid: '8', amount: '1' } }, rgDescriptions: {}, more: true, more_start: '500' }) };
      assert.equal(url.searchParams.get('start'), '500');
      return { ok: true, json: async () => ({ success: true, rgInventory: { '900': { id: '900', classid: '711', instanceid: '91', amount: '99' } }, rgDescriptions: { '711_91': { market_hash_name: 'Golden Baby Roshan' } }, more: false }) };
    }
    assert.equal(url.pathname, '/tradeoffer/500/partnerinventory/');
    assert.equal(url.searchParams.get('partner'), partner);
    assert.equal(url.searchParams.get('sessionid'), 'localsessionfixture');
    return { ok: true, json: async () => ({ success: true, rgInventory: { '901': { id: '901', classid: '712', instanceid: '92', amount: '99' } }, rgDescriptions: { '712_92': { market_hash_name: 'Fractal Horns of Inner Abysm' } }, more: false }) };
  });
  assert.equal(requests.length, 4);
  assert.equal(details.give[0].classId, '711');
  assert.equal(details.receive[0].instanceId, '92');
  assert.equal(details.give[0].amount, 1);
  assert.equal(details.receive[0].amount, 2);
  assert.equal(details.receive[0].market_hash_name, 'Fractal Horns of Inner Abysm');
  assert.equal(JSON.stringify(details).includes('localsessionfixture'), false);
});

test('overlapping offer requests reuse owner-specific class inventory loads', async () => {
  const owner = '76561198000000007';
  const partner = '76561198000000008';
  let inventoryRequests = 0;
  const fetchMock = async href => {
    const offer = href.match(/\/tradeoffer\/(\d+)\/$/)?.[1];
    if (offer) return { ok: true, text: async () => detailsHtml({ owner, partner, offerId: offer }) };
    inventoryRequests++;
    const isOwn = href.includes(owner);
    return { ok: true, json: async () => ({ success: 1, assets: [{ appid: 570, contextid: '2', assetid: isOwn ? '900' : '901', classid: isOwn ? '701' : '700', instanceid: '99' }], more_items: false }) };
  };
  const results = await Promise.all([Offers.fetchDetails('600', owner, fetchMock), Offers.fetchDetails('601', owner, fetchMock)]);
  assert.equal(inventoryRequests, 2);
  assert.ok(results.every(result => result.give[0].classId === '701' && result.receive[0].instanceId === '99'));
});

test('native offer currencies stay unpriced and cannot collide with asset IDs', () => {
  const status = { me: { assets: [], currency: [{ appid: 570, contextid: '2', currencyid: '900', amount: '10' }] }, them: { assets: [] } };
  const parsed = Offers.parseDetails(detailsHtml({ status }), '500', ME);
  assert.equal(parsed.give.length, 1);
  assert.equal(parsed.give[0].isCurrency, true);
  assert.equal(parsed.give[0].assetId, null);
  assert.equal(parsed.give[0].currencyId, '900');
});

test('unavailable class descriptions preserve exact totals but never assign a class-only badge by position', async () => {
  const owner = '76561198000000005';
  const partner = '76561198000000006';
  const details = await Offers.fetchDetails('500', owner, async url => url.endsWith('/tradeoffer/500/')
    ? { ok: true, text: async () => detailsHtml({ owner, partner }) }
    : { ok: false, status: 403 });
  assert.equal(details.give[0].assetId, '900');
  assert.equal(details.give[0].instanceId, undefined);
  assert.ok(details.classError);
  const raw = { offerId: '500', meSteamId: ME, partnerSteamId: PARTNER, give: [{ appid: 570, contextid: '2', assetid: '900', amount: 1 }], receive: [{ appid: 570, contextid: '2', assetid: '901', amount: 1 }] };
  const result = await inDocument(fixture({ classOnly: true }), ({ me, raw }) => {
    const [offer] = SIHLiteTradeOffers.read(document, { meSteamId: me }, { '500': raw });
    return { totalAssets: offer.give.map(item => item.assetId), badge: offer.slots.find(slot => slot.side === 'give').item.assetId };
  }, { raw });
  assert.deepEqual(result.totalAssets, ['900']);
  assert.equal(result.badge, null);
});

test('MAIN offer bridge publishes canonical metadata and never publishes session credentials', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://steamcommunity.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture() }));
    await page.goto('https://steamcommunity.com/profiles/' + ME + '/tradeoffers/');
    await page.evaluate(({ me }) => {
      window.g_steamID = me;
      window.g_sessionID = 'test-session-secret';
      window.g_rgAssets = { '570': { '2': { '101': { assetid: '101', market_hash_name: 'Fractal Horns of Inner Abysm' } } } };
      window.received = [];
      addEventListener('message', event => { if (event.data?.source === 'SIH_LITE_TRADE_PAGE') received.push(event.data); });
    }, { me: ME });
    await page.addScriptTag({ content: source });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../trade-list-inject.js'), 'utf8') });
    await page.waitForFunction(() => received.length > 0);
    const snapshot = await page.evaluate(() => received[0]);
    assert.equal(snapshot.type, 'OFFERS');
    assert.equal(snapshot.meSteamId, ME);
    assert.equal(snapshot.offers[0].give[0].market_hash_name, 'Fractal Horns of Inner Abysm');
    assert.equal(JSON.stringify(snapshot).includes('test-session-secret'), false);
    assert.equal(await page.locator('.trade_item').first().getAttribute('data-sih-trade-key'), '500:receive:0');
  } finally { await page.close(); }
});
