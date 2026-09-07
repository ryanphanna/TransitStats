/**
 * Utility functions for SMS processing
 */
const crypto = require('crypto');
const { AGENCY_CANONICAL } = require('./constants');

const INVALID_ROUTE_WORDS = new Set([
  'N', 'S', 'E', 'W',
  'NB', 'SB', 'EB', 'WB',
  'N/B', 'S/B', 'E/B', 'W/B',
  'NORTH', 'SOUTH', 'EAST', 'WEST',
  'NORTHBOUND', 'SOUTHBOUND', 'EASTBOUND', 'WESTBOUND',
  'IN', 'OUT', 'IB', 'OB', 'INBOUND', 'OUTBOUND',
  'ST', 'STREET', 'RD', 'ROAD', 'AVE', 'AV', 'AVENUE',
  'BLVD', 'BOULEVARD', 'DR', 'DRIVE',
  'BUS', 'TRAIN', 'TRAM', 'SUBWAY', 'METRO', 'STOP', 'STATION',
]);

/**
 * Convert string to Title Case
 * Also normalizes " and " to " & " for intersections
 * @param {string} str - Input string
 * @returns {string} Title Cased String
 */
function toTitleCase(str) {
  if (!str) return str;

  // List of acronyms to preserve in all-caps
  const ACRONYMS = ['TMU', 'TTC', 'GTA', 'GO', 'UP', 'OC', 'HSR', 'GRT', 'YRT'];

  // Replace " and " with " & " (case insensitive)
  // Normalize slashes to a single char first to ensure clean splitting
  const normalized = str.replace(/ (and) /gi, ' & ').replace(/ *\/ */g, '/');

  const titleCased = normalized
    .split(/\s+/)
    .map((word) => {
      // Check if word (stripped of punctuation) is a known acronym
      const cleanWord = word.replace(/[^a-zA-Z]/g, '').toUpperCase();
      if (ACRONYMS.includes(cleanWord)) {
        return word.toUpperCase();
      }

      // Otherwise, standard title case
      const lower = word.toLowerCase();
      return lower.split('/').map((part) => 
        part.replace(/^([^a-zA-Z]*)([a-zA-Z])/, (_, pre, letter) => 
          /\d$/.test(pre) ? pre + letter : pre + letter.toUpperCase()
        )
      ).join('/');
    })
    .join(' ');

  // Restore spaces around slashes for the final "canonical" display/storage format
  return titleCased.replace(/\//g, ' / ');
}

/**
 * Escape XML special characters
 * @param {string} text - Message body
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Normalize direction input to standard full-word format
 * @param {string} input - Raw direction input (e.g. "SB", "North", "CW")
 * @returns {string} Normalized direction (e.g. "Southbound", "Northbound", "Clockwise") or original input
 */
function normalizeDirection(input) {
  if (!input) return null;

  const upper = input.trim().toUpperCase();

  // North/Northbound
  if (['N', 'NB', 'N/B', 'NORTH', 'NORTHBOUND', 'NORTHWARD'].includes(upper)) return 'Northbound';

  // South/Southbound
  if (['S', 'SB', 'S/B', 'SOUTH', 'SOUTHBOUND', 'SOUTHWARD'].includes(upper)) return 'Southbound';

  // East/Eastbound
  if (['E', 'EB', 'E/B', 'EAST', 'EASTBOUND', 'EASTWARD'].includes(upper)) return 'Eastbound';

  // West/Westbound
  if (['W', 'WB', 'W/B', 'WEST', 'WESTBOUND', 'WESTWARD'].includes(upper)) return 'Westbound';

  // Clockwise
  if (['CW', 'CLOCKWISE'].includes(upper)) return 'Clockwise';

  // Counterclockwise
  if (['CCW', 'COUNTERCLOCKWISE', 'ANTICLOCKWISE', 'ANTI-CLOCKWISE'].includes(upper)) return 'Counterclockwise';

  // Inbound
  if (['IB', 'IN', 'INBOUND'].includes(upper)) return 'Inbound';

  // Outbound
  if (['OB', 'OUT', 'OUTBOUND'].includes(upper)) return 'Outbound';

  // Up Valley / Down Valley (ski resort and valley transit systems) — only the
  // explicit "valley" phrasing counts; bare UP/DOWN shouldn't guess a system type.
  if (['UV', 'UPVALLEY', 'UP VALLEY', 'UP-VALLEY'].includes(upper)) return 'Up Valley';
  if (['DV', 'DOWNVALLEY', 'DOWN VALLEY', 'DOWN-VALLEY'].includes(upper)) return 'Down Valley';

  // Up Mountain / Down Mountain / Uphill / Downhill (escarpment cities like Hamilton)
  if (['UP MOUNTAIN', 'UPMOUNTAIN', 'UP-MOUNTAIN', 'UPHILL', 'UP HILL', 'UP-HILL'].includes(upper)) return 'Up Mountain';
  if (['DOWN MOUNTAIN', 'DOWNMOUNTAIN', 'DOWN-MOUNTAIN', 'DOWNHILL', 'DOWN HILL', 'DOWN-HILL'].includes(upper)) return 'Down Mountain';

  // Bare Up/Down (inclines, funiculars, and anything without a valley/mountain framing)
  if (upper === 'UP') return 'Up';
  if (upper === 'DOWN') return 'Down';

  // Return original if no match (e.g. specific destination name)
  return input.trim();
}

/**
 * Return the direction encoded on a stop candidate, including directional
 * platform names such as "College Station - Northbound Platform".
 *
 * Normalized stop data usually has a separate direction field, but imported
 * platform records can carry the direction only in their display name.
 * @param {Object|null} candidate
 * @returns {string|null}
 */
function getStopCandidateDirection(candidate) {
  if (!candidate) return null;

  const explicit = normalizeDirection(candidate.direction);
  if (['Northbound', 'Southbound', 'Eastbound', 'Westbound'].includes(explicit)) {
    return explicit;
  }

  const label = [candidate.stopName, candidate.name].filter(Boolean).join(' ');
  const directionMatch = label.match(/\b(northbound|southbound|eastbound|westbound)\b/i);
  return directionMatch ? normalizeDirection(directionMatch[1]) : null;
}

/**
 * Build a rider-facing identity for a stop candidate. Punctuation-only name
 * differences should not create a second stop-choice option, but directional
 * variants must remain distinct.
 * @param {Object|null} candidate
 * @returns {string|null}
 */
function getStopCandidateKey(candidate) {
  if (!candidate) return null;
  const label = candidate.stopName || candidate.name;
  if (!label) return null;
  const nameKey = label.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const direction = getStopCandidateDirection(candidate) || '';
  return `${nameKey}|${direction.toLowerCase()}`;
}

/**
 * Collapse duplicate stop records that differ only in punctuation or spacing.
 * @param {Array} candidates
 * @returns {Array}
 */
function collapseEquivalentStopCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates || [];

  const chosen = new Map();
  for (const candidate of candidates) {
    const key = getStopCandidateKey(candidate);
    if (!key || !chosen.has(key)) {
      chosen.set(key || Symbol('candidate'), candidate);
      continue;
    }

    const current = chosen.get(key);
    const score = value =>
      (value?.stopCode ? 1 : 0) +
      (Array.isArray(value?.routes) && value.routes.length > 0 ? 1 : 0) -
      ((value?.stopName || '').match(/[^a-z0-9 ]/gi) || []).length * 0.01;
    if (score(candidate) > score(current)) chosen.set(key, candidate);
  }
  return [...chosen.values()];
}

