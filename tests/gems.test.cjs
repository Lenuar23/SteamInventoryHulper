const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { analyzeSteamAsset, analyzeSteampriceItem, makeViewerUrl } = require('../gems.js');

// Small sanitized excerpts of live Steam market socket HTML, fetched from
// /market/listings/570/Unusual%20Baby%20Roshan and Inscribed%20Dragonclaw%20Hook.
// Socket sprite paths, span structure, names, types, and RGB values are retained.
const ETHEREAL_ROW = '<div style="white-space: nowrap; padding: 3px;"><div><div style="border: 2px solid rgb(255, 255, 255)"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_effect.hash.png)"></div></div></div><div><span style="font-size: 18px; color: rgb(255, 255, 255)">Diretide Corruption</span><br><span style="font-size: 12px">Ethereal Gem</span></div></div>';
const PRISMATIC_ROW = '<div style="white-space: nowrap; padding: 3px;"><div><div style="border: 2px solid rgb(161, 255, 89)"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color.hash.png)"></div><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_color_mask.hash.png)"></div></div></div><div><span style="font-size: 18px; color: rgb(161, 255, 89)">Bright Green</span><br><span style="font-size: 12px">Prismatic Gem</span></div></div>';
const EMPTY_ROW = '<div style="white-space: nowrap; padding: 3px;"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_stat_empty.hash.png)"></div><div><span style="font-size: 18px; color: rgb(255, 255, 255)">Empty Socket</span><br><span style="font-size: 12px">General</span></div></div>';
const INSCRIBED_ROW = '<div style="white-space: nowrap; padding: 3px;"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_stat.hash.png)"></div><div><span style="font-size: 18px; color: rgb(255, 255, 255)">Flesh Heap Total: 6102</span><br><span style="font-size: 12px">Inscribed Gem</span></div></div>';
const SPECTATOR_ROW = '<div style="white-space: nowrap; padding: 3px;"><div style="background-image: url(https://cdn.steamstatic.com/apps/570/icons/econ/sockets/gem_spectator.hash.png)"></div><div><span style="font-size: 18px; color: rgb(255, 255, 255)">DK</span><br><span style="font-size: 12px">Games Watched: 1</span></div></div>';

function steamAsset(html, overrides = {}) {
    return { assetid: '123', description: {
        name: 'Unusual Baby Roshan', market_hash_name: 'Unusual Baby Roshan', type: 'Legendary Courier',
        descriptions: [{ type: 'html', value: `<div style="white-space: nowrap; margin: 10px">${html}</div>` }],
        ...overrides
    } };
}

test('native socket rows distinguish effect and color gems without double-counting layered icons', () => {
    const info = analyzeSteamAsset(steamAsset(ETHEREAL_ROW + PRISMATIC_ROW));
    assert.equal(info.hasGems, true);
    assert.equal(info.hasColoredGem, true);
    assert.equal(info.gems.length, 2);
    assert.deepEqual(info.etherealGems, [{ name: 'Diretide Corruption', type: 'Ethereal Gem', color: null }]);
    assert.deepEqual(info.prismaticGems, [{ name: 'Bright Green', type: 'Prismatic Gem', color: { r: 161, g: 255, b: 89 } }]);
    assert.equal(info.isLegacy, false);
    assert.equal(info.legacyRgb, null);
});

test('Russian regular Deep Blue sockets retain exact RGB and produce a regular viewer link', () => {
    const html = PRISMATIC_ROW.replaceAll('161, 255, 89', '61, 104, 196')
        .replace('Bright Green', 'Глубокий синий').replace('Prismatic Gem', 'Призматический самоцвет');
    const info = analyzeSteamAsset(steamAsset(html, {
        market_hash_name: 'Exalted Fractal Horns of Inner Abysm', type: 'Демонические рога, Arcana'
    }));
    assert.equal(info.hasColoredGem, true);
    assert.equal(info.isLegacy, false);
    assert.deepEqual(info.prismaticGems, [{ name: 'Глубокий синий', type: 'Prismatic Gem', color: { r: 61, g: 104, b: 196 } }]);
    const url = new URL(makeViewerUrl('Exalted Fractal Horns of Inner Abysm', info));
    assert.equal(url.searchParams.get('kind'), 'regular');
    assert.equal(url.searchParams.get('model'), 'TB');
    assert.deepEqual(['r', 'g', 'b'].map(key => Number(url.searchParams.get(key))), [61, 104, 196]);
});

