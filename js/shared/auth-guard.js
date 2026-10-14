import { auth, authPersistenceReady, authPersistenceStatus, firestorePersistenceStatus } from '../firebase.js';
import { Auth } from '../auth.js';
import { loginUrlFor } from './return-path.js';

// Mobile browsers can suspend a tab while Firebase is restoring IndexedDB,
// and the shared-session request can then take longer than a normal page load.
// Keep the page in its restoring state long enough to recover before treating
// the missing initial user as a real sign-out.
const AUTH_RESTORE_GRACE_MS = 60000;
const AUTH_SHARED_SESSION_DELAY_MS = 750;
const AUTH_SHARED_SESSION_RETRY_DELAYS_MS = [1500, 3000, 7500, 15000, 30000];
const AUTH_RESTORE_POLL_MS = 250;
// Cap on how long a Firestore outage can hold the page on the restoring
// spinner before falling back to the normal signed-out path.
const AUTH_VERIFY_RETRY_MAX_MS = 60000;
const AUTH_VERIFY_RETRY_DELAY_MS = 3000;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const AUTH_BREADCRUMB_KEY = 'transitstats_auth_breadcrumb';

// Console output from the tab that hit this doesn't survive the redirect that
// follows, so a session-loss incident leaves no evidence to diagnose it from.
// This writes one JSON breadcrumb to localStorage (which does survive) right
// before each redirect/signout branch, so the next occurrence can be read
// back later instead of requiring a live repro.
async function recordAuthBreadcrumb(reason, extra = {}) {
    let sharedSessionStatus = 'unknown';
    let sharedSessionError = null;
    try {
        const response = await fetch(Auth.sharedSessionUrl, { credentials: 'include' });
        sharedSessionStatus = response.status;
        // The endpoint returns 401 for two different reasons (cookie never
        // sent vs. cookie present but invalid) — without the body, both look
        // identical here and point at different bugs.
        try {
            const body = await response.json();
            sharedSessionError = body?.error || null;
        } catch {
            // No JSON body (e.g. a 204) — nothing to capture.
        }
    } catch (error) {
        sharedSessionStatus = `fetch-failed: ${error.message}`;
    }
    try {
        localStorage.setItem(AUTH_BREADCRUMB_KEY, JSON.stringify({
            reason,
            timestamp: new Date().toISOString(),
            path: window.location.pathname,
            hasCurrentUser: Boolean(auth.currentUser),
            sharedSessionStatus,
            sharedSessionError,
            lastSharedSessionSync: Auth.getLastSharedSessionSync?.() || null,
            authPersistence: authPersistenceStatus,
            firestorePersistence: firestorePersistenceStatus,
            ...extra,
        }));
    } catch (error) {
        console.warn('[auth-guard] Could not record auth breadcrumb:', error.message);
    }
}

async function verifyWithRetry(user) {
    let verification;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        verification = await Auth.checkWhitelist(user.email, user.uid);
        if (verification.allowed || !verification.retryable) return verification;
        await wait(500 * (attempt + 1));
    }
    return verification;
}

// Firebase keeps a signed-in user in localStorage or IndexedDB. Returns false
// only when we can positively see there is none (or storage doesn't exist at
// all); any error or uncertainty returns true so the grace period still applies.
export async function hasPersistedFirebaseUser() {
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            if (localStorage.key(i)?.startsWith('firebase:authUser:')) return true;
        }
    } catch {
        return true;
    }
    if (typeof indexedDB === 'undefined') return false;
    try {
        return await new Promise((resolve) => {
            const request = indexedDB.open('firebaseLocalStorageDb');
            request.onupgradeneeded = () => {
                // Database didn't exist: nothing was ever persisted. Don't leave an empty one behind.
                request.transaction.abort();
                resolve(false);
            };
            request.onerror = () => resolve(request.error?.name === 'AbortError' ? false : true);
            request.onblocked = () => resolve(true);
            request.onsuccess = () => {
                const db = request.result;
                try {
                    if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                        db.close();
                        resolve(false);
                        return;
                    }
                    const keysRequest = db.transaction('firebaseLocalStorage', 'readonly')
                        .objectStore('firebaseLocalStorage').getAllKeys();
                    keysRequest.onsuccess = () => {
                        db.close();
                        resolve(keysRequest.result.some(key => String(key).startsWith('firebase:authUser:')));
                    };
                    keysRequest.onerror = () => { db.close(); resolve(true); };
                } catch {
                    db.close();
                    resolve(true);
                }
            };
        });
    } catch {
        return true;
    }
}

