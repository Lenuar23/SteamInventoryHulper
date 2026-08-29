console.log("SIH Lite: Extension loaded!");

/**
 * Injects CSS rules for price badges and total value header.
 */
function injectStyles() {
    if (document.getElementById("sih-lite-styles")) return;
    const style = document.createElement("style");
    style.id = "sih-lite-styles";
    style.textContent = `
        .sih-lite-badge {
            position: absolute !important;
            bottom: 2px !important;
            right: 2px !important;
            font-size: 11px !important;
            font-weight: bold !important;
            padding: 2px 5px !important;
            border-radius: 3px !important;
            z-index: 99 !important;
            pointer-events: none !important;
            user-select: none !important;
            box-shadow: 0 0 4px rgba(0,0,0,0.9) !important;
            line-height: 1.2 !important;
        }
        .sih-lite-price {
            background-color: rgba(0, 0, 0, 0.9) !important;
            color: #5cff5c !important;
            border: 1px solid rgba(92, 255, 92, 0.6) !important;
        }
        .sih-lite-cache {
            background-color: rgba(45, 10, 60, 0.9) !important;
            color: #d070ff !important;
            border: 1px solid rgba(208, 112, 255, 0.7) !important;
        }
        .sih-lite-total {
            font-size: 14px !important;
            font-weight: bold !important;
            color: #66c0f4 !important;
            margin-bottom: 10px !important;
            padding: 6px 12px !important;
            background-color: rgba(0, 0, 0, 0.75) !important;
            border-radius: 4px !important;
            border-left: 4px solid #5cff5c !important;
            display: inline-block !important;
        }
    `;
    document.head.appendChild(style);
}

// Global data stores for fast lookups
const priceByNameMap = new Map(); // Name-based prices
const apiAssetPrices = new Map(); // Direct AssetID to Price mapping (great for items with specific gems)
const assetCaches = new Set();    // Set containing AssetIDs of Collector's Cache items
const assetToNameMap = new Map(); // Maps Steam AssetIDs to their market names

/**
 * Universally extracts and formats the item name and price.
 */
function extractNameAndPrice(item) {
    if (!item) return null;

    let rawName = null;
    let rawPrice = null;

    if (typeof item === 'object') {
        rawName = item.marketHashName || item.market_hash_name || item.hash_name || item.name || item.marketName || item.market_name || item.title || item.item_name;
        
    
        rawPrice = item.collectorAvgSaleCents || item.collectorLowestAskCents || item.priceCents || item.price_cents || item.scmPriceCents || item.basePriceCents || item.price || item.lowest_price || item.cost || item.value;
    }

    if (!rawName || rawPrice === undefined || rawPrice === null || rawPrice === 0) return null;

    // Convert price to float
    let priceNum = rawPrice;
    if (typeof priceNum === 'string') {
        const cleaned = priceNum.replace(/[^0-9.,]/g, '').replace(',', '.');
        priceNum = parseFloat(cleaned);
    }

    if (isNaN(priceNum) || priceNum <= 0) return null;

    let formattedPrice;
    
    if (item.collectorAvgSaleCents !== undefined || item.collectorLowestAskCents !== undefined || item.priceCents !== undefined || item.price_cents !== undefined || item.scmPriceCents !== undefined || item.basePriceCents !== undefined || Number.isInteger(priceNum)) {
        formattedPrice = (priceNum / 100).toFixed(2);
    } else {
        formattedPrice = priceNum.toFixed(2);
    }

    return { name: String(rawName), price: formattedPrice };
}

/**
 * Cleans item names by removing extraneous prefixes/suffixes.
 * E.g., "Inscribed Demon Eater" -> "demon eater"
 */
function cleanName(name) {
    if (!name) return "";
    return name
        .toLowerCase()
        .replace(/^(inscribed|autographed|corrupted|frozen|heroic|cursed|genuine|favored|ascent|elder|unusual|exalted|infused|auspicious|base|legacy|sealed)\s+/i, "")
        .replace(/\s+(bundle|set)$/i, "")
        .trim();
}

/**
 * Looks up an item's price in the name map (checks both raw and cleaned names).
 */
function getPriceForName(name) {
    if (!name) return null;
    const raw = name.trim().toLowerCase();
    if (priceByNameMap.has(raw)) return priceByNameMap.get(raw);
    
    const cleaned = cleanName(name);
    if (priceByNameMap.has(cleaned)) return priceByNameMap.get(cleaned);
    
    return null;
}

