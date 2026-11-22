import { db, serverTimestamp } from './firebase.js';
import { preparePrestoStops, prestoMatchFields } from './presto-stop-matcher.js';
import { PredictionEngine } from './predict.js';
import { loadAtlasStops } from './atlas-stops.js';

const AGENCY_ALIASES = new Map([
    ['Toronto Transit Commission', 'TTC'],
    ['Mississauga Transit', 'MiWay'],
    ['Hamilton Street Railway', 'HSR'],
    ['York Region Transit', 'YRT'],
]);

const LOCATION_ALIASES = new Map([
    ['Toronto- New USBT', 'Union Station Bus Terminal'],
]);

const PDF_ERROR = 'That looks like the PDF version of the report. In PRESTO, open Transit Usage Report, pick a year, click Get Report, then choose Export CSV (not Download PDF) and upload that file.';
const DATE_FORMAT_EXAMPLE = '4/1/2026 2:01:25 PM';

function parseCsv(rawText) {
    // Spreadsheet and browser exports often start with a UTF-8 byte order mark,
    // which would otherwise glue itself onto the first header ("\uFEFFDate").
    const text = String(rawText || '').replace(/^\uFEFF/, '');
    if (text.startsWith('%PDF')) throw new Error(PDF_ERROR);
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
            if (character === '"' && text[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                field += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ',') {
            row.push(field);
            field = '';
        } else if (character === '\n') {
            row.push(field.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += character;
        }
    }

    if (field || row.length > 0) {
        row.push(field.replace(/\r$/, ''));
        rows.push(row);
    }

    const [rawHeaders, ...values] = rows;
    const headers = rawHeaders?.map(header => header.trim());
    // Transaction History comes in two layouts (a PRESTO card's and a
    // contactless bank card's), both naming the usage report's columns differently.
    const cardHistory = headers?.includes('Service Provider Name') && headers.includes('Type') && headers.includes('Date');
    const contactlessHistory = headers?.includes('TransactionDateTime') && headers.includes('TapType');
    const usageReport = !cardHistory && headers?.includes('Date') && headers.includes('Type');
    if (!usageReport && !cardHistory && !contactlessHistory) {
        throw new Error('This does not look like a PRESTO Transit Usage Report or Transaction History export.');
    }
    return values
        .filter(value => value.length === headers.length && value.some(Boolean))
        .map(value => Object.fromEntries(headers.map((header, index) => [header, value[index]])))
        .map(row => {
            if (cardHistory) return { ...row, TransitAgency: row['Service Provider Name'], __history: true };
            if (contactlessHistory) return { ...row, Date: row.TransactionDateTime, Type: row.TapType, __history: true };
            return row;
        });
}

function parseAmountCents(value) {
    const amount = Number(String(value || '').replace(/[$,]/g, ''));
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Transaction History dates: "21 May 2026 07:34 a.m." (no seconds). */
function parseHistoryDate(value) {
    const match = String(value || '').match(/^(\d{1,2}) ([A-Za-z]+) (\d{4}) (\d{1,2}):(\d{2}) ([ap])\.?m\.?$/i);
    const month = match ? MONTHS.findIndex(name => name.startsWith(match[2].toLowerCase().slice(0, 3))) : -1;
    if (!match || month < 0) return null;
    let hour = Number(match[4]);
    if (match[6].toLowerCase() === 'p' && hour !== 12) hour += 12;
    if (match[6].toLowerCase() === 'a' && hour === 12) hour = 0;
    return { local: value, sortKey: Date.UTC(Number(match[3]), month, Number(match[1]), hour, Number(match[5]), 0) };
}

function parseDate(value) {
    const history = parseHistoryDate(value);
    if (history) return history;
    const match = String(value || '').match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/i,
    );
    if (!match) return null;
    let hour = Number(match[4]);
    if (match[7].toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (match[7].toUpperCase() === 'AM' && hour === 12) hour = 0;
    return {
        local: value,
        sortKey: Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]), hour, Number(match[5]), Number(match[6])),
    };
}

// From Transaction History only rides on a pass are imported: the Transit
// Usage Report already has every paid fare (with seconds, so they dedupe), and
// importing both would count paid rides twice.
function classifyHistoryType(value) {
    return value === 'Transit Pass Tap' ? 'fare_payment' : 'history_other';
}