async function waitForRestoredUser(initialUser) {
    if (initialUser) return initialUser;

    // Never signed in on this browser: nothing persisted and the shared cookie
    // check says there is no session. Skip the grace period and redirect now.
    // Anything uncertain (stored user, network error, 5xx) keeps the full wait.
    if (!(await hasPersistedFirebaseUser())) {
        if (auth.currentUser) return auth.currentUser;
        const sharedUser = await Auth.restoreSharedSession();
        if (sharedUser) return sharedUser;
        if (auth.currentUser) return auth.currentUser;
        if (Auth.lastRestoreFoundNoSession) return null;
    }

    const startedAt = Date.now();
    const deadline = startedAt + AUTH_RESTORE_GRACE_MS;
    let sharedSessionAttempts = 0;
    let nextSharedSessionAttemptAt = startedAt + AUTH_SHARED_SESSION_DELAY_MS;

    while (Date.now() < deadline) {
        if (auth.currentUser) return auth.currentUser;

        // The shared cookie is a fallback for pages opened on another
        // TransitStats surface. Retry it if token refresh or the first request
        // is temporarily slow, rather than treating that transient failure as
        // a real sign-out.
        if (sharedSessionAttempts < 1 + AUTH_SHARED_SESSION_RETRY_DELAYS_MS.length
            && Date.now() >= nextSharedSessionAttemptAt) {
            sharedSessionAttempts += 1;
            const sharedUser = await Auth.restoreSharedSession();
            if (sharedUser) return sharedUser;
            const retryDelay = AUTH_SHARED_SESSION_RETRY_DELAYS_MS[sharedSessionAttempts - 1];
            nextSharedSessionAttemptAt = Date.now() + (retryDelay || AUTH_RESTORE_POLL_MS);
        }

        await wait(AUTH_RESTORE_POLL_MS);
    }

    return auth.currentUser || null;
}

function setAuthRestoring(isRestoring) {
    document.body?.toggleAttribute('data-auth-restoring', isRestoring);
    if (!isRestoring) document.body?.classList.remove('dashboard-auth-pending');
}

// Apply theme immediately to prevent flash of unstyled content
if (window.TransitTheme) window.TransitTheme.apply();
else document.body.classList.remove('dark');

/**
 * Resolves when auth is confirmed. Redirects to / if not authed or not whitelisted.
 * @param {object} options
 * @param {boolean} options.returnToPage — send the visitor back to this page after sign-in
 * @param {boolean} options.adminOnly — redirect to /dashboard if user is not admin
 */
export function requireAuth(options = {}) {
    let checking = false;
    let resolved = false;
    return new Promise((resolve) => {
        const listen = () => auth.onAuthStateChanged(async (user) => {
            if (checking || resolved) return;
            checking = true;
            const loginUrl = options.returnToPage ? loginUrlFor(window.location.pathname) : '/';
            // A Vite live reload can recreate the page before Firebase has
            // finished hydrating its LOCAL session. Give that restoration a
            // short grace period instead of treating the transient null as a
            // real sign-out.
            if (!user) setAuthRestoring(true);
            let sessionUser = await waitForRestoredUser(user);
            if (!sessionUser) {
                console.warn('[auth-guard] Redirecting without a restored session.', {
                    path: window.location.pathname,
                    initialUser: Boolean(user),
                    currentUser: Boolean(auth.currentUser),
                });
                await recordAuthBreadcrumb('no-restored-session', { initialUser: Boolean(user) });
                window.location.href = loginUrl;
                return;
            }
            let verification = await verifyWithRetry(sessionUser);
            // A temporary Firestore outage must not become a fake logout. Keep
            // the Firebase session (and the shared cookie) and retry until the
            // whitelist can be read again — never signOut on retryable flakes.
            const verifyRetryDeadline = Date.now() + AUTH_VERIFY_RETRY_MAX_MS;
            while (verification.retryable && Date.now() < verifyRetryDeadline) {
                console.warn('Auth verification is temporarily unavailable; keeping the Firebase session.');
                setAuthRestoring(true);
                await wait(AUTH_VERIFY_RETRY_DELAY_MS);
                sessionUser = auth.currentUser || await waitForRestoredUser(auth.currentUser);
                if (!sessionUser) {
                    await recordAuthBreadcrumb('no-restored-session', {
                        duringWhitelistRetry: true,
                        initialUser: Boolean(user),
                    });
                    window.location.href = loginUrl;
                    return;
                }
                verification = await verifyWithRetry(sessionUser);
            }
            if (verification.retryable) {
                // Still unreadable after the cap: stop the spinner and send the
                // user to login without signing out, so the session survives.
                console.warn('[auth-guard] Verification still unavailable; redirecting to login.');
                await recordAuthBreadcrumb('verification-unavailable', { verificationError: verification.error || null });
                setAuthRestoring(false);
                window.location.href = loginUrl;
                return;
            }
            if (!verification.allowed) {
                console.warn('[auth-guard] Whitelist rejected the session.', {
                    path: window.location.pathname,
                    reason: verification.error,
                });
                await recordAuthBreadcrumb('whitelist-rejected', { verificationError: verification.error || null });
                await Auth.signOut();
                window.location.href = loginUrl;
                return;
            }
            setAuthRestoring(false);
            if (options.adminOnly && !verification.isAdmin) {
                window.location.href = '/dashboard';
                return;
            }
            await Auth.syncSharedSession(sessionUser);
            Auth.startSharedSessionKeepAlive(sessionUser);
            window.currentUser = sessionUser;
            window.isAdmin = verification.isAdmin;
            window.userPilot = verification.pilot || null;
            resolved = true;
            resolve({ user: sessionUser, isAdmin: verification.isAdmin, pilot: verification.pilot || null });
        });

        // Firebase can emit its initial null state before LOCAL persistence
        // has finished hydrating after a full-page navigation. Wait for that
        // initialization before treating null as a real signed-out state.
        Promise.resolve(authPersistenceReady)
            .then(() => typeof auth.authStateReady === 'function'
                ? auth.authStateReady()
                : null)
            .catch(error => console.warn('Firebase auth hydration failed:', error.message))
            .finally(listen);
    });
}