/**
 * Fetches the user's Steam inventory.
 * Supports both modern and legacy API endpoints to bypass 403 Forbidden errors.
 */
async function fetchSteamInventory(steamId) {
    const urls = [
        `${window.location.origin}/inventory/${steamId}/570/2?l=english`,
        `${window.location.origin}/profiles/${steamId}/inventory/json/570/2?l=english`
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;

            const data = await res.json();
            
            let assets = [];
            let descriptions = [];

            // Compatibility for both modern and legacy JSON responses
            if (data.assets && data.descriptions) {
                assets = data.assets;
                descriptions = data.descriptions;
            } else if (data.rgInventory && data.rgDescriptions) {
                assets = Object.values(data.rgInventory);
                descriptions = Object.values(data.rgDescriptions);
            } else {
                continue;
            }

            const descMap = new Map();

            // Map descriptions by classid_instanceid
            descriptions.forEach(desc => {
                const name = desc.market_hash_name || desc.name || desc.market_name;
                const classId = String(desc.classid);
                const instanceId = String(desc.instanceid || '0');
                const compositeKey = `${classId}_${instanceId}`;

                const descStr = JSON.stringify(desc).toLowerCase();
                const isCache = descStr.includes("collector's cache") || descStr.includes("collectors cache");

                const info = { name, isCache };
                descMap.set(compositeKey, info);
                descMap.set(classId, info); // Fallback mapping
            });

            // Associate specific Asset IDs with their resolved names and cache status
            assets.forEach(item => {
                const assetId = String(item.id || item.assetid);
                const classId = String(item.classid);
                const instanceId = String(item.instanceid || '0');
                const compositeKey = `${classId}_${instanceId}`;

                const info = descMap.get(compositeKey) || descMap.get(classId);
                if (info && assetId) {
                    if (info.name) assetToNameMap.set(assetId, info.name);
                    if (info.isCache) assetCaches.add(assetId);
                }
            });

            console.log(`SIH Lite: Indexed ${assetToNameMap.size} inventory items from Steam.`);
            renderPrices(); // Trigger visual update
            return true;
        } catch (err) {
            console.error("SIH Lite: Inventory fetch error", err);
        }
    }
    return false; // Returns false if all endpoints failed
}

/**
 * Attempts to resolve the SteamID64 of the current inventory owner from the DOM.
 */