function classifyType(value) {
    if (value === 'Fare Payment') return 'fare_payment';
    if (value === 'Period Pass Load') return 'period_pass_load';
    if (value === 'Epurse Load') return 'epurse_load';
    if (/refund/i.test(String(value || ''))) return 'refund';
    return 'unknown';
}

function toRecord(row, rowNumber, fileName) {
    const date = parseDate(row.Date);
    const rawLocation = row.Location || null;
    return {
        source: 'presto',
        sourceFileName: fileName,
        sourceRowNumber: rowNumber,
        occurredAtLocal: row.Date || null,
        occurredAtSortKey: date?.sortKey || null,
        agency: AGENCY_ALIASES.get(row.TransitAgency) || row.TransitAgency || null,
        agencySource: row.TransitAgency || null,
        type: row.__history ? classifyHistoryType(row.Type) : classifyType(row.Type),
        ...(row.__history && row.Type === 'Transit Pass Tap' ? { passRide: true } : {}),
        amountCents: parseAmountCents(row.Amount),
        location: rawLocation,
        locationLabel: LOCATION_ALIASES.get(rawLocation) || rawLocation,
        locationAliasApplied: LOCATION_ALIASES.has(rawLocation),
        // Stop resolution is deliberately deferred. The raw PRESTO activity
        // remains importable even when a location is ambiguous or unknown.
        stopMatchStatus: 'pending',
        raw: Object.fromEntries(Object.entries(row).filter(([key]) => key !== '__history')),
    };
}

