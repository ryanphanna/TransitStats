// Single list of agency aliases, shared by the web app and the Cloud Functions
// (functions/lib/agency-aliases.js is generated from this file by scripts/sync-shared.mjs).
// Maps any recognized alias (lowercase) to the canonical stored agency name.
// Anything not in this map is stored as typed.
export const AGENCY_ALIASES = {
  // TTC
  'ttc': 'TTC',
  'toronto transit commission': 'TTC',
  // GO
  'go': 'GO Transit',
  'go transit': 'GO Transit',
  // MiWay
  'miway': 'MiWay',
  'mississauga transit': 'MiWay',
  // YRT
  'yrt': 'YRT',
  'york region transit': 'YRT',
  // OC Transpo
  'oc transpo': 'OC Transpo',
  'octranspo': 'OC Transpo',
  // Brampton Transit
  'brampton transit': 'Brampton Transit',
  // Durham Transit
  'durham transit': 'Durham Transit',
  // HSR
  'hsr': 'HSR',
  'hamilton street railway': 'HSR',
  // GRT
  'grt': 'GRT',
  'grand river transit': 'GRT',
  // STM
  'stm': 'STM',
  // TransLink
  'translink': 'TransLink',
  // NYC MTA
  'nyc mta': 'NYC MTA',
  'mta nyc': 'NYC MTA',
  'new york mta': 'NYC MTA',
  // LA Metro
  'la metro': 'LA Metro',
  'lametro': 'LA Metro',
  // 'metro' and 'mta' intentionally omitted — ambiguous across cities
  // LADOT
  'ladot': 'LADOT',
  // Big Blue Bus
  'big blue bus': 'Big Blue Bus',
  'bbb': 'Big Blue Bus',
  // BART
  'bart': 'BART',
  'bay area rapid transit': 'BART',
  // Muni
  'muni': 'Muni',
  'sf muni': 'Muni',
  'sfmuni': 'Muni',
  'sfmta': 'Muni',
  // Caltrain
  'caltrain': 'Caltrain',
  // VTA
  'vta': 'VTA',
  // AC Transit
  'ac transit': 'AC Transit',
  'actransit': 'AC Transit',
  // SamTrans
  'samtrans': 'SamTrans',
  // MTS (San Diego)
  'mts': 'MTS',
  'sd mts': 'MTS',
  'san diego mts': 'MTS',
  'sdmts': 'MTS',
  // LADOT variants
  'la dot': 'LADOT',
  // Amtrak
  'amtrak': 'Amtrak',
  // Golden Gate Transit
  'golden gate transit': 'Golden Gate Transit',
  'ggt': 'Golden Gate Transit',
  // NFTA Metro (Buffalo). MFTA is the common mistyping of NFTA.
  'nfta': 'NFTA Metro',
  'nfta metro': 'NFTA Metro',
  'mfta': 'NFTA Metro',
  'niagara frontier transportation authority': 'NFTA Metro',
  // SMART
  'smart': 'SMART',
  // Santa Rosa CityBus
  'santa rosa citybus': 'Santa Rosa CityBus',
  'citybus': 'Santa Rosa CityBus',
  'srcitybus': 'Santa Rosa CityBus',
};

/** Canonical stored name for a recognized alias; unknown names come back trimmed and unchanged. */
export function canonicalAgency(name) {
    if (!name) return name;
    const trimmed = String(name).trim();
    return AGENCY_ALIASES[trimmed.toLowerCase()] || trimmed;
}
