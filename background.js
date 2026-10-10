const STEAMPRICE_ROOT = 'https://steamprice.com';
const REQUEST_TIMEOUT_MS = 15000;
const OPERATION_TIMEOUT_MS = 180000;
const PRICE_PAGE_SIZE = 200;
const MAX_PRICE_PAGES = 1000;
const FRESH_CACHE_MS = 90000;
const STALE_CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_STORAGE_KEY = 'sih-lite-steamprice-cache-v1';
const MAX_CACHE_OWNERS = 6;
const MAX_GETS = 1;
const GET_START_INTERVAL_MS = 350;
const pendingRequests = new Map();
const pendingNetwork = new Map();
const cache = new Map();
let cacheReady;
let storageWrites = Promise.resolve();
let cacheWritePending = false;
let cacheWriteRunning = false;
let profileEpoch = 0;
let activeGets = 0;
let nextGetAt = 0;
let getQueueTimer = null;
const getQueue = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PRICE_RECORD_FIELDS = [
    'assetid', 'assetId', 'asset_id', 'id', 'ownerSteamId', 'appId', 'appid', 'contextId', 'contextid', 'context_id',
    'classid', 'classId', 'instanceid', 'instanceId', 'quantity', 'amount',
    'marketHashName', 'market_hash_name', 'hash_name', 'name', 'marketName', 'market_name', 'title', 'item_name',
    'collectorAvgSaleCents', 'collectorLowestAskCents', 'priceCents', 'price_cents', 'scmPriceCents', 'basePriceCents',
    'price', 'lowest_price', 'cost', 'value',
    'itemType', 'type', 'quality', 'assetQuality', 'hasGems', 'hasColoredGem', 'gems',
    'prismaticGems', 'etherealGems', 'kineticGems', 'unusualEffectGems', 'isLegacy', 'legacyRgb', 'emptySockets',
    'allStylesUnlocked', 'styleTotal', 'styleUnlocked', 'gem', 'paintSeed', 'wearRating', 'stickers', 'infuser',
    'roshanCycle', 'expirationDate', 'greevil', 'spectatorGames', 'unusualQuality', 'mayBeGiftedOnce', 'favored',
    'isBuggedEthereal', 'isOtherBug', 'isGolden', 'isCrimson', 'emptyEthereal', 'emptyPrismatic',
    'isUnusualCourier', 'hasAllStyleCourier', 'hasUnusualEffect', 'collectorSetPiece', 'isCollectorBundle',
    'canGiftCollectorBundle', 'unpackGiftCollectorBundle', 'gift', 'tradable', 'marketable', 'pbrCycled'
];

function compactPriceRecord(item) {
    // Images, translated notices and price breakdowns are unnecessary for prices
    // and can multiply a large inventory's runtime messages and cache size.
    const result = {};
    for (const field of PRICE_RECORD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(item, field)) result[field] = item[field];
    }
    for (const field of ['rawTags', 'tags']) {
        if (!Array.isArray(item[field])) continue;
        result[field] = item[field].filter(tag => tag && typeof tag === 'object' &&
            (/^(?:quality|type)$/i.test(String(tag.category || '')) ||
                String(tag.internal_name || '').toLowerCase() === 'socket_gem'))
            .map(tag => {
                const entry = {};
                for (const key of ['category', 'internal_name']) {
                    if (Object.prototype.hasOwnProperty.call(tag, key)) entry[key] = tag[key];
                }
                if (/^type$/i.test(String(tag.category || '')) &&
                    Object.prototype.hasOwnProperty.call(tag, 'localized_tag_name')) {
                    entry.localized_tag_name = tag.localized_tag_name;
                }
                return entry;
            });
    }
    if (item.legacyPricing && typeof item.legacyPricing === 'object' && !Array.isArray(item.legacyPricing)) {
        result.legacyPricing = {};
        for (const field of ['isDupe', 'dupeCount']) {
            if (Object.prototype.hasOwnProperty.call(item.legacyPricing, field)) result.legacyPricing[field] = item.legacyPricing[field];
        }
    } else if (Object.prototype.hasOwnProperty.call(item, 'legacyPricing')) result.legacyPricing = item.legacyPricing;
    return result;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !['fetchPrices', 'fetchProfile'].includes(request.action)) return;
    let steamId;
    try { steamId = validateSteamId(request.steamId); }
    catch (error) { sendResponse({ success: false, error: error.message }); return; }
    const force = request.force === true;
    const allowScan = request.action !== 'fetchPrices' || request.scan !== false;
    const key = `${request.action}:${steamId}:${force}:${request.action === 'fetchProfile' ? profileEpoch : allowScan}`;
    let operation = pendingRequests.get(key);
    if (!operation) {
        operation = loadWithCache(request.action, steamId, force, allowScan)
            .finally(() => pendingRequests.delete(key));
        pendingRequests.set(key, operation);
    }
    operation.then(sendResponse, error => sendResponse({ success: false, error: error.message || 'Could not load Steamprice.' }));
    return true;
});

