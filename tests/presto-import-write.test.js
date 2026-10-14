import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Firestore: records every batch.set so we can check ids and contents.
const store = new Map();
const batches = [];

vi.mock('../js/firebase.js', () => ({
    serverTimestamp: () => 'SERVER_TS',
    db: {
        collection: (name) => ({
            doc: (id) => ({ name, id }),
            where: () => ({
                get: async () => ({ size: [...store.keys()].filter(key => key.startsWith('prestoTransactions/')).length }),
            }),
        }),
        batch: () => {
            const ops = [];
            const batch = {
                set: (ref, data, options) => ops.push({ ref, data, options }),
                commit: async () => {
                    batches.push(ops.length);
                    ops.forEach(({ ref, data }) => store.set(`${ref.name}/${ref.id}`, data));
                },
            };
            return batch;
        },
    },
}));
vi.mock('../js/atlas-stops.js', () => ({ loadAtlasStops: async () => [] }));

import { initPrestoImporter } from '../js/presto-importer.js';

const HEADER = 'Date,TransitAgency,Location,Type,Amount';
const csv = (...rows) => [HEADER, ...rows].join('\n');
const fare = (date, amount = '$-3.30', agency = 'Toronto Transit Commission', location = 'BAY STATION') =>
    `${date},${agency},${location},Fare Payment,${amount}`;

function setupDom() {
    document.body.innerHTML = `
        <div id="presto-import-group" class="hidden"></div>
        <input id="presto-file-input" type="file">
        <button id="presto-preview-button"></button>
        <div id="presto-import-preview" class="hidden"></div>
        <div id="presto-import-actions" class="hidden"></div>
        <button id="presto-import-button"></button>
        <div id="presto-import-status" class="hidden"></div>`;
    return {
        input: document.getElementById('presto-file-input'),
        preview: document.getElementById('presto-preview-button'),
        previewText: document.getElementById('presto-import-preview'),
        importButton: document.getElementById('presto-import-button'),
        status: document.getElementById('presto-import-status'),
    };
}

async function chooseFile(dom, text, name = 'PRESTO 2026.csv') {
    const file = new File([text], name, { type: 'text/csv' });
    file.text = async () => text;
    Object.defineProperty(dom.input, 'files', { value: [file], configurable: true });
    dom.input.dispatchEvent(new Event('change'));
    dom.preview.click();
    await vi.waitFor(() => expect(dom.previewText.textContent).not.toBe(''));
}

async function runImport(dom) {
    dom.importButton.click();
    await vi.waitFor(() => expect(dom.status.textContent).toMatch(/now stored|went wrong/));
}

describe('PRESTO import write', () => {
    let dom;
    beforeEach(() => {
        store.clear();
        batches.length = 0;
        dom = setupDom();
        initPrestoImporter({ user: { uid: 'user_1' } });
    });

    it('writes only usable fare payments, under per-user ids', async () => {
        await chooseFile(dom, csv(
            fare('1/1/2026 8:00:00 AM'),
            fare('1/1/2026 9:00:00 AM', '$-3.30', 'GO Transit', 'Union Station Rail'),
            'garbage,Toronto Transit Commission,BAY,Fare Payment,$-3.30',
            '1/1/2026 10:00:00 AM,Toronto Transit Commission,14579,Epurse Load,$100.00',
            '1/1/2026 10:00:00 AM,Toronto Transit Commission,14579,Period Pass Load,$128.15',
            '1/1/2026 11:00:00 AM,Toronto Transit Commission,BAY,Mystery Row,$1.00',
        ));
        await runImport(dom);

        const ids = [...store.keys()];
        expect(ids).toHaveLength(2);
        ids.forEach(id => expect(id).toMatch(/^prestoTransactions\/user_1_[0-9a-f]{64}$/));
        [...store.values()].forEach(doc => {
            expect(doc).toMatchObject({ userId: 'user_1', source: 'presto', type: 'fare_payment', importedAt: 'SERVER_TS' });
        });
    });

    it('importing the same file again does not create duplicates', async () => {
        const text = csv(fare('1/1/2026 8:00:00 AM'), fare('1/2/2026 8:00:00 AM'));
        await chooseFile(dom, text);
        await runImport(dom);
        const firstIds = [...store.keys()].sort();

        dom = setupDom();
        initPrestoImporter({ user: { uid: 'user_1' } });
        await chooseFile(dom, text);
        await runImport(dom);

        expect([...store.keys()].sort()).toEqual(firstIds);
    });

    it('an overlapping file only adds the new rides', async () => {
        await chooseFile(dom, csv(fare('1/1/2026 8:00:00 AM'), fare('1/2/2026 8:00:00 AM')));
        await runImport(dom);

        dom = setupDom();
        initPrestoImporter({ user: { uid: 'user_1' } });
        await chooseFile(dom, csv(fare('1/2/2026 8:00:00 AM'), fare('1/3/2026 8:00:00 AM')));
        await runImport(dom);

        expect(store.size).toBe(3);
    });

    it('two riders importing identical rows get separate documents', async () => {
        const text = csv(fare('1/1/2026 8:00:00 AM'));
        await chooseFile(dom, text);
        await runImport(dom);

        dom = setupDom();
        initPrestoImporter({ user: { uid: 'user_2' } });
        await chooseFile(dom, text);
        await runImport(dom);

        const [first, second] = [...store.keys()].sort();
        expect(first).toMatch(/^prestoTransactions\/user_1_/);
        expect(second).toMatch(/^prestoTransactions\/user_2_/);
        // Same content, so the same fingerprint, but a different owner prefix.
        expect(first.split('user_1_')[1]).toBe(second.split('user_2_')[1]);
        expect(store.size).toBe(2);
    });

    it('a refunded fare is not imported', async () => {
        await chooseFile(dom, csv(
            fare('1/1/2026 8:00:00 AM'),
            '1/2/2026 8:00:00 AM,Toronto Transit Commission,BAY STATION,Refund,$3.30',
        ));
        expect(dom.previewText.textContent).toMatch(/1 refunded fare/);
        expect(dom.previewText.textContent).toMatch(/Skipped: 1 Refund/);
        expect(document.getElementById('presto-import-actions').classList.contains('hidden')).toBe(true);
    });

    it('commits large files in batches of 400', async () => {
        const rows = Array.from({ length: 850 }, (_, i) => fare(`1/1/2026 ${1 + (i % 12)}:${String(Math.floor(i / 12) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} AM`, '$-3.30', 'Toronto Transit Commission', `STOP ${i}`));
        await chooseFile(dom, csv(...rows));
        await runImport(dom);
        expect(batches).toEqual([400, 400, 50]);
    });

    it('shows a plain message when the file is a PDF', async () => {
        const file = new File(['%PDF-1.7'], 'report.pdf');
        file.text = async () => '%PDF-1.7 binary';
        Object.defineProperty(dom.input, 'files', { value: [file], configurable: true });
        dom.input.dispatchEvent(new Event('change'));
        dom.preview.click();
        await vi.waitFor(() => expect(dom.status.textContent).toMatch(/Export CSV/));
    });
});
