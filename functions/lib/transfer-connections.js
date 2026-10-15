/**
 * Curated transfer-complex connections for reasoning layers like TransferEngine.
 *
 * Stops remain distinct records. This file only declares when separate stops
 * should count as the same rider-meaningful transfer point for journey linking.
 */

const CONNECTION_GROUPS = {
  college_complex: [
    'College',
    'College Station',
    'College St at Yonge St - College Station',
  ],
  queens_park_complex: [
    'Queen\'s Park',
    'Queen\'s Park Station',
    'College St at University Ave - Queen\'s Park Station',
  ],
  spadina_complex: [
    'Spadina',
    'Spadina Station',
  ],
  union_complex: [
    'Union',
    'Union Station',
  ],
  king_complex: [
    'King',
    'King Station',
    'Adelaide St West at Yonge St - King Station',
  ],
  dundas_west_complex: [
    'Dundas West',
    'Dundas West Station',
  ],
  broadview_complex: [
    'Broadview',
    'Broadview Station',
  ],
  bathurst_complex: [
    'Bathurst',
    'Bathurst Station',
  ],
  main_street_complex: [
    'Main Street',
    'Main Street Station',
  ],
  bloor_yonge_complex: [
    'Bloor-Yonge',
    'Bloor-Yonge Station',
  ],
  cedarvale_complex: [
    'Cedarvale',
    'Cedarvale Station',
  ],
  keelesdale_complex: [
    'Keelesdale',
    'Keelesdale Station',
  ],
  st_george_complex: [
    'St George',
    'St George Station',
  ],
  lawrence_west_complex: [
    'Lawrence West',
    'Lawrence West Station',
  ],
  sheppard_yonge_complex: [
    'Sheppard-Yonge',
    'Sheppard-Yonge Station',
  ],
  osgoode_complex: [
    'Osgoode',
    'Osgoode Station',
  ],
};

const CONNECTED_STOP_PAIRS = [
  ['College / Bay', 'College Station'],
  ['College Station', 'College / Yonge'],
  ['Spadina / Queens Quay', 'Spadina / Queens Quay West'],
  ['Spadina / Harbord', 'Harbord / Spadina'],
  ['Queen St West at Spadina Ave', 'Spadina Ave at Queen St West North Side'],
  ['Queen St E / Carlaw', 'Carlaw / Queen St E'],
  ['Dufferin / Lawrence', 'Lawrence / Dufferin'],
  ['Dufferin / College', 'College / Dufferin'],
];

// Canonical stop-library names whose variants all count as one transfer point: a label connects
// to another when both resolve (through the stops library) to a record with this name, e.g. a
// code-prefixed or misspelled alias of the record. Not connection groups, so stop lookup by
// group is unaffected.
const SAME_STOP_NAMES = [
  'Spadina / King',
  'Dufferin / College',
  'Dundas / Sterling',
];

// Entries above use canonical stop-library names. Variants a rider actually texts (stop-code
// prefixes, typos) are not listed here: they resolve through the stops library, where they live
// as aliases of the record they name. Kept exported (empty) for older callers.
const STOP_NAME_ALIASES = {};

function normalizeStopName(name) {
  if (!name) return '';
  const normalized = name.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return STOP_NAME_ALIASES[normalized] || normalized;
}

// normalized name/alias -> Set of normalized canonical names of the library records that carry it.
const libraryIndexCache = new WeakMap();

function getLibraryIndex(stopsLibrary) {
  if (!Array.isArray(stopsLibrary) || stopsLibrary.length === 0) return null;
  let index = libraryIndexCache.get(stopsLibrary);
  if (index) return index;
  index = new Map();
  for (const stop of stopsLibrary) {
    if (!stop || !stop.name) continue;
    const canonical = normalizeStopName(stop.name);
    if (!canonical) continue;
    for (const label of [stop.name, ...(stop.aliases || [])]) {
      const key = normalizeStopName(label);
      if (!key) continue;
      let set = index.get(key);
      if (!set) index.set(key, (set = new Set()));
      set.add(canonical);
    }
  }
  libraryIndexCache.set(stopsLibrary, index);
  return index;
}

/**
 * Lookup keys for a stop label: its own normalized form, plus the normalized canonical name of
 * every stops-library record that lists the label as its name or an alias. Only used to look up
 * the connection tables below, never as general stop equality.
 */
function stopLookupKeys(name, stopsLibrary = null) {
  const own = normalizeStopName(name);
  if (!own) return [];
  const index = getLibraryIndex(stopsLibrary);
  const canonical = index ? index.get(own) : null;
  if (!canonical) return [own];
  return [own, ...[...canonical].filter(key => key !== own)];
}

const stopToGroup = new Map();
for (const [groupId, stops] of Object.entries(CONNECTION_GROUPS)) {
  for (const stop of stops) stopToGroup.set(normalizeStopName(stop), groupId);
}

const connectedPairKeys = new Set();
for (const [a, b] of CONNECTED_STOP_PAIRS) {
  const na = normalizeStopName(a);
  const nb = normalizeStopName(b);
  if (!na || !nb) continue;
  connectedPairKeys.add(`${na}::${nb}`);
  connectedPairKeys.add(`${nb}::${na}`);
}
for (const name of SAME_STOP_NAMES) {
  const key = normalizeStopName(name);
  if (key) connectedPairKeys.add(`${key}::${key}`);
}

function getConnectionGroups(stopName, stopsLibrary = null) {
  const groups = new Set();
  for (const key of stopLookupKeys(stopName, stopsLibrary)) {
    const group = stopToGroup.get(key);
    if (group) groups.add(group);
  }
  return groups;
}

/** First connection group a label belongs to (its own spelling first, then library canonical names). */
function getConnectionGroup(stopName, stopsLibrary = null) {
  const [first] = getConnectionGroups(stopName, stopsLibrary);
  return first || null;
}

/**
 * @param {string} a
 * @param {string} b
 * @param {Array} [stopsLibrary] - stops library ({ name, aliases }) used to resolve texted variants
 */
function areConnectedStops(a, b, stopsLibrary = null) {
  if (!a || !b) return false;
  const keysA = stopLookupKeys(a, stopsLibrary);
  const keysB = stopLookupKeys(b, stopsLibrary);
  for (const ka of keysA) {
    for (const kb of keysB) {
      if (connectedPairKeys.has(`${ka}::${kb}`)) return true;
    }
  }
  const groupsB = getConnectionGroups(b, stopsLibrary);
  for (const group of getConnectionGroups(a, stopsLibrary)) {
    if (groupsB.has(group)) return true;
  }
  return false;
}

module.exports = {
  CONNECTION_GROUPS,
  CONNECTED_STOP_PAIRS,
  SAME_STOP_NAMES,
  STOP_NAME_ALIASES,
  normalizeStopName,
  stopLookupKeys,
  getConnectionGroup,
  getConnectionGroups,
  areConnectedStops,
};
