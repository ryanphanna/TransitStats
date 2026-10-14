import { db, serverTimestamp } from './firebase.js';
import { loadAtlasStops } from './atlas-stops.js';
import { buildStopIndex, resolveStopLocation } from './atlas-stop-resolver.js';

const AGENCY_ALIASES = new Map([
    ['Toronto Transit Commission', 'TTC'],
    ['GO Transit', 'GO'],
    ['Mississauga Transit', 'MiWay'],
    ['Hamilton Street Railway', 'HSR'],
    ['York Region Transit', 'YRT'],
]);

const LOCATION_ALIASES = new Map([
    ['Toronto- New USBT', 'Union Station Bus Terminal'],
]);

export const PDF_ERROR = 'That looks like the PDF version of the report. In PRESTO, open Transit Usage Report, pick a year, click Get Report, then choose Export CSV (not Download PDF) and upload that file.';
export const DATE_FORMAT_EXAMPLE = '4/1/2026 2:01:25 PM';

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
    if (!headers?.includes('Date') || !headers.includes('Type')) {
        throw new Error('This does not look like a PRESTO Transit Usage Report.');
    }
    return values
        .filter(value => value.length === headers.length && value.some(Boolean))
        .map(value => Object.fromEntries(headers.map((header, index) => [header, value[index]])));
}

