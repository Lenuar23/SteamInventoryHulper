const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildIndex, getPrice, summarize, difference, variantFingerprint, ordinaryFingerprint, buildCatalogIndex, catalogFingerprint } = require('../trade-prices.js');

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

test('ordinary aliases use the full canonical name and keep qualities, bundles and sets distinct', () => {
    const index = buildIndex([{ assetid: '100', marketHashName: 'Genuine Sword Set', priceCents: 250 }], OWNER);
    assert.deepEqual(getPrice(index, item('999', 'Genuine Sword Set')), { cents: 250, source: 'name' });
    for (const name of ['Sword', 'Genuine Sword', 'Sword Set', 'Genuine Sword Bundle']) assert.equal(getPrice(index, item('999', name)).cents, null);
    assert.equal(index.cleanNames.size, 0, 'legacy bridge field remains empty for compatibility');
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
        { knownCents: 750, itemCount: 2, pricedCount: 2, unpricedCount: 0, nonDotaCount: 0, estimatedCount: 0, ordinaryEstimatedCount: 0, catalogEstimatedCount: 0, classEstimatedCount: 0, complete: true });
    assert.equal(getPrice(index, item('100', '', { amount: 3 })).cents, 250, 'lookup returns a unit price');
    assert.equal(summarize([item('100', '')], index).knownCents, 250, 'missing amount defaults to one slot');
});

test('unknown prices and non-Dota items produce a partial known total', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }], OWNER);
    assert.deepEqual(summarize([
        item('100', '', { amount: 2 }), item('999', 'Unknown'), item('100', '', { appId: 730, amount: 5 })
    ], index), { knownCents: 500, itemCount: 3, pricedCount: 1, unpricedCount: 2, nonDotaCount: 1, estimatedCount: 0, ordinaryEstimatedCount: 0, catalogEstimatedCount: 0, classEstimatedCount: 0, complete: false });
    assert.deepEqual(getPrice(index, item('100', '', { appId: 730 })), { cents: null, source: 'non-dota' });
    assert.equal(getPrice(index, item('100', '', { appId: undefined })).cents, null, 'missing application cannot claim a Dota valuation');
});

test('offered currency identifiers cannot collide with priced assets and always keep the valuation partial', () => {
    const index = buildIndex([{ assetid: '100', priceCents: 250 }], OWNER);
    const currency = item('100', '', { isCurrency: true, currencyId: '100', amount: 3 });
    assert.deepEqual(getPrice(index, currency), { cents: null, source: 'unknown' });
    assert.equal(getPrice(index, item('100', '', { is_currency: true })).cents, null);
    assert.deepEqual(summarize([item('100', ''), currency], index),
        { knownCents: 250, itemCount: 2, pricedCount: 1, unpricedCount: 1, nonDotaCount: 0, estimatedCount: 0, ordinaryEstimatedCount: 0, catalogEstimatedCount: 0, classEstimatedCount: 0, complete: false });
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
        unpricedCount: 0, nonDotaCount: 0, estimatedCount: 1, ordinaryEstimatedCount: 0, catalogEstimatedCount: 0, classEstimatedCount: 0, complete: true });
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

function ordinaryApi(extra = {}) {
    return basicTbApi({ marketHashName: 'Orb of Reminiscence', prismaticGems: [], priceCents: 92, basePriceCents: 92, ...extra });
}

function ordinaryDescription(extra = {}) {
    return { market_hash_name: 'Orb of Reminiscence', name_color: 'D2D2D2', tradable: 1, marketable: 1,
        tags: [{ category: 'Quality', internal_name: 'unique' }], descriptions: [], ...extra };
}

