/**
 * Message parsing logic for transit trip tracking
 */
const { KNOWN_AGENCIES, AGENCY_CANONICAL } = require('./constants');
const { toTitleCase, normalizeDirection, normalizeRoute, normalizeAgency } = require('./utils');

const CANONICAL_DIRECTIONS = new Set([
  'Northbound', 'Southbound', 'Eastbound', 'Westbound',
  'Clockwise', 'Counterclockwise', 'Inbound', 'Outbound',
  'Up Valley', 'Down Valley',
  'Up Mountain', 'Down Mountain',
]);

const KNOWN_AGENCY_NAMES = new Map([
  ...KNOWN_AGENCIES.map((name) => [name.toLowerCase(), normalizeAgency(name)]),
  ...Object.entries(AGENCY_CANONICAL),
]);

// Spacing, case and stray punctuation never decide whether something is a known agency
// ("GO  Transit", "TTC.", "T.T.C." all match).
function agencyKey(text) {
  return String(text || '').toLowerCase().replace(/[.,;:!]/g, '').replace(/\s+/g, ' ').trim();
}

/** The canonical agency for a line only when it is a known agency name or alias; otherwise null. */
function resolveKnownAgency(text) {
  const key = agencyKey(text);
  return key ? KNOWN_AGENCY_NAMES.get(key) || null : null;
}

// Direction-like words that are not compass bounds but are never an agency.
const EXTRA_DIRECTION_WORDS = new Map([['downtown', 'Downtown'], ['uptown', 'Uptown']]);

// Long direction words that a hurried text ("Northa", "Sout") is probably a slip for.
const LOOSE_DIRECTION_WORDS = [
  ['northbound', 'Northbound'], ['southbound', 'Southbound'], ['eastbound', 'Eastbound'], ['westbound', 'Westbound'],
  ['north', 'Northbound'], ['south', 'Southbound'], ['east', 'Eastbound'], ['west', 'Westbound'],
  ['inbound', 'Inbound'], ['outbound', 'Outbound'], ['clockwise', 'Clockwise'],
];

// Optimal-string-alignment distance (one typo, including a swapped pair, costs 1).
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * Direction from an exact word or a near miss of a long direction word. A near miss must start with
 * the same letter AND be a cut-off of the word ("Sou", "Northa", "Eastb"; at least 3 letters) or,
 * for words of 5+ letters, one typo away ("Sotuh"). So "Test", "Fast", "Worth" and "Easy" are not
 * directions. Anything else returns null.
 */
function looseDirection(text) {
  const exact = normalizeDirection(text);
  // normalizeDirection hands unknown text back as-is, so only recognized directions count.
  if (CANONICAL_DIRECTIONS.has(exact)) return exact;
  const word = agencyKey(text).replace(/\s+/g, '');
  if (EXTRA_DIRECTION_WORDS.has(word)) return EXTRA_DIRECTION_WORDS.get(word);
  if (!/^[a-z]{3,}$/.test(word)) return null;
  for (const [candidate, direction] of LOOSE_DIRECTION_WORDS) {
    if (word[0] !== candidate[0]) continue;
    if (candidate.startsWith(word)) return direction;
    if (word.length >= 5 && editDistance(word, candidate) <= 1) return direction;
  }
  return null;
}

/**
 * Parse stop input to determine if it's a stop code (all digits) or stop name (contains letters)
 * @param {string} input - The stop input string
 * @returns {object} Object with stopCode and stopName fields (only one will be set)
 */
function parseStopInput(input) {
  if (!input) return { stopCode: null, stopName: null };
  const trimmed = input.trim();
  if (!trimmed) return { stopCode: null, stopName: null };

  // Check if the input is all digits (ignoring spaces, e.g., "123 45" -> "12345")
  const withoutSpaces = trimmed.replace(/\s+/g, '');
  if (/^\d+$/.test(withoutSpaces)) {
    return { stopCode: withoutSpaces, stopName: null };
  }
  // Contains letters - it's a stop name
  return { stopCode: null, stopName: toTitleCase(trimmed) };
}

