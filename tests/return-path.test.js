import { describe, expect, it } from 'vitest';
import { loginUrlFor, safeReturnPath } from '../js/shared/return-path.js';

describe('return path after sign-in', () => {
    it('builds a login url that remembers the page', () => {
        expect(loginUrlFor('/recap')).toBe('/?next=%2Frecap');
    });
    it('returns to the remembered page', () => {
        expect(safeReturnPath('?next=%2Frecap')).toBe('/recap');
    });
    it('falls back to the dashboard when missing or unsafe', () => {
        expect(safeReturnPath('')).toBe('/dashboard');
        expect(safeReturnPath('?next=https://evil.com')).toBe('/dashboard');
        expect(safeReturnPath('?next=//evil.com')).toBe('/dashboard');
        expect(safeReturnPath('?next=%2F%5Cevil.com')).toBe('/dashboard');
    });
});
