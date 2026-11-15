import { describe, expect, it } from 'vitest';
import { AGENCY_ALIASES, agencyKey, canonicalAgency, sameAgency, stopBelongsToAgency } from '../js/shared/agency-aliases.js';

describe('shared agency aliases', () => {
    it('maps GO and its long name to GO Transit', () => {
        expect(canonicalAgency('GO')).toBe('GO Transit');
        expect(canonicalAgency(' go transit ')).toBe('GO Transit');
    });

    it('counts Metrolinx as GO Transit (CIV-1463)', () => {
        expect(canonicalAgency('Metrolinx')).toBe('GO Transit');
        expect(canonicalAgency(' METROLINX ')).toBe('GO Transit');
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

    it('compares agency labels by canonical name', () => {
        expect(agencyKey('Metrolinx')).toBe('go transit');
        expect(agencyKey(null)).toBe('');
        expect(sameAgency('GO', 'Metrolinx')).toBe(true);
        expect(sameAgency('GO Transit', 'TTC')).toBe(false);
    });

    it('matches a Metrolinx-tagged stop to a GO trip, not to another agency', () => {
        expect(stopBelongsToAgency({ agencies: ['Metrolinx'] }, 'GO Transit')).toBe(true);
        expect(stopBelongsToAgency({ agency: 'GO Transit' }, 'metrolinx')).toBe(true);
        expect(stopBelongsToAgency({ agency: 'Metrolinx' }, 'TTC')).toBe(false);
        expect(stopBelongsToAgency({ agency: 'Metrolinx' }, '')).toBe(true);
        expect(stopBelongsToAgency({}, 'TTC')).toBe(true);
    });
});