/**
 * Parse multi-line trip format
 * @param {string} body - Message body
 * @param {string} defaultAgency - User's default agency
 * @returns {object|null} Parsed trip data or null if invalid
 */
function parseMultiLineTripFormat(body, defaultAgency) {
  // Guard against non-string input
  if (typeof body !== 'string') {
    return null;
  }

  let lines = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  // Need at least route and stop (lines 1 and 2)
  if (lines.length < 2) {
    return null;
  }

  // Support explicit START prefix:
  // START
  // 2
  // Kipling
  // West
  if (lines[0].toUpperCase() === 'START' && lines.length >= 3) {
    lines = lines.slice(1);
  }

  // If first line is another command, don't parse as trip
  const firstLineUpper = lines[0].toUpperCase();
  if (['END', 'STATUS', 'DISCARD', 'INFO', '?', 'HELP', 'STOP'].includes(firstLineUpper)) {
    return null;
  }

  const route = normalizeRoute(lines[0]);
  let vehicle = null;

  // Extract vehicle if explicitly provided on any line (e.g. "Vehicle 7109")
  const vehicleRegex = /^(?:v|vehicle)[\s:]+([^:\s].*)$/i;
  lines = lines.filter((line, index) => {
    if (index === 0) return true; // First line is always route
    const vMatch = line.match(vehicleRegex);
    if (vMatch) {
      vehicle = vMatch[1].trim();
      return false;
    }
    return true;
  });

  const line2Direction = normalizeDirection(lines[1]);
  const line3Direction = lines.length >= 3 ? normalizeDirection(lines[2]) : null;

  // Support both:
  // 1. route / stop / direction
  // 2. route / direction / stop
  const isRouteDirectionStop =
    lines.length >= 3 &&
    CANONICAL_DIRECTIONS.has(line2Direction) &&
    !CANONICAL_DIRECTIONS.has(line3Direction);

  const stop = toTitleCase(isRouteDirectionStop ? lines[2] : lines[1]);
  let direction = null;
  let agency = defaultAgency;
  let agencyExplicit = false;

  if (isRouteDirectionStop) {
    direction = line2Direction;
    if (lines.length > 3) {
      const potentialAgency = lines[3].trim();
      if (potentialAgency) {
        agency = resolveKnownAgency(potentialAgency) || normalizeAgency(potentialAgency);
        agencyExplicit = true;
      }
    }
  } else if (lines.length >= 3) {
    if (CANONICAL_DIRECTIONS.has(line3Direction)) {
      direction = line3Direction;
    } else {
      // Known agency (or alias) wins, then a direction (exact or near-miss like "Northa");
      // anything else is stored as typed.
      const knownAgency = resolveKnownAgency(lines[2]);
      const looseDir = knownAgency ? null : looseDirection(lines[2]);
      if (knownAgency) {
        agency = knownAgency;
        agencyExplicit = true;
      } else if (looseDir) {
        direction = looseDir;
      } else {
        // Not a known agency or a direction: keep what was typed (riders use systems outside the list).
        agency = normalizeAgency(lines[2]);
        agencyExplicit = true;
      }
    }
    if (lines.length > 3) {
      const potentialAgency = lines[3].trim();
      if (potentialAgency) {
        agency = resolveKnownAgency(potentialAgency) || normalizeAgency(potentialAgency);
        agencyExplicit = true;
      }
    }
  }

  // Reject if route/stop don't look like actual transit data (e.g. a freeform question)
  if (!isHeuristicLogValid(stop, route)) {
    return null;
  }

  let finalStop = stop;

  // If vehicle wasn't found as a line, check if it's in the stop name
  if (!vehicle) {
    const inlineV = extractVehicleFromStop(stop);
    finalStop = inlineV.cleanStop;
    vehicle = inlineV.vehicle;
  }

  return {
    route,
    stop: finalStop,
    direction,
    agency,
    agencyExplicit,
    vehicle,
  };
}

