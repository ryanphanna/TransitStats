/**
 * HabitEngine — learns recurring trip patterns from history.
 *
 * A "habit" is a (stop, route, direction) triplet that recurs in the same
 * part of the week (weekday or weekend) and time-of-day bucket. When a
 * boarding matches a known habit with sufficient confidence, the engine
 * returns its usual end stop directly without needing to run V4/V5.
 *
 * Changelog:
 *   v1 - Habit extraction from trip history, match scoring, Firestore persistence.
 *        Confidence = count score × recency decay × time-window precision.
 *   v2 - Never fired in v1 (habits had no agency, so serving's agency filter dropped
 *        them all; exact-weekday × 2h buckets never reached the 0.75 threshold).
 *        Now: agency stored on habits; day/hour in the agency's local time instead of
 *        server UTC; weekday/weekend × 4h buckets; confidence measures how often the
 *        group ended at its usual end stop (smoothed), × recency. Old-schema
 *        records are ignored until the next rebuild. Tuned with ml/eval (see ml/EVAL.md).
 */

const { AGENCY_TIMEZONE } = require('./constants');

const DEFAULT_TIMEZONE = 'America/Toronto';
const _formatters = {};

const HabitEngine = {
  VERSION: '2.0.0',
  SCHEMA: 2,                  // Records without this schema are ignored by match()

  CONFIDENCE_THRESHOLD: 0.6,  // Minimum confidence to use habit prediction directly
  MIN_OBSERVATIONS: 3,        // Minimum trips to form a habit candidate
  BUCKET_HOURS: 4,            // Time-of-day bucket width
  HOUR_SLACK: 1,              // Match tolerance outside the observed hour window
  PURITY_PRIOR: 1,            // Smoothing: confidence = usual-end-stop count / (count + prior)
  HALF_LIFE_DAYS: 60,         // Recency decay half-life

  /**
   * Extract habits from a set of completed trips.
   * Groups by (agency, stop, route, direction, weekday/weekend, time bucket) and
   * returns habit records for groups meeting MIN_OBSERVATIONS.
   *
   * @param {Array} trips - Completed trips with startStopName, route, direction, startTime, endStopName, agency
   * @param {number} [since] - Only use trips starting at or after this epoch ms
   * @returns {Array} Habit records
   */
  extractHabits(trips, since = null) {
    const groups = {};
    const referenceMs = this._latestTripTime(trips);

    for (const trip of trips) {
      if (!trip.startStopName || !trip.route || !trip.direction || !trip.startTime) continue;

      const time = this._coerceTime(trip.startTime);
      if (isNaN(time.getTime())) continue;
      if (since && time.getTime() < since) continue;

      const { dayGroup, hour } = this._localParts(time, trip.agency);
      const bucket = this._bucket(hour);
      const key = [trip.agency, trip.startStopName, trip.route, trip.direction]
        .map(v => this._norm(v)).concat(dayGroup, bucket).join('|');

      if (!groups[key]) {
        groups[key] = {
          stop: trip.startStopName,
          agency: trip.agency || null,
          route: trip.route.toString(),
          direction: trip.direction,
          dayGroup,
          bucket,
          observations: [],
        };
      }
      groups[key].observations.push({
        time,
        hour,
        endStop: trip.endStopName || trip.endStop || null,
      });
    }

    const habits = [];

    for (const group of Object.values(groups)) {
      if (group.observations.length < this.MIN_OBSERVATIONS) continue;

      const hours = group.observations.map(o => o.hour);
      const lastSeen = Math.max(...group.observations.map(o => o.time.getTime()));

      // Most common end stop (case/space-insensitive), newest spelling wins ties.
      const endStops = {};
      for (const o of group.observations) {
        if (!o.endStop) continue;
        const k = this._norm(o.endStop);
        const e = endStops[k] || (endStops[k] = { name: o.endStop, count: 0, last: 0 });
        e.count += 1;
        if (o.time.getTime() >= e.last) { e.last = o.time.getTime(); e.name = o.endStop; }
      }
      const top = Object.values(endStops).sort((a, b) => b.count - a.count || b.last - a.last)[0] || null;

      const habit = {
        schema: this.SCHEMA,
        stop: group.stop,
        agency: group.agency,
        route: group.route,
        direction: group.direction,
        endStop: top ? top.name : null,
        endStopCount: top ? top.count : 0,
        dayGroup: group.dayGroup,
        bucket: group.bucket,
        hourMin: Math.min(...hours),
        hourMax: Math.max(...hours),
        count: group.observations.length,
        lastSeen,
        stale: false,
      };
      habit.confidence = this._confidence(habit, referenceMs);
      habits.push(habit);
    }

    return habits;
  },

  /**
   * Find the best matching habit for the current boarding context.
   * Returns a habit above CONFIDENCE_THRESHOLD, or null.
   *
   * @param {Array} habits - Loaded habits (from load())
   * @param {string} stop - Current boarding stop name
   * @param {Date} now - Current time
   * @param {Object} [filters] - Optional route/direction/agency filters
   * @returns {Object|null} Best matching habit, or null if none qualify
   */
  match(habits, stop, now, { route = null, direction = null, agency = null } = {}) {
    if (!habits || !habits.length || !stop || !now) return null;

    const nowMs = now.getTime();
    const local = {};
    const partsFor = (tzAgency) => {
      const tz = this._timezone(tzAgency);
      if (!local[tz]) local[tz] = this._localParts(now, tzAgency);
      return local[tz];
    };

    const candidates = [];
    for (const h of habits) {
      if (!h || h.schema !== this.SCHEMA || h.stale) continue;
      if (!this._stopMatch(h.stop, stop)) continue;
      if (route && this._norm(h.route) !== this._norm(route)) continue;
      if (direction && this._norm(h.direction) !== this._norm(direction)) continue;
      if (agency && this._norm(h.agency) !== this._norm(agency)) continue;
      const { dayGroup, hour } = partsFor(h.agency || agency);
      if (h.dayGroup !== dayGroup) continue;
      if (hour < h.hourMin - this.HOUR_SLACK || hour > h.hourMax + this.HOUR_SLACK) continue;
      const confidence = this._confidence(h, nowMs);
      if (confidence < this.CONFIDENCE_THRESHOLD) continue;
      candidates.push({ ...h, confidence });
    }

    if (!candidates.length) return null;
    return candidates.sort((a, b) => b.confidence - a.confidence || b.count - a.count)[0];
  },

  /**
   * Load habits for a user from Firestore.
   */
  async load(db, userId) {
    if (!db || !userId) return [];
    const doc = await db.collection('habits').doc(userId).get();
    return doc.exists ? (doc.data().habits || []) : [];
  },

  /**
   * Save habits for a user to Firestore.
   */
  async save(db, userId, habits) {
    if (!db || !userId) return;
    await db.collection('habits').doc(userId).set({
      userId,
      habits,
      updatedAt: new Date().toISOString(),
    });
  },

  /**
   * Rebuild habits for a user from their recent trip history and persist.
   * Called after each completed trip with the newest 200 completed trips.
   */
  async rebuild(db, userId, trips) {
    const habits = this.extractHabits(trips);

    // Detect stale habits: if a different route/direction is emerging in the same
    // (stop, day group, bucket) slot within the last 30 days, the old habit is being replaced.
    const referenceMs = this._latestTripTime(trips);
    const thirtyDaysAgo = referenceMs - 30 * 86400000;
    const recentHabits = this.extractHabits(trips, thirtyDaysAgo);
    const slotOf = h => `${this._norm(h.agency)}|${this._norm(h.stop)}|${h.dayGroup}|${h.bucket}`;
    const recentBySlot = {};
    for (const h of recentHabits) {
      (recentBySlot[slotOf(h)] = recentBySlot[slotOf(h)] || []).push(h);
    }
    for (const habit of habits) {
      const recent = recentBySlot[slotOf(habit)] || [];
      const replacement = recent.find(r =>
        (this._norm(r.route) !== this._norm(habit.route) ||
         this._norm(r.direction) !== this._norm(habit.direction)) &&
        r.count >= this.MIN_OBSERVATIONS
      );
      if (replacement) {
        habit.stale = true;
        habit.replacedBy = { route: replacement.route, direction: replacement.direction };
      }
    }

    await this.save(db, userId, habits);
    return habits;
  },

  /**
   * Confidence that this boarding ends at the habit's usual end stop:
   * smoothed share of the group's trips that ended there, × recency decay.
   * 3/3 → 0.75, 4/4 → 0.8, 3/4 → 0.6 (fresh, prior 1).
   *
   * @private
   */
  _confidence(habit, referenceMs = Date.now()) {
    if (!habit || !habit.count || !habit.endStopCount) return 0;
    const share = habit.endStopCount / (habit.count + this.PURITY_PRIOR);
    const daysSince = Math.max(0, (referenceMs - habit.lastSeen) / 86400000);
    const recency = Math.exp(-(Math.log(2) / this.HALF_LIFE_DAYS) * daysSince);
    return Math.round(share * recency * 1000) / 1000;
  },

  _bucket(hour) {
    return Math.floor(hour / this.BUCKET_HOURS) * this.BUCKET_HOURS;
  },

  _timezone(agency) {
    return (agency && AGENCY_TIMEZONE[agency]) || DEFAULT_TIMEZONE;
  },

  /** Day group ('weekday'/'weekend') and hour in the agency's local time. */
  _localParts(time, agency) {
    const tz = this._timezone(agency);
    if (!_formatters[tz]) {
      _formatters[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
      });
    }
    let weekday = 'Mon';
    let hour = 0;
    for (const p of _formatters[tz].formatToParts(time)) {
      if (p.type === 'weekday') weekday = p.value;
      if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
    }
    return { dayGroup: weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday', hour };
  },

  _coerceTime(value) {
    return value?.toDate ? value.toDate() : new Date(value);
  },

  _latestTripTime(trips) {
    let latest = 0;
    for (const trip of trips || []) {
      if (!trip?.startTime) continue;
      const time = this._coerceTime(trip.startTime);
      if (isNaN(time.getTime())) continue;
      latest = Math.max(latest, time.getTime());
    }
    return latest || Date.now();
  },

  _norm(s) {
    if (!s) return '';
    return s.toString().toLowerCase().trim();
  },

  _stopMatch(a, b) {
    return this._norm(a) === this._norm(b);
  },
};

module.exports = { HabitEngine };
