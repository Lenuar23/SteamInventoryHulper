(() => {
  'use strict';

  const STEAM_ID = /^7656119\d{10}$/;
  const NUMBER_ID = /^[1-9]\d{0,19}$/;
  const STEAM_ID_BASE = 76561197960265728n;

  function steamId(value) {
    if (typeof value === 'number') return null;
    const id = String(value ?? '');
    return STEAM_ID.test(id) ? id : null;
  }

  function accountSteamId(value) {
    const account = String(value ?? '');
    if (!/^[1-9]\d{0,9}$/.test(account)) return null;
    const number = BigInt(account);
    return number <= 4294967295n ? steamId(String(STEAM_ID_BASE + number)) : null;
  }

  function numericId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    const id = String(value ?? '');
    return NUMBER_ID.test(id) ? id : null;
  }

  function positiveAmount(value) {
    const amount = value === undefined ? 1 : Number(value);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
  }

  // Steam's hover keys distinguish real assets from class descriptions.
  function parseEconomyKey(value) {
    if (typeof value !== 'string' || value.length > 300) return null;
    const parts = value.split('/');
    let amount = 1;
    if (/^a:/.test(parts[parts.length - 1])) {
      amount = positiveAmount(parts.pop().slice(2));
      if (amount == null) return null;
    }
    if (parts[0] === 'classinfo') {
      if (parts.length < 3 || parts.length > 4 || !numericId(parts[1]) || !numericId(parts[2])) return null;
      const instanceId = parts[3] ?? '0';
      if (!/^\d{1,20}$/.test(instanceId)) return null;
      return { appId: parts[1], contextId: null, assetId: null, classId: parts[2], instanceId, amount, ownerSteamId: null };
    }
    if (parts.length < 3 || parts.length > 4 || !parts.slice(0, 3).every(numericId)) return null;
    let ownerSteamId = null;
    if (parts[3] && !parts[3].startsWith('id:')) {
      ownerSteamId = steamId(parts[3]);
      if (!ownerSteamId) return null;
    }
    return { appId: parts[0], contextId: parts[1], assetId: parts[2], amount, ownerSteamId };
  }

  function normalizeItem(value, owner) {
    if (!value || typeof value !== 'object' || !steamId(owner)) return null;
    const appId = numericId(value.appId ?? value.appid);
    const contextId = numericId(value.contextId ?? value.contextid);
    const assetId = numericId(value.assetId ?? value.assetid);
    const amount = positiveAmount(value.amount);
    if (!appId || amount == null) return null;
    const claimedOwner = value.ownerSteamId ?? value.owner;
    if (claimedOwner && String(claimedOwner) !== owner) return null;
    const description = value.description && typeof value.description === 'object' ? value.description : value;
    const canonical = description.market_hash_name ?? description.marketHashName;
    const item = { ownerSteamId: owner, appId, contextId, assetId, amount, market_hash_name: typeof canonical === 'string' ? canonical.slice(0, 512) : '' };
    const classId = numericId(value.classId ?? value.classid ?? description.classid);
    const instanceValue = value.instanceId ?? value.instanceid ?? description.instanceid;
    const instanceId = instanceValue == null ? '' : String(instanceValue);
    if (classId) item.classId = classId;
    if (/^\d{1,20}$/.test(instanceId)) item.instanceId = instanceId;
    for (const field of ['hasGems', 'hasColoredGem']) {
      if (value[field] === true) item[field] = true;
    }
    const currencyId = numericId(value.currencyId ?? value.currencyid);
    if (value.isCurrency === true || value.is_currency === true || currencyId) {
      item.isCurrency = true;
      item.assetId = null;
      if (currencyId) item.currencyId = currencyId;
    }
    return item;
  }

  function profileSteamId(element) {
    if (!element) return null;
    const direct = steamId(element.getAttribute('data-steamid'));
    if (direct) return direct;
    const mini = accountSteamId(element.getAttribute('data-miniprofile'));
    if (mini) return mini;
    const href = element.getAttribute('href') || '';
    const profile = steamId(href.match(/(?:^|\/)profiles\/(7656119\d{10})(?:\/|$)/)?.[1]);
    if (profile) return profile;
    const child = element.querySelector('[data-miniprofile], [data-steamid], a[href]');
    return child && child !== element ? profileSteamId(child) : null;
  }

  function nativeAction(card, action, offerId) {
    for (const element of card.querySelectorAll('.tradeoffer_footer_actions [onclick], .tradeoffer_footer_actions a[href]')) {
      const code = `${element.getAttribute('onclick') || ''} ${element.getAttribute('href') || ''}`;
      const match = code.match(new RegExp(`\\b${action}\\s*\\(\\s*['\"]?(\\d+)['\"]?\\s*[,)]`));
      if (match && match[1] === offerId) return true;
    }
    return false;
  }

  function itemFromSlot(slot, owner, snapshotItem) {
    const key = slot.getAttribute('data-economy-item') || slot.querySelector('[data-economy-item]')?.getAttribute('data-economy-item');
    const parsed = parseEconomyKey(key);
    if (!parsed) return normalizeItem(snapshotItem, owner);
    if (parsed.ownerSteamId && parsed.ownerSteamId !== owner) return null;
    const item = normalizeItem(parsed, owner);
    if (!item) return null;
    const known = normalizeItem(snapshotItem, owner);
    if (known && known.appId === item.appId && (!item.assetId || item.assetId === known.assetId) &&
        (!item.classId || !known.classId || item.classId === known.classId) &&
        (item.instanceId == null || known.instanceId == null || item.instanceId === known.instanceId)) {
      return { ...item, ...known, amount: item.amount };
    }
    return item;
  }

  function applyDetails(offer, details, meSteamId) {
    if (!details || details.offerId !== offer.offerId || details.meSteamId !== meSteamId || details.partnerSteamId !== offer.partnerSteamId) return offer;
    for (const side of ['give', 'receive']) {
      const owner = side === 'give' ? meSteamId : offer.partnerSteamId;
      const items = (details[side] || []).map(item => normalizeItem(item, owner));
      if (items.some(item => !item || (!item.assetId && !item.isCurrency) || !item.contextId)) continue;
      const slots = offer.slots.filter(slot => slot.side === side);
      // The native offer arrays are also used to render the list. Reject stale
      // or mismatched lists rather than displaying prices on different items.
      if (items.length !== slots.length) continue;
      // Exact native offer assets establish totals even if an old or private
      // item's class description is unavailable. Badges require a proven match.
      offer[side] = items;
      const available = items.slice();
      slots.forEach(slot => {
        const old = slot.item;
        const matchIndex = available.findIndex(item => old && old.appId === item.appId && old.amount === item.amount &&
          (old.assetId ? old.assetId === item.assetId :
            old.classId && item.classId === old.classId && old.instanceId != null && item.instanceId === old.instanceId));
        if (matchIndex < 0) return;
        const [item] = available.splice(matchIndex, 1);
        slot.item = { ...slot.item, ...item };
      });
    }
    return offer;
  }

  function read(document, snapshot = {}, detailsByOfferId = {}) {
    const meSteamId = steamId(snapshot.meSteamId);
    if (!meSteamId) return [];
    const knownOffers = new Map((snapshot.offers || []).filter(offer => offer && numericId(offer.offerId)).map(offer => [String(offer.offerId), offer]));
    const offers = [];
    for (const card of document.querySelectorAll('.tradeoffer[id^="tradeofferid_"]')) {
      const offerId = numericId(card.id.match(/^tradeofferid_(\d+)$/)?.[1]);
      if (!offerId) continue;
      const known = knownOffers.get(offerId) || {};
      const sections = [...card.querySelectorAll('.tradeoffer_items')];
      if (sections.length !== 2) continue;
      const owners = sections.map(section => profileSteamId(section.querySelector('.tradeoffer_avatar')));
      const hasDecline = nativeAction(card, 'DeclineTradeOffer', offerId);
      const hasCancel = nativeAction(card, 'CancelTradeOffer', offerId);
      // A native action establishes direction even when avatars use vanity URLs.
      if (owners.some(owner => !owner) && (hasDecline !== hasCancel)) {
        const partner = steamId(known.partnerSteamId) || profileSteamId(card.querySelector('.tradeoffer_partner'));
        if (partner && partner !== meSteamId) {
          owners[0] ||= hasDecline ? partner : meSteamId;
          owners[1] ||= hasDecline ? meSteamId : partner;
        }
      }
      if (owners.filter(owner => owner === meSteamId).length !== 1 || owners.some(owner => !owner)) continue;
      const partnerSteamId = owners.find(owner => owner !== meSteamId);
      if (!steamId(partnerSteamId) || partnerSteamId === meSteamId || (known.partnerSteamId && known.partnerSteamId !== partnerSteamId)) continue;
      const container = card.querySelector('.tradeoffer_items_ctn');
      const active = Boolean(container && !container.classList.contains('inactive') && !card.querySelector('.tradeoffer_items_banner') && (hasDecline || hasCancel));
      const incoming = hasDecline || (!hasCancel && owners[0] === partnerSteamId);
      const offer = { offerId, meSteamId, partnerSteamId, incoming, active, canAccept: active && incoming && hasDecline && !hasCancel, element: card, give: [], receive: [], slots: [] };
      sections.forEach((section, sectionIndex) => {
        const side = owners[sectionIndex] === meSteamId ? 'give' : 'receive';
        const knownSlots = (known.slots || []).filter(slot => slot.side === side);
        [...section.querySelectorAll('.tradeoffer_item_list .trade_item')].forEach((element, index) => {
          const key = `${offerId}:${side}:${index}`;
          const knownSlot = knownSlots.find(slot => slot.key === key);
          const item = itemFromSlot(element, owners[sectionIndex], knownSlot?.item || known[side]?.[index]);
          // Retain unrecognized slots: totals must report an unknown item.
          const value = item || { ownerSteamId: owners[sectionIndex], appId: null, contextId: null, assetId: null, amount: 1, market_hash_name: '' };
          offer[side].push(value);
          offer.slots.push({ element, key, item: value, side });
        });
      });
      const details = detailsByOfferId instanceof Map ? detailsByOfferId.get(offerId) : detailsByOfferId[offerId];
      offers.push(applyDetails(offer, details, meSteamId));
    }
    return offers;
  }

  // Locate JSON assignments without executing any code from the fetched page.
  function readAssignment(html, name) {
    const expression = new RegExp(`(?:\\bvar\\s+|\\blet\\s+|\\bconst\\s+|\\b)${name}\\s*=\\s*`, 'g');
    let match;
    while ((match = expression.exec(html))) {
      let start = expression.lastIndex;
      const opening = html[start];
      if (opening !== '{' && opening !== '[') continue;
      const stack = [opening];
      let quoted = false;
      let escaped = false;
      for (let end = start + 1; end < html.length; end++) {
        const char = html[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
          const expected = char === '}' ? '{' : '[';
          if (stack.pop() !== expected) break;
          if (!stack.length) {
            try { return JSON.parse(html.slice(start, end + 1)); } catch (_) { break; }
          }
        }
      }
    }
    return null;
  }

  function scalarId(html, name) {
    const match = html.match(new RegExp(`\\b${name}\\s*=\\s*['\"]?(\\d{1,20})['\"]?\\s*[;,]`));
    return steamId(match?.[1]);
  }

  function stringAssignment(html, name) {
    const match = html.match(new RegExp(`\\b${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\s*[;,]`));
    if (!match) return null;
    if (match[1][0] === '"') {
      try { return JSON.parse(match[1]); } catch (_) { return null; }
    }
    // Native Steam uses plain quoted strings for IDs and legacy URLs.
    return match[1].slice(1, -1).replace(/\\(['\\/])/g, '$1');
  }

  const classInventories = new Map();

  function inventoryEndpoint(html, details, owner, appId, contextId) {
    const own = owner === details.meSteamId;
    const raw = stringAssignment(html, own ? 'g_strInventoryLoadURL' : 'g_strTradePartnerInventoryLoadURL');
    let session = stringAssignment(html, 'g_sessionID');
    if (!session && typeof document !== 'undefined') session = document.cookie.match(/(?:^|;\s*)sessionid=([a-zA-Z0-9]+)/)?.[1];
    if (raw && typeof raw === 'string') {
      try {
        const url = new URL(raw, 'https://steamcommunity.com');
        const ownPath = new RegExp(`^/profiles/${owner}/inventory/(?:json/)?$`);
        const partnerPath = new RegExp(`^/tradeoffer/(?:${details.offerId}|new)/partnerinventory/?$`);
        if (url.origin === 'https://steamcommunity.com' && !url.username && !url.password && !url.search && !url.hash &&
            (own ? ownPath.test(url.pathname) : partnerPath.test(url.pathname))) {
          if (own) url.pathname = url.pathname.replace(/\/?$/, '/') + appId + '/' + contextId + '/';
          else if (typeof session === 'string' && /^[a-zA-Z0-9]{1,100}$/.test(session)) {
            url.searchParams.set('sessionid', session);
            url.searchParams.set('partner', owner);
            url.searchParams.set('appid', appId);
            url.searchParams.set('contextid', contextId);
          } else return { url: new URL(`https://steamcommunity.com/inventory/${owner}/${appId}/${contextId}/`), modern: true };
          url.searchParams.set('l', 'english');
          url.searchParams.set('count', '2000');
          return { url, modern: false };
        }
      } catch (_) { /* The modern owner-specific endpoint is the safe fallback. */ }
    }
    const url = new URL(`https://steamcommunity.com/inventory/${owner}/${appId}/${contextId}/`);
    url.searchParams.set('l', 'english');
    url.searchParams.set('count', '2000');
    return { url, modern: true };
  }

  function mergeInventoryPage(cache, body, owner, appId, contextId, modern) {
    if (!body || !(body.success === true || body.success === 1)) throw new Error('Steam inventory descriptions are unavailable.');
    const descriptions = new Map();
    if (modern) {
      for (const description of body.descriptions || []) {
        if (description && String(description.appid ?? appId) === appId && numericId(description.classid) && /^\d{1,20}$/.test(String(description.instanceid))) descriptions.set(`${description.classid}_${description.instanceid}`, description);
      }
    } else {
      for (const [key, description] of Object.entries(body.rgDescriptions || {})) descriptions.set(key, description);
    }
    const assets = modern ? (body.assets || []).map(asset => [String(asset.assetid), asset]) : Object.entries(body.rgInventory || {});
    for (const [key, asset] of assets) {
      if (!asset || !numericId(key) || String(asset.assetid ?? asset.id ?? key) !== key) continue;
      if (asset.appid != null && String(asset.appid) !== appId) continue;
      if (asset.contextid != null && String(asset.contextid) !== contextId) continue;
      const description = descriptions.get(`${asset.classid}_${asset.instanceid}`);
      const value = { ...asset, ownerSteamId: owner, appId, contextId, assetId: key, description: description || asset };
      const gemInfo = globalThis.SIHLiteGems?.analyzeSteamAsset(value);
      if (gemInfo?.hasGems) value.hasGems = true;
      if (gemInfo?.hasColoredGem) value.hasColoredGem = true;
      const item = normalizeItem(value, owner);
      if (item?.classId && item.instanceId != null) cache.items.set(key, item);
      if (cache.items.size > 100000) throw new Error('Steam inventory description limit exceeded.');
    }
    const more = Boolean(modern ? body.more_items : body.more);
    const cursor = more ? numericId(modern ? body.last_assetid : body.more_start) : null;
    if (more && (!cursor || cursor === cache.cursor)) throw new Error('Steam returned an invalid inventory page.');
    cache.cursor = cursor;
    cache.complete = !more;
  }

  async function describeAssets(html, details, assets, owner, fetchImpl, signal) {
    const grouped = new Map();
    for (const item of assets) {
      if (item.isCurrency || item.appId !== '570' || (item.classId && item.instanceId != null)) continue;
      const key = `${owner}:${item.appId}:${item.contextId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    for (const [key, wanted] of grouped) {
      const { appId, contextId } = wanted[0];
      let cache = classInventories.get(key);
      if (!cache) { cache = { items: new Map(), complete: false, cursor: null, pages: 0, pending: null }; classInventories.set(key, cache); }
      const missing = () => wanted.some(item => !cache.items.has(item.assetId));
      if (cache.pending) await cache.pending;
      if (missing() && !cache.complete) {
        const endpoint = inventoryEndpoint(html, details, owner, appId, contextId);
        cache.pending = (async () => {
          while (missing() && !cache.complete) {
            if (++cache.pages > 100) throw new Error('Steam inventory description page limit exceeded.');
            const url = new URL(endpoint.url);
            if (cache.cursor) url.searchParams.set(endpoint.modern ? 'start_assetid' : 'start', cache.cursor);
            const response = await fetchImpl(url.href, { credentials: 'include', signal });
            if (!response.ok) throw new Error(`Steam inventory descriptions returned HTTP ${response.status}.`);
            mergeInventoryPage(cache, await response.json(), owner, appId, contextId, endpoint.modern);
          }
        })();
        try { await cache.pending; } finally { cache.pending = null; }
      }
      for (const item of wanted) {
        const description = cache.items.get(item.assetId);
        if (description) Object.assign(item, description, { amount: item.amount });
      }
      if (missing()) throw new Error('Some trade item descriptions are unavailable. Exact trade totals can still be shown.');
    }
  }

  function parseDetails(html, expectedOfferId, expectedOwner) {
    const offerId = numericId(expectedOfferId);
    const meSteamId = steamId(expectedOwner);
    if (!offerId || !meSteamId || typeof html !== 'string' || html.length > 8_000_000) throw new Error('Invalid trade offer details.');
    // Require the same authenticated owner and the requested native offer ID.
    const pageOwner = scalarId(html, 'g_steamID') || scalarId(html, 'g_ulSteamID');
    const begin = html.match(/\bBeginTradeOffer\s*\(\s*['"]?(\d+)['"]?\s*[,)]/);
    const partnerSteamId = scalarId(html, 'g_ulTradePartnerSteamID');
    const status = readAssignment(html, 'g_rgCurrentTradeStatus');
    if (pageOwner !== meSteamId || begin?.[1] !== offerId || !partnerSteamId || partnerSteamId === meSteamId || !status || !Array.isArray(status.me?.assets) || !Array.isArray(status.them?.assets)) throw new Error('Steam did not return this trade offer for the signed-in account.');
    const normalize = (assets, owner) => assets.map(value => {
      const item = normalizeItem(value, owner);
      if (!item?.assetId || !item.contextId) throw new Error('Steam returned incomplete trade items.');
      return item;
    });
    const currencies = (values, owner) => (Array.isArray(values) ? values : []).map(value => {
      const item = normalizeItem({ ...value, isCurrency: true }, owner);
      if (!item?.contextId) throw new Error('Steam returned incomplete trade currencies.');
      return item;
    });
    return { offerId, meSteamId, partnerSteamId,
      give: [...normalize(status.me.assets, meSteamId), ...currencies(status.me.currency, meSteamId)],
      receive: [...normalize(status.them.assets, partnerSteamId), ...currencies(status.them.currency, partnerSteamId)] };
  }

  async function fetchDetails(offerId, meSteamId, fetchImpl = globalThis.fetch) {
    if (!numericId(offerId) || !steamId(meSteamId)) throw new Error('Invalid trade offer.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetchImpl(`https://steamcommunity.com/tradeoffer/${offerId}/`, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`Steam returned HTTP ${response.status} for this trade offer.`);
      const html = await response.text();
      const details = parseDetails(html, String(offerId), String(meSteamId));
      const descriptions = await Promise.allSettled([
        describeAssets(html, details, details.give, details.meSteamId, fetchImpl, controller.signal),
        describeAssets(html, details, details.receive, details.partnerSteamId, fetchImpl, controller.signal)
      ]);
      const failures = descriptions.filter(result => result.status === 'rejected');
      if (failures.length) details.classError = 'Some item prices are unavailable because Steam could not load their descriptions.';
      return details;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Loading trade offer details timed out.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  const api = { read, applyDetails, fetchDetails, parseDetails, parseEconomyKey, normalizeItem, steamId, accountSteamId };
  globalThis.SIHLiteTradeOffers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
