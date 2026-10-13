const assert = require('node:assert/strict');
const { test } = require('node:test');
const Prices = require('../trade-prices.js');
const { buildReport } = require('../trade-diagnostics.js');

const OWNER = '76561198012345678';
const PARTNER = '76561198087654321';

function item(extra = {}) {
    return { ownerSteamId: OWNER, appId: '570', classId: '5000', instanceId: '0',
        amount: 1, market_hash_name: 'Genuine Weather Ash', tradable: true, marketable: false, ...extra };
}

function context(record = item(), index = Prices.buildIndex([], OWNER)) {
    return {
        version: '1.3.5', pathname: '/profiles/' + OWNER + '/tradeoffers/',
        offer: { offerId: '505', meSteamId: OWNER, partnerSteamId: PARTNER,
            incoming: true, active: false, give: [record], receive: [], slots: [] },
        owners: new Map([[OWNER, { index, priceState: 'ready', pricesLoaded: true }]]),
        detailState: { state: 'ready', error: '' }, classState: { state: 'idle', error: '' },
        ordinaryEstimates: new Map(), classAssetProofs: new Map(), classEstimates: new Map(),
        marketEstimates: new Map(), marketStates: new Map(),
        collection: { state: 'idle', error: '', index: new Map() }
    };
}

test('diagnostics distinguish a verified nonmarketable Weather quote from a catalog that was never requested', () => {
    const description = { appid: 570, market_hash_name: 'Genuine Weather Ash', name_color: '4D7455',
        tradable: 1, marketable: 0, tags: [{ category: 'Quality', internal_name: 'genuine' }], descriptions: [] };
    const record = item({ catalogFingerprint: Prices.catalogFingerprint(description), amount: '2' });
    const ctx = context(record);
    const before = buildReport(ctx).items[0];
    assert.equal(before.flags.marketable, false);
    assert.equal(before.identity.contextKnown, false, 'class hovers leave the asset context unknown');
    assert.equal(before.reason.code, 'collection-not-requested');
    assert.deepEqual(before.matches.catalog, { present: false });

    ctx.collection = { state: 'ready', index: Prices.buildCatalogIndex([
        { marketHashName: 'Genuine Weather Ash', priceCents: 671 }
    ]) };
    const after = buildReport(ctx).items[0];
    assert.deepEqual(after.price, { cents: 671, source: 'catalog', totalCents: 1342 });
    assert.equal(after.reason.code, 'price-known');
    assert.deepEqual(after.matches.catalog, { present: true, cents: 671 });
    assert.equal(record.assetId, undefined, 'diagnostics never invent an owner asset');
});

test('class diagnostics separate verified absence, priced current owner proof, and a conflict that blocks weaker quotes', () => {
    const record = item({ market_hash_name: 'Inscribed Hat', hasGems: true, marketable: true });
    const ctx = context(record);
    const key = OWNER + ':5000:0';
    ctx.classAssetProofs.set(key, []);
    assert.equal(buildReport(ctx).items[0].reason.code, 'class-owner-assets-absent');
    assert.deepEqual(buildReport(ctx).items[0].classProof, { present: true, assetIds: [], assetPrices: [], count: 0, omitted: 0 });

    ctx.classAssetProofs.set(key, ['100', '101']);
    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':100', 3182);
    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':101', 3182);
    ctx.classEstimates.set(key, 3182);
    const priced = buildReport(ctx).items[0];
    assert.deepEqual(priced.price, { cents: 3182, source: 'class-estimate', totalCents: 3182 });
    assert.equal(priced.reason.code, 'price-known');
    assert.deepEqual(priced.classProof.assetIds, ['100', '101']);

    ctx.classEstimates.set(key, null);
    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':101', 9999);
    const conflicting = buildReport(ctx).items[0];
    assert.deepEqual(conflicting.matches.class, { present: true, cents: null });
    assert.deepEqual(conflicting.price, { cents: null, source: 'unknown', totalCents: null });
    assert.equal(conflicting.reason.code, 'class-price-conflict');
});

