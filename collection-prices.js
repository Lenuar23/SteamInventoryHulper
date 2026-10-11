/* Compact the public Steamprice Dota 2 collection catalog to ordinary cash prices. */
(function (root) {
    'use strict';

    const MAX_COLLECTIONS = 1000;
    const MAX_ITEMS = 100000;
    const SPECIAL_COLLECTION = /^(?:unusual\b|tb colors$|legacy owner$|baby roshan$|spectator couriers$|max aura greevils$|kinetic$)/i;
    const SPECIAL_NAME = /\b(?:fractal horns of inner abysm|baby roshan|jumo)\b|^(?:unusual|inscribed|autographed|corrupted|heroic|cursed|favored|exalted|legacy)\s+/i;

    function invalidCatalog() {
        return new Error('Steamprice returned an invalid collection catalog.');
    }

    function ordinaryRow(row) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
        if (row.disablePrices !== false || row.fullSet !== false || row.unpackHint !== false || row.dotagiftx !== false) return false;
        if (row.owned !== true && row.owned !== false) return false;
        // For a completed collection entry Steamprice can quote the owner's
        // matching piece or quality instead of the catalog's displayed name.
        // A Pudge back piece must not supply the price of his Arcana, and a
        // Genuine wearable must not supply a Standard wearable's price.
        if (row.owned === true && (typeof row.ownedItemName !== 'string'
            || typeof row.itemName !== 'string'
            || row.ownedItemName.trim().toLowerCase() !== row.itemName.trim().toLowerCase())) return false;
        if (SPECIAL_NAME.test(String(row.itemName || '')) || /courier/i.test(String(row.itemType || ''))) return false;
        if (row.arcanaColor != null || row.kineticCompletion != null || row.infuserName != null) return false;
        if (row.kineticWrongItem || row.infusedWrongItem || row.cashOnly) return false;
        if (row.personaGiftx != null || (Array.isArray(row.personaSets) && row.personaSets.length)) return false;
        if (Array.isArray(row.missingParts) && row.missingParts.length) return false;
        if (row.collectorAvgSaleCents != null || row.collectorLowestAskCents != null || row.collectorMedianAskCents != null) return false;
        return true;
    }

    function compactCollection(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.collections)
            || payload.collections.length > MAX_COLLECTIONS) throw invalidCatalog();
        const items = [];
        let inspected = 0;
        for (const collection of payload.collections) {
            if (!collection || typeof collection !== 'object' || Array.isArray(collection)
                || !Array.isArray(collection.items)) throw invalidCatalog();
            inspected += collection.items.length;
            if (inspected > MAX_ITEMS) throw invalidCatalog();
            // Color collections reuse a base item's name for multiple premium
            // variants. Their names alone never identify the offered variant.
            if (collection.kind !== 'regular' || typeof collection.name !== 'string'
                || SPECIAL_COLLECTION.test(collection.name.trim())) continue;
            for (const row of collection.items) {
                if (!ordinaryRow(row) || typeof row.itemName !== 'string') continue;
                const marketHashName = row.itemName.trim();
                if (!marketHashName || marketHashName.length > 512) continue;
                // The Dota collection cards show the cash price. A zero value
                // in this API is a missing quote, not a free item; in particular
                // all WEATHER rows have steamPriceCents: 0 and a cash quote.
                const priceCents = row.cashPriceCents;
                if (!Number.isSafeInteger(priceCents) || priceCents <= 0) continue;
                // Ownership, asset IDs, images, and translated names describe
                // the collection viewer, not an item in a historical offer.
                items.push({ marketHashName, priceCents });
            }
        }
        return { items, collectionCount: payload.collections.length, itemCount: items.length };
    }

    const api = { compactCollection };
    root.SIHLiteCollectionPrices = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
