import { describe, expect, it, vi } from 'vitest';

// presto-importer.js imports firebase.js for db/serverTimestamp (used only by
// initPrestoImporter, not by the pure functions this file tests), but
// firebase.js initializes real Firebase Auth at module load. That throws in
// CI, which has no Firebase env vars configured. Mock it so importing this
// module for its parsing/summary functions doesn't require a real project.
vi.mock('../js/firebase.js', () => ({ db: {}, serverTimestamp: () => null }));

import { assertDatesReadable, classifyType, money, markRefundedFares, parseAmountCents, parseCsv, parseDate, summarize, toRecord, withoutCrossExportDuplicates } from '../js/presto-importer.js';

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
        expect(record.agency).toBe('GO Transit');
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

describe('file format handling', () => {
    const header = 'Date,TransitAgency,Location,Type,Amount';
    const row = '1/1/2026 8:00:00 AM,Toronto Transit Commission,BAY STATION,Fare Payment,$-3.30';

    it('accepts a UTF-8 byte order mark before the header', () => {
        const rows = parseCsv(`﻿${header}\n${row}\n`);
        expect(rows).toHaveLength(1);
        expect(rows[0].Date).toBe('1/1/2026 8:00:00 AM');
    });

    it('tolerates padding around header names and Windows line endings', () => {
        const rows = parseCsv(` Date , TransitAgency,Location,Type ,Amount\r\n${row}\r\n`);
        expect(rows).toHaveLength(1);
    });

    it('gives a specific message for the PDF report', () => {
        expect(() => parseCsv('%PDF-1.7\n...binary...')).toThrow(/Export CSV/);
        expect(() => parseCsv('%PDF-1.7\n...binary...')).toThrow(/PDF version/);
    });

    it('still rejects an unrelated CSV with the generic message', () => {
        expect(() => parseCsv('a,b\n1,2\n')).toThrow(/does not look like a PRESTO/);
    });

    it('explains an unreadable date format instead of flagging every row', () => {
        const records = parseCsv(`${header}\n2026-01-01 08:00,Toronto Transit Commission,BAY,Fare Payment,$-3.30\n`)
            .map((r, i) => toRecord(r, i + 2, 'f.csv'));
        expect(() => assertDatesReadable(records)).toThrow(/2026-01-01 08:00/);
        expect(() => assertDatesReadable(records)).toThrow(/4\/1\/2026 2:01:25 PM/);
    });

    it('does not complain when at least one ride date parses', () => {
        const records = parseCsv(`${header}\n${row}\ngarbage,Toronto Transit Commission,BAY,Fare Payment,$-3.30\n`)
            .map((r, i) => toRecord(r, i + 2, 'f.csv'));
        expect(() => assertDatesReadable(records)).not.toThrow();
    });
});

