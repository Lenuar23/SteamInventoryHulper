const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildIndex, getPrice, summarize, difference, variantFingerprint } = require('../trade-prices.js');

const OWNER = '76561198012345678';
const PARTNER = '76561198087654321';
const item = (assetId, market_hash_name, overrides = {}) => ({ ownerSteamId: OWNER, assetId, appId: '570', market_hash_name, ...overrides });

test('asset keys include the owner and prevent collisions between both inventories', () => {
    const index = buildIndex([
        { ownerSteamId: OWNER, assetid: '100', marketHashName: 'Sword', priceCents: 250 },
        { ownerSteamId: PARTNER, assetid: '100', marketHashName: 'Sword', priceCents: 900 }
    ]);
    assert.deepEqual(getPrice(index, item('100', 'Sword')), { cents: 250, source: 'asset' });
    assert.deepEqual(getPrice(index, item('100', 'Sword', { ownerSteamId: PARTNER })), { cents: 900, source: 'asset' });
    assert.equal(getPrice(index, item('100', 'Sword', { ownerSteamId: undefined })).cents, null);
    const onlyOwner = buildIndex([{ assetid: '100', marketHashName: 'Sword', priceCents: 250 }], OWNER);
    assert.equal(getPrice(onlyOwner, item('100', 'Sword', { ownerSteamId: PARTNER })).cents, null);
});

test('zero, string cents, collector priority and generic dollars retain per-unit semantics', () => {
    const index = buildIndex([
        { assetid: '100', collectorAvgSaleCents: '0', collectorLowestAskCents: 123, priceCents: 999 },
        { assetid: '101', collectorLowestAskCents: '275', price: 999 },
        { assetid: '102', price: '$2.50' },
        { assetid: '103', value: '1,25' },
        { assetid: '104', priceCents: true, price: '-$4.00' },
        { assetid: '105', priceCents: ' ', price: 'invalid' }
    ], OWNER);
    assert.equal(getPrice(index, item('100', '')).cents, 0);
    assert.equal(getPrice(index, item('101', '')).cents, 275);
    assert.equal(getPrice(index, item('102', '')).cents, 250);
    assert.equal(getPrice(index, item('103', '')).cents, 125);
    assert.equal(getPrice(index, item('104', '')).cents, null);
    assert.equal(getPrice(index, item('105', '')).cents, null);
});

test('ordinary canonical exact and cleaned aliases work without using renamed display names', () => {
    const index = buildIndex([{ assetid: '100', marketHashName: 'Genuine Sword Set', priceCents: 250 }], OWNER);
    assert.deepEqual(getPrice(index, item('999', 'Genuine Sword Set')), { cents: 250, source: 'name' });
    assert.deepEqual(getPrice(index, item('999', 'Sword')), { cents: 250, source: 'clean-name' });
    assert.deepEqual(getPrice(index, item('999', undefined, { description: { market_hash_name: 'Genuine Sword Set', name: 'Custom name' } })),
        { cents: 250, source: 'name' });
    assert.equal(getPrice(index, item('999', undefined, { name: 'Genuine Sword Set' })).cents, null);
    assert.equal(getPrice(index, item('999', 'Unrelated Hat', { name: 'Genuine Sword Set' })).cents, null);
});

test('conflicting aliases or duplicate asset prices remain unknown instead of choosing pagination order', () => {
    const index = buildIndex([
        { assetid: '100', marketHashName: 'Genuine Sword', priceCents: 250 },
        { assetid: '101', marketHashName: 'Sword', priceCents: 100 },
        { assetid: '102', marketHashName: 'Hat', priceCents: 100 },
        { assetid: '103', marketHashName: 'Hat', priceCents: 200 },
        { assetid: '104', marketHashName: 'Duplicate', priceCents: 10 },
        { assetid: '104', marketHashName: 'Duplicate', priceCents: 20 }
    ], OWNER);
    assert.equal(getPrice(index, item('999', 'Cursed Sword')).cents, null);
    assert.equal(getPrice(index, item('999', 'Hat')).cents, null);
    assert.equal(getPrice(index, item('104', 'Duplicate')).cents, null);
    assert.equal(getPrice(index, item('100', 'Genuine Sword')).cents, 250);
});