/**
 * Helper to extract vehicle info from within a stop name string (e.g. "Union (Vehicle 123)")
 */
function extractVehicleFromStop(stopName) {
  const vehicleRegex = /\s*\((?:v|vehicle)(?:\s+number)?[\s:]+([^:\s][^)]*)\)/i;
  const match = stopName.match(vehicleRegex);
  if (match) {
    return {
      cleanStop: stopName.replace(vehicleRegex, '').trim(),
      vehicle: match[1].trim()
    };
  }
  return { cleanStop: stopName, vehicle: null };
}

/**
 * Parse common natural-language trip format:
 * "I'm on the 510 from Spadina and Nassau"
 * @param {string} body
 * @param {string} defaultAgency
 * @returns {object|null}
 */
function parseCasualTripFormat(body, defaultAgency) {
  if (typeof body !== 'string') return null;

  const trimmed = body.trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  const match = trimmed.match(
    /^(?:i\s*(?:'m|am)\s+on\s+(?:the\s+)?)((?:[a-z]{1,2}\d+[a-z]?|\d+[a-z]?))\s+from\s+(.{1,100})$/i
  );
  if (!match) return null;

  const route = normalizeRoute(match[1]);
  const stop = toTitleCase(match[2]);

  if (!isHeuristicLogValid(stop, route)) return null;

  return {
    route,
    stop,
    direction: null,
    agency: defaultAgency,
    agencyExplicit: false,
  };
}

/**
 * Parse multi-line END trip format
 * @param {string} body - Message body
 * @returns {object|null} Parsed end trip data or null if not an END command
 */
function parseEndTripFormat(body) {
  // Guard against non-string input
  if (typeof body !== 'string') {
    return null;
  }

  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  // First line must be "END" or "STOP"
  if (lines.length === 0 || !['END', 'STOP'].includes(lines[0].toUpperCase())) {
    return null;
  }

  // Just "END" - no stop provided
  if (lines.length < 2) {
    return { isEnd: true, stop: null, route: null, notes: null };
  }

  // Format:
  // Line 1: END/STOP
  // Line 2: Stop Name
  // Line 3+: Notes
  const stop = lines[1];
  const notes = lines.length > 2 ? lines.slice(2).join('\n') : null;

  return {
    isEnd: true,
    stop,
    route: null, // Deprecated route verification in favor of simple stop + notes
    notes,
  };
}

/**
 * Parse agency override from end of message
 * @param {string} message - The full message
 * @returns {object} { agency: string|null, remainingMessage: string }
 */
function parseAgencyOverride(message) {
  const trimmed = message.trim();
  const lowerMessage = trimmed.toLowerCase();

  // Check each known agency name or alias (case-insensitive), longest first so "GO Transit" wins over "GO".
  const names = [...KNOWN_AGENCY_NAMES.keys()].sort((x, y) => y.length - x.length);
  for (const name of names) {
    // Check if message is exactly the agency name or ends with [whitespace][agency]
    // The regex \s covers spaces, newlines, and tabs.
    const pattern = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    if (lowerMessage === name || pattern.test(lowerMessage)) {
      // Remove agency from end of message
      const remainingMessage = lowerMessage === name ?
        '' :
        trimmed.slice(0, -(name.length + 1)).trim();

      // If there's no actual message left, this wasn't an override (e.g. they just sent "TTC")
      if (remainingMessage.length === 0) {
        return { agency: null, remainingMessage: trimmed };
      }

      // Return the canonical agency name
      return { agency: KNOWN_AGENCY_NAMES.get(name), remainingMessage };
    }
  }

  return { agency: null, remainingMessage: trimmed };
}

/**
 * Check if the input likely contains a trip log with heuristic parsing
 * @param {string} stopCodeRaw - raw stop name/code
 * @param {string} routeRaw - raw route number
 * @returns {boolean} true if it looks valid
 */
function isHeuristicLogValid(stopCodeRaw, routeRaw) {
  if (!stopCodeRaw || !routeRaw || typeof stopCodeRaw !== 'string' || typeof routeRaw !== 'string') {
    return false;
  }

  // 1. Sentence Starters: Reject if stop name starts with unlikely conversation starters
  // Heavily reduced list to avoid blocking "The"
  const sentenceStarters = ['I', 'IM', 'I\'M', 'ILL', 'I\'LL', 'HELLO', 'HI', 'HEY', 'PLEASE', 'THANKS', 'TO', 'ROUTE'];
  const firstWord = stopCodeRaw.split(' ')[0].toUpperCase();
  const isSentenceStart = sentenceStarters.includes(firstWord);

  // 2. Sentence Structure: Reject if text contains obvious motion sentences
  const sentencePattern = /\b(headed to|going to|im at|i am at|moving towards)\b/i;
  const isSentenceStructure = sentencePattern.test(stopCodeRaw) || sentencePattern.test(routeRaw);

  // 3. Bad Stop Names
  const badStopNames = ['BUS', 'STREETCAR', 'TRAIN', 'SUBWAY'];
  const isBadStopName = badStopNames.includes(firstWord);

  // 4. Length checks
  const isStopTooLong = stopCodeRaw.length > 60;
  const isRouteTooLong = routeRaw.length > 30; // Routes are usually short codes

  // Only accept if it passes all heuristics
  return (
    stopCodeRaw.length > 0 &&
    routeRaw.length > 0 &&
    !isSentenceStart &&
    !isSentenceStructure &&
    !isBadStopName &&
    !isStopTooLong &&
    !isRouteTooLong
  );
}

/**
 * Parse single-line trip format: "[route] [stop] [direction]"
 * e.g. "510 Spadina/College North" or "47 Lansdowne / Dupont South"
 * @param {string} body - Message body (must be a single line)
 * @param {string} defaultAgency - User's default agency
 * @returns {object|null} Parsed trip data or null if not a match
 */
function parseSingleLineTripFormat(body, defaultAgency) {
  if (typeof body !== 'string') return null;

  const trimmed = body.trim();

  // Only handle single-line messages
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length !== 1) return null;

  const DIRECTION_WORDS = new Set([
    'N', 'NB', 'NORTH', 'NORTHBOUND', 'NORTHWARD',
    'S', 'SB', 'SOUTH', 'SOUTHBOUND', 'SOUTHWARD',
    'E', 'EB', 'EAST', 'EASTBOUND', 'EASTWARD',
    'W', 'WB', 'WEST', 'WESTBOUND', 'WESTWARD',
    'CW', 'CLOCKWISE', 'CCW', 'COUNTERCLOCKWISE',
    'IB', 'IN', 'INBOUND', 'OB', 'OUT', 'OUTBOUND',
  ]);

  const words = trimmed.split(/\s+/);
  if (words.length < 3) return null; // Need at least route + stop + direction

  // First word is the route
  const route = normalizeRoute(words[0]);
  if (!route) return null;

  // Last word must be a direction — without it we can't distinguish from other formats
  const lastWord = words[words.length - 1].toUpperCase();
  if (!DIRECTION_WORDS.has(lastWord)) return null;

  const direction = normalizeDirection(words[words.length - 1]);
  const stopWords = words.slice(1, -1);
  if (stopWords.length === 0) return null;

  let stop = toTitleCase(stopWords.join(' '));
  // Check for vehicle info in single-line stop text
  const inlineV = extractVehicleFromStop(stop);
  stop = inlineV.cleanStop;
  const vehicle = inlineV.vehicle;

  if (!isHeuristicLogValid(stop, route)) return null;

  return { route, stop, direction, agency: defaultAgency, agencyExplicit: false, vehicle };
}

module.exports = {
  parseStopInput,
  parseMultiLineTripFormat,
  parseSingleLineTripFormat,
  parseCasualTripFormat,
  parseEndTripFormat,
  parseAgencyOverride,
  isHeuristicLogValid,
};
