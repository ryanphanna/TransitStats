// Station names for stop records, shared by the web app and the Cloud Functions
// (functions/lib/station-names.js is generated from this file by `npm run sync:shared`;
// a test fails if the copy drifts). Keep it to plain `export const` / `export function`.

// A platform record ("College Station - Northbound Platform", "Union Station (Platform 3)")
// belongs to its parent station. Only an explicit "platform" suffix counts, so ordinary stop names
// (and genuinely different stops) are never shortened.
export const PLATFORM_SUFFIX = /\s*[-–—,(]?\s*(?:(?:north|south|east|west)bound\s+)?platform(?:\s+[a-z0-9]+)?\)?\s*$/i;

/** The station a platform record belongs to ("College Station - Northbound Platform" -> "College Station"). */
export function stationBaseName(label) {
  const text = (label || '').toString().trim();
  const base = text.replace(PLATFORM_SUFFIX, '').trim();
  return base && base !== text ? base : text;
}

export function isPlatformRecord(label) {
  const text = (label || '').toString().trim();
  return PLATFORM_SUFFIX.test(text) && stationBaseName(text) !== text;
}

/** Punctuation/spacing/case-insensitive identity of a stop's station name. */
export function stopNameKey(label) {
  return stationBaseName(label).toLowerCase().replace(/[^a-z0-9]/g, '');
}
