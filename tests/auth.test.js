import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snapshots = new Map();
const getIdToken = vi.fn(async () => 'fresh-id-token');

vi.mock('../js/firebase.js', () => ({
    auth: {
        get currentUser() {
            return globalThis.__authCurrentUser || null;
        },
    },
    authPersistenceReady: Promise.resolve(),
    db: {
        collection(name) {
            return {
                doc(id) {
                    return {
                        async get() {
                            const hit = snapshots.get(`${name}/${id}`);
                            if (hit instanceof Error) throw hit;
                            return hit || {
                                exists: () => false,
                                data: () => undefined,
                            };
                        },
                    };
                },
            };
        },
    },
}));

import { Auth } from '../js/auth.js';

describe('Auth.checkWhitelist', () => {
    beforeEach(() => snapshots.clear());

    it('allows a phone-authenticated user without a profile', async () => {
        await expect(Auth.checkWhitelist(null, 'missing-profile')).resolves.toEqual({
            allowed: true,
            isAdmin: false,
            pilot: null,
        });
    });

    it('reads admin and pilot flags from an existing phone profile', async () => {
        snapshots.set('profiles/admin-user', {
            exists: () => true,
            data: () => ({ isAdmin: true, pilot: 'presto' }),
        });

        await expect(Auth.checkWhitelist(null, 'admin-user')).resolves.toEqual({
            allowed: true,
            isAdmin: true,
            pilot: 'presto',
        });
    });

    it('denies an email that is not on the whitelist', async () => {
        await expect(Auth.checkWhitelist('not-invited@example.com')).resolves.toEqual({
            allowed: false,
            error: 'Access denied. This app is invite-only.',
        });
    });
});

describe('Auth.checkWhitelist permission-denied', () => {
    it('treats a denied read as not allowed, without retrying', async () => {
        const denied = Object.assign(new Error('denied'), { code: 'permission-denied' });
        snapshots.set('allowedUsers/unverified@example.com', denied);
        const result = await Auth.checkWhitelist('unverified@example.com');
        expect(result).toEqual({ allowed: false, error: 'Access denied. This app is invite-only.' });
        expect(result.retryable).toBeUndefined();
    });

    it('still marks other failures as retryable', async () => {
        snapshots.set('allowedUsers/flaky@example.com', new Error('network'));
        const result = await Auth.checkWhitelist('flaky@example.com');
        expect(result.retryable).toBe(true);
    });
});

describe('Auth.syncSharedSession', () => {
    beforeEach(() => {
        getIdToken.mockClear();
        localStorage.clear();
        globalThis.__authCurrentUser = { uid: 'user_1', getIdToken };
        global.fetch = vi.fn(async () => ({ ok: true, status: 204 }));
    });

    it('always force-refreshes the ID token before minting the cookie', async () => {
        await expect(Auth.syncSharedSession(globalThis.__authCurrentUser)).resolves.toBe(true);
        expect(getIdToken).toHaveBeenCalledWith(true);
        expect(Auth.getLastSharedSessionSync()).toMatchObject({ ok: true, status: 204 });
    });

    it('records a failed sync without throwing', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
        await expect(Auth.syncSharedSession(globalThis.__authCurrentUser)).resolves.toBe(false);
        expect(Auth.getLastSharedSessionSync()).toMatchObject({ ok: false, status: 500 });
    });
});

describe('Auth.startSharedSessionKeepAlive', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
        localStorage.clear();
        globalThis.__authCurrentUser = { uid: 'user_1', getIdToken };
        global.fetch = vi.fn(async () => ({ ok: true, status: 204 }));
        Auth._keepAliveBound = false;
        Auth._lastKeepAliveSyncAt = 0;
    });

    afterEach(() => {
        window.clearInterval(Auth._keepAliveTimer);
        vi.useRealTimers();
    });

    it('coalesces focus and visibilitychange on one tab return into one session call', async () => {
        Auth.startSharedSessionKeepAlive(globalThis.__authCurrentUser);
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('syncs again on a later return and on the 45-minute tick', async () => {
        Auth.startSharedSessionKeepAlive(globalThis.__authCurrentUser);
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(60 * 1000);
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(0);
        expect(global.fetch).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
        expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
});

describe('Auth.restoreSharedSession no-session detection', () => {
    beforeEach(() => { globalThis.__authCurrentUser = null; });

    afterEach(() => {
        vi.unstubAllGlobals();
        globalThis.__authCurrentUser = null;
    });

    it('treats a 200 HTML answer (dev server fallback) as a definite no-session', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })));
        expect(await Auth.restoreSharedSession()).toBeNull();
        expect(Auth.lastRestoreFoundNoSession).toBe(true);
    });

    it('keeps a 5xx as inconclusive so the grace period still applies', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })));
        expect(await Auth.restoreSharedSession()).toBeNull();
        expect(Auth.lastRestoreFoundNoSession).toBe(false);
    });
});
