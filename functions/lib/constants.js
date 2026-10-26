/**
 * Constants used across SMS handlers
 */

// Maps any recognized alias (lowercase) to the canonical stored agency name; the list itself is
// shared with the web app (js/shared/agency-aliases.js). Unknown names are stored as-is.
const { AGENCY_ALIASES, canonicalAgency } = require('./agency-aliases');
exports.AGENCY_CANONICAL = AGENCY_ALIASES;

exports.KNOWN_AGENCIES = [
  'TTC',
  'OC Transpo',
  'GO Transit',
  'GO',
  'MiWay',
  'YRT',
  'Brampton Transit',
  'Durham Transit',
  'HSR',
  'GRT',
  'STM',
  'TransLink',
  // LA
  'LA Metro',
  'LAMETRO',
  'NYC MTA',
  'LADOT',
  'Big Blue Bus',
  // SF Bay Area
  'BART',
  'Muni',
  'SF Muni',
  'SFMUNI',
  'SFMTA',
  'Caltrain',
  'VTA',
  'AC Transit',
  'ACTRANSIT',
  'SamTrans',
  // San Diego
  'MTS',
  'SD MTS',
  'SDMTS',
  // Other
  'Amtrak',
  'SMART',
  'Golden Gate Transit',
  'GGT',
  'LA DOT',
  'Santa Rosa CityBus',
  'CityBus',
  'NFTA Metro',
  'PRT',
];

exports.BAD_ROUTE_SUFFIXES = [
  'ST', 'AVE', 'RD', 'DR', 'BLVD', 'WAY', 'STATION',
  'N', 'S', 'E', 'W', 'NB', 'SB', 'EB', 'WB',
  'NORTH', 'SOUTH', 'EAST', 'WEST', 'INBOUND', 'OUTBOUND',
  'NORTHBOUND', 'SOUTHBOUND', 'EASTBOUND', 'WESTBOUND',
  'TRIP', 'RIDE', 'STOP', 'BUS', 'STREETCAR', 'TRAIN', 'SUBWAY',
  'FROM', 'TO', 'AT', 'ON', 'HEADED', 'GOING',
];

exports.VALID_INTENTS = [
  'START_TRIP', 'END_TRIP', 'DISCARD_TRIP', 'INCOMPLETE_TRIP', 'QUERY', 'OTHER',
];

exports.VALID_SENTIMENTS = ['POSITIVE', 'NEGATIVE', 'NEUTRAL'];

// Maps canonical agency name (as stored on trips, see agency-aliases.js) to its IANA timezone.
// The one table for every timezone decision: trip creation (db/trips.js), the agency timezone
// lookup (gemini.js), the recompute after an agency correction (finalization.js), and local-time
// habit/ML features (habit.js, ml_utils.js).
exports.AGENCY_TIMEZONE = {
  // Ontario
  'TTC': 'America/Toronto',
  'GO Transit': 'America/Toronto',
  'MiWay': 'America/Toronto',
  'YRT': 'America/Toronto',
  'Brampton Transit': 'America/Toronto',
  'Durham Transit': 'America/Toronto',
  'HSR': 'America/Toronto',
  'GRT': 'America/Toronto',
  'OC Transpo': 'America/Toronto',
  'Oakville Transit': 'America/Toronto',
  'GTAA Terminal Link': 'America/Toronto',
  // Quebec
  'STM': 'America/Toronto',
  // BC
  'TransLink': 'America/Vancouver',
  // New York State and Pennsylvania
  'NYC MTA': 'America/New_York',
  'NFTA Metro': 'America/New_York',
  'PRT': 'America/New_York',
  // LA
  'LA Metro': 'America/Los_Angeles',
  'LADOT': 'America/Los_Angeles',
  'Big Blue Bus': 'America/Los_Angeles',
  // SF Bay Area and North Bay
  'BART': 'America/Los_Angeles',
  'Muni': 'America/Los_Angeles',
  'Caltrain': 'America/Los_Angeles',
  'VTA': 'America/Los_Angeles',
  'AC Transit': 'America/Los_Angeles',
  'SamTrans': 'America/Los_Angeles',
  'Golden Gate Transit': 'America/Los_Angeles',
  'SMART': 'America/Los_Angeles',
  'Santa Rosa CityBus': 'America/Los_Angeles',
  'Flagship Cruises & Events': 'America/Los_Angeles',
  // San Diego
  'MTS': 'America/Los_Angeles',
  // National
  'Amtrak': 'America/New_York',
};

/**
 * IANA timezone for an agency name (aliases resolve to the canonical name first), or null when
 * the agency isn't in AGENCY_TIMEZONE. Callers keep their own fallback for null.
 * @param {string} agency
 * @returns {string|null}
 */
exports.timezoneForAgency = (agency) => {
  if (!agency) return null;
  return exports.AGENCY_TIMEZONE[canonicalAgency(agency)] || null;
};

// Maps canonical agency name to the city/region shown in disambiguation prompts.
// When two agencies map to the same city, the agency name is shown instead.
exports.AGENCY_CITY = {
  'TTC': 'Toronto',
  'GO Transit': 'Toronto / GTA',
  'MiWay': 'Mississauga',
  'YRT': 'York Region',
  'Brampton Transit': 'Brampton',
  'Durham Transit': 'Durham Region',
  'HSR': 'Hamilton',
  'GRT': 'Waterloo Region',
  'OC Transpo': 'Ottawa',
  'STM': 'Montréal',
  'TransLink': 'Vancouver',
  'NYC MTA': 'New York City',
  'LA Metro': 'Los Angeles',
  'LADOT': 'Los Angeles',
  'Big Blue Bus': 'Santa Monica',
  'BART': 'Bay Area',
  'Muni': 'San Francisco',
  'Caltrain': 'Bay Area',
  'VTA': 'San José',
  'AC Transit': 'East Bay',
  'SamTrans': 'Peninsula',
  'MTS': 'San Diego',
  'Amtrak': 'Amtrak',
  'Golden Gate Transit': 'Marin / Sonoma',
  'SMART': 'Sonoma / Marin',
  'Santa Rosa CityBus': 'Santa Rosa',
};

// Prediction history windows (read by ml/eval/harness.py and ml/eval/replay_js.js; keep the
// `exports.NAME = <integer>;` form). V3 votes over the newest PREDICTION_HISTORY_LIMIT completed
// trips (3.5.0); V4/V5 eligibility counts the first ELIGIBILITY_HISTORY_LIMIT of those after the
// serving filter.
exports.PREDICTION_HISTORY_LIMIT = 500;
exports.ELIGIBILITY_HISTORY_LIMIT = 100;

// V4/V5 ML end-stop models at trip start (CIV-425). Off: trips get V3 + habit only, and the sms
// function never loads the model files or the ONNX runtime. The models are graded weekly instead,
// on the past week's real trips (functions/scripts/weekly-shadow-grade.js, run by retrain.yml).
// Set to true to run and store them live again (endStopPredictionV4/V5, graded at finalization).
exports.ML_ENDSTOP_LIVE = false;