describe('refunds and skipped row types', () => {
    const mk = (Date, Type, Amount, TransitAgency = 'Toronto Transit Commission') =>
        ({ Date, TransitAgency, Location: 'BAY STATION', Type, Amount });
    const records = rows => rows.map((row, i) => toRecord(row, i + 2, 'f.csv'));

    it('classifies refund rows', () => {
        expect(classifyType('Refund')).toBe('refund');
        expect(classifyType('Fare Refund')).toBe('refund');
    });

    it('cancels a fare that an equal later refund reverses', () => {
        const marked = markRefundedFares(records([
            mk('1/1/2026 8:00:00 AM', 'Fare Payment', '$-3.30'),
            mk('1/1/2026 9:00:00 AM', 'Fare Payment', '$-3.30'),
            mk('1/2/2026 9:00:00 AM', 'Refund', '$3.30'),
        ]));
        // Closest earlier matching fare is cancelled; the first stays.
        expect(marked.map(r => Boolean(r.refunded))).toEqual([false, true, false]);
        const summary = summarize(marked);
        expect(summary.farePayments).toBe(1);
        expect(summary.fareChargedCents).toBe(330);
        expect(summary.refundedFares).toBe(1);
        expect(summary.refundedCents).toBe(330);
    });

    it('leaves a refund alone when no fare matches (other amount, agency or order)', () => {
        const marked = markRefundedFares(records([
            mk('1/1/2026 8:00:00 AM', 'Fare Payment', '$-3.30'),
            mk('1/2/2026 9:00:00 AM', 'Refund', '$5.00'),
            mk('1/2/2026 9:00:00 AM', 'Refund', '$3.30', 'GO Transit'),
            mk('12/31/2025 9:00:00 AM', 'Refund', '$3.30'),
        ]));
        expect(marked.some(r => r.refunded)).toBe(false);
    });

    it('one refund cancels at most one fare', () => {
        const marked = markRefundedFares(records([
            mk('1/1/2026 8:00:00 AM', 'Fare Payment', '$-3.30'),
            mk('1/1/2026 8:05:00 AM', 'Fare Payment', '$-3.30'),
            mk('1/1/2026 9:00:00 AM', 'Refund', '$3.30'),
        ]));
        expect(marked.filter(r => r.refunded)).toHaveLength(1);
    });

    it('counts skipped row types by the label PRESTO used', () => {
        const summary = summarize(records([
            mk('1/1/2026 8:00:00 AM', 'Fare Payment', '$-3.30'),
            mk('1/1/2026 9:00:00 AM', 'Refund', '$1.00'),
            mk('1/1/2026 9:00:00 AM', 'Refund', '$1.00'),
            mk('1/1/2026 9:00:00 AM', 'Autoload', '$20.00'),
            mk('1/1/2026 9:00:00 AM', 'Epurse Load', '$20.00'),
        ]));
        expect(summary.skipped).toEqual({ Refund: 2, Autoload: 1 });
    });
});

describe('money', () => {
    it('puts the minus sign before the dollar sign', () => {
        expect(money(-1005)).toBe('-$10.05');
        expect(money(1005)).toBe('$10.05');
        expect(money(0)).toBe('$0.00');
        expect(money(-5)).toBe('-$0.05');
    });
});

describe('Transaction History export', () => {
    const csv = [
        'TransactionDateTime,TransitAgency,Location,TapType,Amount,ConfirmationID',
        '"21 Nov 2025 09:15 p.m.","Toronto Transit Commission","QUEENS PARK STATION","Transit Pass Tap","","X1"',
        '"20 Nov 2025 12:05 a.m.","Toronto Transit Commission","College St at McCaul St","Fare Payment","$3.30","X2"',
        '"20 Nov 2025 12:20 a.m.","Toronto Transit Commission","COLLEGE STATION","Free Transfer","","X3"',
    ].join('\n');

    it('imports rides on a pass, paid fares and free transfers', () => {
        const records = parseCsv(csv).map((row, index) => toRecord(row, index + 2, 'history.csv'));
        expect(records.map(record => record.type)).toEqual(['fare_payment', 'fare_payment', 'fare_payment']);
        expect(records[1].amountCents).toBe(-330);
        expect(records[0]).toMatchObject({ passRide: true, amountCents: 0, agency: 'TTC', location: 'QUEENS PARK STATION' });
        expect(records[0].occurredAtSortKey).toBe(Date.UTC(2025, 10, 21, 21, 15, 0));
        expect(records[1].occurredAtSortKey).toBe(Date.UTC(2025, 10, 20, 0, 5, 0));
        expect(records[0].raw.__history).toBeUndefined();
        const summary = summarize(records);
        expect(summary.passRides).toBe(1);
        expect(summary.farePayments).toBe(3);
    });
});

