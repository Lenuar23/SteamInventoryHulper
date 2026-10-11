/* Read-only, selected-offer price diagnostics. Never reads cookies or URLs. */
(function (root) {
    'use strict';

    const Prices = root.SIHLiteTradePrices || (typeof require === 'function' ? require('./trade-prices.js') : null);
    const MAX_ITEMS = 2048;
    const MAX_PROOF_ASSETS = 256;
    const STATES = new Set(['idle', 'loading', 'ready', 'error']);

    function numericId(value, zero = false) {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
        const text = String(value ?? '');
        return (zero ? /^\d{1,20}$/ : /^[1-9]\d{0,19}$/).test(text) ? text : null;
    }

    function ownerId(value) {
        return typeof value === 'string' && /^\d{17}$/.test(value) ? value : null;
    }

    function boundedText(value, length) {
        return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length) : '';
    }

    function safeError(value) {
        if (typeof value !== 'string') return '';
        if (/<(?:script|html|!doctype)\b/i.test(value)) return '[Non-text error omitted]';
        return value.replace(/["']?\b(?:cookies?|set-cookie|authorization)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi, '[Private header omitted]')
            .replace(/["']?\b(sessionid|session_id|session|token|access_token|refresh_token|api_key|apikey|password)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,}]+)/gi, '$1=[redacted]')
            .replace(/https?:\/\/[^\s<>"']+/gi, value => {
                try { const url = new URL(value); return url.origin + url.pathname; }
                catch (_) { return '[URL omitted]'; }
            }).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
    }

    function cacheInfo(value) {
        if (!value || typeof value !== 'object') return null;
        return {
            cached: value.cached === true,
            cachedAt: Number.isSafeInteger(value.cachedAt) && value.cachedAt >= 0 ? value.cachedAt : null,
            scanned: value.scanned === true,
            needsScan: value.needsScan === true,
            error: safeError(value.error)
        };
    }

    function stateInfo(value) {
        return { state: STATES.has(value?.state) ? value.state : 'unavailable', error: safeError(value?.error) };
    }

    function mapMatch(map, key) {
        if (!key || !(map instanceof Map) || !map.has(key)) return { present: false };
        const value = map.get(key);
        if (value === null) return { present: true, cents: null };
        if (Number.isSafeInteger(value) && value >= 0) return { present: true, cents: value };
        return { present: true, cents: null, invalid: true };
    }

    function canonicalName(item) {
        const value = item?.marketHashName || item?.market_hash_name || item?.description?.market_hash_name;
        return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512
            ? boundedText(value.trim().toLowerCase(), 512) : '';
    }

    function flag(item, field) {
        const values = [item?.[field], item?.description?.[field]];
        if (values.some(value => value === false || value === 0)) return false;
        return values.some(value => value === true || value === 1) ? true : null;
    }

    function fingerprint(value, kind, name) {
        if (typeof value !== 'string' || value.length > 600) return null;
        try {
            const parts = JSON.parse(value);
            if (!Array.isArray(parts) || parts[0] !== kind) return null;
            if (kind === 'tb-v1') {
                if (parts.length !== 6 || !['standard', 'exalted'].includes(parts[1]) ||
                    !['regular', 'legacy'].includes(parts[2]) ||
                    !parts.slice(3).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 255)) return null;
            } else if (kind === 'ordinary-v1') {
                if (parts.length !== 3 || parts[1] !== 'standard' || !name || parts[2] !== name) return null;
            } else if (kind === 'catalog-v1') {
                if (parts.length !== 3 || !name || parts[1] !== name || !['standard', 'genuine'].includes(parts[2])) return null;
            }
            return JSON.stringify(parts);
        } catch (_) { return null; }
    }

    function computedFingerprint(item, method, kind, name) {
        try { return fingerprint(Prices?.[method]?.(item), kind, name); }
        catch (_) { return null; }
    }

    function identity(item) {
        const context = item ? ['contextId', 'contextid', 'context_id'].find(key => Object.prototype.hasOwnProperty.call(item, key)) : undefined;
        return {
            ownerSteamId: ownerId(item?.ownerSteamId),
            appId: numericId(item?.appId ?? item?.appid ?? item?.description?.appid),
            contextId: numericId(context ? item[context] : item?.description?.contextid),
            contextKnown: context !== undefined || item?.description?.contextid !== undefined,
            assetId: numericId(item?.assetId ?? item?.assetid ?? item?.asset_id ?? item?.id),
            classId: numericId(item?.classId ?? item?.classid ?? item?.description?.classid),
            instanceId: numericId(item?.instanceId ?? item?.instanceid ?? item?.description?.instanceid, true),
            market_hash_name: canonicalName(item)
        };
    }

    function quantity(item) {
        const value = item?.amount === undefined ? 1 : item.amount;
        if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !/^\d+$/.test(value.trim()))) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    function proofInfo(proofs, key, assetPrices, owner) {
        if (!key || !(proofs instanceof Map) || !proofs.has(key)) return { present: false };
        const value = proofs.get(key);
        if (!Array.isArray(value)) return { present: true, invalid: true, assetIds: [] };
        const ids = [...new Set(value.map(id => numericId(id)).filter(Boolean))];
        const shown = ids.slice(0, MAX_PROOF_ASSETS);
        return { present: true, assetIds: shown,
            assetPrices: shown.map(assetId => ({ assetId, match: mapMatch(assetPrices, owner + ':' + assetId) })),
            count: ids.length, omitted: Math.max(0, ids.length - MAX_PROOF_ASSETS) };
    }

    function ownerInfo(id, data) {
        const sizes = {};
        for (const name of ['assetPrices', 'exactNames', 'cleanNames', 'variants', 'sharedOrdinaryPrices']) {
            sizes[name] = data?.index?.[name] instanceof Map ? data.index[name].size : 0;
        }
        return {
            steamId: id,
            priceState: STATES.has(data?.priceState) ? data.priceState : 'unavailable',
            priceError: safeError(data?.priceError),
            pricesLoaded: data?.pricesLoaded === true,
            needsScan: data?.needsScan === true,
            priceCache: cacheInfo(data?.priceCache),
            indexSizes: sizes
        };
    }

    function reasonFor(record, ctx, data) {
        const { identity: id, flags, matches, fingerprints, price, classProof } = record;
        if (price.cents !== null) return { code: record.amount === null ? 'invalid-quantity' : 'price-known' };
        if (id.appId !== '570') return { code: id.appId ? 'non-dota' : 'unverified-app' };
        if (flags.isCurrency) return { code: 'currency' };
        if (id.contextKnown && id.contextId !== '2') return { code: 'unsupported-context' };
        if (!id.ownerSteamId) return { code: 'unverified-owner' };
        if (!data?.index?.assetPrices || !data.index.exactNames || !data.index.cleanNames) return { code: 'owner-index-unavailable' };
        if (matches.asset.present) return { code: matches.asset.invalid ? 'asset-price-invalid' : 'asset-price-conflict' };
        if (flags.tradable !== true && matches.class.present) return { code: flags.tradable === false ? 'non-tradable' : 'tradability-unverified' };
        if (matches.class.present) {
            if (matches.class.invalid) return { code: 'class-price-invalid' };
            if (matches.class.cents !== null) return { code: 'class-match-unverified' };
            if (classProof.present && !classProof.invalid && classProof.count === 0) return { code: 'class-owner-assets-absent' };
            if (classProof.assetPrices?.some(candidate => !candidate.match.present)) return { code: 'class-candidate-price-missing' };
            if (classProof.assetPrices?.some(candidate => candidate.match.invalid)) return { code: 'class-candidate-price-invalid' };
            return { code: 'class-price-conflict' };
        }
        if (flags.tradable === false) return { code: 'non-tradable' };
        if (flags.marketable === false && !(fingerprints.catalog.provided || fingerprints.catalog.computed)) return { code: 'non-marketable' };
        if (!id.market_hash_name) return { code: 'missing-canonical-name' };
        if (matches.variant.present) return { code: matches.variant.invalid ? 'variant-price-invalid'
            : matches.variant.cents === null ? 'variant-price-conflict' : 'variant-match-unverified' };
        if (flags.hasGems || flags.hasColoredGem || /\b(?:fractal horns of inner abysm|baby roshan|jumo)\b/i.test(id.market_hash_name)) {
            return { code: classProof.present && classProof.count === 0 ? 'class-owner-assets-absent'
                : (fingerprints.variant.provided || fingerprints.variant.computed) ? 'variant-owner-price-missing' : 'gem-variant-unverified' };
        }
        if (matches.ownerName.present) return { code: matches.ownerName.invalid ? 'owner-name-price-invalid'
            : matches.ownerName.cents === null ? 'owner-name-price-conflict' : 'owner-name-match-unverified' };
        if (matches.ordinary.present) return { code: matches.ordinary.invalid ? 'pooled-ordinary-price-invalid'
            : matches.ordinary.cents === null ? 'pooled-ordinary-price-conflict' : 'pooled-ordinary-match-unverified' };
        if (!(fingerprints.catalog.provided || fingerprints.catalog.computed)) return { code: 'catalog-eligibility-unverified' };
        if (matches.catalog.present) return { code: matches.catalog.invalid ? 'catalog-price-invalid'
            : matches.catalog.cents === null ? 'catalog-price-conflict' : 'catalog-match-unverified' };
        if (ctx.collection?.state === 'loading') return { code: 'collection-loading' };
        if (ctx.collection?.state === 'error') return { code: 'collection-error' };
        if (ctx.collection?.state !== 'ready') return { code: 'collection-not-requested' };
        return { code: 'catalog-name-absent' };
    }

    function itemReport(item, location, side, index, ctx, counterpart) {
        const id = identity(item);
        const data = ctx.owners instanceof Map ? ctx.owners.get(id.ownerSteamId) : null;
        const fingerprints = {};
        for (const [name, kind, method] of [['variant', 'tb-v1', 'variantFingerprint'], ['ordinary', 'ordinary-v1', 'ordinaryFingerprint'], ['catalog', 'catalog-v1', 'catalogFingerprint']]) {
            fingerprints[name] = {
                provided: fingerprint(item?.[method], kind, id.market_hash_name),
                computed: computedFingerprint(item, method, kind, id.market_hash_name)
            };
        }
        const keys = {
            asset: id.ownerSteamId && id.assetId ? id.ownerSteamId + ':' + id.assetId : null,
            ownerName: id.ownerSteamId && id.market_hash_name ? id.ownerSteamId + ':' + id.market_hash_name : null,
            variant: id.ownerSteamId && (fingerprints.variant.provided || fingerprints.variant.computed)
                ? id.ownerSteamId + ':' + (fingerprints.variant.provided || fingerprints.variant.computed) : null,
            ordinary: fingerprints.ordinary.provided || fingerprints.ordinary.computed,
            catalog: id.market_hash_name || null,
            class: id.ownerSteamId && id.classId && id.instanceId ? id.ownerSteamId + ':' + id.classId + ':' + id.instanceId : null
        };
        const matches = {
            asset: mapMatch(data?.index?.assetPrices, keys.asset),
            ownerName: mapMatch(data?.index?.exactNames, keys.ownerName),
            variant: mapMatch(data?.index?.variants, keys.variant),
            ordinary: mapMatch(ctx.ordinaryEstimates, keys.ordinary),
            catalog: mapMatch(ctx.collection?.index, keys.catalog),
            class: mapMatch(ctx.classEstimates, keys.class)
        };
        let result;
        try { result = Prices?.getPrice(data?.index, item, ctx.ordinaryEstimates, ctx.collection?.index, ctx.classEstimates); }
        catch (_) { result = null; }
        const amount = quantity(item);
        const cents = Number.isSafeInteger(result?.cents) && result.cents >= 0 ? result.cents : null;
        const report = {
            location, side, index, identity: id, amount,
            flags: { tradable: flag(item, 'tradable'), marketable: flag(item, 'marketable'),
                hasGems: item?.hasGems === true, hasColoredGem: item?.hasColoredGem === true,
                isCurrency: item?.isCurrency === true || item?.is_currency === true },
            fingerprints, keys, matches,
            classProof: proofInfo(ctx.classAssetProofs, keys.class, data?.index?.assetPrices, id.ownerSteamId),
            price: { cents, source: boundedText(result?.source, 40) || 'unknown',
                totalCents: cents !== null && amount !== null && Number.isSafeInteger(cents * amount) ? cents * amount : null }
        };
        if (counterpart) report.cardIdentity = identity(counterpart);
        report.reason = reasonFor(report, ctx, data);
        return report;
    }

    function itemSignature(item) {
        return JSON.stringify({ identity: identity(item), amount: quantity(item),
            tradable: flag(item, 'tradable'), marketable: flag(item, 'marketable'),
            hasGems: item?.hasGems === true, hasColoredGem: item?.hasColoredGem === true,
            variantFingerprint: item?.variantFingerprint, ordinaryFingerprint: item?.ordinaryFingerprint,
            catalogFingerprint: item?.catalogFingerprint });
    }

    function buildReport(ctx = {}) {
        const offer = ctx.offer || {};
        const items = [];
        const slots = Array.isArray(offer.slots) ? offer.slots : [];
        let omitted = 0;
        for (const side of ['give', 'receive']) {
            const summaryItems = Array.isArray(offer[side]) ? offer[side] : [];
            const cardItems = slots.filter(slot => slot?.side === side);
            for (let index = 0; index < Math.max(summaryItems.length, cardItems.length); index++) {
                const item = summaryItems[index], card = cardItems[index]?.item;
                if (item) {
                    if (items.length < MAX_ITEMS) items.push(itemReport(item, 'summary.' + side + '[' + index + ']', side, index, ctx, card));
                    else omitted++;
                }
                if (card && (!item || itemSignature(item) !== itemSignature(card))) {
                    if (items.length < MAX_ITEMS) items.push(itemReport(card, 'card.' + side + '[' + index + ']', side, index, ctx));
                    else omitted++;
                }
            }
        }
        const ownerIds = [...new Set([ownerId(offer.meSteamId), ownerId(offer.partnerSteamId)].filter(Boolean))];
        return {
            schemaVersion: 1,
            version: typeof ctx.version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(ctx.version) ? ctx.version : 'unknown',
            pathname: typeof ctx.pathname === 'string' && ctx.pathname.startsWith('/')
                ? boundedText(ctx.pathname.split(/[?#]/)[0], 256) : '',
            offer: { offerId: numericId(offer.offerId), meSteamId: ownerId(offer.meSteamId),
                partnerSteamId: ownerId(offer.partnerSteamId), incoming: offer.incoming === true, active: offer.active === true },
            details: stateInfo(ctx.detailState),
            classPrices: stateInfo(ctx.classState),
            owners: ownerIds.map(id => ownerInfo(id, ctx.owners instanceof Map ? ctx.owners.get(id) : null)),
            ordinaryEstimateCount: ctx.ordinaryEstimates instanceof Map ? ctx.ordinaryEstimates.size : 0,
            collection: { ...stateInfo(ctx.collection), cache: cacheInfo(ctx.collection?.cache),
                indexSize: ctx.collection?.index instanceof Map ? ctx.collection.index.size : 0 },
            items, omittedItems: omitted
        };
    }

    const api = { buildReport };
    root.SIHLiteTradeDiagnostics = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