test('socket icons classify localized Prismatic and Ethereal gems without relying on translated labels', () => {
    for (const [prismatic, ethereal] of [
        ['Призматический самоцвет', 'Потусторонний самоцвет'],
        ['Prismatischer Edelstein', 'Ätherischer Edelstein'],
        ['棱彩宝石', '虚灵宝石']
    ]) {
        const html = PRISMATIC_ROW.replace('Prismatic Gem', prismatic) + ETHEREAL_ROW.replace('Ethereal Gem', ethereal);
        const info = analyzeSteamAsset(steamAsset(html));
        assert.equal(info.gems.length, 2);
        assert.equal(info.prismaticGems[0].type, 'Prismatic Gem');
        assert.equal(info.etherealGems[0].type, 'Ethereal Gem');
        assert.equal(info.etherealGems[0].color, null, 'effect gem white text is not a Prismatic color');
    }
});

test('localized ordinary sockets count without becoming colored, while localized empty and loose gems remain excluded', () => {
    const inscribed = INSCRIBED_ROW.replace('Inscribed Gem', 'Надпись').replace('Flesh Heap Total: 6102', 'Заряды Flesh Heap: 6102');
    const kinetic = INSCRIBED_ROW.replaceAll('gem_stat', 'gem_kinetic').replace('Inscribed Gem', 'Кинетический самоцвет');
    const spectator = SPECTATOR_ROW.replace('Games Watched: 1', 'Просмотрено игр: 1');
    const empty = EMPTY_ROW.replace('Empty Socket', 'Пустое гнездо').replace('General', 'Общий');
    const info = analyzeSteamAsset(steamAsset(inscribed + kinetic + spectator + empty));
    assert.equal(info.hasGems, true);
    assert.equal(info.hasColoredGem, false);
    assert.equal(info.gems.length, 3);
    assert.equal(info.kineticGems[0].type, 'Kinetic Gem');
    assert.equal(analyzeSteamAsset(steamAsset(empty)).hasGems, false);
    assert.equal(analyzeSteamAsset(steamAsset(PRISMATIC_ROW, {
        market_hash_name: 'Необычное локализованное название', type: 'Самоцвет / Руна',
        rawTags: [], tags: [{ category: 'Тип', internal_name: 'socket_gem', localized_tag_name: 'Самоцвет / Руна' }]
    })).hasGems, false, 'internal socket_gem tag excludes loose gems independently of language');
    assert.equal(analyzeSteamAsset(steamAsset(PRISMATIC_ROW.replaceAll('gem_color.hash', 'gem_color_mask.hash'))).hasGems, false,
        'a decorative color mask alone does not establish an occupied socket');
});

test('unknown and noncolored socket icons cannot become colored gems through their labels', () => {
    for (const html of [
        PRISMATIC_ROW.replace('gem_color.hash', 'gem_unrecognized.hash'),
        PRISMATIC_ROW.replace('gem_color.hash', 'gem_stat.hash'),
        ETHEREAL_ROW.replace('gem_effect.hash', 'gem_stat.hash')
    ]) {
        const info = analyzeSteamAsset(steamAsset(html));
        assert.equal(info.hasGems, true);
        assert.equal(info.hasColoredGem, false);
        assert.deepEqual(info.prismaticGems, []);
        assert.deepEqual(info.etherealGems, []);
        assert.equal(info.gems[0].color, null);
        assert.equal(makeViewerUrl('Platinum Baby Roshan', info), null);
    }
});

