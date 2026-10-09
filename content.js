(() => {
    'use strict';
    const assetPrices = new Map();
    const namePrices = new Map();
    const inventoryItems = new Map();
    const apiGemInfo = new Map();
    const pendingSorts = new Map();
    let steamId = null, activeDota = false, generation = 0;
    let priceState = 'loading', totalCents = null;
    let profileError = '', priceError = '', sortStatus = '', sortOrder = 'original';
    let busy = false, renderQueued = false, requestNumber = 0;
    let profileLoad = Promise.resolve();
    let gemFilter = 'all', gemDataRevision = 0;
    let refreshGemDataAfterState = false;

    const cleanName = name => String(name || '').toLowerCase()
        .replace(/^(inscribed|autographed|corrupted|frozen|heroic|cursed|genuine|favored|ascent|elder|unusual|exalted|infused|auspicious|base|legacy|sealed)\s+/i, '')
        .replace(/\s+(bundle|set)$/i, '').trim();
    const money = cents => `$${(cents / 100).toFixed(2)}`;

    function parsePrice(item) {
        if (!item || typeof item !== 'object') return null;
        for (const key of ['collectorAvgSaleCents', 'collectorLowestAskCents', 'priceCents', 'price_cents', 'scmPriceCents', 'basePriceCents']) {
            if (!['number', 'string'].includes(typeof item[key]) || String(item[key]).trim() === '') continue;
            const number = Number(item[key]);
            if (number >= 0 && Number.isSafeInteger(Math.round(number))) return Math.round(number);
        }
        for (const key of ['price', 'lowest_price', 'cost', 'value']) {
            if (!['number', 'string'].includes(typeof item[key]) || String(item[key]).trim() === '') continue;
            const cleaned = typeof item[key] === 'string' ? item[key].replace(/[^0-9.,]/g, '').replace(',', '.') : item[key];
            if (cleaned === '') continue;
            const number = typeof item[key] === 'string'
                ? Number(cleaned) : item[key];
            if (number >= 0 && Number.isSafeInteger(Math.round(number * 100))) return Math.round(number * 100);
        }
        return null;
    }

    function buildPrices(items) {
        assetPrices.clear();
        namePrices.clear();
        apiGemInfo.clear();
        gemDataRevision++;
        for (const item of items) {
            const assetId = item.assetid ?? item.assetId ?? item.asset_id ?? item.id;
            if (/^\d{1,20}$/.test(String(assetId))) {
                apiGemInfo.set(String(assetId), globalThis.SIHLiteGems.analyzeSteampriceItem(item));
            }
            const cents = parsePrice(item);
            if (cents === null) continue;
            if (/^\d{1,20}$/.test(String(assetId))) assetPrices.set(String(assetId), cents);
            const name = item.marketHashName || item.market_hash_name || item.hash_name || item.name || item.marketName || item.market_name || item.title || item.item_name;
            if (name) {
                for (const key of [String(name).trim().toLowerCase(), cleanName(name)]) {
                    if (key && key.length <= 512) namePrices.set(key, cents);
                }
            }
        }
    }

    function getPrice(assetId, name) {
        if (assetPrices.has(assetId)) return assetPrices.get(assetId);
        const raw = String(name || '').trim().toLowerCase();
        if (namePrices.has(raw)) return namePrices.get(raw);
        return namePrices.get(cleanName(name)) ?? null;
    }

    function request(action, id) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Steamprice request timed out. Please try again.')), 180000);
            try {
                chrome.runtime.sendMessage({ action, steamId: id }, response => {
                    clearTimeout(timer);
                    const error = chrome.runtime.lastError;
                    if (error) reject(new Error(error.message));
                    else if (!response?.success) reject(new Error(response?.error || 'Steamprice did not return any data.'));
                    else resolve(response.data);
                });
            } catch (error) { clearTimeout(timer); reject(error); }
        });
    }

    async function loadPrices(id, currentGeneration) {
        priceState = 'loading'; priceError = ''; queueRender();
        try {
            const data = await request('fetchPrices', id);
            if (currentGeneration !== generation) return;
            if (!Array.isArray(data?.items)) throw new Error('Invalid price response.');
            buildPrices(data.items);
            priceState = 'ready';
            queueRender();
            if (activeDota && gemFilter === 'colored' && !busy) filterInventory('colored');
            // Empty price caches may have triggered a scan; request the total again
            // after the initial profile request settles, avoiding a stale overwrite.
            await profileLoad;
            if (currentGeneration === generation) profileLoad = loadProfile(id, currentGeneration);
        } catch (error) {
            if (currentGeneration !== generation) return;
            priceState = 'error'; priceError = error.message;
        }
        queueRender();
    }

    async function loadProfile(id, currentGeneration) {
        profileError = '';
        try {
            const data = await request('fetchProfile', id);
            if (currentGeneration !== generation) return;
            const value = data?.totalValueCents;
            if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
                throw new Error('Steamprice did not return totalValueCents.');
            }
            totalCents = Math.round(Number(value));
        } catch (error) {
            if (currentGeneration !== generation) return;
            profileError = error.message;
        }
        queueRender();
    }

    function setOwner(id) {
        if (steamId === id) return;
        steamId = id; generation++;
        totalCents = null; priceState = 'loading';
        priceError = profileError = sortStatus = ''; sortOrder = 'original'; busy = false;
        gemFilter = 'all'; gemDataRevision++; refreshGemDataAfterState = false;
        assetPrices.clear(); namePrices.clear(); inventoryItems.clear(); apiGemInfo.clear();
        for (const pending of pendingSorts.values()) clearTimeout(pending.timer);
        pendingSorts.clear();
        profileLoad = loadProfile(id, generation);
        loadPrices(id, generation);
    }

    function sortInventory(order) {
        if (!activeDota || busy || (order !== 'original' && priceState !== 'ready')) return;
        busy = true; sortStatus = 'Loading all inventory items…';
        const requestId = `${Date.now()}-${++requestNumber}`;
        const timer = setTimeout(() => {
            pendingSorts.delete(requestId); busy = false;
            sortStatus = 'Steam did not finish loading. Please try again.'; queueRender();
            requestNativeState();
        }, 125000);
        pendingSorts.set(requestId, { timer, type: 'SORT', order, generation, gemDataRevision });
        window.postMessage({source: 'SIH_LITE_CONTENT', type: 'SORT', requestId, steamId, order,
            prices: {assetPrices: Array.from(assetPrices), namePrices: Array.from(namePrices)}}, window.location.origin);
        queueRender();
    }

    function filterInventory(mode) {
        if (!activeDota || busy || !['all', 'colored'].includes(mode)) return;
        busy = true;
        sortStatus = mode === 'colored' ? 'Loading items with colored gems…' : 'Showing all items…';
        const requestId = `${Date.now()}-${++requestNumber}`;
        const timer = setTimeout(() => {
            pendingSorts.delete(requestId); busy = false;
            sortStatus = 'Steam did not finish loading. Please try again.'; queueRender();
            requestNativeState();
        }, 125000);
        pendingSorts.set(requestId, { timer, type: 'FILTER_GEMS', mode, generation, gemDataRevision });
        const gemAssetIds = [], coloredAssetIds = [];
        for (const [assetId, info] of apiGemInfo) {
            if (info.hasGems) gemAssetIds.push(assetId);
            if (info.hasColoredGem) coloredAssetIds.push(assetId);
        }
        window.postMessage({source: 'SIH_LITE_CONTENT', type: 'FILTER_GEMS', requestId, steamId,
            mode, gemAssetIds, coloredAssetIds}, window.location.origin);
        queueRender();
    }

    function gemInfoFor(assetId) {
        const native = inventoryItems.get(assetId) || {};
        const api = apiGemInfo.get(assetId) || {};
        // Steam's current socket color takes precedence over a cached API color.
        const nativeColorKnown = (native.prismaticGems || []).some(gem => gem?.color &&
            ['r', 'g', 'b'].every(channel => Number.isSafeInteger(gem.color[channel]) && gem.color[channel] >= 0 && gem.color[channel] <= 255));
        return {
            ...native, ...api,
            hasGems: Boolean(native.hasGems || api.hasGems),
            hasColoredGem: Boolean(native.hasColoredGem || api.hasColoredGem),
            isLegacy: nativeColorKnown ? Boolean(native.isLegacy) : Boolean(native.isLegacy || api.isLegacy),
            legacyRgb: nativeColorKnown ? native.legacyRgb || null : api.legacyRgb || native.legacyRgb || null,
            gems: [...(native.gems || []), ...(api.gems || [])],
            prismaticGems: nativeColorKnown ? native.prismaticGems : [...(native.prismaticGems || []), ...(api.prismaticGems || [])],
            etherealGems: native.etherealGems?.length ? native.etherealGems : api.etherealGems || []
        };
    }

    function renderColorLink(slot, assetId, name) {
        const info = gemInfoFor(assetId);
        const url = activeDota && info.hasColoredGem ? globalThis.SIHLiteGems.makeViewerUrl(name, info) : null;
        let link = slot.querySelector('.sih-lite-color-link');
        if (!url) { if (link) link.remove(); return; }
        if (!link) {
            link = document.createElement('a');
            link.className = 'sih-lite-color-link';
            link.textContent = 'View color';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.setAttribute('aria-label', 'View gem color on Steamprice');
            for (const eventName of ['click', 'mousedown', 'pointerdown']) {
                link.addEventListener(eventName, event => event.stopPropagation());
            }
            slot.appendChild(link);
        }
        if (link.href !== url) link.href = url;
        link.title = 'Preview this gem color on Steamprice; the effect may differ from the item.';
    }

    function installStyles() {
        if (document.getElementById('sih-lite-styles')) return;
        const style = document.createElement('style'); style.id = 'sih-lite-styles';
        style.textContent = `
            #sih-lite-ui-container { display:flex; flex-wrap:wrap; align-items:center; gap:8px;
                margin:8px 0; padding:10px; box-sizing:border-box; background:rgba(0,0,0,.4); border-radius:4px; }
            #sih-lite-ui-container[hidden] { display:none; }
            .sih-lite-total { color:#66c0f4; font-weight:bold; margin-right:auto; }
            .sih-lite-sort-btn { background:#39516a; color:#fff; border:1px solid #536b83;
                padding:5px 9px; border-radius:3px; cursor:pointer; }
            .sih-lite-sort-btn:disabled { opacity:.5; cursor:default; }
            .sih-lite-sort-btn[aria-pressed="true"] { border-color:#5cff5c; }
            #sih-lite-status { width:100%; color:#b8b9ba; font-size:12px; overflow-wrap:anywhere; }
            .sih-lite-badge { position:absolute!important; bottom:2px!important; right:2px!important;
                font-size:11px!important; font-weight:bold; padding:2px 5px; border-radius:3px;
                pointer-events:none; user-select:none; line-height:1.2; z-index:3; }
            .sih-lite-price { background:rgba(0,0,0,.9); color:#5cff5c; border:1px solid #5cff5c; }
            .sih-lite-cache { background:#2d0a3c; color:#d070ff; border:1px solid #d070ff; }
            .sih-lite-color-link { position:absolute; top:3px; left:3px; z-index:4;
                padding:2px 4px; border:1px solid #9bbcd5; border-radius:3px; font-size:10px;
                line-height:1.3; color:#fff!important; background:rgba(22,40,55,.95); text-decoration:none!important; }
            .sih-lite-color-link:hover, .sih-lite-color-link:focus-visible { background:#39516a; outline:1px solid #fff; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function ensurePanel() {
        let panel = document.getElementById('sih-lite-ui-container');
        if (panel) return panel;
        const target = document.querySelector('#inventories, #inventory_items, .inventory_pagecontrols, .inventory_header');
        if (!target?.parentNode) return null;
        panel = document.createElement('div'); panel.id = 'sih-lite-ui-container';
        const total = document.createElement('span'); total.id = 'sih-lite-total-text'; total.className = 'sih-lite-total';
        panel.appendChild(total);
        for (const [order, label] of [['desc', 'Price ↓'], ['asc', 'Price ↑'], ['original', 'Steam order']]) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'sih-lite-sort-btn';
            button.dataset.order = order; button.textContent = label;
            button.addEventListener('click', () => sortInventory(order)); panel.appendChild(button);
        }
        const gemButton = document.createElement('button');
        gemButton.type = 'button'; gemButton.id = 'sih-lite-gem-filter';
        gemButton.className = 'sih-lite-sort-btn'; gemButton.textContent = 'Colored gems only';
        gemButton.title = 'Show items with inserted Prismatic or Ethereal gems.';
        gemButton.addEventListener('click', () => filterInventory(gemFilter === 'colored' ? 'all' : 'colored'));
        panel.appendChild(gemButton);
        const retry = document.createElement('button'); retry.type = 'button'; retry.id = 'sih-lite-retry';
        retry.className = 'sih-lite-sort-btn'; retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
            if (!steamId) return;
            if (priceState === 'error') loadPrices(steamId, generation);
            if (profileError) loadProfile(steamId, generation);
        });
        panel.appendChild(retry);
        const status = document.createElement('div'); status.id = 'sih-lite-status';
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.appendChild(status);
        target.parentNode.insertBefore(panel, target);
        return panel;
    }

    function setText(element, text) { if (element && element.textContent !== text) element.textContent = text; }

    function render() {
        installStyles();
        const panel = ensurePanel();
        if (panel) {
            panel.hidden = !activeDota;
            setText(panel.querySelector('#sih-lite-total-text'), totalCents !== null
                ? `Dota 2 value: ${money(totalCents)}` : profileError ? 'Inventory value unavailable' : 'Loading inventory value…');
            panel.querySelector('#sih-lite-total-text').title = 'Full inventory valuation from Steamprice; updates may be delayed.';
            for (const button of panel.querySelectorAll('[data-order]')) {
                button.disabled = busy || (button.dataset.order !== 'original' && priceState !== 'ready');
                button.setAttribute('aria-pressed', String(button.dataset.order === sortOrder));
            }
            const gemButton = panel.querySelector('#sih-lite-gem-filter');
            gemButton.disabled = busy;
            gemButton.setAttribute('aria-pressed', String(gemFilter === 'colored'));
            panel.querySelector('#sih-lite-retry').hidden = !profileError && priceState !== 'error';
            setText(panel.querySelector('#sih-lite-status'), [priceState === 'loading' ? 'Loading Steamprice prices…' : priceError,
                profileError, sortStatus].filter(Boolean).join(' '));
        }
        for (const slot of document.querySelectorAll('.itemHolder .item, div.item')) {
            const match = (slot.id || slot.querySelector('a.inventory_item_link')?.href || '').match(/(?:item)?570_2_(\d+)/);
            let badge = slot.querySelector('.sih-lite-badge');
            if (!activeDota || !match) {
                if (badge) badge.remove();
                slot.querySelector('.sih-lite-color-link')?.remove();
                continue;
            }
            const assetId = match[1], info = inventoryItems.get(assetId), image = slot.querySelector('img');
            const name = info?.name || image?.alt || image?.title || '';
            renderColorLink(slot, assetId, name);
            const cents = getPrice(assetId, name), isCache = info?.isCache || /collector'?s cache/i.test(name);
            if (cents === null && !isCache) { if (badge) badge.remove(); continue; }
            if (!badge) { badge = document.createElement('div'); slot.appendChild(badge); }
            const className = `sih-lite-badge sih-lite-${cents === null ? 'cache' : 'price'}`;
            if (badge.className !== className) badge.className = className;
            setText(badge, cents === null ? 'Cache' : money(cents));
        }
    }

    function queueRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {renderQueued = false; render();});
    }

    function requestNativeState() {
        window.postMessage({source: 'SIH_LITE_CONTENT', type: 'STATE_REQUEST'}, window.location.origin);
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== 'SIH_LITE_PAGE') return;
        const message = event.data;
        if (message.type === 'STATE') {
            const wasActive = activeDota;
            activeDota = String(message.appId) === '570' && String(message.contextId) === '2' && /^\d{17}$/.test(String(message.steamId));
            if (activeDota && /^\d{17}$/.test(String(message.steamId))) setOwner(String(message.steamId));
            if (activeDota && ['asc', 'desc', 'original'].includes(message.order)) {
                if (!busy && sortOrder !== message.order) sortStatus = '';
                sortOrder = message.order;
            }
            if (activeDota && ['all', 'colored'].includes(message.gemFilter)) gemFilter = message.gemFilter;
            if (!busy && refreshGemDataAfterState) {
                refreshGemDataAfterState = false;
                if (activeDota && gemFilter === 'colored') filterInventory('colored');
            }
            if (wasActive !== activeDota || activeDota) queueRender();
        } else if (message.type === 'INVENTORY' && String(message.steamId) === steamId && String(message.appId) === '570' && String(message.contextId) === '2' && Array.isArray(message.items)) {
            inventoryItems.clear();
            for (const item of message.items) if (item && /^\d+$/.test(String(item.assetId))) inventoryItems.set(String(item.assetId), item);
            queueRender();
        } else if (['SORT_RESULT', 'SORT_PROGRESS', 'FILTER_RESULT', 'FILTER_PROGRESS'].includes(message.type)) {
            const pending = pendingSorts.get(message.requestId);
            if (!pending || pending.generation !== generation) return;
            if (message.type === 'SORT_PROGRESS' || message.type === 'FILTER_PROGRESS') sortStatus = message.message ||
                (Number.isSafeInteger(message.loaded) && Number.isSafeInteger(message.total)
                    ? `Loading items: ${message.loaded} / ${message.total}…` : 'Loading all items…');
            else {
                clearTimeout(pending.timer); pendingSorts.delete(message.requestId); busy = false;
                if (message.success) {
                    if (pending.type === 'FILTER_GEMS') {
                        gemFilter = pending.mode;
                        sortStatus = pending.mode === 'colored'
                            ? `${message.count} items have colored gems. Steam text and tag filters still apply.`
                            : 'Showing all items. Steam text and tag filters still apply.';
                    } else {
                        sortOrder = pending.order;
                        sortStatus = pending.order === 'original' ? 'Steam order restored.'
                            : `Sorted ${message.count} items. Unpriced items are shown last.`;
                    }
                    if (gemFilter === 'colored' && pending.gemDataRevision !== gemDataRevision) filterInventory('colored');
                } else {
                    sortStatus = message.error || (pending.type === 'FILTER_GEMS' ? 'Could not filter the inventory.' : 'Could not sort the inventory.');
                    refreshGemDataAfterState = gemFilter === 'colored' && pending.gemDataRevision !== gemDataRevision;
                    requestNativeState();
                }
            }
            queueRender();
        }
    });
    new MutationObserver(queueRender).observe(document.documentElement, {subtree: true, childList: true});
    requestNativeState();
    queueRender();
})();
