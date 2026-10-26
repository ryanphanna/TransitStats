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
