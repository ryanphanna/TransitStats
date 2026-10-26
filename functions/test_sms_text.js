/**
 * Checks on lib/sms-text.js, the one home for user-facing reply texts.
 * Run with: node --test test_sms_text.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const smsText = require('./lib/sms-text');

// Sample arguments for every function export. Each entry is a list of calls,
// so branches (plural, stale, 0/1/many stops) all get checked. Sample values
// must not contain first-person words themselves.
const SAMPLES = {
  helpText: [[[...smsText.HELP_COMMANDS, smsText.HELP_ASK_COMMAND]]],
  activeTripStatus: [['504 King Eastbound', 'Spadina Ave (1234)', '8:05 AM', 12]],
  tripDeleted: [['504 King']],
  notesAdded: [['504 King']],
  journeyUnlinked: [['504 King']],
  tripSavedIncomplete: [['504 King']],
  phoneAlreadyLinked: [['rider@example.com']],
  tooManyAttemptsTryIn: [[1], [7]],
  registerCodeSent: [['rider@example.com']],
  otpLoginCode: [['123456']],
  registerCodeEmail: [['123456']],
  signInEmail: [['https://transitstats.fyi/sign-in?code=abc']],
  phoneCodeEmail: [['123456']],
  settingsSummary: [['TTC'], ['Automatic']],
  unknownAgency: [['Metrolinx Bus']],
  agencySet: [['GO Transit']],
  viaAgency: [['GO Transit']],
  tripStarted: [['504 King', 'Spadina Ave', ''], ['504 King', 'Spadina Ave', ' via GO Transit']],
  startedAfterIncomplete: [['501 Queen', '504 King', 'Spadina Ave', ' via GO Transit']],
  activeTripConflict: [
    [true, '501 Queen', 'Union Station', 400, '504 King', 'Spadina Ave'],
    [false, '501 Queen', 'Union Station', 20, '504 King', 'Spadina Ave'],
  ],
  endStopPrompt: [[[]], [['Union Station']], [['Union Station', 'Bathurst']], [['Union Station', 'Bathurst', 'Dufferin']]],
  achievementNote: [[1], [10], [25], [50], [100], [250], [500], [1000], [7]],
  agencyChoicePrompt: [['Union Station', 'GO Transit', 'TTC']],
  stopMatchesMultiple: [['504 King', 'King St', [{ name: 'King St West', code: '1234' }, { name: 'King St East' }]]],
  stopSet: [['King St West']],
  newTripCancelled: [['501 Queen', 'Union Station']],
  activeSavedNewCancelled: [['501 Queen', 'Union Station']],
  confirmStartReminder: [['504 King']],
  mmsStopNeeded: [[['504', '510']]],
  mmsMultipleRoutes: [['Spadina Ave', ['504', '510']]],
  mmsWhichRoute: [[['504', '510']]],
  mmsRouteReminder: [[2]],
  routeMismatch: [['501 Queen', '504']],
  tripEndedBasic: [['504 King', 'Union Station', 22]],
  tripEnded: [
    ['504 King', 'Union Station', '', 22, ''],
    ['504 King', 'Union Station', ' via GO Transit', 22, '\n\nUsually take the 1 Yonge from here.'],
  ],
  journeyLinkedNote: [['501 Queen', 0], ['501 Queen', 6]],
  slowTripNote: [[40, 15]],
  nextLegNote: [['1 Yonge-University']],
  statsSummary: [
    [{ weekCount: 1, weekTrendPct: null, monthCount: 1, monthTrendPct: null, routeCount: 1, totalMinutes: 30, topRoute: undefined }],
    [{ weekCount: 5, weekTrendPct: 25, monthCount: 20, monthTrendPct: -10, routeCount: 4, totalMinutes: 540, topRoute: ['504', 8] }],
  ],
  journeyGapTooLong: [[75.4]],
  journeyLinked: [['501 Queen', '504 King', 0.5], ['501 Queen', '504 King', 6.2]],
  mlCheckIn: [
    [{ description: 'Review end-stop accuracy', count: 50, agency: 'TTC', tripsSince: '2026-10-01', linearUrl: 'https://example.com/CIV-1' }],
    [{ description: 'Review end-stop accuracy', count: 50 }],
  ],
};

// Texts that speak in the first person today, with the exact words that break
// the rule. The follow-up wording change empties this list; the test fails if
// an entry stops breaking the rule or breaks it with different words, so the
// list always matches the texts.
const EXCEPTIONS = {
  // The quoted "I" is an example question a rider would type.
  ASK_HELP: ['I'],
};

const FIRST_PERSON = /\b(?:I'm|I've|I'll|I'd|I)\b|\b(?:me|my|we're|we've|we'll|we|us|our)\b/gi;

function firstPersonWords(str) {
  const found = new Set();
  for (const match of str.matchAll(FIRST_PERSON)) {
    const word = match[0];
    // "I" and its contractions only count in upper case ("i" is never a word here).
    if (/^i('|$)/.test(word)) continue;
    found.add(word);
  }
  return found;
}

/** All strings an export produces, flattened (arrays, objects, function results). */
function stringsOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
}