/**
 * Generate a cryptographically secure random 6-digit code
 * @returns {string} 6-digit verification code
 */
function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Check if a route string is valid
 * @param {string} route - Route string to check
 * @returns {boolean} true if valid
 */
function isValidRoute(route) {
  if (!route) return false;

  // Clean up
  const cleanRoute = route.trim().replace(/\s+/g, ' ');
  const upper = cleanRoute.toUpperCase();

  if (INVALID_ROUTE_WORDS.has(upper)) return false;

  // Valid formats: "505", "510A", "510B", "GO1", "Line 1", "Line 2"
  if (/^[A-Z]{0,2}\d+[A-Z]?$/.test(upper)) return true;
  if (/^LINE\s*\d+$/.test(upper)) return true;

  // Named routes across agencies: "Orange", "Green Line", "Pacific Surfliner",
  // "Flagship Cruises & Events", "J Line", "506 Bus B", "Red Oakland-bound".
  // Keep this permissive enough for real multi-agency labels, but reject
  // obvious sentence fragments by limiting token count and character set.
  if (/^[A-Z0-9&./'() -]+$/i.test(cleanRoute)) {
    const tokens = cleanRoute.split(' ').filter(Boolean);
    const hasAlpha = /[A-Z]/i.test(cleanRoute);
    const hasReasonableTokenLengths = tokens.every(token => token.length <= 24);
    const isShortWordOnlyToken = tokens.length === 1 && /^[A-Z]+$/i.test(cleanRoute) && cleanRoute.length <= 2;
    if (
      hasAlpha &&
      tokens.length >= 1 &&
      tokens.length <= 5 &&
      hasReasonableTokenLengths &&
      !isShortWordOnlyToken
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Get display string for a stop (handles both code and name fields)
 * @param {string|null} stopCode - Stop code (numeric)
 * @param {string|null} stopName - Stop name (text)
 * @param {string|null} legacyStop - Legacy startStop/endStop field for backward compatibility
 * @returns {string} Display string for the stop
 */
function getStopDisplay(stopCode, stopName, legacyStop = null) {
  if (stopName) return stopName;
  if (stopCode) return stopCode;
  if (legacyStop) return legacyStop;
  return 'Unknown';
}

/**
 * Determine timing reliability based on prompt delay
 * @param {admin.firestore.Timestamp} stateExpiresAt - When the prompt expires (created + 5 mins)
 * @returns {string} Reliability classification
 */
function determineReliability(stateExpiresAt) {
  if (!stateExpiresAt) return 'actual';

  // prompt was created 5 mins before expiration
  const createdAtMs = stateExpiresAt.toDate().getTime() - (5 * 60 * 1000);
  const nowMs = Date.now();
  const delayMinutes = (nowMs - createdAtMs) / 1000 / 60;

  return delayMinutes > 2 ? 'delayed_start' : 'actual';
}

/**
 * Normalize a route identifier — uppercases trailing letter suffixes (e.g. "510a" → "510A")
 * @param {string} route - Raw route string
 * @returns {string} Normalized route
 */
function normalizeRoute(route) {
  if (!route) return route;
  const s = route.toString().trim();

  // Guard against extreme input length to provide baseline DoS protection
  if (s.length > 100) return s;

  // Only uppercase trailing letter suffixes on numeric routes (e.g. "510a" → "510A").
  // Named routes like "Lakeshore West" or "Lakeshore East" must not be uppercased.
  if (!/^\d/.test(s)) return s;

  // Find the index where trailing letters start (e.g., "510a" -> index 3)
  // We scan backwards to find the boundary in O(N) without backtracking risk.
  let i = s.length;
  while (i > 0 && /[a-zA-Z]/.test(s[i - 1])) {
    i--;
  }

  if (i === s.length) return s; // No trailing letters

  const base = s.slice(0, i);
  const suffix = s.slice(i);
  return base + suffix.toUpperCase();
}

/**
 * Get display string for a route, uppercasing any trailing letters (e.g. "510a" → "510A")
 * @param {string} route - Route identifier
 * @param {string|null} direction - Optional direction string
 * @returns {string} Display string for the route
 */
function getRouteDisplay(route, direction = null) {
  const r = normalizeRoute(route ? route.toString() : route);
  return direction ? `${r} ${direction}` : `${r}`;
}

/**
 * Normalize an agency name to its canonical stored form.
 * e.g. "Toronto Transit Commission", "toronto transit commission", "TTC" → "TTC"
 * @param {string} agency
 * @returns {string} Canonical agency name
 */
function normalizeAgency(agency) {
  if (!agency) return agency;
  return AGENCY_CANONICAL[agency.trim().toLowerCase()] || agency.trim();
}

/**
 * Normalize a route for prediction grading/stats comparisons.
 * TTC routes collapse to their leading digits (variants share a route number);
 * other agencies keep digit+letter suffixes uppercased, or single letters uppercased.
 *
 * This intentionally does NOT use ml_utils.normalizeRouteForMl — that function's
 * collapse policy applies to whichever agency is the caller's PRIMARY agency, but
 * grading always compares a prediction to the actual trip within the same agency,
 * so this stays hardcoded to TTC rather than needing a primaryAgency to be threaded in.
 * @param {string} route
 * @param {string} agency
 * @returns {string} Normalized route
 */
function normalizeRouteForGrading(route, agency) {
  const r = route.toString().trim();
  if (agency === 'TTC') return (r.match(/^(\d+)/) || [])[1] || r;
  const compact = r.match(/^(\d+)([a-zA-Z]+)$/);
  if (compact) return compact[1] + compact[2].toUpperCase();
  return /^[a-zA-Z]$/.test(r) ? r.toUpperCase() : r;
}

/**
 * Admins get every premium perk without needing isPremium set — this is the
 * one place that rule lives, so a new premium-gated feature can't ship
 * admin-locked-out by accident the way ASK and STATS trends both did.
 */
function hasPremiumAccess(profile, isAdmin) {
  return !!profile?.isPremium || !!isAdmin;
}

module.exports = {
  toTitleCase,
  escapeXml,
  normalizeDirection,
  getStopCandidateDirection,
  getStopCandidateKey,
  collapseEquivalentStopCandidates,
  normalizeRoute,
  normalizeRouteForGrading,
  normalizeAgency,
  generateVerificationCode,
  isValidRoute,
  getStopDisplay,
  getRouteDisplay,
  determineReliability,
  hasPremiumAccess,
};
