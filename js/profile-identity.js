import { db, auth, serverTimestamp } from './firebase.js';
import { UI } from './ui-utils.js';
import { Identity } from './identity.js';
import { UsernameGenerator } from './username-generator.js';
import { getEmojiUsername } from './profile-fields.js';

export const IDENTITY_TAKEN_MESSAGE = "That one's taken. Try another combination.";
const IDENTITY_HELP_DEFAULT = 'Choose carefully — this identity can’t be changed later.';

// Shown next to the picker as well as in the toast, so the reason stays
// visible while the person picks again.
function setIdentityNote(message) {
    const help = document.getElementById('settings-identity-help');
    if (!help) return;
    help.textContent = message || IDENTITY_HELP_DEFAULT;
    help.classList.toggle('settings-identity-taken', Boolean(message));
    if (message) help.setAttribute('role', 'alert');
    else help.removeAttribute('role');
}

export function updateUsernameDisplay(profile) {
    const display = document.getElementById('settings-username-display');
    if (display) display.textContent = `@${Identity.toSlug(profile.currentTriplet)}`;
}

export function initializeIdentityPicker(profile) {
    const slots = document.querySelectorAll('.emoji-slot');
    const popover = document.getElementById('emoji-popover');
    const grid = popover?.querySelector('.emoji-grid');
    if (!grid) return;

    grid.innerHTML = Identity.getLibrary().map(item => `
        <div class="emoji-item" data-key="${item.key}">${item.emoji}</div>
    `).join('');

    slots.forEach(slot => {
        slot.addEventListener('click', event => {
            if (profile.data?.username) return;

            profile.activeSlot = parseInt(event.currentTarget.dataset.index, 10);
            const used = new Set(profile.currentTriplet);
            used.delete(profile.currentTriplet[profile.activeSlot]);

            grid.querySelectorAll('.emoji-item').forEach(item => {
                const isUsed = used.has(item.dataset.key);
                item.classList.toggle('used', isUsed);
                item.style.opacity = isUsed ? '0.3' : '1';
                item.style.pointerEvents = isUsed ? 'none' : 'auto';
            });

            const rect = event.currentTarget.getBoundingClientRect();
            popover.style.top = `${rect.bottom + window.scrollY + 5}px`;
            popover.style.left = `${rect.left + window.scrollX}px`;
            popover.classList.remove('hidden');
        });
    });

    grid.addEventListener('click', event => {
        const item = event.target.closest('.emoji-item');
        if (!item || item.classList.contains('used')) return;

        profile.currentTriplet[profile.activeSlot] = item.dataset.key;
        const slot = document.querySelector(`.emoji-slot[data-index="${profile.activeSlot}"]`);
        if (slot) slot.textContent = Identity.LIBRARY[item.dataset.key];
        popover.classList.add('hidden');
        updateUsernameDisplay(profile);
        setIdentityNote(null);
    });
}

export async function reserveUsername(profile, username) {
    const user = auth.currentUser;
    if (!user) return;

    if (profile.data?.username) {
        UI.showNotification('Identity changes are not supported.');
        return;
    }

    try {
        const legacyUsername = username.replace(/-/g, '_');
        const usernameDocs = await Promise.all(
            [...new Set([username, legacyUsername])].map(candidate => db.collection('usernames').doc(candidate).get()),
        );
        if (usernameDocs.some(existing => existing.exists())) {
            // Keep the picker as it is so they can change a slot and save again.
            UI.showNotification(IDENTITY_TAKEN_MESSAGE);
            setIdentityNote(IDENTITY_TAKEN_MESSAGE);
            return;
        }

        // One batch: either both writes land or neither does, so a failed
        // profile write can't leave the name reserved.
        const batch = db.batch();
        batch.set(db.collection('usernames').doc(username), {
            uid: user.uid,
            type: 'emoji',
            createdAt: serverTimestamp(),
        });
        batch.set(db.collection('profiles').doc(user.uid), {
            username,
            emojiUsername: username,
            usernameAliases: [username],
            usernameType: 'emoji',
            updatedAt: serverTimestamp(),
        }, { merge: true });
        await batch.commit();

        profile.data = {
            ...profile.data,
            username,
            emojiUsername: username,
            usernameAliases: [username],
            usernameType: 'emoji',
        };
        window.currentUserProfile = profile.data;
        await profile.syncUI(user.email);
        UI.showNotification('Identity reserved!');
    } catch (error) {
        console.error('Username save failed:', error);
        UI.showNotification(error?.code === 'permission-denied'
            ? "Couldn't save your identity. Please try again, and contact support if it keeps happening."
            : "Couldn't save your identity. Check your connection and try again.");
    }
}

export async function reserveCustomUsername(profile, value) {
    const user = auth.currentUser;
    if (!user || !window.isAdmin) return;

    const validation = UsernameGenerator.isCustomValid(value);
    if (!validation.valid) {
        UI.showNotification(validation.error);
        return;
    }

    const username = validation.value;
    const currentUsername = profile.data?.username || '';
    if (currentUsername === username) return;

    try {
        const legacyUsername = username.replace(/-/g, '_');
        const usernameDocs = await Promise.all(
            [...new Set([username, legacyUsername])].map(candidate => db.collection('usernames').doc(candidate).get()),
        );
        const occupiedByOtherUser = usernameDocs.some(existing => existing.exists() && existing.data()?.uid !== user.uid);
        if (occupiedByOtherUser) {
            UI.showNotification('That username is already in use. Choose another.');
            return;
        }

        const emojiUsername = getEmojiUsername(profile.data || {}) || currentUsername;
        const aliases = [...new Set([
            ...(profile.data?.usernameAliases || []),
            emojiUsername,
            currentUsername,
        ].filter(Boolean))];

        const batch = db.batch();
        batch.set(db.collection('usernames').doc(username), {
            uid: user.uid,
            type: 'custom',
            createdAt: serverTimestamp(),
        });
        batch.set(db.collection('profiles').doc(user.uid), {
            username,
            emojiUsername,
            usernameAliases: aliases,
            usernameType: 'custom',
            updatedAt: serverTimestamp(),
        }, { merge: true });
        await batch.commit();

        profile.data = { ...profile.data, username, emojiUsername, usernameAliases: aliases, usernameType: 'custom' };
        window.currentUserProfile = profile.data;
        await profile.syncUI(user.email);
        UI.showNotification('Custom username saved.', 'success');
    } catch (error) {
        console.error('Custom username save failed:', error);
        UI.showNotification("Couldn't save that username. Please try again.");
    }
}
