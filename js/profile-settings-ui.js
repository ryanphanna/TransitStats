import { UI } from './ui-utils.js';
import { Identity } from './identity.js';
import { createAgencyAutocomplete } from './agency-autocomplete.js';
import { reserveCustomUsername, reserveUsername } from './profile-identity.js';
import { db, auth } from './firebase.js';

export function setupProfileListeners(profile) {
    const agencySelect = document.getElementById('settings-agency');
    const agencyField = document.getElementById('settings-agency-field');
    const agencyDisplay = document.getElementById('settings-agency-display');
    const changeAgencyButton = document.getElementById('btn-change-agency');
    const customUsernameDisplay = document.getElementById('settings-custom-username-display');
    const customUsernameInput = document.getElementById('settings-custom-username');
    const changeCustomUsernameButton = document.getElementById('btn-change-custom-username');
    const saveCustomUsernameButton = document.getElementById('btn-save-custom-username');
    const customUsernameEditor = document.getElementById('settings-custom-username-editor');
    const betaPredictions = document.getElementById('settings-beta-predictions');
    const publicProfile = document.getElementById('settings-public-profile');
    const leaderboardOptIn = document.getElementById('settings-leaderboard-opt-in');
    const mapStopModeSelect = document.getElementById('settings-map-stop-mode');

    if (agencySelect) {
        profile.agencyAutocomplete = createAgencyAutocomplete({
            input: agencySelect,
            options: profile.agencyOptions,
            allowCustom: false,
            onCommit: value => profile.updateAgencyPreference(value).then(() => {
                agencyField?.classList.add('hidden');
                agencyDisplay?.classList.remove('hidden');
                changeAgencyButton?.classList.remove('hidden');
                profile.syncAgencyOptions();
            }),
            onInvalid: () => UI.showNotification('Choose an agency from the suggestions.'),
        });
        document.getElementById('btn-clear-agency')?.addEventListener('click', () => {
            profile.agencyAutocomplete?.clear();
            agencyField?.classList.add('hidden');
            agencyDisplay?.classList.remove('hidden');
            changeAgencyButton?.classList.remove('hidden');
        });
    }

    changeAgencyButton?.addEventListener('click', () => {
        agencyField?.classList.remove('hidden');
        agencyDisplay?.classList.add('hidden');
        changeAgencyButton.classList.add('hidden');
        agencySelect?.focus();
    });

    changeCustomUsernameButton?.addEventListener('click', () => {
        customUsernameDisplay?.classList.add('hidden');
        changeCustomUsernameButton.classList.add('hidden');
        customUsernameEditor?.classList.remove('hidden');
        customUsernameInput?.focus();
        customUsernameInput?.select();
    });

    saveCustomUsernameButton?.addEventListener('click', async () => {
        await reserveCustomUsername(profile, customUsernameInput?.value || '');
    });

    betaPredictions?.addEventListener('change', event => {
        profile.updateSetting('betaFeatures', {
            ...profile.data?.betaFeatures,
            predictions: event.target.checked,
        });
    });

    const nameInput = document.getElementById('settings-name');
    const nameDisplay = document.getElementById('settings-name-display');
    const changeNameButton = document.getElementById('btn-change-name');
    const saveNameButton = document.getElementById('btn-save-name');

    changeNameButton?.addEventListener('click', () => {
        nameInput?.classList.remove('hidden');
        nameDisplay?.classList.add('hidden');
        changeNameButton.classList.add('hidden');
        saveNameButton?.classList.remove('hidden');
        nameInput?.focus();
        nameInput?.select();
    });

    saveNameButton?.addEventListener('click', async () => {
        const name = nameInput?.value.trim();
        if (!name) return;
        await profile.updateSetting('displayName', name);
        nameDisplay.textContent = name;
        nameInput.classList.add('hidden');
        nameDisplay.classList.remove('hidden');
        saveNameButton.classList.add('hidden');
        changeNameButton?.classList.remove('hidden');
    });

    publicProfile?.addEventListener('change', async event => {
        const isPublic = event.target.checked;
        await profile.updateSetting('isPublic', isPublic);

        try {
            UI.showNotification(`Syncing ${isPublic ? 'public' : 'private'} state to all trips...`, 'info');
            const user = auth.currentUser;
            const tripsSnap = await db.collection('trips').where('userId', '==', user.uid).get();
            for (let start = 0; start < tripsSnap.docs.length; start += 500) {
                const batch = db.batch();
                tripsSnap.docs.slice(start, start + 500).forEach(doc => {
                    batch.update(doc.ref, { isPublic });
                });
                await batch.commit();
            }
            UI.showNotification('All trips updated.', 'success');
        } catch (error) {
            console.error('Trip sync failed:', error);
            UI.showNotification('Failed to sync trips: ' + error.message);
        }
    });

    leaderboardOptIn?.addEventListener('change', async event => {
        if (!profile.data?.username) {
            event.target.checked = false;
            UI.showNotification('Choose your public identity first.');
            return;
        }
        await profile.updateSetting('leaderboardOptIn', event.target.checked);
    });

    mapStopModeSelect?.addEventListener('change', event => {
        const mode = event.target.value === 'exiting' ? 'exiting' : 'boarding';
        localStorage.setItem('transitstats-map-stop-mode', mode);
        profile.updateSetting('mapStopMode', mode);
    });

    document.getElementById('btn-save-identity')?.addEventListener('click', () => {
        reserveUsername(profile, Identity.toSlug(profile.currentTriplet));
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.emoji-slot') && !event.target.closest('.emoji-popover')) {
            document.getElementById('emoji-popover')?.classList.add('hidden');
        }
    });
}