test('shared ordinary estimates use verified exact standard variants without borrowing another owner asset', () => {
    const other = buildIndex([ordinaryApi()], PARTNER);
    const own = buildIndex([], OWNER);
    const description = ordinaryDescription();
    const fingerprint = ordinaryFingerprint(description);
    assert.equal(fingerprint, '["ordinary-v1","standard","orb of reminiscence"]');
    assert.equal(ordinaryFingerprint(ordinaryApi(), true), fingerprint);
    assert.equal(other.sharedOrdinaryPrices.get(fingerprint), 92);
    const offered = item('400', 'Orb of Reminiscence', { description });
    assert.deepEqual(getPrice(own, offered), { cents: null, source: 'unknown' });
    assert.deepEqual(getPrice(own, offered, other.sharedOrdinaryPrices), { cents: 92, source: 'ordinary-estimate' });
    assert.equal(own.assetPrices.size, 0);
    assert.equal(offered.assetId, '400', 'lookup does not alter owner or asset identity');
    const reduced = item(null, 'Orb of Reminiscence', { ordinaryFingerprint: fingerprint });
    assert.deepEqual(getPrice(own, reduced, other.sharedOrdinaryPrices), { cents: 92, source: 'ordinary-estimate' });
    assert.equal(getPrice(own, { ...reduced, market_hash_name: 'A different orb' }, other.sharedOrdinaryPrices).cents, null);
    assert.equal(getPrice(own, { ...reduced, market_hash_name: undefined, name: 'Orb of Reminiscence' }, other.sharedOrdinaryPrices).cents, null);
});

test('stock API flags, quality and full/base cash agreement are required for pooled ordinary prices', () => {
    const fingerprint = ordinaryFingerprint(ordinaryApi(), true);
    for (const change of [
        { quality: 'Genuine' }, { assetQuality: undefined }, { rawTags: undefined }, { favored: undefined },
        { allStylesUnlocked: true }, { styleUnlocked: 2 }, { emptySockets: 1 }, { kineticGems: ['Fireborn Assault'] },
        { isOtherBug: true }, { isGolden: true }, { isCrimson: true }, { isLegacy: true }, { tradable: false },
        { collectorAvgSaleCents: 92 }, { collectorLowestAskCents: 92 }, { collectorSetPiece: 'Set piece' },
        { marketHashName: 'Genuine Orb of Reminiscence' }, { gems: ['A rune'] }, { unusualEffectGems: undefined }
    ]) {
        assert.equal(ordinaryFingerprint(ordinaryApi(change), true), null, JSON.stringify(change));
        assert.equal(buildIndex([ordinaryApi(change)], PARTNER).sharedOrdinaryPrices.size, 0);
    }
    for (const change of [{ priceCents: null }, { basePriceCents: null }, { priceCents: 93 }, { priceCents: true }]) {
        assert.equal(buildIndex([ordinaryApi(), ordinaryApi({ assetid: '401', ...change })], PARTNER).sharedOrdinaryPrices.get(fingerprint), null);
    }
    assert.equal(buildIndex([ordinaryApi({ scmPriceCents: 300, priceCents: 92, basePriceCents: 92 })], PARTNER).sharedOrdinaryPrices.get(fingerprint), 92,
        'cash estimate never replaces Steamprice values with SCM dollars');
    const zero = buildIndex([ordinaryApi({ priceCents: 0, basePriceCents: 0 })], PARTNER);
    assert.equal(zero.sharedOrdinaryPrices.get(fingerprint), 0);
});

test('historical ordinary fingerprints reject quality changes, unknown metadata and every socket or style', () => {
    assert.ok(ordinaryFingerprint(ordinaryDescription({ tags: [] })));
    for (const extra of [
        { tags: [], name_color: '' }, { tags: [{ category: 'Quality', internal_name: 'genuine' }] },
        { tags: [{ category: 'Quality', internal_name: 'unique' }, { category: 'Quality', internal_name: 'unique' }] },
        { tradable: 0 }, { marketable: false }, { descriptions: undefined },
        { market_hash_name: 'Inscribed Orb of Reminiscence' }, { hasGems: true },
        { descriptions: [{ value: 'Styles unlocked: 2' }] },
        { descriptions: [{ value: 'Rune: kills counted' }] },
        { descriptions: [{ value: '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_empty.hash.png)">Свободное гнездо</div>' }] },
        { descriptions: [{ value: '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_rune.hash.png)">Золота заработано</div>' }] }
    ]) assert.equal(ordinaryFingerprint(ordinaryDescription(extra)), null, JSON.stringify(extra));
    assert.equal(ordinaryFingerprint({ ...tbDescription(), descriptions: [] }), null, 'colored-gem models remain excluded even without socket data');
});