function validateSteamId(steamId) {
    if (typeof steamId !== 'string' || !/^\d{17}$/.test(steamId)) {
        throw new Error('A valid 17-digit SteamID64 is required.');
    }
    return steamId;
}

function temporaryError(message, retryAfter = null) {
    const error = new Error(message);
    error.temporary = true;
    error.retryAfter = retryAfter;
    return error;
}

function drainGetQueue() {
    if (activeGets >= MAX_GETS || getQueueTimer !== null) return;
    while (getQueue.length && Date.now() >= getQueue[0].deadline) {
        const expired = getQueue.shift();
        clearTimeout(expired.timer);
        expired.reject(temporaryError('Steamprice inventory loading timed out.'));
    }
    if (!getQueue.length) return;
    const wait = Math.max(0, nextGetAt - Date.now());
    if (wait > 0) {
        getQueueTimer = setTimeout(() => {
            getQueueTimer = null;
            drainGetQueue();
        }, wait);
        return;
    }
    const entry = getQueue.shift();
    clearTimeout(entry.timer);
    activeGets++;
    nextGetAt = Date.now() + GET_START_INTERVAL_MS;
    let released = false;
    entry.resolve(() => {
        if (released) return;
        released = true;
        activeGets--;
        drainGetQueue();
    });
}

function acquireGet(deadline) {
    return new Promise((resolve, reject) => {
        const entry = { deadline, resolve, reject, timer: null };
        getQueue.push(entry);
        entry.timer = setTimeout(() => {
            const index = getQueue.indexOf(entry);
            if (index !== -1) getQueue.splice(index, 1);
            reject(temporaryError('Steamprice inventory loading timed out.'));
            drainGetQueue();
        }, Math.max(0, deadline - Date.now()));
        drainGetQueue();
    });
}

function retryAfterMs(response) {
    const value = response.headers?.get?.('Retry-After');
    if (!value) return null;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

async function fetchJson(url, deadline) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const release = await acquireGet(deadline);
        const controller = new AbortController();
        let timer;
        let failure;
        try {
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(temporaryError('Steamprice request timed out.'));
                }, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
            });
            const request = (async () => {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) {
                    const message = `Steamprice returned HTTP ${response.status}.`;
                    if ([429, 502, 503, 504].includes(response.status)) {
                        const retryAfter = retryAfterMs(response);
                        if (retryAfter !== null) nextGetAt = Math.max(nextGetAt, Date.now() + retryAfter);
                        throw temporaryError(message, retryAfter);
                    }
                    throw new Error(message);
                }
                const data = await response.json();
                if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Steamprice returned an invalid JSON response.');
                if (data.success === false) throw new Error(typeof data.error === 'string' ? data.error : 'Steamprice could not load this inventory.');
                return data;
            })();
            return await Promise.race([request, timeout]);
        } catch (error) {
            failure = controller.signal.aborted ? temporaryError('Steamprice request timed out.') : error;
            if (failure?.name === 'TypeError') failure = temporaryError('Could not connect to Steamprice.');
        } finally {
            clearTimeout(timer);
            release();
        }
        if (!failure?.temporary || attempt === 2) throw failure;
        const backoff = Math.max(attempt === 0 ? 600 : 1800, failure.retryAfter || 0);
        // Do not ignore a long server Retry-After or hold a connection slot during backoff.
        if (backoff > 10000 || Date.now() + backoff >= deadline) throw failure;
        await delay(backoff);
    }
}

