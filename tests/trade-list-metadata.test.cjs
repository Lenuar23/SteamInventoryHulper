const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const ME = '76561198000000001';
const PARTNER = '76561198000000002';
const HEAD = require('./fixtures/steam-inscribed-demon-eater-head.json');
const COLORED_TB = require('./fixtures/steam-inscribed-terrorblade-deep-blue.json');
const ROOT = path.join(__dirname, '..');
let browser;

before(async () => { browser = await chromium.launch({ executablePath: '/usr/lib/chromium/chromium', headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

function offerHtml(keys) {
  return `<div class="tradeoffer" id="tradeofferid_500"><div class="tradeoffer_items_ctn active">
    <div class="tradeoffer_items"><a class="tradeoffer_avatar" data-steamid="${ME}"></a>
      <div class="tradeoffer_item_list">${keys.map((key, index) => `<div id="native_${index}" class="trade_item" data-economy-item="${key}"></div>`).join('')}</div>
    </div><div class="tradeoffer_items"><a class="tradeoffer_avatar" data-steamid="${PARTNER}"></a>
      <div class="tradeoffer_item_list"></div></div>
    </div><div class="tradeoffer_footer_actions"><a onclick="CancelTradeOffer('500')">Native action</a></div></div>`;
}

function nativeAsset(assetId, description = HEAD, extra = {}) {
  return { ownerSteamId: ME, assetid: assetId, appid: 570, contextid: '2',
    classid: description.classid, instanceid: description.instanceid, description, ...extra };
}

async function snapshot(t, records, keys = records.map((_, index) => `570/2/${100 + index}/${ME}`), source = 'rgItem') {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('https://steamcommunity.com/**', route => route.fulfill({ contentType: 'text/html', body: offerHtml(keys) }));
  await page.goto(`https://steamcommunity.com/profiles/${ME}/tradeoffers/`);
  await page.evaluate(({ me, records, source }) => {
    window.g_steamID = me;
    window.g_sessionID = 'native-session-secret-that-must-not-cross-the-bridge';
    window.received = [];
    window.g_rgAssets = { '570': { '2': {} } };
    records.forEach((record, index) => {
      if (source === 'rgItem') document.getElementById(`native_${index}`).rgItem = record;
      else window.g_rgAssets['570']['2'][String(100 + index)] = record;
    });
    addEventListener('message', event => { if (event.data?.source === 'SIH_LITE_TRADE_PAGE') window.received.push(event.data); });
  }, { me: ME, records, source });
  for (const file of ['gems.js', 'trade-prices.js', 'trade-offers.js', 'trade-list-inject.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') });
  }
  await page.waitForFunction(() => received.some(message => message.type === 'OFFERS'));
  return page.evaluate(() => received.find(message => message.type === 'OFFERS'));
}

test('real native Inscribed Head assets emit compact market proof and eligibility without exposing descriptions or credentials', async t => {
  for (const source of ['rgItem', 'g_rgAssets']) {
    const result = await snapshot(t, [nativeAsset('100')], undefined, source);
    const item = result.offers[0].give[0];
    assert.equal(item.ownerSteamId, ME);
    assert.equal(item.appId, '570');
    assert.equal(item.contextId, '2');
    assert.equal(item.assetId, '100');
    assert.equal(item.market_hash_name, 'Inscribed Demon Eater - Head');
    assert.equal(item.tradable, true);
    assert.equal(item.marketable, true);
    assert.equal(item.hasGems, true, 'the real Head has an Inscribed statistic socket');
    assert.equal(item.hasColoredGem, undefined);
    assert.equal(item.marketFingerprint, '["steam-market-v1","inscribed demon eater - head","inscribed"]');
    const serialized = JSON.stringify(result);
    for (const forbidden of ['native-session-secret', '<div', 'descriptions', 'gem_stat.', 'Gift From:']) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} stays in the native page`);
    }
  }
});

test('colored Terrorblade and untradable Candyworks copies never emit ordinary market proof', async t => {
  const candy = { ...HEAD, tradable: 0, marketable: 0 };
  const contradictory = nativeAsset('102', HEAD, { tradable: false, marketable: false });
  const unknownFlag = nativeAsset('103', HEAD, { tradable: '1' });
  const result = await snapshot(t, [nativeAsset('100', COLORED_TB), nativeAsset('101', candy), contradictory, unknownFlag]);
  const [colored, unavailable, conflict, unknown] = result.offers[0].give;
  assert.equal(colored.hasColoredGem, true);
  assert.equal(colored.marketFingerprint, undefined);
  assert.equal(unavailable.tradable, false);
  assert.equal(unavailable.marketable, false);
  assert.equal(unavailable.marketFingerprint, undefined);
  assert.equal(conflict.tradable, false);
  assert.equal(conflict.marketable, false);
  assert.equal(conflict.marketFingerprint, undefined);
  assert.equal(unknown.marketFingerprint, undefined);
});

test('mismatched native owner, asset, app, context, class or instance cannot borrow names, flags or proof', async t => {
  const wrongRecords = [
    nativeAsset('100', HEAD, { ownerSteamId: PARTNER }),
    nativeAsset('999'),
    nativeAsset('102', HEAD, { appid: 440 }),
    nativeAsset('103', HEAD, { contextid: '3' }),
    nativeAsset('104', HEAD, { classid: '99999' }),
    nativeAsset('105', HEAD, { instanceid: '0' }),
    nativeAsset('106', { ...HEAD, ownerSteamId: PARTNER })
  ];
  const result = await snapshot(t, wrongRecords);
  for (const [index, item] of result.offers[0].give.entries()) {
    assert.equal(item.ownerSteamId, ME);
    assert.equal(item.assetId, String(100 + index));
    assert.equal(item.market_hash_name, '');
    assert.equal(item.tradable, undefined);
    assert.equal(item.marketable, undefined);
    assert.equal(item.hasGems, undefined);
    assert.equal(item.marketFingerprint, undefined);
  }
});

test('class-only native metadata proves its exact class and instance without creating an asset ID', async t => {
  const valid = { description: HEAD };
  const mismatch = { description: { ...HEAD, classid: '99999' } };
  const keys = [`classinfo/570/${HEAD.classid}/${HEAD.instanceid}`, `classinfo/570/${HEAD.classid}/${HEAD.instanceid}`];
  const result = await snapshot(t, [valid, mismatch], keys);
  const [known, unknown] = result.offers[0].give;
  assert.equal(known.assetId, null);
  assert.equal(known.classId, HEAD.classid);
  assert.equal(known.instanceId, HEAD.instanceid);
  assert.equal(known.tradable, true);
  assert.equal(known.marketable, true);
  assert.equal(known.marketFingerprint, '["steam-market-v1","inscribed demon eater - head","inscribed"]');
  assert.equal(unknown.assetId, null);
  assert.equal(unknown.market_hash_name, '');
  assert.equal(unknown.marketFingerprint, undefined);
});
