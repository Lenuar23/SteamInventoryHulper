console.log("SIH Lite: Extension loaded!");

/**
 * Injects CSS rules for price badges once into the DOM head
 */
function injectStyles() {
    if (document.getElementById("sih-lite-styles")) return;
    const style = document.createElement("style");
    style.id = "sih-lite-styles";
    style.textContent = `
        .sih-lite-price {
            position: absolute !important;
            bottom: 2px !important;
            right: 2px !important;
            background-color: rgba(0, 0, 0, 0.85) !important;
            color: #5cff5c !important;
            font-size: 11px !important;
            font-weight: bold !important;
            padding: 2px 4px !important;
            border-radius: 3px !important;
            z-index: 10 !important;
            pointer-events: none !important;
            user-select: none !important;
            box-shadow: 0 0 3px rgba(0,0,0,0.8) !important;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Resolves full 17-digit SteamID64 for inventory owner, converting custom URLs if needed
 * @returns {Promise<string|null>} 17-digit SteamID64
 */
async function getInventoryOwnerSteamId() {
    const pathname = window.location.pathname;

    // 1. Direct path match for numeric profiles (/profiles/7656119...)
    const profileMatch = pathname.match(/\/profiles\/(7656119\d{10})/);
    if (profileMatch) return profileMatch[1];

    // 2. Scan script tags specifically for inventory owner variables (ignoring viewer header)
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
        const text = script.textContent;

        // g_ownerSteamID strictly holds the target inventory owner ID
        const ownerMatch = text.match(/g_ownerSteamID\s*=\s*["']?(7656119\d{10})["']?/);
        if (ownerMatch) return ownerMatch[1];

        // UserYouAreViewing object on custom profile pages
        const viewingMatch = text.match(/UserYouAreViewing[\s\S]*?"strSteamId"\s*:\s*"(7656119\d{10})"/);
        if (viewingMatch) return viewingMatch[1];

        // g_rgProfileData object
        const profileDataMatch = text.match(/g_rgProfileData[\s\S]*?"steamid"\s*:\s*"(7656119\d{10})"/);
        if (profileDataMatch) return profileDataMatch[1];
    }

    // 3. Fallback for Custom URLs (/id/custom_name/): Resolve SteamID64 via Steam XML endpoint
    const customIdMatch = pathname.match(/\/id\/([^\/]+)/);
    if (customIdMatch) {
        const customSlug = customIdMatch[1];
        try {
            const xmlUrl = `${window.location.origin}/id/${customSlug}?xml=1`;
            const response = await fetch(xmlUrl);
            if (response.ok) {
                const xmlText = await response.text();
                const steamIdMatch = xmlText.match(/<steamID64>(7656119\d{10})<\/steamID64>/);
                if (steamIdMatch) {
                    return steamIdMatch[1];
                }
            }
        } catch (err) {
            console.error("SIH Lite: Error resolving custom Steam ID via XML fallback", err);
        }
    }

    return null;
}

/**
 * Renders total inventory value banner above the item grid
 * @param {Array} items - Array of items from API
 */
function renderTotalValue(items) {
    if (!Array.isArray(items)) return;

    const totalCents = items.reduce((sum, item) => sum + (item.priceCents || 0), 0);
    const totalDollars = (totalCents / 100).toFixed(2);

    let header = document.querySelector('.sih-lite-total');
    if (!header) {
        header = document.createElement('div');
        header.className = 'sih-lite-total';
        
        Object.assign(header.style, {
            fontSize: '15px',
            fontWeight: 'bold',
            color: '#66c0f4',
            marginBottom: '12px',
            padding: '8px 14px',
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            borderRadius: '4px',
            borderLeft: '4px solid #5cff5c',
            display: 'inline-block'
        });

        const targetContainer = document.querySelector('#inventory_items') || document.querySelector('.inventory_header');
        if (targetContainer && targetContainer.parentNode) {
            targetContainer.parentNode.insertBefore(header, targetContainer);
        }
    }

    header.innerText = `Total Inventory Value: $${totalDollars}`;
}

// Storage maps for price lookups
let priceByAssetId = new Map();
let priceByName = new Map();

/**
 * Builds price lookups for assetid (primary) and name (fallback for Collector's Cache)
 * @param {Array} items 
 */
function buildPriceMaps(items) {
    priceByAssetId.clear();
    priceByName.clear();

    items.forEach(item => {
        if (!item.priceCents) return;
        const formattedPrice = (item.priceCents / 100).toFixed(2);

        if (item.assetid) {
            priceByAssetId.set(String(item.assetid), formattedPrice);
        }

        const itemName = item.market_hash_name || item.name || item.market_name;
        if (itemName) {
            priceByName.set(itemName.trim().toLowerCase(), formattedPrice);
        }
    });
}

/**
 * Renders price badges without modifying layout structure or blocking mouse clicks
 */
function renderPrices() {
    const inventoryLinks = document.querySelectorAll('a.inventory_item_link');

    inventoryLinks.forEach(el => {
        if (el.dataset.sihProcessed === "true") return;

        const href = el.getAttribute('href') || '';
        const assetIdMatch = href.match(/#570_2_(\d+)/);

        if (assetIdMatch) {
            const assetId = assetIdMatch[1];
            let price = priceByAssetId.get(assetId);

            // Fallback for non-marketable items like Collector's Cache
            if (!price) {
                const img = el.querySelector('img');
                const title = img ? (img.alt || img.title || '') : '';
                if (title) {
                    price = priceByName.get(title.trim().toLowerCase());
                }
            }

            if (price) {
                const priceBadge = document.createElement('div');
                priceBadge.className = 'sih-lite-price';
                priceBadge.innerText = `$${price}`;
                el.appendChild(priceBadge);
            }

            el.dataset.sihProcessed = "true";
        }
    });
}

/**
 * Observes DOM changes when switching inventory pages
 */
function initObserver() {
    const target = document.querySelector('#inventory_items') || document.body;
    const observer = new MutationObserver((mutations) => {
        let shouldRender = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldRender = true;
                break;
            }
        }
        if (shouldRender) {
            renderPrices();
        }
    });

    observer.observe(target, { childList: true, subtree: true });
}

// Main execution flow
injectStyles();

(async function init() {
    const targetSteamId = await getInventoryOwnerSteamId();

    if (targetSteamId) {
        console.log("SIH Lite: Successfully detected inventory owner Steam ID ->", targetSteamId);
        
        chrome.runtime.sendMessage({ action: "fetchPrices", steamId: targetSteamId }, (response) => {
            if (response && response.success && response.data?.items) {
                console.log(`SIH Lite: Loaded total of ${response.data.items.length} items from API.`);
                
                buildPriceMaps(response.data.items);
                renderTotalValue(response.data.items);
                renderPrices();
                initObserver();
            } else {
                console.error("SIH Lite: Failed to retrieve prices from API.", response?.error);
            }
        });
    } else {
        console.warn("SIH Lite: Could not determine inventory owner Steam ID on this page.");
    }
})();