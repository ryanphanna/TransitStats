/**
 * Plain builders for trip and stop writes shared by the dispatcher and the handlers.
 * No requires on purpose: callers pass their own db / FieldValue, so the test
 * harnesses' mocks still apply.
 */

/** Fields that save a trip as incomplete (FORGOT, or starting over on top of it). */
function incompleteTripUpdate(trip) {
  return {
    incomplete: true,
    endTime: trip.startTime,
    exitLocation: null,
    duration: null,
  };
}

/** Trip options for a trip started from a photo of the stop sign. */
function mmsTripOptions(receivedAt) {
  return {
    parsed_by: 'mms',
    startTime: receivedAt,
    source: 'mms',
    timing_reliability: 'approximate',
  };
}

/**
 * Background: teach a stop that a route serves it, and promote gtfs→verified on the
 * first real trip. Fire-and-forget; failures are ignored.
 */
function teachStopRoute(db, FieldValue, stopId, stopSource, route) {
  if (!stopId || !route) return;
  const stopUpdate = { routes: FieldValue.arrayUnion(route) };
  if (stopSource === 'gtfs') stopUpdate.source = 'verified';
  db.collection('stops').doc(stopId).update(stopUpdate).catch(() => {});
}

/** Rider-supplied trip details, with the defaults every new trip stores. */
function tripDetailFields(source) {
  return {
    sentiment: source.sentiment || null,
    tags: source.tags || [],
    parsed_by: source.parsed_by || 'manual',
    vehicle: source.vehicle || null,
  };
}

module.exports = {
  tripDetailFields,
  incompleteTripUpdate,
  mmsTripOptions,
  teachStopRoute,
};