async function getInventoryOwnerSteamId() {
    const pathname = window.location.pathname;

    // Direct match from URL
    const profileMatch = pathname.match(/\/profiles\/(7656119\d{10})/);
    if (profileMatch) return profileMatch[1];

    // Search page scripts for global variables
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
        const text = script.textContent;

        const ownerMatch = text.match(/g_ownerSteamID\s*=\s*["']?(7656119\d{10})["']?/);
        if (ownerMatch) return ownerMatch[1];

        const viewingMatch = text.match(/UserYouAreViewing[\s\S]*?"strSteamId"\s*:\s*"(7656119\d{10})"/);
        if (viewingMatch) return viewingMatch[1];
    }

    // Resolve custom URL slug to SteamID64 via XML endpoint
    const customIdMatch = pathname.match(/\/id\/([^\/]+)/);
    if (customIdMatch) {
        const customSlug = customIdMatch[1];
        try {
            const xmlUrl = `${window.location.origin}/id/${customSlug}?xml=1`;
            const response = await fetch(xmlUrl);
            if (response.ok) {
                const xmlText = await response.text();
                const steamIdMatch = xmlText.match(/<steamID64>(7656119\d{10})<\/steamID64>/);
                if (steamIdMatch) return steamIdMatch[1];
            }
        } catch (err) {}
    }

    return null;
}

/**
 * Populates price maps from external API data.
 */
function buildPriceMap(items) {
    priceByNameMap.clear();
    apiAssetPrices.clear();

    items.forEach(item => {
        const parsed = extractNameAndPrice(item);
        if (!parsed) return;

        // If the API provides a specific assetid (e.g. for items with gems), bind strictly to it
        const assetId = item.assetid || item.assetId || item.id || item.asset_id;
        if (assetId) {
            apiAssetPrices.set(String(assetId), parsed.price);
        }

        // Fallback: Bind by exact and cleaned name
        priceByNameMap.set(parsed.name.trim().toLowerCase(), parsed.price);
        priceByNameMap.set(cleanName(parsed.name), parsed.price);
    });

    console.log(`SIH Lite: Processed ${priceByNameMap.size} prices (${apiAssetPrices.size} specific Asset IDs).`);
    renderPrices();
}

/**
 * Calculates and displays the total inventory value at the top of the page.
 */
function renderTotalValue(items) {
    if (!Array.isArray(items)) return;

    // Calculate sum using Array.reduce
    let totalDollars = items.reduce((sum, item) => {
        const parsed = extractNameAndPrice(item);
        return parsed ? sum + parseFloat(parsed.price) : sum;
    }, 0);

    let header = document.querySelector('.sih-lite-total');
    
    // Inject the header if it doesn't exist yet
    if (!header) {
        const targetContainer = document.querySelector('#inventory_items, .inventory_header');
        if (targetContainer && targetContainer.parentNode) {
            header = document.createElement('div');
            header.className = 'sih-lite-total';
            targetContainer.parentNode.insertBefore(header, targetContainer);
        }
    }

    if (header) {
        header.innerText = `Total Inventory Value: $${totalDollars.toFixed(2)}`;
    }
}

/**
 * Main DOM manipulation function. Scans item slots and injects badges.
 */
function renderPrices() {
    const itemSlots = document.querySelectorAll('.itemHolder .item, div.item');

    itemSlots.forEach(slot => {
        let assetId = null;

        // Extract AssetID directly from the slot element ID
        if (slot.id) {
            const match = slot.id.match(/570_2_(\d+)/);
            if (match) assetId = match[1];
        }

        // Extract AssetID from nested link as fallback
        if (!assetId) {
            const link = slot.querySelector('a.inventory_item_link');
            if (link && link.href) {
                const match = link.href.match(/570_2_(\d+)/);
                if (match) assetId = match[1];
            }
        }

        const img = slot.querySelector('img');
        const titleName = img ? (img.alt || img.title || '') : '';

        let price = null;
        let isCache = false;

        // Step 1: Secure Asset ID lookup
        if (assetId) {
            price = apiAssetPrices.get(assetId); // Perfect match lookup
            
            // Name-based fallback utilizing the assetToNameMap
            if (!price && assetToNameMap.has(assetId)) {
                price = getPriceForName(assetToNameMap.get(assetId));
            }
            
            if (assetCaches.has(assetId)) isCache = true;
        }

        // Step 2: Desperate DOM text fallback
        if (!price && titleName) {
            price = getPriceForName(titleName);
            const lowerTitle = titleName.toLowerCase();
            if (lowerTitle.includes("cache") || lowerTitle.includes("коллекторс")) isCache = true;
        }

        // Determine badge type
        let badgeType = null;
        let badgeValue = null;

        if (isCache && !price) {
            badgeType = 'cache';
            badgeValue = 'Cache';
        } else if (price) {
            badgeType = 'price';
            badgeValue = `$${price}`;
        }

        // DOM Injection
        let badge = slot.querySelector('.sih-lite-badge');

        if (badgeType && badgeValue) {
            const className = `sih-lite-badge sih-lite-${badgeType}`;

            if (!badge) {
                badge = document.createElement('div');
                badge.className = className;
                badge.textContent = badgeValue;
                slot.appendChild(badge);
            } else {
                // Only update DOM if changes occurred to save performance
                if (badge.className !== className) badge.className = className;
                if (badge.textContent !== badgeValue) badge.textContent = badgeValue;
            }
        } else if (badge) {
            badge.remove(); // Cleanup invalid badges
        }
    });
}

// ==========================================
// Extension Initialization Execution
// ==========================================
injectStyles();

(async function init() {
    const targetSteamId = await getInventoryOwnerSteamId();

    if (targetSteamId) {
        console.log("SIH Lite: Detected inventory owner Steam ID ->", targetSteamId);

        // Runs repeatedly to catch DOM updates (page turns, filters).
        // Consider switching to MutationObserver for better performance in the future.
        setInterval(renderPrices, 350);

        fetchSteamInventory(targetSteamId);

        chrome.runtime.sendMessage({ action: "fetchPrices", steamId: targetSteamId }, (response) => {
            if (response && response.success && response.data?.items) {
                console.log(`SIH Lite: Loaded ${response.data.items.length} prices from API.`);

                buildPriceMap(response.data.items);
                renderTotalValue(response.data.items);
            } else {
                console.error("SIH Lite: Failed to retrieve prices from API.", response?.error);
            }
        });
    }
})();