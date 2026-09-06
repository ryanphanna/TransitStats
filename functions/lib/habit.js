/**
 * HabitEngine — learns recurring trip patterns from history.
 *
 * A "habit" is a (stop, route, direction) triplet that fires predictably
 * on certain days within a certain hour window. When a boarding matches a
 * known habit with sufficient confidence, the engine returns a prediction
 * directly without needing to run V4/V5.
 *
 * Changelog:
 *   v1 - Habit extraction from trip history, match scoring, Firestore persistence.
 *        Confidence = count score × recency decay × time-window precision.
 */

const HabitEngine = {
  VERSION: '1.0.0',

  CONFIDENCE_THRESHOLD: 0.75, // Minimum confidence to use habit prediction directly
  MIN_OBSERVATIONS: 3,        // Minimum trips to form a habit candidate

  /**
   * Extract habits from a set of completed trips.
   * Groups by (stop, route, direction, dayOfWeek, 2-hour bucket) and
   * returns habit records for groups meeting MIN_OBSERVATIONS.
   *
   * @param {Array} trips - Completed trips with startStopName, route, direction, startTime, endStopName
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

      const day = time.getDay();
      const hour = time.getHours();
      const bucket = Math.floor(hour / 2) * 2; // 2-hour buckets: 0, 2, 4, ..., 22
      const key = `${this._norm(trip.agency)}|${this._norm(trip.startStopName)}|${trip.route}|${trip.direction}|${day}|${bucket}`;

      if (!groups[key]) {
        groups[key] = {
          stop: trip.startStopName,
          agency: trip.agency || null,
          route: trip.route.toString(),
          direction: trip.direction,
          day,
          bucket,
          observations: [],
        };
      }
      groups[key].observations.push({
        time,
        hour,
        endStop: trip.endStopName || null,
      });
    }

    const habits = [];

    for (const group of Object.values(groups)) {
      if (group.observations.length < this.MIN_OBSERVATIONS) continue;

      const hours = group.observations.map(o => o.hour);
      const hourMin = Math.min(...hours);
      const hourMax = Math.max(...hours);
      const lastSeen = Math.max(...group.observations.map(o => o.time.getTime()));

      // Most common end stop across observations
      const endStopCounts = {};
      for (const o of group.observations) {
        if (o.endStop) endStopCounts[o.endStop] = (endStopCounts[o.endStop] || 0) + 1;
      }
      const endStop = Object.entries(endStopCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      habits.push({
        stop: group.stop,
        route: group.route,
        direction: group.direction,
        endStop,
        day: group.day,
        bucket: group.bucket,
        hourMin,
        hourMax,
        count: group.observations.length,
        lastSeen,
        confidence: this._confidence(
          group.observations.length,
          lastSeen,
          hourMax - hourMin,
          referenceMs
        ),
        stale: false,
      });
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
   * @param {Object} [filters] - Optional route/direction filters
   * @param {string} [filters.route] - Only match habits for this route
   * @param {string} [filters.direction] - Only match habits for this direction
   * @param {string} [filters.agency] - Only match habits for this agency
   * @returns {Object|null} Best matching habit, or null if none qualify
   */
  match(habits, stop, now, { route = null, direction = null, agency = null } = {}) {
    if (!habits || !habits.length || !stop || !now) return null;

    const day = now.getDay();
    const hour = now.getHours();
    const nowMs = now.getTime();

    const candidates = habits.filter(h => {
      if (h.stale) return false;
      if (!this._stopMatch(h.stop, stop)) return false;
      if (h.day !== day) return false;
      // Allow ±1 hour flexibility outside the observed window
      if (hour < h.hourMin - 1 || hour > h.hourMax + 1) return false;
      const confidence = this._confidence(h.count, h.lastSeen, h.hourMax - h.hourMin, nowMs);
      if (confidence < this.CONFIDENCE_THRESHOLD) return false;
      if (route && this._norm(h.route) !== this._norm(route.toString())) return false;
      if (direction && this._norm(h.direction) !== this._norm(direction)) return false;
      if (agency && this._norm(h.agency) !== this._norm(agency)) return false;
      return true;
    });

    if (!candidates.length) return null;
    return candidates
      .map((habit) => ({
        ...habit,
        confidence: this._confidence(habit.count, habit.lastSeen, habit.hourMax - habit.hourMin, nowMs),
      }))
      .sort((a, b) => b.confidence - a.confidence)[0];
  },

  /**
   * Load habits for a user from Firestore.
   *
   * @param {Object} db - Firestore instance
   * @param {string} userId
   * @returns {Array} Habit records (empty array if none)
   */
  async load(db, userId) {
    if (!db || !userId) return [];
    const doc = await db.collection('habits').doc(userId).get();
    return doc.exists ? (doc.data().habits || []) : [];
  },

  /**
   * Save habits for a user to Firestore.
   *
   * @param {Object} db
   * @param {string} userId
   * @param {Array} habits
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
   * Rebuild habits for a user from their full trip history and persist.
   * Call after enough new trips accumulate, or on a weekly schedule.
   *
   * @param {Object} db
   * @param {string} userId
   * @param {Array} trips - Full trip history
   * @returns {Array} Extracted habits
   */
  async rebuild(db, userId, trips) {
    const habits = this.extractHabits(trips);

    // Detect stale habits: if a different route/direction is emerging in the same
    // (stop, day, bucket) slot within the last 30 days, the old habit is being replaced.
    const referenceMs = this._latestTripTime(trips);
    const thirtyDaysAgo = referenceMs - 30 * 86400000;
    const recentHabits = this.extractHabits(trips, thirtyDaysAgo);
    const recentBySlot = {};
    for (const h of recentHabits) {
      const slot = `${this._norm(h.agency)}|${this._norm(h.stop)}|${h.day}|${h.bucket}`;
      if (!recentBySlot[slot]) recentBySlot[slot] = [];
      recentBySlot[slot].push(h);
    }
    for (const habit of habits) {
      const slot = `${this._norm(habit.agency)}|${this._norm(habit.stop)}|${habit.day}|${habit.bucket}`;
      const recent = recentBySlot[slot] || [];
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
   * Confidence score for a habit: count × recency × time-window precision.
   *
   * - Count: reaches ~1.0 at 10 observations
   * - Recency: exponential decay with 30-day half-life
   * - Precision: tighter hour window = more reliable signal
   *
   * @private
   */
  _confidence(count, lastSeenMs, hourSpread, referenceMs = Date.now()) {
    const countScore = Math.min(count / 10, 1.0);
    const daysSince = Math.max(0, (referenceMs - lastSeenMs) / 86400000);
    const recency = Math.exp(-(Math.log(2) / 30) * daysSince);
    const precision = hourSpread <= 1 ? 1.0 : hourSpread <= 2 ? 0.9 : 0.8;
    return Math.round(countScore * recency * precision * 1000) / 1000;
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
