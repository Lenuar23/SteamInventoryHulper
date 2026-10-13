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
    let ordinaryEstimates = new Map(), ordinaryEstimateEpoch = 0;
    const collection = { owner: null, index: new Map(), state: 'idle', error: '', cache: null, epoch: 0 };
    const classAssetProofs = new Map(), classDetails = new Map();
    let classEstimates = new Map(), classEstimateEpoch = 0;
    const marketEstimates = new Map(), marketStates = new Map(), marketQueued = new Map();
    let marketBatchPending = false, marketBatchTimer = null;
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

    function marketName(item) {
        const name = item?.marketHashName || item?.market_hash_name || item?.description?.market_hash_name;
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 512) return null;
        const key = name.trim().toLowerCase();
        // Probe the same price resolver with a prospective quote. A stronger
        // price or an ambiguous native match must prevent fallback requests.
        const probe = new Map([[key, { marketHashName: name.trim(), priceCents: 1,
            currency: 'USD', source: 'steam-market', estimateKind: 'market-name' }]]);
        return Prices.getPrice(priceIndex(item.ownerSteamId), item, ordinaryEstimates, collection.index,
            classEstimates, probe).source === 'steam-market' ? name.trim() : null;
    }

    function loadMarketEstimates(items) {
        for (const item of items) {
            const name = marketName(item);
            if (!name) continue;
            const key = name.toLowerCase(), state = marketStates.get(key);
            if (state && state.state !== 'idle') continue;
            if (marketQueued.size >= 128) continue;
            marketQueued.set(key, { name, force: state?.force === true });
            marketStates.set(key, { state: 'loading', error: '' });
        }
        if (marketQueued.size && !marketBatchPending && marketBatchTimer === null) {
            marketBatchTimer = setTimeout(() => { marketBatchTimer = null; void fetchMarketBatch(); }, 50);
        }
    }

    function retryMarketEstimates(items) {
        for (const item of items) {
            const name = marketName(item);
            if (name && marketStates.get(name.toLowerCase())?.state !== 'loading') {
                marketStates.set(name.toLowerCase(), { state: 'idle', error: '', force: true });
            }
        }
    }

    async function fetchMarketBatch() {
        if (marketBatchPending || !marketQueued.size) return;
        marketBatchPending = true;
        const batch = [...marketQueued.entries()].slice(0, 20);
        for (const [key] of batch) marketQueued.delete(key);
        const fail = (key, error) => {
            marketStates.set(key, { state: 'error', error });
            const previous = marketEstimates.get(key);
            if (previous && Date.now() - previous.cachedAt <= 24 * 60 * 60 * 1000) {
                marketEstimates.set(key, { ...previous, cached: true, error });
            } else marketEstimates.delete(key);
        };
        try {
            const response = await queueOperation(() => new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Steam Market estimates timed out. Please retry.')), 240000);
                try {
                    chrome.runtime.sendMessage({ action: 'fetchMarketQuotes', names: batch.map(([, entry]) => entry.name),
                        force: batch.some(([, entry]) => entry.force) }, result => {
                        clearTimeout(timer);
                        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                        else if (!result?.success) reject(new Error(result?.error || 'Steam Market estimates are unavailable.'));
                        else resolve(result.data);
                    });
                } catch (error) { clearTimeout(timer); reject(error); }
            }));
            if (response?.currency !== 'USD' || !Array.isArray(response.items) || response.items.length > 20 ||
                !Array.isArray(response.missingNames) || !Array.isArray(response.errors) || response.errors.length > 20) {
                throw new Error('Steam Market returned invalid USD estimates.');
            }
            const expected = new Set(batch.map(([key]) => key)), quotes = new Map();
            for (const quote of response.items) {
                const key = typeof quote?.marketHashName === 'string' ? quote.marketHashName.trim().toLowerCase() : '';
                if (!expected.has(key) || quotes.has(key) || quote.currency !== 'USD' || quote.source !== 'steam-market' ||
                    quote.estimateKind !== 'market-name' || !Number.isSafeInteger(quote.priceCents) || quote.priceCents <= 0) {
                    throw new Error('Steam Market returned invalid USD estimates.');
                }
                quotes.set(key, { marketHashName: quote.marketHashName, priceCents: quote.priceCents,
                    currency: 'USD', source: 'steam-market', estimateKind: 'market-name', cached: quote.cached === true,
                    cachedAt: Number.isSafeInteger(quote.cachedAt) ? quote.cachedAt : Date.now(),
                    error: typeof quote.error === 'string' ? quote.error : '' });
            }
            for (const [key] of batch) {
                const quote = quotes.get(key);
                if (quote) {
                    marketEstimates.delete(key); marketEstimates.set(key, quote);
                    marketStates.set(key, { state: 'ready', error: quote.error });
                } else {
                    const error = response.errors.find(entry => typeof entry?.marketHashName === 'string' &&
                        entry.marketHashName.trim().toLowerCase() === key)?.error;
                    if (error) fail(key, String(error));
                    else {
                        marketEstimates.delete(key);
                        marketStates.set(key, { state: 'ready', error: 'Steam Market has no current listing quote for this name.' });
                    }
                }
            }
        } catch (error) {
            for (const [key] of batch) fail(key, error.message);
        } finally {
            marketBatchPending = false;
            while (marketEstimates.size > 128) {
                const key = marketEstimates.keys().next().value;
                marketEstimates.delete(key);
                if (marketStates.get(key)?.state !== 'loading') marketStates.delete(key);
            }
            for (const [key, state] of marketStates) {
                if (marketStates.size <= 256) break;
                if (state.state !== 'loading' && !marketEstimates.has(key)) marketStates.delete(key);
            }
            queueRender();
            if (marketQueued.size) void fetchMarketBatch();
        }
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
        if (force) {
            // A fresh price response can include a newly added matching copy.
            // Its prices cannot be combined with an older class membership scan.
            for (const key of classAssetProofs.keys()) if (key.startsWith(data.id + ':')) {
                classAssetProofs.delete(key); classEstimates.delete(key);
            }
            classEstimateEpoch++;
            for (const [id, entry] of classDetails) if (entry.ownerIds?.includes(data.id)) {
                classDetails.set(id, { state: 'idle', error: '', force: true, ownerIds: entry.ownerIds });
            }
        }
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
            void rebuildOrdinaryEstimates();
            void rebuildClassEstimates();
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

    async function rebuildOrdinaryEstimates() {
        const epoch = ++ordinaryEstimateEpoch;
        const estimates = new Map();
        const maps = [...owners.values()].map(data => data.index?.sharedOrdinaryPrices).filter(map => map instanceof Map);
        let processed = 0;
        for (const map of maps) for (const [key, cents] of map) {
            if (epoch !== ordinaryEstimateEpoch) return;
            if (!estimates.has(key)) estimates.set(key, cents);
            else if (estimates.get(key) !== cents) estimates.set(key, null);
            if (++processed % 300 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (epoch !== ordinaryEstimateEpoch) return;
        ordinaryEstimates = estimates;
        queueRender();
    }

    async function rebuildClassEstimates() {
        const epoch = ++classEstimateEpoch, estimates = new Map();
        const proofs = [...classAssetProofs];
        let processed = 0;
        for (const [key, assetIds] of proofs) {
            // No current copy means no class quote. It must not suppress an
            // independently verified catalog quote after a successful retry.
            if (!assetIds.length) continue;
            const owner = key.split(':')[0], index = priceIndex(owner);
            let cents, complete = assetIds.length > 0;
            for (const assetId of assetIds) {
                if (epoch !== classEstimateEpoch) return;
                const price = index?.assetPrices?.get(owner + ':' + assetId);
                if (!Number.isSafeInteger(price) || price < 0 || (cents !== undefined && cents !== price)) {
                    complete = false; break;
                }
                cents = price;
                if (++processed % 300 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            estimates.set(key, complete ? cents : null);
        }
        if (epoch !== classEstimateEpoch) return;
        classEstimates = estimates;
        queueRender();
    }

    async function loadCollection(owner, force = false) {
        if (!validOwner(owner) || collection.state === 'loading') return;
        const epoch = ++collection.epoch;
        if (collection.owner !== owner) collection.index = new Map();
        collection.owner = owner;
        collection.state = 'loading'; collection.error = '';
        queueRender();
        try {
            const response = await request('fetchCollection', owner, force);
            if (epoch !== collection.epoch || collection.owner !== owner) return;
            if (!Array.isArray(response?.items) || response.items.length > 100000) {
                throw new Error('Steamprice returned invalid collection prices.');
            }
            const index = new Map();
            for (let start = 0; start < response.items.length; start += 300) {
                if (epoch !== collection.epoch) return;
                const part = Prices.buildCatalogIndex(response.items.slice(start, start + 300));
                for (const [name, cents] of part) {
                    if (!index.has(name)) index.set(name, cents);
                    else if (index.get(name) !== cents) index.set(name, null);
                }
                if (start + 300 < response.items.length) await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (epoch !== collection.epoch) return;
            collection.index = index;
            collection.cache = response.cacheInfo;
            collection.error = collection.cache.error;
            collection.state = 'ready';
        } catch (error) {
            if (epoch !== collection.epoch) return;
            collection.error = error.message;
            collection.state = 'error';
            if (collection.index.size) collection.cache = { ...collection.cache, cached: true, error: error.message };
        }
        queueRender();
    }

    function needsCollection(items) {
        return items.some(item => item.catalogFingerprint &&
            Prices.getPrice(priceIndex(item.ownerSteamId), item, ordinaryEstimates, collection.index, classEstimates).cents === null);
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
            '.sih-lite-trade-price.sih-lite-trade-market-price{color:#ffc878;border-color:#ffc878}',
            '.sih-lite-trade-button{background:#39516a;color:#fff;border:1px solid #536b83;padding:5px 8px;border-radius:3px;cursor:pointer;margin:3px 5px 3px 0}',
            '.sih-lite-trade-button:disabled{opacity:.5;cursor:default}.sih-lite-trade-button[aria-pressed="true"]{border-color:#5cff5c}',
            '.sih-lite-trade-accept-status{width:100%;overflow-wrap:anywhere}.sih-lite-trade-summary button{position:relative;z-index:4}',
            '.sih-lite-trade-diagnostics-status{width:100%;font-size:12px}.sih-lite-trade-diagnostics-text{width:100%;height:160px;box-sizing:border-box;background:#18212a;color:#c6d4df;font-size:12px}',
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
        summary.title = 'Dota 2 values in USD. Steam Market fallbacks are labeled estimates and may exclude attached-gem premiums.';
        return summary;
    }

    function renderSummary(element, give, receive, me, them, extraStatus = '', completeness = {}) {
        const a = Prices.summarize(give, priceIndex(me), ordinaryEstimates, collection.index, classEstimates, marketEstimates);
        const b = Prices.summarize(receive, priceIndex(them), ordinaryEstimates, collection.index, classEstimates, marketEstimates);
        if (completeness.me === false) a.complete = false;
        if (completeness.them === false) b.complete = false;
        const net = Prices.difference(a, b);
        const marketEstimated = (a.marketEstimatedCount || 0) + (b.marketEstimatedCount || 0);
        const subtotal = side => !side.complete && side.itemCount > 0 && side.pricedCount === 0
            ? 'Unavailable' : money(side.knownCents) + (side.marketEstimatedCount > 0
                ? side.complete ? ' (estimated)' : ' (known, estimated)' : side.complete ? '' : ' (known)');
        text(role(element, 'give'), 'You give: ' + subtotal(a));
        text(role(element, 'receive'), 'You receive: ' + subtotal(b));
        const netElement = role(element, 'net');
        text(netElement, !net.complete ? (marketEstimated ? 'Known estimated difference: ' : 'Known difference: ') + (a.pricedCount + b.pricedCount === 0
            ? 'Unavailable' : signedMoney(net.knownCents || 0))
            : net.cents > 0 ? (marketEstimated ? 'Estimated gain: ' : 'Net gain: ') + signedMoney(net.cents)
                : net.cents < 0 ? (marketEstimated ? 'Estimated loss: ' : 'Net loss: ') + signedMoney(net.cents)
                    : marketEstimated ? 'Estimated difference: $0.00' : 'Even: $0.00');
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
        const ordinaryEstimated = (a.ordinaryEstimatedCount || 0) + (b.ordinaryEstimatedCount || 0);
        if (ordinaryEstimated) status.push('Includes ' + ordinaryEstimated + ' current Steamprice ordinary-item estimate' +
            (ordinaryEstimated === 1 ? '.' : 's.') + ' Saved source prices may be cached.');
        const catalogEstimated = (a.catalogEstimatedCount || 0) + (b.catalogEstimatedCount || 0);
        if (catalogEstimated) {
            status.push('Includes ' + catalogEstimated + ' current Steamprice collection estimate' + (catalogEstimated === 1 ? '.' : 's.'));
            const cached = cacheNotice(collection.cache, 'Cached collection prices');
            if (cached) status.push(cached);
        }
        const classEstimated = (a.classEstimatedCount || 0) + (b.classEstimatedCount || 0);
        if (classEstimated) status.push('Includes ' + classEstimated + ' current estimate' + (classEstimated === 1 ? '' : 's') +
            ' matched by exact item class and variant in the owner’s inventory.');
        if (marketEstimated) status.push('Includes ' + marketEstimated + ' Steam Market USD listing estimate' +
            (marketEstimated === 1 ? '.' : 's.') + ' Steam wallet prices may differ from cash prices and do not establish attached-gem or autograph premiums.');
        const marketNames = new Set([...give, ...receive].map(marketName).filter(Boolean).map(name => name.toLowerCase()));
        if ([...marketNames].some(name => marketStates.get(name)?.state === 'loading')) status.push('Loading Steam Market estimates…');
        const marketErrors = new Set();
        for (const name of marketNames) {
            const state = marketStates.get(name), quote = marketEstimates.get(name);
            if (state?.error) marketErrors.add(state.error);
            const cached = cacheNotice(quote, 'Cached Steam Market estimate');
            if (quote?.cached && cached && !status.includes(cached)) status.push(cached);
        }
        for (const error of [...marketErrors].slice(0, 3)) status.push('Steam Market: ' + error);
        if (needsCollection([...give, ...receive])) {
            if (collection.state === 'loading') status.push('Loading Steamprice collection prices…');
            else if (collection.error) status.push('Steamprice collection prices: ' + collection.error);
        }
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
        const market = listPage || element.closest('#your_slots, #their_slots') ? marketEstimates : null;
        const price = Prices.getPrice(priceIndex(item.ownerSteamId), item, ordinaryEstimates, collection.index, classEstimates, market);
        const value = Prices.summarize([item], priceIndex(item.ownerSteamId), ordinaryEstimates, collection.index, classEstimates, market);
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
        badge.classList.toggle('sih-lite-trade-market-price', price.source === 'steam-market');
        text(badge, (price.source === 'steam-market' ? '~' : '') + money(value.knownCents));
        if (price.source === 'steam-market') {
            const quote = marketEstimates.get((item.marketHashName || item.market_hash_name || '').trim().toLowerCase());
            badge.title = 'Steam Market USD estimate: ' + money(price.cents) + ' each, quantity ' + String(item.amount ?? 1) +
                '. Current lowest listing for the exact market name. Steam wallet prices may differ from cash prices; attached-gem and autograph premiums are not established.' +
                (quote?.cached ? ' ' + cacheNotice(quote, 'Cached Steam Market estimate') : '');
            return;
        }
        badge.title = 'Steamprice: ' + money(price.cents) + ' each, quantity ' + String(item.amount ?? 1) + '.' +
            (price.source === 'variant' ? ' Current estimate for the matching gem variant; exact asset details are unavailable.' : '') +
            (price.source === 'ordinary-estimate' ? ' Current ordinary-item estimate from saved Steamprice prices; exact asset details are unavailable. Source prices may be cached.' : '') +
            (price.source === 'catalog' ? ' Current estimate from Steamprice collection; exact asset details are unavailable.' +
                (collection.cache?.cached ? ' ' + cacheNotice(collection.cache, 'Cached collection prices') : '') : '') +
            (price.source === 'class-estimate' ? ' Current estimate from all matching item classes and variants in this owner’s inventory. Historical asset identity is unchanged.' : '') +
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
            retryMarketEstimates([...normalizeItems(editor?.offers?.me, editor?.owners?.me?.steamId),
                ...normalizeItems(editor?.offers?.them, editor?.owners?.them?.steamId)]);
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
        if (![me, them].some(id => owners.get(id)?.priceState === 'loading')) loadMarketEstimates([...give, ...receive]);
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
            const marketNames = [...give, ...receive].map(marketName).filter(Boolean).map(name => name.toLowerCase());
            document.getElementById('sih-lite-trade-retry').hidden = !errors.length &&
                !marketNames.some(name => marketStates.get(name)?.error || marketEstimates.get(name)?.cached);
            document.getElementById('sih-lite-trade-retry').disabled = [me, them].some(id =>
                owners.get(id)?.priceState === 'loading' || owners.get(id)?.profileState === 'loading') ||
                marketNames.some(name => marketStates.get(name)?.state === 'loading');
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
            for (const [source, target] of [[data.index.exactNames, namePrices]]) {
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

    function classCandidates(offer, force = false) {
        const eligible = item => {
            if (item.appId !== '570' || item.isCurrency ||
                (item.contextId != null && item.contextId !== '2') ||
                !/^[1-9]\d{0,19}$/.test(String(item.classId)) || !/^\d{1,20}$/.test(String(item.instanceId)) ||
                ![true, 1].includes(item.tradable) || !priceIndex(item.ownerSteamId)?.assetPrices?.size) return false;
            const price = Prices.getPrice(priceIndex(item.ownerSteamId), item, ordinaryEstimates, collection.index, classEstimates);
            return price.cents === null || (force && price.source === 'class-estimate');
        };
        return { ...offer, meSteamId: list.meSteamId,
            give: normalizeItems(offer.give, list.meSteamId).filter(eligible),
            receive: normalizeItems(offer.receive, offer.partnerSteamId).filter(eligible) };
    }

    function loadClassAssets(offer) {
        if (typeof Offers.fetchClassAssets !== 'function' || details.get(offer.offerId)?.state === 'loading' ||
            [list.meSteamId, offer.partnerSteamId].some(id => owners.get(id)?.priceState === 'loading') ||
            collection.state === 'loading') return;
        const previous = classDetails.get(offer.offerId);
        if (previous && previous.state !== 'idle') return;
        const candidates = classCandidates(offer, previous?.force === true);
        if (!candidates.give.length && !candidates.receive.length) return;
        const entry = { state: 'loading', error: '', force: previous?.force === true,
            ownerIds: [list.meSteamId, offer.partnerSteamId] };
        classDetails.set(offer.offerId, entry);
        const meSteamId = list.meSteamId;
        if (entry.force) {
            for (const item of [...candidates.give, ...candidates.receive]) {
                const key = item.ownerSteamId + ':' + item.classId + ':' + item.instanceId;
                classAssetProofs.delete(key); classEstimates.delete(key);
            }
            classEstimateEpoch++;
        }
        queueOperation(() => Offers.fetchClassAssets(candidates, meSteamId, undefined, { force: entry.force })).then(async data => {
            if (classDetails.get(offer.offerId) !== entry || list.meSteamId !== meSteamId) return;
            if (data?.offerId !== offer.offerId || data.meSteamId !== meSteamId || data.partnerSteamId !== offer.partnerSteamId ||
                !Array.isArray(data.classAssets) || data.classAssets.length > 100000) {
                throw new Error('Steam returned invalid current item classes.');
            }
            const wanted = new Set([...candidates.give, ...candidates.receive].map(item =>
                item.ownerSteamId + ':' + item.classId + ':' + item.instanceId));
            for (const proof of data.classAssets) {
                const key = proof.ownerSteamId + ':' + proof.classId + ':' + proof.instanceId;
                if (!wanted.has(key) || proof.appId !== '570' || proof.contextId !== '2' ||
                    !Array.isArray(proof.assetIds) || proof.assetIds.length > 100000 ||
                    proof.assetIds.some(id => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))) {
                    throw new Error('Steam returned invalid current item classes.');
                }
            }
            for (const proof of data.classAssets) {
                classAssetProofs.set(proof.ownerSteamId + ':' + proof.classId + ':' + proof.instanceId, proof.assetIds);
            }
            await rebuildClassEstimates();
            entry.state = data.classAssetError ? 'error' : 'ready';
            entry.error = data.classAssetError || '';
        }).catch(error => {
            if (classDetails.get(offer.offerId) !== entry) return;
            entry.state = 'error'; entry.error = error.message;
        }).finally(queueRender);
    }

    async function copyDiagnostics(offerId, summary, event) {
        if (!event.isTrusted || !globalThis.SIHLiteTradeDiagnostics?.buildReport) return;
        const offer = readOffers().find(value => value.offerId === offerId);
        if (!offer) return;
        const report = globalThis.SIHLiteTradeDiagnostics.buildReport({
            version: chrome.runtime.getManifest?.().version || '1.3.5', pathname: location.pathname, offer,
            detailState: details.get(offerId), classState: classDetails.get(offerId),
            owners, ordinaryEstimates, collection, classAssetProofs, classEstimates, marketEstimates, marketStates
        });
        const value = JSON.stringify(report, null, 2);
        let status = role(summary, 'diagnostics-status');
        if (!status) {
            status = document.createElement('span'); status.dataset.role = 'diagnostics-status';
            status.className = 'sih-lite-trade-diagnostics-status'; summary.appendChild(status);
        }
        try {
            await navigator.clipboard.writeText(value);
            summary.querySelector('.sih-lite-trade-diagnostics-text')?.remove();
            text(status, 'Price diagnostics copied.');
        } catch (_) {
            let field = summary.querySelector('.sih-lite-trade-diagnostics-text');
            if (!field) {
                field = document.createElement('textarea'); field.readOnly = true;
                field.className = 'sih-lite-trade-diagnostics-text'; field.setAttribute('aria-label', 'Price diagnostics');
                summary.appendChild(field);
            }
            field.value = value; field.focus(); field.select();
            text(status, 'Copy the price diagnostics below.');
        }
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
            if (collection.state === 'idle' && needsCollection([...give, ...receive]) &&
                ![me, them].some(id => owners.get(id)?.priceState === 'loading') &&
                details.get(offer.offerId)?.state !== 'loading') void loadCollection(me);
            loadClassAssets(offer);
            if (![me, them].some(id => owners.get(id)?.priceState === 'loading') &&
                details.get(offer.offerId)?.state !== 'loading' && classDetails.get(offer.offerId)?.state !== 'loading' &&
                collection.state !== 'loading') loadMarketEstimates([...give, ...receive]);
            let summary = offer.element.querySelector('.sih-lite-trade-summary');
            if (!summary) {
                summary = makeSummary();
                summary.dataset.offerId = offer.offerId;
                offer.element.appendChild(summary);
                const retry = makeButton('Retry prices', () => {
                    retryOwners([list.meSteamId, offer.partnerSteamId]);
                    const current = readOffers().find(value => value.offerId === offer.offerId);
                    if (current) retryMarketEstimates([...current.give, ...current.receive]);
                    if (details.get(offer.offerId)?.state === 'error') loadDetails(offer, true);
                    classDetails.set(offer.offerId, { state: 'idle', error: '', force: true });
                    if (collection.owner === list.meSteamId && collection.state !== 'loading' &&
                        (collection.error || collection.cache?.cached)) void loadCollection(list.meSteamId, true);
                });
                retry.classList.add('sih-lite-trade-retry');
                summary.appendChild(retry);
                const diagnostics = makeButton('Copy price diagnostics', event => copyDiagnostics(offer.offerId, summary, event));
                diagnostics.classList.add('sih-lite-trade-diagnostics'); summary.appendChild(diagnostics);
                const scans = document.createElement('span'); scans.dataset.role = 'scan-links'; summary.appendChild(scans);
            }
            const detail = details.get(offer.offerId);
            const classDetail = classDetails.get(offer.offerId);
            const extraStatus = [];
            if (detail?.state === 'loading') extraStatus.push('Loading trade item descriptions…');
            else if (detail?.error) extraStatus.push(detail.error);
            if (classDetail?.state === 'loading') extraStatus.push('Loading exact current item variants…');
            else if (classDetail?.error) extraStatus.push('Current variant prices: ' + classDetail.error);
            if (!offer.active) extraStatus.push('Historical offers show current estimates, not prices at the time of the trade.');
            renderSummary(summary, give, receive, me, them, extraStatus.join(' '));
            const unpriced = [...give, ...receive].some(item =>
                Prices.getPrice(priceIndex(item.ownerSteamId), item, ordinaryEstimates, collection.index, classEstimates, marketEstimates).cents === null);
            const unpricedCard = (offer.slots || []).some(slot => Prices.getPrice(priceIndex(slot.item?.ownerSteamId),
                slot.item, ordinaryEstimates, collection.index, classEstimates, marketEstimates).cents === null);
            const marketNames = [...give, ...receive].map(marketName).filter(Boolean).map(name => name.toLowerCase());
            const marketUsed = [...give, ...receive].some(item => Prices.getPrice(priceIndex(item.ownerSteamId), item,
                ordinaryEstimates, collection.index, classEstimates, marketEstimates).source === 'steam-market');
            summary.querySelector('.sih-lite-trade-diagnostics').hidden = !unpriced && !unpricedCard && !marketUsed;
            renderScanLinks(role(summary, 'scan-links'), me, them);
            summary.querySelector('.sih-lite-trade-retry').hidden =
                !unpriced && !owners.get(me)?.priceError && !owners.get(them)?.priceError && !detail?.error && !classDetail?.error &&
                !owners.get(me)?.priceCache?.cached && !owners.get(them)?.priceCache?.cached &&
                !owners.get(me)?.needsScan && !owners.get(them)?.needsScan &&
                !collection.error && !collection.cache?.cached &&
                !marketNames.some(name => marketStates.get(name)?.error || marketEstimates.get(name)?.cached);
            summary.querySelector('.sih-lite-trade-retry').disabled =
                [me, them].some(id => owners.get(id)?.priceState === 'loading') || detail?.state === 'loading' ||
                classDetail?.state === 'loading' || collection.state === 'loading' ||
                marketNames.some(name => marketStates.get(name)?.state === 'loading');
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
                classDetails.clear(); classAssetProofs.clear(); classEstimates = new Map(); classEstimateEpoch++;
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
