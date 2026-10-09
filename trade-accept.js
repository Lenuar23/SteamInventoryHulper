/* Steam's authenticated acceptance request, shared with the trade-list UI. */
(function (root) {
    'use strict';

    const STEAM_ORIGIN = 'https://steamcommunity.com';
    const REQUEST_TIMEOUT_MS = 20000;
    const inFlight = new Map();
    const completed = new Map();
    const uncertainOffers = new Map();

    function validateId(value, label) {
        if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) ||
            BigInt(value) > 18446744073709551615n) {
            throw new Error(`A valid ${label} is required.`);
        }
        return value;
    }

    function unknownOutcomeError(message) {
        const error = new Error(message);
        error.code = 'STEAM_ACCEPT_STATUS_UNKNOWN';
        return error;
    }

    function timeoutError() {
        return unknownOutcomeError('Steam acceptance timed out. Reload your offers to check their status before trying again.');
    }

    function serverError(data, fallback, sessionId) {
        if (typeof data?.strError !== 'string' || !data.strError.trim()) return new Error(fallback);
        // A server error is displayed as text; never return authentication values.
        const text = data.strError.split(sessionId).join('[redacted]')
            .replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
        return new Error(text || fallback);
    }

    function confirmationFlag(data, key) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) return null;
        const value = data[key];
        if (value === true || value === 1) return true;
        if (value === false || value === 0) return false;
        throw unknownOutcomeError('Steam returned an invalid trade confirmation response. Reload your offers to check their status.');
    }

    function readResult(data, sessionId) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw unknownOutcomeError('Steam returned an invalid trade acceptance response. Reload your offers to check their status.');
        }
        const hasSteamError = typeof data.strError === 'string' && data.strError.trim().length > 0;
        if (hasSteamError || data.success === false || data.success === 0) {
            throw serverError(data, 'Steam did not accept this offer. Reload your offers and try again.', sessionId);
        }
        if (data.strError !== undefined && data.strError !== null && typeof data.strError !== 'string') {
            throw unknownOutcomeError('Steam returned an invalid trade acceptance response. Reload your offers to check their status.');
        }
        if (Object.prototype.hasOwnProperty.call(data, 'success') && data.success !== true && data.success !== 1) {
            throw unknownOutcomeError('Steam returned an invalid trade acceptance response. Reload your offers to check their status.');
        }
        const mobile = confirmationFlag(data, 'needs_mobile_confirmation');
        const email = confirmationFlag(data, 'needs_email_confirmation');
        let tradeId;
        if (data.tradeid !== undefined && data.tradeid !== null && data.tradeid !== '' &&
            data.tradeid !== 0 && data.tradeid !== '0') {
            if (typeof data.tradeid === 'number' && Number.isSafeInteger(data.tradeid)) tradeId = String(data.tradeid);
            else tradeId = data.tradeid;
            try { validateId(tradeId, 'trade ID in Steam’s response'); }
            catch (error) {
                throw unknownOutcomeError('Steam returned an invalid trade ID. Reload your offers to check their status.');
            }
        }
        if (mobile) return Object.freeze({ state: 'mobile_confirmation', ...(tradeId ? { tradeId } : {}) });
        if (email) return Object.freeze({ state: 'email_confirmation', ...(tradeId ? { tradeId } : {}) });
        if (!tradeId && data.success !== true && data.success !== 1 && !(mobile === false && email === false)) {
            throw unknownOutcomeError('Steam did not confirm acceptance of this offer. Reload your offers to check its status.');
        }
        return Object.freeze({ state: 'accepted', ...(tradeId ? { tradeId } : {}) });
    }

    async function requestAcceptance(offerId, partnerSteamId, sessionId, fetchImpl) {
        const controller = new AbortController();
        let timedOut = false;
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(timeoutError());
            }, REQUEST_TIMEOUT_MS);
        });
        const request = (async () => {
            let response;
            try {
                response = await fetchImpl(`${STEAM_ORIGIN}/tradeoffer/${offerId}/accept`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    mode: 'same-origin',
                    redirect: 'error',
                    referrer: `${STEAM_ORIGIN}/tradeoffer/${offerId}/`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: new URLSearchParams({
                        sessionid: sessionId, serverid: '1', tradeofferid: offerId,
                        partner: partnerSteamId, captcha: ''
                    }).toString(),
                    signal: controller.signal
                });
            } catch (error) {
                throw unknownOutcomeError('Could not contact Steam. Reload your offers to check their status.');
            }
            if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
                throw unknownOutcomeError('Steam returned an invalid HTTP response. Reload your offers to check their status.');
            }
            let data;
            try { data = await response.json(); }
            catch (error) {
                if (response.ok) {
                    throw unknownOutcomeError('Steam returned an invalid trade acceptance response. Reload your offers to check their status.');
                }
                throw new Error(`Steam could not accept this offer (HTTP ${response.status}). Reload the page and sign in if necessary.`);
            }
            if (!response.ok) {
                throw serverError(data, `Steam could not accept this offer (HTTP ${response.status}). Reload the page and sign in if necessary.`, sessionId);
            }
            return readResult(data, sessionId);
        })();
        try { return await Promise.race([request, timeout]); }
        catch (error) { throw timedOut ? timeoutError() : error; }
        finally { clearTimeout(timer); }
    }

    async function accept(options) {
        // Always check the real page origin; callers cannot turn this guard off.
        if (root.location?.origin !== STEAM_ORIGIN) {
            throw new Error('Trade acceptance is available only on the HTTPS Steam Community page.');
        }
        if (!options || typeof options !== 'object') throw new Error('Trade acceptance details are required.');
        const offerId = validateId(options.offerId, 'trade offer ID');
        const partnerSteamId = validateId(options.partnerSteamId, 'partner SteamID64');
        if (partnerSteamId.length !== 17) throw new Error('A valid partner SteamID64 is required.');
        const sessionId = options.sessionId;
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) {
            throw new Error('The Steam session is unavailable. Reload this page and sign in.');
        }
        const fetchImpl = options.fetchImpl === undefined ? root.fetch?.bind(root) : options.fetchImpl;
        if (typeof fetchImpl !== 'function') throw new Error('The Steam request service is unavailable.');

        if (uncertainOffers.has(offerId)) throw unknownOutcomeError(uncertainOffers.get(offerId));

        const previous = completed.get(offerId) || inFlight.get(offerId);
        if (previous) {
            if (previous.partnerSteamId !== partnerSteamId) {
                throw new Error('The partner information for this offer changed. Reload your offers.');
            }
            if (previous.sessionId !== undefined && previous.sessionId !== sessionId) {
                throw new Error('The Steam session changed while accepting this offer. Reload your offers.');
            }
            return previous.result || previous.promise;
        }

        const promise = requestAcceptance(offerId, partnerSteamId, sessionId, fetchImpl)
            .then(result => {
                completed.set(offerId, { partnerSteamId, result });
                return result;
            })
            .catch(error => {
                if (error.code === 'STEAM_ACCEPT_STATUS_UNKNOWN') uncertainOffers.set(offerId, error.message);
                throw error;
            })
            .finally(() => inFlight.delete(offerId));
        inFlight.set(offerId, { partnerSteamId, sessionId, promise });
        return promise;
    }

    const api = Object.freeze({ accept });
    root.SIHLiteTradeAccept = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
