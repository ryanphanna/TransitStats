import { auth, authPersistenceReady, db } from './firebase.js';

/**
 * TransitStats V2 Authentication Module
 */
export const Auth = {
    phoneApiUrl: 'https://us-central1-transitstats-21ba4.cloudfunctions.net/api',
    sharedSessionUrl: '/auth/session',
    _restorePromise: null,

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
    async sendMagicLink(email, redirectPath = '/') {
        const settings = {
            url: window.location.origin + redirectPath,
            handleCodeInApp: true
        };
        await auth.sendSignInLinkToEmail(email.toLowerCase(), settings);
        localStorage.setItem('emailForSignIn', email);
    },

    // Completes an email sign-in link. The email normally comes from
    // localStorage (same device/browser that requested the link) — but
    // opening the link on a different device (e.g. requested on desktop,
    // opened on a phone) has no localStorage to read, so this returns
    // { needsEmail: true } instead of guessing. The caller shows a real
    // "confirm your email" step and calls this again with that value,
    // rather than this shared module reaching for window.prompt itself.
    async completeMagicLinkSignIn(explicitEmail = null) {
        if (!auth.isSignInWithEmailLink(window.location.href)) return { signedIn: false };

        const email = explicitEmail || localStorage.getItem('emailForSignIn');
        if (!email) return { signedIn: false, needsEmail: true };

        await auth.signInWithEmailLink(email, window.location.href);
        localStorage.removeItem('emailForSignIn');
        window.history.replaceState({}, document.title, window.location.pathname);
        return { signedIn: true };
    },

    // Still used by the existing password credential on Settings' "Reset
    // password" row — untouched in this pass, see linkEmail below.
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

    async syncSharedSession(user = auth.currentUser) {
        if (!user) return false;
        let lastError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const idToken = await user.getIdToken(attempt > 0);
                const response = await fetch(this.sharedSessionUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { Authorization: `Bearer ${idToken}` }
                });
                if (!response.ok) throw new Error(`Shared session request failed (${response.status})`);
                return true;
            } catch (error) {
                lastError = error;
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }

        // SSO is additive: a surface can still use its local Firebase session
        // while a not-yet-deployed or unavailable handoff endpoint recovers.
        console.warn('Shared session unavailable:', lastError?.message || 'unknown error');
        return false;
    },

    async restoreSharedSession(timeoutMs = 1500) {
        if (auth.currentUser) return auth.currentUser;
        if (!this._restorePromise) {
            this._restorePromise = (async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const response = await fetch(this.sharedSessionUrl, {
                        credentials: 'include',
                        signal: controller.signal,
                    });
                    if (!response.ok) return null;
                    const data = await response.json();
                    if (!data.token) return null;
                    await auth.signInWithCustomToken(data.token);
                    return auth.currentUser;
                } catch (error) {
                    return null;
                } finally {
                    clearTimeout(timeout);
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
            case 'auth/user-not-found': return 'No account found for that email.';
            case 'auth/invalid-email': return 'Invalid email address.';
            case 'auth/user-disabled': return 'Account disabled.';
            case 'auth/email-already-in-use':
            case 'auth/credential-already-in-use': return 'That email is already linked to a different account.';
            case 'auth/weak-password': return 'Choose a stronger password (at least 6 characters).';
            case 'auth/requires-recent-login': return 'Please sign in again before linking an email.';
            case 'auth/invalid-action-code':
            case 'auth/expired-action-code': return 'That sign-in link has expired or was already used. Request a new one.';
            default: return 'Authentication failed. Please try again.';
        }
    }
};