test('gem-bearing items require their own asset price and cannot fall back to a base name', () => {
    const index = buildIndex([
        { assetid: '100', marketHashName: 'Sword', priceCents: 50 },
        { assetid: '101', marketHashName: 'Sword', priceCents: 5000, kineticGems: ['Fireborn Assault'] },
        { assetid: '102', marketHashName: 'Fractal Horns of Inner Abysm', priceCents: 10000, prismaticGems: ['Deep Blue'] }
    ], OWNER);
    assert.equal(getPrice(index, item('101', 'Sword', { hasGems: true })).cents, 5000);
    assert.equal(getPrice(index, item('999', 'Sword', { hasGems: true })).cents, null);
    assert.equal(getPrice(index, item('999', 'Sword', { kineticGems: [{ name: 'Fireborn Assault' }] })).cents, null);
    assert.equal(getPrice(index, item('999', 'Sword')).cents, 50, 'a gem-bearing record cannot poison the ordinary name index');
    for (const name of ['Fractal Horns of Inner Abysm', 'Unusual Baby Roshan', 'Platinum Baby Roshan', 'Jumo', 'Inscribed Sword', 'Autographed Sword']) {
        const modelIndex = buildIndex([{ assetid: '100', marketHashName: name, priceCents: 100 }], OWNER);
        assert.equal(getPrice(modelIndex, item('999', name)).cents, null, name);
        assert.equal(getPrice(modelIndex, item('100', name)).cents, 100, 'exact owner asset price remains valid');
    }
});

test('native installed socket HTML blocks unsafe base-price fallback', () => {
    const index = buildIndex([{ assetid: '100', marketHashName: 'Sword', priceCents: 50 }], OWNER);
    const offerItem = item('999', 'Sword', { description: { market_hash_name: 'Sword', type: 'Rare Wearable', descriptions: [{ type: 'html',
        value: '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_kinetic.hash.png)"></div><span>Fireborn Assault</span><br><span>Кинетический самоцвет</span>' }] } });
    assert.equal(getPrice(index, offerItem).cents, null);
});

test('stack quantities multiply price while summary counts remain offered item slots', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }, { assetid: '101', priceCents: 0 }], OWNER);
    assert.deepEqual(summarize([item('100', '', { amount: '3' }), item('101', '', { amount: 100 })], index),
        { knownCents: 750, itemCount: 2, pricedCount: 2, unpricedCount: 0, nonDotaCount: 0, estimatedCount: 0, complete: true });
    assert.equal(getPrice(index, item('100', '', { amount: 3 })).cents, 250, 'lookup returns a unit price');
    assert.equal(summarize([item('100', '')], index).knownCents, 250, 'missing amount defaults to one slot');
});

test('unknown prices and non-Dota items produce a partial known total', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }], OWNER);
    assert.deepEqual(summarize([
        item('100', '', { amount: 2 }), item('999', 'Unknown'), item('100', '', { appId: 730, amount: 5 })
    ], index), { knownCents: 500, itemCount: 3, pricedCount: 1, unpricedCount: 2, nonDotaCount: 1, estimatedCount: 0, complete: false });
    assert.deepEqual(getPrice(index, item('100', '', { appId: 730 })), { cents: null, source: 'non-dota' });
    assert.equal(getPrice(index, item('100', '', { appId: undefined })).cents, null, 'missing application cannot claim a Dota valuation');
});

test('offered currency identifiers cannot collide with priced assets and always keep the valuation partial', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }], OWNER);
    const currency = item('100', '', { isCurrency: true, currencyId: '100', amount: 3 });
    assert.deepEqual(getPrice(index, currency), { cents: null, source: 'unknown' });
    assert.equal(getPrice(index, item('100', '', { is_currency: true })).cents, null);
    assert.deepEqual(summarize([item('100', ''), currency], index),
        { knownCents: 250, itemCount: 2, pricedCount: 1, unpricedCount: 1, nonDotaCount: 0, estimatedCount: 0, complete: false });
    assert.deepEqual(getPrice(index, { ...currency, appId: '730' }), { cents: null, source: 'non-dota' });
});

