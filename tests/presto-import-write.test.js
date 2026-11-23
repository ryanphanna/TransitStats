import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Firestore: records every batch.set so we can check ids and contents.
const store = new Map();
const batches = [];

vi.mock('../js/firebase.js', () => ({
    serverTimestamp: () => 'SERVER_TS',
    db: {
        collection: (name) => ({
            doc: (id) => ({ name, id }),
            where: (field, op, value) => ({
                get: async () => {
                    const docs = [...store.entries()]
                        .filter(([key, data]) => key.startsWith('prestoTransactions/') && data[field] === value)
                        .map(([, data]) => ({ data: () => data }));
                    return { size: docs.length, docs };
                },
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

function setupDom(uid = 'user_1') {
    document.body.innerHTML = '<div id="presto-import-group" class="hidden"></div>';
    initPrestoImporter({ user: { uid } });
    const group = document.getElementById('presto-import-group');
    return {
        group,
        input: document.getElementById('presto-file-input'),
        importButton: document.getElementById('presto-import-button'),
        status: document.getElementById('presto-import-status'),
        screen: name => group.querySelector(`[data-screen="${name}"]`),
    };
}

const visible = element => !element.classList.contains('hidden');

async function pickFile(dom, file) {
    Object.defineProperty(dom.input, 'files', { value: [file], configurable: true });
    dom.input.dispatchEvent(new Event('change'));
}

async function chooseFile(dom, text, name = 'PRESTO 2026.csv') {
    const file = new File([text], name, { type: 'text/csv' });
    file.text = async () => text;
    await pickFile(dom, file);
    await vi.waitFor(() => expect(visible(dom.screen('review')) || /No rides|already on your map/.test(dom.status.textContent)).toBe(true));
}

async function runImport(dom) {
    dom.importButton.click();
    await vi.waitFor(() => expect(visible(dom.screen('done')) || /went wrong/.test(dom.status.textContent)).toBe(true));
}

describe('PRESTO import write', () => {
    let dom;
    beforeEach(() => {
        store.clear();
        batches.length = 0;
        dom = setupDom();
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
        await chooseFile(dom, text);
        expect(dom.status.textContent).toMatch(/already on your map/);

        expect([...store.keys()].sort()).toEqual(firstIds);
    });

    it('an overlapping file only adds the new rides', async () => {
        await chooseFile(dom, csv(fare('1/1/2026 8:00:00 AM'), fare('1/2/2026 8:00:00 AM')));
        await runImport(dom);

        dom = setupDom();
        await chooseFile(dom, csv(fare('1/2/2026 8:00:00 AM'), fare('1/3/2026 8:00:00 AM')));
        await runImport(dom);

        expect(store.size).toBe(3);
    });

    it('two riders importing identical rows get separate documents', async () => {
        const text = csv(fare('1/1/2026 8:00:00 AM'));
        await chooseFile(dom, text);
        await runImport(dom);

        dom = setupDom('user_2');
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
        expect(dom.status.textContent).toMatch(/No rides to import.*1 Refund/);
        expect(visible(dom.screen('review'))).toBe(false);
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
        await pickFile(dom, file);
        await vi.waitFor(() => expect(dom.status.textContent).toMatch(/Export CSV/));
    });
});

describe('PRESTO import screens', () => {
    beforeEach(() => { store.clear(); batches.length = 0; });

    it('walks file → review → done and reports what was added', async () => {
        const dom = setupDom();
        expect(visible(dom.screen('file'))).toBe(true);
        await chooseFile(dom, csv(fare('1/1/2026 8:00:00 AM'), fare('1/2/2026 8:00:00 AM')));
        expect(dom.screen('review').textContent).toMatch(/2\s*new rides to add/);
        expect(dom.importButton.textContent).toBe('Add 2 rides');
        await runImport(dom);
        expect(dom.screen('done').textContent).toMatch(/Added 2 rides/);
    });

    it('counts a ride PRESTO lists twice only once', async () => {
        const dom = setupDom();
        await chooseFile(dom, csv(fare('1/1/2026 8:00:00 AM'), fare('1/1/2026 8:00:00 AM'), fare('1/2/2026 8:00:00 AM')));
        expect(dom.screen('review').textContent).toMatch(/2\s*new rides to add/);
        await runImport(dom);
        expect(dom.screen('done').textContent).toMatch(/Added 2 rides/);
        expect(dom.screen('done').textContent).not.toMatch(/already imported/);
    });

    it('says when a file was already imported', async () => {
        const text = csv(fare('1/1/2026 8:00:00 AM'));
        let dom = setupDom();
        await chooseFile(dom, text);
        await runImport(dom);
        dom = setupDom();
        await chooseFile(dom, text);
        expect(dom.status.textContent).toMatch(/Every ride in this file is already on your map/);
        expect(visible(dom.screen('review'))).toBe(false);
    });

    it('opens on the Transaction History steps, with older years from the Usage Report', () => {
        const dom = setupDom();
        expect(visible(dom.screen('file'))).toBe(true);
        expect(dom.screen('file').textContent).toMatch(/Transaction History/);
        expect(dom.screen('file').textContent).toMatch(/Load More/);
        expect(dom.screen('file').textContent).toMatch(/Transit Usage Report/);
    });
});

describe('PRESTO later re-match', () => {
    it('updates only rides that now match, at most once a day', async () => {
        const { rematchUnmatchedPresto } = await import('../js/presto-importer.js');
        localStorage.clear();
        const updates = [];
        const doc = (data) => ({ data: () => data, ref: { id: data.id } });
        const docs = [
            doc({ id: 'a', type: 'fare_payment', agency: 'TTC', location: 'NOWHERE AT ALL', stopMatchStatus: 'unmatched' }),
            doc({ id: 'b', type: 'fare_payment', agency: 'TTC', location: 'BAY STATION', stopMatchStatus: 'matched' }),
        ];
        const count = await rematchUnmatchedPresto('user_9', docs);
        expect(count).toBe(0);
        expect(updates).toEqual([]);
        // A second call in the same session does nothing.
        expect(await rematchUnmatchedPresto('user_9', docs)).toBe(0);
    });
});
