# SIH Beta

A Chromium extension that shows prices for your **Dota 2** inventory on Steam.

- Shows individual item prices and the total inventory valuation from Steamprice. The total comes from `/api/dota2/profile/{steamId}` (`totalValueCents`).
- Sorts the entire inventory by price in ascending or descending order, including items on unopened pages. Items with unknown prices stay at the end; zero prices are included.
- The **Steam order** button restores the original item order.
- Keeps Steam's native pages, appearance, filters, and item elements.

## Installation

1. Download or clone the extension into a separate folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. If an earlier version is installed, disable it so that two versions do not modify the inventory at the same time.
5. Reload your Steam inventory page and select Dota 2. Both `/profiles/.../inventory` and `/id/.../inventory` URLs are supported.

Requires Chrome/Chromium 111+ or a compatible browser with Manifest V3 support. A managed browser must allow extension installation through its policy.

## Sorting

Once prices have loaded, click **Price ↓** or **Price ↑**. On the first sort, Steam loads every item through its `LoadCompleteInventory()` method. The panel shows progress, and the buttons remain disabled during loading. Sorting opens the first native inventory page. Subsequent sorts reuse the loaded items.

If Steam fails to load the inventory or limits requests, the extension keeps the previous order and displays an error. Wait a few seconds and click the sort button again. If Steamprice returns an error, **Retry** repeats the failed price or total-value requests. Failed requests produce an error instead of reporting an incomplete inventory as successfully loaded.

Steamprice valuations may be outdated or differ from Steam Market prices. The total value comes directly from the profile API rather than the sum of the displayed items. Item prices are matched by AssetID first, then by name; matching by a cleaned name preserves the previous version's behavior. If Steamprice has no cached inventory, the extension temporarily opens a background tab on the service to trigger a scan, then closes it.

Sorting relies on Steam's internal methods (`LoadCompleteInventory`, `LayoutPages`, and the array of native item holders). Changes to these internals may require an extension update. The safety limits are 100,000 items and 1,000 price pages; exceeding either limit produces an explicit error.

## Development checks

No build step or server is required. The extension consists of `manifest.json`, `background.js`, `content.js`, and `inject.js`.

```sh
node --test tests/background.test.cjs tests/native-inventory.test.cjs
node --test tests/content-browser.test.cjs
```

The second command requires Playwright and Chromium, which are already available in the configured cloud environment. The tests cover API pagination, prices in cents and zero prices, request failures, sorting and order restoration, and panel behavior in the browser. Network responses are mocked, so these tests do not verify current prices for a real inventory.

Additional checks using Steam's official scripts covered 200 items, sequential loading in five batches, native pagination, filters, and clicks on a narrow screen. To rerun that scenario:

```sh
SIH_STEAM_FIXTURES=/workspace/.sih-test-fixtures node tests/steam-browser-integration.cjs
```

In the cloud environment, these fixture files are stored outside the repository. On another machine, place `economy_v2.js`, `jquery-1.11.1.min.js`, and `prototype-1.7.js` from `https://steamcommunity.com/public/javascript/` in a separate folder and set `SIH_STEAM_FIXTURES` to its path. The runner makes no network requests. Set `SIH_CHROMIUM_PATH` if you need to specify the browser executable.
