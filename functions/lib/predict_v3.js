/**
 * TransitStats Prediction Engine V3 (Heuristic Voting)
 *
 * Runs in parallel with V4 and V5 (Shadow Mode).
 * Uses weighted voting over historical trips with recency, time, day, and sequence signals.
 *
 * History:
 *   v1 - Additive point scoring across 5 signals (location, sequence, time, day, frequency).
 *   v2 - Stop-first filtering with multiplicative weighted voting.
 *   v3 - Stop canonicalization, distance-based day similarity, trip validity filter.
 *   topology filter - Post-inference for subway/LRT end stop predictions.
 */

let _topology = null;
try { _topology = require('./topology.json'); } catch (e) { /* topology filter disabled */ }

const { NetworkEngine } = require('./network');
const TopologyConstraints = require('./topology-constraints');

const PredictionEngineV3 = {
  VERSION: '3.4.1',

  CONFIG: {
    TIME_SIGMA_HOURS: 1.5,
    DECAY_HALFLIFE_RIDES: 100, // rides on same agency at which a trip's weight halves
    SEQUENCE_WINDOW_HOURS: 3,
    SEQUENCE_BOOST: 1.5,
  },

  /**
   * Stops library used for name canonicalization.
   * Each entry: { name: string, aliases: string[] }
   */
  stopsLibrary: [],

  /**
   * Learned network graph for the current trip's route/agency.
   * Set before calling guessEndStop / guessTopEndStops.
   * When set, used to narrow end-stop candidates inside authoritative
   * topology/GTFS-derived constraints.
   */
  networkGraph: null,

  /**
   * Guess the next route given the current stop and time.
   * @param {Array} history - Completed trips (should exclude the trip being evaluated)
   * @param {Object} context - { stopName, time, routesAtStop?, lastEndStopName?, agency? }
   *   routesAtStop: optional array of routeShortNames known to serve this stop.
   *   lastEndStopName: optional name of the stop where the user just finished a trip.
   * @returns {Object|null} { route, direction, stop, confidence, version }
   */
  guess: function (history, context) {
    if (!history || history.length === 0) return null;

    const now = context.time instanceof Date ? context.time : new Date(context.time);
    const stopName = context.stopName ? context.stopName.trim().toLowerCase() : null;

    let candidates = stopName
      ? history.filter(t => this._isValidTrip(t) && this._stopMatch(t.startStopName, stopName))
      : history.filter(t => this._isValidTrip(t));

    if (context.agency) {
      candidates = candidates.filter(t => this._sameAgency(t.agency, context.agency));
    }

    if (candidates.length === 0) return null;

    if (context.routesAtStop && context.routesAtStop.length > 0) {
      const validFamilies = new Set(context.routesAtStop.map(r => this._baseRoute(r.toString())));
      const filtered = candidates.filter(t => validFamilies.has(this._baseRoute(t.route)));
      if (filtered.length > 0) candidates = filtered;
    }

    // Determine sequence context
    const atTransferPoint = context.lastEndStopName 
      ? this._stopMatch(context.lastEndStopName, stopName)
      : (this._getLastRecentTrip(history, now) && this._stopMatch(this._getLastRecentTrip(history, now).endStopName, stopName));

    const ridesAfterMap = this._computeRidesAfter(history);

    const votes = {};
    let totalWeight = 0;

    for (const trip of candidates) {
      const tripTime = trip.startTime && trip.startTime.toDate
        ? trip.startTime.toDate()
        : new Date(trip.startTime);

      const normDir = this._normalizeDirection(trip.direction);
      // Group by route family so 510, 510a, 510b pool votes rather than splitting signal.
      const family = this._baseRoute(trip.route);
      const key = `${family}|${normDir || ''}`;
      const weight =
        this._recencyWeight(ridesAfterMap.get(trip) || 0) *
        this._timeSimilarity(now, tripTime) *
        this._daySimilarity(now.getDay(), tripTime.getDay()) *
        (atTransferPoint ? this.CONFIG.SEQUENCE_BOOST : 1.0);

      if (!votes[key]) {
        votes[key] = {
          family,
          direction: normDir || null,
          stop: trip.startStopName,
          weight: 0,
          specificRoutes: {},
        };
      }
      votes[key].weight += weight;
      totalWeight += weight;
      const routeKey = trip.route.toString().trim();
      votes[key].specificRoutes[routeKey] = (votes[key].specificRoutes[routeKey] || 0) + weight;
    }

    if (totalWeight === 0) return null;

    const sorted = Object.values(votes).sort((a, b) => b.weight - a.weight);
    const top = sorted[0];

    const bestSpecific = Object.entries(top.specificRoutes)
      .sort((a, b) => b[1] - a[1])[0][0];

    return {
      route: bestSpecific,
      routeFamily: top.family,
      direction: top.direction,
      stop: top.stop,
      confidence: Math.round((top.weight / totalWeight) * 100),
      version: this.VERSION,
    };
  },

  /**
   * Predict the most likely exit stop given a known route and boarding stop.
   * @param {Array} history - Completed trips
   * @param {Object} context - { route, startStopName, direction, time, duration?, lastEndStopName? }
   * @returns {Object|null} { stop, confidence, version }
   */
  guessEndStop: function (history, context) {
    const top = this.guessTopEndStops(history, context, 1);
    return top.length > 0 ? top[0] : null;
  },

  /**
   * Return the top N predicted exit stops, ranked by weight.
   * Same voting logic as guessEndStop but returns an array.
   * @param {Array} history - Completed trips
   * @param {Object} context - { route, startStopName, direction, time, duration?, lastEndStopName? }
   * @param {number} topN - Number of predictions to return (default 3)
   * @returns {Array} Array of { stop, confidence, version }, highest confidence first
   */
  guessTopEndStops: function (history, context, topN = 3) {
    if (!history || history.length === 0) return [];

    const now = context.time instanceof Date ? context.time : new Date(context.time);
    const routeFamily = this._baseRoute(context.route);
    const normDir = context.direction ? this._normalizeDirection(context.direction) : null;
    const startStopName = context.startStopName ? context.startStopName.trim().toLowerCase() : null;

    let candidates = history.filter(t => {
      if (!this._isValidTrip(t)) return false;
      if (!t.endStopName) return false;
      if (context.agency && !this._sameAgency(t.agency, context.agency)) return false;
      return this._baseRoute(t.route) === routeFamily &&
        this._stopMatch(t.startStopName, startStopName);
    });

    if (candidates.length === 0) return [];

    if (normDir) {
      const withDir = candidates.filter(t => {
        const tDir = this._normalizeDirection(t.direction);
        return !tDir || tDir === normDir;
      });
      if (withDir.length > 0) candidates = withDir;
    }

    // Determine sequence context
    const atTransferPoint = context.lastEndStopName 
      ? this._stopMatch(context.lastEndStopName, startStopName)
      : (this._getLastRecentTrip(history, now) && this._stopMatch(this._getLastRecentTrip(history, now).endStopName, startStopName));

    // Pre-filter: remove trips that ended at a physically impossible stop.
    candidates = this._preFilterCandidatesByTopology(candidates, context.route, startStopName, context.direction);

    const ridesAfterMap = this._computeRidesAfter(history);
    const votes = {};
    let totalWeight = 0;

    for (const trip of candidates) {
      const tripTime = trip.startTime && trip.startTime.toDate
        ? trip.startTime.toDate()
        : new Date(trip.startTime);

      const weight =
        this._recencyWeight(ridesAfterMap.get(trip) || 0) *
        this._timeSimilarity(now, tripTime) *
        this._daySimilarity(now.getDay(), tripTime.getDay()) *
        (context.duration && trip.duration ? this._durationSimilarity(context.duration, trip.duration) : 1.0) *
        (atTransferPoint ? this.CONFIG.SEQUENCE_BOOST : 1.0);

      const key = this._canonicalizeStop(trip.endStopName);
      if (!votes[key]) votes[key] = { stop: trip.endStopName, weight: 0 };
      votes[key].weight += weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return [];

    const sorted = Object.values(votes).sort((a, b) => b.weight - a.weight);
    return sorted.slice(0, topN).map(v => ({
      stop: v.stop,
      confidence: Math.round((v.weight / totalWeight) * 100),
      version: this.VERSION,
    }));
  },

  /**
   * Extract the base route number from a numeric variant like "510a", "510b", "510 Shuttle".
   * Only strips suffixes when the route starts with a digit, so numeric routes pool correctly
   * ("510a" → "510", "52g" → "52") while word-based routes like "Line 1" are left as-is.
   */
  _baseRoute: function (route) {
    const s = route.toString().trim();
    // Only strip suffixes if it starts with a digit. 
    // This allows pooling "510a" and "510 Shuttle" into data for "510".
    if (!/^\d/.test(s)) return s;
    const match = s.match(/^\d+/);
    return match ? match[0] : s;
  },

  _normalizeDirection: function (dir) {
    if (!dir) return null;
    const d = dir.toString().toLowerCase().replace(/bound$/i, '').trim();
    if (d === 'n' || d === 'nb' || d === 'north') return 'Northbound';
    if (d === 's' || d === 'sb' || d === 'south') return 'Southbound';
    if (d === 'e' || d === 'eb' || d === 'east' || d === 'eastward') return 'Eastbound';
    if (d === 'w' || d === 'wb' || d === 'west') return 'Westbound';
    return dir.trim();
  },

  /**
   * Returns false for trips with obviously malformed data (bad SMS parses, sentence-as-stop-name, etc.)
   */
  _isValidTrip: function (trip) {
    const stop = trip.startStopName || trip.startStop;
    const route = trip.route;
    if (!stop || !route) return false;

    const stopStr = stop.toString();
    if (stopStr.length > 60) return false;
    const sentenceWords = /\b(i'm|i am|just|boarded|headed|northbound|southbound|eastbound|westbound)\b/i;
    if (sentenceWords.test(stopStr)) return false;

    const routeStr = route.toString().trim();
    if (routeStr.length <= 4 && !/\d/.test(routeStr) && !/^line\s*\d/i.test(routeStr)) return false;

    return true;
  },

  /**
   * Resolve a stop name to its canonical form using the stops library.
   */
  _canonicalizeStop: function (name) {
    if (!name) return null;
    const lower = name.trim().toLowerCase()
      .replace(/\s*[/&@]\s*/g, '/')
      .replace(/\s+at\s+/g, '/');
    if (this.stopsLibrary && this.stopsLibrary.length > 0) {
      const match = this.stopsLibrary.find(s => {
        const candidates = [s.name, ...(s.aliases || [])];
        return candidates.some(c => c.trim().toLowerCase()
          .replace(/\s*[/&@]\s*/g, '/')
          .replace(/\s+at\s+/g, '/') === lower);
      });
      if (match) return match.name.toLowerCase().replace(/\s*[/&@]\s*/g, '/').replace(/\s+at\s+/g, '/');
    }
    return lower;
  },

  _stopMatch: function (a, b) {
    if (!a || !b) return false;
    return this._canonicalizeStop(a) === this._canonicalizeStop(b);
  },

  _sameAgency: function (a, b) {
    return a != null && b != null && a.toString().trim().toLowerCase() === b.toString().trim().toLowerCase();
  },

  // Pre-compute per-trip ride counts: for each trip, how many same-agency
  // trips occurred after it. O(n) single pass from newest to oldest.
  _computeRidesAfter: function (history) {
    const sorted = [...history].sort((a, b) => {
      const ta = a.startTime?.toDate ? a.startTime.toDate() : new Date(a.startTime || 0);
      const tb = b.startTime?.toDate ? b.startTime.toDate() : new Date(b.startTime || 0);
      return ta - tb;
    });
    const agencyCount = {};
    const ridesAfter = new Map();
    for (let i = sorted.length - 1; i >= 0; i--) {
      const trip = sorted[i];
      const agency = trip.agency || 'unknown';
      ridesAfter.set(trip, agencyCount[agency] || 0);
      agencyCount[agency] = (agencyCount[agency] || 0) + 1;
    }
    return ridesAfter;
  },

  _recencyWeight: function (ridesAfter) {
    const lambda = Math.log(2) / this.CONFIG.DECAY_HALFLIFE_RIDES;
    return Math.exp(-lambda * ridesAfter);
  },

  _timeSimilarity: function (now, tripTime) {
    const nowHour = now.getHours() + now.getMinutes() / 60;
    const tripHour = tripTime.getHours() + tripTime.getMinutes() / 60;
    let diff = Math.abs(nowHour - tripHour);
    if (diff > 12) diff = 24 - diff;
    return Math.exp(-(diff ** 2) / (2 * this.CONFIG.TIME_SIGMA_HOURS ** 2));
  },

  _daySimilarity: function (nowDay, tripDay) {
    if (nowDay === tripDay) return 1.0;
    const isWeekend = d => d === 0 || d === 6;
    const nowIsWeekend = isWeekend(nowDay);
    const tripIsWeekend = isWeekend(tripDay);
    if (nowIsWeekend !== tripIsWeekend) return 0.1;
    if (nowIsWeekend) return 0.7;
    // Both weekdays: closer days score higher
    const dist = Math.abs(nowDay - tripDay); // 1–4
    return 1.0 - dist * 0.15;
  },

  _durationSimilarity: function (actualMinutes, pastMinutes) {
    const diff = Math.abs(actualMinutes - pastMinutes);
    return Math.exp(-(diff * diff) / (2 * 25)); // sigma = 5 minutes
  },

  _getLastRecentTrip: function (history, now) {
    return history.find(t => {
      if (!t.endTime) return false;
      const end = t.endTime.toDate ? t.endTime.toDate() : new Date(t.endTime);
      const hoursSince = (now - end) / (1000 * 60 * 60);
      return hoursSince > 0 && hoursSince < this.CONFIG.SEQUENCE_WINDOW_HOURS;
    });
  },

  /**
   * Pre-filter historical trip candidates to only those that ended at a topologically valid stop.
   * Called before voting so the model never scores impossible destinations.
   * Falls back to the unfiltered array if topology doesn't cover this route/stop/direction.
   * @param {Array} candidates - Trip objects with endStopName
   * @param {string} route
   * @param {string} boardingStop
   * @param {string} direction
   * @returns {Array}
   */
  _preFilterCandidatesByTopology: function (candidates, route, boardingStop, direction) {
    if (!boardingStop || !direction) return candidates;

    const constraint = this.getEndStopConstraint({ route, startStopName: boardingStop, direction });
    if (constraint.source === 'topology' || constraint.source === 'topology+network') {
      candidates = TopologyConstraints.filterCandidatesByConstraint(candidates, constraint, {
        canonicalizeStop: this._canonicalizeStop.bind(this),
        getStopName: t => t.endStopName,
      });
    }

    if (constraint.source === 'network' || constraint.source === 'topology+network') {
      const filtered = NetworkEngine.filterCandidates(candidates, this.networkGraph, boardingStop, direction);
      candidates = filtered !== null
        ? TopologyConstraints.filterCandidatesByPlatform(filtered, _topology, route, direction, {
          baseRoute: this._baseRoute.bind(this),
          getStopName: t => t.endStopName,
        })
        : candidates;
    }

    return candidates;
  },

  /**
   * Filter predicted end stops to only those that are directionally valid per subway topology.
   * Only applies to linear lines (2, 4, 5). Line 1 excluded — U-shape.
   * Falls back to unfiltered array if topology doesn't cover this route/stop.
   * @param {Array} candidates - Array of { stop, weight, ... }
   * @param {string} route
   * @param {string} boardingStop
   * @param {string} direction
   * @returns {Array}
   */
  _applyTopologyFilter: function (candidates, route, boardingStop, direction) {
    const constraint = this.getEndStopConstraint({ route, startStopName: boardingStop, direction });
    if (constraint.source !== 'topology' || !constraint.legalStops) return candidates;
    return TopologyConstraints.filterCandidatesByConstraint(candidates, constraint, {
      canonicalizeStop: this._canonicalizeStop.bind(this),
      getStopName: c => c.stop,
    });
  },

  /**
   * Describe the physical destination constraint for a given boarding context.
   * Returns the source that would constrain predictions and the legal downstream
   * stop set when that source is authoritative.
   *
   * @param {Object} context - { route, startStopName, direction }
   * @returns {{source: string, legalStops: Set<string>|null, routeCovered?: boolean}}
   */
  getEndStopConstraint: function (context) {
    const boardingStop = context?.startStopName;
    const direction = context?.direction;
    const route = context?.route;
    if (!boardingStop || !direction || !route) return { source: 'none', legalStops: null };

    const normDir = this._normalizeDirection(direction);
    if (!normDir) return { source: 'none', legalStops: null };

    const topologyConstraint = TopologyConstraints.getConstraint(_topology, { route, startStopName: boardingStop, direction }, {
      baseRoute: this._baseRoute.bind(this),
      canonicalizeStop: this._canonicalizeStop.bind(this),
    });

    if (this.networkGraph) {
      const augGraph = NetworkEngine._withTransitiveEdges(this.networkGraph);
      const reachable = NetworkEngine._getReachableStops(augGraph, boardingStop, normDir);
      if (reachable) {
        if (topologyConstraint.source === 'topology') {
          return { ...topologyConstraint, source: 'topology+network', networkStops: reachable };
        }
        return { source: 'network', legalStops: reachable, routeCovered: true };
      }
    }

    return topologyConstraint;
  },

};

module.exports = { PredictionEngineV3 };
