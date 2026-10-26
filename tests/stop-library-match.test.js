import { describe, expect, it } from 'vitest';
import { isStopLinked, normalizeStopLibraryLabel } from '../js/stop-library-match.js';

describe('stop library matching', () => {
    const stop = {
        agency: 'TTC',
        code: '1234',
        name: 'College Station',
        aliases: ['College / Yonge'],
    };

    it('normalizes punctuation and accents for names', () => {
        expect(normalizeStopLibraryLabel('Sèvres - Babylone')).toBe('sevresbabylone');
        expect(isStopLinked({ agency: 'TTC', stopName: 'College & Yonge' }, stop)).toBe(true);
    });

    it('matches codes only within the trip agency', () => {
        expect(isStopLinked({ agency: 'TTC', stopCode: '1234' }, stop)).toBe(true);
        expect(isStopLinked({ agency: 'GO Transit', stopCode: '1234' }, stop)).toBe(false);
    });

    it('does not match an unrelated agency by name', () => {
        expect(isStopLinked({ agency: 'GO Transit', stopName: 'College Station' }, stop)).toBe(false);
    });

    it('matches the agency label regardless of case', () => {
        const goStop = { agency: 'GO Transit', name: 'West Harbour GO' };
        expect(isStopLinked({ agency: 'go transit', stopName: 'West Harbour GO' }, goStop)).toBe(true);
    });
});