function parseAmountCents(value) {
    const amount = Number(String(value || '').replace(/[$,]/g, ''));
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function parseDate(value) {
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
        type: classifyType(row.Type),
        amountCents: parseAmountCents(row.Amount),
        location: rawLocation,
        locationLabel: LOCATION_ALIASES.get(rawLocation) || rawLocation,
        locationAliasApplied: LOCATION_ALIASES.has(rawLocation),
        // Stop resolution is deliberately deferred. The raw PRESTO activity
        // remains importable even when a location is ambiguous or unknown.
        stopMatchStatus: 'pending',
        raw: row,
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
            const label = String(record.raw?.Type || 'Unlabelled').trim() || 'Unlabelled';
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
    element.className = `settings-row presto-import-status ${type}`;
    show(element, true);
}

// Every imported record starts as stopMatchStatus: 'pending' - matching
// happens after import, not synchronously here. This runs the same
// resolution the rest of the app uses (Atlas stop data + the shared
// resolver) against the fare records at preview time only to tell the
// rider how many will likely resolve immediately versus need the later
// matching pass, without blocking or changing what actually gets saved.
async function checkLocationMatches(records) {
    const fareRecords = records.filter(record => record.type === 'fare_payment' && record.location);
    if (fareRecords.length === 0) return { checked: 0, matched: 0, pending: 0 };

    const agencies = [...new Set(fareRecords.map(record => record.agency).filter(Boolean))];
    let index;
    try {
        const atlasStops = await loadAtlasStops(agencies);
        index = buildStopIndex({ atlasStops, normalizedStops: [] });
    } catch {
        // Can't reach Atlas right now - don't block the preview over a
        // count that's advisory anyway.
        return { checked: 0, matched: 0, pending: 0 };
    }

    let matched = 0;
    fareRecords.forEach(record => {
        const resolution = resolveStopLocation(
            { agency: record.agency, startStopName: record.locationLabel },
            'boarding',
            index,
        );
        if (resolution.location) matched += 1;
    });
    return { checked: fareRecords.length, matched, pending: fareRecords.length - matched };
}

export function initPrestoImporter({ user }) {
    const group = document.getElementById('presto-import-group');
    const input = document.getElementById('presto-file-input');
    const previewButton = document.getElementById('presto-preview-button');
    const preview = document.getElementById('presto-import-preview');
    const actions = document.getElementById('presto-import-actions');
    const importButton = document.getElementById('presto-import-button');
    const statusElement = document.getElementById('presto-import-status');
    if (!group || !input || !previewButton || !preview || !actions || !importButton || !statusElement) return;

    show(group, true);
    let pendingRecords = [];

    input.addEventListener('change', () => {
        pendingRecords = [];
        show(preview, false);
        show(actions, false);
        show(statusElement, false);
        previewButton.disabled = input.files.length === 0;
    });

    previewButton.addEventListener('click', async () => {
        previewButton.disabled = true;
        try {
            const files = [...input.files];
            const recordsByFile = await Promise.all(files.map(async file => {
                const rows = parseCsv(await file.text());
                return rows.map((row, index) => toRecord(row, index + 2, file.name));
            }));
            pendingRecords = recordsByFile.flat();
            assertDatesReadable(pendingRecords);
            pendingRecords = markRefundedFares(pendingRecords);
            const summary = summarize(pendingRecords);
            const agencySummary = Object.entries(summary.agencies)
                .map(([agency, count]) => `${agency} (${count})`)
                .join(', ');
            const locationCheck = await checkLocationMatches(pendingRecords);
            const locationLine = locationCheck.checked === 0
                ? 'Locations will be matched after import.'
                : locationCheck.pending === 0
                    ? `All ${locationCheck.matched} ride locations already recognized.`
                    : `${locationCheck.matched} of ${locationCheck.checked} ride locations recognized now; ${locationCheck.pending} will be matched after import.`;
            const skippedLine = Object.keys(summary.skipped).length
                ? `Skipped: ${Object.entries(summary.skipped).map(([label, count]) => `${count} ${label}`).join(', ')}.`
                : null;
            preview.textContent = [
                `${summary.rows} rows ready`,
                `${summary.farePayments} fare payments · ${summary.epurseLoads} balance top-ups · ${summary.passLoads} pass purchases`,
                `${money(summary.fareChargedCents)} net fares charged (GO tap-in/tap-out pairs are combined into one trip)`,
                `${money(summary.epurseLoadedCents)} added to reloadable balance · ${money(summary.passLoadedCents)} spent on passes`,
                `${summary.first || 'Unknown'} to ${summary.last || 'unknown'}`,
                `Agencies: ${agencySummary || 'none'}`,
                summary.refundedFares ? `${summary.refundedFares} refunded fare${summary.refundedFares === 1 ? '' : 's'} (${money(summary.refundedCents)}) cancelled out and will not be imported.` : null,
                skippedLine,
                summary.invalidRows ? `${summary.invalidRows} rows need review and will not be imported.` : 'All rows passed basic validation.',
                locationLine,
            ].filter(Boolean).join('\n');
            show(preview, true);
            show(actions, summary.farePayments - summary.invalidRows > 0);
            status(statusElement, 'Preview only. Nothing has been saved.', 'success');
        } catch (error) {
            pendingRecords = [];
            status(statusElement, error.message || 'Could not read this PRESTO report.');
        } finally {
            previewButton.disabled = input.files.length === 0;
        }
    });

    importButton.addEventListener('click', async () => {
        if (!pendingRecords.length || importButton.disabled) return;
        importButton.disabled = true;
        try {
            // Card loads (pass purchases, balance top-ups) aren't rides, and
            // nothing reads them back out of storage once imported — the
            // preview above already summarized them from the file in memory.
            // Only fare payments are worth persisting. Invalid rows (bad date
            // or amount) are skipped rather than written with null fields.
            const fareRecords = pendingRecords.filter(record => record.type === 'fare_payment' && !record.refunded && isRecordUsable(record));
            const records = await Promise.all(fareRecords.map(async record => ({
                ...record,
                fingerprint: await fingerprint(record),
                userId: user.uid,
                importedAt: serverTimestamp(),
            })));
            const batchCount = Math.ceil(records.length / 400);
            for (let start = 0; start < records.length; start += 400) {
                const batchNumber = Math.floor(start / 400) + 1;
                status(statusElement, `Importing batch ${batchNumber} of ${batchCount}…`);
                const batch = db.batch();
                records.slice(start, start + 400).forEach(record => {
                    // The fingerprint alone is content-only (date, agency, location,
                    // type, amount) and does not include the user. Two different
                    // riders could in principle produce the same fingerprint, which
                    // would otherwise collide on the same document and fail the
                    // whole batch (Firestore rules deny writing over another user's
                    // doc, and a denied op fails the entire batch atomically).
                    // Prefixing with the uid keeps documents unique per user while
                    // still deduping a single user's repeat imports.
                    const ref = db.collection('prestoTransactions').doc(`${user.uid}_${record.fingerprint}`);
                    batch.set(ref, record, { merge: true });
                });
                await batch.commit();
            }
            const imported = await db.collection('prestoTransactions').where('userId', '==', user.uid).get();
            status(statusElement, `${pendingRecords.length} rows processed; ${imported.size} fare payments now stored. Stop matching will continue later, and re-imports will not create duplicates.`, 'success');
            show(actions, false);
        } catch (error) {
            console.error('PRESTO import failed:', error);
            status(statusElement, "Something went wrong partway through the import. It's safe to try again — already-imported rows won't be duplicated.");
        } finally {
            importButton.disabled = false;
        }
    });
}

export { classifyType, isRecordUsable, parseAmountCents, parseCsv, parseDate, summarize, toRecord };