test('explicit Dota contexts other than 2 cannot borrow context 2 asset or name prices', () => {
    const index = buildIndex([{ assetid: '100', marketHashName: 'Sword', priceCents: 250, contextId: '2' },
        { assetid: '101', marketHashName: 'Other context item', priceCents: 999, contextid: '3' }], OWNER);
    assert.equal(getPrice(index, item('100', 'Sword', { contextId: '2' })).cents, 250);
    for (const extra of [{ contextId: '3' }, { contextid: 0 }, { context_id: '3' }, { contextId: null }]) {
        assert.equal(getPrice(index, item('100', 'Sword', extra)).cents, null);
        assert.equal(getPrice(index, item('999', 'Sword', extra)).cents, null);
    }
    assert.equal(getPrice(index, item('101', 'Other context item', { contextId: '2' })).cents, null);
});

test('oversized indexes fail explicitly rather than silently truncating price rows', () => {
    assert.throws(() => buildIndex(new Array(100001), OWNER), /100000 price items/);
    assert.doesNotThrow(() => buildIndex([], OWNER));
});

test('explicit invalid amounts and unsafe products or totals remain unpriced', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }, { assetid: '101', priceCents: Number.MAX_SAFE_INTEGER }], OWNER);
    for (const amount of [null, '', 0, -1, 1.5, '2.5', 'invalid', true, Number.MAX_SAFE_INTEGER + 1]) {
        const summary = summarize([item('100', '', { amount })], index);
        assert.equal(summary.complete, false, String(amount));
        assert.equal(summary.knownCents, 0);
    }
    assert.equal(summarize([item('101', '', { amount: 2 })], index).complete, false);
    const overflow = summarize([item('101', ''), item('100', '')], index);
    assert.equal(overflow.complete, false);
    assert.equal(overflow.knownCents, Number.MAX_SAFE_INTEGER);
    assert.equal(overflow.unpricedCount, 1);
});

test('complete differences are receive minus give; partial differences never assert a full gain or loss', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }, { assetid: '101', priceCents: 900 }], OWNER);
    const give = summarize([item('100', '')], index);
    const receive = summarize([item('101', '')], index);
    assert.deepEqual(difference(give, receive), { knownCents: 650, cents: 650, complete: true });
    assert.deepEqual(difference(receive, give), { knownCents: -650, cents: -650, complete: true });
    const partial = summarize([item('101', ''), item('999', 'Unknown')], index);
    assert.deepEqual(difference(give, partial), { knownCents: 650, cents: null, complete: false });
    assert.deepEqual(difference(partial, give), { knownCents: -650, cents: null, complete: false });
    assert.deepEqual(difference(give, summarize([item('101', '', { appId: 730 })], index)),
        { knownCents: -250, cents: null, complete: false });
    assert.deepEqual(difference(summarize([], index), summarize([], index)), { knownCents: 0, cents: 0, complete: true });
    assert.deepEqual(difference({ knownCents: NaN, complete: true }, receive), { knownCents: null, cents: null, complete: false });
});

test('malformed owners, non-Dota rows and unsafe numeric asset identifiers never cross-match', () => {
    assert.throws(() => buildIndex([], 'not-a-steamid'), /SteamID64/);
    const index = buildIndex([
        { ownerSteamId: 'invalid', assetid: '100', marketHashName: 'Sword', priceCents: 250 },
        { ownerSteamId: OWNER, assetid: '100', appid: 730, marketHashName: 'Sword', priceCents: 500 },
        { ownerSteamId: OWNER, assetid: Number.MAX_SAFE_INTEGER + 1, priceCents: 999 }
    ]);
    assert.equal(getPrice(index, item('100', 'Sword')).cents, null);
    assert.equal(getPrice(index, item(String(Number.MAX_SAFE_INTEGER + 1), '')).cents, null);
    assert.equal(getPrice(index, item('100', 'Sword', { ownerSteamId: '../other' })).cents, null);
});

test('the browser global exposes the same pure APIs without a CommonJS runtime', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gems.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'trade-prices.js'), 'utf8'), context);
    for (const name of ['buildIndex', 'getPrice', 'summarize', 'difference']) assert.equal(typeof context.SIHLiteTradePrices[name], 'function');
    const index = context.SIHLiteTradePrices.buildIndex([{ assetId: '100', priceCents: 0 }], OWNER);
    assert.equal(context.SIHLiteTradePrices.getPrice(index, item('100', '')).cents, 0);
});

