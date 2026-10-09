import { beforeEach, describe, expect, it, vi } from 'vitest';

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
                            return snapshots.get(`${name}/${id}`) || {
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

describe('auth-guard idle-session contract', () => {
    it('keeps retrying whitelist flakes instead of signing out', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const source = readFileSync(resolve(process.cwd(), 'js/shared/auth-guard.js'), 'utf8');
        expect(source).toContain('while (verification.retryable)');
        expect(source).toContain('Auth.startSharedSessionKeepAlive(sessionUser)');
        expect(source).not.toMatch(/while \(verification\.retryable && Date\.now\(\) < verificationDeadline\)/);
    });
});