test('unknown class prices identify absent owner assets versus missing, invalid or conflicting candidate API quotes', () => {
    const ctx = context(item({ market_hash_name: 'Inscribed Hat', hasGems: true, marketable: true }));
    const key = OWNER + ':5000:0';
    ctx.classEstimates.set(key, null);
    ctx.classAssetProofs.set(key, []);
    assert.equal(buildReport(ctx).items[0].reason.code, 'class-owner-assets-absent');

    ctx.classAssetProofs.set(key, ['100', '101']);
    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':100', 3182);
    let report = buildReport(ctx).items[0];
    assert.equal(report.reason.code, 'class-candidate-price-missing');
    assert.deepEqual(report.classProof.assetPrices, [
        { assetId: '100', match: { present: true, cents: 3182 } },
        { assetId: '101', match: { present: false } }
    ]);

    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':101', 'unverified');
    report = buildReport(ctx).items[0];
    assert.equal(report.reason.code, 'class-candidate-price-invalid');
    assert.deepEqual(report.classProof.assetPrices[1].match, { present: true, cents: null, invalid: true });

    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':101', null);
    assert.equal(buildReport(ctx).items[0].reason.code, 'class-price-conflict');
    ctx.owners.get(OWNER).index.assetPrices.set(OWNER + ':101', 9999);
    assert.equal(buildReport(ctx).items[0].reason.code, 'class-price-conflict');
});

test('catalog diagnostics distinguish absent names, conflicting prices, and unverified item eligibility', () => {
    const record = item({ catalogFingerprint: '["catalog-v1","genuine weather ash","genuine"]' });
    const ctx = context(record);
    ctx.collection.state = 'ready';
    assert.equal(buildReport(ctx).items[0].reason.code, 'catalog-name-absent');
    ctx.collection.index.set('genuine weather ash', null);
    assert.equal(buildReport(ctx).items[0].reason.code, 'catalog-price-conflict');
    assert.deepEqual(buildReport(ctx).items[0].matches.catalog, { present: true, cents: null });

    const unverified = context(item({ market_hash_name: 'Unknown Hat', tradable: true, marketable: true }));
    unverified.collection.state = 'ready';
    unverified.collection.index.set('unknown hat', 9999);
    const report = buildReport(unverified).items[0];
    assert.equal(report.reason.code, 'catalog-eligibility-unverified');
    assert.deepEqual(report.matches.catalog, { present: true, cents: 9999 },
        'the presence of a name quote does not establish permission to use it');
    assert.equal(report.price.cents, null);
});

test('diagnostics retain a distinct card counterpart when an exact summary asset cannot prove a badge', () => {
    const exact = item({ assetId: '100', contextId: '2', market_hash_name: 'Your Current Item' });
    const card = item({ market_hash_name: '', assetId: null, marketable: true });
    const ctx = context(exact, Prices.buildIndex([{ assetid: '100', marketHashName: 'Your Current Item', priceCents: 500 }], OWNER));
    ctx.offer.slots = [{ side: 'give', key: '505:give:0', item: card, element: { innerHTML: 'PRIVATE_HTML' } }];
    const report = buildReport(ctx);
    assert.equal(report.items.length, 2);
    assert.equal(report.items[0].location, 'summary.give[0]');
    assert.equal(report.items[0].price.source, 'asset');
    assert.equal(report.items[0].cardIdentity.assetId, null);
    assert.equal(report.items[1].location, 'card.give[0]');
    assert.equal(report.items[1].reason.code, 'missing-canonical-name');
    assert.equal(JSON.stringify(report).includes('PRIVATE_HTML'), false);

    ctx.offer.slots[0].item = { ...exact };
    assert.equal(buildReport(ctx).items.length, 1, 'matching cards do not duplicate the selected item');
});