function basicTbApi(extra = {}) {
    const row = {
        assetid: '400', marketHashName: 'Fractal Horns of Inner Abysm', quality: 'Standard', assetQuality: 'Standard',
        rawTags: [{ category: 'Quality', internal_name: 'unique' }], priceCents: 11767,
        prismaticGems: ['Deep Blue'], etherealGems: [], kineticGems: [], unusualEffectGems: [],
        emptySockets: 0, spectatorGames: 0, tradable: true, marketable: true,
        isLegacy: false, legacyRgb: null, legacyPricing: null
    };
    for (const key of ['allStylesUnlocked', 'mayBeGiftedOnce', 'favored', 'unusualQuality', 'isBuggedEthereal',
        'isOtherBug', 'isGolden', 'isCrimson', 'emptyEthereal', 'emptyPrismatic', 'isUnusualCourier',
        'hasAllStyleCourier', 'hasUnusualEffect', 'isCollectorBundle', 'canGiftCollectorBundle',
        'unpackGiftCollectorBundle', 'pbrCycled']) row[key] = false;
    for (const key of ['styleTotal', 'styleUnlocked', 'gem', 'paintSeed', 'wearRating', 'stickers', 'infuser',
        'roshanCycle', 'expirationDate', 'greevil', 'collectorSetPiece']) row[key] = null;
    return { ...row, ...extra };
}

function tbDescription({ name = 'Deep Blue', rgb = [61, 104, 196], quality = 'unique', tags = true, extraHtml = '' } = {}) {
    return {
        appid: 570, classid: '400', instanceid: '0',
        market_hash_name: quality === 'exalted' ? 'Exalted Fractal Horns of Inner Abysm' : 'Fractal Horns of Inner Abysm',
        name_color: quality === 'exalted' ? 'CCCCCC' : 'D2D2D2', tradable: true, marketable: true,
        tags: tags ? [{ category: 'Quality', internal_name: quality }] : [],
        descriptions: [{ type: 'html', value: '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color.hash.png)">' +
            `<span style="color:rgb(${rgb.join(',')})">${name}</span><br><span>Prismatic Gem</span></div>` + extraHtml }]
    };
}

test('verified ordinary TB colors match only the same owner and quality and are explicitly estimates', () => {
    const index = buildIndex([basicTbApi()], OWNER);
    const offered = item(null, 'Fractal Horns of Inner Abysm', { description: tbDescription(), amount: 2 });
    assert.deepEqual(getPrice(index, offered), { cents: 11767, source: 'variant' });
    assert.deepEqual(summarize([offered], index), { knownCents: 23534, itemCount: 1, pricedCount: 1,
        unpricedCount: 0, nonDotaCount: 0, estimatedCount: 1, complete: true });
    assert.equal(getPrice(index, { ...offered, ownerSteamId: PARTNER }).cents, null);
    assert.equal(getPrice(index, { ...offered, description: tbDescription({ quality: 'exalted' }) }).cents, null);
    assert.equal(getPrice(index, item('400', '', { description: tbDescription() })).source, 'asset', 'real exact asset identity takes priority');
});

test('localized socket names and omitted hover tags need the same verified regular RGB', () => {
    const api = basicTbApi();
    const native = tbDescription({ name: 'Глубокий синий', tags: false });
    assert.equal(variantFingerprint(native), variantFingerprint(api, true));
    assert.equal(getPrice(buildIndex([api], OWNER), item(null, native.market_hash_name, { description: native })).cents, 11767);
    assert.equal(variantFingerprint(tbDescription({ name: 'Глубокий синий', rgb: [61, 104, 195], tags: false })), null);
    assert.equal(variantFingerprint({ ...native, name_color: 'A52A2A' }), null);
    assert.equal(variantFingerprint({ ...native, name_color: '' }), null);
    assert.equal(variantFingerprint(tbDescription({ name: 'Unknown Color' })), null);
    assert.equal(variantFingerprint(tbDescription({ name: "Reflection's Shade", rgb: [255, 60, 40] })),
        '["tb-v1","standard","regular",255,60,40]');
});

