import { beforeEach, describe, expect, it, vi } from 'vitest';

const existing = new Set();
const batchSet = vi.fn();
vi.mock('../js/firebase.js', () => ({
    auth: { currentUser: { uid: 'u1', email: 'a@example.com' } },
    serverTimestamp: () => 'TS',
    db: {
        collection: () => ({
            doc: (id) => ({ id, get: async () => ({ exists: () => existing.has(id) }) }),
        }),
        batch: () => ({ set: batchSet, commit: vi.fn(async () => {}) }),
    },
}));

import { IDENTITY_TAKEN_MESSAGE, initializeIdentityPicker, reserveUsername } from '../js/profile-identity.js';

function page() {
    document.body.innerHTML = `
        <div class="emoji-slot" data-index="0">❓</div>
        <div id="emoji-popover" class="hidden"><div class="emoji-grid"></div></div>
        <button id="btn-save-identity">Save identity</button>
        <span id="settings-identity-help">Choose carefully — this identity can’t be changed later.</span>
        <div id="settings-username-display"></div>`;
}

describe('saving a public identity that is already reserved', () => {
    beforeEach(() => {
        page();
        existing.clear();
        batchSet.mockClear();
    });

    it('tells the person it is taken (toast and note), writes nothing, and leaves the picker usable', async () => {
        existing.add('bus-taco-panda');
        const profile = { data: {}, currentTriplet: ['bus', 'taco', 'panda'], syncUI: vi.fn() };

        await reserveUsername(profile, 'bus-taco-panda');

        expect(document.body.textContent).toContain(IDENTITY_TAKEN_MESSAGE);
        expect(document.querySelector('[role="alert"]')).not.toBeNull();
        expect(document.getElementById('settings-identity-help').textContent).toBe("That one's taken. Try another combination.");
        expect(batchSet).not.toHaveBeenCalled();
        expect(profile.syncUI).not.toHaveBeenCalled();
        // Picker stays as it was: slots and save button still there and enabled.
        expect(document.getElementById('btn-save-identity').disabled).toBe(false);
        expect(document.querySelector('.emoji-slot')).not.toBeNull();
    });

    it('also treats the legacy underscore spelling as taken', async () => {
        existing.add('bus_taco_panda');
        const profile = { data: {}, currentTriplet: ['bus', 'taco', 'panda'], syncUI: vi.fn() };
        await reserveUsername(profile, 'bus-taco-panda');
        expect(document.getElementById('settings-identity-help').textContent).toBe(IDENTITY_TAKEN_MESSAGE);
        expect(batchSet).not.toHaveBeenCalled();
    });

    it('a free combination saves normally and does not show the taken note', async () => {
        const profile = { data: {}, currentTriplet: ['bus', 'taco', 'panda'], syncUI: vi.fn(async () => {}) };
        await reserveUsername(profile, 'bus-taco-panda');
        expect(batchSet).toHaveBeenCalledTimes(2);
        expect(document.getElementById('settings-identity-help').textContent).not.toContain('taken');
    });

    it('picking a different emoji clears the taken note', () => {
        const profile = { data: {}, currentTriplet: ['bus', 'taco', 'panda'], activeSlot: 0 };
        initializeIdentityPicker(profile);
        const help = document.getElementById('settings-identity-help');
        help.textContent = IDENTITY_TAKEN_MESSAGE;
        document.querySelector('.emoji-slot').click();
        document.querySelector('.emoji-item:not(.used)').click();
        expect(help.textContent).toMatch(/Choose carefully/);
    });
});