function readInteger(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value.trim()))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeProfile(profile) {
    const cents = readInteger(profile.totalValueCents);
    if (cents === null) throw new Error('Steamprice profile is missing a valid totalValueCents value.');
    return { ...profile, totalValueCents: cents };
}

async function fetchProfile(steamId, deadline) {
    return normalizeProfile(await fetchJson(`${STEAMPRICE_ROOT}/api/dota2/profile/${steamId}`, deadline));
}

async function handleFetchPrices(steamId, deadline, allowScan) {
    let items = await fetchAllPrices(steamId, deadline);
    let scanned = false;
    // Only a complete, valid empty response can mean an inventory is not cached.
    if (items.length === 0) {
        if (!allowScan) return { data: { items }, needsScan: true };
        scanned = true;
        invalidateProfile(steamId);
        try { await triggerScanViaTab(steamId); await delay(5000); }
        finally { invalidateProfile(steamId); }
        items = await fetchAllPrices(steamId, deadline);
    }
    return { data: { items }, ...(scanned ? { scanned: true } : {}) };
}

function invalidateProfile(steamId) {
    profileEpoch++;
    const entry = cache.get(`fetchProfile:${steamId}`);
    if (entry) entry.invalidated = true;
    persistCache();
}

function triggerScanViaTab(steamId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url: `${STEAMPRICE_ROOT}/ru/dota2/inventory/${steamId}`, active: false }, tab => {
            const error = chrome.runtime.lastError;
            if (error || !tab || !Number.isInteger(tab.id)) {
                reject(new Error(error?.message || 'Could not open the Steamprice inventory scan.'));
                return;
            }
            setTimeout(() => {
                chrome.tabs.remove(tab.id, () => {
                    const closeError = chrome.runtime.lastError;
                    if (closeError) reject(new Error(closeError.message));
                    else resolve();
                });
            }, 7000);
        });
    });
}

