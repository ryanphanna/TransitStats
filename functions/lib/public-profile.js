/**
 * Public profile stats endpoint.
 *
 * The `trips` collection is never publicly readable (see firestore.rules) because
 * each document carries userId, route, and exact timestamps that a public
 * profile page has no business exposing. This endpoint reads trips with the
 * Admin SDK and returns only aggregate stats plus coordinates and usage counts
 * for the map.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { db, getUserProfile, getStopsLibrary } = require('./db');
const logger = require('./logger');
const { getMapStopMode } = require('./profile-fields');
const { resolveAtlasAgency } = require('../atlas-agency');
const { buildHeatmapBands } = require('./public-profile-heatmap');
const { unmatchedImportedRides } = require('./ride-merge');
const { buildPrestoTrips } = require('./presto-trips');

const ACTIVE_TRIP_WINDOW_MS = 6 * 60 * 60 * 1000;
const ATLAS_R2_BASE = process.env.ATLAS_R2_BASE || 'https://data.transitatlas.fyi';
const atlasRouteCache = new Map();
const ATLAS_ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function getAtlasRoutes(agency) {
  const cached = atlasRouteCache.get(agency);
  if (cached && Date.now() - cached.fetchedAt < ATLAS_ROUTE_CACHE_TTL_MS) return cached.data;
  const slug = await resolveAtlasAgency(agency);
  if (!slug) return [];
  const response = await fetch(`${ATLAS_R2_BASE}/atlas/${slug}.json`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Atlas route data unavailable for ${agency}`);
  const data = await response.json();
  const features = (data.features || []).map(feature => ({ ...feature, __agency: agency }));
  atlasRouteCache.set(agency, { fetchedAt: Date.now(), data: features });
  return features;
}

async function buildPublicHeatmap(trips) {
  const agencies = [...new Set(trips.map(trip => trip.agency || 'TTC'))];
  const routeFeatures = [];
  for (const agency of agencies) {
    try {
      routeFeatures.push(...await getAtlasRoutes(agency));
    } catch (error) {
      logger.warn('Public profile heatmap route lookup failed', { agency, error: error.message });
    }
  }
  return buildHeatmapBands(trips, routeFeatures);
}

function isDashboardHistoryTrip(trip, now = Date.now()) {
  if (trip.endTime || trip.discarded) return true;
  const startTime = trip.startTime?.toDate ? trip.startTime.toDate() : new Date(trip.startTime);
  return Number.isFinite(startTime.getTime()) && now - startTime.getTime() >= ACTIVE_TRIP_WINDOW_MS;
}

function normalizeStopLabel(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function stopBelongsToAgency(stop, agency) {
  const candidates = [...new Set(stop?.agencies || (stop?.agency ? [stop.agency] : []))]
    .map(value => String(value).trim().toLowerCase());
  const target = String(agency || '').trim().toLowerCase();
  if (!target || candidates.length === 0) return true;
  return candidates.some(candidate => candidate === target
    || (candidate === 'go' && target === 'go transit')
    || (candidate === 'go transit' && target === 'go'));
}

function validStopLocation(stop) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng ?? stop?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return null;
  return { lat, lng };
}

function uniquePrestoStopCandidates(record, stops) {
  const target = normalizeStopLabel(record.locationLabel || record.location);
  if (!target) return [];
  const candidates = new Map();

  for (const stop of stops) {
    if (!stopBelongsToAgency(stop, record.agency)) continue;
    const labels = [stop.code, stop.name, ...(stop.aliases || [])]
      .filter(Boolean)
      .map(normalizeStopLabel);
    if (!labels.includes(target)) continue;

    const location = validStopLocation(stop);
    const agency = String(stop.agency || (stop.agencies || [])[0] || '').toLowerCase();
    const code = normalizeStopLabel(stop.code);
    const key = code
      ? `${agency}:code:${code}`
      : `${agency}:label:${normalizeStopLabel(stop.name)}:${location?.lat?.toFixed(5) || ''}:${location?.lng?.toFixed(5) || ''}`;
    const candidate = {
      name: stop.name || stop.stopName || stop.code || null,
      location,
    };
    const existing = candidates.get(key);
    if (!existing || (!existing.location && location)) candidates.set(key, candidate);
  }

  return [...candidates.values()];
}

const AGENCY_COUNTRIES = new Map([
  ...['TTC', 'GO', 'GO Transit', 'MiWay', 'YRT', 'Brampton Transit', 'Durham Transit', 'HSR', 'GRT', 'Grand River Transit', 'OC Transpo', 'STM', 'TransLink', 'Oakville Transit', 'GTAA Terminal Link', 'Flagship Cruises & Events', 'Exo', 'CDPQ Infra', 'Niagara Region Transit'].map(agency => [agency.toLowerCase(), 'Canada']),
  ...['NYC MTA', 'New York City Transit', 'LA Metro', 'LADOT', 'Los Angeles Department of Transportation', 'Big Blue Bus', 'BART', 'Muni', 'Caltrain', 'VTA', 'AC Transit', 'SamTrans', 'MTS', 'Amtrak', 'Golden Gate Transit', 'SMART', 'Santa Rosa CityBus', 'CDTA', 'NFTA Metro', 'TriMet', 'C-Tran', 'Sound Transit', 'King County Metro', 'Utah Transit Authority', 'Sacramento Regional Transit', 'GCRTA'].map(agency => [agency.toLowerCase(), 'United States']),
  ...['RATP', 'SNCF Transilien'].map(agency => [agency.toLowerCase(), 'France']),
  ...['TMB'].map(agency => [agency.toLowerCase(), 'Spain']),
]);

function buildStopLocationIndex(stops = []) {
  const index = new Map();
  const add = (key, location) => {
    if (key && !index.has(key)) index.set(key, location);
  };

  for (const stop of stops) {
    const lat = Number(stop.lat);
    const lng = Number(stop.lng ?? stop.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) continue;

    const labels = [stop.name, stop.stopName, stop.code, ...(stop.aliases || [])]
      .map(normalizeStopLabel)
      .filter(Boolean);
    const agencies = [stop.agency, ...(stop.agencies || [])]
      .map(normalizeStopLabel)
      .filter(Boolean);
    const location = { lat, lng };
    labels.forEach(label => {
      add(`*:${label}`, location);
      agencies.forEach(agency => add(`${agency}:${label}`, location));
    });
  }
  return index;
}

function resolveTripLocation(location, stopName, agency, stopIndex) {
  const savedLat = Number(location?.lat);
  const savedLng = Number(location?.lng ?? location?.lon);
  if (Number.isFinite(savedLat) && Number.isFinite(savedLng) && savedLat !== 0 && savedLng !== 0) {
    return { lat: savedLat, lng: savedLng };
  }

  const label = normalizeStopLabel(stopName);
  if (!label || !stopIndex) return null;
  return stopIndex.get(`${normalizeStopLabel(agency)}:${label}`)
    || stopIndex.get(`*:${label}`)
    || null;
}

async function handlePublicProfile(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  // Public profile data can be briefly stale; allowing intermediary caching
  // avoids repeating the Firestore aggregation for every new device.
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET');
    res.status(204).send('');
    return;
  }

  const requestedUsername = String(req.query.user || '').trim().toLowerCase();
  const includeHeatmap = String(req.query.includeHeatmap || '') === '1';
  const includePoints = String(req.query.includePoints || '1') !== '0';
  const resolveStops = String(req.query.resolveStops || '1') !== '0';
  if (!requestedUsername) {
    res.status(400).json({ error: 'Missing user parameter' });
    return;
  }

  try {
    let username = requestedUsername;
    let usernameDoc = await db.collection('usernames').doc(username).get();
    if (!usernameDoc.exists && username.includes('-')) {
      username = username.replace(/-/g, '_');
      usernameDoc = await db.collection('usernames').doc(username).get();
    }
    if (!usernameDoc.exists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const userId = usernameDoc.data().uid;

    const profile = await getUserProfile(userId);
    if (!profile || !profile.isPublic) {
      res.status(403).json({ error: 'This profile is private' });
      return;
    }
    // The public profile switch is the permission boundary. Once the profile
    // is public, expose the same history as the signed-in map through the
    // aggregate-only response below. Individual trip documents remain private.
    const [tripsSnap, prestoSnap, stopsSnap] = await Promise.all([
      db.collection('trips').where('userId', '==', userId).get(),
      db.collection('prestoTransactions').where('userId', '==', userId).get(),
      db.collection('stops').get(),
    ]);
    const historyTrips = [];
    const nowMs = Date.now();
    tripsSnap.forEach((doc) => {
      const trip = doc.data();
      if (isDashboardHistoryTrip(trip, nowMs)) historyTrips.push(trip);
    });
    const prestoRecords = prestoSnap.docs
      .map(doc => doc.data())
      .filter(record => record.type === 'fare_payment');
    const stops = stopsSnap.docs.map(doc => doc.data());

    let totalMinutes = 0;
    let last30Days = 0;
    let last7Days = 0;
    const riddenDays = new Set();
    const agencies = new Set();
    const routes = new Set();
    const countries = new Set();
    const pointsByStop = new Map();
    let stopIndex = null;
    let stopIndexPromise = null;
    const getStopIndex = async () => {
      if (!resolveStops) return null;
      if (!stopIndexPromise) {
        stopIndexPromise = getStopsLibrary().then(buildStopLocationIndex);
      }
      stopIndex = await stopIndexPromise;
      return stopIndex;
    };
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const addPoint = (location, type, name) => {
      if (location?.lat == null || location?.lng == null) return;
      const lat = Number(location.lat);
      const lng = Number(location.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const key = `${type}:${lat}:${lng}`;
      const existing = pointsByStop.get(key);
      if (existing) {
        existing.usage += 1;
        if (name) existing.names = existing.names ? [...new Set([...existing.names, name])] : [name];
        return;
      }
      pointsByStop.set(key, {
        lat,
        lng,
        type,
        usage: 1,
        ...(name ? { names: [name] } : {}),
      });
    };
    for (const trip of historyTrips) {
      totalMinutes += trip.duration || 0;
      const tripDate = trip.startTime?.toDate ? trip.startTime.toDate() : new Date(trip.startTime);
      if (!Number.isNaN(tripDate.getTime())) {
        riddenDays.add(`${tripDate.getFullYear()}-${tripDate.getMonth()}-${tripDate.getDate()}`);
        if (tripDate >= thirtyDaysAgo) last30Days += 1;
        if (tripDate >= sevenDaysAgo) last7Days += 1;
      }
      const agency = String(trip.agency || '').trim();
      const route = String(trip.route || '').trim();
      if (route) routes.add(route.toLowerCase());
      if (agency) {
        agencies.add(agency.toLowerCase());
        const country = AGENCY_COUNTRIES.get(agency.toLowerCase());
        if (country) countries.add(country);
      }
      if (includePoints) {
        const boardingLocation = resolveTripLocation(
          trip.boardingLocation || trip.boardLocation,
          trip.startStopName || trip.startStop,
          trip.agency,
          stopIndex,
        ) || await resolveTripLocation(
          trip.boardingLocation || trip.boardLocation,
          trip.startStopName || trip.startStop,
          trip.agency,
          await getStopIndex(),
        );
        const exitLocation = resolveTripLocation(
          trip.exitLocation,
          trip.endStopName || trip.endStop,
          trip.agency,
          stopIndex,
        ) || await resolveTripLocation(
          trip.exitLocation,
          trip.endStopName || trip.endStop,
          trip.agency,
          await getStopIndex(),
        );
        addPoint(boardingLocation, 'start');
        addPoint(exitLocation, 'end');
      }
    }

    const heatmapBands = includeHeatmap ? await buildPublicHeatmap(historyTrips) : undefined;

    // Rides the user also logged as trips are already counted above.
    const prestoTrips = unmatchedImportedRides(historyTrips, buildPrestoTrips(prestoRecords));

    prestoTrips.forEach((trip) => {
      const { startRecord, endRecord } = trip;
      const tripDate = Number.isFinite(Number(startRecord.occurredAtSortKey))
        ? new Date(Number(startRecord.occurredAtSortKey))
        : new Date(startRecord.occurredAtLocal);
      if (!Number.isNaN(tripDate.getTime())) {
        riddenDays.add(`${tripDate.getFullYear()}-${tripDate.getMonth()}-${tripDate.getDate()}`);
        if (tripDate >= thirtyDaysAgo) last30Days += 1;
        if (tripDate >= sevenDaysAgo) last7Days += 1;
      }

      const agency = String(trip.agency || '').trim();
      if (agency) {
        agencies.add(agency.toLowerCase());
        const country = AGENCY_COUNTRIES.get(agency.toLowerCase());
        if (country) countries.add(country);
      }

      // Only uniquely resolved PRESTO locations are exposed. Ambiguous
      // directional candidates remain stored but do not get guessed publicly.
      const startCandidates = uniquePrestoStopCandidates(startRecord, stops);
      if (startCandidates.length === 1) {
        addPoint(startCandidates[0].location, 'start', startCandidates[0].name);
      }
      if (endRecord) {
        const endCandidates = uniquePrestoStopCandidates(endRecord, stops);
        if (endCandidates.length === 1) {
          addPoint(endCandidates[0].location, 'end', endCandidates[0].name);
        }
      }
    });

    res.status(200).json({
      displayName: profile.displayName || profile.name || null,
      username: profile.username || null,
      canonicalUsername: profile.username || requestedUsername,
      emoji: profile.emoji || null,
      defaultAgency: profile.defaultAgency || null,
      mapStopMode: getMapStopMode(profile),
      totalTrips: historyTrips.length + prestoTrips.length,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      // Keep the existing response keys for clients that have not refreshed yet.
      thisMonth: last30Days,
      thisWeek: last7Days,
      daysRidden: riddenDays.size,
      agencies: agencies.size,
      routes: routes.size,
      countries: countries.size,
      points: includePoints ? [...pointsByStop.values()] : [],
      ...(includeHeatmap ? { heatmapBands } : {}),
    });
  } catch (err) {
    logger.error('Public profile lookup failed', { error: err.message, username: requestedUsername });
    res.status(500).json({ error: 'Internal error' });
  }
}

async function getPublicProfilePayload(username, {
  includeHeatmap = false,
  includePoints = true,
  resolveStops = true,
} = {}) {
  const result = { statusCode: 200, body: null };
  const response = {
    set: () => response,
    status: code => {
      result.statusCode = code;
      return response;
    },
    json: body => {
      result.body = body;
      return response;
    },
    send: body => {
      result.body = body;
      return response;
    },
  };
  await handlePublicProfile({
    method: 'GET',
    query: {
      user: username,
      ...(includeHeatmap ? { includeHeatmap: '1' } : {}),
      ...(includePoints ? {} : { includePoints: '0' }),
      ...(resolveStops ? {} : { resolveStops: '0' }),
    },
  }, response);
  return result;
}

exports.publicProfile = onRequest({ concurrency: 80, maxInstances: 10 }, handlePublicProfile);
exports.getPublicProfilePayload = getPublicProfilePayload;
