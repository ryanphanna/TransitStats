import { Identity } from './identity.js';

const AGENCY_DISPLAY_NAMES = {
    TTC: 'Toronto Transit Commission',
    GO: 'GO Transit',
    'GO Transit': 'GO Transit',
    MiWay: 'Mississauga Transit',
    YRT: 'York Region Transit',
    'Brampton Transit': 'Brampton Transit',
    'Durham Transit': 'Durham Region Transit',
    HSR: 'Hamilton Street Railway',
    GRT: 'Grand River Transit',
    'OC Transpo': 'OC Transpo',
    STM: 'Société de transport de Montréal',
    TransLink: 'TransLink',
    'NYC MTA': 'New York City Transit',
    'LA Metro': 'Los Angeles Metro',
    LADOT: 'Los Angeles Department of Transportation',
    'Big Blue Bus': 'Santa Monica Big Blue Bus',
    BART: 'Bay Area Rapid Transit',
    Muni: 'San Francisco Municipal Transportation Agency',
    Caltrain: 'Caltrain',
    VTA: 'Santa Clara Valley Transportation Authority',
    'AC Transit': 'Alameda-Contra Costa Transit District',
    SamTrans: 'San Mateo County Transit District',
    MTS: 'San Diego Metropolitan Transit System',
    Amtrak: 'Amtrak',
    'Golden Gate Transit': 'Golden Gate Transit',
    SMART: 'Sonoma-Marin Area Rail Transit',
    'Santa Rosa CityBus': 'Santa Rosa CityBus',
    'Oakville Transit': 'Oakville Transit',
    'GTAA Terminal Link': 'GTAA Terminal Link',
    'Flagship Cruises & Events': 'Flagship Cruises & Events',
};

export const BUILT_IN_AGENCY_OPTIONS = Object.entries(AGENCY_DISPLAY_NAMES)
    .map(([value, label]) => ({ value, label }));

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase().replace(/_/g, '-');
}

export function isEmojiUsername(username) {
    const keys = String(username || '').split(/[-_]/).filter(Boolean);
    return keys.length === 3 && keys.every(key => Object.prototype.hasOwnProperty.call(Identity.LIBRARY, key));
}

export function getEmojiUsername(profile = {}) {
    const candidates = [profile.emojiUsername, ...(profile.usernameAliases || []), profile.username];
    return candidates.find(isEmojiUsername) || '';
}

export function displayAgencyName(value) {
    const name = String(value || '').trim();
    return AGENCY_DISPLAY_NAMES[name] || name;
}

export function formatPhoneNumber(value) {
    const phone = String(value || '').trim();
    const digits = phone.replace(/\D/g, '');
    const nationalDigits = digits.length === 11 && digits.startsWith('1')
        ? digits.slice(1)
        : digits;

    if (nationalDigits.length === 10) {
        return `(${nationalDigits.slice(0, 3)}) ${nationalDigits.slice(3, 6)}-${nationalDigits.slice(6)}`;
    }

    return phone || 'Not linked';
}

export function getConfiguredAgency(profile = {}) {
    const value = profile.defaultAgencyMode === 'automatic'
        ? profile.primaryAgency
        : profile.defaultAgency;
    return String(value || '').trim() || null;
}

export function getMapStopMode(profile = {}, fallback = 'boarding') {
    return profile.mapStopMode === 'exiting'
        ? 'exiting'
        : (fallback === 'exiting' ? 'exiting' : 'boarding');
}
