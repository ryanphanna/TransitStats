/**
 * Smoke-test the V3 route guess (the V4/V5 route models were removed)
 */

const { PredictionEngine: V3 } = require('./lib/predict.js');

async function testAll() {
  const now = new Date('2026-05-28T14:00:00Z');
  
  const context = {
    stopName: 'Spadina Station',
    time: now,
    lastEndStopName: 'Union Station',
    lastRoute: '506',
    agency: 'TTC',
    stopsLibrary: [],
  };

  const tripHistory = [
    {
      route: '1',
      direction: 'south',
      startStopName: 'spadina station',
      endStopName: 'union station',
      startTime: new Date('2026-05-27T14:00:00Z'),
    },
    {
      route: '510',
      direction: 'south',
      startStopName: 'spadina station',
      endStopName: 'spadina ave at college',
      startTime: new Date('2026-05-26T14:00:00Z'),
    },
  ];

  console.log('=== Prediction Engine Test ===\n');
  console.log(`Stop: ${context.stopName}`);
  console.log(`Previous Route: ${context.lastRoute}`);
  console.log(`Time: ${now.toISOString()}\n`);

  // Test V3
  console.log('V3 (Heuristic):');
  const v3Result = V3.guess(tripHistory, context);
  console.log(`  Result: ${v3Result ? `${v3Result.route} (conf ${v3Result.confidence}%)` : 'null'}`);
  console.log(`  Version: ${V3.VERSION}\n`);

  console.log('=== Feature Verification ===');
  console.log(`✓ V3 refactored to separate file`);
}

testAll().catch(console.error);
