(() => {
    'use strict';
    const assetPrices = new Map();
    const namePrices = new Map();
    const inventoryItems = new Map();
    const pendingSorts = new Map();
    let steamId = null, activeDota = false, generation = 0;
    let priceState = 'loading', totalCents = null;
    let profileError = '', priceError = '', sortStatus = '', sortOrder = 'original';
    let busy = false, renderQueued = false, requestNumber = 0;
    let profileLoad = Promise.resolve();

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
        for (const item of items) {
            const cents = parsePrice(item);
            if (cents === null) continue;
            const assetId = item.assetid ?? item.assetId ?? item.asset_id ?? item.id;
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
            const timer = setTimeout(() => reject(new Error('Час очікування Steamprice вичерпано. Спробуйте ще раз.')), 180000);
            try {
                chrome.runtime.sendMessage({ action, steamId: id }, response => {
                    clearTimeout(timer);
                    const error = chrome.runtime.lastError;
                    if (error) reject(new Error(error.message));
                    else if (!response?.success) reject(new Error(response?.error || 'Steamprice не повернув дані.'));
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
            if (!Array.isArray(data?.items)) throw new Error('Некоректна відповідь з цінами.');
            buildPrices(data.items);
            priceState = 'ready';
            queueRender();
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
                throw new Error('Steamprice не повернув totalValueCents.');
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
        assetPrices.clear(); namePrices.clear(); inventoryItems.clear();
        for (const pending of pendingSorts.values()) clearTimeout(pending.timer);
        pendingSorts.clear();
        profileLoad = loadProfile(id, generation);
        loadPrices(id, generation);
    }

    function sortInventory(order) {
        if (!activeDota || busy || (order !== 'original' && priceState !== 'ready')) return;
        busy = true; sortStatus = 'Завантажуємо всі предмети інвентарю…';
        const requestId = `${Date.now()}-${++requestNumber}`;
        const timer = setTimeout(() => {
            pendingSorts.delete(requestId); busy = false;
            sortStatus = 'Steam не завершив завантаження. Спробуйте ще раз.'; queueRender();
        }, 125000);
        pendingSorts.set(requestId, { timer, order, generation });
        window.postMessage({source: 'SIH_LITE_CONTENT', type: 'SORT', requestId, steamId, order,
            prices: {assetPrices: Array.from(assetPrices), namePrices: Array.from(namePrices)}}, window.location.origin);
        queueRender();
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
        for (const [order, label] of [['desc', 'Ціна ↓'], ['asc', 'Ціна ↑'], ['original', 'Порядок Steam']]) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'sih-lite-sort-btn';
            button.dataset.order = order; button.textContent = label;
            button.addEventListener('click', () => sortInventory(order)); panel.appendChild(button);
        }
        const retry = document.createElement('button'); retry.type = 'button'; retry.id = 'sih-lite-retry';
        retry.className = 'sih-lite-sort-btn'; retry.textContent = 'Повторити';
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
                ? `Вартість Dota 2: ${money(totalCents)}` : profileError ? 'Вартість недоступна' : 'Завантажуємо вартість…');
            panel.querySelector('#sih-lite-total-text').title = 'Повна оцінка інвентарю від Steamprice; дані можуть оновлюватися із затримкою.';
            for (const button of panel.querySelectorAll('[data-order]')) {
                button.disabled = busy || (button.dataset.order !== 'original' && priceState !== 'ready');
                button.setAttribute('aria-pressed', String(button.dataset.order === sortOrder));
            }
            panel.querySelector('#sih-lite-retry').hidden = !profileError && priceState !== 'error';
            setText(panel.querySelector('#sih-lite-status'), [priceState === 'loading' ? 'Завантажуємо ціни Steamprice…' : priceError,
                profileError, sortStatus].filter(Boolean).join(' '));
        }
        for (const slot of document.querySelectorAll('.itemHolder .item, div.item')) {
            const match = (slot.id || slot.querySelector('a.inventory_item_link')?.href || '').match(/(?:item)?570_2_(\d+)/);
            let badge = slot.querySelector('.sih-lite-badge');
            if (!activeDota || !match) { if (badge) badge.remove(); continue; }
            const assetId = match[1], info = inventoryItems.get(assetId), image = slot.querySelector('img');
            const name = info?.name || image?.alt || image?.title || '';
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

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== 'SIH_LITE_PAGE') return;
        const message = event.data;
        if (message.type === 'STATE') {
            const wasActive = activeDota;
            activeDota = String(message.appId) === '570' && String(message.contextId) === '2' && /^\d{17}$/.test(String(message.steamId));
            if (activeDota && /^\d{17}$/.test(String(message.steamId))) setOwner(String(message.steamId));
            if (activeDota && !busy && ['asc', 'desc', 'original'].includes(message.order)) {
                if (sortOrder !== message.order) sortStatus = '';
                sortOrder = message.order;
            }
            if (wasActive !== activeDota || activeDota) queueRender();
        } else if (message.type === 'INVENTORY' && String(message.steamId) === steamId && String(message.appId) === '570' && String(message.contextId) === '2' && Array.isArray(message.items)) {
            inventoryItems.clear();
            for (const item of message.items) if (item && /^\d+$/.test(String(item.assetId))) inventoryItems.set(String(item.assetId), item);
            queueRender();
        } else if (message.type === 'SORT_RESULT' || message.type === 'SORT_PROGRESS') {
            const pending = pendingSorts.get(message.requestId);
            if (!pending || pending.generation !== generation) return;
            if (message.type === 'SORT_PROGRESS') sortStatus = message.message ||
                (Number.isSafeInteger(message.loaded) && Number.isSafeInteger(message.total)
                    ? `Завантажуємо предмети: ${message.loaded} / ${message.total}…` : 'Завантажуємо всі предмети…');
            else {
                clearTimeout(pending.timer); pendingSorts.delete(message.requestId); busy = false;
                if (message.success) {
                    sortOrder = pending.order;
                    sortStatus = pending.order === 'original' ? 'Відновлено порядок Steam.'
                        : `Відсортовано ${message.count} предметів. Предмети без ціни — в кінці.`;
                } else sortStatus = message.error || 'Не вдалося відсортувати інвентар.';
            }
            queueRender();
        }
    });
    new MutationObserver(queueRender).observe(document.documentElement, {subtree: true, childList: true});
    window.postMessage({source: 'SIH_LITE_CONTENT', type: 'STATE_REQUEST'}, window.location.origin);
    queueRender();
})();
