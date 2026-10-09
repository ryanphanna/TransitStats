import { auth, authPersistenceReady, db } from './firebase.js';

/**
 * TransitStats V2 Authentication Module
 */
const SHARED_SESSION_SYNC_KEY = 'transitstats_shared_session_sync';
// Re-mint before the Firebase ID token's typical 1h expiry so a suspended
// tab still has a valid shared cookie when IndexedDB comes back empty.
const SHARED_SESSION_REFRESH_MS = 45 * 60 * 1000;

export const Auth = {
    phoneApiUrl: 'https://us-central1-transitstats-21ba4.cloudfunctions.net/api',
    sharedSessionUrl: '/auth/session',
    _restorePromise: null,
    _keepAliveBound: false,
    _keepAliveTimer: null,

    // --- Rate Limiting ---
    getRateLimit() {
        try {
            return JSON.parse(localStorage.getItem('auth_rl') || '{}');
        } catch { return {}; }
    },

    isRateLimited() {
        const { attempts, lockedUntil } = this.getRateLimit();
        if (lockedUntil && Date.now() < lockedUntil) return true;
        if (lockedUntil && Date.now() >= lockedUntil) {
            localStorage.removeItem('auth_rl');
        }
        return false;
    },

    recordFailure() {
        const data = this.getRateLimit();
        const attempts = (data.attempts || 0) + 1;
        const lockedUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null;
        localStorage.setItem('auth_rl', JSON.stringify({ attempts, lockedUntil }));
        return attempts;
    },

    clearRateLimit() {
        localStorage.removeItem('auth_rl');
    },

    // --- Whitelist Check ---
    async checkWhitelist(email, userId = null) {
        try {
            if (email) {
                const doc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
                if (!doc.exists()) return { allowed: false, error: 'Access denied. This app is invite-only.' };
                return { allowed: true, isAdmin: doc.data().isAdmin === true, pilot: doc.data().pilot || null };
            }

            if (!userId) return { allowed: false, error: 'Access denied. This app is invite-only.' };
            // Phone-authenticated users arrive with a Firebase custom token and
            // no email. The phoneNumbers collection is intentionally not
            // readable by regular users, so use the signed-in user's profile
            // for the client-side admin flag instead of querying that mapping.
            const profile = await db.collection('profiles').doc(userId).get();
            return {
                allowed: true,
                isAdmin: profile.exists() && profile.data().isAdmin === true,
                pilot: (profile.exists() && profile.data().pilot) || null,
            };
        } catch (err) {
            console.error('Whitelist check failed, retrying:', err);
            // Retry once before giving up — guards against transient network errors
            // on page load signing out valid users.
            try {
                if (email) {
                    const doc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
                    if (!doc.exists()) return { allowed: false, error: 'Access denied. This app is invite-only.' };
                    return { allowed: true, isAdmin: doc.data().isAdmin === true, pilot: doc.data().pilot || null };
                }

                if (!userId) return { allowed: false, error: 'Access denied. This app is invite-only.' };
                const profile = await db.collection('profiles').doc(userId).get();
                return {
                    allowed: true,
                    isAdmin: profile.exists() && profile.data().isAdmin === true,
                    pilot: (profile.exists() && profile.data().pilot) || null,
                };
            } catch (retryErr) {
                console.error('Whitelist check failed after retry:', retryErr);
                return { allowed: false, retryable: true, error: 'Verification failed. Try again.' };
            }
        }
    },

    // --- Core Methods ---
    async signInWithPassword(email, password) {
        if (this.isRateLimited()) throw new Error('Too many attempts. Try again in 15m.');
        
        try {
            await authPersistenceReady;
            // First check whitelist before even trying to auth? 
            // Better to auth first then check, but for invite-only we can pre-check or post-check.
            // Legacy did it post-auth in onAuthStateChanged. Let's keep that for consistency but
            // wrap the login call.
            const result = await auth.signInWithEmailAndPassword(email.toLowerCase(), password);
            this.clearRateLimit();
            return result;
        } catch (err) {
            this.recordFailure();
            throw err;
        }
    },

    async sendMagicLink(email, redirectPath = '/') {
        const settings = {
            url: window.location.origin + redirectPath,
            handleCodeInApp: true
        };
        await auth.sendSignInLinkToEmail(email.toLowerCase(), settings);
        localStorage.setItem('emailForSignIn', email);
    },

    async completeMagicLinkSignIn() {
        if (auth.isSignInWithEmailLink(window.location.href)) {
            let email = localStorage.getItem('emailForSignIn');
            if (!email) email = window.prompt('Please confirm your email:');
            
            if (email) {
                await auth.signInWithEmailLink(email, window.location.href);
                localStorage.removeItem('emailForSignIn');
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }
    },

    async sendPasswordReset(email) {
        if (!email) throw new Error('Email required');
        await auth.sendPasswordResetEmail(email.toLowerCase());
    },

    // Attaches an email/password credential to the currently signed-in
    // account (used for phone-only accounts, which have no email in Firebase
    // at all). Firebase enforces one account per email address, so once
    // linked, signing in later with that email - by password or by magic
    // link, both use the same underlying 'password' provider - resolves to
    // this same account instead of creating a separate, disconnected one.
    async linkEmail(email, password) {
        await auth.linkEmailPassword(email.toLowerCase(), password);
    },

    async requestPhoneCode(phoneNumber, turnstileToken) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        let response;
        try {
            response = await fetch(this.phoneApiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'request_otp', phoneNumber, turnstileToken }),
                signal: controller.signal,
            });
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('The request took too long. Please try again.');
            throw new Error('Could not reach TransitStats. Please check your connection and try again.');
        } finally {
            window.clearTimeout(timeout);
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not send a verification code.');
        return data;
    },

    async verifyPhoneCode(phoneNumber, code) {
        const response = await fetch(this.phoneApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify_otp', phoneNumber, code })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'That code could not be verified.');
        if (!data.token) throw new Error('Verification succeeded but sign-in could not be completed.');
        await authPersistenceReady;
        await auth.signInWithCustomToken(data.token);
        await this.syncSharedSession(auth.currentUser);
        return data;
    },

    _recordSharedSessionSync(ok, extra = {}) {
        try {
            localStorage.setItem(SHARED_SESSION_SYNC_KEY, JSON.stringify({
                ok: Boolean(ok),
                at: new Date().toISOString(),
                ...extra,
            }));
        } catch {
            // Diagnostics only — never block auth on storage failures.
        }
    },

    getLastSharedSessionSync() {
        try {
            return JSON.parse(localStorage.getItem(SHARED_SESSION_SYNC_KEY) || 'null');
        } catch {
            return null;
        }
    },

    async syncSharedSession(user = auth.currentUser) {
        if (!user) return false;
        let lastError;
        let lastStatus = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                // Always force-refresh: a cached token near expiry can mint a
                // cookie that dies while the tab is idle overnight.
                const idToken = await user.getIdToken(true);
                const response = await fetch(this.sharedSessionUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { Authorization: `Bearer ${idToken}` }
                });
                lastStatus = response.status;
                if (!response.ok) throw new Error(`Shared session request failed (${response.status})`);
                this._recordSharedSessionSync(true, { status: response.status, attempt: attempt + 1 });
                return true;
            } catch (error) {
                lastError = error;
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }

        // SSO is additive: a surface can still use its local Firebase session
        // while a not-yet-deployed or unavailable handoff endpoint recovers.
        this._recordSharedSessionSync(false, {
            status: lastStatus,
            error: lastError?.message || 'unknown error',
        });
        console.warn('Shared session unavailable:', lastError?.message || 'unknown error');
        return false;
    },

    /**
     * Keep the shared-session cookie alive while a signed-in tab sits open.
     * Idle Firebase IndexedDB often comes back empty after overnight suspend;
     * a fresh cookie is the only backstop on the next refresh.
     */
    startSharedSessionKeepAlive(user = auth.currentUser) {
        if (this._keepAliveBound || typeof window === 'undefined') return;
        this._keepAliveBound = true;

        const sync = () => {
            const current = auth.currentUser || user;
            if (!current) return;
            void this.syncSharedSession(current);
        };

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') sync();
        });
        window.addEventListener('focus', sync);
        this._keepAliveTimer = window.setInterval(sync, SHARED_SESSION_REFRESH_MS);
    },

    async restoreSharedSession() {
        if (auth.currentUser) return auth.currentUser;
        if (!this._restorePromise) {
            this._restorePromise = (async () => {
                try {
                    const response = await fetch(this.sharedSessionUrl, { credentials: 'include' });
                    if (!response.ok) return null;
                    const data = await response.json();
                    if (!data.token) return null;
                    await auth.signInWithCustomToken(data.token);
                    return auth.currentUser;
                } catch (error) {
                    return null;
                }
            })().finally(() => {
                this._restorePromise = null;
            });
        }
        return this._restorePromise;
    },

    async clearSharedSession() {
        try {
            await fetch(this.sharedSessionUrl, {
                method: 'DELETE',
                credentials: 'include'
            });
        } catch (error) {
            console.warn('Shared session could not be cleared:', error.message);
        }
    },

    async signOut() {
        console.warn('[auth] Signing out current session.', { path: window.location.pathname });
        await this.clearSharedSession();
        return auth.signOut();
    },

    getErrorMessage(code) {
        switch (code) {
            case 'auth/wrong-password':
            case 'auth/user-not-found': return 'Incorrect email or password.';
            case 'auth/invalid-email': return 'Invalid email address.';
            case 'auth/user-disabled': return 'Account disabled.';
            case 'auth/email-already-in-use':
            case 'auth/credential-already-in-use': return 'That email is already linked to a different account.';
            case 'auth/weak-password': return 'Choose a stronger password (at least 6 characters).';
            case 'auth/requires-recent-login': return 'Please sign in again before linking an email.';
            default: return 'Authentication failed. Please try again.';
        }
    }
};
