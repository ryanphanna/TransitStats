const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseMatch } = require('./atlas-agency');

// Slice of Atlas's live agency directory (atlas/agencies.json), including the look-alikes that
// short rider labels can wrongly match by name.
const DIRECTORY = [
  { slug: "actransit", name: "Alameda-Contra Costa Transit District (AC Transit)" },
  { slug: "bart", name: "Bay Area Rapid Transit (BART)" },
  { slug: "brampton", name: "Brampton Transit" },
  { slug: "caltrain", name: "Caltrain" },
  { slug: "cta", name: "Chicago Transit Authority (CTA)" },
  { slug: "drt", name: "Durham Region Transit" },
  { slug: "durango-transit", name: "Durango Transit" },
  { slug: "go", name: "GO Transit" },
  { slug: "godurham", name: "GoDurham" },
  { slug: "gotriangle", name: "GoTriangle (Raleigh-Durham)" },
  { slug: "grt", name: "Grand River Transit (Waterloo Region)" },
  { slug: "hamilton", name: "Hamilton Street Railway" },
  { slug: "indygo", name: "IndyGo (Indianapolis)" },
  { slug: "kalamazoo", name: "Kalamazoo Metro Transit" },
  { slug: "lacmta", name: "Los Angeles County Metropolitan Transportation Authority (LA Metro)" },
  { slug: "madison-metro", name: "Madison Metro Transit" },
  { slug: "metro-transit", name: "Metro Transit (Minneapolis)" },
  { slug: "miway", name: "MiWay (Mississauga)" },
  { slug: "nashvillemta", name: "Nashville MTA WeGo Public Transit" },
  { slug: "nfta", name: "NFTA (Buffalo)" },
  { slug: "octranspo", name: "OC Transpo (Ottawa)" },
  { slug: "omniride", name: "OmniRide (PRTC)" },
  { slug: "pace-bus", name: "Pace Bus (Chicago suburbs)" },
  { slug: "path", name: "PATH (Port Authority Trans-Hudson)" },
  { slug: "port-authority-pa", name: "Pittsburgh Regional Transit" },
  { slug: "samtrans", name: "San Mateo County Transit District (samTrans)" },
  { slug: "sdmts", name: "Metropolitan Transit System (San Diego MTS)" },
  { slug: "sfmta", name: "San Francisco Municipal Transportation Agency (SFMTA - Muni)" },
  { slug: "stm", name: "STM (Montr\u00e9al)" },
  { slug: "translink", name: "TransLink (Vancouver)" },
  { slug: "ttc", name: "Toronto Transit Commission" },
  { slug: "upexpress", name: "UP Express (Toronto)" },
  { slug: "vta", name: "Santa Clara Valley Transportation Authority (VTA)" },
  { slug: "waukesha-metro", name: "Waukesha Metro Transit" },
  { slug: "wvu-prt", name: "West Virginia University PRT (Morgantown, WV)" },
  { slug: "yrt", name: "York Region Transit" },
];

// Every short label Ryan uses, pinned to the slug it must resolve to.
const EXPECTED = {
  PRT: 'port-authority-pa',
  'Pittsburgh Regional Transit': 'port-authority-pa',
  TTC: 'ttc',
  GO: 'go',
  'GO Transit': 'go',
  HSR: 'hamilton',
  MiWay: 'miway',
  BART: 'bart',
  MTS: 'sdmts',
  'AC Transit': 'actransit',
  NFTA: 'nfta',
  'NFTA Metro': 'nfta',
  CTA: 'cta',
  'UP Express': 'upexpress',
  DRT: 'drt',
  YRT: 'yrt',
};

for (const [label, slug] of Object.entries(EXPECTED)) {
  test(`atlas agency: "${label}" resolves to ${slug}`, () => {
    assert.equal(chooseMatch(DIRECTORY, label), slug);
  });
}

test('a failed agency-directory fetch is remembered briefly instead of retried on every call', async () => {
  const { resolveAtlasAgency, resetAgencyCachesForTests } = require('./atlas-agency');
  resetAgencyCachesForTests();
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 503 }; };
  try {
    await assert.rejects(() => resolveAtlasAgency('TTC'), /unavailable/);
    await assert.rejects(() => resolveAtlasAgency('TTC'), /unavailable/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = original;
    resetAgencyCachesForTests();
  }
});
