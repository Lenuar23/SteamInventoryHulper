/* Isolated-world trade prices and controls. Steam owns the item elements. */
(() => {
    'use strict';
    const Prices = globalThis.SIHLiteTradePrices;
    const Offers = globalThis.SIHLiteTradeOffers;
    const Accept = globalThis.SIHLiteTradeAccept;
    if (!Prices || !Offers || !Accept || location.origin !== 'https://steamcommunity.com') return;
    const editorPage = /^\/tradeoffer\/(?:new|\d+)\/?$/.test(location.pathname);
    const listPage = /^\/(?:profiles\/\d+|id\/[^/]+)\/tradeoffers(?:\/.*)?$/.test(location.pathname);
    if (!editorPage && !listPage) return;

    const owners = new Map();
    const details = new Map();
    const acceptStates = new Map();
    const requestQueue = [];
    let runningRequests = 0, renderQueued = false, editor = null, list = null;
    let lastRenderAt = 0, badgeEpoch = 0;
    const badgeNodes = new Set();
    const observedOffers = new WeakSet();
    const offerObserver = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(() => queueRender(), { rootMargin: '200px' }) : null;
    let sortPending = null, sortStatus = '', requestNumber = 0;
    const validOwner = id => typeof id === 'string' && /^\d{17}$/.test(id);
    const money = cents => '$' + (cents / 100).toFixed(2);
    const signedMoney = cents => (cents < 0 ? '−' : '+') + money(Math.abs(cents));
    const text = (element, value) => {
        if (element && element.textContent !== value) element.textContent = value;
    };
    const role = (element, name) => element.querySelector('[data-role="' + name + '"]');

    function queueOperation(operation) {
        return new Promise((resolve, reject) => {
            requestQueue.push({ operation, resolve, reject });
            pumpRequests();
        });
    }

    function pumpRequests() {
        // Network GETs are serialized in their helpers. A spare pending slot
        // lets a newly selected owner load while old responses are still pending.
        while (runningRequests < 3 && requestQueue.length) {
            const entry = requestQueue.shift();
            runningRequests++;
            Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
                runningRequests--;
                pumpRequests();
            });
        }
    }

    function request(action, steamId, force = false) {
        return queueOperation(() => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Steamprice request timed out. Please retry.')), 240000);
            try {
                chrome.runtime.sendMessage({ action, steamId, force, scan: false }, response => {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else if (!response?.success) reject(new Error(response?.error || 'Steamprice data is unavailable.'));
                    else resolve({ ...response.data, cacheInfo: {
                        cached: response.cached === true,
                        cachedAt: Number.isSafeInteger(response.cachedAt) ? response.cachedAt : Date.now(),
                        scanned: response.scanned === true,
                        needsScan: response.needsScan === true,
                        error: response.cached === true && typeof response.error === 'string' ? response.error : ''
                    } });
                });
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        }));
    }

    function ownerData(id, profile = false, prices = true) {
        if (!validOwner(id)) return null;
        let data = owners.get(id);
        if (!data) {
            data = { id, index: Prices.buildIndex([], id), priceState: 'idle', priceError: '',
                profileState: 'idle', profileError: '', totalCents: null, priceEpoch: 0, profileEpoch: 0,
                pricesLoaded: false, priceCache: null, profileCache: null, needsScan: false };
            owners.set(id, data);
        }
        if (prices && data.priceState === 'idle') void loadPrices(data);
        if (profile && data.profileState === 'idle') void loadProfile(data);
        return data;
    }

    async function loadPrices(data, force = false) {
        const epoch = ++data.priceEpoch;
        data.priceState = 'loading';
        data.priceError = '';
        queueRender();
        try {
            const response = await request('fetchPrices', data.id, force);
            if (epoch !== data.priceEpoch) return;
            if (!Array.isArray(response?.items)) throw new Error('Steamprice returned invalid price items.');
            const index = await buildIndexGradually(response.items, data, epoch);
            if (!index || epoch !== data.priceEpoch) return;
            data.index = index;
            data.pricesLoaded = true;
            data.priceCache = response.cacheInfo;
            data.needsScan = data.priceCache.needsScan;
            data.priceError = data.priceCache.error;
            data.priceState = 'ready';
            queueRender();
            // A price request may have populated an empty Steamprice inventory.
            // Refresh the full value after the initial profile request settles.
            if (((!force && !data.priceCache.cached) || data.priceCache.scanned) && data.profileState !== 'idle') {
                await data.profilePromise;
                if (epoch === data.priceEpoch) void loadProfile(data, true);
            }
        } catch (error) {
            if (epoch !== data.priceEpoch) return;
            data.priceState = data.pricesLoaded ? 'ready' : 'error';
            data.priceError = error.message;
            if (data.pricesLoaded) data.priceCache = { ...data.priceCache, cached: true, error: error.message };
        }
        queueRender();
    }

    async function buildIndexGradually(items, data, epoch) {
        if (items.length > 100000) throw new Error('Steamprice inventory exceeds the supported 100000 price items.');
        const index = Prices.buildIndex([], data.id);
        for (let start = 0; start < items.length; start += 300) {
            if (epoch !== data.priceEpoch) return null;
            const part = Prices.buildIndex(items.slice(start, start + 300), data.id);
            for (const [name, map] of Object.entries(part)) {
                if (!(map instanceof Map)) continue;
                if (!(index[name] instanceof Map)) index[name] = new Map();
                for (const [key, value] of map) {
                    if (!index[name].has(key)) index[name].set(key, value);
                    else if (index[name].get(key) !== value) index[name].set(key, null);
                }
            }
            if (start + 300 < items.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
        return index;
    }

    function loadProfile(data, force = false) {
        const epoch = ++data.profileEpoch;
        data.profileState = 'loading';
        data.profileError = '';
        data.profilePromise = (async () => {
            try {
                const response = await request('fetchProfile', data.id, force);
                if (epoch !== data.profileEpoch) return;
                const value = response?.totalValueCents;
                if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
                    !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
                    throw new Error('Steamprice did not return a valid inventory value.');
                }
                data.totalCents = Number(value);
                data.profileCache = response.cacheInfo;
                data.profileError = data.profileCache.error;
                data.profileState = 'ready';
            } catch (error) {
                if (epoch !== data.profileEpoch) return;
                data.profileState = 'error';
                data.profileError = error.message;
                if (data.totalCents !== null) data.profileCache = { ...data.profileCache, cached: true, error: error.message };
            }
            queueRender();
        })();
        return data.profilePromise;
    }

    function retryOwners(ids) {
        for (const id of new Set(ids)) {
            const data = owners.get(id);
            if (!data) continue;
            if (data.priceState !== 'loading') void loadPrices(data, true);
            if (data.profileState !== 'idle' && data.profileState !== 'loading') void loadProfile(data, true);
        }
    }

    function priceIndex(id) {
        return owners.get(id)?.index || null;
    }

    function cacheNotice(info, label) {
        if (!info?.cached) return '';
        return label + (Number.isSafeInteger(info.cachedAt)
            ? ' from ' + new Date(info.cachedAt).toLocaleString('en-US') : '') + '.';
    }

    function normalizeItems(items, owner, defaults = {}) {
        if (!Array.isArray(items)) return [];
        return items.slice(0, 100000).filter(item => item && typeof item === 'object').map(item => ({
            ...defaults, ...item, ownerSteamId: owner
        }));
    }

    function addStyles() {
        if (document.getElementById('sih-lite-trade-styles')) return;
        const style = document.createElement('style');
        style.id = 'sih-lite-trade-styles';
        style.textContent = [
            '.sih-lite-trade-summary,#sih-lite-trade-inventory-panel{box-sizing:border-box;background:rgba(0,0,0,.5);border:1px solid #39516a;border-radius:4px;padding:9px;margin:8px 0;color:#c6d4df;font-size:13px;line-height:1.5;position:relative;z-index:3}',
            '.sih-lite-trade-summary{display:flex;flex-wrap:wrap;gap:5px 15px;clear:both}',
            '.sih-lite-trade-summary [data-role="give"],.sih-lite-trade-summary [data-role="receive"]{font-weight:bold}',
            '.sih-lite-trade-summary [data-role="status"]{width:100%;font-size:12px;color:#b8b9ba;overflow-wrap:anywhere}',
            '.sih-lite-trade-gain{color:#5cff5c}.sih-lite-trade-loss{color:#ffad86}',
            '.sih-lite-trade-price{position:absolute!important;bottom:2px!important;right:2px!important;z-index:5;background:rgba(0,0,0,.92);color:#5cff5c;border:1px solid #5cff5c;font-size:11px;font-weight:bold;line-height:1.2;padding:2px 4px;border-radius:3px;pointer-events:none}',
            '.sih-lite-trade-button{background:#39516a;color:#fff;border:1px solid #536b83;padding:5px 8px;border-radius:3px;cursor:pointer;margin:3px 5px 3px 0}',
            '.sih-lite-trade-button:disabled{opacity:.5;cursor:default}.sih-lite-trade-button[aria-pressed="true"]{border-color:#5cff5c}',
            '.sih-lite-trade-accept-status{width:100%;overflow-wrap:anywhere}.sih-lite-trade-summary button{position:relative;z-index:4}',
            '#sih-lite-trade-inventory-panel [data-role="inventory-me"],#sih-lite-trade-inventory-panel [data-role="inventory-them"]{display:block;color:#66c0f4;font-weight:bold}',
            '#sih-lite-trade-inventory-panel [data-role="inventory-status"]{display:block;overflow-wrap:anywhere;font-size:12px}',
            '@media(max-width:700px){.sih-lite-trade-summary{gap:4px 10px}.sih-lite-trade-summary,#sih-lite-trade-inventory-panel{padding:7px}}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function makeButton(label, click) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sih-lite-trade-button';
        button.textContent = label;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            click(event);
        });
        return button;
    }

    function makeSummary() {
        const summary = document.createElement('div');
        summary.className = 'sih-lite-trade-summary';
        for (const name of ['give', 'receive', 'net', 'status']) {
            const element = document.createElement('span');
            element.dataset.role = name;
            summary.appendChild(element);
        }
        summary.title = 'Dota 2 values in USD from Steamprice. Cached valuations may differ from market sale prices.';
        return summary;
    }

    function renderSummary(element, give, receive, me, them, extraStatus = '', completeness = {}) {
        const a = Prices.summarize(give, priceIndex(me));
        const b = Prices.summarize(receive, priceIndex(them));
        if (completeness.me === false) a.complete = false;
        if (completeness.them === false) b.complete = false;
        const net = Prices.difference(a, b);
        const subtotal = side => !side.complete && side.itemCount > 0 && side.pricedCount === 0
            ? 'Unavailable' : money(side.knownCents) + (side.complete ? '' : ' (known)');
        text(role(element, 'give'), 'You give: ' + subtotal(a));
        text(role(element, 'receive'), 'You receive: ' + subtotal(b));
        const netElement = role(element, 'net');
        text(netElement, !net.complete ? 'Known difference: ' + (a.pricedCount + b.pricedCount === 0
            ? 'Unavailable' : signedMoney(net.knownCents || 0))
            : net.cents > 0 ? 'Net gain: ' + signedMoney(net.cents)
                : net.cents < 0 ? 'Net loss: ' + signedMoney(net.cents) : 'Even: $0.00');
        const className = net.complete && net.cents !== 0
            ? net.cents > 0 ? 'sih-lite-trade-gain' : 'sih-lite-trade-loss' : '';
        if (netElement.className !== className) netElement.className = className;
        const status = [];
        if (completeness.me === false || completeness.them === false) status.push('Trade item details are incomplete.');
        const unpriced = a.unpricedCount + b.unpricedCount;
        if (unpriced) status.push('Partial valuation: ' + unpriced + ' item' + (unpriced === 1 ? '' : 's') + ' unpriced.');
        if (a.nonDotaCount + b.nonDotaCount) status.push('Only Dota 2 items are priced.');
        const estimated = (a.estimatedCount || 0) + (b.estimatedCount || 0);
        if (estimated) status.push('Includes ' + estimated + ' current gem variant estimate' + (estimated === 1 ? '.' : 's.'));
        for (const id of new Set([me, them])) {
            const data = owners.get(id);
            if (data?.priceState === 'loading') status.push('Loading ' + (id === me ? 'your' : 'partner') + ' prices…');
            else if (data?.priceError) status.push((id === me ? 'Your prices: ' : 'Partner prices: ') + data.priceError);
            const cached = cacheNotice(data?.priceCache, 'Cached prices (' + (id === me ? 'your' : 'partner') + ')');
            if (cached) status.push(cached);
            if (data?.needsScan) status.push((id === me ? 'Your' : 'Partner') + ' inventory has no saved Steamprice prices. Open it on Steamprice, then retry.');
        }
        if (extraStatus) status.push(extraStatus);
        text(role(element, 'status'), status.join(' '));
    }

    function renderBadge(element, item) {
        let badge = element.querySelector('.sih-lite-trade-price');
        const price = Prices.getPrice(priceIndex(item.ownerSteamId), item);
        const value = Prices.summarize([item], priceIndex(item.ownerSteamId));
        if (price.cents === null || !value.complete) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'sih-lite-trade-price';
            element.appendChild(badge);
        }
        // Native Steam item blocks are normally already positioned. A style
        // fallback also supports the smaller offer-list cards.
        if (!element.dataset.sihTradePositioned) {
            if (getComputedStyle(element).position === 'static') element.style.position = 'relative';
            element.dataset.sihTradePositioned = 'true';
        }
        text(badge, money(value.knownCents));
        badge.title = 'Steamprice: ' + money(price.cents) + ' each, quantity ' + String(item.amount ?? 1) + '.' +
            (price.source === 'variant' ? ' Current estimate for the matching gem variant; exact asset details are unavailable.' : '') +
            (owners.get(item.ownerSteamId)?.priceCache?.cached
                ? ' ' + cacheNotice(owners.get(item.ownerSteamId).priceCache, 'Cached prices') : '');
    }

    function inventoryPanel() {
        let panel = document.getElementById('sih-lite-trade-inventory-panel');
        if (panel) return panel;
        const inventoryBox = document.getElementById('inventory_box');
        if (!inventoryBox) return null;
        panel = document.createElement('div');
        panel.id = 'sih-lite-trade-inventory-panel';
        for (const name of ['inventory-me', 'inventory-them', 'active-inventory']) {
            const line = document.createElement('span');
            line.dataset.role = name;
            panel.appendChild(line);
        }
        for (const [order, label] of [['desc', 'Price ↓'], ['asc', 'Price ↑'], ['original', 'Steam order']]) {
            const button = makeButton(label, () => sortInventory(order));
            button.dataset.tradeOrder = order;
            panel.appendChild(button);
        }
        const retry = makeButton('Retry prices', () => {
            retryOwners([editor?.owners?.me?.steamId, editor?.owners?.them?.steamId]);
        });
        retry.id = 'sih-lite-trade-retry';
        panel.appendChild(retry);
        const status = document.createElement('span');
        status.dataset.role = 'inventory-status';
        panel.appendChild(status);
        const scans = document.createElement('span'); scans.dataset.role = 'scan-links'; panel.appendChild(scans);
        const inventory = document.getElementById('inventories');
        if (inventory?.parentElement === inventoryBox) inventoryBox.insertBefore(panel, inventory);
        else inventoryBox.appendChild(panel);
        return panel;
    }

    function renderEditor() {
        if (!editor) return;
        const me = editor.owners?.me?.steamId, them = editor.owners?.them?.steamId;
        const give = normalizeItems(editor.offers?.me, me);
        const receive = normalizeItems(editor.offers?.them, them);
        const activeOwner = editor.active?.supported ? editor.active.ownerSteamId : null;
        ownerData(me, true, activeOwner === me || give.some(item => String(item.appId) === '570'));
        ownerData(them, true, activeOwner === them || receive.some(item => String(item.appId) === '570'));
        let summary = document.getElementById('sih-lite-trade-editor-summary');
        const target = document.getElementById('trade_box') || document.getElementById('trade_area');
        if (!summary && target) {
            summary = makeSummary();
            summary.id = 'sih-lite-trade-editor-summary';
            target.insertBefore(summary, target.firstChild);
        }
        if (summary) renderSummary(summary, give, receive, me, them, '', editor.offersComplete);
        const panel = inventoryPanel();
        if (panel) {
            const errors = [];
            for (const [side, id, label] of [['me', me, 'Your Dota 2 inventory'], ['them', them, 'Partner Dota 2 inventory']]) {
                const data = owners.get(id);
                text(role(panel, 'inventory-' + side), label + ': ' + (data?.totalCents !== null && data?.totalCents !== undefined
                    ? money(data.totalCents) + (data.profileCache?.cached ? ' (cached)' : '') : data?.profileError ? 'Unavailable' : 'Loading…'));
                if (data?.profileError) errors.push(label + ': ' + data.profileError);
                if (data?.priceError) errors.push((side === 'me' ? 'Your prices: ' : 'Partner prices: ') + data.priceError);
                const cachedPrices = cacheNotice(data?.priceCache, 'Cached prices (' + (side === 'me' ? 'your' : 'partner') + ')');
                const cachedProfile = cacheNotice(data?.profileCache, 'Cached inventory value (' + (side === 'me' ? 'your' : 'partner') + ')');
                if (cachedPrices) errors.push(cachedPrices);
                if (cachedProfile) errors.push(cachedProfile);
                if (data?.needsScan) errors.push(label + ' has no saved Steamprice prices. Open it on Steamprice, then retry.');
            }
            const active = editor.active || {};
            const data = owners.get(active.ownerSteamId);
            text(role(panel, 'active-inventory'), active.supported
                ? 'Sort ' + (active.side === 'me' ? 'your' : 'partner') + ' inventory: '
                : 'Select a Dota 2 inventory to sort.');
            for (const button of panel.querySelectorAll('[data-trade-order]')) {
                button.disabled = Boolean(sortPending || active.loading || !active.supported ||
                    (button.dataset.tradeOrder !== 'original' && data?.priceState !== 'ready'));
                button.setAttribute('aria-pressed', String(button.dataset.tradeOrder === (active.order || 'original')));
            }
            document.getElementById('sih-lite-trade-retry').hidden = !errors.length;
            document.getElementById('sih-lite-trade-retry').disabled = [me, them].some(id =>
                owners.get(id)?.priceState === 'loading' || owners.get(id)?.profileState === 'loading');
            text(role(panel, 'inventory-status'), [sortStatus, ...errors].filter(Boolean).join(' '));
            renderScanLinks(role(panel, 'scan-links'), me, them);
        }
        const records = new Map();
        for (const inventory of editor.inventories || []) {
            const items = normalizeItems(inventory.items, inventory.ownerSteamId,
                { appId: inventory.appId, contextId: inventory.contextId });
            for (const item of items) records.set(item.ownerSteamId + ':' + item.appId + ':' + item.contextId + ':' + item.assetId, item);
        }
        const offered = new Map([...give, ...receive].map(item => [
            item.ownerSteamId + ':' + item.appId + ':' + item.contextId + ':' + item.assetId, item
        ]));
        const badges = [];
        const selectors = '[data-sih-trade-visible="true"], #your_slots .item[data-sih-trade-owner], #their_slots .item[data-sih-trade-owner]';
        for (const element of document.querySelectorAll(selectors)) {
            const key = element.dataset.sihTradeOwner + ':' + element.dataset.sihTradeApp + ':' +
                element.dataset.sihTradeContext + ':' + element.dataset.sihTradeAsset;
            const item = element.closest('#your_slots, #their_slots') ? offered.get(key) : records.get(key);
            if (item) badges.push([element, item]);
        }
        renderBadgesGradually(badges);
    }

    function renderBadgesGradually(entries) {
        const epoch = ++badgeEpoch;
        const current = new Set(entries.map(([element]) => element));
        for (const element of badgeNodes) if (!current.has(element)) {
            element.querySelector('.sih-lite-trade-price')?.remove(); badgeNodes.delete(element);
        }
        let offset = 0;
        function batch() {
            if (epoch !== badgeEpoch) return;
            const limit = Math.min(entries.length, offset + 24);
            while (offset < limit) {
                const [element, item] = entries[offset++];
                if (element.isConnected) { renderBadge(element, item); badgeNodes.add(element); }
            }
            if (offset < entries.length) setTimeout(batch, 16);
        }
        batch();
    }

    function renderScanLinks(container, me, them) {
        if (!container) return;
        for (const [id, label] of [[me, 'Open your inventory on Steamprice'], [them, 'Open partner inventory on Steamprice']]) {
            let link = container.querySelector('[data-scan-owner="' + id + '"]');
            if (!owners.get(id)?.needsScan || !validOwner(id)) { link?.remove(); continue; }
            if (!link) {
                link = document.createElement('a'); link.dataset.scanOwner = id;
                link.className = 'sih-lite-trade-button'; link.target = '_blank'; link.rel = 'noopener noreferrer';
                link.href = 'https://steamprice.com/dota2/inventory/' + id; link.textContent = label;
                container.appendChild(link);
            }
        }
        for (const link of container.querySelectorAll('[data-scan-owner]')) if (![me, them].includes(link.dataset.scanOwner)) link.remove();
    }

    function sortInventory(order) {
        const active = editor?.active;
        const data = owners.get(active?.ownerSteamId);
        if (sortPending || !active?.supported || !['asc', 'desc', 'original'].includes(order) ||
            (order !== 'original' && data?.priceState !== 'ready')) return;
        const assetPrices = [], namePrices = [], cleanNamePrices = [];
        if (data) {
            const prefix = active.ownerSteamId + ':';
            for (const [key, cents] of data.index.assetPrices) {
                if (key.startsWith(prefix) && Number.isSafeInteger(cents)) assetPrices.push([key.slice(prefix.length), cents]);
            }
            // Only ordinary, unambiguous aliases may price items Steam has not
            // loaded yet. An asset-specific gem price is never a name fallback.
            for (const [source, target] of [[data.index.exactNames, namePrices], [data.index.cleanNames, cleanNamePrices]]) {
                for (const [key, cents] of source) {
                    if (!key.startsWith(prefix) || !Number.isSafeInteger(cents)) continue;
                    target.push([key.slice(prefix.length), cents]);
                }
            }
        }
        const requestId = 'trade-' + Date.now() + '-' + ++requestNumber;
        const timer = setTimeout(() => {
            if (sortPending?.requestId !== requestId) return;
            sortPending = null;
            sortStatus = 'Steam did not finish loading the inventory. Try again.';
            post('STATE_REQUEST');
            queueRender();
        }, 180000);
        sortPending = { requestId, timer, ownerSteamId: active.ownerSteamId };
        sortStatus = 'Loading all inventory items…';
        post('SORT', { requestId, ownerSteamId: active.ownerSteamId, side: active.side,
            appId: '570', contextId: '2', order, prices: { assetPrices, namePrices, cleanNamePrices } });
        queueRender();
    }

    function readOffers() {
        if (!list) return [];
        const resolved = {};
        for (const [id, entry] of details) if (entry.data) resolved[id] = entry.data;
        return Offers.read(document, list, resolved);
    }

    function needsDetails(offer) {
        return [...offer.give, ...offer.receive, ...(offer.slots || []).map(slot => slot.item)].some(item => String(item.appId ?? item.appid) === '570' &&
            !/^\d{1,20}$/.test(String(item.assetId ?? item.assetid)));
    }

    function loadDetails(offer, force = false) {
        if (!needsDetails(offer) || (details.has(offer.offerId) && !force) || typeof Offers.fetchDetails !== 'function') return;
        const entry = { state: 'loading', error: '', data: details.get(offer.offerId)?.data || null };
        details.set(offer.offerId, entry);
        const meSteamId = list.meSteamId;
        queueOperation(() => offer.active ? Offers.fetchDetails(offer.offerId, meSteamId)
            : Offers.fetchClassDescriptions(offer, meSteamId)).then(data => {
            if (details.get(offer.offerId) !== entry) return;
            if (!data || String(data.partnerSteamId) !== offer.partnerSteamId) {
                throw new Error('Steam returned a different trade partner. Refresh the offers page.');
            }
            entry.data = data;
            entry.state = data.classError ? 'error' : 'ready';
            entry.error = data.classError ? 'Steam could not verify some item cards. Retry to load their prices.' : '';
        }).catch(async error => {
            if (details.get(offer.offerId) === entry) {
                entry.state = 'error';
                entry.error = error.message;
                if (typeof Offers.fetchClassDescriptions === 'function') {
                    try {
                        const fallback = await Offers.fetchClassDescriptions(offer, meSteamId);
                        if (details.get(offer.offerId) === entry && fallback?.partnerSteamId === offer.partnerSteamId &&
                            fallback.meSteamId === meSteamId && fallback.offerId === offer.offerId) {
                            entry.data = entry.data ? { ...entry.data, classItems: fallback.classItems } : fallback;
                            queueRender();
                        }
                    } catch (_) { /* Keep the exact-details error and the verified native item cards. */ }
                }
            }
        }).finally(queueRender);
    }

    function renderList() {
        if (!list) return;
        const seen = new Set();
        const badges = [];
        for (const offer of readOffers()) {
            if (!offer.element?.isConnected) continue;
            seen.add(offer.offerId);
            if (offerObserver && !observedOffers.has(offer.element)) { observedOffers.add(offer.element); offerObserver.observe(offer.element); }
            const rect = offer.element.getBoundingClientRect();
            if (rect.bottom < -200 || rect.top > innerHeight + 200) continue;
            const me = list.meSteamId, them = offer.partnerSteamId;
            const give = normalizeItems(offer.give, me), receive = normalizeItems(offer.receive, them);
            if (give.some(item => String(item.appId ?? item.appid) === '570')) ownerData(me);
            if (receive.some(item => String(item.appId ?? item.appid) === '570')) ownerData(them);
            loadDetails(offer);
            let summary = offer.element.querySelector('.sih-lite-trade-summary');
            if (!summary) {
                summary = makeSummary();
                summary.dataset.offerId = offer.offerId;
                offer.element.appendChild(summary);
                const retry = makeButton('Retry prices', () => {
                    retryOwners([list.meSteamId, offer.partnerSteamId]);
                    if (details.get(offer.offerId)?.state === 'error') loadDetails(offer, true);
                });
                retry.classList.add('sih-lite-trade-retry');
                summary.appendChild(retry);
                const scans = document.createElement('span'); scans.dataset.role = 'scan-links'; summary.appendChild(scans);
            }
            const detail = details.get(offer.offerId);
            renderSummary(summary, give, receive, me, them, detail?.state === 'loading'
                ? 'Loading trade item descriptions…' : detail?.error || (!offer.active ? 'Historical offers show current estimates, not prices at the time of the trade.' : ''));
            renderScanLinks(role(summary, 'scan-links'), me, them);
            summary.querySelector('.sih-lite-trade-retry').hidden =
                !owners.get(me)?.priceError && !owners.get(them)?.priceError && !detail?.error &&
                !owners.get(me)?.priceCache?.cached && !owners.get(them)?.priceCache?.cached &&
                !owners.get(me)?.needsScan && !owners.get(them)?.needsScan;
            summary.querySelector('.sih-lite-trade-retry').disabled =
                [me, them].some(id => owners.get(id)?.priceState === 'loading') || detail?.state === 'loading';
            for (const slot of offer.slots || []) if (slot.element) {
                badges.push([slot.element, { ...slot.item, ownerSteamId: slot.side === 'give' ? me : them }]);
            }
            renderAccept(offer, summary);
        }
        for (const summary of document.querySelectorAll('.sih-lite-trade-summary[data-offer-id]')) {
            if (!seen.has(summary.dataset.offerId)) summary.remove();
        }
        renderBadgesGradually(badges);
    }

    function sessionId() {
        for (const part of document.cookie.split(';')) {
            const separator = part.indexOf('=');
            if (part.slice(0, separator).trim() === 'sessionid') {
                try { return decodeURIComponent(part.slice(separator + 1)); } catch (_) { return ''; }
            }
        }
        return '';
    }

    function renderAccept(offer, summary) {
        let button = summary.querySelector('.sih-lite-fast-accept');
        let status = summary.querySelector('.sih-lite-trade-accept-status');
        const state = acceptStates.get(offer.offerId);
        if (!offer.canAccept && !state) {
            if (button) button.remove();
            if (status) status.remove();
            return;
        }
        if (!button) {
            button = makeButton('Fast accept', event => {
                if (!event.isTrusted) return;
                void acceptOffer(offer.offerId);
            });
            button.classList.add('sih-lite-fast-accept');
            summary.appendChild(button);
        }
        if (!status) {
            status = document.createElement('span');
            status.className = 'sih-lite-trade-accept-status';
            status.setAttribute('role', 'status');
            summary.appendChild(status);
        }
        button.disabled = !offer.canAccept || Boolean(state && state.state !== 'error');
        text(button, state?.state === 'loading' ? 'Accepting…' : state?.state === 'accepted' ? 'Accepted' : 'Fast accept');
        text(status, state?.message || '');
    }

    async function acceptOffer(offerId) {
        const previous = acceptStates.get(offerId);
        if (previous && previous.state !== 'error') return;
        const offer = readOffers().find(entry => entry.offerId === offerId);
        if (!offer?.canAccept || !offer.incoming || !offer.active || !validOwner(list?.meSteamId) ||
            !validOwner(offer.partnerSteamId) || offer.partnerSteamId === list.meSteamId) return;
        const pending = { state: 'loading', message: 'Accepting this offer…' };
        acceptStates.set(offerId, pending);
        queueRender();
        try {
            const result = await Accept.accept({ offerId, partnerSteamId: offer.partnerSteamId, sessionId: sessionId() });
            pending.state = result.state;
            pending.message = result.state === 'mobile_confirmation' ? 'Confirm this trade in Steam Guard.'
                : result.state === 'email_confirmation' ? 'Confirm this trade using the email sent by Steam.'
                    : 'Trade accepted.';
        } catch (error) {
            pending.state = error.code === 'STEAM_ACCEPT_STATUS_UNKNOWN' ? 'uncertain' : 'error';
            pending.message = error.message;
        }
        queueRender();
    }

    function post(type, data = {}) {
        window.postMessage({ source: 'SIH_LITE_TRADE_CONTENT', type, ...data }, location.origin);
    }

    function queueRender() {
        if (renderQueued) return;
        renderQueued = true;
        setTimeout(() => requestAnimationFrame(() => {
            renderQueued = false; lastRenderAt = Date.now();
            addStyles();
            if (editorPage) renderEditor(); else renderList();
        }), Math.max(0, 200 - (Date.now() - lastRenderAt)));
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (event.source !== window || event.origin !== location.origin || message?.source !== 'SIH_LITE_TRADE_PAGE') return;
        if (editorPage && message.type === 'EDITOR') {
            const previous = editor?.active;
            editor = message;
            if (sortPending && (previous?.ownerSteamId !== message.active?.ownerSteamId ||
                previous?.side !== message.active?.side)) {
                clearTimeout(sortPending.timer);
                sortPending = null;
                sortStatus = '';
            }
            queueRender();
        } else if (listPage && message.type === 'OFFERS' && validOwner(message.meSteamId)) {
            if (list && list.meSteamId !== message.meSteamId) {
                details.clear();
                acceptStates.clear();
            }
            list = message;
            queueRender();
        } else if (editorPage && ['SORT_RESULT', 'SORT_PROGRESS'].includes(message.type) &&
            sortPending?.requestId === message.requestId && sortPending.ownerSteamId === message.ownerSteamId) {
            if (message.type === 'SORT_PROGRESS') {
                sortStatus = Number.isSafeInteger(message.loaded) && Number.isSafeInteger(message.total)
                    ? (message.phase === 'pricing' ? 'Preparing price sort: ' : 'Loading inventory: ') + message.loaded + ' / ' + message.total + '…'
                    : 'Loading all inventory items…';
            } else {
                clearTimeout(sortPending.timer);
                sortPending = null;
                sortStatus = message.success ? (message.order === 'original' ? 'Steam order restored.'
                    : 'Sorted ' + message.count + ' items. Unpriced items are shown last.')
                    : message.error || 'Steam could not sort this inventory.';
                post('STATE_REQUEST');
            }
            queueRender();
        }
    });
    function extensionNode(node) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        return Boolean(element?.closest('.sih-lite-trade-summary, .sih-lite-trade-price, #sih-lite-trade-inventory-panel, #sih-lite-trade-styles'));
    }
    new MutationObserver(records => {
        if (records.some(record => !extensionNode(record.target) &&
            (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !extensionNode(node))))) queueRender();
    }).observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-economy-item']
    });
    window.addEventListener('scroll', queueRender, { passive: true });
    post('STATE_REQUEST');
    queueRender();
})();