function textsFor(name) {
  const value = smsText[name];
  if (typeof value !== 'function') return stringsOf(value);
  return SAMPLES[name].flatMap(args => stringsOf(value(...args)));
}

test('every function export in sms-text.js has sample arguments', () => {
  const missing = Object.keys(smsText).filter(name => typeof smsText[name] === 'function' && !SAMPLES[name]);
  assert.deepEqual(missing, []);
  const stale = Object.keys(SAMPLES).filter(name => typeof smsText[name] !== 'function');
  assert.deepEqual(stale, []);
});

test('every sms-text.js export produces non-empty text', () => {
  for (const name of Object.keys(smsText)) {
    const texts = textsFor(name);
    assert.ok(texts.length > 0, `${name} produced no text`);
    // achievementNote returns '' for a non-milestone count on purpose.
    const nonEmpty = texts.filter(t => t.length > 0);
    assert.ok(nonEmpty.length > 0, `${name} produced only empty text`);
  }
});

test('reply texts do not speak in the first person (I, me, my, we, us, our)', () => {
  const offenders = {};
  for (const name of Object.keys(smsText)) {
    const words = new Set();
    for (const t of textsFor(name)) for (const w of firstPersonWords(t)) words.add(w);
    if (words.size) offenders[name] = [...words].sort();
  }
  const unexpected = Object.fromEntries(Object.entries(offenders).filter(([name]) => !EXCEPTIONS[name]));
  assert.deepEqual(unexpected, {}, 'New first-person wording in sms-text.js; reword it (texts speak as the app, not "I"/"we")');
});

test('the EXCEPTIONS list matches the texts exactly', () => {
  for (const [name, expected] of Object.entries(EXCEPTIONS)) {
    assert.ok(name in smsText, `EXCEPTIONS names ${name}, which sms-text.js does not export`);
    const words = new Set();
    for (const t of textsFor(name)) for (const w of firstPersonWords(t)) words.add(w);
    assert.deepEqual([...words].sort(), [...expected].sort(),
      `${name}: update its EXCEPTIONS entry (remove it once the text no longer speaks in the first person)`);
  }
});

test('the first-person check catches whole words only', () => {
  assert.deepEqual([...firstPersonWords('I\'m here, we\'ll see; email us or call me at our desk. My trip.')].sort(),
    ['I\'m', 'My', 'our', 'me', 'us', 'we\'ll'].sort());
  assert.deepEqual([...firstPersonWords('Imports, used, mess, ourselves, welcome, Unlinked, i')], []);
});

test('handlers send reply texts from sms-text.js, not inline string literals', () => {
  const libDir = path.join(__dirname, 'lib');
  // A string, template or concatenation as the message argument of sendSmsReply.
  const inlineSend = /sendSmsReply\(\s*[\w.]+\s*,\s*['"`]/g;
  const found = [];
  for (const file of fs.readdirSync(libDir)) {
    if (!file.endsWith('.js') || file === 'sms-text.js') continue;
    const source = fs.readFileSync(path.join(libDir, file), 'utf8');
    for (const match of source.matchAll(inlineSend)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push(`lib/${file}:${line}`);
    }
  }
  assert.deepEqual(found, [], 'Move these reply texts into lib/sms-text.js');
});
