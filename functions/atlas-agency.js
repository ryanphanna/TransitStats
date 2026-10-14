const ATLAS_R2_BASE = process.env.ATLAS_R2_BASE || 'https://data.transitatlas.fyi';

// A few rider-facing labels are abbreviations that do not appear in Atlas's
// public agency name. Everything else is resolved from the live directory.
const RIDER_LABEL_ALIASES = {
  hsr: 'hamilton',
  smart: 'smart-ca',
  // "PRT" otherwise matches West Virginia University's PRT (wvu-prt) by name.
  prt: 'port-authority-pa',
  'port authority of allegheny county': 'port-authority-pa',
};

let directoryCache = null;
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function getAgencyDirectory() {
  if (directoryCache && Date.now() - directoryCache.fetchedAt < DIRECTORY_TTL_MS) {
    return directoryCache.agencies;
  }

  const response = await fetch(`${ATLAS_R2_BASE}/atlas/agencies.json`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Atlas agency directory unavailable (${response.status})`);

  const data = await response.json();
  const agencies = Array.isArray(data.agencies) ? data.agencies : [];
  directoryCache = { fetchedAt: Date.now(), agencies };
  return agencies;
}

function chooseMatch(agencies, requested) {
  const value = normalize(requested);
  if (!value) return null;

  const alias = RIDER_LABEL_ALIASES[value];
  if (alias && agencies.some(agency => agency.slug === alias)) return alias;

  const exactSlug = agencies.find(agency => normalize(agency.slug) === value);
  if (exactSlug) return exactSlug.slug;

  const exactName = agencies.find(agency => normalize(agency.name) === value);
  if (exactName) return exactName.slug;

  const firstToken = value.split(' ')[0];
  const tokenMatches = agencies.filter(agency => {
    const slug = normalize(agency.slug);
    const name = normalize(agency.name);
    return slug === firstToken || name.split(' ')[0] === firstToken;
  });
  if (tokenMatches.length === 1) return tokenMatches[0].slug;

  const prefixMatches = agencies.filter(agency => {
    const name = normalize(agency.name);
    return name.startsWith(value) || value.startsWith(name);
  });
  if (prefixMatches.length === 1) return prefixMatches[0].slug;

  const containsMatches = agencies.filter(agency => {
    const name = normalize(agency.name);
    const nameTokens = name.split(' ');
    const valueTokens = value.split(' ');
    return valueTokens.length === 1
      ? nameTokens.includes(value) || normalize(agency.slug).split(' ').includes(value)
      : name.includes(value) || value.includes(name);
  });
  return containsMatches.length === 1 ? containsMatches[0].slug : null;
}

async function resolveAtlasAgency(value) {
  const agencies = await getAgencyDirectory();
  return chooseMatch(agencies, value);
}

module.exports = { resolveAtlasAgency, chooseMatch };
