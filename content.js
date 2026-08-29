console.log("SIH Lite: Extension loaded!");

/**
 * Injects CSS for badges without affecting Steam clicks or slot layouts
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

// Stores
const priceByNameMap = new Map();
const assetPrices = new Map();
const iconPrices = new Map();
const assetCaches = new Set();
const iconCaches = new Set();

const assetToNameMap = new Map();
const assetToIconMap = new Map();

/**
 * Universal name & price extractor supporting camelCase and snake_case API schemas
 */
function extractNameAndPrice(item) {
    if (!item) return null;

    let rawName = null;
    let rawPrice = null;

    if (typeof item === 'object') {
        // Name detection (Fixed: added marketHashName)
        rawName = item.marketHashName || item.market_hash_name || item.hash_name || item.name || item.marketName || item.market_name || item.title || item.item_name;

        // Price detection
        rawPrice = item.priceCents ?? item.price_cents ?? item.scmPriceCents ?? item.basePriceCents ?? item.price ?? item.lowest_price ?? item.cost ?? item.value;
    }

    if (!rawName || rawPrice === undefined || rawPrice === null) return null;

    // Parse price value
    let priceNum = rawPrice;
    if (typeof priceNum === 'string') {
        const cleaned = priceNum.replace(/[^0-9.,]/g, '').replace(',', '.');
        priceNum = parseFloat(cleaned);
    }

    if (isNaN(priceNum) || priceNum <= 0) return null;

    let formattedPrice;
    // Check if the source explicitly uses cents
    if (item.priceCents !== undefined || item.price_cents !== undefined || item.scmPriceCents !== undefined || item.basePriceCents !== undefined) {
        formattedPrice = (priceNum / 100).toFixed(2);
    } else if (priceNum >= 100 && Number.isInteger(priceNum)) {
        formattedPrice = (priceNum / 100).toFixed(2);
    } else if (priceNum < 100 && Number.isInteger(priceNum)) {
        formattedPrice = (priceNum / 100).toFixed(2);
    } else {
        formattedPrice = priceNum.toFixed(2);
    }

    return { name: String(rawName), price: formattedPrice };
}

/**
 * Cleans item names (removes qualities & set/bundle prefixes/suffixes)
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
 * Matches item name to price map
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
 * Extracts Economy Image Hash
 */
