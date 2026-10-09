const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'trade-accept.js'), 'utf8');
const OFFER = '12345678901';
const PARTNER = '76561198012345678';
// This value is a synthetic fixture, never an actual Steam session.
const SESSION = '0123456789abcdef01234567';
const details = extra => ({ offerId: OFFER, partnerSteamId: PARTNER, sessionId: SESSION, ...extra });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function setup(fetchImpl, options = {}) {
    const calls = [];
    const sandbox = {
        location: options.origin === null ? undefined : { origin: options.origin || 'https://steamcommunity.com' },
        AbortController,
        URLSearchParams,
        setTimeout: (callback, ms) => setTimeout(callback, options.immediateTimeout ? 0 : ms),
        clearTimeout,
        module: { exports: {} },
        fetch: async (url, init) => {
            calls.push({ url, init });
            return fetchImpl(url, init, calls.length);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: 'trade-accept.js' });
    assert.equal(sandbox.SIHLiteTradeAccept, sandbox.module.exports);
    return { api: sandbox.SIHLiteTradeAccept, calls };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('sends the official acceptance form on the fixed Steam endpoint without navigating', async () => {
    const env = setup(async () => response({ tradeid: '98765432101234567' }));
    const result = await env.api.accept(details());
    assert.equal(result.state, 'accepted');
    assert.equal(result.tradeId, '98765432101234567');
    assert.equal(env.calls.length, 1);
    const { url, init } = env.calls[0];
    assert.equal(url, `https://steamcommunity.com/tradeoffer/${OFFER}/accept`);
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrer, `https://steamcommunity.com/tradeoffer/${OFFER}/`);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
        sessionid: SESSION, serverid: '1', tradeofferid: OFFER, partner: PARTNER, captcha: ''
    });
    assert.equal(init.signal.aborted, false);
    assert.equal(Object.isFrozen(result), true);
});

for (const [data, state] of [
    [{ needs_mobile_confirmation: true }, 'mobile_confirmation'],
    [{ needs_email_confirmation: true }, 'email_confirmation'],
    [{ needs_mobile_confirmation: true, needs_email_confirmation: true }, 'mobile_confirmation'],
    [{ needs_mobile_confirmation: 1, needs_email_confirmation: 0 }, 'mobile_confirmation'],
    [{ needs_mobile_confirmation: false, needs_email_confirmation: true }, 'email_confirmation'],
    [{ needs_mobile_confirmation: false, needs_email_confirmation: false }, 'accepted'],
    [{ tradeid: 0, needs_mobile_confirmation: true }, 'mobile_confirmation'],
    [{ tradeid: '0', needs_email_confirmation: true }, 'email_confirmation'],
    [{ tradeid: '0', success: true }, 'accepted'],
    [{ success: true }, 'accepted'],
    [{ success: 1 }, 'accepted']
]) {
    test(`interprets ${JSON.stringify(data)} as ${state}`, async () => {
        const env = setup(async () => response(data));
        const result = await env.api.accept(details());
        assert.equal(result.state, state);
        assert.equal(result.tradeId, undefined);
        assert.equal(env.calls.length, 1);
    });
}

test('confirmation responses preserve an optional trade ID without claiming full acceptance', async () => {
    const env = setup(async () => response({ tradeid: 123456, needs_mobile_confirmation: true }));
    const result = await env.api.accept(details());
    assert.equal(result.state, 'mobile_confirmation');
    assert.equal(result.tradeId, '123456');
});

test('rejects invalid IDs or authentication details before any network request', async () => {
    const env = setup(async () => { throw new Error('must not fetch'); });
    const invalid = [
        undefined,
        null,
        details({ offerId: '../another/accept' }),
        details({ offerId: 123456 }),
        details({ offerId: '0' }),
        details({ offerId: '012345' }),
        details({ offerId: '18446744073709551616' }),
        details({ partnerSteamId: '1234' }),
        details({ partnerSteamId: 76561198012345678 }),
        details({ partnerSteamId: '7656119801234567x' }),
        details({ sessionId: undefined }),
        details({ sessionId: '' }),
        details({ sessionId: 'contains a space' }),
        details({ sessionId: 'x\r\nCookie: value' }),
        details({ sessionId: 'x'.repeat(257) }),
        details({ fetchImpl: null })
    ];
    for (const value of invalid) await assert.rejects(env.api.accept(value), { name: 'Error' });
    assert.equal(env.calls.length, 0);
});

