/**
 * TransferEngine — learns whether two consecutive trips are a journey transfer
 * or two separate trips, based on historical journey patterns.
 *
 * Changelog:
 *   v1 - Confidence scoring from historical transfers. Signals: stop pair match,
 *        route pair match, gap time vs historical average, time-of-day similarity.
 *        Cold start fallback: 15-minute hard limit when no history exists.
 *   v1.1 - NetworkEngine transfer index as a possibility signal. When no personal
 *          history matches, known network connections at the boarding stop boost
 *          confidence and extend the cold-start window from 15 → 20 min.
 */

const { areConnectedStops } = require('./transfer-connections');

const TransferEngine = {
  VERSION: '1.1.0',

  CONFIDENCE_THRESHOLD: 0.55, // Minimum confidence to auto-link

  /**
   * Extract historical transfer records from a set of completed trips.
   * Finds consecutive pairs within journeys (shared journeyId) and
   * returns the features of each real transfer.
   *
   * @param {Array} trips - Completed trips with journeyId, endTime, startTime, etc.
   * @param {Object} [stopsLibrary] - Normalized stops library for hub resolution
   * @returns {Array} Transfer records: { routeA, routeB, endStop, startStop, gap, hour, dayOfWeek, endHubId, startHubId }
   */
  extractTransfers(trips, stopsLibrary = null) {
    const journeys = {};
    for (const trip of trips) {
      if (!trip.journeyId || !trip.endTime || !trip.startTime) continue;
      if (!journeys[trip.journeyId]) journeys[trip.journeyId] = [];
      journeys[trip.journeyId].push(trip);
    }

    const transfers = [];
    for (const journeyTrips of Object.values(journeys)) {
      if (journeyTrips.length < 2) continue;

      journeyTrips.sort((a, b) => {
        const ta = a.startTime?.toDate ? a.startTime.toDate() : new Date(a.startTime);
        const tb = b.startTime?.toDate ? b.startTime.toDate() : new Date(b.startTime);
        return ta - tb;
      });

      for (let i = 0; i < journeyTrips.length - 1; i++) {
        const prev = journeyTrips[i];
        const next = journeyTrips[i + 1];

        if (!prev.endTime || !next.startTime || !prev.endStopName || !next.startStopName) continue;

        const prevEnd = prev.endTime?.toDate ? prev.endTime.toDate() : new Date(prev.endTime);
        const nextStart = next.startTime?.toDate ? next.startTime.toDate() : new Date(next.startTime);
        const gap = (nextStart - prevEnd) / 60000;

        if (gap < 0 || gap > 120) continue;

        // Resolve Hub IDs via library if available
        let endHubId = null;
        let startHubId = null;
        if (stopsLibrary) {
          const prevStop = Object.values(stopsLibrary).find(s => 
            (s.code && s.code === prev.endStopCode) || 
            (s.name.toLowerCase() === prev.endStopName.toLowerCase())
          );
          const nextStop = Object.values(stopsLibrary).find(s => 
            (s.code && s.code === next.startStopCode) || 
            (s.name.toLowerCase() === next.startStopName.toLowerCase())
          );
          endHubId = prevStop?.hubId || null;
          startHubId = nextStop?.hubId || null;
        }

        transfers.push({
          routeA: prev.route?.toString(),
          routeB: next.route?.toString(),
          agencyA: prev.agency || null,
          agencyB: next.agency || null,
          endStop: prev.endStopName,
          startStop: next.startStopName,
          endHubId,
          startHubId,
          gap,
          hour: nextStart.getHours(),
          dayOfWeek: nextStart.getDay(),
        });
      }
    }

    return transfers;
  },

  /**
   * Suggest candidate connected stop pairs from repeated real transfers.
   * This is evidence only — callers can review/promote candidates into the
   * canonical transfer-complex map later.
   *
   * @param {Array} trips - Completed trips with journeyId, endTime, startTime, etc.
   * @param {Object} [options]
   * @param {number} [options.minCount=3] - Minimum repeated observations
   * @param {number} [options.maxMedianGap=12] - Maximum median gap in minutes
   * @returns {Array} Sorted suggestions with count/gap/route-pair evidence
   */
  suggestConnectedPairs(trips, { minCount = 3, maxMedianGap = 12 } = {}) {
    const transfers = this.extractTransfers(trips);
    const groups = new Map();

    for (const transfer of transfers) {
      const a = transfer.endStop;
      const b = transfer.startStop;
      if (!a || !b) continue;
      if (this._stopMatch(a, b)) continue;

      const key = this._pairKey(a, b);
      let group = groups.get(key);
      if (!group) {
        const [stopA, stopB] = this._sortedPair(a, b);
        group = {
          stopA,
          stopB,
          counts: 0,
          gaps: [],
          routePairs: new Map(),
        };
        groups.set(key, group);
      }

      group.counts += 1;
      group.gaps.push(transfer.gap);
      const routeKey = `${transfer.routeA || '?'} -> ${transfer.routeB || '?'}`;
      group.routePairs.set(routeKey, (group.routePairs.get(routeKey) || 0) + 1);
    }

    return Array.from(groups.values())
      .map(group => {
        const sortedGaps = group.gaps.slice().sort((a, b) => a - b);
        const medianGap = this._median(sortedGaps);
        const topRoutePairs = Array.from(group.routePairs.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([routePair, count]) => ({ routePair, count }));
        return {
          stopA: group.stopA,
          stopB: group.stopB,
          count: group.counts,
          medianGap,
          minGap: sortedGaps[0],
          maxGap: sortedGaps[sortedGaps.length - 1],
          topRoutePairs,
        };
      })
      .filter(row => row.count >= minCount && row.medianGap <= maxMedianGap)
      .sort((a, b) => b.count - a.count || a.medianGap - b.medianGap);
  },

  /**
   * Score whether a candidate (prevTrip → nextTrip) is a journey transfer.
   *
   * @param {Object} prevTrip - The trip that just ended
   * @param {Object} nextTrip - The trip that just started
   * @param {Array} history - Recent completed trips to learn from (ideally 50+)
   * @param {Object|null} networkConnections - Transfer index for nextTrip's boarding stop
   *   ({ [fromRoute_to_toRoute]: count }) from NetworkEngine.getConnectionsAtStop()
   * @returns {number} Confidence score 0–1
   */
  score(prevTrip, nextTrip, history, networkConnections = null) {
    if (!prevTrip.endTime || !nextTrip.startTime) return 0;

    const prevEnd = prevTrip.endTime?.toDate ? prevTrip.endTime.toDate() : new Date(prevTrip.endTime);
    const nextStart = nextTrip.startTime?.toDate ? nextTrip.startTime.toDate() : new Date(nextTrip.startTime);
    const gap = (nextStart - prevEnd) / 60000;

    // Hard limits
    if (gap < 0 || gap > 90) return 0;

    const prevEndStop = prevTrip.endStopName;
    const nextStartStop = nextTrip.startStopName || nextTrip.startStop;
    const prevEndHubId = prevTrip.endHubId;
    const nextStartHubId = nextTrip.startHubId;
    const routeA = prevTrip.route?.toString();
    const routeB = nextTrip.route?.toString();
    const agencyA = prevTrip.agency || null;
    const agencyB = nextTrip.agency || null;
    const hour = nextStart.getHours();

    const transfers = this.extractTransfers(history);

    // Cold start — no history to learn from
    if (transfers.length === 0) {
      const connKey = `${this._normalizeKey(routeA)}_to_${this._normalizeKey(routeB)}`;
      const networkCount = networkConnections ? (networkConnections[connKey] || 0) : 0;
      
      // Check if they are at the same hub even without history
      const sameHub = prevEndHubId && nextStartHubId && prevEndHubId === nextStartHubId;
      
      // Known network connection or same Hub extends the window slightly
      const limit = (networkCount >= 2 || sameHub) ? 20 : 15;
      const baseConfidence = sameHub ? 0.65 : 0.6;
      
      return gap <= limit ? baseConfidence : 0;
    }

    // Stop pair matches (by Name or HubId)
    const stopPairMatches = transfers.filter(t => {
      if (t.agencyA && !this._sameAgency(t.agencyA, agencyA)) return false;
      if (t.agencyB && !this._sameAgency(t.agencyB, agencyB)) return false;
      const hubMatch = (prevEndHubId && t.endHubId && prevEndHubId === t.endHubId) &&
                       (nextStartHubId && t.startHubId && nextStartHubId === t.startHubId);
      
      const nameMatch = this._stopMatch(t.endStop, prevEndStop) &&
                        this._stopMatch(t.startStop, nextStartStop);
                        
      return hubMatch || nameMatch;
    });

    // Route pair matches
    const routePairMatches = transfers.filter(t =>
      t.routeA === routeA && t.routeB === routeB &&
      (!t.agencyA || this._sameAgency(t.agencyA, agencyA)) &&
      (!t.agencyB || this._sameAgency(t.agencyB, agencyB))
    );

    let confidence = 0;

    if (stopPairMatches.length > 0) {
      const gaps = stopPairMatches.map(t => t.gap);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const maxGap = Math.max(...gaps);

      confidence += 0.4; // Stop pair has been a real transfer before

      if (gap <= avgGap * 1.5) confidence += 0.25; // Within typical range
      else if (gap <= maxGap * 1.2) confidence += 0.1; // Within extended range

      if (routePairMatches.length > 0) confidence += 0.2; // Route pair also matches

      // Time-of-day similarity
      const hourMatches = stopPairMatches.filter(t => Math.abs(t.hour - hour) <= 2);
      if (hourMatches.length > 0) confidence += 0.1;

    } else if (routePairMatches.length > 0) {
      // Route pair matches but not at the same stops
      const gaps = routePairMatches.map(t => t.gap);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

      confidence += 0.25;
      if (gap <= avgGap * 1.5) confidence += 0.15;

    } else {
      // No historical pattern — check NetworkEngine transfer index
      const connKey = `${this._normalizeKey(routeA)}_to_${this._normalizeKey(routeB)}`;
      const networkCount = networkConnections ? (networkConnections[connKey] || 0) : 0;

      if (networkCount >= 2) {
        // This route pair is known to connect at this stop — population-level prior
        if (gap <= 10) confidence = 0.60;
        else if (gap <= 20) confidence = 0.45;
        else if (gap <= 30) confidence = 0.25;
        else confidence = 0;
      } else {
        if (gap <= 10) confidence = 0.5;
        else if (gap <= 20) confidence = 0.3;
        else confidence = 0;
      }
    }

    return Math.min(confidence, 1.0);
  },

  _normalizeKey(s) {
    if (!s) return '';
    return s.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  },

  _sameAgency(a, b) {
    return a != null && b != null && a.toString().trim().toLowerCase() === b.toString().trim().toLowerCase();
  },

  _sortedPair(a, b) {
    return [a, b].sort((x, y) => this._normalizeKey(x).localeCompare(this._normalizeKey(y)));
  },

  _pairKey(a, b) {
    const [left, right] = this._sortedPair(a, b);
    return `${this._normalizeKey(left)}::${this._normalizeKey(right)}`;
  },

  _median(values) {
    if (!values || values.length === 0) return 0;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0
      ? (values[mid - 1] + values[mid]) / 2
      : values[mid];
  },

  /**
   * Normalize and compare two stop names.
   * Strips punctuation/spaces before comparing.
   */
  _stopMatch(a, b) {
    if (!a || !b) return false;
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalize(a) === normalize(b) || areConnectedStops(a, b);
  },
};

module.exports = { TransferEngine };
