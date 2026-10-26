import { db, auth, serverTimestamp } from './firebase.js';
import { UI } from './ui-utils.js';
import { Identity } from './identity.js';
import { setupProfileListeners } from './profile-settings-ui.js';
import { initializeIdentityPicker, updateUsernameDisplay } from './profile-identity.js';
import {
    BUILT_IN_AGENCY_OPTIONS,
    displayAgencyName,
    formatPhoneNumber,
    getConfiguredAgency,
    getEmojiUsername,
    getMapStopMode,
    isEmojiUsername,
} from './profile-fields.js';

export { displayAgencyName, formatPhoneNumber } from './profile-fields.js';

/**
 * TransitStats - Preference Management
 * Handles user profile settings, beta features, and agency preferences.
 */
export const Profile = {
    data: null,
    phone: null,
    agencies: [],
    agencyOptions: [],
    agencyAutocomplete: null,
    currentTriplet: ['subway', 'subway', 'subway'],
    activeSlot: null,

    getDisplayName(user = auth.currentUser) {
        const displayName = this.data?.displayName || user?.displayName || '';
        const emailPrefix = user?.email?.split('@')[0] || '';
        return displayName && displayName !== emailPrefix ? displayName : '';
    },

    async init() {
        setupProfileListeners(this);
        initializeIdentityPicker(this);
        this.syncAgencyOptions();
    },

    /**
     * Load user data and phone number mappings.
     */
    async load(user) {
        if (!user) return;
        
        try {
            // Check cache first to avoid redundant reads
            if (this.data && this.phone) {
                window.currentUserProfile = this.data;
                return;
            }

            const profileDoc = await db.collection('profiles').doc(user.uid).get();

            if (profileDoc.exists()) {
                this.data = profileDoc.data();
            } else {
                // Auto-initialize profile if it doesn't exist
                this.data = await this.ensureProfile(user);
            }

            this.phone = user.phoneNumber || null;

            // Admins can read the legacy phone mapping; regular users cannot.
            if (!this.phone && window.isAdmin && user.email) {
                const emailPhoneSnap = await db.collection('phoneNumbers')
                    .where('email', '==', user.email)
                    .limit(1)
                    .get();
                if (!emailPhoneSnap.empty) {
                    this.phone = emailPhoneSnap.docs[0].id;
                }
            }

            if (!this.data?.username) {
                const usernameSnap = await db.collection('usernames')
                    .where('uid', '==', user.uid)
                    .limit(1)
                    .get();
                if (!usernameSnap.empty) {
                    this.data = {
                        ...this.data,
                        username: usernameSnap.docs[0].id,
                    };
                }
            }

            this.syncUI(user.email);
            window.currentUserProfile = this.data;
        } catch (err) {
            console.error('Profile load error:', err);
        }
    },

    async loadAgencies(user = auth.currentUser) {
        if (!user) return;

        try {
            const tripsSnap = await db.collection('trips').where('userId', '==', user.uid).get();
            this.setAgenciesFromTrips(tripsSnap.docs.map(doc => doc.data()));
        } catch (error) {
            console.warn('Could not load agencies from trips:', error);
            this.agencies = [];
            this.agencyOptions = [];
            this.syncAgencyOptions();
        }
    },

    /**
     * Derive agency options from already-loaded trip data, avoiding a
     * redundant full-collection Firestore read (the dashboard's live trips
     * listener already has this data).
     */
    setAgenciesFromTrips(trips = []) {
        const optionsByValue = new Map(BUILT_IN_AGENCY_OPTIONS.map(option => [option.value, option]));
        trips.forEach(trip => {
            const value = String(trip.agency || '').trim();
            if (!value || optionsByValue.has(value)) return;
            optionsByValue.set(value, { value, label: displayAgencyName(value) });
        });
        this.agencyOptions = [...optionsByValue.values()];
        this.agencies = this.agencyOptions.map(option => option.label);
        this.syncAgencyOptions();
    },

    syncAgencyOptions() {
        const agencyEl = document.getElementById('settings-agency');
        if (!agencyEl) return;

        const optionsByValue = new Map(this.agencyOptions.map(option => [option.value, option]));
        const defaultValue = getConfiguredAgency(this.data || {});
        const options = [...optionsByValue.values()].sort((a, b) => a.label.localeCompare(b.label));
        const automatic = this.data?.defaultAgencyMode === 'automatic' || !defaultValue;
        const agencyDisplay = document.getElementById('settings-agency-display');
        const selectedAgency = defaultValue
            ? options.find(option => option.value.toLowerCase() === defaultValue.toLowerCase())
            : null;
        const effectiveAutomatic = automatic || !selectedAgency;

        agencyEl.disabled = false;
        agencyEl.placeholder = effectiveAutomatic ? 'Automatic' : 'Search agencies…';
        if (agencyDisplay && document.getElementById('settings-agency-field')?.classList.contains('hidden')) {
            agencyDisplay.textContent = effectiveAutomatic ? 'Automatic' : selectedAgency.label;
        }
        if (this.agencyAutocomplete) {
            this.agencyAutocomplete.setOptions(options);
            this.agencyAutocomplete.setValue(effectiveAutomatic ? '' : selectedAgency.value);
        } else if (!effectiveAutomatic) {
            agencyEl.value = selectedAgency.label;
        }
    },

    /**
     * Ensure a profile document exists for the user.
     */
    async ensureProfile(user) {
        const triplet = Identity.generate();
        const defaultData = {
            userId: user.uid,
            displayName: user.displayName || 'Traveler',
            username: Identity.toSlug(triplet), // Auto-generate themed slug
            defaultAgency: null,
            defaultAgencyMode: 'automatic',
            primaryAgency: null,
            isPremium: false,
            isAdmin: false,
            isPublic: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        try {
            await db.collection('profiles').doc(user.uid).set(defaultData, { merge: true });
            console.log('Profile initialized for', user.uid);
            return defaultData;
        } catch (err) {
            console.error('Failed to initialize profile:', err);
            return defaultData;
        }
    },

    /**
     * Update UI elements with current profile state.
     */
    async syncUI(email) {
        // If we don't have data, try to load it from the current auth state
        if (!this.data && auth.currentUser) {
            await this.load(auth.currentUser);
        }

        const emailEl = document.getElementById('settings-email');
        const phoneEl = document.getElementById('settings-phone');
        const publicProfileEl = document.getElementById('settings-public-profile');
        const publicLinkEl = document.getElementById('settings-public-link');
        const mapStopModeEl = document.getElementById('settings-map-stop-mode');

        if (emailEl) emailEl.textContent = email || auth.currentUser?.email || '—';
        if (phoneEl) phoneEl.textContent = formatPhoneNumber(this.phone);

        // Primary agency only affects text-in trip logging, so it's only
        // relevant once a phone number is actually linked.
        document.getElementById('settings-agency-row')?.classList.toggle('hidden', !this.phone);
        document.getElementById('settings-agency-no-phone')?.classList.toggle('hidden', !!this.phone);

        const nameEl = document.getElementById('settings-name');
        if (nameEl) nameEl.value = this.getDisplayName();
        const nameDisplayEl = document.getElementById('settings-name-display');
        if (nameDisplayEl && nameEl?.classList.contains('hidden')) {
            nameDisplayEl.textContent = this.getDisplayName() || 'Not set';
        }

        this.syncAgencyOptions();

        if (publicProfileEl) {
            publicProfileEl.checked = !!this.data?.isPublic;
        }

        window.TransitTheme?.apply();

        if (mapStopModeEl) {
            const mode = getMapStopMode(this.data || {}, localStorage.getItem('transitstats-map-stop-mode'));
            mapStopModeEl.value = mode;
            localStorage.setItem('transitstats-map-stop-mode', mode);
        }

        const username = this.data?.username;
        const emojiUsername = getEmojiUsername(this.data || {});
        const customUsername = username && !isEmojiUsername(username) ? username : '';
        const adminUsernameEl = document.getElementById('settings-admin-username');
        const customUsernameDisplayEl = document.getElementById('settings-custom-username-display');
        const customUsernameInputEl = document.getElementById('settings-custom-username');
        const customUsernameEditorEl = document.getElementById('settings-custom-username-editor');
        const changeCustomUsernameButtonEl = document.getElementById('btn-change-custom-username');
        if (adminUsernameEl) adminUsernameEl.classList.toggle('hidden', !window.isAdmin);
        if (window.isAdmin) {
            if (customUsernameDisplayEl) customUsernameDisplayEl.textContent = customUsername ? `@${customUsername}` : 'Not set';
            if (customUsernameInputEl) customUsernameInputEl.value = customUsername;
            customUsernameDisplayEl?.classList.remove('hidden');
            customUsernameEditorEl?.classList.add('hidden');
            changeCustomUsernameButtonEl?.classList.remove('hidden');
        }

        // --- Identity UI ---
        const identityRow = document.querySelector('.settings-identity-row');
        if (username) {
            identityRow?.classList.add('is-reserved');
            if (emojiUsername) this.currentTriplet = emojiUsername.split(/[-_]/);
            const saveBtn = document.getElementById('btn-save-identity');
            if (saveBtn) saveBtn.style.display = 'none';
            const help = document.getElementById('settings-identity-help');
            if (help) {
                help.textContent = '';
                help.classList.add('hidden');
            }
        } else {
            identityRow?.classList.remove('is-reserved');
            document.getElementById('settings-identity-help')?.classList.remove('hidden');
        }
        
        document.querySelectorAll('.emoji-slot').forEach((slot, i) => {
            const key = this.currentTriplet[i];
            slot.textContent = Identity.LIBRARY[key] || '❓';
            if (username) slot.style.cursor = 'default';
        });

        updateUsernameDisplay(this);

        if (publicLinkEl) {
            const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
            const baseUrl = isLocal ? 'https://transitstats.fyi' : window.location.origin;
            const profileUsernames = [...new Set([username, emojiUsername].filter(Boolean))];
            const profileLinks = profileUsernames.map(value => ({
                label: value === customUsername ? 'Custom' : 'Emoji',
                url: `${baseUrl}/user/${encodeURIComponent(value)}`,
            }));
            
            if (profileLinks.length > 0) {
                publicLinkEl.innerHTML = '';
                profileLinks.forEach(({ label, url }) => {
                    const linkBox = document.createElement('div');
                    linkBox.className = 'public-link-box';

                    const linkLabel = document.createElement('span');
                    linkLabel.className = 'settings-profile-url-label';
                    linkLabel.textContent = label;

                    const link = document.createElement('a');
                    link.className = 'public-url settings-profile-url';
                    link.href = url;
                    link.target = '_blank';
                    link.rel = 'noopener';
                    link.textContent = url;

                    const shareButton = document.createElement('button');
                    shareButton.className = 'btn btn-link settings-text-action';
                    shareButton.textContent = navigator.share ? 'Share' : 'Copy';
                    linkBox.append(linkLabel, link, shareButton);
                    publicLinkEl.append(linkBox);

                    shareButton.addEventListener('click', async () => {
                        if (navigator.share) {
                            try {
                                await navigator.share({
                                    title: `${this.getDisplayName() || 'My'} TransitStats`,
                                    url,
                                });
                                return;
                            } catch (error) {
                                if (error?.name === 'AbortError') return;
                            }
                        }

                        try {
                            if (!navigator.clipboard?.writeText) return;
                            await navigator.clipboard.writeText(url);
                            UI.showNotification('Link copied.', 'success');
                        } catch {
                            // Sharing is optional; avoid surfacing a generic failure toast.
                        }
                    });
                });
            } else {
                publicLinkEl.textContent = 'Pick your identity to enable sharing.';
            }
        }
    },

    /**
     * Save a setting to Firestore and update local state.
     */
    async updateSetting(key, value) {
        return this.updateSettings({ [key]: value });
    },

    async updateAgencyPreference(value) {
        return this.updateSettings({
            defaultAgency: value || null,
            defaultAgencyMode: value ? 'manual' : 'automatic',
            ...(value ? {} : { primaryAgency: null }),
        });
    },

    async updateSettings(changes) {
        const user = auth.currentUser;
        if (!user) return;

        try {
            await db.collection('profiles').doc(user.uid).set({
                ...changes,
                updatedAt: serverTimestamp()
            }, { merge: true });
            
            // Update local state
            if (!this.data) this.data = {};
            Object.assign(this.data, changes);
            window.currentUserProfile = this.data;
            
            UI.showNotification('Saved.', 'success');
        } catch (err) {
            console.error('Save failed:', err);
            UI.showNotification('Failed to save: ' + err.message);
        }
    },
};