test('empty sockets never count, including when placed after an occupied socket', () => {
    for (const html of [EMPTY_ROW, ETHEREAL_ROW + EMPTY_ROW, EMPTY_ROW + ETHEREAL_ROW]) {
        const info = analyzeSteamAsset(steamAsset(html));
        assert.equal(info.gems.length, html === EMPTY_ROW ? 0 : 1);
        assert.ok(info.gems.every(gem => gem.name !== 'Empty Socket'));
    }
    const disguised = EMPTY_ROW.replace('Empty Socket', 'Victories: 42').replace('General', 'Inscribed Gem');
    assert.equal(analyzeSteamAsset(steamAsset(disguised)).hasGems, false, 'empty sprite is insufficient even with a gem label');
});

test('inscribed, kinetic, autograph, and spectator sockets are installed gems but are not colored gems', () => {
    const kinetic = INSCRIBED_ROW.replaceAll('gem_stat', 'gem_kinetic').replace('Flesh Heap Total: 6102', 'Fireborn Assault').replace('Inscribed Gem', 'Kinetic Gem');
    const autograph = INSCRIBED_ROW.replaceAll('gem_stat', 'gem_autograph').replace('Flesh Heap Total: 6102', 'Dendi').replace('Inscribed Gem', 'Autograph Rune');
    const info = analyzeSteamAsset(steamAsset(INSCRIBED_ROW + kinetic + autograph + SPECTATOR_ROW));
    assert.equal(info.hasGems, true);
    assert.equal(info.hasColoredGem, false);
    assert.equal(info.gems.length, 4);
    assert.equal(info.kineticGems[0].name, 'Fireborn Assault');
    assert.deepEqual(info.gems.at(-1), { name: 'DK', type: 'Games Watched: 1', color: null });
});

test('quality prefixes, item capabilities, and descriptive text do not imply installed gems', () => {
    for (const name of ['Inscribed Dragonclaw Hook', 'Unusual Baby Roshan', 'Fractal Horns of Inner Abysm']) {
        const info = analyzeSteamAsset(steamAsset('', { name, market_hash_name: name }));
        assert.equal(info.hasGems, false);
    }
    const text = '<span>Bright Green</span><br><span>Prismatic Gem</span> can be inserted into a socket.';
    assert.equal(analyzeSteamAsset(steamAsset(text)).hasGems, false);
});

test('loose gems are excluded even if descriptions and API arrays resemble installed gem metadata', () => {
    for (const overrides of [
        { type: 'Rare Prismatic Gem' },
        { type: 'Gem / Rune' },
        { tags: [{ category: 'Type', internal_name: 'socket_gem', localized_tag_name: 'Gem / Rune' }] },
        { market_hash_name: 'Prismatic: Bright Green' },
        { market_hash_name: 'Ethereal: Ionic Vapor' },
        { market_hash_name: 'Kinetic: Fireborn Assault' }
    ]) {
        assert.equal(analyzeSteamAsset(steamAsset(PRISMATIC_ROW, overrides)).hasGems, false);
    }
    const loose = analyzeSteampriceItem({ marketHashName: 'Ethereal: Ionic Vapor', itemType: 'Gem / Rune',
        rawTags: [{ category: 'Type', internal_name: 'socket_gem' }], etherealGems: ['Ionic Vapor'] });
    assert.equal(loose.hasGems, false);
    assert.equal(loose.hasColoredGem, false);
    assert.deepEqual(loose.etherealGems, []);
});