test('owner asset and conflicting aliases retain priority over pooled ordinary estimates', () => {
    const pool = buildIndex([ordinaryApi()], PARTNER).sharedOrdinaryPrices;
    const offered = item('400', 'Orb of Reminiscence', { ordinaryFingerprint: ordinaryFingerprint(ordinaryDescription()) });
    assert.deepEqual(getPrice(buildIndex([ordinaryApi({ priceCents: 500, basePriceCents: 500 })], OWNER), offered, pool), { cents: 500, source: 'asset' });
    const conflict = buildIndex([ordinaryApi(), ordinaryApi({ priceCents: 500 })], OWNER);
    assert.deepEqual(getPrice(conflict, offered, pool), { cents: null, source: 'unknown' });
    const nameConflict = buildIndex([ordinaryApi({ assetid: '500' }), ordinaryApi({ assetid: '501', priceCents: 500 })], OWNER);
    assert.deepEqual(getPrice(nameConflict, offered, pool), { cents: null, source: 'unknown' });
    assert.deepEqual(getPrice(buildIndex([], OWNER), offered, new Map([[ordinaryFingerprint(ordinaryDescription()), null]])), { cents: null, source: 'unknown' });
});

test('pooled ordinary estimates keep unsafe gem, currency, app, context, owner and forged fingerprint rows unknown', () => {
    const pool = buildIndex([ordinaryApi()], PARTNER).sharedOrdinaryPrices;
    const own = buildIndex([], OWNER);
    const offered = item(null, 'Orb of Reminiscence', { ordinaryFingerprint: ordinaryFingerprint(ordinaryDescription()) });
    for (const extra of [
        { hasGems: true }, { hasColoredGem: true }, { kineticGems: ['Fireborn Assault'] }, { isCurrency: true },
        { appId: undefined }, { contextId: '3' }, { ownerSteamId: undefined },
        { market_hash_name: 'Inscribed Orb of Reminiscence' },
        { ordinaryFingerprint: '["ordinary-v1","genuine","orb of reminiscence"]' },
        { ordinaryFingerprint: '["ordinary-v1","standard","a different orb"]' }
    ]) assert.equal(getPrice(own, { ...offered, ...extra }, pool).cents, null, JSON.stringify(extra));
    assert.equal(getPrice(own, { ...offered, appId: '730' }, pool).source, 'non-dota');
});

test('ordinary estimates count separately from gem estimates and multiply offered stack quantities', () => {
    const own = buildIndex([basicTbApi()], OWNER);
    const pool = buildIndex([ordinaryApi()], PARTNER).sharedOrdinaryPrices;
    const ordinary = item(null, 'Orb of Reminiscence', { ordinaryFingerprint: ordinaryFingerprint(ordinaryDescription()), amount: 3 });
    const colored = item(null, 'Fractal Horns of Inner Abysm', { description: tbDescription() });
    assert.deepEqual(summarize([ordinary, colored], own, pool), { knownCents: 12043, itemCount: 2, pricedCount: 2,
        unpricedCount: 0, nonDotaCount: 0, estimatedCount: 1, ordinaryEstimatedCount: 1, catalogEstimatedCount: 0, classEstimatedCount: 0, complete: true });
    assert.equal(summarize([ordinary], own).ordinaryEstimatedCount, 0);
    assert.equal(summarize([ordinary], own).unpricedCount, 1);
});

function genuineWeatherDescription(extra = {}) {
    return ordinaryDescription({ market_hash_name: 'Genuine Weather Ash', name_color: '4D7455',
        tags: [{ category: 'Quality', internal_name: 'genuine' }], ...extra });
}

// Public Steam class metadata, fetched from itemclasshover/570/519295759/93973071.
const realWeatherRain = require('./fixtures/steam-genuine-weather-rain.json');