async function fingerprint(record) {
    const input = JSON.stringify([
        record.occurredAtLocal,
        record.agencySource,
        record.location,
        record.type,
        record.amountCents,
    ]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// If NO ride row has a readable date, the export is in a date format we don't
// handle; say so plainly instead of reporting every row as "needs review".
export function assertDatesReadable(records) {
    const fares = records.filter(record => record.type === 'fare_payment');
    if (fares.length === 0 || fares.some(record => Number.isFinite(record.occurredAtSortKey))) return;
    const sample = fares[0].occurredAtLocal || 'blank';
    throw new Error(`We couldn't read the dates in this file (for example "${sample}"). The importer expects dates like ${DATE_FORMAT_EXAMPLE}. Export the Transit Usage Report as CSV straight from PRESTO without opening and re-saving it.`);
}

function sameAgency(a, b) {
    return String(a.agency || a.agencySource || '').toLowerCase() === String(b.agency || b.agencySource || '').toLowerCase();
}

/**
 * A refund row that exactly reverses an earlier fare (same agency, same
 * amount, refund after the fare) cancels it: the fare isn't a ride we should
 * import or total. One refund cancels at most one fare, the closest earlier
 * one. Returns new records; cancelled fares get `refunded: true`.
 */
export function markRefundedFares(records) {
    const marked = records.map(record => ({ ...record }));
    const fares = marked.filter(record => record.type === 'fare_payment' && Number.isFinite(record.occurredAtSortKey) && record.amountCents < 0);
    marked
        .filter(record => record.type === 'refund' && Number.isFinite(record.occurredAtSortKey) && record.amountCents > 0)
        .sort((a, b) => a.occurredAtSortKey - b.occurredAtSortKey)
        .forEach(refund => {
            const target = fares
                .filter(fare => !fare.refunded && sameAgency(fare, refund)
                    && fare.amountCents === -refund.amountCents
                    && fare.occurredAtSortKey <= refund.occurredAtSortKey)
                .sort((a, b) => b.occurredAtSortKey - a.occurredAtSortKey)[0];
            if (target) target.refunded = true;
        });
    return marked;
}

function isRecordUsable(record) {
    return Number.isFinite(record.occurredAtSortKey) && record.amountCents !== null;
}

function summarize(records) {
    const refundedFares = records.filter(record => record.type === 'fare_payment' && record.refunded);
    const farePayments = records.filter(record => record.type === 'fare_payment' && !record.refunded);
    // Everything that isn't a fare or a card load is skipped on import. Count
    // those by the label PRESTO used so people can see what was left out.
    const skipped = {};
    records
        .filter(record => !['fare_payment', 'epurse_load', 'period_pass_load'].includes(record.type))
        .forEach(record => {
            const base = String(record.raw?.Type || 'Unlabelled').trim() || 'Unlabelled';
            const label = record.type === 'history_other' && base === 'Fare Payment'
                ? 'paid fares (import those from the Transit Usage Report)'
                : base;
            skipped[label] = (skipped[label] || 0) + 1;
        });
    // Epurse loads fund the reloadable balance that fares are paid from, so
    // they're comparable to fareChargedCents. Period pass loads pay for a
    // separate all-you-can-ride subscription and have no per-fare relationship
    // at all. Combining them into one "loaded" total invites comparing it
    // against fares charged and concluding there's a large stray balance that
    // doesn't actually exist.
    const epurseLoads = records.filter(record => record.type === 'epurse_load');
    const passLoads = records.filter(record => record.type === 'period_pass_load');
    const dates = records
        .filter(record => Number.isFinite(record.occurredAtSortKey))
        .sort((left, right) => left.occurredAtSortKey - right.occurredAtSortKey);
    const agencies = {};
    records.forEach(record => {
        if (record.agency) agencies[record.agency] = (agencies[record.agency] || 0) + 1;
    });
    return {
        rows: records.length,
        farePayments: farePayments.length,
        passRides: farePayments.filter(record => record.passRide).length,
        epurseLoads: epurseLoads.length,
        passLoads: passLoads.length,
        // GO's tap-in/tap-out pairs can include a small positive adjustment at
        // exit, so this is the net amount actually charged, not a sum of charges.
        fareChargedCents: -farePayments.reduce((total, record) => total + (record.amountCents || 0), 0),
        epurseLoadedCents: epurseLoads.reduce((total, record) => total + (record.amountCents || 0), 0),
        passLoadedCents: passLoads.reduce((total, record) => total + (record.amountCents || 0), 0),
        first: dates[0]?.occurredAtLocal || null,
        last: dates.at(-1)?.occurredAtLocal || null,
        agencies,
        // Only fare payments are ever persisted (see the import handler below),
        // so an invalid Period Pass Load or Epurse Load row would be discarded
        // either way — it must not block importable fare payments.
        invalidRows: farePayments.filter(record => !isRecordUsable(record)).length,
        refundedFares: refundedFares.length,
        refundedCents: -refundedFares.reduce((total, record) => total + (record.amountCents || 0), 0),
        skipped,
    };
}

export function money(cents) {
    const amount = Math.abs(cents) / 100;
    return `${cents < 0 ? '-' : ''}$${amount.toFixed(2)}`;
}

function show(element, visible) {
    element?.classList.toggle('hidden', !visible);
}

function status(element, message, type = '') {
    if (!element) return;
    element.textContent = message;
    element.className = `presto-import-status ${type}`;
    show(element, true);
}

// Each fare row is matched to the stop library (the same matcher the map uses)
// when it is imported, and the result is saved on the row. The preview runs
// the same match so its count is what actually gets saved.
// Atlas (each agency's full stop list) fills in stops the library doesn't have.
const stopReads = new Map();
function loadPrestoStops(records) {
    const agencies = [...new Set(records.map(record => record.agency).filter(Boolean))].sort();
    const key = agencies.join('|');
    if (!stopReads.has(key)) {
        const cached = PredictionEngine.stopsLibrary;
        const read = Promise.all([
            Promise.resolve().then(() => (Array.isArray(cached) && cached.length
                ? cached
                : db.collection('stops').get().then(snap => snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))))),
            Promise.resolve().then(() => loadAtlasStops(agencies)).catch(() => []),
        ]).then(([firestoreStops, atlasStops]) => preparePrestoStops({ firestoreStops, atlasStops }));
        read.catch(() => { if (stopReads.get(key) === read) stopReads.delete(key); });
        stopReads.set(key, read);
    }
    return stopReads.get(key);
}

async function checkLocationMatches(records) {
    const fareRecords = records.filter(record => record.type === 'fare_payment' && record.location);
    if (fareRecords.length === 0) return { checked: 0, matched: 0, unmatched: 0 };
    let stops;
    try {
        stops = await loadPrestoStops(fareRecords);
    } catch {
        return { checked: 0, matched: 0, unmatched: 0 };
    }
    const matched = fareRecords.filter(record => prestoMatchFields(record, stops).stopMatchStatus === 'matched').length;
    return { checked: fareRecords.length, matched, unmatched: fareRecords.length - matched };
}

