import { vi } from 'vitest';
import { PredictionEngine } from '../js/predict';

vi.mock('../js/firebase.js', () => ({ auth: { currentUser: null }, db: {} }));

// Ensure the engine starts with a clean stops library for each test
beforeEach(() => {
  PredictionEngine.stopsLibrary = [];
});

// ---------------------------------------------------------------------------
// _canonicalizeStop
// ---------------------------------------------------------------------------

describe('PredictionEngine._canonicalizeStop', () => {
  test('null returns null', () => {
    expect(PredictionEngine._canonicalizeStop(null)).toBeNull();
  });

  test('lowercases and trims', () => {
    expect(PredictionEngine._canonicalizeStop('  UNION  ')).toBe('union');
  });

  test('"&" and "@" are replaced with "/"', () => {
    expect(PredictionEngine._canonicalizeStop('Queen & Spadina')).toBe('queen/spadina');
    expect(PredictionEngine._canonicalizeStop('Queen @ Spadina')).toBe('queen/spadina');
  });

  test('"at" is replaced with "/"', () => {
    expect(PredictionEngine._canonicalizeStop('Queen at Spadina')).toBe('queen/spadina');
  });

  test('stops library alias resolves to canonical name', () => {
    PredictionEngine.stopsLibrary = [
      { name: 'Union Station', aliases: ['Union', 'Union St'] },
    ];
    expect(PredictionEngine._canonicalizeStop('union')).toBe('union station');
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union station');
  });
});

// ---------------------------------------------------------------------------
// Cache reset when the stops library is replaced
// ---------------------------------------------------------------------------

describe('PredictionEngine stops library replacement', () => {
  test('names cached before the library loaded resolve once it loads', () => {
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union st');
    PredictionEngine.stopsLibrary = [
      { name: 'Union Station', aliases: ['Union St'] },
    ];
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union station');
  });

  test('a replaced library drops the old aliases', () => {
    PredictionEngine.stopsLibrary = [{ name: 'Union Station', aliases: ['Union St'] }];
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union station');
    PredictionEngine.stopsLibrary = [{ name: 'Union Stn', aliases: ['Union St'] }];
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union stn');
  });

  test('MapEngine.setStopSources resets the canonicalizer caches', async () => {
    const { MapEngine } = await import('../js/map-engine.js');
    MapEngine.map = null;
    await MapEngine.setStopSources({ firestoreStops: [{ name: 'Union Station', aliases: ['Union St'] }] });
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union station');
    await MapEngine.setStopSources({ firestoreStops: [{ name: 'Union Stn', aliases: ['Union St'] }] });
    expect(PredictionEngine._canonicalizeStop('Union St')).toBe('union stn');
  });
});

// ---------------------------------------------------------------------------
// #405: names shared across agencies resolve within the trip's agency
// ---------------------------------------------------------------------------

describe('PredictionEngine._canonicalizeStop agency preference (#405)', () => {
  const library = [
    { name: 'Union Station', aliases: ['Union'], agency: 'TTC', agencies: ['GO Transit'] },
    { name: 'Union Station Patsaouras Bus Plaza', aliases: ['Union Station'], agency: 'LA Metro' },
  ];

  test('a TTC or GO trip resolves Union Station to the TTC stop', () => {
    PredictionEngine.stopsLibrary = library;
    expect(PredictionEngine._canonicalizeStop('Union Station', 'TTC')).toBe('union station');
    expect(PredictionEngine._canonicalizeStop('Union Station', 'Toronto Transit Commission')).toBe('union station');
    expect(PredictionEngine._canonicalizeStop('Union Station', 'GO Transit')).toBe('union station');
  });

  test('an LA Metro trip still resolves to the LA stop', () => {
    PredictionEngine.stopsLibrary = library;
    expect(PredictionEngine._canonicalizeStop('Union Station', 'LA Metro')).toBe('union station patsaouras bus plaza');
  });

  test('unknown agency, or no stop at that agency, falls back to the library order', () => {
    PredictionEngine.stopsLibrary = library;
    expect(PredictionEngine._canonicalizeStop('Union Station')).toBe('union station patsaouras bus plaza');
    expect(PredictionEngine._canonicalizeStop('Union', 'MiWay')).toBe('union station');
  });
});
