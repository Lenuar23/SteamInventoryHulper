/* Runs in Steam's MAIN world. Keep the native item holders and page controls. */
(function () {
    'use strict';

    const CONTENT_SOURCE = 'SIH_LITE_CONTENT';
    const PAGE_SOURCE = 'SIH_LITE_PAGE';
    const MAX_ITEMS = 100000;
    const LOAD_TIMEOUT_MS = 120000;
    const originalOrders = new WeakMap();
    const preservedResponsivePages = new WeakSet();
    let busy = false;
    let previousInventory = null;
    let previousItems = null;
    let previousLoaded = -1;
    let previousState = '';
    let hookedFilter = null;

    function reply(type, data) {
        window.postMessage({ source: PAGE_SOURCE, type, ...data }, window.location.origin);
    }

    function getActiveInventory() {
        return window.g_ActiveInventory || null;
    }

    // Dota normally has context 2. Steam can also expose its single context
    // through the "all items" (context 0) inventory wrapper.
    function getItemInventory(active) {
        if (!active || String(active.m_appid ?? active.appid) !== '570') return null;
        const contextId = String(active.m_contextid ?? active.contextid);
        if (contextId === '2') return active;
        if (contextId !== '0' || !active.m_rgChildInventories) return null;
        const contexts = (active.m_rgContextIds || Object.keys(active.m_rgChildInventories)).map(String);
        if (contexts.length !== 1 || contexts[0] !== '2') return null;
        return active.m_rgChildInventories['2'] || null;
    }

    function getSteamId(inventory) {
        let steamId = inventory && inventory.m_steamid;
        if (!steamId && inventory?.m_owner && typeof inventory.m_owner.GetSteamId === 'function') {
            steamId = inventory.m_owner.GetSteamId();
        }
        return /^\d{17}$/.test(String(steamId)) ? String(steamId) : null;
    }

    function countLoaded(inventory) {
        if (!inventory) return 0;
        if (Number.isSafeInteger(inventory.m_iNextEmptyItemElement)) {
            return inventory.m_iNextEmptyItemElement;
        }
        return Array.isArray(inventory.m_rgItemElements)
            ? inventory.m_rgItemElements.filter(holder => holder?.[0]?.rgItem).length : 0;
    }

    function stateFor(active) {
        const items = getItemInventory(active);
        return {
            appId: active ? String(active.m_appid ?? active.appid ?? '') : null,
            contextId: items ? '2' : active ? String(active.m_contextid ?? active.contextid ?? '') : null,
            nativeContextId: active ? String(active.m_contextid ?? active.contextid ?? '') : null,
            steamId: getSteamId(items || active),
            supported: Boolean(items && getSteamId(items)),
            loaded: countLoaded(items),
            total: items && Number.isSafeInteger(items.m_cItems) ? items.m_cItems : 0,
            fullyLoaded: Boolean(items?.m_bFullyLoaded),
            order: items ? originalOrders.get(items)?.order || 'original' : 'original'
        };
    }

    function isCollectorsCache(description) {
        const text = [description.market_hash_name, description.name,
            ...(Array.isArray(description.descriptions)
                ? description.descriptions.map(entry => entry?.value || '') : [])].join(' ');
        return /collector(?:['’]s|s)\s+cache/i.test(text);
    }

    function emitInventory(active) {
        const inventory = getItemInventory(active);
        if (!inventory || !Array.isArray(inventory.m_rgItemElements)) return;
        const items = [];
        for (const holder of inventory.m_rgItemElements) {
            const asset = holder?.[0]?.rgItem;
            if (!asset || !/^\d{1,20}$/.test(String(asset.assetid))) continue;
            const description = asset.description || {};
            items.push({
                assetId: String(asset.assetid),
                name: String(description.market_hash_name || description.name || description.market_name || '').slice(0, 512),
                isCache: isCollectorsCache(description)
            });
            if (items.length >= MAX_ITEMS) break;
        }
        reply('INVENTORY', { appId: '570', contextId: '2', steamId: getSteamId(inventory), items });
    }

    function emitState(force) {
        const active = getActiveInventory();
        const items = getItemInventory(active);
        const state = stateFor(active);
        const serialized = JSON.stringify(state);
        if (force || active !== previousInventory || items !== previousItems || serialized !== previousState) {
            reply('STATE', state);
            previousState = serialized;
        }
        if (force || active !== previousInventory || items !== previousItems || state.loaded !== previousLoaded) {
            emitInventory(active);
        }
        previousInventory = active;
        previousItems = items;
        previousLoaded = state.loaded;
    }

    function validatePrices(prices) {
        if (!prices || typeof prices !== 'object') throw new Error('Invalid price data.');
        const assetPrices = prices.assetPrices;
        const namePrices = prices.namePrices;
        if (!Array.isArray(assetPrices) || !Array.isArray(namePrices) ||
            assetPrices.length > MAX_ITEMS || namePrices.length > MAX_ITEMS) {
            throw new Error('Price data is too large or invalid.');
        }
        const readEntries = (entries, validKey) => {
            const result = new Map();
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length !== 2 || !validKey(entry[0]) ||
                    !Number.isSafeInteger(entry[1]) || entry[1] < 0) {
                    throw new Error('Invalid item price.');
                }
                result.set(entry[0], entry[1]);
            }
            return result;
        };
        return {
            assets: readEntries(assetPrices, key => typeof key === 'string' && /^\d{1,20}$/.test(key)),
            names: readEntries(namePrices, key => typeof key === 'string' && key.length > 0 && key.length <= 512)
        };
    }

    function cleanName(name) {
        return name.toLowerCase()
            .replace(/^(inscribed|autographed|corrupted|frozen|heroic|cursed|genuine|favored|ascent|elder|unusual|exalted|infused|auspicious|base|legacy|sealed)\s+/i, '')
            .replace(/\s+(bundle|set)$/i, '').trim();
    }

    function priceFor(holder, prices) {
        const asset = holder[0].rgItem;
        const id = String(asset.assetid);
        if (prices.assets.has(id)) return prices.assets.get(id);
        const description = asset.description || {};
        const name = String(description.market_hash_name || description.name || description.market_name || '').trim().toLowerCase();
        if (prices.names.has(name)) return prices.names.get(name);
        const cleaned = cleanName(name);
        return prices.names.has(cleaned) ? prices.names.get(cleaned) : null;
    }

    function ensureCurrent(active, steamId, expectedItems) {
        if (getActiveInventory() !== active || getSteamId(getItemInventory(active)) !== steamId ||
            (expectedItems && getItemInventory(active) !== expectedItems)) {
            throw new Error('Inventory changed. Select the Dota 2 inventory and try again.');
        }
    }

    function resetRejectedLoad(inventory) {
        const pending = inventory?.m_promiseLoadCompleteInventory;
        // Steam caches a rejected full-load promise. A later user retry must
        // create a new promise, while LoadMoreAssets still enforces its cooldown.
        if (pending && typeof pending.state === 'function' && pending.state() === 'rejected') {
            inventory.m_promiseLoadCompleteInventory = null;
        }
    }

    function loadComplete(active, items, onProgress) {
        if (typeof active.LoadCompleteInventory !== 'function') {
            return Promise.reject(new Error('Steam inventory loading API is unavailable. Reload this page.'));
        }
        resetRejectedLoad(active);
        if (items !== active) resetRejectedLoad(items);
        return new Promise((resolve, reject) => {
            let finished = false;
            let timer = null;
            const finish = (error) => {
                if (finished) return;
                finished = true;
                if (timer !== null) window.clearTimeout(timer);
                if (typeof active.RemoveOnItemsLoadedCallback === 'function') {
                    active.RemoveOnItemsLoadedCallback(onProgress);
                }
                if (error) reject(error); else resolve();
            };
            timer = window.setTimeout(() => finish(new Error('Steam took too long to load the inventory. Try again later.')), LOAD_TIMEOUT_MS);
            try {
                if (typeof active.AddOnItemsLoadedCallback === 'function') active.AddOnItemsLoadedCallback(onProgress);
                const pending = active.LoadCompleteInventory();
                if (pending && typeof pending.done === 'function' && typeof pending.fail === 'function') {
                    pending.done(() => finish()).fail(() => finish(new Error('Steam could not load the full inventory. Try again in a few seconds.')));
                } else {
                    Promise.resolve(pending).then(() => finish(), () => finish(new Error('Steam could not load the full inventory. Try again later.')));
                }
            } catch (error) {
                finish(error);
            }
        });
    }

    function updatePageMetadata(active) {
        if (!active || !originalOrders.has(getItemInventory(active))) return;
        for (const page of active.m_rgPages || []) {
            if (!page.m_$Page) continue; // Preserve lazy page DOM creation.
            page.m_$Page.children().each(function () {
                if (this.rgItem) window.$J(this).data('iPage', page.m_iPage);
            });
        }
    }

    function preserveFilterPageMetadata() {
        const filter = window.Filter;
        if (!filter || hookedFilter === filter || typeof filter.ApplyFilter !== 'function') return;
        const apply = filter.ApplyFilter;
        filter.ApplyFilter = function (...args) {
            const result = apply.apply(this, args);
            updatePageMetadata(getActiveInventory());
            return result;
        };
        hookedFilter = filter;
    }

    function preserveResponsivePage(page) {
        if (!page || preservedResponsivePages.has(page)) return;
        // Steam's cleanup uses empty(), which removes listeners from reusable
        // item holders. Preserve those listeners when clearing native filters.
        page.PostFilterCleanUp = function () {
            if (!this.m_bMounted) return;
            this.m_$Page.children().detach();
            this.m_cPagesLoaded = 0;
            this.m_bImagesLoaded = false;
            this.EnsurePageItemsCreated();
        };
        preservedResponsivePages.add(page);
    }

    function relayout(active, items) {
        // Clear the existing filter markers so Steam reapplies its current
        // text/tag filters to the new order rather than optimizing stale pages.
        for (const holder of items.m_rgItemElements) {
            holder[0].filtered = false;
            holder.css('display', '');
        }
        const perPage = Number.isSafeInteger(window.INVENTORY_PAGE_ITEMS) && window.INVENTORY_PAGE_ITEMS > 0
            ? window.INVENTORY_PAGE_ITEMS : 25;
        items.m_rgItemElements.forEach((holder, index) => holder.data('iPage', Math.floor(index / perPage)));

        // Steam reuses this page on responsive layouts. Detach item holders
        // before rebuilding it; jQuery.empty() would remove Steam's listeners.
        for (const inventory of new Set([active, items])) {
            const responsivePage = inventory.m_SingleResponsivePage;
            preserveResponsivePage(responsivePage);
            if (responsivePage?.m_$Page && (window.g_bEnableDynamicSizing || responsivePage.m_bMounted)) {
                responsivePage.m_$Page.children().detach();
                responsivePage.m_cPagesLoaded = 0;
                responsivePage.m_bImagesLoaded = false;
            }
        }
        items.m_bNeedsRepagination = true;
        active.m_bNeedsRepagination = true;
        active.m_iCurrentPage = 0;
        active.LayoutPages();
        preserveFilterPageMetadata();
        if (window.Filter && typeof window.Filter.ReApplyFilter === 'function' && window.Filter.elFilter) {
            window.Filter.ReApplyFilter();
        }
        updatePageMetadata(active);
        if (typeof active.ShowPageControlsIfNeeded === 'function') active.ShowPageControlsIfNeeded();
    }

    async function sortInventory(message) {
        const requestId = message.requestId;
        if (typeof requestId !== 'string' || requestId.length > 100 || !requestId) return;
        if (busy) {
            reply('SORT_RESULT', { requestId, success: false, error: 'Inventory sorting is already in progress.' });
            return;
        }
        let acquired = false;
        try {
            if (!['asc', 'desc', 'original'].includes(message.order) || !/^\d{17}$/.test(String(message.steamId))) {
                throw new Error('Invalid sort request.');
            }
            const steamId = String(message.steamId);
            const active = getActiveInventory();
            const items = getItemInventory(active);
            if (!items || typeof active.LayoutPages !== 'function' || !Array.isArray(items.m_rgItemElements) || !window.$J) {
                throw new Error('Select the Dota 2 inventory before sorting.');
            }
            ensureCurrent(active, steamId, items);
            const prices = message.order === 'original' ? null : validatePrices(message.prices);
            if (items.m_cItems > MAX_ITEMS) throw new Error('This inventory is too large to sort safely.');
            busy = acquired = true;
            const progress = () => {
                if (getActiveInventory() !== active) return;
                reply('SORT_PROGRESS', { requestId, phase: 'loading', loaded: countLoaded(items), total: items.m_cItems });
                emitState(false);
            };
            progress();
            await loadComplete(active, items, progress);
            ensureCurrent(active, steamId, items);
            if (!items.m_bFullyLoaded || items.m_rgItemElements.length > MAX_ITEMS ||
                items.m_rgItemElements.some(holder => !holder?.[0]?.rgItem)) {
                throw new Error('Steam has not loaded every inventory item. Try again later.');
            }
            // Sorting while Steam is animating pagination can leave the
            // animation's completion callback pointing at obsolete pages.
            if (active.m_$Inventory?.hasClass('paging_transition')) {
                throw new Error('Wait for the page transition to finish, then try again.');
            }
            if (!originalOrders.has(items)) originalOrders.set(items, { holders: items.m_rgItemElements.slice(), order: 'original' });
            const original = originalOrders.get(items);
            const rank = new Map(original.holders.map((holder, index) => [holder, index]));
            const sorted = items.m_rgItemElements.slice();
            sorted.sort((left, right) => {
                const stable = rank.get(left) - rank.get(right);
                if (message.order === 'original') return stable;
                const a = priceFor(left, prices);
                const b = priceFor(right, prices);
                if (a === null || b === null) return a === b ? stable : a === null ? 1 : -1;
                return (message.order === 'asc' ? a - b : b - a) || stable;
            });
            const before = items.m_rgItemElements;
            items.m_rgItemElements = sorted;
            try {
                relayout(active, items);
            } catch (error) {
                items.m_rgItemElements = before;
                try { relayout(active, items); } catch (_) { /* Keep the original failure. */ }
                throw error;
            }
            original.order = message.order;
            emitState(true);
            reply('SORT_RESULT', { requestId, success: true, count: sorted.length, order: message.order, steamId });
        } catch (error) {
            reply('SORT_RESULT', { requestId, success: false, error: error?.message || 'Could not sort the inventory.' });
        } finally {
            if (acquired) busy = false;
        }
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin || !event.data ||
            event.data.source !== CONTENT_SOURCE) return;
        if (event.data.type === 'STATE_REQUEST') emitState(true);
        else if (event.data.type === 'SORT') void sortInventory(event.data);
    });
    window.setInterval(() => emitState(false), 500);
    emitState(true);
})();
