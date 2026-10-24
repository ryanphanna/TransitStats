/**
 * End-stop prediction context built at trip start.
 *
 * Shared by the live trip-start path (handlers-trip.js) and the weekly V4/V5 grading replay
 * (scripts/weekly-shadow-grade.js), so the replay feeds the models exactly what live would have.
 * `history` is the serving history: newest completed trips first, already filtered, with
 * Firestore Timestamps (minutesSinceLastTrip stays null otherwise, as it always has live).
 */
function buildEndStopContext({
  route, startStopName, direction, now, history = [], agency = null, primaryAgency = null,
  stopsLibrary = [], networkGraph = null,
}) {
  const lastTrip = history.length > 0 ? history[0] : null;
  return {
    route,
    startStopName,
    direction,
    time: now,
    lastEndStopName: lastTrip?.endStopName || lastTrip?.endStop || null,
    lastRoute: lastTrip?.route || null,
    minutesSinceLastTrip: lastTrip?.startTime?.toDate
      ? Math.max(0, Math.round((now.getTime() - lastTrip.startTime.toDate().getTime()) / 60000))
      : null,
    agency,
    primaryAgency,
    stopsLibrary,
    networkGraph: networkGraph || null,
  };
}

module.exports = { buildEndStopContext };
