import { describe, expect, it } from 'vitest';
import { AGENCY_ALIASES, canonicalAgency } from '../js/shared/agency-aliases.js';

describe('shared agency aliases', () => {
    it('maps GO and its long name to GO Transit', () => {
        expect(canonicalAgency('GO')).toBe('GO Transit');
        expect(canonicalAgency(' go transit ')).toBe('GO Transit');
    });

    it('maps NFTA and the common MFTA typo to NFTA Metro', () => {
        expect(canonicalAgency('MFTA')).toBe('NFTA Metro');
        expect(canonicalAgency('nfta')).toBe('NFTA Metro');
        expect(canonicalAgency('NFTA Metro')).toBe('NFTA Metro');
    });

    it('keeps long names and leaves unknown agencies untouched', () => {
        expect(canonicalAgency('Toronto Transit Commission')).toBe('TTC');
        expect(canonicalAgency('Some Small Agency')).toBe('Some Small Agency');
        expect(canonicalAgency('')).toBe('');
    });

    it('has only lowercase keys so lookups are case-insensitive', () => {
        for (const key of Object.keys(AGENCY_ALIASES)) expect(key).toBe(key.toLowerCase());
    });
});
