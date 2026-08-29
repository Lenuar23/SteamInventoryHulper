// Background script handling multi-page API requests to bypass CSP and API pagination limits
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchPrices") {
        const steamId = request.steamId;

        fetchAllPrices(steamId)
            .then(allItems => {
                sendResponse({ success: true, data: { items: allItems } });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });

        return true; // Keep message channel open for async response
    }
});

/**
 * Fetches all inventory pages recursively from SteamPrice API
 * @param {string} steamId 
 * @returns {Promise<Array>} Combined array of all inventory items
 */
async function fetchAllPrices(steamId) {
    let page = 1;
    const pageSize = 200; // API max limit per page
    let allItems = [];
    let hasMorePages = true;

    while (hasMorePages) {
        const url = `https://steamprice.com/api/dota2/inventory/${steamId}?page=${page}&pageSize=${pageSize}&sort=price_desc`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const items = data.items || [];
        
        allItems = allItems.concat(items);

        // Stop fetching if current page has fewer items than pageSize or totalPages reached
        if (items.length < pageSize || (data.totalPages && page >= data.totalPages)) {
            hasMorePages = false;
        } else {
            page++;
        }

        // Safety cap to prevent potential infinite loops (up to 5,000 items)
        if (page > 25) break;
    }

    return allItems;
}