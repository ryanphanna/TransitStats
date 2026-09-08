// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, restoreSharedSession } = vi.hoisted(() => ({
    auth: { currentUser: null },
    restoreSharedSession: vi.fn(),
}));

vi.mock('../js/firebase.js', () => ({
    auth,
    authPersistenceReady: Promise.resolve(),
    authPersistenceStatus: { ok: true, error: null },
    firestorePersistenceStatus: { ok: true, error: null },
}));

vi.mock('../js/auth.js', () => ({
    Auth: {
        restoreSharedSession,
    },
}));

import { getRestorePolicy, waitForRestoredUser } from '../js/shared/auth-guard.js';

describe('auth restore guard', () => {
    beforeEach(() => {
        vi.useRealTimers();
        auth.currentUser = null;
        restoreSharedSession.mockReset();
        restoreSharedSession.mockResolvedValue(null);
    });

    it('uses the short policy only when Firebase has no initial user', () => {
        expect(getRestorePolicy(null)).toEqual({ graceMs: 3000, retryDelays: [] });
        expect(getRestorePolicy({ uid: 'signed-in-user' })).toEqual({
            graceMs: 60000,
            retryDelays: [1500, 3000, 7500, 15000, 30000],
        });
    });

    it('returns an existing Firebase user immediately', async () => {
        const user = { uid: 'signed-in-user' };
        await expect(waitForRestoredUser(user)).resolves.toBe(user);
        expect(restoreSharedSession).not.toHaveBeenCalled();
    });

    it('makes one short shared-session attempt for an initial signed-out state', async () => {
        vi.useFakeTimers();
        const restoring = waitForRestoredUser(null, 3000, []);

        await vi.advanceTimersByTimeAsync(750);
        expect(restoreSharedSession).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2250);

        await expect(restoring).resolves.toBeNull();
        expect(restoreSharedSession).toHaveBeenCalledTimes(1);
    });

    it('can recover a shared session during the short fallback', async () => {
        const user = { uid: 'shared-user' };
        restoreSharedSession.mockResolvedValueOnce(user);

        vi.useFakeTimers();
        const restoring = waitForRestoredUser(null, 3000, []);
        await vi.advanceTimersByTimeAsync(750);

        await expect(restoring).resolves.toBe(user);
    });
});
