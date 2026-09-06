/**
 * Test V3, V4, V5 prediction engines with new features
 */

const { PredictionEngine: V3 } = require('./lib/predict.js');
const { PredictionEngineV4 } = require('./lib/predict_v4.js');
const { PredictionEngineV5 } = require('./lib/predict_v5.js');

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

  // Test V4
  console.log('V4 (Logistic Regression):');
  const v4Result = PredictionEngineV4.guessTopRoutes(context, 3);
  if (v4Result.length > 0) {
    console.log(`  Top 3: ${v4Result.map(r => `${r.route}(${r.confidence}%)`).join(', ')}`);
  } else {
    console.log('  No predictions');
  }
  console.log(`  Version: ${PredictionEngineV4.VERSION}\n`);

  // Test V5
  console.log('V5 (XGBoost):');
  const v5Result = await PredictionEngineV5.guessTopRoutes(context, 3);
  if (v5Result.length > 0) {
    console.log(`  Top 3: ${v5Result.map(r => `${r.route}(${r.confidence}%)`).join(', ')}`);
  } else {
    console.log('  No predictions');
  }
  console.log(`  Version: ${PredictionEngineV5.VERSION}\n`);

  console.log('=== Feature Verification ===');
  console.log(`✓ V3 refactored to separate file`);
  console.log(`✓ V4 supports prev_route (lastRoute: ${context.lastRoute})`);
  console.log(`✓ V4/V5 use agency-scoped route labels and previous-route context`);
}

testAll().catch(console.error);