test('real tradable but non-marketable Genuine Weather receives only its Steamprice cash catalog estimate', () => {
    assert.equal(realWeatherRain.tradable, 1);
    assert.equal(realWeatherRain.marketable, 0);
    const key = catalogFingerprint(realWeatherRain);
    assert.equal(key, '["catalog-v1","genuine weather rain","genuine"]');
    const offered = item(null, realWeatherRain.market_hash_name, { description: realWeatherRain });
    const empty = buildIndex([], OWNER);
    const catalog = buildCatalogIndex([{ marketHashName: 'Genuine Weather Rain', priceCents: 613 }]);
    assert.deepEqual(getPrice(empty, offered, new Map(), catalog), { cents: 613, source: 'catalog' });
    assert.deepEqual(getPrice(empty, { ...offered, description: undefined, catalogFingerprint: key,
        tradable: true, marketable: false }, new Map(), catalog), { cents: 613, source: 'catalog' }, 'verified class proof survives reduced bridge metadata');
    assert.deepEqual(summarize([offered], empty, new Map(), catalog), { knownCents: 613, itemCount: 1,
        pricedCount: 1, unpricedCount: 0, nonDotaCount: 0, estimatedCount: 0,
        ordinaryEstimatedCount: 0, catalogEstimatedCount: 1, classEstimatedCount: 0, complete: true });
    assert.equal(offered.assetId, null, 'cash estimates do not invent an owner asset');
});

test('non-marketable Weather eligibility is closed to the nine verified Genuine cash effects', () => {
    for (const effect of ['Ash', 'Aurora', 'Harvest', 'Moonbeam', 'Rain', 'Pestilence', 'Sirocco', 'Snow', 'Spring']) {
        const description = { ...realWeatherRain, market_hash_name: `Genuine Weather ${effect}` };
        assert.equal(catalogFingerprint(description), JSON.stringify(['catalog-v1', description.market_hash_name.toLowerCase(), 'genuine']));
    }
    for (const extra of [
        { market_hash_name: 'Genuine Weather Unknown' }, { market_hash_name: 'Weather Rain' },
        { market_hash_name: 'Genuine Golden Bloodfeather Feast' }, { tradable: 0 }, { tradable: false },
        { tradable: undefined }, { tradable: '1' }, { marketable: null }, { marketable: '0' },
        { tags: [{ category: 'Quality', internal_name: 'unique' }] }, { tags: [], name_color: 'D2D2D2' },
        { descriptions: undefined }, { hasColoredGem: true }, { kineticGems: ['Kinetic Gem'] },
        { descriptions: [{ value: '<img src="https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_empty.png">' }] },
        { descriptions: [{ value: 'Styles unlocked: 2' }] }
    ]) assert.equal(catalogFingerprint({ ...realWeatherRain, ...extra }), null, JSON.stringify(extra));
    assert.equal(catalogFingerprint({ ...realWeatherRain, marketable: false }), catalogFingerprint(realWeatherRain));
});

test('Weather cash exemption cannot expose ordinary aliases or accept foreign and contradictory proofs', () => {
    const key = catalogFingerprint(realWeatherRain);
    const own = buildIndex([{ marketHashName: realWeatherRain.market_hash_name, priceCents: 9999 }], OWNER);
    const offered = item(null, realWeatherRain.market_hash_name, { catalogFingerprint: key, tradable: true, marketable: false });
    const pool = new Map([['["ordinary-v1","standard","genuine weather rain"]', 9999]]);
    assert.equal(getPrice(own, offered, pool).cents, null, 'missing catalog never falls through to an owner alias');
    const catalog = buildCatalogIndex([{ marketHashName: 'Genuine Weather Rain', priceCents: 613 }]);
    for (const extra of [
        { catalogFingerprint: '["catalog-v1","genuine weather ash","genuine"]' },
        { catalogFingerprint: '["catalog-v1","genuine weather rain","standard"]' },
        { catalogFingerprint: null }, { tradable: false }, { tradable: 0 }, { tradable: undefined },
        { description: { ...realWeatherRain, tradable: false } },
        { description: { ...realWeatherRain, marketable: true } },
        { description: { ...realWeatherRain, tags: [{ category: 'Quality', internal_name: 'unique' }] } }
    ]) assert.equal(getPrice(own, { ...offered, ...extra }, pool, catalog).cents, null, JSON.stringify(extra));
});