test('diagnostics redact private error values and ignore cookies, URLs, unrelated assets and extra context', () => {
    const ctx = context(item({ market_hash_name: 'Selected Item', marketable: true }));
    ctx.pathname += '?token=PATH_TOKEN#PRIVATE_HASH';
    ctx.cookies = 'sessionid=CONTEXT_COOKIE';
    ctx.sessionId = 'CONTEXT_SESSION';
    ctx.url = 'https://steamcommunity.com/tradeoffer/new/?partner=123&token=CONTEXT_URL';
    ctx.detailState.error = 'HTTP failure https://steamcommunity.com/tradeoffer/505/?token=URL_TOKEN#URL_HASH sessionid=ERROR_SESSION';
    ctx.classState.error = 'Cookie: sessionid=HEADER_COOKIE; account=HEADER_ACCOUNT';
    const owner = ctx.owners.get(OWNER);
    owner.priceCache = { cached: true, cachedAt: 123, rawResponse: 'CACHE_SECRET',
        error: 'token="CACHE_TOKEN" password=CACHE_PASSWORD' };
    owner.index.assetPrices.set(OWNER + ':987654321', 123456789);
    owner.index.exactNames.set(OWNER + ':UNRELATED_NAME', 123456789);
    const json = JSON.stringify(buildReport(ctx));
    for (const secret of ['PATH_TOKEN', 'PRIVATE_HASH', 'CONTEXT_COOKIE', 'CONTEXT_SESSION', 'CONTEXT_URL',
        'URL_TOKEN', 'URL_HASH', 'ERROR_SESSION', 'HEADER_COOKIE', 'HEADER_ACCOUNT', 'CACHE_SECRET',
        'CACHE_TOKEN', 'CACHE_PASSWORD', '987654321', 'UNRELATED_NAME']) assert.equal(json.includes(secret), false, secret);
    assert.equal(json.includes('https://steamcommunity.com/tradeoffer/505/'), true, 'a failed public endpoint path remains useful');
    assert.equal(ctx.owners.get(OWNER).index.assetPrices.size, 1, 'read-only diagnostics retain the original maps');
    assert.equal(ctx.cookies, 'sessionid=CONTEXT_COOKIE');
});

test('diagnostics do not describe nontradable inventory copies as missing catalog prices', () => {
    const record = item({ market_hash_name: 'Candyworks Hat', tradable: false, marketable: false,
        catalogFingerprint: '["catalog-v1","candyworks hat","standard"]' });
    const ctx = context(record);
    ctx.collection = { state: 'ready', index: new Map([['candyworks hat', 10002]]) };
    const report = buildReport(ctx).items[0];
    assert.equal(report.price.cents, null);
    assert.equal(report.reason.code, 'non-tradable');
    assert.deepEqual(report.matches.catalog, { present: true, cents: 10002 });
});

test('diagnostics redact quoted JSON secret keys and escaped literals as well as private headers and URL parameters', () => {
    const ctx = context();
    ctx.detailState.error = 'API failure ' + JSON.stringify({ token: 'JSON_TOKEN', sessionid: 'JSON_SESSION',
        password: 'ESCAPED_START"ESCAPED_END', api_key: 765432198765,
        cookie: 'sessionid=JSON_COOKIE; account=JSON_ACCOUNT',
        url: 'https://steamcommunity.com/tradeoffer/505/?token=JSON_URL_TOKEN#JSON_URL_HASH' });
    ctx.classState.error = "API failure {'token': 'SINGLE_TOKEN', 'session_id': 'SINGLE_SESSION', " +
        "'set-cookie': 'sessionid=SINGLE_COOKIE', 'url': 'https://steamcommunity.com/tradeoffer/505/?key=SINGLE_URL_TOKEN#SINGLE_URL_HASH'}";
    ctx.collection.error = '{"authorization":"Bearer JSON_AUTH", "refresh_token":"JSON_REFRESH"}';
    const json = JSON.stringify(buildReport(ctx));
    for (const secret of ['JSON_TOKEN', 'JSON_SESSION', 'ESCAPED_START', 'ESCAPED_END', '765432198765',
        'JSON_COOKIE', 'JSON_ACCOUNT', 'JSON_URL_TOKEN', 'JSON_URL_HASH', 'SINGLE_TOKEN', 'SINGLE_SESSION',
        'SINGLE_COOKIE', 'SINGLE_URL_TOKEN', 'SINGLE_URL_HASH', 'JSON_AUTH', 'JSON_REFRESH']) {
        assert.equal(json.includes(secret), false, secret);
    }
    assert.equal(json.includes('API failure'), true, 'the nonprivate error context remains useful');
    assert.equal(json.includes('https://steamcommunity.com/tradeoffer/505/'), true);
});