// The import flow is a few screens, one per phase: choose what to import,
// get the file, review it, save, done. Both hosts (Settings → Import and the
// /import page) supply an empty #presto-import-group and this fills it.
const EXPORTS = {
    paid: {
        title: 'Paid fares',
        blurb: 'Rides you paid for from your card balance.',
        report: 'Transit Usage Report',
        steps: [
            'Sign in at <a href="https://www.prestocard.ca" target="_blank" rel="noopener">prestocard.ca</a>',
            'In the sidebar, open <strong>Transit Usage Report</strong>',
            'Pick a year and click <strong>Get Report</strong>',
            'Click <strong>Export CSV</strong> (not Download PDF)',
        ],
        note: 'One file per year. You can add several years at once.',
    },
    pass: {
        title: 'Monthly pass rides',
        blurb: 'Rides taken while you held a monthly pass. These are only in Transaction History.',
        report: 'Transaction History',
        steps: [
            'Sign in at <a href="https://www.prestocard.ca" target="_blank" rel="noopener">prestocard.ca</a>',
            'Open <strong>Transaction History</strong> and pick the card you used',
            'Click <strong>Load More</strong> until your oldest ride shows',
            'Click <strong>Export CSV</strong>',
        ],
        note: 'PRESTO only exports the rows shown on the page, so load them all first.',
    },
};

