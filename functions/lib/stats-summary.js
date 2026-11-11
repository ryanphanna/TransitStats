/**
 * Figures for the STATS text reply, counted with the shared trip rule
 * (countedRides in trip-stats), the same one the dashboard and ASK use.
 */
const { countedRides, finishedTrips, tripStartDate } = require('./trip-stats');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object[]} loggedTrips - The user's logged trips from the last 60 days
 * @param {object[]} prestoTrips - The user's imported PRESTO rides (buildPrestoTrips)
 * @param {Date} now
 * @returns {object} Counts for the past 7/30 days and the windows before them
 */
function recentRideStats(loggedTrips, prestoTrips, now = new Date()) {
  const nowMs = now.getTime();
  const rides = countedRides(loggedTrips, prestoTrips, { now: nowMs })
    .map((ride) => ({ ride, age: nowMs - (tripStartDate(ride)?.getTime() ?? NaN) }))
    .filter(({ age }) => age >= 0 && age <= 60 * DAY_MS);
  // Rides aged over `fromDays` and up to `toDays`; today's rides have age 0.
  const aged = (fromDays, toDays) => rides
    .filter(({ age }) => (fromDays === 0 || age > fromDays * DAY_MS) && age <= toDays * DAY_MS)
    .map(({ ride }) => ride);

  const last30 = aged(0, 30);
  const routeCounts = {};
  for (const ride of last30) {
    if (ride.route) routeCounts[ride.route] = (routeCounts[ride.route] || 0) + 1;
  }

  return {
    total: rides.length,
    weekCount: aged(0, 7).length,
    prevWeekCount: aged(7, 14).length,
    monthCount: last30.length,
    prevMonthCount: aged(30, 60).length,
    routeCount: Object.keys(routeCounts).length,
    totalMinutes: finishedTrips(last30).reduce((sum, ride) => sum + ride.duration, 0),
    topRoute: Object.entries(routeCounts).sort((x, y) => y[1] - x[1])[0],
  };
}

module.exports = { recentRideStats };