test('caller-supplied origin or guard flags cannot bypass the real page origin', async () => {
    for (const origin of [null, 'http://steamcommunity.com', 'https://www.steamcommunity.com',
        'https://steamcommunity.com.example.com', 'https://example.com']) {
        let customCalls = 0;
        const env = setup(async () => { throw new Error('must not fetch'); }, { origin });
        await assert.rejects(env.api.accept(details({
            origin: 'https://steamcommunity.com', allowUnsafeOrigin: true, requireSteamOrigin: false,
            fetchImpl: async () => { customCalls++; return response({ success: true }); }
        })), /HTTPS Steam Community/);
        assert.equal(customCalls, 0);
        assert.equal(env.calls.length, 0);
    }
});

test('provided mock transport uses the same guarded fixed URL and form', async () => {
    const env = setup(async () => { throw new Error('must use provided transport'); });
    const calls = [];
    const result = await env.api.accept(details({ fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response({ tradeid: '12345' });
    } }));
    assert.equal(result.state, 'accepted');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://steamcommunity.com/tradeoffer/${OFFER}/accept`);
    assert.equal(new URLSearchParams(calls[0].init.body).get('partner'), PARTNER);
    assert.equal(env.calls.length, 0);
});

test('HTTP failures surface Steam errors or the actual HTTP status', async () => {
    for (const status of [401, 403, 429, 500]) {
        const env = setup(async () => response({ strError: 'This offer is no longer active.' }, status));
        await assert.rejects(env.api.accept(details()), error => {
            assert.match(error.message, /no longer active/);
            assert.equal(error.code, undefined, 'known Steam rejection permits an explicit retry');
            return true;
        });
        assert.equal(env.calls.length, 1);
    }
    const generic = setup(async () => response({}, 503));
    await assert.rejects(generic.api.accept(details()), /HTTP 503/);
    const htmlLogin = setup(async () => ({ ok: false, status: 401, json: async () => { throw new Error('HTML login page'); } }));
    await assert.rejects(htmlLogin.api.accept(details()), /HTTP 401/);
});

test('Steam error bodies are not mistaken for successful acceptance, even over HTTP 200', async () => {
    for (const data of [
        { strError: '<b>This offer expired.</b>', tradeid: '12345' },
        { success: false, tradeid: '12345' },
        { success: 0, needs_mobile_confirmation: true }
    ]) {
        const env = setup(async () => response(data));
        await assert.rejects(env.api.accept(details()), /offer expired|did not accept/);
    }
});

test('error messages never return an authentication value echoed by the server', async () => {
    const env = setup(async () => response({ strError: `Session ${SESSION} is no longer valid.` }, 403));
    await assert.rejects(env.api.accept(details()), error => {
        assert.equal(error.message.includes(SESSION), false);
        assert.match(error.message, /\[redacted\]/);
        return true;
    });
});

test('unknown, malformed or ambiguous responses do not claim acceptance', async () => {
    for (const data of [null, [], 'accepted', {}, { unexpected: true },
        { needs_mobile_confirmation: 'false' }, { needs_email_confirmation: null },
        { needs_mobile_confirmation: false }, { needs_email_confirmation: 0 },
        { success: '0', needs_mobile_confirmation: false },
        { success: 2, needs_mobile_confirmation: false, needs_email_confirmation: false },
        { success: null, tradeid: '12345' },
        { strError: 1 }, { strError: {}, tradeid: '12345' }, { strError: 0, tradeid: '12345' },
        { tradeid: '../receipt' }, { tradeid: '0' }, { tradeid: 0 }, { tradeid: Number.MAX_SAFE_INTEGER + 1 }]) {
        const env = setup(async () => response(data));
        await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
        await assert.rejects(env.api.accept(details({ force: true, retry: true, clearCache: true })), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
        assert.equal(env.calls.length, 1);
    }
    const invalidJson = setup(async () => ({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } }));
    await assert.rejects(invalidJson.api.accept(details()), /invalid trade acceptance response/);
});

