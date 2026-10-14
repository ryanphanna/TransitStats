// GENERATED from js/shared/presto-trips.js by scripts/sync-shared.mjs. Do not edit.
// Turns imported PRESTO fare rows into trips. Single source of truth for the
// app and the public profile function (functions/lib/presto-trips.js is
// generated from this file by `npm run sync:shared`). Dependency-free.

// Longest plausible gap between a GO tap-on and its tap-off.
const GO_MAX_TRIP_GAP_MS = 4 * 60 * 60 * 1000;

function isGoTransitRecord(record) {
    const agency = String(record?.agency || record?.agencySource || '').trim().toLowerCase();
    return agency === 'go' || agency === 'go transit';
}

// GO taps on (a charge, negative) and off (an adjustment, zero or positive).
// A row is only treated as a new boarding when it is clearly another charge;
// a row with no amount is assumed to be an exit.
function looksLikeExit(record) {
    return !(Number.isFinite(record?.amountCents) && record.amountCents < 0);
}

/**
 * PRESTO lists every tap as its own row. Non-GO agencies tap once per trip.
 * GO taps on and off, so its rows are paired in time order: an exit row
 * completes the open boarding only if it comes within GO_MAX_TRIP_GAP_MS and
 * is not itself a new charge. This way one missed tap-off leaves that single
 * trip boarding-only instead of shifting every later pair.
 */
function buildPrestoTrips(records = []) {
    const trips = [];
    const goRecords = [];

    for (const record of records) {
        if (record?.type !== 'fare_payment') continue;
        if (isGoTransitRecord(record)) {
            goRecords.push(record);
        } else {
            trips.push({ source: 'presto', agency: record.agency, startRecord: record, endRecord: null });
        }
    }

    goRecords.sort((a, b) => (Number(a.occurredAtSortKey) || 0) - (Number(b.occurredAtSortKey) || 0));

    let open = null;
    const close = (startRecord, endRecord = null) => {
        trips.push({ source: 'presto', agency: startRecord.agency, startRecord, endRecord });
    };

    for (const record of goRecords) {
        if (!open) {
            // An exit with no boarding still happened as a trip; keep it.
            if (looksLikeExit(record) && Number.isFinite(record.amountCents) && record.amountCents > 0) {
                close(record);
            } else {
                open = record;
            }
            continue;
        }

        const gap = (Number(record.occurredAtSortKey) || 0) - (Number(open.occurredAtSortKey) || 0);
        if (gap <= GO_MAX_TRIP_GAP_MS && looksLikeExit(record)) {
            close(open, record);
            open = null;
        } else {
            close(open);
            open = record;
        }
    }
    if (open) close(open);

    return trips;
}

module.exports = { GO_MAX_TRIP_GAP_MS, buildPrestoTrips };