const MISSING_MARKET_ITEMS = [
    ['Inscribed Mecha Boots of Travel Mk III', 110, 'steam-inscribed-mecha-boots-travel.json'],
    ['Autographed Wraithbinder', 119, 'steam-autographed-wraithbinder.json'],
    ['Inscribed Demon Eater - Head', 209, 'steam-inscribed-demon-eater-head.json'],
    ['Inscribed Arms of Desolation', 972, 'steam-inscribed-arms-of-desolation.json'],
    ['Inscribed Demon Eater', 1777, 'steam-inscribed-demon-eater.json']
];

function marketDescription(name) {
    const file = MISSING_MARKET_ITEMS.find(item => item[0] === name)?.[2];
    assert.ok(file, 'a sanitized public description fixture exists for ' + name);
    return structuredClone(require('./fixtures/' + file));
}

function marketQuote(marketHashName, priceCents, extra = {}) {
    return { marketHashName, priceCents, currency: 'USD', source: 'steam-market', estimateKind: 'market-name', ...extra };
}

test('diagnostics identify the five missing exact market variants from native and reduced proofs without inventing current assets', () => {
    for (const [name, cents] of MISSING_MARKET_ITEMS) {
        const description = marketDescription(name);
        const proof = Prices.marketFingerprint(description);
        assert.ok(proof, name);
        for (const native of [true, false]) {
            const record = item({ market_hash_name: name, marketable: true, hasGems: true,
                classId: description.classid, instanceId: description.instanceid,
                ...(native ? { description } : { marketFingerprint: proof }) });
            const ctx = context(record);
            const key = name.toLowerCase();
            ctx.classAssetProofs.set(OWNER + ':' + record.classId + ':' + record.instanceId, []);
            ctx.marketEstimates.set(key, marketQuote(name, cents, { cached: true, cachedAt: 1234 }));
            ctx.marketStates.set(key, { state: 'ready', error: '' });
            const report = buildReport(ctx);
            const diagnostic = report.items[0];
            assert.equal(report.schemaVersion, 2);
            assert.equal(diagnostic.market.eligible, true, name);
            assert.equal(diagnostic.fingerprints.market.computed, proof);
            assert.equal(diagnostic.fingerprints.market.provided, native ? null : proof);
            assert.deepEqual(diagnostic.price, { cents, source: 'steam-market', totalCents: cents, currency: 'USD' });
            assert.deepEqual(diagnostic.matches.market, { present: true, cents });
            assert.equal(diagnostic.reason.code, 'price-known');
            assert.equal(diagnostic.market.quote.source, 'steam-market');
            assert.equal(diagnostic.market.quote.currency, 'USD');
            assert.equal(diagnostic.market.quote.cached, true);
            assert.equal(diagnostic.market.quote.cachedAt, 1234);
            assert.equal(diagnostic.classProof.count, 0);
            assert.equal(diagnostic.identity.assetId, null);
            assert.equal(record.assetId, undefined);
        }
    }
});

test('diagnostics expose Market loading, errors and no quote while keeping empty current-owner class evidence', () => {
    const name = 'Inscribed Demon Eater - Head';
    const record = item({ market_hash_name: name, marketable: true, hasGems: true,
        marketFingerprint: Prices.marketFingerprint(marketDescription(name)) });
    const ctx = context(record);
    ctx.classAssetProofs.set(OWNER + ':5000:0', []);
    for (const [state, reason] of [['loading', 'steam-market-loading'], ['error', 'steam-market-error'], ['ready', 'steam-market-no-quote']]) {
        ctx.marketStates.set(name.toLowerCase(), { state, error: state === 'error' ? 'Steam Market returned HTTP 429.' : '' });
        const report = buildReport(ctx).items[0];
        assert.equal(report.reason.code, reason);
        assert.equal(report.market.state, state);
        assert.equal(report.classProof.present, true);
        assert.equal(report.classProof.count, 0);
        assert.equal(report.price.cents, null);
        assert.deepEqual(report.matches.market, { present: false });
    }

    ctx.classEstimates.set(OWNER + ':5000:0', null);
    assert.equal(buildReport(ctx).items[0].reason.code, 'class-owner-assets-absent',
        'an explicit class conflict remains a blocker rather than initiating a weaker quote');
});

