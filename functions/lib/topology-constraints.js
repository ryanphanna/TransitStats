function normalizeStopLabel(name) {
  if (!name) return null;
  return name.trim().toLowerCase()
    .replace(/\s*[/&@]\s*/g, '/')
    .replace(/\s+at\s+/g, '/');
}

// Both sides of every comparison are reduced the same way: the plain normalized label, and (when a
// canonicalizer is supplied, e.g. the stops library) its canonical form. "College" and "College
// Station" then meet at the library's canonical name instead of only matching literally.
function labelKeys(label, options = {}) {
  const keys = new Set();
  const plain = normalizeStopLabel(label);
  if (plain) {
    keys.add(plain);
    // Subway lines list bare names ("College", "St. Clair West") while trips say "College Station"
    // or "St.Clair West Station": spacing, punctuation and a trailing "Station" never decide a match.
    const compact = value => value.replace(/[^a-z0-9/]/g, '');
    keys.add(compact(plain));
    const bare = plain.replace(/\s+station$/, '');
    if (bare && bare !== plain) keys.add(compact(bare));
  }
  let canon = null;
  if (options.canonicalizeStop && label) {
    // Canonicalizing scans the stops library, so each distinct label is resolved once per call.
    const cache = options._canonCache || (options._canonCache = new Map());
    if (!cache.has(label)) cache.set(label, options.canonicalizeStop(label));
    canon = cache.get(label);
  }
  const normalizedCanon = canon ? normalizeStopLabel(canon) : null;
  if (normalizedCanon && normalizedCanon !== 'unknown') keys.add(normalizedCanon);
  return keys;
}

function sharesKey(a, b) {
  for (const key of a) if (b.has(key)) return true;
  return false;
}

function normalizeDirection(direction) {
  if (!direction) return null;
  const dir = direction.toString().toLowerCase().replace(/bound$/, '').trim();
  if (['south', 's', 'sb'].includes(dir)) return 'Southbound';
  if (['north', 'n', 'nb'].includes(dir)) return 'Northbound';
  if (['east', 'e', 'eb'].includes(dir)) return 'Eastbound';
  if (['west', 'w', 'wb'].includes(dir)) return 'Westbound';
  return null;
}

function defaultBaseRoute(route) {
  const routeStr = route?.toString().trim();
  if (!routeStr) return '';
  return routeStr.replace(/^(\d+).*/, '$1');
}

function getLine(topology, route, options = {}) {
  if (!topology || !route) return null;
  const routeStr = (options.baseRoute || defaultBaseRoute)(route.toString());
  const lines = topology.lines || {};

  const exact = lines[routeStr];
  if (exact && (!options.agency || exact.network === options.agency)) return exact;

  const lower = routeStr.toLowerCase();
  for (const line of Object.values(lines)) {
    if (options.agency && line.network !== options.agency) continue;
    if ((line.route_aliases || []).some(alias => alias.toLowerCase() === lower)) return line;
  }
  return null;
}

function stopIndex(line, stopName, options = {}) {
  if (!line || !stopName) return -1;
  const wanted = labelKeys(stopName, options);

  for (let i = 0; i < (line.stops || []).length; i++) {
    const canon = line.stops[i];
    const names = [canon, ...((line.aliases && line.aliases[canon]) || [])];
    for (const variant of (line.directional_stops && line.directional_stops[canon]) || []) {
      names.push(variant.name, ...(variant.aliases || []));
    }
    if (names.filter(Boolean).some(name => sharesKey(labelKeys(name, options), wanted))) return i;
  }

  return -1;
}

function goingHigherForDirection(line, boardingIdx, direction) {
  const normDir = normalizeDirection(direction);
  if (!line || boardingIdx < 0 || !normDir) return null;

  if (line.name === 'Yonge-University') {
    const unionIdx = stopIndex(line, 'Union');
    if (unionIdx === -1 || boardingIdx === unionIdx) return null;
    return boardingIdx <= unionIdx ? normDir === 'Southbound' : normDir === 'Northbound';
  }

  if (line.direction_order) {
    if (normDir === line.direction_order.forward) return true;
    if (normDir === line.direction_order.reverse) return false;
    return null;
  }

  return normDir === 'Eastbound' || normDir === 'Northbound';
}