test('exact Steamprice catalog estimates cover Genuine weather absent from every owner inventory', () => {
    const description = genuineWeatherDescription();
    const key = catalogFingerprint(description);
    assert.equal(key, '["catalog-v1","genuine weather ash","genuine"]');
    const offered = item(null, description.market_hash_name, { catalogFingerprint: key, amount: 2, tradable: true, marketable: true });
    const catalog = buildCatalogIndex([{ marketHashName: 'Genuine Weather Ash', priceCents: 671 },
        { marketHashName: 'Genuine Weather Rain', priceCents: 106 }]);
    const own = buildIndex([], OWNER);
    assert.deepEqual(getPrice(own, offered), { cents: null, source: 'unknown' });
    assert.deepEqual(getPrice(own, offered, new Map(), catalog), { cents: 671, source: 'catalog' });
    assert.deepEqual(summarize([offered], own, new Map(), catalog), { knownCents: 1342, itemCount: 1, pricedCount: 1,
        unpricedCount: 0, nonDotaCount: 0, estimatedCount: 0, ordinaryEstimatedCount: 0, catalogEstimatedCount: 1, classEstimatedCount: 0, complete: true });
    assert.equal(offered.assetId, null, 'catalog does not assign owner assets to historical classes');
    assert.equal(catalogFingerprint(genuineWeatherDescription({ tags: [] })), key);
    assert.equal(getPrice(own, { ...offered, market_hash_name: 'Weather Ash' }, new Map(), catalog).cents, null, 'Genuine prefix is retained');
});

test('catalog estimates require known Standard or Genuine quality and reject gem/socket/style metadata', () => {
    const description = genuineWeatherDescription();
    const catalog = buildCatalogIndex([{ marketHashName: 'Genuine Weather Ash', priceCents: 671 }, { marketHashName: 'Orb of Reminiscence', priceCents: 92 }]);
    const own = buildIndex([], OWNER);
    assert.ok(catalogFingerprint(ordinaryDescription()));
    for (const extra of [
        { tags: [], name_color: '' }, { tags: [{ category: 'Quality', internal_name: 'unique' }] },
        { market_hash_name: 'Weather Ash' }, { tradable: 0 }, { marketable: null }, { descriptions: undefined },
        { hasColoredGem: true }, { kineticGems: ['Fireborn Assault'] }, { styleUnlocked: 2 }, { isOtherBug: true },
        { descriptions: [{ value: '<div style="background-image:url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_empty.hash.png)">Empty slot</div>' }] },
        { descriptions: [{ value: 'Styles unlocked: 2' }] }
    ]) assert.equal(catalogFingerprint({ ...description, ...extra }), null, JSON.stringify(extra));
    for (const name of ['Inscribed Orb of Reminiscence', 'Exalted Orb of Reminiscence', 'Unusual Baby Roshan', 'Genuine Fractal Horns of Inner Abysm']) {
        assert.equal(catalogFingerprint(genuineWeatherDescription({ market_hash_name: name })), null);
    }
    const forged = item(null, 'Exalted Orb of Reminiscence', { catalogFingerprint: '["catalog-v1","exalted orb of reminiscence",null]' });
    assert.equal(getPrice(own, forged, new Map(), buildCatalogIndex([{ marketHashName: forged.market_hash_name, priceCents: 999 }])).cents, null);
    const styled = item(null, description.market_hash_name, { catalogFingerprint: catalogFingerprint(description),
        description: genuineWeatherDescription({ descriptions: [{ value: 'Styles unlocked: 2' }] }) });
    assert.equal(getPrice(own, styled, new Map(), catalog).cents, null, 'claimed class key cannot bypass full native style metadata');
});

