/* MAIN-world read-only trade metadata and native inventory sorting. */
(function () {
    'use strict';

    const CONTENT_SOURCE = 'SIH_LITE_TRADE_CONTENT';
    const PAGE_SOURCE = 'SIH_LITE_TRADE_PAGE';
    const MAX_ITEMS = 100000;
    const LOAD_TIMEOUT_MS = 120000;
    const originalOrders = new WeakMap();
    const objectIds = new WeakMap();
    const responsivePages = new WeakSet();
    let nextObjectId = 0;
    let lastSignature = '';
    let busy = false;
    let hookedFilter = null;

    function reply(type, data) {
        window.postMessage({ source: PAGE_SOURCE, type, ...data }, window.location.origin);
    }

    function objectId(object) {
        if (!object || typeof object !== 'object') return 0;
        if (!objectIds.has(object)) objectIds.set(object, ++nextObjectId);
        return objectIds.get(object);
    }

    function userFor(side) { return side === 'me' ? window.UserYou : side === 'them' ? window.UserThem : null; }
    function inventoryOwner(inventory) { return inventory?.m_owner || inventory?.owner || null; }
    function activeInventory() { return window.g_ActiveInventory || null; }
    function appId(inventory) { return String(inventory?.m_appid ?? inventory?.appid ?? ''); }
    function contextId(inventory) { return String(inventory?.m_contextid ?? inventory?.contextid ?? ''); }

    function steamId(user) {
        const id = typeof user?.GetSteamId === 'function' ? user.GetSteamId() : user?.strSteamId;
        return /^\d{17}$/.test(String(id)) ? String(id) : null;
    }

    function loadedInventory(user, app = '570', context = '2') {
        // getInventory() can initiate loads. Snapshot reads only existing native
        // contexts; Steam itself loads the inventories needed by the editor.
        return user?.rgContexts?.[app]?.[context]?.inventory || null;
    }

    function itemInventory(active) {
        if (!active || appId(active) !== '570') return null;
        if (contextId(active) === '2') return active;
        if (contextId(active) !== '0') return null;
        const children = active.m_rgChildInventories || active.rgChildInventories;
        const contexts = active.m_rgContextIds || active.rgContextIds || Object.keys(children || {});
        if (!children || contexts.length !== 1 || String(contexts[0]) !== '2') return null;
        return children['2'] || null;
    }

    function pending(inventory) {
        return !inventory || (typeof inventory.BIsPendingInventory === 'function' && inventory.BIsPendingInventory());
    }

    function assets(inventory) {
        const values = inventory?.m_rgAssets || inventory?.rgInventory;
        return values && typeof values === 'object' ? Object.values(values).slice(0, MAX_ITEMS) : [];
    }

    function description(asset) { return asset?.description || asset || {}; }
    function assetId(asset) { return String(asset?.assetid ?? asset?.id ?? ''); }
    function holderNode(holder) { return holder?.nodeType ? holder : holder?.[0] || holder; }
    function holders(inventory) { return inventory?.m_rgItemElements || inventory?.rgItemElements || []; }
    function holderAsset(holder) { return holderNode(holder)?.rgItem || null; }

    function quantity(value) {
        if (value === undefined) return 1;
        if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return 0;
        const amount = Number(value);
        return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
    }

    function gemDetails(asset) {
        const detector = globalThis.SIHLiteGems || window.SIHLiteGems;
        return detector?.analyzeSteamAsset({ appid: asset?.appid || 570, description: description(asset) }) || {
            hasGems: false, hasColoredGem: false, gems: [], prismaticGems: [], etherealGems: [],
            kineticGems: [], legacyRgb: null, isLegacy: false
        };
    }

    function itemData(asset, side, user, app = '570', context = '2', amount) {
        const desc = description(asset);
        return {
            assetId: assetId(asset), ownerSteamId: steamId(user), side, appId: String(app), contextId: String(context),
            name: String(desc.market_hash_name || desc.market_name || desc.name || '').slice(0, 512),
            market_hash_name: String(desc.market_hash_name || desc.market_name || '').slice(0, 512),
            amount: quantity(amount === undefined ? asset?.amount : amount), ...gemDetails(asset)
        };
    }

    function annotate(element, data) {
        const node = element?.nodeType ? element : element?.[0];
        if (!node || typeof node.setAttribute !== 'function') return;
        for (const [key, value] of Object.entries({ owner: data.ownerSteamId, asset: data.assetId,
            app: data.appId, context: data.contextId, side: data.side })) {
            const name = `data-sih-trade-${key}`;
            if (value && node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
        }
    }

    function offerRecords(side, kind = 'assets') {
        const records = window.g_rgCurrentTradeStatus?.[side]?.[kind];
        return records && typeof records === 'object' ? Object.values(records).slice(0, MAX_ITEMS) : [];
    }

    function nativeSlotAssets(side, currency = false) {
        const root = document.getElementById((side === 'me' ? 'your_slots' : 'their_slots') + (currency ? '_currency' : ''));
        if (!root) return [];
        return Array.from(root.querySelectorAll('.item')).filter(element => element.rgItem).map(element => ({ element, asset: element.rgItem }));
    }

    function offeredItems(side, user) {
        const slots = nativeSlotAssets(side);
        const result = [];
        let complete = Boolean(steamId(user));
        for (const kind of ['assets', 'currency']) {
            const source = window.g_rgCurrentTradeStatus?.[side]?.[kind];
            if (!source || typeof source !== 'object' || Object.keys(source).length > MAX_ITEMS) complete = false;
        }
        const unresolved = currency => {
            complete = false;
            result.push({ assetId: null, ownerSteamId: steamId(user), side, appId: null, contextId: null,
                name: '', market_hash_name: '', amount: 0, isCurrency: currency });
        };
        for (const record of offerRecords(side)) {
            const app = String(record?.appid || '');
            const context = String(record?.contextid || '');
            const id = String(record?.assetid || '');
            if (!/^\d{1,20}$/.test(id) || !/^\d+$/.test(app) || !/^\d+$/.test(context)) { unresolved(false); continue; }
            const inventory = loadedInventory(user, app, context);
            const native = inventory?.m_rgAssets?.[id] || inventory?.rgInventory?.[id];
            const slot = slots.find(entry => assetId(entry.asset) === id &&
                String(entry.asset.appid) === app && String(entry.asset.contextid) === context);
            const asset = native || slot?.asset || { assetid: id, appid: app, contextid: context };
            const data = itemData(asset, side, user, app, context, record.amount);
            result.push(data);
            if (!data.amount) complete = false;
            if (slot) annotate(slot.element, data);
        }
        // Native currencies use separate slots and IDs. Include them in totals
        // as explicitly unpriced records, even before their inventory arrives.
        const currencySlots = nativeSlotAssets(side, true);
        for (const record of offerRecords(side, 'currency')) {
            const app = String(record?.appid || '');
            const context = String(record?.contextid || '');
            const id = String(record?.currencyid || '');
            if (!/^\d{1,20}$/.test(id) || !/^\d+$/.test(app) || !/^\d+$/.test(context)) { unresolved(true); continue; }
            const inventory = loadedInventory(user, app, context);
            const native = inventory?.rgCurrency?.[id];
            const slot = currencySlots.find(entry => assetId(entry.asset) === id &&
                String(entry.asset.appid) === app && String(entry.asset.contextid) === context);
            const asset = native || slot?.asset || { id, appid: app, contextid: context };
            const data = { ...itemData(asset, side, user, app, context, record.amount), isCurrency: true, currencyId: id };
            result.push(data);
            if (!data.amount) complete = false;
            if (slot) annotate(slot.element, data);
        }
        // A visible native slot may briefly precede its status update. Retain
        // it as incomplete metadata instead of reporting an empty, complete side.
        for (const [entries, currency] of [[slots, false], [currencySlots, true]]) {
            for (const { element, asset } of entries) {
                if (result.some(item => Boolean(item.isCurrency) === currency && item.assetId === assetId(asset) &&
                    item.appId === String(asset.appid) && item.contextId === String(asset.contextid))) continue;
                if (!/^\d{1,20}$/.test(assetId(asset))) { unresolved(currency); continue; }
                const data = { ...itemData(asset, side, user, asset.appid, asset.contextid), isCurrency: currency };
                result.push(data);
                annotate(element, data);
                complete = false;
            }
        }
        return { items: result, complete };
    }

    function editorState(active) {
        const user = inventoryOwner(active) || window.g_ActiveUser;
        const side = user && user === userFor('me') ? 'me' : user && user === userFor('them') ? 'them' : null;
        const items = itemInventory(active);
        return {
            side, ownerSteamId: steamId(user), appId: appId(active), contextId: items ? '2' : contextId(active),
            nativeContextId: contextId(active), supported: Boolean(side && items && steamId(user)),
            loading: pending(active) || pending(items),
            order: items ? originalOrders.get(items)?.order || 'original' : 'original'
        };
    }

    function signature() {
        const active = activeInventory();
        return JSON.stringify({
            owners: ['me', 'them'].map(side => steamId(userFor(side))), active: objectId(active),
            order: originalOrders.get(itemInventory(active))?.order,
            inventories: ['me', 'them'].map(side => {
                const inventory = loadedInventory(userFor(side));
                return [objectId(inventory), pending(inventory), assets(inventory).length];
            }), offers: ['me', 'them'].map(side => [offerRecords(side), offerRecords(side, 'currency')]),
            slots: ['me', 'them'].map(side => [false, true].map(currency => nativeSlotAssets(side, currency)
                .map(entry => [objectId(entry.element), assetId(entry.asset), entry.asset.amount]))),
            version: window.g_rgCurrentTradeStatus?.version
        });
    }

    function emitEditor(force) {
        const current = signature();
        if (!force && current === lastSignature) return;
        lastSignature = current;
        const owners = {}, inventories = [];
        for (const side of ['me', 'them']) {
            const user = userFor(side);
            owners[side] = { steamId: steamId(user) };
            const inventory = loadedInventory(user);
            if (!inventory || pending(inventory)) continue;
            const items = [];
            for (const asset of assets(inventory)) {
                if (!/^\d{1,20}$/.test(assetId(asset))) continue;
                const data = itemData(asset, side, user);
                items.push(data);
                annotate(asset.element, data);
            }
            inventories.push({ side, ownerSteamId: steamId(user), appId: '570', contextId: '2', items });
        }
        const me = offeredItems('me', userFor('me')), them = offeredItems('them', userFor('them'));
        reply('EDITOR', { owners, active: editorState(activeInventory()), inventories,
            offers: { me: me.items, them: them.items }, offersComplete: { me: me.complete, them: them.complete } });
    }

    function validatePrices(prices) {
        if (!prices || !Array.isArray(prices.assetPrices) || !Array.isArray(prices.namePrices) ||
            prices.assetPrices.length > MAX_ITEMS || prices.namePrices.length > MAX_ITEMS ||
            (prices.cleanNamePrices !== undefined && (!Array.isArray(prices.cleanNamePrices) || prices.cleanNamePrices.length > MAX_ITEMS))) {
            throw new Error('Invalid price data.');
        }
        const read = (entries, validKey) => {
            const map = new Map();
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length !== 2 || !validKey(entry[0]) ||
                    !Number.isSafeInteger(entry[1]) || entry[1] < 0) throw new Error('Invalid item price.');
                map.set(entry[0], entry[1]);
            }
            return map;
        };
        return {
            assets: read(prices.assetPrices, key => typeof key === 'string' && /^\d{1,20}$/.test(key)),
            names: read(prices.namePrices, key => typeof key === 'string' && key.length > 0 && key.length <= 512),
            cleanNames: read(prices.cleanNamePrices || [], key => typeof key === 'string' && key.length > 0 && key.length <= 512)
        };
    }

    function cleanName(name) {
        return String(name || '').toLowerCase()
            .replace(/^(inscribed|autographed|corrupted|frozen|heroic|cursed|genuine|favored|ascent|elder|unusual|exalted|infused|auspicious|base|legacy|sealed)\s+/i, '')
            .replace(/\s+(bundle|set)$/i, '').trim();
    }

    function priceFor(holder, prices) {
        const asset = holderAsset(holder);
        const id = assetId(asset);
        if (prices.assets.has(id)) return prices.assets.get(id);
        const desc = description(asset);
        const name = String(desc.market_hash_name || desc.market_name || '').toLowerCase().trim();
        // Different sockets and qualities can share a market hash name. Only
        // an exact owner/asset price can value these individual variants.
        if (!name || gemDetails(asset).hasGems || /\b(?:fractal horns of inner abysm|baby roshan|jumo)\b/i.test(name) ||
            /^(?:unusual|inscribed|autographed|corrupted)\s+/i.test(name)) return null;
        if (prices.names.has(name)) return prices.names.get(name);
        return prices.cleanNames.has(cleanName(name)) ? prices.cleanNames.get(cleanName(name)) : null;
    }

    function ensureSelected(user, ownerId) {
        const active = activeInventory();
        if (inventoryOwner(active) !== user || steamId(user) !== ownerId || !itemInventory(active)) {
            throw new Error('Inventory changed. Select that user’s Dota 2 inventory and try again.');
        }
        return active;
    }

    async function completeInventory(user, ownerId, progress) {
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        let active = ensureSelected(user, ownerId);
        const initial = active;
        const initiallyPending = pending(active) || pending(itemInventory(active));
        // Legacy RequestFullInventory merges every more/more_start response
        // before replacing Pending. Do not bypass its native authenticated read.
        while (pending(active) || pending(itemInventory(active))) {
            if (Date.now() >= deadline) throw new Error('Steam took too long to load the inventory. Try again later.');
            if (user?.rgContexts?.['570']?.['2'] && !loadedInventory(user)) {
                throw new Error('Steam could not load the inventory. Select it again to retry.');
            }
            progress(0, 0);
            await new Promise(resolve => window.setTimeout(resolve, 250));
            active = ensureSelected(user, ownerId);
        }
        if (!initiallyPending && active !== initial) throw new Error('The inventory was reloaded. Try again.');
        const items = itemInventory(active);
        if (typeof active.LoadCompleteInventory === 'function') {
            for (const inventory of new Set([active, items])) {
                const load = inventory.m_promiseLoadCompleteInventory;
                if (typeof load?.state === 'function' && load.state() === 'rejected') inventory.m_promiseLoadCompleteInventory = null;
            }
            await new Promise((resolve, reject) => {
                let finished = false;
                const callback = () => progress(assets(items).length, items.m_cItems || assets(items).length);
                const finish = error => {
                    if (finished) return;
                    finished = true;
                    window.clearTimeout(timer);
                    active.RemoveOnItemsLoadedCallback?.(callback);
                    if (error) reject(error); else resolve();
                };
                const timer = window.setTimeout(() => finish(new Error('Steam took too long to load the inventory.')), Math.max(1, deadline - Date.now()));
                try {
                    active.AddOnItemsLoadedCallback?.(callback);
                    const load = active.LoadCompleteInventory();
                    if (typeof load?.done === 'function') load.done(() => finish()).fail(() => finish(new Error('Steam could not load the complete inventory. Try again later.')));
                    else Promise.resolve(load).then(() => finish(), () => finish(new Error('Steam could not load the complete inventory.')));
                } catch (error) { finish(error); }
            });
            if (ensureSelected(user, ownerId) !== active || itemInventory(active) !== items || !items.m_bFullyLoaded) {
                throw new Error('Inventory changed before loading completed. Try again.');
            }
        }
        if (typeof items.Initialize === 'function' && !items.initialized) items.Initialize();
        if (typeof active.Initialize === 'function' && !active.initialized) active.Initialize();
        if (holders(items).length > MAX_ITEMS || holders(items).some(holder => !holderAsset(holder))) {
            throw new Error('This inventory is incomplete or too large to sort safely.');
        }
        return { active, items };
    }

    function updatePageMetadata(active) {
        if (!active?.m_rgPages || !originalOrders.has(itemInventory(active))) return;
        for (const page of active.m_rgPages) {
            page.m_$Page?.children().each(function () {
                if (this.rgItem) window.$J(this).data('iPage', page.m_iPage);
            });
        }
    }

    function preserveModernFilter() {
        const filter = window.Filter;
        if (!filter || hookedFilter === filter || typeof filter.ApplyFilter !== 'function') return;
        const apply = filter.ApplyFilter;
        filter.ApplyFilter = function (...args) {
            const result = apply.apply(this, args);
            updatePageMetadata(activeInventory());
            return result;
        };
        hookedFilter = filter;
    }

    function relayout(active, items) {
        for (const holder of holders(items)) {
            const node = holderNode(holder);
            node.filtered = false;
            if (node.style) node.style.display = '';
        }
        if (items.m_rgItemElements) {
            const perPage = Number.isSafeInteger(window.INVENTORY_PAGE_ITEMS) && window.INVENTORY_PAGE_ITEMS > 0 ? window.INVENTORY_PAGE_ITEMS : 16;
            items.m_rgItemElements.forEach((holder, index) => holder.data('iPage', Math.floor(index / perPage)));
            for (const inventory of new Set([active, items])) {
                const page = inventory.m_SingleResponsivePage;
                if (page && !responsivePages.has(page)) {
                    page.PostFilterCleanUp = function () {
                        if (!this.m_bMounted) return;
                        this.m_$Page.children().detach();
                        this.m_cPagesLoaded = 0;
                        this.m_bImagesLoaded = false;
                        this.EnsurePageItemsCreated();
                    };
                    responsivePages.add(page);
                }
                if (page?.m_$Page && (window.g_bEnableDynamicSizing || page.m_bMounted)) {
                    page.m_$Page.children().detach(); page.m_cPagesLoaded = 0; page.m_bImagesLoaded = false;
                }
            }
            items.m_bNeedsRepagination = active.m_bNeedsRepagination = true;
            active.m_iCurrentPage = 0;
        } else {
            items.bNeedsRepagination = active.bNeedsRepagination = true;
            active.pageCurrent = 0;
        }
        active.LayoutPages();
        if (typeof active.SetActivePage === 'function') active.SetActivePage(0);
        if (items.m_rgItemElements) preserveModernFilter();
        if (window.Filter?.elFilter && typeof window.Filter.ReApplyFilter === 'function') {
            if (String(window.Filter.elFilter.value || '').trim() || Object.keys(window.Filter.rgCurrentTags || {}).length) active.bFilterApplied = false;
            window.Filter.ReApplyFilter();
        }
        updatePageMetadata(active);
        if (typeof active.ShowPageControlsIfNeeded === 'function') active.ShowPageControlsIfNeeded();
        else {
            const controls = document.getElementById('inventory_pagecontrols');
            if (controls) controls.style.visibility = active.pageTotal <= 1 ? 'hidden' : '';
        }
    }

    async function sortInventory(message) {
        const requestId = message.requestId;
        const ownerSteamId = String(message.ownerSteamId || '');
        if (typeof requestId !== 'string' || !requestId || requestId.length > 100) return;
        if (busy) { reply('SORT_RESULT', { requestId, ownerSteamId, success: false, error: 'Another inventory is still loading.' }); return; }
        let acquired = false;
        try {
            const user = userFor(message.side);
            if (!user || !/^\d{17}$/.test(String(message.ownerSteamId)) || steamId(user) !== String(message.ownerSteamId) ||
                String(message.appId) !== '570' || String(message.contextId) !== '2' || !['asc', 'desc', 'original'].includes(message.order)) {
                throw new Error('Invalid trade inventory sort request.');
            }
            ensureSelected(user, String(message.ownerSteamId));
            const prices = message.order === 'original' ? null : validatePrices(message.prices);
            busy = acquired = true;
            const progress = (loaded, total) => {
                reply('SORT_PROGRESS', { requestId, ownerSteamId, loaded, total }); emitEditor(false);
            };
            const { active, items } = await completeInventory(user, String(message.ownerSteamId), progress);
            if (active.bInPagingTransition || active.m_$Inventory?.hasClass('paging_transition')) throw new Error('Wait for the page transition to finish, then try again.');
            if (typeof active.LayoutPages !== 'function') throw new Error('Steam’s inventory layout API is unavailable. Reload the page.');
            if (!originalOrders.has(items)) originalOrders.set(items, { holders: holders(items).slice(), order: 'original' });
            const original = originalOrders.get(items);
            const rank = new Map(original.holders.map((holder, index) => [holder, index]));
            const before = holders(items);
            const itemPrices = prices ? new Map(before.map(holder => [holder, priceFor(holder, prices)])) : null;
            const sorted = before.slice().sort((left, right) => {
                const stable = rank.get(left) - rank.get(right);
                if (message.order === 'original') return stable;
                const a = itemPrices.get(left), b = itemPrices.get(right);
                if (a === null || b === null) return a === b ? stable : a === null ? 1 : -1;
                return (message.order === 'asc' ? a - b : b - a) || stable;
            });
            if (items.m_rgItemElements) items.m_rgItemElements = sorted; else items.rgItemElements = sorted;
            try { relayout(active, items); }
            catch (error) {
                if (items.m_rgItemElements) items.m_rgItemElements = before; else items.rgItemElements = before;
                try { relayout(active, items); } catch (_) { /* Keep the first failure. */ }
                throw error;
            }
            original.order = message.order;
            emitEditor(true);
            reply('SORT_RESULT', { requestId, success: true, count: sorted.length, side: message.side,
                ownerSteamId: String(message.ownerSteamId), order: message.order });
        } catch (error) {
            reply('SORT_RESULT', { requestId, ownerSteamId, success: false, error: error?.message || 'Could not sort this inventory.' });
        } finally { if (acquired) busy = false; }
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== CONTENT_SOURCE) return;
        if (event.data.type === 'STATE_REQUEST') emitEditor(true);
        else if (event.data.type === 'SORT') void sortInventory(event.data);
    });
    window.setInterval(() => emitEditor(false), 500);
    emitEditor(true);
})();
