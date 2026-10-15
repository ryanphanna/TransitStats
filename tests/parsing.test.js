const {
  parseStopInput,
  parseMultiLineTripFormat,
  parseCasualTripFormat,
  parseEndTripFormat,
  parseAgencyOverride,
  isHeuristicLogValid,
} = require('../functions/lib/parsing');

// ---------------------------------------------------------------------------
// parseStopInput
// ---------------------------------------------------------------------------

describe('parseStopInput', () => {
  test('empty string returns nulls', () => {
    expect(parseStopInput('')).toEqual({ stopCode: null, stopName: null });
  });

  test('whitespace-only returns nulls', () => {
    expect(parseStopInput('   ')).toEqual({ stopCode: null, stopName: null });
  });

  test('null/undefined returns nulls', () => {
    expect(parseStopInput(null)).toEqual({ stopCode: null, stopName: null });
    expect(parseStopInput(undefined)).toEqual({ stopCode: null, stopName: null });
  });

  test('pure digit string returns stopCode', () => {
    expect(parseStopInput('14202')).toEqual({ stopCode: '14202', stopName: null });
  });

  test('digits with spaces are treated as stop code (spaces stripped)', () => {
    expect(parseStopInput('123 45')).toEqual({ stopCode: '12345', stopName: null });
  });

  test('string with letters returns stopName in title case', () => {
    expect(parseStopInput('queen street')).toEqual({ stopCode: null, stopName: 'Queen Street' });
  });

  test('mixed alphanumeric is treated as stop name', () => {
    expect(parseStopInput('Main St')).toEqual({ stopCode: null, stopName: 'Main St' });
  });
});

// ---------------------------------------------------------------------------
// parseMultiLineTripFormat
// ---------------------------------------------------------------------------

describe('parseMultiLineTripFormat', () => {
  test('non-string input returns null', () => {
    expect(parseMultiLineTripFormat(12345, 'TTC')).toBeNull();
    expect(parseMultiLineTripFormat(null, 'TTC')).toBeNull();
    expect(parseMultiLineTripFormat(undefined, 'TTC')).toBeNull();
  });

  test('single-line message returns null', () => {
    expect(parseMultiLineTripFormat('501', 'TTC')).toBeNull();
  });

  test('command as first line returns null', () => {
    expect(parseMultiLineTripFormat('HELP\nMain St', 'TTC')).toBeNull();
    expect(parseMultiLineTripFormat('END\nUnion', 'TTC')).toBeNull();
    expect(parseMultiLineTripFormat('STATUS\nAnywhere', 'TTC')).toBeNull();
    expect(parseMultiLineTripFormat('stop\nUnion', 'TTC')).toBeNull(); // case-insensitive
  });

  test('explicit START prefix is accepted for multiline start messages', () => {
    const result = parseMultiLineTripFormat('Start\n2\nKipling\nWest', 'TTC');
    expect(result).toMatchObject({
      route: '2',
      stop: 'Kipling',
      direction: 'Westbound',
      agency: 'TTC',
      agencyExplicit: false,
    });
  });

  test('basic two-line message parses route and stop', () => {
    const result = parseMultiLineTripFormat('501\nQueen & Spadina', 'TTC');
    expect(result).toMatchObject({ route: '501', stop: 'Queen & Spadina', agency: 'TTC' });
  });

  test('leading/trailing newlines are ignored', () => {
    const result = parseMultiLineTripFormat('\n\n501\nQueen\n\n', 'TTC');
    expect(result).toMatchObject({ route: '501', stop: 'Queen' });
  });

  test('direction on line 3 is normalized', () => {
    const result = parseMultiLineTripFormat('501\nQueen\nSB', 'TTC');
    expect(result).toMatchObject({ route: '501', direction: 'Southbound' });
  });

  test('direction on line 2 with stop on line 3 is parsed as route/direction/stop', () => {
    const result = parseMultiLineTripFormat('506\nWest\nCollege / Spadina', 'TTC');
    expect(result).toMatchObject({
      route: '506',
      stop: 'College / Spadina',
      direction: 'Westbound',
      agency: 'TTC',
      agencyExplicit: false,
    });
  });

  test('route/direction/stop still accepts agency on line 4', () => {
    const result = parseMultiLineTripFormat('501\nNorthbound\nMain St\nGO Transit', 'TTC');
    expect(result).toMatchObject({
      route: '501',
      stop: 'Main St',
      direction: 'Northbound',
      agency: 'GO Transit',
      agencyExplicit: true,
    });
  });

  test('known agency on line 3 overrides default agency and clears direction', () => {
    const result = parseMultiLineTripFormat('501\nQueen\nOC Transpo', 'TTC');
    expect(result).toMatchObject({ agency: 'OC Transpo', direction: null });
  });

  test('known agency on line 4 overrides default agency', () => {
    const result = parseMultiLineTripFormat('501\nQueen\nSouthbound\nGO Transit', 'TTC');
    expect(result).toMatchObject({ direction: 'Southbound', agency: 'GO Transit' });
  });

  test('route trailing letter is uppercased', () => {
    const result = parseMultiLineTripFormat('510a\nDundas', 'TTC');
    expect(result.route).toBe('510A');
  });

  test('stop name is title-cased', () => {
    const result = parseMultiLineTripFormat('501\nqueen and spadina', 'TTC');
    expect(result.stop).toBe('Queen & Spadina');
  });

  test('extracts vehicle from a separate line', () => {
    const result = parseMultiLineTripFormat('506\nCollege\nWest\nVehicle 4412', 'TTC');
    expect(result).toMatchObject({
      route: '506',
      stop: 'College',
      direction: 'Westbound',
      vehicle: '4412',
    });
  });

  test('extracts vehicle from stop name in multiline', () => {
    const result = parseMultiLineTripFormat('506\nCollege (v: 4412)\nWest', 'TTC');
    expect(result).toMatchObject({
      route: '506',
      stop: 'College',
      direction: 'Westbound',
      vehicle: '4412',
    });
  });
});

