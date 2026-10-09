/* Shared gem metadata for Steam's MAIN world and the isolated content script. */
(function (root) {
    'use strict';

    const GEM_PREFIX = /^(?:prismatic|ethereal|kinetic|inscribed|autograph(?:ed)?|ascendant|spectator|foulfell|bloodstone|empowered|unusual effect)\s*:/i;
    const EMPTY_SOCKET = /^empty\s+socket$/i;
    const MAX_HTML_LENGTH = 100000;
    const steamCache = new WeakMap();
    const VIEWER_MODELS = [
        [/\bfractal horns of inner abysm\b/i, 'TB'],
        [/\bplatinum baby roshan\b/i, 'PBR'],
        [/\bgolden baby roshan\b/i, 'GBR'],
        [/\bice baby roshan\b/i, 'Ice Baby Roshan'],
        [/\blava baby roshan\b/i, 'Lava Baby Roshan'],
        [/\bjumo\b/i, 'Jumo']
    ];
    // These names and model-specific effects are supported by Steamprice's viewer.
    const VIEWER_EFFECTS = {
        TB: ['Default'],
        PBR: ['Ionic Vapor', 'TOBD'],
        GBR: ['Ionic Vapor', 'TOBD', 'Touch of Flame'],
        'Ice Baby Roshan': ['Ionic Vapor', 'TOBD', 'Touch of Frost'],
        'Lava Baby Roshan': ['Ionic Vapor', 'TOBD', 'Touch of Flame'],
        Jumo: ['Ionic Vapor', 'TOBD']
    };

    function rgb(value) {
        if (!value || typeof value !== 'object') return null;
        const { r, g, b } = value;
        return [r, g, b].every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)
            ? { r, g, b } : null;
    }

    function legacyColor(name) {
        const match = /^legacy\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(name);
        return match ? rgb({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }) : null;
    }

    function cleanText(value) {
        if (typeof value !== 'string') return '';
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
            if (code[0] !== '#') return named[code.toLowerCase()] || entity;
            const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
            return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
                ? String.fromCodePoint(point) : entity;
        }).replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 512);
    }

    function itemName(item) {
        return cleanText(item?.marketHashName || item?.market_hash_name || item?.market_name || item?.name || '');
    }

    function isLooseGem(item) {
        if (!item || typeof item !== 'object') return false;
        if (GEM_PREFIX.test(itemName(item))) return true;
        const type = cleanText(item.itemType || item.type || '');
        if (/\b(?:gem|rune)\b/i.test(type)) return true;
        const tags = Array.isArray(item.rawTags) ? item.rawTags : Array.isArray(item.tags) ? item.tags : [];
        return tags.some(tag => tag && /^type$/i.test(String(tag.category || '')) &&
            (String(tag.internal_name || '').toLowerCase() === 'socket_gem' ||
                /\b(?:gem|rune)\b/i.test(String(tag.localized_tag_name || ''))));
    }

    function summarize(gems, legacyHint = false, colorHint = null) {
        const prismaticGems = gems.filter(gem => /^prismatic\s+gem$/i.test(gem.type));
        const etherealGems = gems.filter(gem => /^ethereal\s+gem$/i.test(gem.type));
        const kineticGems = gems.filter(gem => /^kinetic\s+gem$/i.test(gem.type));
        const legacyGem = prismaticGems.find(gem => /^legacy\s*\(/i.test(gem.name));
        const isLegacy = prismaticGems.length > 0 && (legacyHint || Boolean(legacyGem));
        const legacyRgb = isLegacy ? rgb(colorHint) || (legacyGem && legacyColor(legacyGem.name)) || null : null;
        if (legacyRgb) {
            const gem = legacyGem || prismaticGems[0];
            gem.color = { ...legacyRgb };
        }
        return {
            hasGems: gems.length > 0,
            hasColoredGem: prismaticGems.length > 0 || etherealGems.length > 0,
            gems, prismaticGems, etherealGems, kineticGems, legacyRgb, isLegacy
        };
    }

    function analyzeSteamAsset(asset) {
        const description = asset?.description && typeof asset.description === 'object' ? asset.description : asset;
        if (!description || typeof description !== 'object') return summarize([]);
        if (steamCache.has(description)) return steamCache.get(description);
        if (isLooseGem(description)) {
            const empty = summarize([]);
            steamCache.set(description, empty);
            return empty;
        }
        const entries = Array.isArray(description.descriptions) ? description.descriptions : [];
        const gems = [];
        for (const entry of entries) {
            if (!entry || typeof entry.value !== 'string' || (entry.type && entry.type !== 'html')) continue;
            const html = entry.value.slice(0, MAX_HTML_LENGTH).replace(/\\"/g, '"');
            if (!/\/econ\/sockets\/gem_/i.test(html)) continue;
            // Steam puts each installed gem's name and type in adjacent spans.
            // Inspect only the icons preceding this pair so an earlier occupied
            // socket cannot make a later empty socket count as an installed gem.
            const pairs = /<span\b([^>]*)>([\s\S]*?)<\/span\s*>\s*<br\s*\/?\s*>\s*<span\b[^>]*>([\s\S]*?)<\/span\s*>/gi;
            let pair;
            let previousEnd = 0;
            while ((pair = pairs.exec(html))) {
                const preceding = html.slice(previousEnd, pair.index);
                previousEnd = pairs.lastIndex;
                const icons = [];
                const iconPattern = /\/econ\/sockets\/(gem_[a-z0-9_]+)(?:\.|[/?])/gi;
                let icon;
                while ((icon = iconPattern.exec(preceding))) icons.push(icon[1].toLowerCase());
                const name = cleanText(pair[2]);
                const type = cleanText(pair[3]);
                if (!icons.length || icons.some(icon => /(?:^|_)empty(?:_|$)/.test(icon)) ||
                    !name || EMPTY_SOCKET.test(name) || !type) continue;
                const spectator = icons.includes('gem_spectator') && /^games\s+watched\s*:/i.test(type);
                if (!/\b(?:gem|rune)\b/i.test(type) && !spectator) continue;
                let color = null;
                if (/^prismatic\s+gem$/i.test(type)) {
                    // Read the name span's text color, never the socket border
                    // or another gem's default white color.
                    const match = /(?:^|[;\s"'])color\s*:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(pair[1]);
                    color = match ? rgb({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }) : null;
                }
                gems.push({ name, type, color });
            }
        }
        const result = summarize(gems);
        steamCache.set(description, result);
        return result;
    }

    function analyzeSteampriceItem(item) {
        if (!item || typeof item !== 'object' || isLooseGem(item)) return summarize([]);
        const gems = [];
        for (const [key, type] of [
            ['prismaticGems', 'Prismatic Gem'], ['etherealGems', 'Ethereal Gem'],
            ['kineticGems', 'Kinetic Gem'], ['unusualEffectGems', 'Unusual Effect Gem']
        ]) {
            if (!Array.isArray(item[key])) continue;
            for (const value of item[key]) {
                const name = cleanText(value);
                if (!name || EMPTY_SOCKET.test(name)) continue;
                gems.push({ name, type, color: type === 'Prismatic Gem' ? legacyColor(name) : null });
            }
        }
        return summarize(gems, item.isLegacy === true, item.legacyRgb);
    }

    function makeViewerUrl(name, gemInfo) {
        if (typeof name !== 'string' || GEM_PREFIX.test(name.trim()) || !gemInfo ||
            !Array.isArray(gemInfo.prismaticGems) || !gemInfo.prismaticGems.length) return null;
        const entry = VIEWER_MODELS.find(([pattern]) => pattern.test(name));
        if (!entry) return null;
        const model = entry[1];
        const color = rgb(gemInfo.legacyRgb) || gemInfo.prismaticGems.map(gem => rgb(gem?.color)).find(Boolean);
        if (!color) return null;
        const url = new URL('https://steamprice.com/dota2/legacy');
        for (const [key, value] of Object.entries({ lv: 1, model, ...color })) url.searchParams.set(key, String(value));
        if (!gemInfo.isLegacy) url.searchParams.set('kind', 'regular');
        for (const gem of Array.isArray(gemInfo.etherealGems) ? gemInfo.etherealGems : []) {
            if (typeof gem?.name !== 'string') continue;
            const effect = /^trail of (?:the )?burning doom$/i.test(gem.name) ? 'TOBD'
                : VIEWER_EFFECTS[model].find(candidate => candidate.toLowerCase() === gem.name.toLowerCase());
            if (effect && VIEWER_EFFECTS[model].includes(effect)) {
                url.searchParams.set('effect', effect);
                break;
            }
        }
        return url.href;
    }

    const api = { analyzeSteamAsset, analyzeSteampriceItem, makeViewerUrl };
    root.SIHLiteGems = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
