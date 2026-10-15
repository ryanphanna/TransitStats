const test = require('node:test');
const assert = require('node:assert');
const { PredictionEngine } = require('./lib/predict');

function makeTrip({ endStopName, daysAgo }) {
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - daysAgo);
  return {
    route: '510',
    startStopName: 'Spadina Station',
    endStopName,
    direction: 'Southbound',
    startTime,
    endTime: new Date(startTime.getTime() + 5 * 60000),
  };
}

test('V3 topology constraint vetoes conflicting learned NetworkEngine stops', () => {
  PredictionEngine.stopsLibrary = [];
  PredictionEngine.networkGraph = {
    edges: {
      wrong: {
        fromStop: 'Spadina Station',
        toStop: 'Spadina Ave at Nassau St',
        direction: 'Southbound',
        tripCount: 5,
      },
    },
  };

  const history = [
    ...Array.from({ length: 8 }, (_, i) => makeTrip({
      endStopName: 'Spadina Ave at Nassau St',
      daysAgo: i + 1,
    })),
    makeTrip({
      endStopName: 'Spadina Ave at Nassau St South Side',
      daysAgo: 1,
    }),
  ];

  try {
    const constraint = PredictionEngine.getEndStopConstraint({
      route: '510',
      startStopName: 'Spadina Station',
      direction: 'Southbound',
    });
    const top = PredictionEngine.guessTopEndStops(history, {
      route: '510',
      startStopName: 'Spadina Station',
      direction: 'Southbound',
      time: new Date(),
    }, 3);

    assert.equal(constraint.source, 'topology+network');
    assert.ok(top.some(prediction => prediction.stop === 'Spadina Ave at Nassau St South Side'));
    assert.ok(!top.some(prediction => prediction.stop === 'Spadina Ave at Nassau St'));
  } finally {
    PredictionEngine.networkGraph = null;
    PredictionEngine.stopsLibrary = [];
  }
});

// --- CIV-205: direction data, label matching and missing stops (real topology.json) ---

const realTopology = require('./lib/topology.json');
const TC = require('./lib/topology-constraints');

const allowed = (route, start, direction, end, options = {}) => {
  const constraint = TC.getConstraint(realTopology, { route, startStopName: start, direction }, options);
  return constraint.source === 'topology' && TC.stopAllowedByConstraint(end, constraint, options);
};

test('every line\'s listing order is pinned to real geography: which direction increases the index', () => {
  // The direction a rider travels when moving toward the END of each line's stop list.
  const TOWARD_END = {
    510: 'Southbound', 506: 'Eastbound', 504: 'Westbound', 512: 'Eastbound', 505: 'Eastbound', 501: 'Eastbound',
    41: 'Southbound', 511: 'Southbound', 2: 'Eastbound', 4: 'Eastbound', 5: 'Eastbound',
    'LA-B': 'Southbound', 'LA-D': 'Eastbound', 'LA-A': 'Southbound', 'LA-E': 'Westbound', 'LA-G': 'Westbound',
    'LA-J': 'Southbound', 'Muni-N': 'Westbound', 'Muni-T': 'Northbound', BART: 'Northbound',
  };
  const opposite = { Northbound: 'Southbound', Southbound: 'Northbound', Eastbound: 'Westbound', Westbound: 'Eastbound' };
  for (const [key, towardEnd] of Object.entries(TOWARD_END)) {
    const line = realTopology.lines[key];
    assert.ok(line, `line ${key} exists`);
    assert.equal(TC.normalizeDirection(towardEnd) !== null, true);
    const higher = (dir) => {
      // boarding at the first stop: only the "toward the end" direction can have legal stops ahead
      const c = TC.getConstraint(realTopology, { route: key, startStopName: line.stops[0], direction: dir });
      return c.source === 'topology' && c.legalStops.size > 0;
    };
    assert.equal(higher(towardEnd), true, `${key}: ${towardEnd} from the first stop must have stops ahead`);
    assert.equal(higher(opposite[towardEnd]), false, `${key}: ${opposite[towardEnd]} from the first stop must have none`);
  }
});

