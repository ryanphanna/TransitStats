/**
 * The hour of day (0-23) a trip started, in the trip's own timezone. One definition shared by
 * the network graph (which files durations under it) and the slow-trip check (which looks them
 * up), so the two always agree. Server-local getHours() would be UTC in production.
 */
const { timezoneForAgency } = require('./constants');

const DEFAULT_TIMEZONE = 'America/Toronto';
const _formatters = {};

function tripStartHour(startTime, { timezone = null, agency = null } = {}) {
  const date = startTime?.toDate ? startTime.toDate() : new Date(startTime ?? Date.now());
  const time = Number.isNaN(date.getTime()) ? new Date() : date;
  const tz = timezone || timezoneForAgency(agency) || DEFAULT_TIMEZONE;
  try {
    if (!_formatters[tz]) {
      _formatters[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    }
    const part = _formatters[tz].formatToParts(time).find(p => p.type === 'hour');
    return parseInt(part.value, 10) % 24;
  } catch {
    return time.getHours();
  }
}

module.exports = { tripStartHour };