const STEP_LABELS = ['Choose', 'Get file', 'Review', 'Done'];

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function monthLabel(sortKey) {
    if (!Number.isFinite(sortKey)) return null;
    return new Date(sortKey).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function rangeLabel(records) {
    const keys = records.map(record => record.occurredAtSortKey).filter(Number.isFinite);
    if (!keys.length) return null;
    const first = monthLabel(Math.min(...keys));
    const last = monthLabel(Math.max(...keys));
    return first === last ? first : `${first} – ${last}`;
}

function plural(count, word) {
    return `${count.toLocaleString('en-CA')} ${word}${count === 1 ? '' : 's'}`;
}

function importerMarkup() {
    return `
        <div class="presto-flow">
            <ol class="presto-steps" aria-label="Import progress">
                ${STEP_LABELS.map((label, index) => `<li data-step="${index}">${label}</li>`).join('')}
            </ol>

            <section class="presto-screen" data-screen="choose">
                <h3 class="presto-title">Import PRESTO rides</h3>
                <p class="presto-lede">Add rides from your PRESTO card to your map. Importing the same file twice never adds a ride twice.</p>
                <p class="presto-existing hidden" data-existing></p>
                <div class="presto-choices">
                    ${Object.entries(EXPORTS).map(([key, info]) => `
                        <button type="button" class="presto-choice" data-choose="${key}">
                            <span class="presto-choice-title">${info.title}</span>
                            <span class="presto-choice-blurb">${info.blurb}</span>
                            <span class="presto-choice-report">From: ${info.report}</span>
                        </button>`).join('')}
                </div>
            </section>

            <section class="presto-screen hidden" data-screen="file">
                <button type="button" class="presto-back" data-go="choose">← Back</button>
                <h3 class="presto-title" data-file-title></h3>
                <ol class="presto-howto" data-file-steps></ol>
                <p class="presto-note" data-file-note></p>
                <label class="presto-drop" data-drop>
                    <input id="presto-file-input" type="file" accept=".csv,text/csv" multiple>
                    <span class="presto-drop-main">Drop your CSV here or <u>choose a file</u></span>
                    <span class="presto-drop-sub">Nothing is saved until you confirm.</span>
                </label>
            </section>

            <section class="presto-screen hidden" data-screen="review">
                <button type="button" class="presto-back" data-go="file">← Choose a different file</button>
                <p class="presto-big"><strong data-review-count></strong> <span data-review-noun></span></p>
                <ul class="presto-facts" data-review-facts></ul>
                <details class="presto-details">
                    <summary>Details</summary>
                    <ul data-review-details></ul>
                </details>
                <div class="presto-actions">
                    <button id="presto-import-button" class="btn btn-primary" type="button"></button>
                </div>
            </section>

            <section class="presto-screen hidden" data-screen="saving">
                <h3 class="presto-title">Saving your rides…</h3>
                <progress class="presto-progress" max="1" value="0"></progress>
                <p class="presto-lede" data-saving-text></p>
            </section>

            <section class="presto-screen hidden" data-screen="done">
                <h3 class="presto-title" data-done-title></h3>
                <p class="presto-lede" data-done-text></p>
                <div class="presto-actions">
                    <button type="button" class="btn btn-ghost" data-go="choose">Import another file</button>
                    <a class="btn btn-primary" href="/dashboard">See your map</a>
                </div>
            </section>

            <p id="presto-import-status" class="presto-import-status hidden" role="status" aria-live="polite"></p>
        </div>`;
}

export function initPrestoImporter({ user }) {
    const group = document.getElementById('presto-import-group');
    if (!group) return;
    group.innerHTML = importerMarkup();
    show(group, true);

    const $ = selector => group.querySelector(selector);
    const input = $('#presto-file-input');
    const importButton = $('#presto-import-button');
    const statusElement = $('#presto-import-status');
    const drop = $('[data-drop]');
    let pendingRecords = [];
    let fareRecords = [];

    const showScreen = name => {
        group.querySelectorAll('.presto-screen').forEach(screen => show(screen, screen.dataset.screen === name));
        const stepIndex = { choose: 0, file: 1, review: 2, saving: 2, done: 3 }[name];
        group.querySelectorAll('.presto-steps li').forEach(item => {
            const index = Number(item.dataset.step);
            item.classList.toggle('is-current', index === stepIndex);
            item.classList.toggle('is-done', index < stepIndex);
        });
        show(statusElement, false);
        if (name === 'choose') refreshExisting();
    };

    const refreshExisting = async () => {
        const line = $('[data-existing]');
        try {
            const snap = await db.collection('prestoTransactions').where('userId', '==', user.uid).get();
            const rows = snap.docs.map(doc => doc.data());
            if (!rows.length) return show(line, false);
            const pass = rows.filter(row => row.passRide).length;
            const parts = [pass ? `${plural(rows.length - pass, 'paid fare')} and ${plural(pass, 'pass ride')}` : plural(rows.length, 'ride')];
            const range = rangeLabel(rows);
            line.textContent = `Already on your map: ${parts[0]}${range ? `, ${range}` : ''}.`;
            show(line, true);
        } catch {
            show(line, false);
        }
    };

    const chooseExport = key => {
        const info = EXPORTS[key];
        $('[data-file-title]').textContent = `${info.title}: get your ${info.report}`;
        $('[data-file-steps]').innerHTML = info.steps.map(step => `<li>${step}</li>`).join('');
        $('[data-file-note]').textContent = info.note;
        input.value = '';
        showScreen('file');
    };

    group.addEventListener('click', event => {
        const choice = event.target.closest('[data-choose]');
        if (choice) return chooseExport(choice.dataset.choose);
        const go = event.target.closest('[data-go]');
        if (go) {
            if (go.dataset.go === 'file') input.value = '';
            showScreen(go.dataset.go);
        }
    });

    ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', event => {
        event.preventDefault();
        if (event.dataTransfer?.files?.length) review([...event.dataTransfer.files]);
    });
    input.addEventListener('change', () => { if (input.files.length) review([...input.files]); });

    async function review(files) {
        status(statusElement, `Reading ${files.length === 1 ? files[0].name : `${files.length} files`}…`, 'info');
        try {
            const recordsByFile = await Promise.all(files.map(async file => {
                const rows = parseCsv(await file.text());
                return rows.map((row, index) => toRecord(row, index + 2, file.name));
            }));
            pendingRecords = markRefundedFares(recordsByFile.flat());
            assertDatesReadable(pendingRecords);
            fareRecords = pendingRecords.filter(record => record.type === 'fare_payment' && !record.refunded && isRecordUsable(record));
            if (!fareRecords.length) {
                const summary = summarize(pendingRecords);
                const skipped = Object.entries(summary.skipped).map(([label, count]) => `${count} ${label}`).join(', ');
                throw new Error(`No rides to import in this file${skipped ? ` (it has ${skipped})` : ''}. Check it's the right export.`);
            }
            const summary = summarize(pendingRecords);
            const locationCheck = await checkLocationMatches(fareRecords);
            const passRides = fareRecords.filter(record => record.passRide).length;
            const paid = fareRecords.length - passRides;

            $('[data-review-count]').textContent = fareRecords.length.toLocaleString('en-CA');
            $('[data-review-noun]').textContent = `ride${fareRecords.length === 1 ? '' : 's'} ready to add`;
            const facts = [
                passRides && paid ? `${plural(paid, 'paid fare')} and ${plural(passRides, 'pass ride')}` : passRides ? 'All taken on a monthly pass' : 'All paid fares',
                rangeLabel(fareRecords),
                locationCheck.checked
                    ? `${locationCheck.matched.toLocaleString('en-CA')} of ${locationCheck.checked.toLocaleString('en-CA')} matched to a stop${locationCheck.unmatched ? `; ${plural(locationCheck.unmatched, 'ride')} will be saved without one` : ''}`
                    : null,
                `Agencies: ${Object.entries(summary.agencies).sort((a, b) => b[1] - a[1]).map(([agency]) => agency).join(', ')}`,
            ];
            $('[data-review-facts]').innerHTML = facts.filter(Boolean).map(fact => `<li>${escapeHtml(fact)}</li>`).join('');

            const details = [
                `${plural(summary.rows, 'row')} read from ${plural(files.length, 'file')}`,
                summary.fareChargedCents ? `${money(summary.fareChargedCents)} in fares charged (GO tap-on/tap-off pairs count as one ride)` : null,
                summary.epurseLoadedCents || summary.passLoadedCents ? `${money(summary.epurseLoadedCents)} added to your balance · ${money(summary.passLoadedCents)} spent on passes` : null,
                summary.refundedFares ? `${plural(summary.refundedFares, 'refunded fare')} (${money(summary.refundedCents)}) left out` : null,
                summary.invalidRows ? `${plural(summary.invalidRows, 'ride')} with an unreadable date or amount left out` : null,
                Object.keys(summary.skipped).length ? `Not rides, left out: ${Object.entries(summary.skipped).map(([label, count]) => `${count} ${label}`).join(', ')}` : null,
            ];
            $('[data-review-details]').innerHTML = details.filter(Boolean).map(line => `<li>${escapeHtml(line)}</li>`).join('');
            importButton.textContent = `Add ${plural(fareRecords.length, 'ride')}`;
            showScreen('review');
        } catch (error) {
            pendingRecords = [];
            fareRecords = [];
            input.value = '';
            status(statusElement, error.message || 'Could not read this PRESTO file.');
        }
    }

    importButton.addEventListener('click', async () => {
        if (!fareRecords.length || importButton.disabled) return;
        importButton.disabled = true;
        const progress = $('.presto-progress');
        const savingText = $('[data-saving-text]');
        showScreen('saving');
        try {
            savingText.textContent = 'Matching rides to stops…';
            progress.removeAttribute('value');
            const stops = await loadPrestoStops(fareRecords).catch(() => null);
            const records = await Promise.all(fareRecords.map(async record => ({
                ...record,
                ...(stops ? prestoMatchFields(record, stops) : {}),
                fingerprint: await fingerprint(record),
                userId: user.uid,
                importedAt: serverTimestamp(),
            })));
            const before = await db.collection('prestoTransactions').where('userId', '==', user.uid).get();
            for (let start = 0; start < records.length; start += 400) {
                progress.value = start / records.length;
                savingText.textContent = `Saved ${start.toLocaleString('en-CA')} of ${records.length.toLocaleString('en-CA')}`;
                const batch = db.batch();
                records.slice(start, start + 400).forEach(record => {
                    // Doc ids are uid + content fingerprint: one user's re-imports
                    // overwrite instead of duplicating, and two riders with an
                    // identical fare never collide on the same document.
                    const ref = db.collection('prestoTransactions').doc(`${user.uid}_${record.fingerprint}`);
                    batch.set(ref, record, { merge: true });
                });
                await batch.commit();
            }
            progress.value = 1;
            const after = await db.collection('prestoTransactions').where('userId', '==', user.uid).get();
            const added = after.size - before.size;
            $('[data-done-title]').textContent = added > 0 ? `Added ${plural(added, 'ride')}` : 'Already up to date';
            $('[data-done-text]').textContent = added > 0
                ? `${added < records.length ? `${plural(records.length - added, 'ride')} were already imported. ` : ''}You now have ${plural(after.size, 'PRESTO ride')} on your map.`
                : `Every ride in this file was already imported. You have ${plural(after.size, 'PRESTO ride')} on your map.`;
            pendingRecords = [];
            fareRecords = [];
            showScreen('done');
        } catch (error) {
            console.error('PRESTO import failed:', error);
            showScreen('review');
            status(statusElement, "Something went wrong partway through. It's safe to try again: rides already saved won't be added twice.");
        } finally {
            importButton.disabled = false;
        }
    });

    showScreen('choose');
}

export { classifyType, parseAmountCents, parseCsv, parseDate, summarize, toRecord };
