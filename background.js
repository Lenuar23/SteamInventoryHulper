const STEAMPRICE_ROOT = 'https://steamprice.com';
const REQUEST_TIMEOUT_MS = 15000;
const PRICE_PAGE_SIZE = 200;
// A broken pagination response must fail explicitly instead of looping forever.
const MAX_PRICE_PAGES = 1000;
const pendingRequests = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !['fetchPrices', 'fetchProfile'].includes(request.action)) return;

    let steamId;
    try {
        steamId = validateSteamId(request.steamId);
    } catch (error) {
        sendResponse({ success: false, error: error.message });
        return;
    }

    const key = `${request.action}:${steamId}`;
    let operation = pendingRequests.get(key);
    if (!operation) {
        operation = (request.action === 'fetchPrices'
            ? handleFetchPrices(steamId).then(items => ({ items }))
            : fetchProfile(steamId)
        ).finally(() => pendingRequests.delete(key));
        pendingRequests.set(key, operation);
    }

    operation.then(
        data => sendResponse({ success: true, data }),
        error => sendResponse({ success: false, error: error.message })
    );
    return true;
});

function validateSteamId(steamId) {
    if (typeof steamId !== 'string' || !/^\d{17}$/.test(steamId)) {
        throw new Error('A valid 17-digit SteamID64 is required.');
    }
    return steamId;
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Steamprice returned HTTP ${response.status}.`);
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Steamprice returned an invalid JSON response.');
        }
        if (data.success === false) {
            throw new Error(typeof data.error === 'string' ? data.error : 'Steamprice could not load this inventory.');
        }
        return data;
    } catch (error) {
        if (controller.signal.aborted) throw new Error('Steamprice request timed out.');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchProfile(steamId) {
    const profile = await fetchJson(`${STEAMPRICE_ROOT}/api/dota2/profile/${steamId}`);
    const value = profile.totalValueCents;
    const isNumericString = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim());
    const cents = typeof value === 'number' || isNumericString ? Number(value) : NaN;
    if (!Number.isSafeInteger(cents) || cents < 0) {
        throw new Error('Steamprice profile is missing a valid totalValueCents value.');
    }
    // Always keep this field in cents, including when the API sends a string or zero.
    return { ...profile, totalValueCents: cents };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function handleFetchPrices(steamId) {
    let items = await fetchAllPrices(steamId);
    // Only a complete, valid empty response can mean an inventory is not cached.
    // HTTP errors, malformed JSON and failed later pages never open a scan tab.
    if (items.length === 0) {
        await triggerScanViaTab(steamId);
        await delay(5000);
        items = await fetchAllPrices(steamId);
    }
    return items;
}

function triggerScanViaTab(steamId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({
            url: `${STEAMPRICE_ROOT}/ru/dota2/inventory/${steamId}`,
            active: false
        }, tab => {
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

async function fetchAllPrices(steamId) {
    const allItems = [];
    let expectedTotalPages = null;
    for (let page = 1; page <= MAX_PRICE_PAGES; page++) {
        const url = `${STEAMPRICE_ROOT}/api/dota2/inventory/${steamId}?page=${page}&pageSize=${PRICE_PAGE_SIZE}&sort=price_desc`;
        const data = await fetchJson(url);
        if (!Array.isArray(data.items) || data.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
            throw new Error(`Steamprice returned invalid items on price page ${page}.`);
        }

        if (data.totalPages !== undefined && data.totalPages !== null) {
            const totalPages = Number(data.totalPages);
            if ((typeof data.totalPages !== 'number' && typeof data.totalPages !== 'string') ||
                (typeof data.totalPages === 'string' && !/^\d+$/.test(data.totalPages)) ||
                !Number.isSafeInteger(totalPages) || totalPages < 0) {
                throw new Error('Steamprice returned invalid pagination metadata.');
            }
            if (totalPages > MAX_PRICE_PAGES) {
                throw new Error(`Steamprice inventory exceeds the supported ${MAX_PRICE_PAGES} price pages.`);
            }
            if (expectedTotalPages !== null && expectedTotalPages !== totalPages) {
                throw new Error('Steamprice inventory changed during loading. Please try again.');
            }
            expectedTotalPages = totalPages;
        }

        if (expectedTotalPages !== null) {
            if ((expectedTotalPages === 0 && data.items.length !== 0) ||
                (expectedTotalPages > 1 && data.items.length === 0) ||
                (expectedTotalPages > 0 && page > expectedTotalPages)) {
                throw new Error(`Steamprice returned incomplete inventory pagination on page ${page}.`);
            }
        }
        allItems.push(...data.items);

        // Metadata takes precedence: servers may clamp pageSize below our request.
        if (expectedTotalPages !== null) {
            if (page >= expectedTotalPages) return allItems;
        } else if (data.items.length < PRICE_PAGE_SIZE) {
            return allItems;
        }
    }
    throw new Error(`Steamprice inventory did not finish within ${MAX_PRICE_PAGES} price pages.`);
}
