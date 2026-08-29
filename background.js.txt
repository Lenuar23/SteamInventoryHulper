// This background script handles API requests to bypass CSP restrictions on Steam pages.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchPrices") {
        const steamId = request.steamId;
        // Construct the API URL for SteamPrice
        const url = `https://steamprice.com/api/dota2/inventory/${steamId}?page=1&pageSize=100`;

        fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                // Send the JSON data back to the content script
                sendResponse({ success: true, data: data });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });

        // Return true to indicate that sendResponse will be called asynchronously
        return true; 
    }
});