function stopLabels(line, canon, direction, options = {}) {
  const normDir = normalizeDirection(direction);
  const variants = (line.directional_stops && line.directional_stops[canon]) || [];
  const names = variants.length > 0
    ? variants
      .filter(variant => !variant.directions || variant.directions.includes(normDir))
      .flatMap(variant => [variant.name, ...(variant.aliases || [])])
    : [canon, ...((line.aliases && line.aliases[canon]) || [])];
  return names.filter(Boolean).flatMap(name => [...labelKeys(name, options)]);
}

function platformCompatible(line, stopName, direction, options = {}) {
  if (!line || !stopName || !direction) return true;
  const normDir = normalizeDirection(direction);
  const wanted = labelKeys(stopName, options);
  if (!normDir || wanted.size === 0) return true;

  for (const canon of line.stops || []) {
    const variants = (line.directional_stops && line.directional_stops[canon]) || [];
    if (variants.length === 0) continue;

    let matchedVariant = false;
    let compatibleVariant = false;
    for (const variant of variants) {
      const labels = new Set([variant.name, ...(variant.aliases || [])]
        .filter(Boolean)
        .flatMap(name => [...labelKeys(name, options)]));
      if (sharesKey(labels, wanted)) {
        matchedVariant = true;
        if (!variant.directions || variant.directions.includes(normDir)) compatibleVariant = true;
      }
    }
    if (matchedVariant) return compatibleVariant;
  }

  return true;
}

function getConstraint(topology, context, options = {}) {
  const route = context?.route;
  const boardingStop = context?.startStopName || context?.boardingStop;
  const direction = context?.direction;
  if (!topology || !route || !boardingStop || !direction) return { source: 'none', legalStops: null };

  const line = getLine(topology, route, options);
  if (!line) return { source: 'none', legalStops: null };

  const boardingIdx = stopIndex(line, boardingStop, options);
  if (boardingIdx === -1) return { source: 'none', legalStops: null };

  const goingHigher = goingHigherForDirection(line, boardingIdx, direction);
  if (goingHigher === null) return { source: 'none', legalStops: null };

  const legalStops = new Set();
  for (let i = 0; i < (line.stops || []).length; i++) {
    if (goingHigher ? i > boardingIdx : i < boardingIdx) {
      for (const label of stopLabels(line, line.stops[i], direction, options)) {
        legalStops.add(label);
      }
    }
  }

  return { source: 'topology', legalStops, routeCovered: true, line };
}

function stopAllowedByConstraint(stopName, constraint, options = {}) {
  if (!constraint?.legalStops || !stopName) return false;
  return [...labelKeys(stopName, options)].some(label => constraint.legalStops.has(label));
}

function filterCandidatesByConstraint(candidates, constraint, options = {}) {
  return candidates.filter(candidate => {
    const stopName = options.getStopName ? options.getStopName(candidate) : candidate.stop || candidate.endStop || candidate.endStopName;
    return stopAllowedByConstraint(stopName, constraint, options);
  });
}

function filterCandidatesByPlatform(candidates, topology, route, direction, options = {}) {
  const line = getLine(topology, route, options);
  if (!line) return candidates;
  return candidates.filter(candidate => {
    const stopName = options.getStopName ? options.getStopName(candidate) : candidate.stop || candidate.endStop || candidate.endStopName;
    return platformCompatible(line, stopName, direction, options);
  });
}

function getMask(topology, route, boardingStop, direction, classes, options = {}) {
  if (!topology || !route || !boardingStop || !direction || !classes) return null;
  const line = getLine(topology, route, options);
  if (!line) return null;

  const boardingIdx = stopIndex(line, boardingStop, options);
  const goingHigher = goingHigherForDirection(line, boardingIdx, direction);
  if (boardingIdx === -1 || goingHigher === null) return null;

  const mask = classes.map(cls => {
    const idx = stopIndex(line, cls, options);
    if (idx === -1) return false;
    return (goingHigher ? idx > boardingIdx : idx < boardingIdx) && platformCompatible(line, cls, direction, options);
  });

  return mask.some(Boolean) ? mask : null;
}

function combineMasks(primaryMask, secondaryMask) {
  if (!primaryMask) return secondaryMask || null;
  if (!secondaryMask) return primaryMask;

  const combined = primaryMask.map((keep, index) => keep && secondaryMask[index]);
  return combined.some(Boolean) ? combined : primaryMask;
}

module.exports = {
  combineMasks,
  filterCandidatesByConstraint,
  filterCandidatesByPlatform,
  getConstraint,
  getLine,
  getMask,
  labelKeys,
  normalizeDirection,
  normalizeStopLabel,
  platformCompatible,
  stopAllowedByConstraint,
  stopIndex,
  stopLabels,
};