test('Steamprice owner and pooled priorities, including conflicts, cannot be bypassed by catalog estimates', () => {
    const key = ordinaryFingerprint(ordinaryDescription());
    const offered = item('400', 'Orb of Reminiscence', { ordinaryFingerprint: key, catalogFingerprint: catalogFingerprint(ordinaryDescription()) });
    const catalog = buildCatalogIndex([{ marketHashName: 'Orb of Reminiscence', priceCents: 999 }]);
    const own = buildIndex([ordinaryApi()], OWNER);
    assert.deepEqual(getPrice(own, offered, new Map(), catalog), { cents: 92, source: 'asset' });
    assert.deepEqual(getPrice(own, { ...offered, assetId: null }, new Map(), catalog), { cents: 92, source: 'name' });
    const empty = buildIndex([], OWNER);
    assert.deepEqual(getPrice(empty, offered, new Map([[key, 123]]), catalog), { cents: 123, source: 'ordinary-estimate' });
    assert.equal(getPrice(empty, offered, new Map([[key, null]]), catalog).cents, null);
    assert.equal(getPrice(buildIndex([ordinaryApi(), ordinaryApi({ priceCents: 93 })], OWNER), offered, new Map(), catalog).cents, null);
    assert.equal(getPrice(buildIndex([ordinaryApi({ assetid: '500' }), ordinaryApi({ assetid: '501', priceCents: 93 })], OWNER), offered, new Map(), catalog).cents, null);
});

test('catalog names stay exact and conflicting or unavailable cash prices remain unknown', () => {
    const catalog = buildCatalogIndex([{ marketHashName: 'Genuine Weather Ash', priceCents: 671 },
        { marketHashName: 'Genuine Weather Ash', priceCents: 672 }, { marketHashName: 'Genuine Weather Rain', priceCents: 0 },
        { marketHashName: 'Genuine Weather Moonbeam', priceCents: null }, { marketHashName: 'Genuine Weather Aurora', priceCents: '92' },
        { marketHashName: 'Invalid', priceCents: true }, { name: 'Display name only', priceCents: 99 }]);
    assert.equal(catalog.get('genuine weather ash'), null);
    assert.equal(catalog.get('genuine weather rain'), null);
    assert.equal(catalog.get('genuine weather moonbeam'), null);
    assert.equal(catalog.get('genuine weather aurora'), 92);
    assert.equal(catalog.get('invalid'), null);
    assert.equal(catalog.has('display name only'), false);
    const offered = item(null, 'Genuine Weather Ash', { description: genuineWeatherDescription() });
    assert.equal(getPrice(buildIndex([], OWNER), offered, new Map(), catalog).cents, null);
    assert.throws(() => buildCatalogIndex(new Array(100001)), /100000 price items/);
    assert.throws(() => buildCatalogIndex({}), /must be an array/);
});

test('explicit unavailable native flags block all aliases and estimates while exact API assets retain priority', () => {
    const own = buildIndex([ordinaryApi()], OWNER);
    const empty = buildIndex([], OWNER);
    const description = ordinaryDescription();
    const offered = item(null, description.market_hash_name, { ordinaryFingerprint: ordinaryFingerprint(description), catalogFingerprint: catalogFingerprint(description) });
    const pool = new Map([[offered.ordinaryFingerprint, 92]]);
    const catalog = buildCatalogIndex([{ marketHashName: description.market_hash_name, priceCents: 99 }]);
    for (const field of ['tradable', 'marketable']) for (const value of [false, 0]) {
        const unavailable = { ...offered, [field]: value };
        assert.equal(getPrice(own, unavailable, pool, catalog).cents, null, `${field} ${value}: owner alias`);
        assert.equal(getPrice(empty, unavailable, pool, catalog).cents, null, `${field} ${value}: estimate`);
        assert.equal(getPrice(own, { ...unavailable, assetId: '400' }, pool, catalog).source, 'asset');
        assert.equal(catalogFingerprint({ ...description, [field]: value }), null);
        assert.equal(getPrice(own, { ...offered, description: { ...description, [field]: value } }, pool, catalog).cents, null);
    }
});

const realSocketClasses = [
    require('./fixtures/steam-golden-bloodfeather-feast.json'),
    require('./fixtures/steam-genuine-bloodfeather-wings.json'),
    require('./fixtures/steam-inscribed-terrorblade-deep-blue.json')
];