// ---------------------------------------------------------------------------
// parseCasualTripFormat
// ---------------------------------------------------------------------------

describe('parseCasualTripFormat', () => {
  test('parses "I am on the [route] from [stop]" messages', () => {
    const result = parseCasualTripFormat("I'm on the 510 from Aspen and Poplar", 'TTC');
    expect(result).toMatchObject({
      route: '510',
      stop: 'Aspen & Poplar',
      direction: null,
      agency: 'TTC',
      agencyExplicit: false,
    });
  });

  test('returns null for unrelated casual text', () => {
    expect(parseCasualTripFormat('Hello there', 'TTC')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseEndTripFormat
// ---------------------------------------------------------------------------

describe('parseEndTripFormat', () => {
  test('non-string input returns null', () => {
    expect(parseEndTripFormat(null)).toBeNull();
    expect(parseEndTripFormat(42)).toBeNull();
  });

  test('non-END message returns null', () => {
    expect(parseEndTripFormat('hello')).toBeNull();
    expect(parseEndTripFormat('501\nQueen')).toBeNull();
  });

  test('bare END returns isEnd with no stop or notes', () => {
    expect(parseEndTripFormat('END')).toEqual({ isEnd: true, stop: null, route: null, notes: null });
  });

  test('STOP is also accepted', () => {
    expect(parseEndTripFormat('STOP')).toEqual({ isEnd: true, stop: null, route: null, notes: null });
  });

  test('case-insensitive first line', () => {
    expect(parseEndTripFormat('end')).toEqual({ isEnd: true, stop: null, route: null, notes: null });
  });

  test('END with stop name', () => {
    const result = parseEndTripFormat('END\nUnion');
    expect(result).toMatchObject({ isEnd: true, stop: 'Union', notes: null });
  });

  test('END with stop and notes', () => {
    const result = parseEndTripFormat('END\nUnion\nGreat ride today');
    expect(result).toMatchObject({ isEnd: true, stop: 'Union', notes: 'Great ride today' });
  });

  test('blank lines between END and stop are ignored', () => {
    const result = parseEndTripFormat('END\n\nUnion\n\nNotes here');
    expect(result).toMatchObject({ isEnd: true, stop: 'Union', notes: 'Notes here' });
  });
});

// ---------------------------------------------------------------------------
// parseAgencyOverride
// ---------------------------------------------------------------------------

describe('parseAgencyOverride', () => {
  test('message with no agency returns it unchanged', () => {
    expect(parseAgencyOverride('501 Queen')).toEqual({ agency: null, remainingMessage: '501 Queen' });
  });

  test('agency at end of message is extracted', () => {
    expect(parseAgencyOverride('501 Queen TTC')).toEqual({ agency: 'TTC', remainingMessage: '501 Queen' });
  });

  test('multi-word agency at end is extracted', () => {
    expect(parseAgencyOverride('65 Dundas GO Transit')).toEqual({ agency: 'GO Transit', remainingMessage: '65 Dundas' });
  });

  test('message that is exactly the agency name returns no override (no remaining message)', () => {
    // Just sending "TTC" is not an override — no trip data to override
    expect(parseAgencyOverride('TTC')).toEqual({ agency: null, remainingMessage: 'TTC' });
  });

  test('agency match is case-insensitive', () => {
    expect(parseAgencyOverride('501 Queen ttc')).toEqual({ agency: 'TTC', remainingMessage: '501 Queen' });
  });

  test('agency in the middle of a message is NOT extracted (only end-of-message)', () => {
    const result = parseAgencyOverride('TTC 501 Queen');
    expect(result.agency).toBeNull();
  });

  test('leading/trailing whitespace is handled', () => {
    expect(parseAgencyOverride('  501 Queen TTC  ')).toEqual({ agency: 'TTC', remainingMessage: '501 Queen' });
  });
});

// ---------------------------------------------------------------------------
// isHeuristicLogValid
// ---------------------------------------------------------------------------

describe('isHeuristicLogValid', () => {
  test('returns false for empty or null inputs', () => {
    expect(isHeuristicLogValid('', '501')).toBe(false);
    expect(isHeuristicLogValid('Union', '')).toBe(false);
    expect(isHeuristicLogValid(null, '501')).toBe(false);
    expect(isHeuristicLogValid('Union', null)).toBe(false);
  });

  test('rejects stops starting with sentence starters', () => {
    expect(isHeuristicLogValid('I am at Union', '501')).toBe(false);
    expect(isHeuristicLogValid('Hello there', '501')).toBe(false);
    expect(isHeuristicLogValid('To the Beach', '501')).toBe(false);
    expect(isHeuristicLogValid('Route 66', '66')).toBe(false);
  });

  test('rejects stops with motion sentence patterns', () => {
    expect(isHeuristicLogValid('Headed to Union', '501')).toBe(false);
    expect(isHeuristicLogValid('Going to Spadina', '501')).toBe(false);
  });

  test('rejects bad stop name keywords', () => {
    expect(isHeuristicLogValid('Bus stop', '501')).toBe(false);
    expect(isHeuristicLogValid('Streetcar at King', '501')).toBe(false);
  });

  test('rejects stop names over 60 chars', () => {
    const longStop = 'A'.repeat(61);
    expect(isHeuristicLogValid(longStop, '501')).toBe(false);
  });

  test('rejects route strings over 30 chars', () => {
    const longRoute = 'A'.repeat(31);
    expect(isHeuristicLogValid('Union', longRoute)).toBe(false);
  });

  test('accepts valid stop/route combinations', () => {
    expect(isHeuristicLogValid('Union', '501')).toBe(true);
    expect(isHeuristicLogValid('Dundas West', '505')).toBe(true);
    expect(isHeuristicLogValid('Fromm St', '501')).toBe(true);
    expect(isHeuristicLogValid('The Esplanade', '501')).toBe(true);
  });

  test('non-string inputs return false', () => {
    expect(isHeuristicLogValid(123, '501')).toBe(false);
    expect(isHeuristicLogValid('Union', 501)).toBe(false);
  });
});
