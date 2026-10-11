const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { compactCollection } = require('../collection-prices.js');

// Shape verified from Steamprice's public /api/dota2/collection/:steamid64.
const row = (itemName, cashPriceCents, extra = {}) => ({ itemName, cashPriceCents, steamPriceCents: 0,
    owned: false, ownedItemName: null,
    itemType: 'Misc', disablePrices: false, fullSet: false, unpackHint: false, dotagiftx: false,
    cashOnly: false, missingParts: null, personaSets: null, personaGiftx: null,
    collectorAvgSaleCents: null, collectorLowestAskCents: null, collectorMedianAskCents: null, ...extra });
const collection = (items, extra = {}) => ({ name: 'WEATHER', kind: 'regular', priceSource: 'steam', items, ...extra });

test('public weather cash quotes survive zero Steam placeholders without inheriting viewer ownership', () => {
    const payload = { collections: [collection([
        row('Genuine Weather Ash', 671, { owned: true, ownedAssetid: '36811265116', ownedItemName: 'Genuine Weather Ash', image: '/ash.webp' }),
        row('Genuine Weather Aurora', 92), row('Genuine Weather Harvest', 84)
    ])], overallOwned: 9, overallTotal: 9, collectionRank: 123 };
    assert.deepEqual(compactCollection(payload), { items: [
        { marketHashName: 'Genuine Weather Ash', priceCents: 671 },
        { marketHashName: 'Genuine Weather Aurora', priceCents: 92 },
        { marketHashName: 'Genuine Weather Harvest', priceCents: 84 }
    ], collectionCount: 1, itemCount: 3 });
    assert.equal(payload.collections[0].items[0].ownedAssetid, '36811265116', 'input is not mutated');
});

test('no zero, malformed, string, or absent cash quote falls back to a Steam or display price', () => {
    const result = compactCollection({ collections: [collection([
        ...[0, -1, null, undefined, '123', 1.25, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]
            .map((value, index) => row(`Item ${index}`, value, { steamPriceCents: 999, price: '$9.99' })),
        row(' Genuine Weather Rain ', 613)
    ])] });
    assert.deepEqual(result.items, [{ marketHashName: 'Genuine Weather Rain', priceCents: 613 }]);
});

test('color variants, couriers, collector bundles, and completion rows are excluded', () => {
    const unsafe = [
        row('Fractal Horns of Inner Abysm', 10000), row('Genuine Platinum Baby Roshan', 99999),
        row('Jumo', 999), row('Unusual Hat', 999), row('Inscribed Sword', 999),
        row('Autographed Sword', 999), row('Corrupted Sword', 999), row('Genuine Courier', 999, { itemType: 'Courier' }),
        row('Sword', 999, { disablePrices: true }), row('Sword', 999, { fullSet: true }),
        row('Sword', 999, { unpackHint: true }), row('Sword', 999, { dotagiftx: true }),
        row('Sword', 999, { personaGiftx: {} }), row('Sword', 999, { personaSets: ['Persona'] }),
        row('Sword', 999, { missingParts: ['Gloves'] }), row('Sword', 999, { cashOnly: true }),
        row('Sword', 999, { arcanaColor: {} }), row('Sword', 999, { kineticCompletion: 'loose' }),
        row('Sword', 999, { infuserName: 'Infuser' }), row('Sword', 999, { infusedWrongItem: true }),
        row('Sword', 999, { collectorAvgSaleCents: 1000 }), row('Sword', 999, { collectorLowestAskCents: 1000 })
    ];
    const result = compactCollection({ collections: [collection(unsafe),
        collection([row('Sword', 999)], { name: 'TB COLORS', kind: 'arcana_colors' }),
        collection([row('Sword', 999)], { name: 'UNUSUAL SNOWDRIFT' }),
        collection([row('Sword', 999)], { name: 'SPECTATOR COURIERS' }),
        collection([row('Sword', 999)], { kind: 'sets' })] });
    assert.deepEqual(result.items, []);
});

test('duplicate exact catalog names remain separate so the pricing index can reject conflicting quotes', () => {
    const result = compactCollection({ collections: [collection([row('Genuine Weather Ash', 671)]),
        collection([row('Genuine Weather Ash', 671), row('Genuine Weather Ash', 700)])] });
    assert.deepEqual(result.items.map(item => item.priceCents), [671, 671, 700]);
});

test('owned completion pieces and quality variants cannot price the catalog display name', () => {
    // Verified differences between two public viewers' collection responses.
    const result = compactCollection({ collections: [collection([
        row('Feast of Abscession', 57, { owned: true, ownedItemName: 'Feast of Abscession - Back' }),
        row('Claddish Cudgel', 2468, { owned: true, ownedItemName: 'Genuine Claddish Cudgel' }),
        row('Soul Diffuser', 2786, { owned: true, ownedItemName: 'Genuine Soul Diffuser' }),
        row('The Hallows Within', 676, { owned: true, ownedItemName: null }),
        row('Sword', 100, { owned: undefined }),
        row('Genuine Weather Ash', 671, { owned: true, ownedItemName: 'Genuine Weather Ash' }),
        row('Feast of Abscession', 1639, { owned: true, ownedItemName: 'Feast of Abscession' }),
        row('Claddish Cudgel', 1491)
    ])] });
    assert.deepEqual(result.items, [
        { marketHashName: 'Genuine Weather Ash', priceCents: 671 },
        { marketHashName: 'Feast of Abscession', priceCents: 1639 },
        { marketHashName: 'Claddish Cudgel', priceCents: 1491 }
    ]);
});

test('invalid top-level catalogs and excessive response sizes fail instead of claiming a complete catalog', () => {
    for (const payload of [null, [], {}, { collections: {} }, { collections: [null] }, { collections: [{}] },
        { collections: Array.from({ length: 1001 }, () => collection([])) },
        { collections: [collection(Array(100001))] }]) {
        assert.throws(() => compactCollection(payload), /invalid collection catalog/);
    }
    assert.deepEqual(compactCollection({ collections: [] }), { items: [], collectionCount: 0, itemCount: 0 });
});

test('unverified rows cannot become catalog prices through translated or owned display names', () => {
    const result = compactCollection({ collections: [collection([
        { ...row('Sword', 100), disablePrices: undefined },
        row('', 100, { ownedItemName: 'Sword', nameRu: 'Sword' }),
        row('A'.repeat(513), 100), row(123, 100), null, []
    ])] });
    assert.deepEqual(result.items, []);
});

test('classic service worker global works without CommonJS or a browser window', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../collection-prices.js'), 'utf8'), context);
    const result = context.SIHLiteCollectionPrices.compactCollection({ collections: [collection([row('Genuine Weather Aurora', 92)])] });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { items: [{ marketHashName: 'Genuine Weather Aurora', priceCents: 92 }],
        collectionCount: 1, itemCount: 1 });
});
