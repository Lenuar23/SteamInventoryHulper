/* Owner-specific Dota 2 valuations for trade offer lists and the editor. */
(function (root) {
    'use strict';

    const gems = root.SIHLiteGems || (typeof require === 'function' ? require('./gems.js') : null);
    const MAX_INDEX_ITEMS = 100000;
    const CENT_FIELDS = ['collectorAvgSaleCents', 'collectorLowestAskCents', 'priceCents', 'price_cents', 'scmPriceCents', 'basePriceCents'];
    const DOLLAR_FIELDS = ['price', 'lowest_price', 'cost', 'value'];
    const GEM_CAPABLE_NAME = /\b(?:fractal horns of inner abysm|baby roshan|jumo)\b/i;
    const GEM_QUALITY_NAME = /^(?:unusual|inscribed|autographed|corrupted)\s+/i;
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

    function buildIndex(apiItems, ownerSteamId) {
        if (!Array.isArray(apiItems)) throw new TypeError('Price items must be an array.');
        if (apiItems.length > MAX_INDEX_ITEMS) throw new RangeError('Steamprice inventory exceeds the supported 100000 price items.');
        if (ownerSteamId !== undefined && !ownerId(ownerSteamId)) {
            throw new TypeError('A valid inventory owner SteamID64 is required.');
        }
        const index = { ownerSteamId: ownerSteamId || null, assetPrices: new Map(), exactNames: new Map(), cleanNames: new Map() };
        for (const item of apiItems) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const owner = ownerId(ownerSteamId ?? item.ownerSteamId);
            const context = contextId(item);
            if (!owner || (appId(item) !== undefined && String(appId(item)) !== '570') ||
                (context !== undefined && String(context) !== '2')) continue;
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
        let knownCents = 0, pricedCount = 0, unpricedCount = 0, nonDotaCount = 0;
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
            }
        }
        return { knownCents, itemCount: items.length, pricedCount, unpricedCount, nonDotaCount, complete: unpricedCount === 0 };
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

    const api = { buildIndex, getPrice, summarize, difference };
    root.SIHLiteTradePrices = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
