import { describe, expect, it } from 'vitest';
import {
    displayAgencyName,
    formatPhoneNumber,
    getConfiguredAgency,
    getMapStopMode,
    isEmojiUsername,
} from '../js/profile-fields.js';

describe('profile field helpers', () => {
    it('formats North American phone numbers for account settings', () => {
        expect(formatPhoneNumber('+15195550143')).toBe('(519) 555-0143');
        expect(formatPhoneNumber('')).toBe('Not linked');
    });

    it('uses automatic primary agency only when the profile is automatic', () => {
        expect(getConfiguredAgency({ defaultAgencyMode: 'automatic', primaryAgency: 'TTC' })).toBe('TTC');
        expect(getConfiguredAgency({ defaultAgencyMode: 'manual', defaultAgency: 'GO' })).toBe('GO');
        expect(getConfiguredAgency({ defaultAgencyMode: 'automatic' })).toBeNull();
    });

    it('normalizes map-stop mode to the two supported values', () => {
        expect(getMapStopMode({ mapStopMode: 'exiting' }, 'boarding')).toBe('exiting');
        expect(getMapStopMode({}, 'exiting')).toBe('exiting');
        expect(getMapStopMode({}, 'invalid')).toBe('boarding');
    });

    it('keeps agency labels and emoji usernames deterministic', () => {
        expect(displayAgencyName('TTC')).toBe('Toronto Transit Commission');
        expect(isEmojiUsername('subway-subway-subway')).toBe(true);
        expect(isEmojiUsername('my-profile')).toBe(false);
    });
});
