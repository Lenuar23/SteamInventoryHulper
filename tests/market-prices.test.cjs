const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { validateName, normalizeQuote } = require('../market-prices.js');

// Live public priceoverview responses verified with appid=570 and currency=1.
const LIVE_QUOTES = [
    ['Inscribed Mecha Boots of Travel Mk III', { success: true, lowest_price: '$1.10', volume: '34', median_price: '$1.12' }, 110],
    ['Autographed Wraithbinder', { success: true, lowest_price: '$1.19', volume: '4', median_price: '$1.19' }, 119],
    ['Inscribed Demon Eater - Head', { success: true, lowest_price: '$2.09', volume: '67', median_price: '$2.05' }, 209],
    ['Inscribed Arms of Desolation', { success: true, lowest_price: '$9.72', volume: '66', median_price: '$9.68' }, 972],
    ['Inscribed Demon Eater', { success: true, lowest_price: '$17.77', volume: '102', median_price: '$17.65' }, 1777]
];
const quote = (lowest_price, extra = {}) => normalizeQuote({ success: true, lowest_price, ...extra }, 'Inscribed Sword');

test('all five verified exact quality and component listing names keep their USD quote identity', () => {
    for (const [marketHashName, payload, priceCents] of LIVE_QUOTES) {
        assert.deepEqual(normalizeQuote(payload, marketHashName), { marketHashName, priceCents,
            currency: 'USD', source: 'steam-market', estimateKind: 'market-name' });
    }
    assert.notEqual(normalizeQuote(LIVE_QUOTES[2][1], LIVE_QUOTES[2][0]).priceCents,
        normalizeQuote(LIVE_QUOTES[4][1], LIVE_QUOTES[4][0]).priceCents, 'a Head quote is distinct from a full Arcana');
});

test('name validation preserves exact quality, capitalization, punctuation, and component suffixes', () => {
    assert.equal(validateName('  Inscribed Demon Eater - Head  '), 'Inscribed Demon Eater - Head');
    assert.equal(validateName("Autographed Captain's Hat"), "Autographed Captain's Hat");
    assert.equal(validateName('Kinetic: Booties of Travel!'), 'Kinetic: Booties of Travel!');
    assert.equal(validateName('A'.repeat(512)).length, 512);
    assert.equal(normalizeQuote({ success: true, lowest_price: '$1.00' }, '  Inscribed Demon Eater - Head ').marketHashName,
        'Inscribed Demon Eater - Head');
});

test('invalid names cannot become URLs, markup, control text, or oversized quote keys', () => {
    for (const value of [null, undefined, 123, {}, [], '', '   ', 'A'.repeat(513), '\nSword', 'Sword\t', 'Sword\x00',
        'Sword\x7f', '<img src=x>', '&lt;img&gt;', 'https://example.test/item', 'steam://market/item', '//example.test',
        'www.example.test', 'javascript:alert(1)', 'data:text/html,sword']) {
        assert.throws(() => validateName(value), /Invalid Steam Market item name/);
        assert.throws(() => normalizeQuote({ success: true, lowest_price: '$1.00' }, value), /Invalid Steam Market item name/);
    }
});

test('explicit dollar and optional USD headers retain exact two-digit cent precision', () => {
    for (const [text, cents] of [['$0.01', 1], ['$1', 100], ['$1.10', 110], ['$1234.56', 123456],
        ['$1,234.56', 123456], ['$12,345,678.90', 1234567890], [' USD $1,234.56 ', 123456],
        ['$1,234.56 USD', 123456], ['$ 1.23', 123]]) {
        assert.equal(quote(text).priceCents, cents, text);
    }
    assert.equal(quote('$1.23', { currency: 'USD' }).priceCents, 123);
    assert.equal(quote('$1.23', { currency: 1 }).priceCents, 123);
});

test('ambiguous currencies, decimals, grouping, ranges, and zero quotes remain unavailable', () => {
    for (const text of [null, undefined, 123, '$0', '$0.00', '0.00', '1.23', 'USD 1.23', '€1.23', '£1.23',
        'CDN$1.23', 'A$1.23', 'US$1.23', '$1.23 CAD', '$1.23 EUR', 'USD $1.23 USD', '$1.23USD',
        '$1,23', '$1,23.45', '$1234,567.89', '$1,234,56', '$01.23', '$1.2', '$1.234', '$1.23 - $2.00',
        '-$1.23', '$-1.23', '$1.23abc', '$1.23\n', '$NaN', '$Infinity', 'R$1,23']) {
        assert.equal(quote(text), null, String(text));
    }
    assert.equal(quote('$1.23', { currency: 'EUR' }), null, 'contradictory explicit response currency is rejected');
});

test('unavailable or unsuccessful responses never use a median, a bare value, or a false zero', () => {
    for (const payload of [null, [], {}, { success: false, lowest_price: '$1.23' },
        { success: 0, lowest_price: '$1.23' }, { success: 'true', lowest_price: '$1.23' },
        { success: '1', lowest_price: '$1.23' }, { success: true, median_price: '$1.23' },
        { success: true, priceCents: 123 }, { success: true, lowest_price: '' }]) {
        assert.equal(normalizeQuote(payload, 'Sword'), null);
    }
    assert.equal(normalizeQuote({ success: 1, lowest_price: '$1.23' }, 'Sword').priceCents, 123);
});

test('safe integer limits use integer cents instead of floating-point price rounding', () => {
    assert.equal(quote('$90071992547409.91').priceCents, Number.MAX_SAFE_INTEGER);
    assert.equal(quote('$90071992547409.92'), null);
    assert.equal(quote('$999999999999999999999999999999999999.99'), null);
    assert.equal(quote('$' + '9'.repeat(129) + '.99'), null);
});

test('normalization does not inherit asset IDs, gems, cache metadata, or mutate the raw payload', () => {
    const payload = { success: true, lowest_price: '$1.23', assetid: '12345', gems: ['Expensive Gem'],
        cached: true, estimated: false, marketHashName: 'Wrong Name' };
    const before = JSON.stringify(payload);
    assert.deepEqual(normalizeQuote(payload, 'Inscribed Sword'), { marketHashName: 'Inscribed Sword', priceCents: 123,
        currency: 'USD', source: 'steam-market', estimateKind: 'market-name' });
    assert.equal(JSON.stringify(payload), before);
});

test('classic service worker global works independently of CommonJS and browser window', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../market-prices.js'), 'utf8'), context);
    const result = context.SIHLiteMarketQuotes.normalizeQuote({ success: true, lowest_price: '$2.09' }, 'Inscribed Demon Eater - Head');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { marketHashName: 'Inscribed Demon Eater - Head', priceCents: 209,
        currency: 'USD', source: 'steam-market', estimateKind: 'market-name' });
});
