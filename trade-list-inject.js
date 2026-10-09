/* Native offer-list metadata bridge. Session credentials stay in Steam. */
(() => {
  'use strict';
  const Offers = globalThis.SIHLiteTradeOffers;
  if (!Offers || location.origin !== 'https://steamcommunity.com' || !/^\/(?:profiles\/\d+|id\/[^/]+)\/tradeoffers(?:\/.*)?$/.test(location.pathname)) return;
  let lastSnapshot = '';
  let scheduled = false;

  function currentOwner() {
    return Offers.steamId(globalThis.g_steamID) || Offers.steamId(globalThis.g_ulSteamID);
  }

  function nativeItem(slot) {
    const direct = slot.element.rgItem || slot.element.rgEconomyItem;
    if (direct && typeof direct === 'object') return direct;
    const item = slot.item;
    if (item.assetId && item.contextId) {
      const asset = globalThis.g_rgAssets?.[item.appId]?.[item.contextId]?.[item.assetId];
      if (asset && typeof asset === 'object') return asset;
    }
    // Class descriptions provide canonical names, never real asset IDs.
    if (item.classId) {
      const descriptions = globalThis.g_rgDescriptions;
      const key = `${item.classId}_${item.instanceId || '0'}`;
      const description = descriptions?.[item.appId]?.[key] || descriptions?.[`${item.appId}_${key}`] || descriptions?.[key];
      if (description && typeof description === 'object') return { description };
    }
    return null;
  }

  function metadataItem(slot) {
    const value = nativeItem(slot);
    const result = { ...slot.item };
    if (!value) return result;
    const description = value.description && typeof value.description === 'object' ? value.description : value;
    const owner = value.ownerSteamId ?? value.owner;
    if (owner && String(owner) !== result.ownerSteamId) return result;
    const classId = value.classid ?? description.classid;
    const instanceId = value.instanceid ?? description.instanceid;
    if (result.classId && classId != null && String(classId) !== result.classId) return result;
    if (result.instanceId != null && instanceId != null && String(instanceId) !== result.instanceId) return result;
    const canonical = description.market_hash_name ?? description.marketHashName;
    if (typeof canonical === 'string' && canonical.length <= 512) result.market_hash_name = canonical;
    const nativeAssetId = String(value.assetid ?? '');
    // A class hover cannot establish ownership or an asset's identity.
    if (result.assetId && nativeAssetId && nativeAssetId !== result.assetId) return slot.item;
    const info = globalThis.SIHLiteGems?.analyzeSteamAsset(value);
    if (info?.hasGems) result.hasGems = true;
    if (info?.hasColoredGem) result.hasColoredGem = true;
    return result;
  }

  function emit(force = false) {
    scheduled = false;
    const meSteamId = currentOwner();
    if (!meSteamId) return;
    const offers = Offers.read(document, { meSteamId }).map(offer => {
      const slots = offer.slots.map(slot => {
        const item = metadataItem(slot);
        if (slot.element.getAttribute('data-sih-trade-key') !== slot.key) slot.element.setAttribute('data-sih-trade-key', slot.key);
        return { key: slot.key, item, side: slot.side };
      });
      return { offerId: offer.offerId, partnerSteamId: offer.partnerSteamId, incoming: offer.incoming, active: offer.active,
        canAccept: offer.canAccept, give: slots.filter(slot => slot.side === 'give').map(slot => slot.item),
        receive: slots.filter(slot => slot.side === 'receive').map(slot => slot.item), slots };
    });
    const snapshot = { source: 'SIH_LITE_TRADE_PAGE', type: 'OFFERS', meSteamId, offers };
    const serialized = JSON.stringify(snapshot);
    if (!force && serialized === lastSnapshot) return;
    lastSnapshot = serialized;
    window.postMessage(snapshot, location.origin);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => emit());
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'SIH_LITE_TRADE_CONTENT') return;
    if (event.data.type === 'STATE_REQUEST') emit(true);
  });
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  setInterval(schedule, 1000);
  schedule();
})();