test('exact current owner classes price real TI8, kinetic and Inscribed prismatic sockets without a base-name guess', () => {
    const empty = buildIndex([], OWNER);
    const cents = [163, 667, 11767];
    const classes = new Map(realSocketClasses.map((description, position) =>
        [`${OWNER}:${description.classid}:${description.instanceid}`, cents[position]]));
    const offered = realSocketClasses.map(description => item(null, description.market_hash_name, { description }));
    for (let position = 0; position < offered.length; position++) {
        assert.equal(catalogFingerprint(realSocketClasses[position]), null, 'gem-bearing class cannot borrow a plain catalog price');
        assert.equal(getPrice(empty, offered[position]).cents, null);
        assert.deepEqual(getPrice(empty, offered[position], new Map(), new Map(), classes), { cents: cents[position], source: 'class-estimate' });
        assert.equal(offered[position].assetId, null, 'a class estimate does not manufacture an exact historical asset');
    }
    offered[2].amount = 2;
    assert.deepEqual(summarize(offered, empty, new Map(), new Map(), classes), {
        knownCents: 24364, itemCount: 3, pricedCount: 3, unpricedCount: 0, nonDotaCount: 0,
        estimatedCount: 0, ordinaryEstimatedCount: 0, catalogEstimatedCount: 0,
        classEstimatedCount: 3, complete: true
    });
});

test('class estimates require an exact owner, native class and instance, valid Dota context and known tradability', () => {
    const description = realSocketClasses[0];
    const empty = buildIndex([], OWNER);
    const key = `${OWNER}:${description.classid}:${description.instanceid}`;
    const classes = new Map([[key, 163]]);
    const offered = item(null, description.market_hash_name, { description });
    assert.deepEqual(getPrice(empty, { ...offered, description: undefined, classId: description.classid,
        instanceId: description.instanceid, tradable: true, hasGems: true }, null, null, classes), { cents: 163, source: 'class-estimate' });
    for (const extra of [
        { ownerSteamId: PARTNER }, { ownerSteamId: undefined }, { appId: '730' }, { contextId: '6' },
        { isCurrency: true }, { tradable: false }, { tradable: 0 }, { tradable: null },
        { description: { ...description, tradable: false } }, { description: { ...description, tradable: undefined } },
        { classId: '0' }, { classId: '02944822253' }, { classId: 'wrong' }, { classId: '9'.repeat(21) },
        { classId: Number.MAX_SAFE_INTEGER + 1 }, { instanceId: '-1' }, { instanceId: 'wrong' },
        { instanceId: '9'.repeat(21) }, { instanceId: Number.MAX_SAFE_INTEGER + 1 },
        { classId: description.classid, instanceId: '0' },
        { description: { ...description, appid: '730' } }
    ]) assert.equal(getPrice(empty, { ...offered, ...extra }, null, null, classes).cents, null, JSON.stringify(extra));
    const missingInstance = { ...description };
    delete missingInstance.instanceid;
    assert.equal(getPrice(empty, { ...offered, description: missingInstance }, null, null, classes).cents, null);
    for (const cents of [null, undefined, -1, NaN, '163', Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(getPrice(empty, offered, null, null, new Map([[key, cents]])).cents, null, String(cents));
    }
});

test('class conflicts stop weaker aliases and an exact historical asset retains priority over all class estimates', () => {
    const description = ordinaryDescription({ classid: '152', instanceid: '0' });
    const offered = item(null, description.market_hash_name, { description });
    const own = buildIndex([{ assetid: '400', marketHashName: description.market_hash_name, priceCents: 900 }], OWNER);
    const key = `${OWNER}:152:0`;
    const catalog = buildCatalogIndex([{ marketHashName: description.market_hash_name, priceCents: 1000 }]);
    assert.deepEqual(getPrice(own, offered, null, catalog), { cents: 900, source: 'name' });
    assert.equal(getPrice(own, offered, null, catalog, new Map([[key, null]])).cents, null, 'an ambiguous exact class cannot fall back to a plain name');
    assert.deepEqual(getPrice(own, offered, null, catalog, new Map([[key, 152]])), { cents: 152, source: 'class-estimate' });
    assert.deepEqual(getPrice(own, { ...offered, assetId: '400' }, null, catalog, new Map([[key, null]])), { cents: 900, source: 'asset' });
    const conflictingAsset = buildIndex([{ assetid: '400', priceCents: 900 }, { assetid: '400', priceCents: 901 }], OWNER);
    assert.equal(getPrice(conflictingAsset, { ...offered, assetId: '400' }, null, catalog, new Map([[key, 152]])).cents, null);
});
