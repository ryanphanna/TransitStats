import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = { currentUser: null, listener: null };

vi.mock('../js/firebase.js', () => ({
    auth: {
        get currentUser() { return authState.currentUser; },
        onAuthStateChanged(cb) { authState.listener = cb; return () => {}; },
    },
    authPersistenceReady: Promise.resolve(),
    authPersistenceStatus: 'ok',
    firestorePersistenceStatus: 'ok',
    db: {},
}));

import { Auth } from '../js/auth.js';
import { requireAuth } from '../js/shared/auth-guard.js';

const user = { uid: 'user_1', email: 'a@example.com' };

function lastBreadcrumb() {
    return JSON.parse(localStorage.getItem('transitstats_auth_breadcrumb') || 'null');
}

describe('requireAuth whitelist retries', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        authState.currentUser = user;
        authState.listener = null;
        global.fetch = vi.fn(async () => ({ status: 401, json: async () => ({}) }));
        vi.spyOn(Auth, 'signOut').mockResolvedValue();
        vi.spyOn(Auth, 'syncSharedSession').mockResolvedValue(true);
        vi.spyOn(Auth, 'startSharedSessionKeepAlive').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function start() {
        const settled = vi.fn();
        requireAuth().then(settled);
        await vi.advanceTimersByTimeAsync(0);
        authState.listener(user);
        return settled;
    }

    it('stops retrying after the cap, leaves the spinner and does not sign out', async () => {
        const check = vi.spyOn(Auth, 'checkWhitelist').mockResolvedValue({ allowed: false, retryable: true, error: 'Verification failed. Try again.' });
        const settled = await start();

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        const callsAtCap = check.mock.calls.length;
        expect(lastBreadcrumb()).toMatchObject({ reason: 'verification-unavailable' });
        expect(document.body.hasAttribute('data-auth-restoring')).toBe(false);
        expect(Auth.signOut).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();

        // The loop is really over: no further whitelist reads.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(check.mock.calls.length).toBe(callsAtCap);
    });

    it('does not wait for the shared-session cookie sync before resolving', async () => {
        vi.spyOn(Auth, 'checkWhitelist').mockResolvedValue({ allowed: true, isAdmin: false, pilot: null });
        Auth.syncSharedSession.mockReturnValue(new Promise(() => {}));
        const settled = await start();

        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toHaveBeenCalledWith({ user, isAdmin: false, pilot: null });
        expect(Auth.syncSharedSession).toHaveBeenCalledWith(user);
    });

    it('recovers without signing out when the whitelist comes back mid-outage', async () => {
        vi.spyOn(Auth, 'checkWhitelist')
            .mockResolvedValueOnce({ allowed: false, retryable: true })
            .mockResolvedValueOnce({ allowed: false, retryable: true })
            .mockResolvedValueOnce({ allowed: false, retryable: true })
            .mockResolvedValue({ allowed: true, isAdmin: false, pilot: null });
        const settled = await start();

        await vi.advanceTimersByTimeAsync(30 * 1000);

        expect(settled).toHaveBeenCalledWith({ user, isAdmin: false, pilot: null });
        expect(Auth.signOut).not.toHaveBeenCalled();
        expect(Auth.startSharedSessionKeepAlive).toHaveBeenCalledWith(user);
    });
});

describe('requireAuth signed-out redirect', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('sends a signed-out visitor to login and remembers the page', async () => {
        vi.useFakeTimers();
        localStorage.clear();
        authState.currentUser = null;
        global.fetch = vi.fn(async () => ({ status: 401, json: async () => ({}) }));
        vi.spyOn(Auth, 'restoreSharedSession').mockImplementation(async () => {
            Auth.lastRestoreFoundNoSession = true;
            return null;
        });
        const location = { pathname: '/wrapped', href: 'http://localhost/wrapped' };
        vi.stubGlobal('location', location);
        const originalWindowLocation = window.location;
        Object.defineProperty(window, 'location', { value: location, configurable: true, writable: true });

        const settled = vi.fn();
        requireAuth({ returnToPage: true }).then(settled);
        await vi.advanceTimersByTimeAsync(0);
        authState.listener(null);
        await vi.advanceTimersByTimeAsync(2000);

        // Never signed in: redirects right away, not after the 60s grace period.
        expect(location.href).toBe('/?next=%2Fwrapped');
        expect(settled).not.toHaveBeenCalled();
        Object.defineProperty(window, 'location', { value: originalWindowLocation, configurable: true, writable: true });
    });
});

describe('requireAuth grace period only when a session may exist', () => {
    let location;
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        authState.currentUser = null;
        location = { pathname: '/dashboard', href: 'http://localhost/dashboard' };
        Object.defineProperty(window, 'location', { value: location, configurable: true, writable: true });
        vi.spyOn(Auth, 'restoreSharedSession').mockImplementation(async () => {
            Auth.lastRestoreFoundNoSession = restoreOutcome === 'none';
            return null;
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    let restoreOutcome = 'none';

    async function run() {
        global.fetch = vi.fn(async () => ({ status: 401, json: async () => ({}) }));
        requireAuth();
        await vi.advanceTimersByTimeAsync(0);
        authState.listener(null);
    }

    it('keeps waiting when a Firebase user is persisted', async () => {
        restoreOutcome = 'none';
        localStorage.setItem('firebase:authUser:key:[DEFAULT]', '{}');
        await run();
        await vi.advanceTimersByTimeAsync(30 * 1000);
        expect(location.href).toBe('http://localhost/dashboard');
        await vi.advanceTimersByTimeAsync(40 * 1000);
        expect(location.href).toBe('/');
    });

    it('keeps waiting when the cookie check fails transiently', async () => {
        restoreOutcome = 'error';
        await run();
        await vi.advanceTimersByTimeAsync(30 * 1000);
        expect(location.href).toBe('http://localhost/dashboard');
        await vi.advanceTimersByTimeAsync(40 * 1000);
        expect(location.href).toBe('/');
    });

    it('redirects immediately when nothing is persisted and the cookie check finds no session', async () => {
        restoreOutcome = 'none';
        await run();
        await vi.advanceTimersByTimeAsync(2000);
        expect(location.href).toBe('/');
    });
});
