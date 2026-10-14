/**
 * Constants used across SMS handlers
 */

// Maps any recognized alias (lowercase) to the canonical stored agency name; the list itself is
// shared with the web app (js/shared/agency-aliases.js). Unknown names are stored as-is.
exports.AGENCY_CANONICAL = require('./agency-aliases').AGENCY_ALIASES;

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

// Maps canonical agency name to its IANA timezone string.
// Only agencies actually present in trip history are listed to avoid speculative bloat.
exports.AGENCY_TIMEZONE = {
  'TTC': 'America/Toronto',
  'GO Transit': 'America/Toronto',
  'MiWay': 'America/Toronto',
  'YRT': 'America/Toronto',
  'Oakville Transit': 'America/Toronto',
  'GTAA Terminal Link': 'America/Toronto',
  'LA Metro': 'America/Los_Angeles',
  'LADOT': 'America/Los_Angeles',
  'Big Blue Bus': 'America/Los_Angeles',
  'BART': 'America/Los_Angeles',
  'Muni': 'America/Los_Angeles',
  'VTA': 'America/Los_Angeles',
  'AC Transit': 'America/Los_Angeles',
  'SamTrans': 'America/Los_Angeles',
  'MTS': 'America/Los_Angeles',
  'Golden Gate Transit': 'America/Los_Angeles',
  'SMART': 'America/Los_Angeles',
  'Santa Rosa CityBus': 'America/Los_Angeles',
  'Flagship Cruises & Events': 'America/Los_Angeles',
  'Amtrak': 'America/New_York', 
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