test('Prismatic RGB comes from its name span and rejects invalid channels or border-only colors', () => {
    const borderChanged = PRISMATIC_ROW.replace('border: 2px solid rgb(161, 255, 89)', 'border: 2px solid rgb(255, 255, 255)');
    assert.deepEqual(analyzeSteamAsset(steamAsset(borderChanged)).prismaticGems[0].color, { r: 161, g: 255, b: 89 });
    for (const value of ['rgb(256, 2, 3)', 'rgb(-1, 2, 3)', 'rgb(1.5, 2, 3)', 'inherit']) {
        const html = PRISMATIC_ROW.replace('font-size: 18px; color: rgb(161, 255, 89)', `font-size: 18px; color: ${value}`);
        const info = analyzeSteamAsset(steamAsset(html));
        assert.equal(info.prismaticGems[0].color, null);
        assert.equal(makeViewerUrl('Platinum Baby Roshan', info), null);
    }
    assert.equal(analyzeSteamAsset(steamAsset(PRISMATIC_ROW.replace('; color: rgb(161, 255, 89)', ''))).prismaticGems[0].color, null);
});

test('HTML entities and Steam escaped apostrophes are decoded as text', () => {
    const html = ETHEREAL_ROW.replace('Diretide Corruption', 'Champion\\\'s Aura &amp; Flame &#39;2014&#39;');
    assert.equal(analyzeSteamAsset(steamAsset(html)).etherealGems[0].name, "Champion's Aura & Flame '2014'");
    const escapedAttributes = PRISMATIC_ROW.replaceAll('"', '\\"');
    assert.deepEqual(analyzeSteamAsset(steamAsset(escapedAttributes)).prismaticGems[0].color, { r: 161, g: 255, b: 89 });
});

test('Legacy RGB is normalized from an installed Prismatic name or verified API metadata', () => {
    const html = PRISMATIC_ROW.replaceAll('161, 255, 89', '230, 155, 253').replace('Bright Green', 'Legacy (230, 155, 253)');
    const native = analyzeSteamAsset(steamAsset(html));
    assert.equal(native.isLegacy, true);
    assert.deepEqual(native.legacyRgb, { r: 230, g: 155, b: 253 });
    const api = analyzeSteampriceItem({ marketHashName: 'Unusual Platinum Baby Roshan',
        prismaticGems: ['Legacy (230, 155, 253)'], isLegacy: true,
        legacyRgb: { r: 230, g: 155, b: 253, sum: 638 } });
    assert.deepEqual(api.legacyRgb, native.legacyRgb);
    assert.deepEqual(api.prismaticGems[0].color, native.prismaticGems[0].color);
    assert.equal(api.isLegacy, true);
});

test('Steamprice uses actual gem arrays, preserves effects, and rejects malformed entries', () => {
    const info = analyzeSteampriceItem({ marketHashName: 'Unusual Platinum Baby Roshan',
        prismaticGems: ['Pyroclastic Flow', '', null, {}, 'Empty Socket'],
        etherealGems: ['Ionic Vapor'], kineticGems: ['Fireborn Assault'], unusualEffectGems: ['Ravenblight'],
        isLegacy: false, legacyRgb: null });
    assert.equal(info.hasGems, true);
    assert.equal(info.hasColoredGem, true);
    assert.equal(info.gems.length, 4);
    assert.equal(info.prismaticGems[0].color, null, 'regular API names alone supply no RGB');
    assert.equal(info.kineticGems[0].name, 'Fireborn Assault');
    assert.equal(info.gems.at(-1).type, 'Unusual Effect Gem');
    assert.equal(analyzeSteampriceItem({ unusualEffectGems: ['Ravenblight'] }).hasColoredGem, false);
    assert.equal(analyzeSteampriceItem({ isLegacy: true, legacyRgb: { r: 1, g: 2, b: 3 } }).hasGems, false);
});

