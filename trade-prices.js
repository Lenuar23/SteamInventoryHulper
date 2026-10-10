/* Owner-specific Dota 2 valuations for trade offer lists and the editor. */
(function (root) {
    'use strict';

    const gems = root.SIHLiteGems || (typeof require === 'function' ? require('./gems.js') : null);
    const MAX_INDEX_ITEMS = 100000;
    const CENT_FIELDS = ['collectorAvgSaleCents', 'collectorLowestAskCents', 'priceCents', 'price_cents', 'scmPriceCents', 'basePriceCents'];
    const DOLLAR_FIELDS = ['price', 'lowest_price', 'cost', 'value'];
    const GEM_CAPABLE_NAME = /\b(?:fractal horns of inner abysm|baby roshan|jumo)\b/i;
    const GEM_QUALITY_NAME = /^(?:unusual|inscribed|autographed|corrupted)\s+/i;
    // Stable Dota gem colors, verified against Steamprice's regular gem table.
    // Prices are always obtained from the owner's API inventory, never this table.
    const REGULAR_COLORS = new Map([
        ['blue', '0,151,206'], ['cursed black', '6,6,6'], ["champion's green", '21,165,21'],
        ['ships in the night', '25,25,112'], ['crystalline blue', '26,61,133'], ['glacial flow', '50,171,220'],
        ['deep green', '55,134,77'], ['deep blue', '61,104,196'], ['sea green', '74,183,141'],
        ["champion's blue", '80,125,254'], ['verdant green', '81,179,80'], ['earth green', '90,195,85'],
        ['plague grey', '98,110,91'], ['dungeon doom', '123,104,238'], ["champion's purple", '127,72,195'],
        ['unhallowed ground', '128,128,0'], ['purple', '130,50,207'], ['bright purple', '130,50,237'],
        ['placid blue', '148,202,208'], ['bright green', '161,255,89'], ['light green', '183,207,51'],
        ["tnim s'nnam", '188,221,179'], ['dredge earth', '189,183,107'], ['miasmatic grey', '192,192,192'],
        ['vermillion renewal', '202,1,35'], ['gold', '207,171,49'], ['red', '208,61,51'],
        ['orange', '208,119,51'], ['rubiline', '209,31,161'], ['pristine platinum', '213,227,245'],
        ['blossom red', '215,96,146'], ["creator's light", '220,242,255'], ['brusque britches beige', '240,230,140'],
        ['diretide orange', '247,157,0'], ["reflection's shade", '255,60,40'], ['defensive red', '255,66,0'],
        ['pyroclastic flow', '255,120,50'], ['explosive burst', '255,175,0'], ['plushy shag', '255,193,220'],
        ['ember flame', '255,198,4'], ['midas gold', '255,202,21'], ['summer warmth', '255,238,188']
    ]);
    const VARIANT_FALSE_FLAGS = ['allStylesUnlocked', 'mayBeGiftedOnce', 'favored', 'unusualQuality',
        'isBuggedEthereal', 'isOtherBug', 'isGolden', 'isCrimson', 'emptyEthereal', 'emptyPrismatic',
        'isUnusualCourier', 'hasAllStyleCourier', 'hasUnusualEffect', 'isCollectorBundle',
        'canGiftCollectorBundle', 'unpackGiftCollectorBundle', 'pbrCycled'];
    const VARIANT_NULL_FIELDS = ['styleTotal', 'styleUnlocked', 'gem', 'paintSeed', 'wearRating', 'stickers',
        'infuser', 'roshanCycle', 'expirationDate', 'greevil', 'collectorSetPiece'];
    const cleanName = name => name.toLowerCase()
        .replace(/^(inscribed|autographed|corrupted|frozen|heroic|cursed|genuine|favored|ascent|elder|unusual|exalted|infused|auspicious|base|legacy|sealed)\s+/i, '')
        .replace(/\s+(bundle|set)$/i, '').trim();

    function ownerId(value) {
        return typeof value === 'string' && /^\d{17}$/.test(value) ? value : null;
    }

    function assetId(item) {
        const value = item?.assetId ?? item?.assetid ?? item?.asset_id ?? item?.id;
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
        return /^\d{1,20}$/.test(String(value)) ? String(value) : null;
    }

    function appId(item) {
        return item?.appId ?? item?.appid ?? item?.description?.appid;
    }

    function contextId(item) {
        for (const key of ['contextId', 'contextid', 'context_id']) {
            if (item && Object.prototype.hasOwnProperty.call(item, key)) return item[key];
        }
        return item?.description?.contextid;
    }

    function canonicalName(item) {
        const value = item?.marketHashName || item?.market_hash_name || item?.description?.market_hash_name;
        return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512
            ? value.trim().toLowerCase() : '';
    }

    function parsePrice(item) {
        for (const key of CENT_FIELDS) {
            const value = item[key];
            if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') continue;
            const number = Number(value);
            if (number >= 0 && Number.isSafeInteger(Math.round(number))) return Math.round(number);
        }
        for (const key of DOLLAR_FIELDS) {
            const value = item[key];
            if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') continue;
            if (typeof value === 'string' && value.includes('-')) continue;
            const cleaned = typeof value === 'string' ? value.replace(/[^0-9.,]/g, '').replace(',', '.') : value;
            if (cleaned === '') continue;
            const number = Number(cleaned);
            if (number >= 0 && Number.isSafeInteger(Math.round(number * 100))) return Math.round(number * 100);
        }
        return null;
    }

    function unsafeNameFallback(item, name, apiRecord = false) {
        if (GEM_CAPABLE_NAME.test(name) || GEM_QUALITY_NAME.test(name) || item.hasGems === true || item.hasColoredGem === true) return true;
        const info = apiRecord ? gems?.analyzeSteampriceItem(item) : gems?.analyzeSteamAsset(item);
        if (info?.hasGems) return true;
        // These fields also protect callers that have already reduced a native
        // description to the bridge's structured gem metadata.
        return ['gems', 'prismaticGems', 'etherealGems', 'kineticGems', 'unusualEffectGems']
            .some(key => Array.isArray(item[key]) && item[key].length > 0);
    }

    function storePrice(map, key, cents) {
        // A conflicting alias cannot choose a price by API pagination order.
        if (!map.has(key)) map.set(key, cents);
        else if (map.get(key) !== cents) map.set(key, null);
    }

    function variantQuality(item, apiRecord) {
        const description = item?.description && typeof item.description === 'object' ? item.description : item;
        const tags = apiRecord ? (item.rawTags || item.tags) : description?.tags;
        const qualities = (Array.isArray(tags) ? tags : []).filter(tag => tag && String(tag.category).toLowerCase() === 'quality');
        if (qualities.length > 1) return null;
        const name = canonicalName(item);
        const raw = String(qualities[0]?.internal_name || '').toLowerCase();
        let quality = raw === 'unique' ? 'standard' : raw;
        if (!quality && apiRecord) {
            // This identifies the key to invalidate for an incomplete API row.
            // eligibleVariant still requires all three quality fields to agree.
            quality = String(item.assetQuality || item.quality || '').toLowerCase();
        }
        if (!quality && !apiRecord) {
            // The public class hover often omits tags. Its canonical market
            // name and fixed quality color must both identify the same quality.
            const color = String(description.name_color || '').toLowerCase();
            if (name === 'fractal horns of inner abysm' && color === 'd2d2d2') quality = 'standard';
            else if (name === 'exalted fractal horns of inner abysm' && color === 'cccccc') quality = 'exalted';
        }
        // Runes, counters, and unusual bugged items need more evidence than a
        // class hover provides. This fallback deliberately supports only these.
        if (!['standard', 'exalted'].includes(quality)) return null;
        const prefix = /^(exalted|standard)\s+/.exec(name);
        if (prefix && prefix[1] !== quality) return null;
        return name.replace(/^(?:exalted|standard)\s+/, '') === 'fractal horns of inner abysm' ? quality : null;
    }

    function rgbChannels(value) {
        return value && [value.r, value.g, value.b].every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)
            ? [value.r, value.g, value.b] : null;
    }

    function variantCore(item, apiRecord) {
        const quality = variantQuality(item, apiRecord);
        if (!quality) return null;
        const info = apiRecord ? gems?.analyzeSteampriceItem(item) : gems?.analyzeSteamAsset(item);
        if (!info || info.prismaticGems.length !== 1) return null;
        const gem = info.prismaticGems[0];
        const name = String(gem.name).trim().toLowerCase();
        const legacy = /^legacy\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(name);
        let channels;
        if (legacy) {
            channels = legacy.slice(1).map(Number);
            if (!channels.every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)) return null;
            const color = rgbChannels(gem.color);
            if (!color || color.join(',') !== channels.join(',')) return null;
        } else {
            const normalized = name === 'глубокий синий' ? 'deep blue' : name;
            const expected = REGULAR_COLORS.get(normalized);
            if (!expected) return null;
            channels = expected.split(',').map(Number);
            if (!apiRecord && rgbChannels(gem.color)?.join(',') !== expected) return null;
        }
        return { key: JSON.stringify(['tb-v1', quality, legacy ? 'legacy' : 'regular', ...channels]), info, legacy: Boolean(legacy) };
    }

    function eligibleVariant(item, core, apiRecord) {
        if (!core || core.info.gems.length !== 1 || core.info.etherealGems.length || core.info.kineticGems.length) return false;
        if (apiRecord) {
            const quality = JSON.parse(core.key)[1];
            const qualities = (Array.isArray(item.rawTags || item.tags) ? item.rawTags || item.tags : [])
                .filter(tag => tag && String(tag.category).toLowerCase() === 'quality');
            if (qualities.length !== 1 || ![item.assetQuality, item.quality].every(value =>
                typeof value === 'string' && value.toLowerCase() === quality)) return false;
            const rawQuality = String(qualities[0].internal_name || '').toLowerCase();
            if ((rawQuality === 'unique' ? 'standard' : rawQuality) !== quality) return false;
            if (VARIANT_FALSE_FLAGS.some(key => item[key] !== false) || VARIANT_NULL_FIELDS.some(key => item[key] !== null) ||
                item.emptySockets !== 0 || item.spectatorGames !== 0 || item.tradable !== true || item.marketable !== true) return false;
            if (item.gems != null && (!Array.isArray(item.gems) || item.gems.length > 0)) return false;
            if (['etherealGems', 'kineticGems', 'unusualEffectGems'].some(key => !Array.isArray(item[key]) || item[key].length)) return false;
            if (core.legacy) {
                if (item.isLegacy !== true || rgbChannels(item.legacyRgb)?.join(',') !== JSON.parse(core.key).slice(3).join(',') ||
                    item.legacyPricing?.isDupe !== false || item.legacyPricing?.dupeCount !== 0) return false;
            } else if (item.isLegacy !== false || item.legacyRgb !== null || item.legacyPricing !== null) return false;
            return true;
        }
        const description = item?.description && typeof item.description === 'object' ? item.description : item;
        if (description.tradable === false || description.marketable === false) return false;
        // An unparsed occupied socket must not disappear from a fingerprint.
        // The class endpoint is requested in English; translated labels are
        // handled by gems.js's stable icon parsing, including Russian Deep Blue.
        const entries = description.descriptions;
        if (!Array.isArray(entries)) return false;
        let occupied = 0;
        for (const entry of entries) {
            if (typeof entry?.value !== 'string') continue;
            const text = entry.value.replace(/<[^>]*>/g, ' ');
            if (/\b(?:style|styles|rune|autograph|charge|bugged|gifted)\b/i.test(text)) return false;
            const icons = entry.value.match(/\/econ\/sockets\/gem_[a-z0-9_]+(?=[.?/])/gi) || [];
            for (const icon of icons) {
                if (/gem_empty|gem_color_mask/i.test(icon)) continue;
                if (!/gem_color$/i.test(icon)) return false;
                occupied++;
            }
            if (/gem_empty/i.test(entry.value)) return false;
            if (core.legacy) {
                const pairs = /<span\b([^>]*)>\s*Legacy\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*<\/span/gi;
                let pair;
                while ((pair = pairs.exec(entry.value))) {
                    const css = /color\s*:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(pair[1]);
                    if (!css || css.slice(1).map(Number).join(',') !== pair.slice(2).map(Number).join(',')) return false;
                }
            }
        }
        return occupied === 1;
    }

    function variantFingerprint(item, apiRecord = false) {
        const core = variantCore(item, apiRecord);
        return eligibleVariant(item, core, apiRecord) ? core.key : null;
    }

    function verifiedFingerprint(value) {
        if (typeof value !== 'string' || value.length > 160) return null;
        try {
            const parts = JSON.parse(value);
            if (!Array.isArray(parts) || parts.length !== 6 || parts[0] !== 'tb-v1' ||
                !['standard', 'exalted'].includes(parts[1]) || !['legacy', 'regular'].includes(parts[2]) ||
                !parts.slice(3).every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255) ||
                (parts[2] === 'regular' && ![...REGULAR_COLORS.values()].includes(parts.slice(3).join(',')))) return null;
            return JSON.stringify(parts);
        } catch (_) { return null; }
    }

    function buildIndex(apiItems, ownerSteamId) {
        if (!Array.isArray(apiItems)) throw new TypeError('Price items must be an array.');
        if (apiItems.length > MAX_INDEX_ITEMS) throw new RangeError('Steamprice inventory exceeds the supported 100000 price items.');
        if (ownerSteamId !== undefined && !ownerId(ownerSteamId)) {
            throw new TypeError('A valid inventory owner SteamID64 is required.');
        }
        const index = { ownerSteamId: ownerSteamId || null, assetPrices: new Map(), exactNames: new Map(), cleanNames: new Map(), variants: new Map() };
        for (const item of apiItems) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const owner = ownerId(ownerSteamId ?? item.ownerSteamId);
            const context = contextId(item);
            if (!owner || (appId(item) !== undefined && String(appId(item)) !== '570') ||
                (context !== undefined && String(context) !== '2')) continue;
            const core = variantCore(item, true);
            if (core) {
                // Incomplete or exceptional candidates poison the estimate too;
                // a different API row must never silently choose its price.
                const fullPrice = item.priceCents ?? item.price_cents;
                const cents = ['number', 'string'].includes(typeof fullPrice) && String(fullPrice).trim() !== '' &&
                    Number.isSafeInteger(Number(fullPrice)) && Number(fullPrice) >= 0 ? Number(fullPrice) : null;
                storePrice(index.variants, `${owner}:${core.key}`, eligibleVariant(item, core, true) ? cents : null);
            }
            const cents = parsePrice(item);
            if (cents === null) continue;
            const asset = assetId(item);
            if (asset) storePrice(index.assetPrices, `${owner}:${asset}`, cents);
            const name = canonicalName(item);
            if (!name || unsafeNameFallback(item, name, true)) continue;
            storePrice(index.exactNames, `${owner}:${name}`, cents);
            const cleaned = cleanName(name);
            if (cleaned) storePrice(index.cleanNames, `${owner}:${cleaned}`, cents);
        }
        return index;
    }

    function getPrice(index, item) {
        const unknown = { cents: null, source: 'unknown' };
        if (!item || typeof item !== 'object') return unknown;
        const app = appId(item);
        if (app !== undefined && String(app) !== '570') return { cents: null, source: 'non-dota' };
        if (app === undefined) return unknown;
        const context = contextId(item);
        if (item.isCurrency === true || item.is_currency === true ||
            (context !== undefined && String(context) !== '2')) return unknown;
        const owner = ownerId(item.ownerSteamId);
        if (!owner || !index?.assetPrices || !index.exactNames || !index.cleanNames) return unknown;
        const asset = assetId(item);
        if (asset && index.assetPrices.has(`${owner}:${asset}`)) {
            const cents = index.assetPrices.get(`${owner}:${asset}`);
            return cents === null ? unknown : { cents, source: 'asset' };
        }
        const name = canonicalName(item);
        const bareModel = name.replace(/^(?:exalted|standard)\s+/, '');
        let fingerprint = bareModel === 'fractal horns of inner abysm'
            ? verifiedFingerprint(item.variantFingerprint) || variantFingerprint(item) : null;
        const namedQuality = /^(exalted|standard)\s+/.exec(name)?.[1];
        if (fingerprint && namedQuality && JSON.parse(fingerprint)[1] !== namedQuality) fingerprint = null;
        if (fingerprint && index.variants?.has(`${owner}:${fingerprint}`)) {
            const cents = index.variants.get(`${owner}:${fingerprint}`);
            return cents === null ? unknown : { cents, source: 'variant' };
        }
        if (!name || unsafeNameFallback(item, name)) return unknown;
        const exact = `${owner}:${name}`;
        if (index.exactNames.has(exact)) {
            const cents = index.exactNames.get(exact);
            return cents === null ? unknown : { cents, source: 'name' };
        }
        const cleaned = `${owner}:${cleanName(name)}`;
        if (index.cleanNames.has(cleaned)) {
            const cents = index.cleanNames.get(cleaned);
            return cents === null ? unknown : { cents, source: 'clean-name' };
        }
        return unknown;
    }

    function amountFor(item) {
        if (item?.amount === undefined) return 1;
        const value = item.amount;
        if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
        const amount = Number(value);
        return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
    }

    function summarize(items, index) {
        if (!Array.isArray(items)) throw new TypeError('Trade items must be an array.');
        let knownCents = 0, pricedCount = 0, unpricedCount = 0, nonDotaCount = 0, estimatedCount = 0;
        for (const item of items) {
            const price = getPrice(index, item);
            const amount = amountFor(item);
            const value = price.cents !== null && amount !== null ? price.cents * amount : null;
            if (price.source === 'non-dota') nonDotaCount++;
            if (value === null || !Number.isSafeInteger(value) || !Number.isSafeInteger(knownCents + value)) {
                unpricedCount++;
            } else {
                knownCents += value;
                pricedCount++;
                if (price.source === 'variant') estimatedCount++;
            }
        }
        return { knownCents, itemCount: items.length, pricedCount, unpricedCount, nonDotaCount, estimatedCount, complete: unpricedCount === 0 };
    }

    function difference(give, receive) {
        if (!give || !receive || !Number.isSafeInteger(give.knownCents) || give.knownCents < 0 ||
            !Number.isSafeInteger(receive.knownCents) || receive.knownCents < 0) {
            return { knownCents: null, cents: null, complete: false };
        }
        const knownCents = receive.knownCents - give.knownCents;
        const complete = give.complete === true && receive.complete === true;
        return { knownCents, cents: complete ? knownCents : null, complete };
    }

    const api = { buildIndex, getPrice, summarize, difference, variantFingerprint };
    root.SIHLiteTradePrices = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
