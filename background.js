chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchPrices") {
        handleFetchPrices(request.steamId)
            .then(allItems => sendResponse({ success: true, data: { items: allItems } }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; 
    }
});

const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Main price fetching manager
 */
async function handleFetchPrices(steamId) {
    // First try fetching prices normally
    let items = await fetchAllPrices(steamId);

    // If inventory is empty (server has not cached this ID yet)
    if (items.length === 0) {
        console.log(`[SIH Lite] Inventory for ${steamId} missing in database. Spawning background tab for scanning...`);
        
        // Open background tab on Steamprice to force scanning
        await triggerScanViaTab(steamId);

        // Wait 5 seconds while the website scans the profile
        await delay(5000);

        // Retry fetching prices
        items = await fetchAllPrices(steamId);
    }

    return items;
}

/**
 * Opens a background tab on Steamprice to trigger inventory scan,
 * then automatically closes it after a few seconds.
 */
function triggerScanViaTab(steamId) {
    return new Promise((resolve) => {
        const targetUrl = `https://steamprice.com/ru/dota2/inventory/${steamId}`;

        // Create background tab (active: false prevents switching away from current page)
        chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
            // Give the website 7 seconds to establish connection and finish scanning
            setTimeout(() => {
                if (tab && tab.id) {
                    chrome.tabs.remove(tab.id, () => {
                        console.log(`[SIH Lite] Background tab closed.`);
                        resolve();
                    });
                } else {
                    resolve();
                }
            }, 7000);
        });
    });
}

/**
 * Fetches all inventory pages recursively from API
 */
async function fetchAllPrices(steamId) {
    let page = 1;
    const pageSize = 200; 
    let allItems = [];
    let hasMorePages = true;

    while (hasMorePages) {
        const url = `https://steamprice.com/api/dota2/inventory/${steamId}?page=${page}&pageSize=${pageSize}&sort=price_desc`;
        try {
            const response = await fetch(url);
            if (!response.ok) break;

            const data = await response.json();
            const items = data.items || [];

            allItems = allItems.concat(items);

            if (items.length < pageSize || (data.totalPages && page >= data.totalPages)) {
                hasMorePages = false;
            } else {
                page++;
            }
        } catch (e) {
            break;
        }

        if (page > 25) break;
    }

    return allItems;
}