test('viewer links use supported model identifiers, exact RGB, regular/Legacy mode, and effect aliases', () => {
    const regular = analyzeSteamAsset(steamAsset(PRISMATIC_ROW));
    const legacy = analyzeSteampriceItem({ prismaticGems: ['Legacy (230, 155, 253)'], etherealGems: ['Trail of the Burning Doom'], isLegacy: true });
    for (const [name, model] of [
        ['Exalted Fractal Horns of Inner Abysm', 'TB'], ['Unusual Platinum Baby Roshan', 'PBR'],
        ['Golden Baby Roshan', 'GBR'], ['Ice Baby Roshan', 'Ice Baby Roshan'],
        ['Lava Baby Roshan', 'Lava Baby Roshan'], ['Unusual Jumo', 'Jumo']
    ]) {
        const url = new URL(makeViewerUrl(name, regular));
        assert.equal(url.origin, 'https://steamprice.com');
        assert.equal(url.pathname, '/dota2/legacy');
        assert.equal(url.searchParams.get('lv'), '1');
        assert.equal(url.searchParams.get('model'), model);
        assert.equal(url.searchParams.get('kind'), 'regular');
        assert.equal(url.searchParams.get('r'), '161');
        assert.equal(url.searchParams.get('g'), '255');
        assert.equal(url.searchParams.get('b'), '89');
    }
    const url = new URL(makeViewerUrl('Unusual Platinum Baby Roshan', legacy));
    assert.equal(url.searchParams.has('kind'), false);
    assert.equal(url.searchParams.get('effect'), 'TOBD');
    assert.equal(url.searchParams.get('r'), '230');
    assert.equal(url.searchParams.get('b'), '253');
});

test('viewer never guesses a missing color/model or claims an unsupported effect match', () => {
    const regular = analyzeSteamAsset(steamAsset(PRISMATIC_ROW));
    assert.equal(makeViewerUrl('Unusual Baby Roshan', regular), null);
    assert.equal(makeViewerUrl('Dragonclaw Hook', regular), null);
    assert.equal(makeViewerUrl('Prismatic: Platinum Baby Roshan', regular), null);
    assert.equal(makeViewerUrl('Platinum Baby Roshan', analyzeSteampriceItem({ prismaticGems: ['Bright Green'] })), null);
    assert.equal(makeViewerUrl('Platinum Baby Roshan', analyzeSteamAsset(steamAsset(ETHEREAL_ROW))), null);
    for (const effect of ['Diretide Corruption', 'Touch of Frost']) {
        const info = { ...regular, etherealGems: [{ name: effect, type: 'Ethereal Gem', color: null }] };
        assert.equal(new URL(makeViewerUrl('Platinum Baby Roshan', info)).searchParams.has('effect'), false);
    }
    const supported = { ...regular, etherealGems: [{ name: 'Touch of Frost', type: 'Ethereal Gem', color: null }] };
    assert.equal(new URL(makeViewerUrl('Ice Baby Roshan', supported)).searchParams.get('effect'), 'Touch of Frost');
});

test('the helper exposes browser globals and works with Steam Prototype array overrides', () => {
    const context = vm.createContext({ URL });
    vm.runInContext('Array.prototype.toJSON = function () { return "prototype-array"; }; Array.from = function (array) { return Array.prototype.slice.call(array); };', context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gems.js'), 'utf8'), context);
    assert.equal(typeof context.SIHLiteGems.analyzeSteamAsset, 'function');
    assert.equal(typeof context.SIHLiteGems.analyzeSteampriceItem, 'function');
    assert.equal(typeof context.SIHLiteGems.makeViewerUrl, 'function');
    const info = context.SIHLiteGems.analyzeSteamAsset(steamAsset(PRISMATIC_ROW));
    assert.equal(info.prismaticGems.length, 1);
    assert.equal(new URL(context.SIHLiteGems.makeViewerUrl('Platinum Baby Roshan', info)).searchParams.get('r'), '161');
});

test('native analysis is cached by the stable description object', () => {
    const asset = steamAsset(PRISMATIC_ROW);
    assert.strictEqual(analyzeSteamAsset(asset), analyzeSteamAsset({ assetid: '456', description: asset.description }));
});