test('network and login-redirect failures do not retry automatically', async () => {
    const env = setup(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(env.api.accept(details()), error => {
        assert.match(error.message, /Could not contact Steam/);
        assert.equal(error.code, 'STEAM_ACCEPT_STATUS_UNKNOWN');
        return true;
    });
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    assert.equal(env.calls.length, 1);
});

test('duplicate clicks share one in-flight acceptance and completed calls never resubmit', async () => {
    const gate = deferred();
    const env = setup(async () => { await gate.promise; return response({ tradeid: '12345' }); });
    const first = env.api.accept(details());
    const second = env.api.accept(details());
    assert.equal(env.calls.length, 1);
    gate.resolve();
    const results = await Promise.all([first, second]);
    assert.strictEqual(results[0], results[1]);
    assert.equal(results[0].state, 'accepted');
    let duplicateTransportCalls = 0;
    const cached = await env.api.accept(details({ fetchImpl: async () => { duplicateTransportCalls++; return response({ success: true }); } }));
    assert.strictEqual(cached, results[0]);
    assert.equal(duplicateTransportCalls, 0);
    assert.equal(env.calls.length, 1);
});

test('an offer awaiting confirmation is not resubmitted by another click', async () => {
    const env = setup(async () => response({ needs_mobile_confirmation: true }));
    const first = await env.api.accept(details());
    const second = await env.api.accept(details());
    assert.equal(first.state, 'mobile_confirmation');
    assert.strictEqual(second, first);
    assert.equal(env.calls.length, 1);
});

test('duplicate calls cannot change the partner or session and cached calls still validate inputs', async () => {
    const gate = deferred();
    const env = setup(async () => { await gate.promise; return response({ tradeid: '12345' }); });
    const first = env.api.accept(details());
    await assert.rejects(env.api.accept(details({ partnerSteamId: '76561198087654321' })), /partner information/);
    await assert.rejects(env.api.accept(details({ sessionId: 'abcdef0123456789abcdef01' })), /session changed/);
    assert.equal(env.calls.length, 1);
    gate.resolve();
    await first;
    await assert.rejects(env.api.accept(details({ sessionId: '' })), /session is unavailable/);
    await assert.rejects(env.api.accept(details({ partnerSteamId: '76561198087654321' })), /partner information/);
    assert.equal(env.calls.length, 1);
});

test('shared failures clear in-flight work and permit a later explicit user retry', async () => {
    const gate = deferred();
    const env = setup(async (_, __, count) => {
        if (count === 1) { await gate.promise; return response({ strError: 'Steam is unavailable.' }, 503); }
        return response({ tradeid: '12345' });
    });
    const first = env.api.accept(details());
    const second = env.api.accept(details());
    gate.resolve();
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.ok(results.every(result => result.reason.code === undefined));
    assert.equal(env.calls.length, 1);
    const retry = await env.api.accept(details());
    assert.equal(retry.state, 'accepted');
    assert.equal(env.calls.length, 2);
});

test('timeout is bounded even when a transport ignores AbortSignal, with no automatic retry', async () => {
    let signal;
    const env = setup(async (_, init) => { signal = init.signal; return new Promise(() => {}); }, { immediateTimeout: true });
    await assert.rejects(env.api.accept(details()), error => {
        assert.match(error.message, /timed out.*Reload your offers/);
        assert.equal(error.code, 'STEAM_ACCEPT_STATUS_UNKNOWN');
        return true;
    });
    assert.equal(signal.aborted, true);
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    assert.equal(env.calls.length, 1);
});

test('timeout also covers a response body that never finishes', async () => {
    const env = setup(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), { immediateTimeout: true });
    await assert.rejects(env.api.accept(details()), /timed out/);
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    assert.equal(env.calls[0].init.signal.aborted, true);
    assert.equal(env.calls.length, 1);
});

test('malformed HTTP 200 bodies lock acceptance until a page reload rather than resubmitting', async () => {
    const env = setup(async () => ({ ok: true, status: 200, json: async () => { throw new Error('truncated body'); } }));
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    assert.equal(env.calls.length, 1);

    // A reload creates a new isolated helper; the UI must first reread eligibility.
    const reloaded = setup(async () => response({ tradeid: '12345' }));
    assert.equal((await reloaded.api.accept(details())).state, 'accepted');
    assert.equal(reloaded.calls.length, 1);
});

test('late transport completion after timeout cannot clear the uncertain-outcome lock', async () => {
    const gate = deferred();
    const env = setup(async () => { await gate.promise; return response({ tradeid: '12345' }); }, { immediateTimeout: true });
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(env.api.accept(details()), { code: 'STEAM_ACCEPT_STATUS_UNKNOWN' });
    assert.equal(env.calls.length, 1);
});
