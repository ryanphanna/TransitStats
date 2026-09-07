import { describe, expect, it, vi } from 'vitest';

// presto-importer.js imports firebase.js for db/serverTimestamp (used only by
// initPrestoImporter, not by the pure functions this file tests), but
// firebase.js initializes real Firebase Auth at module load. That throws in
// CI, which has no Firebase env vars configured. Mock it so importing this
// module for its parsing/summary functions doesn't require a real project.
vi.mock('../js/firebase.js', () => ({ db: {}, serverTimestamp: () => null }));

import { classifyType, parseAmountCents, parseCsv, parseDate, summarize, toRecord } from '../js/presto-importer.js';

describe('parseCsv', () => {
    it('parses a PRESTO Transit Usage Report into row objects', () => {
        const csv = 'Date,TransitAgency,Location,Type,Amount\n"1/1/2026 12:13:10 PM","Toronto Transit Commission","BAY STATION","Fare Payment","$-3.30"\n';
        const rows = parseCsv(csv);
        expect(rows).toEqual([{
            Date: '1/1/2026 12:13:10 PM',
            TransitAgency: 'Toronto Transit Commission',
            Location: 'BAY STATION',
            Type: 'Fare Payment',
            Amount: '$-3.30',
        }]);
    });

    it('rejects a file that is not a PRESTO Transit Usage Report', () => {
        expect(() => parseCsv('foo,bar\n1,2\n')).toThrow(/PRESTO Transit Usage Report/);
    });

    it('skips blank trailing rows', () => {
        const csv = 'Date,TransitAgency,Location,Type,Amount\n"1/1/2026 12:13:10 PM","TTC","BAY","Fare Payment","$-3.30"\n\n';
        expect(parseCsv(csv)).toHaveLength(1);
    });
});

describe('parseAmountCents', () => {
    it('parses a negative dollar amount into cents', () => {
        expect(parseAmountCents('$-3.30')).toBe(-330);
    });

    it('parses a comma-separated amount', () => {
        expect(parseAmountCents('$1,028.15')).toBe(102815);
    });

    it('returns null for unparseable amounts', () => {
        expect(parseAmountCents('n/a')).toBeNull();
    });
});

describe('parseDate', () => {
    it('parses a 12-hour PRESTO timestamp into a sortable UTC key', () => {
        const result = parseDate('4/1/2026 2:01:25 PM');
        expect(result.local).toBe('4/1/2026 2:01:25 PM');
        expect(result.sortKey).toBe(Date.UTC(2026, 3, 1, 14, 1, 25));
    });

    it('handles 12 AM and 12 PM edge cases', () => {
        expect(parseDate('1/1/2026 12:00:00 AM').sortKey).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
        expect(parseDate('1/1/2026 12:00:00 PM').sortKey).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
    });

    it('returns null for an unparseable date', () => {
        expect(parseDate('not a date')).toBeNull();
    });
});

describe('classifyType', () => {
    it('classifies known PRESTO row types', () => {
        expect(classifyType('Fare Payment')).toBe('fare_payment');
        expect(classifyType('Period Pass Load')).toBe('period_pass_load');
        expect(classifyType('Epurse Load')).toBe('epurse_load');
    });

    it('classifies anything else as unknown', () => {
        expect(classifyType('Something New')).toBe('unknown');
    });
});

describe('toRecord', () => {
    it('builds a stop-matchable record from a parsed row', () => {
        const record = toRecord({
            Date: '4/1/2026 2:01:25 PM',
            TransitAgency: 'GO Transit',
            Location: 'Toronto- New USBT',
            Type: 'Fare Payment',
            Amount: '$-2.64',
        }, 2, 'PRESTO 2026.csv');

        expect(record.source).toBe('presto');
        expect(record.agency).toBe('GO');
        expect(record.agencySource).toBe('GO Transit');
        expect(record.type).toBe('fare_payment');
        expect(record.amountCents).toBe(-264);
        expect(record.locationLabel).toBe('Union Station Bus Terminal');
        expect(record.locationAliasApplied).toBe(true);
        expect(record.stopMatchStatus).toBe('pending');
    });
});

describe('summarize', () => {
    it('separates fares from the two unrelated load types', () => {
        const records = [
            toRecord({ Date: '1/1/2026 8:00:00 AM', TransitAgency: 'Toronto Transit Commission', Location: 'BAY STATION', Type: 'Fare Payment', Amount: '$-3.30' }, 2, 'f.csv'),
            toRecord({ Date: '1/1/2026 9:00:00 AM', TransitAgency: 'Toronto Transit Commission', Location: '14579', Type: 'Epurse Load', Amount: '$100.00' }, 3, 'f.csv'),
            toRecord({ Date: '1/1/2026 10:00:00 AM', TransitAgency: 'Toronto Transit Commission', Location: '14579', Type: 'Period Pass Load', Amount: '$128.15' }, 4, 'f.csv'),
        ];
        const summary = summarize(records);

        expect(summary.rows).toBe(3);
        expect(summary.farePayments).toBe(1);
        expect(summary.epurseLoads).toBe(1);
        expect(summary.passLoads).toBe(1);
        expect(summary.fareChargedCents).toBe(330);
        expect(summary.epurseLoadedCents).toBe(10000);
        expect(summary.passLoadedCents).toBe(12815);
    });

    it('nets a GO tap-in charge against its tap-out adjustment rather than summing them as separate charges', () => {
        const records = [
            toRecord({ Date: '1/1/2026 8:00:00 AM', TransitAgency: 'GO Transit', Location: 'Union Station Rail', Type: 'Fare Payment', Amount: '$-5.52' }, 2, 'f.csv'),
            toRecord({ Date: '1/1/2026 9:00:00 AM', TransitAgency: 'GO Transit', Location: 'Oakville GO Station Rail', Type: 'Fare Payment', Amount: '$2.64' }, 3, 'f.csv'),
        ];
        const summary = summarize(records);

        expect(summary.farePayments).toBe(2);
        expect(summary.fareChargedCents).toBe(288);
    });

    it('flags rows with an unparseable date or amount as invalid', () => {
        const records = [
            toRecord({ Date: 'garbage', TransitAgency: 'TTC', Location: 'BAY', Type: 'Fare Payment', Amount: '$-3.30' }, 2, 'f.csv'),
            toRecord({ Date: '1/1/2026 8:00:00 AM', TransitAgency: 'TTC', Location: 'BAY', Type: 'Fare Payment', Amount: 'garbage' }, 3, 'f.csv'),
        ];
        expect(summarize(records).invalidRows).toBe(2);
    });

    it('does not count an invalid Period Pass Load or Epurse Load row as invalid, since neither is ever imported', () => {
        const records = [
            toRecord({ Date: '1/1/2026 8:00:00 AM', TransitAgency: 'TTC', Location: 'BAY', Type: 'Fare Payment', Amount: '$-3.30' }, 2, 'f.csv'),
            toRecord({ Date: 'garbage', TransitAgency: 'TTC', Location: '14579', Type: 'Period Pass Load', Amount: '$128.15' }, 3, 'f.csv'),
            toRecord({ Date: 'garbage', TransitAgency: 'TTC', Location: '14579', Type: 'Epurse Load', Amount: 'garbage' }, 4, 'f.csv'),
        ];
        expect(summarize(records).invalidRows).toBe(0);
    });
});
