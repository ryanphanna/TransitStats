import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshots = new Map();

vi.mock('../js/firebase.js', () => ({
    auth: {},
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

    it('does not wait indefinitely for a shared-session response', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        vi.stubGlobal('fetch', fetchMock);

        const restoring = Auth.restoreSharedSession(100);
        await vi.advanceTimersByTimeAsync(100);

        await expect(restoring).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledWith('/auth/session', {
            credentials: 'include',
            signal: expect.any(AbortSignal),
        });

        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
});