test('Market diagnostics retain full names and verified quality and never leak unrelated quotes or private quote metadata', () => {
    const name = 'Inscribed Demon Eater - Head';
    const record = item({ market_hash_name: name, marketable: true, hasGems: true,
        marketFingerprint: Prices.marketFingerprint(marketDescription(name)) });
    const ctx = context(record);
    ctx.classAssetProofs.set(OWNER + ':5000:0', []);
    ctx.marketStates.set(name.toLowerCase(), { state: 'error', error:
        '{"sessionid":"MARKET_STATE_SECRET", "url":"https://steamcommunity.com/market/priceoverview/?token=STATE_URL_SECRET"}' });
    ctx.marketEstimates.set('inscribed demon eater', marketQuote('Inscribed Demon Eater', 1777, { unrelated: 'UNRELATED_QUOTE_SECRET' }));
    let diagnostic = buildReport(ctx).items[0];
    assert.equal(diagnostic.reason.code, 'steam-market-error');
    assert.equal(diagnostic.price.cents, null, 'the full Arcana quote cannot price its Head item');
    assert.deepEqual(diagnostic.matches.market, { present: false });

    ctx.marketEstimates.set(name.toLowerCase(), marketQuote(name, 209, { cached: true, cachedAt: 123,
        error: '{"token":"MARKET_QUOTE_SECRET", "cookie":"sessionid=QUOTE_COOKIE_SECRET"}',
        cookies: 'QUOTE_COOKIE_SECRET', sessionId: 'QUOTE_SESSION_SECRET', rawResponse: 'QUOTE_RAW_SECRET',
        url: 'https://steamcommunity.com/market/priceoverview/?token=QUOTE_URL_SECRET' }));
    const json = JSON.stringify(buildReport(ctx));
    for (const secret of ['MARKET_STATE_SECRET', 'STATE_URL_SECRET', 'UNRELATED_QUOTE_SECRET', 'MARKET_QUOTE_SECRET',
        'QUOTE_COOKIE_SECRET', 'QUOTE_SESSION_SECRET', 'QUOTE_RAW_SECRET', 'QUOTE_URL_SECRET']) {
        assert.equal(json.includes(secret), false, secret);
    }
    diagnostic = buildReport(ctx).items[0];
    assert.equal(diagnostic.price.currency, 'USD');
    assert.equal(diagnostic.market.quote.error.includes('[redacted]'), true);

    ctx.marketStates.set(name.toLowerCase(), { state: 'ready', error: '' });
    ctx.marketEstimates.set(name.toLowerCase(), marketQuote('Inscribed Demon Eater', 1777));
    diagnostic = buildReport(ctx).items[0];
    assert.equal(diagnostic.market.eligible, true);
    assert.equal(diagnostic.price.cents, null, 'a quote under the requested key still has to identify the exact Head item');
    assert.deepEqual(diagnostic.matches.market, { present: true, cents: null, invalid: true });
    assert.equal(diagnostic.market.quote.marketHashName, 'inscribed demon eater');
    assert.equal(diagnostic.reason.code, 'steam-market-no-quote');

    ctx.marketEstimates.set(name.toLowerCase(), marketQuote(name, 209));
    record.marketFingerprint = '["steam-market-v1","demon eater - head","standard"]';
    diagnostic = buildReport(ctx).items[0];
    assert.equal(diagnostic.market.eligible, false, 'a different quality and stripped name cannot validate the offered item');
    assert.equal(diagnostic.fingerprints.market.provided, null);
    assert.deepEqual(diagnostic.matches.market, { present: true, cents: 209 }, 'a valid quote cannot supply a missing quality proof');
    assert.equal(diagnostic.price.cents, null);
});