test('Legacy fingerprints require exact RGB and remain distinct from regular colors with the same RGB', () => {
    const first = basicTbApi({ assetid: '401', prismaticGems: ['Legacy (61, 104, 196)'], isLegacy: true,
        legacyRgb: { r: 61, g: 104, b: 196 }, legacyPricing: { isDupe: false, dupeCount: 0 }, priceCents: 99999 });
    const second = basicTbApi({ assetid: '402', prismaticGems: ['Legacy (61, 104, 195)'], isLegacy: true,
        legacyRgb: { r: 61, g: 104, b: 195 }, legacyPricing: { isDupe: false, dupeCount: 0 }, priceCents: 88888 });
    const index = buildIndex([first, second, basicTbApi()], OWNER);
    const description = tbDescription({ name: 'Legacy (61, 104, 196)' });
    assert.deepEqual(getPrice(index, item(null, description.market_hash_name, { description })), { cents: 99999, source: 'variant' });
    assert.equal(getPrice(index, item(null, 'Fractal Horns of Inner Abysm', { description: tbDescription() })).cents, 11767);
    assert.equal(variantFingerprint(tbDescription({ name: 'Legacy (61, 104, 196)', rgb: [61, 104, 195] })), null);
    assert.equal(variantFingerprint({ ...first, legacyRgb: { r: 61, g: 104, b: 195 } }, true), null);
    assert.equal(variantFingerprint({ ...first, legacyPricing: { isDupe: true, dupeCount: 2 } }, true), null);
});

test('ambiguous, exceptional, unpriced or incomplete API variants cannot select another matching candidate', () => {
    const offered = item(null, 'Fractal Horns of Inner Abysm', { description: tbDescription() });
    for (const exceptional of [
        { priceCents: 9000 }, { priceCents: null }, { isOtherBug: true }, { allStylesUnlocked: true },
        { styleTotal: 2 }, { favored: undefined }, { isLegacy: undefined }, { rawTags: undefined }, { assetQuality: undefined },
        { etherealGems: ['Ethereal Flame'] },
        { etherealGems: ['Orbital Decay'] }, { kineticGems: ['Fireborn Assault'] }, { gems: ['Unknown Rune'] }, { unusualEffectGems: undefined },
        { emptySockets: 1 }, { tradable: false }
    ]) {
        const index = buildIndex([basicTbApi(), basicTbApi({ assetid: '401', ...exceptional })], OWNER);
        assert.equal(getPrice(index, offered).cents, null, JSON.stringify(exceptional));
    }
    const samePrice = buildIndex([basicTbApi(), basicTbApi({ assetid: '401' })], OWNER);
    assert.equal(getPrice(samePrice, offered).cents, 11767);
    const missing = basicTbApi(); delete missing.favored;
    assert.equal(variantFingerprint(missing, true), null);
    assert.equal(variantFingerprint(tbDescription({ quality: 'inscribed' })), null);
});

test('unknown occupied sockets, ethereal effects, styles and unsupported couriers remain unpriced', () => {
    const index = buildIndex([basicTbApi()], OWNER);
    for (const extraHtml of [
        '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_effect.hash.png)"><span>Ethereal Flame</span><br><span>Ethereal Gem</span></div>',
        '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_rune.hash.png)">Unparsed rune</div>',
        '<div>Styles unlocked: 2</div>',
        '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_empty.hash.png)">Empty socket</div>'
    ]) {
        assert.equal(getPrice(index, item(null, 'Fractal Horns of Inner Abysm', { description: tbDescription({ extraHtml }) })).cents, null);
    }
    const courier = { ...tbDescription(), market_hash_name: 'Platinum Baby Roshan' };
    assert.equal(variantFingerprint(courier), null);
    assert.equal(getPrice(index, item(null, 'Platinum Baby Roshan', { description: courier })).cents, null);
    assert.equal(getPrice(index, item(null, 'Sword', { variantFingerprint: variantFingerprint(tbDescription()) })).cents, null);
    assert.equal(getPrice(index, item(null, 'Exalted Fractal Horns of Inner Abysm', { variantFingerprint: variantFingerprint(tbDescription()) })).cents, null);
    assert.equal(getPrice(index, item(null, 'Fractal Horns of Inner Abysm', { variantFingerprint: '["tb-v1","standard","regular",1,2,3]' })).cents, null);
});
