import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../js/phone-fields.js';

describe('normalizePhone', () => {
    it('normalizes North American input to E.164', () => {
        expect(normalizePhone('(519) 555-0143')).toBe('+15195550143');
        expect(normalizePhone('+1 519 555 0143')).toBe('+15195550143');
    });

    it('preserves the plus prefix for other supported formats', () => {
        expect(normalizePhone('+442071234567')).toBe('+442071234567');
    });
});