async function fetchAllPrices(steamId, deadline) {
    const allItems = [];
    const seenAssets = new Set();
    const metadata = {};
    for (let page = 1; page <= MAX_PRICE_PAGES; page++) {
        const data = await fetchJson(`${STEAMPRICE_ROOT}/api/dota2/inventory/${steamId}?page=${page}&pageSize=${PRICE_PAGE_SIZE}&sort=price_desc`, deadline);
        if (!Array.isArray(data.items) || data.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
            throw new Error(`Steamprice returned invalid items on price page ${page}.`);
        }
        for (const field of ['totalPages', 'total', 'itemsCount', 'pageSize', 'page']) {
            const present = data[field] !== undefined && data[field] !== null;
            if (page > 1 && (metadata[field] !== undefined) !== present) throw new Error('Steamprice inventory changed during loading. Please try again.');
            if (!present) continue;
            const value = readInteger(data[field]);
            if (value === null || (field === 'pageSize' && (value < 1 || value > 1000))) throw new Error('Steamprice returned invalid pagination metadata.');
            if (field === 'page' && value !== page) throw new Error('Steamprice returned an incorrect inventory page.');
            if (field !== 'page' && metadata[field] !== undefined && metadata[field] !== value) throw new Error('Steamprice inventory changed during loading. Please try again.');
            metadata[field] = value;
        }
        const pageSize = metadata.pageSize || PRICE_PAGE_SIZE;
        // total counts rows; itemsCount counts stacked quantities, not pages.
        const total = metadata.total;
        let pages = metadata.totalPages;
        if (total !== undefined) {
            const calculatedPages = Math.ceil(total / pageSize);
            if (pages !== undefined && pages !== calculatedPages && !(total === 0 && pages === 1)) throw new Error('Steamprice returned inconsistent pagination metadata.');
            pages = calculatedPages;
        }
        if (pages > MAX_PRICE_PAGES) throw new Error(`Steamprice inventory exceeds the supported ${MAX_PRICE_PAGES} price pages.`);
        if (data.items.length > pageSize || (pages === 0 && data.items.length !== 0) ||
            (pages > 0 && page > pages) || (pages > 1 && data.items.length === 0) ||
            (total !== undefined && data.items.length !== Math.min(pageSize, Math.max(0, total - allItems.length)))) {
            throw new Error(`Steamprice returned incomplete inventory pagination on page ${page}.`);
        }
        for (const item of data.items) {
            const assetId = item.assetid ?? item.assetId ?? item.asset_id;
            if (assetId === undefined || assetId === null || assetId === '') continue;
            const key = String(assetId);
            if (seenAssets.has(key)) throw new Error('Steamprice returned duplicate inventory pages. Please try again.');
            seenAssets.add(key);
        }
        allItems.push(...data.items.map(compactPriceRecord));
        if (pages !== undefined ? page >= pages : data.items.length < pageSize) return allItems;
    }
    throw new Error(`Steamprice inventory did not finish within ${MAX_PRICE_PAGES} price pages.`);
}

async function loadWithCache(action, steamId, force, allowScan = true) {
    await ensureCache();
    pruneCache();
    const key = `${action}:${steamId}`;
    const previous = cache.get(key);
    if (!force && previous && !previous.invalidated && Date.now() - previous.cachedAt < FRESH_CACHE_MS) {
        previous.usedAt = Date.now();
        return { success: true, data: previous.data, cached: true, cachedAt: previous.cachedAt,
            ...(!allowScan && action === 'fetchPrices' && previous.data.items.length === 0 ? { needsScan: true } : {}) };
    }
    const epoch = profileEpoch;
    const networkKey = `${key}:${action === 'fetchProfile' ? epoch : allowScan}`;
    let operation = pendingNetwork.get(networkKey);
    if (!operation) {
        operation = (async () => {
            const deadline = Date.now() + OPERATION_TIMEOUT_MS;
            const result = action === 'fetchPrices'
                ? await handleFetchPrices(steamId, deadline, allowScan)
                : { data: await fetchProfile(steamId, deadline) };
            if (!result.needsScan && (action !== 'fetchProfile' || epoch === profileEpoch)) {
                cache.set(key, { action, steamId, cachedAt: Date.now(), usedAt: Date.now(), data: result.data });
                pruneCache();
                persistCache();
            }
            return { success: true, ...result, cached: false };
        })().finally(() => pendingNetwork.delete(networkKey));
        pendingNetwork.set(networkKey, operation);
    }
    try { return await operation; }
    catch (error) {
        // A previous complete snapshot is useful only for a temporary service outage.
        const fallback = cache.get(key);
        if (error?.temporary && fallback && Date.now() - fallback.cachedAt <= STALE_CACHE_MS) {
            return { success: true, data: fallback.data, cached: true, cachedAt: fallback.cachedAt, error: error.message,
                ...(!allowScan && action === 'fetchPrices' && fallback.data.items.length === 0 ? { needsScan: true } : {}) };
        }
        throw error;
    }
}

