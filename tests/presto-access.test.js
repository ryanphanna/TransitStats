import { describe, expect, it } from 'vitest';
import { canUsePrestoImport } from '../js/shared/presto-access.js';

describe('canUsePrestoImport', () => {
    it('allows admins and the presto pilot', () => {
        expect(canUsePrestoImport({ isAdmin: true })).toBe(true);
        expect(canUsePrestoImport({ pilot: 'presto' })).toBe(true);
    });

    it('denies everyone else, including other pilots and missing flags', () => {
        expect(canUsePrestoImport({ isAdmin: false, pilot: null })).toBe(false);
        expect(canUsePrestoImport({ pilot: 'other' })).toBe(false);
        expect(canUsePrestoImport({ isAdmin: 'yes' })).toBe(false);
        expect(canUsePrestoImport()).toBe(false);
    });
});