function extractIconUrl(imgSrc) {
    if (!imgSrc) return null;
    const match = imgSrc.match(/\/economy\/image\/([^\/\?#]+)/);
    return match ? match[1] : null;
}

/**
 * Legacy Steam Inventory parser
 */
async function fetchLegacySteamInventory(steamId) {
    const basePath = window.location.pathname.split('/inventory')[0];
    const urls = [
        `${window.location.origin}${basePath}/inventory/json/570/2?l=english`,
        `${window.location.origin}/profiles/${steamId}/inventory/json/570/2?l=english`
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;

            const data = await res.json();
            if (!data || !data.rgInventory || !data.rgDescriptions) continue;

            const descMap = new Map();

            Object.entries(data.rgDescriptions).forEach(([key, desc]) => {
                const name = desc.market_hash_name || desc.name || desc.market_name;
                const iconUrl = desc.icon_url;
                const classId = String(desc.classid);
                const instanceId = String(desc.instanceid || '0');
                const compositeKey = `${classId}_${instanceId}`;

                const isCache = (name && name.toLowerCase().includes("collector's cache")) ||
                    (desc.tags && desc.tags.some(t => 
                        (t.name && t.name.toLowerCase().includes("collector's cache")) || 
                        (t.category_name && t.category_name.toLowerCase().includes("collector's cache"))
                    ));

                const info = { name, iconUrl, isCache };
                descMap.set(compositeKey, info);
                descMap.set(classId, info);
                descMap.set(key, info);
            });

            Object.values(data.rgInventory).forEach(item => {
                const assetId = String(item.id || item.assetid);
                const classId = String(item.classid);
                const instanceId = String(item.instanceid || '0');
                const compositeKey = `${classId}_${instanceId}`;

                const info = descMap.get(compositeKey) || descMap.get(classId);
                if (info && assetId) {
                    if (info.name) assetToNameMap.set(assetId, info.name);
                    if (info.iconUrl) assetToIconMap.set(assetId, info.iconUrl);
                    if (info.isCache) {
                        assetCaches.add(assetId);
                        if (info.iconUrl) iconCaches.add(info.iconUrl);
                    }
                }
            });

            console.log(`SIH Lite: Indexed ${assetToNameMap.size} inventory items.`);
            recalculateAndRender();
            return true;
        } catch (err) {
            console.error("SIH Lite: Legacy inventory fetch error", err);
        }
    }
    return false;
}

/**
 * Cross-links price dictionary to parsed items & icons
 */
function recalculateAndRender() {
    assetToNameMap.forEach((name, assetId) => {
        const price = getPriceForName(name);
        if (price) {
            assetPrices.set(assetId, price);
            const iconUrl = assetToIconMap.get(assetId);
            if (iconUrl) iconPrices.set(iconUrl, price);
        }
    });
    renderPrices();
}

/**
 * Resolves SteamID64
 */
async function getInventoryOwnerSteamId() {
    const pathname = window.location.pathname;

    const profileMatch = pathname.match(/\/profiles\/(7656119\d{10})/);
    if (profileMatch) return profileMatch[1];

    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
        const text = script.textContent;

        const ownerMatch = text.match(/g_ownerSteamID\s*=\s*["']?(7656119\d{10})["']?/);
        if (ownerMatch) return ownerMatch[1];

        const viewingMatch = text.match(/UserYouAreViewing[\s\S]*?"strSteamId"\s*:\s*"(7656119\d{10})"/);
        if (viewingMatch) return viewingMatch[1];
    }

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
 * Builds price lookup map with universal extractor
 */
function buildPriceMap(items) {
    priceByNameMap.clear();

    items.forEach(item => {
        const parsed = extractNameAndPrice(item);
        if (!parsed) return;

        priceByNameMap.set(parsed.name.trim().toLowerCase(), parsed.price);
        priceByNameMap.set(cleanName(parsed.name), parsed.price);
    });

    console.log(`SIH Lite: Processed ${priceByNameMap.size} valid prices.`);
    recalculateAndRender();
}

/**
 * Renders inventory value banner
 */
function renderTotalValue(items) {
    if (!Array.isArray(items)) return;

    let totalDollars = 0;
    items.forEach(item => {
        const parsed = extractNameAndPrice(item);
        if (parsed) totalDollars += parseFloat(parsed.price);
    });

    let header = document.querySelector('.sih-lite-total');
    if (!header) {
        header = document.createElement('div');
        header.className = 'sih-lite-total';
        const targetContainer = document.querySelector('#inventory_items') || document.querySelector('.inventory_header');
        if (targetContainer && targetContainer.parentNode) {
            targetContainer.parentNode.insertBefore(header, targetContainer);
        }
    }

    if (header) {
        header.innerText = `Total Inventory Value: $${totalDollars.toFixed(2)}`;
    }
}

/**
 * Main rendering engine
 */
function renderPrices() {
    const itemSlots = document.querySelectorAll('.itemHolder .item, div.item');

    itemSlots.forEach(slot => {
        let assetId = null;

        if (slot.id) {
            const match = slot.id.match(/570_2_(\d+)/);
            if (match) assetId = match[1];
        }

        if (!assetId) {
            const link = slot.querySelector('a.inventory_item_link');
            if (link && link.href) {
                const match = link.href.match(/570_2_(\d+)/);
                if (match) assetId = match[1];
            }
        }

        const img = slot.querySelector('img');
        const iconUrl = img ? extractIconUrl(img.src) : null;
        const titleName = img ? (img.alt || img.title || '') : '';

        let price = null;
        let isCache = false;

        // Step 1: Asset ID lookup
        if (assetId) {
            price = assetPrices.get(assetId);
            if (!price && assetToNameMap.has(assetId)) {
                price = getPriceForName(assetToNameMap.get(assetId));
            }
            if (assetCaches.has(assetId)) isCache = true;
        }

        // Step 2: Icon Hash lookup (for duplicates)
        if (!price && iconUrl) {
            price = iconPrices.get(iconUrl);
            if (iconCaches.has(iconUrl)) isCache = true;
        }

        // Step 3: Image Title / Alt text fallback
        if (!price && titleName) {
            price = getPriceForName(titleName);
            if (titleName.toLowerCase().includes("collector's cache")) isCache = true;
        }

        // Automatic icon -> price auto-learning
        if (price && iconUrl && !iconPrices.has(iconUrl)) {
            iconPrices.set(iconUrl, price);
        }

        let badgeType = null;
        let badgeValue = null;

        if (price) {
            badgeType = 'price';
            badgeValue = `$${price}`;
        } else if (isCache) {
            badgeType = 'cache';
            badgeValue = 'Cache';
        }

        let badge = slot.querySelector('.sih-lite-badge');

        if (badgeType && badgeValue) {
            const className = `sih-lite-badge sih-lite-${badgeType}`;

            if (!badge) {
                badge = document.createElement('div');
                badge.className = className;
                badge.textContent = badgeValue;
                slot.appendChild(badge);
            } else {
                if (badge.className !== className) badge.className = className;
                if (badge.textContent !== badgeValue) badge.textContent = badgeValue;
            }
        } else if (badge) {
            badge.remove();
        }
    });
}

// Execution
injectStyles();

(async function init() {
    const targetSteamId = await getInventoryOwnerSteamId();

    if (targetSteamId) {
        console.log("SIH Lite: Detected inventory owner Steam ID ->", targetSteamId);

        setInterval(renderPrices, 350);

        fetchLegacySteamInventory(targetSteamId);

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