function validCacheEntry(key, entry, now) {
    if (!entry || !['fetchPrices', 'fetchProfile'].includes(entry.action) ||
        typeof entry.steamId !== 'string' || !/^\d{17}$/.test(entry.steamId) || key !== `${entry.action}:${entry.steamId}` ||
        !Number.isSafeInteger(entry.cachedAt) || entry.cachedAt > now || now - entry.cachedAt > STALE_CACHE_MS ||
        !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return false;
    if (entry.action === 'fetchProfile') return readInteger(entry.data.totalValueCents) !== null;
    return Array.isArray(entry.data.items) && entry.data.items.every(item => item && typeof item === 'object' && !Array.isArray(item));
}

function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of cache) if (!validCacheEntry(key, entry, now)) cache.delete(key);
    const owners = new Map();
    for (const entry of cache.values()) owners.set(entry.steamId, Math.max(owners.get(entry.steamId) || 0, entry.usedAt || entry.cachedAt));
    const keep = new Set([...owners].sort((a, b) => b[1] - a[1]).slice(0, MAX_CACHE_OWNERS).map(([id]) => id));
    for (const [key, entry] of cache) if (!keep.has(entry.steamId)) cache.delete(key);
}

function storageCall(method, argument) {
    return new Promise(resolve => {
        const local = chrome.storage?.local;
        if (!local?.[method]) { resolve(undefined); return; }
        let finished = false;
        const finish = value => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            const error = chrome.runtime.lastError;
            resolve(error ? undefined : value);
        };
        const timer = setTimeout(() => finish(undefined), 1000);
        try {
            const result = local[method](argument, finish);
            if (result?.then) result.then(finish, () => finish(undefined));
        } catch { finish(undefined); }
    });
}

async function decodeCache(bucket) {
    if (bucket?.version !== 1) return null;
    if (bucket.encoding === 'gzip') {
        if (typeof DecompressionStream !== 'function' || typeof bucket.data !== 'string') return null;
        const bytes = Uint8Array.from(atob(bucket.data), char => char.charCodeAt(0));
        bucket = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    }
    return bucket?.version === 1 && bucket.entries && typeof bucket.entries === 'object' && !Array.isArray(bucket.entries) ? bucket.entries : null;
}

function ensureCache() {
    if (!cacheReady) cacheReady = (async () => {
        try {
            const result = await storageCall('get', CACHE_STORAGE_KEY);
            const entries = await decodeCache(result?.[CACHE_STORAGE_KEY]);
            const now = Date.now();
            for (const [key, entry] of Object.entries(entries || {})) if (validCacheEntry(key, entry, now)) {
                if (entry.action === 'fetchProfile') entry.data = normalizeProfile(entry.data);
                else entry.data = { items: entry.data.items.map(compactPriceRecord) };
                cache.set(key, entry);
            }
            pruneCache();
        } catch { /* Corrupt or unavailable storage falls back to a live request. */ }
    })();
    return cacheReady;
}

function persistCache() {
    // Coalesce updates while a snapshot is being compressed/written rather than
    // queueing a full serialization for every profile and inventory response.
    cacheWritePending = true;
    if (cacheWriteRunning) return;
    cacheWriteRunning = true;
    storageWrites = storageWrites.then(async () => {
        while (cacheWritePending) {
            cacheWritePending = false;
            pruneCache();
            let bucket = { version: 1, entries: Object.fromEntries(cache) };
            try {
                const json = JSON.stringify(bucket);
                if (json.length > 16384 && typeof CompressionStream === 'function') {
                    const compressed = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
                    let binary = '';
                    for (let index = 0; index < compressed.length; index += 8192) binary += String.fromCharCode(...compressed.subarray(index, index + 8192));
                    bucket = { version: 1, encoding: 'gzip', data: btoa(binary) };
                }
                await storageCall('set', { [CACHE_STORAGE_KEY]: bucket });
            } catch { /* Keep the complete successful snapshot in memory. */ }
        }
    }).catch(() => {}).finally(() => {
        cacheWriteRunning = false;
        if (cacheWritePending) persistCache();
    });
}
