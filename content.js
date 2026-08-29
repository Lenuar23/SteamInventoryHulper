console.log("SIH Lite: Extension loaded on Steam inventory page!");

// Helper function to extract the Steam ID from the current URL
function getSteamIdFromUrl() {
    const pathParts = window.location.pathname.split('/');
    // Check if the URL follows the standard /profiles/STEAM_ID/inventory format
    if (pathParts[1] === 'profiles') {
        return pathParts[2];
    }
    // Note: Custom URLs (/id/custom_name/) will require a different approach to find the numeric ID
    return null; 
}

const steamId = getSteamIdFromUrl();

if (steamId) {
    console.log("Found Steam ID:", steamId, "Fetching prices...");
    
    // Send a message to the background script to fetch the data
    chrome.runtime.sendMessage({ action: "fetchPrices", steamId: steamId }, (response) => {
        if (response && response.success) {
            console.log("🔥 Success! Received data from SteamPrice:", response.data);
            // Future implementation: render the prices directly onto the inventory items
        } else {
            console.error("Error fetching data:", response?.error);
        }
    });
} else {
    console.log("Could not find a numeric Steam ID in the URL.");
}