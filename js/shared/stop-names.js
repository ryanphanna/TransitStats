// The one stop-name cleanup rule, shared by the web app and the Cloud Functions
// (functions/lib/stop-names.js is generated from this file by scripts/sync-shared.mjs).
// ml/stop_canon.py ml_norm() is the Python copy and must apply the same steps.
// Lowercases and trims, then writes every intersection joiner as "/": " and ", "&", "@", "/" and
// " at " all mean the same corner, so "Spadina and Nassau", "Spadina & Nassau" and
// "Spadina/Nassau" are one stop (RYN-541).
export function normalizeStopName(name) {
  return String(name).trim().toLowerCase()
    .replace(/\s+and\s+/g, '/')
    .replace(/\s*[/&@]\s*/g, '/')
    .replace(/\s+at\s+/g, '/');
}
