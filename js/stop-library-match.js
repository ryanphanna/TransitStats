/**
 * Shared exact matching for the Firestore stop library.
 *
 * This intentionally does not use coordinates or fuzzy matching. A stop is
 * recognized only when its code, name, or alias matches within the trip's
 * agency, so the Admin inbox and maintenance audit agree.
 */
import { canonicalAgency } from './shared/agency-aliases.js';

// Agency names compare by canonical name, so GO, GO Transit and Metrolinx are one agency.
const agencyKey = agency => String(canonicalAgency(String(agency)) || '').toLowerCase();

export function normalizeStopLibraryLabel(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function stopAgencies(stop) {
    return [...new Set(stop?.agencies || (stop?.agency ? [stop.agency] : []))]
        .filter(Boolean)
        .map(agencyKey);
}

export function stopBelongsToAgency(stop, agency) {
    const candidateAgencies = stopAgencies(stop);
    if (!agency || candidateAgencies.length === 0) return true;
    const target = agencyKey(agency);
    return candidateAgencies.includes(target);
}

export function isStopLinked({ agency, stopName, stopCode }, stop) {
    if (!stop || !stopBelongsToAgency(stop, agency)) return false;

    if (stopCode && stop.code && String(stop.code).trim() === String(stopCode).trim()) {
        return true;
    }

    const target = normalizeStopLibraryLabel(stopName);
    if (!target) return false;

    return [stop.name, ...(stop.aliases || [])]
        .filter(Boolean)
        .some(label => normalizeStopLibraryLabel(label) === target);
}