test('511 Bathurst: Southbound goes toward Exhibition, Northbound toward Bathurst Station', () => {
  assert.equal(allowed('511', 'Bathurst St at College St', 'Southbound', 'Bathurst St at King St West'), true);
  assert.equal(allowed('511', 'Bathurst St at College St', 'Southbound', 'Bathurst Station'), false);
  assert.equal(allowed('511', 'Fleet St at Bathurst St', 'Northbound', 'Bathurst St at Nassau St - Toronto Western Hospital'), true);
  assert.equal(allowed('511', 'Fleet St at Bathurst St', 'Northbound', 'Exhibition Loop'), false);
});

test('41 Keele: Southbound goes toward Keele Station, Northbound toward Pioneer Village', () => {
  assert.equal(allowed('41', 'Keele St at Lawrence Ave West', 'Southbound', 'Keele St at Eglinton Ave West'), true);
  assert.equal(allowed('41', 'Keele St at Lawrence Ave West', 'Southbound', 'Keele St at Finch Ave West - Finch West Station'), false);
  assert.equal(allowed('41', 'Keele St at Lawrence Ave West', 'Northbound', 'Keele St at Wilson Ave'), true);
});

test('504 King: Westbound goes toward King Station, Eastbound toward Broadview', () => {
  assert.equal(allowed('504', 'King St East at Sumach St', 'Westbound', 'King Station'), true);
  assert.equal(allowed('504', 'King St East at Ontario St', 'Eastbound', 'King St East at Sumach St'), true);
  assert.equal(allowed('504', 'King St East at Ontario St', 'Eastbound', 'King Station'), false);
});

test('Line 1 stop labels match however the subway station is written (Station suffix, punctuation)', () => {
  assert.equal(allowed('1', 'Davisville', 'Southbound', 'College Station'), true);
  assert.equal(allowed('1', 'Davisville', 'Southbound', 'Wellesley Station'), true);
  assert.equal(allowed('1', 'Queen\'s Park Station', 'Southbound', 'St Patrick Station'), true);
  assert.equal(allowed('1', 'Eglinton Station', 'Southbound', 'TMU Station'), true);
  assert.equal(allowed('1', 'Davisville', 'Southbound', 'Finch Station'), false); // still a real constraint
  assert.equal(allowed('1', 'St. George Station', 'Northbound', 'St.Clair West Station'), true);
});

test('both sides are canonicalized the same way before comparing', () => {
  const canonicalizeStop = (name) => ({ 'college stn': 'college station', 'college': 'college station' }[name.toLowerCase()] || name.toLowerCase());
  // the line says "College", the candidate says "College Stn": only the shared canonical form connects them
  assert.equal(allowed('1', 'Davisville', 'Southbound', 'College Stn'), false);
  assert.equal(allowed('1', 'Davisville', 'Southbound', 'College Stn', { canonicalizeStop }), true);
  const mask = TC.getMask(realTopology, '1', 'Davisville', 'Southbound', ['college stn', 'finch'], { canonicalizeStop });
  assert.deepEqual(mask, [true, false]);
});

test('506 Westbound from College Station can end at College / St George', () => {
  assert.equal(allowed('506', 'College Station', 'Westbound', 'College / St George'), true);
  assert.equal(allowed('506', 'College Station', 'Westbound', 'College St at St George St'), true);
  assert.equal(allowed('506', 'College St at Dufferin St', 'Eastbound', 'College / St George'), true);
  assert.equal(allowed('506', 'College Station', 'Eastbound', 'College / St George'), false);
});

test('510 Southbound can end at the stops riders actually use at Nassau and Bremner', () => {
  // the plain name is the north-side (Northbound) platform on purpose; see the platform-filter test above
  assert.equal(allowed('510', 'Spadina Station', 'Southbound', 'Spadina Ave at Nassau St South Side'), true);
  assert.equal(allowed('510', 'Spadina Station', 'Southbound', 'Nassau / Spadina'), true);
  assert.equal(allowed('510', 'Spadina Station', 'Southbound', 'Spadina / Bremner'), true);
  assert.equal(allowed('510', 'Spadina Station', 'Southbound', 'Queens Quay Loop at Lower Spadina Ave'), true);
  assert.equal(allowed('510', 'Spadina Ave at Harbord St', 'Northbound', 'Spadina Station'), true);
});
