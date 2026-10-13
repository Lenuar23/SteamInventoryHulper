/* Normalize exact-name Steam Market USD quotes without assigning asset prices. */
(function (root) {
    'use strict';

    const MAX_NAME_LENGTH = 512;
    const INVALID_NAME = /[\x00-\x1f\x7f<>]|\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|file|data|javascript|vbscript):|(?:^|\s)(?:\/\/|www\.)|&(?:lt|gt);/i;
    const USD_AMOUNT = /^\$\s*(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{2}))?$/;

    function validateName(value) {
        if (typeof value !== 'string' || INVALID_NAME.test(value)) throw new Error('Invalid Steam Market item name.');
        const name = value.trim();
        if (!name || name.length > MAX_NAME_LENGTH) throw new Error('Invalid Steam Market item name.');
        return name;
    }

    function usdCents(value) {
        if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) return null;
        let text = value.trim();
        const prefix = /^USD\s+/.test(text);
        const suffix = /\s+USD$/.test(text);
        if (prefix && suffix) return null;
        if (prefix) text = text.replace(/^USD\s+/, '');
        if (suffix) text = text.replace(/\s+USD$/, '');
        const match = USD_AMOUNT.exec(text);
        if (!match) return null;
        // Integer arithmetic preserves cent precision near the safe-integer
        // limit and rejects oversized quotes instead of rounding them down.
        const cents = BigInt(match[1].replace(/,/g, '')) * 100n + BigInt(match[2] || '0');
        return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
    }

    function normalizeQuote(payload, name) {
        const marketHashName = validateName(name);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || (payload.success !== true && payload.success !== 1)) return null;
        if (payload.currency != null && !['USD', 1, '1'].includes(payload.currency)) return null;
        const priceCents = usdCents(payload.lowest_price);
        if (priceCents === null) return null;
        // This is the current quote for the exact market listing name, with
        // its quality and component suffix intact. It is not a quote for an
        // individual asset's gems, counters, autograph, or unlocked styles.
        return { marketHashName, priceCents, currency: 'USD', source: 'steam-market', estimateKind: 'market-name' };
    }

    const api = { validateName, normalizeQuote };
    root.SIHLiteMarketQuotes = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