describe('PRESTO card Transaction History export', () => {
    it('reads the card layout (Service Provider Name, full month names)', () => {
        const csv = [
            'Date,Sequence Number,Service Provider Name,Location,Type,Discount Sum,Amount,Balance',
            '"21 November 2026 09:15 p.m.","0","Toronto Transit Commission","Spadina Ave at King St West North Side","Transit Pass Tap","0","","$13.20"',
            '"1 November 2026 02:00 p.m.","1","Toronto Transit Commission","BATHURST STATION","Fare Payment","0","$3.30","$13.20"',
        ].join('\n');
        const records = parseCsv(csv).map((row, index) => toRecord(row, index + 2, 'card.csv'));
        expect(records[0]).toMatchObject({ type: 'fare_payment', passRide: true, agency: 'TTC', amountCents: 0 });
        expect(records[0].occurredAtSortKey).toBe(Date.UTC(2026, 10, 21, 21, 15, 0));
        expect(records[1]).toMatchObject({ type: 'fare_payment', amountCents: -330 });
    });

    it('skips a paid fare the Usage Report already has, in either order', () => {
        const history = parseCsv([
            'Date,Sequence Number,Service Provider Name,Location,Type,Discount Sum,Amount,Balance',
            '"1 November 2026 02:00 p.m.","1","Toronto Transit Commission","BATHURST STATION","Fare Payment","0","$3.30","$13.20"',
            '"2 November 2026 08:00 a.m.","2","Toronto Transit Commission","BATHURST STATION","Fare Payment","0","$3.30","$9.90"',
        ].join('\n')).map((row, index) => toRecord(row, index + 2, 'card.csv'));
        const usage = parseCsv([
            'Date,TransitAgency,Location,Type,Amount',
            '"11/1/2026 2:00:41 PM","Toronto Transit Commission","14583","Fare Payment","$-3.30"',
        ].join('\n')).map((row, index) => toRecord(row, index + 2, 'usage.csv'));
        // Usage Report already saved: only the second history fare is new.
        expect(withoutCrossExportDuplicates(history, usage).map(r => r.occurredAtLocal)).toEqual(['2 November 2026 08:00 a.m.']);
        // History already saved: the usage fare is a repeat.
        expect(withoutCrossExportDuplicates(usage, history)).toEqual([]);
        // Both files at once: the usage row wins.
        expect(withoutCrossExportDuplicates([...history, ...usage]).map(r => r.raw.Location)).toEqual(['BATHURST STATION', '14583']);
        // A GO tap-on a minute off its Usage Report row is the same ride.
        const goTap = parseCsv([
            'Date,Sequence Number,Service Provider Name,Location,Type,Discount Sum,Amount,Balance',
            '"17 December 2025 08:29 a.m.","10","GO Transit","Burlington - AldershotGOStationBusLoop","Tap On","0","$5.25","$9.90"',
            '"17 December 2025 09:10 a.m.","9","GO Transit","Aldershot GO Station Rail","Tap Off","0","$0.00","$9.90"',
        ].join('\n')).map((row, index) => toRecord(row, index + 2, 'card.csv'));
        expect(goTap.map(r => r.type)).toEqual(['fare_payment', 'history_other']);
        const goUsage = parseCsv('Date,TransitAgency,Location,Type,Amount\n"12/17/2025 8:28:02 AM","GO Transit","Aldershot GO Station Rail","Fare Payment","$-5.25"')
            .map((row, index) => toRecord(row, index + 2, 'usage.csv'));
        expect(withoutCrossExportDuplicates(goTap.filter(r => r.type === 'fare_payment'), goUsage)).toEqual([]);
        // A pass tap or free transfer a minute after a paid fare is its own ride.
        const passTap = parseCsv([
            'Date,Sequence Number,Service Provider Name,Location,Type,Discount Sum,Amount,Balance',
            '"1 November 2026 02:01 p.m.","3","Toronto Transit Commission","SPADINA STATION","Free Transfer","0","","$13.20"',
        ].join('\n')).map((row, index) => toRecord(row, index + 2, 'card.csv'));
        expect(withoutCrossExportDuplicates(passTap, usage)).toHaveLength(1);
        // An unreadable amount stays null instead of becoming $0.
        const bad = parseCsv([
            'Date,Sequence Number,Service Provider Name,Location,Type,Discount Sum,Amount,Balance',
            '"1 November 2026 02:00 p.m.","1","Toronto Transit Commission","BATHURST STATION","Fare Payment","0","N/A","$13.20"',
        ].join('\n')).map((row, index) => toRecord(row, index + 2, 'card.csv'));
        expect(bad[0].amountCents).toBeNull();
        // Re-importing the same export is not treated as a repeat.
        expect(withoutCrossExportDuplicates(history, history)).toHaveLength(2);
    });
});
