/**
 * TransitStats — ML Feature Preparation
 * Centralizes the canonicalization logic used by both training (Python) and inference (Node).
 */

/**
 * Standardize a stop name using the stops library.
 * This MUST match the behavior used in ml/train_endstop.py for feature alignment.
 */
function canonicalizeStop(name, stopsLibrary = []) {
  if (!name) return 'unknown';
  
  const normalize = s => s.trim().toLowerCase()
    .replace(/\s+and\s+/g, '/')
    .replace(/\s*[/&@]\s*/g, '/')
    .replace(/\s+at\s+/g, '/');

  const lower = normalize(name);

  if (stopsLibrary && stopsLibrary.length > 0) {
    const match = stopsLibrary.find(s => {
      const candidates = [s.name, ...(s.aliases || [])];
      return candidates.some(c => normalize(c) === lower);
    });
    if (match) {
      return normalize(match.name);
    }
  }
  return lower;
}

/**
 * Build a consistent feature vector key for a stop.
 */
function getStopFeature(name, stopsLibrary = []) {
  const canon = canonicalizeStop(name, stopsLibrary);
  return `stop_${canon.replace(/[^a-z0-9]/g, '_')}`;
}

// ---------------------------------------------------------------------------
// Per-agency route normalization policies (mirrors ml/route_normalization.py)
// The Python side is the source of truth for training.
// This side must stay in sync for inference consistency.
//
// Design goal: zero baked-in agencies in the library defaults.
// Any agency (TTC or completely new) gets the neutral default until the
// caller explicitly configures it via configureFromDict / loadPolicies.
// ---------------------------------------------------------------------------

// Policy functions (implementation only — not exported directly)
function ttcCollapsePolicy(routeStr) {
  const match = routeStr.match(/^(\d+)/);
  return match ? match[1] : routeStr;
}

function defaultPreservePolicy(routeStr) {
  const compact = routeStr.match(/^(\d+)([a-zA-Z]+)$/);
  if (compact) return `${compact[1]}${compact[2].toUpperCase()}`;
  if (/^[A-Za-z]$/.test(routeStr)) return routeStr.toUpperCase();
  return routeStr;
}

function strictPreservePolicy(routeStr) {
  if (/^[A-Za-z]$/.test(routeStr)) return routeStr.toUpperCase();
  return routeStr;
}

function upperPolicy(routeStr) {
  const compact = routeStr.match(/^(\d+)([a-zA-Z]+)$/);
  if (compact) routeStr = `${compact[1]}${compact[2].toUpperCase()}`;
  return routeStr.toUpperCase();
}

// Registry + configuration state (starts completely empty / neutral)
const POLICY_REGISTRY = Object.create(null);
let defaultPolicy = defaultPreservePolicy;

const POLICY_NAME_TO_FN = Object.assign(Object.create(null), {
  collapse: ttcCollapsePolicy,
  preserve_variant: defaultPreservePolicy,
  strict_preserve: strictPreservePolicy,
  upper: upperPolicy,
});

function registerPolicy(agency, policyFn) {
  POLICY_REGISTRY[agency] = policyFn;
}

function configurePolicies(policies) {
  Object.assign(POLICY_REGISTRY, policies);
}

function configureFromDict(config) {
  for (const [agency, policyName] of Object.entries(config || {})) {
    const fn = POLICY_NAME_TO_FN[String(policyName).toLowerCase()];
    if (!fn) {
      const valid = Object.keys(POLICY_NAME_TO_FN).join(', ');
      throw new Error(`Unknown policy name: ${policyName}. Valid options: ${valid}`);
    }
    if (String(agency).toUpperCase() === 'DEFAULT') {
      defaultPolicy = fn;
    } else {
      POLICY_REGISTRY[agency] = fn;
    }
  }
}

function getPolicyForAgency(agency, primaryAgency = null) {
  if (!agency) return defaultPolicy;
  const key = agency.toString().trim();
  const primaryKey = primaryAgency ? primaryAgency.toString().trim() : null;

  if (primaryKey && key === primaryKey) {
    if (POLICY_REGISTRY['PRIMARY']) {
      return POLICY_REGISTRY['PRIMARY'];
    }
  }
  return POLICY_REGISTRY[key] || defaultPolicy;
}

function normalizeRouteForMl(route, agency = null, primaryAgency = null) {
  if (route == null) return route;
  const routeStr = route.toString().trim();
  if (!routeStr) return routeStr;

  const policyFn = getPolicyForAgency(agency, primaryAgency);
  if (typeof policyFn !== 'function') return routeStr;
  return policyFn(routeStr);
}

function agencyId(agency) {
  if (agency == null) return null;
  const key = agency.toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return key || null;
}

function scopedRouteKey(route, agency, primaryAgency = null) {
  const normalized = normalizeRouteForMl(route, agency, primaryAgency);
  const key = agencyId(agency);
  return normalized == null || !key ? null : `${key}::${normalized}`;
}

function displayScopedRouteLabel(label) {
  const value = String(label || '');
  const separator = value.indexOf('::');
  return separator >= 0 ? value.slice(separator + 2) : value;
}

function displayScopedStopLabel(label) {
  const value = String(label || '');
  const separator = value.indexOf('::');
  return separator >= 0 ? value.slice(separator + 2) : value;
}

// ---------------------------------------------------------------------------
// File loading + lifecycle (JSON only — no new dependencies for functions)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function loadPoliciesFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    throw new Error(
      'YAML support requires a parser (e.g. js-yaml). ' +
      'Use a .json file or call configureFromDict() directly.'
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const config = JSON.parse(raw);
  if (typeof config !== 'object' || config === null) {
    throw new Error('Policy file must contain a JSON object mapping agency → policy name');
  }
  configureFromDict(config);
}

function loadPolicies(configPath = null) {
  if (configPath) {
    loadPoliciesFromFile(configPath);
    return;
  }

  // Auto-discover next to this module (functions/lib/), same as Python side
  const base = __dirname;
  const candidates = ['policies.json', 'policies.yaml', 'policies.yml'];
  for (const name of candidates) {
    const full = path.join(base, name);
    if (fs.existsSync(full)) {
      loadPoliciesFromFile(full);
      return;
    }
  }

  // No file → neutral baseline (any agency gets preserve_variant)
  configureFromDict(getDefaultConfig());
}

function resetPolicies() {
  Object.keys(POLICY_REGISTRY).forEach(k => delete POLICY_REGISTRY[k]);
  defaultPolicy = defaultPreservePolicy;
}

function getDefaultConfig() {
  return { DEFAULT: 'preserve_variant' };
}

function listAvailablePolicies() {
  return Object.keys(POLICY_NAME_TO_FN).sort();
}

function getGapFeatures(minutesSinceLastTrip) {
  if (minutesSinceLastTrip === null || minutesSinceLastTrip === undefined || minutesSinceLastTrip === '') {
    return { gapLog: 0, gapMissing: 1 };
  }
  const n = Number(minutesSinceLastTrip);
  if (!Number.isFinite(n) || n < 0) {
    return { gapLog: 0, gapMissing: 1 };
  }
  const capped = Math.min(Math.max(n, 0), 720);
  return {
    gapLog: Math.log1p(capped) / Math.log1p(720),
    gapMissing: 0,
  };
}

/**
 * Normalize a direction string to a canonical ML feature key.
 * Returns a canonical cardinal or semantic direction key, or null.
 * Mirrors the normalization in ml/train_endstop.py.
 */
function normalizeDirectionForMl(dir) {
  if (!dir) return null;
  const d = dir.toString().toLowerCase().replace(/bound$/i, '').trim();
  if (d === 'n' || d === 'nb' || d === 'north') return 'northbound';
  if (d === 's' || d === 'sb' || d === 'south') return 'southbound';
  if (d === 'e' || d === 'eb' || d === 'east' || d === 'eastward') return 'eastbound';
  if (d === 'w' || d === 'wb' || d === 'west') return 'westbound';
  return d || null;
}

// ---------------------------------------------------------------------------
// End-stop feature construction shared by predict_v4.js and predict_v5.js. Training builds the same
// end-stop features in ml/train_endstop.py; test_ml_feature_parity.js and
// ml/test_feature_parity.py check both sides against one fixture.
// ---------------------------------------------------------------------------

const { AGENCY_TIMEZONE } = require('./constants');
const DEFAULT_TIMEZONE = 'America/Toronto';
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const _formatters = new Map();

/**
 * Hour (0-23) and Python-style weekday (Mon=0) of `date`.
 * timeBasis 'local' uses the agency's timezone (DST-aware), as trips store it (db/trips.js), with
 * America/Toronto for unmapped agencies; anything else keeps the old UTC features, so artifacts
 * trained before local time keep matching until the next retrain.
 */
function getHourAndDay(date, agency, timeBasis) {
  if (timeBasis !== 'local') {
    return { hour: date.getUTCHours(), pyDay: (date.getUTCDay() + 6) % 7 };
  }
  const timeZone = AGENCY_TIMEZONE[agency] || DEFAULT_TIMEZONE;
  let fmt = _formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', weekday: 'short' });
    _formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, pyDay: WEEKDAY_INDEX[parts.weekday] };
}

function sanitizeFeature(value) {
  return String(value).toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
}

/**
 * Named features for the end-stop models (one-hots are 1.0; absent names are 0). The route models
 * still build their own features in predict_v4/v5.js (UTC, unchanged).
 */
function buildEndStopFeatures(context, timeBasis) {
  const date = context.time instanceof Date ? context.time : new Date(context.time);
  const { hour, pyDay } = getHourAndDay(date, context.agency, timeBasis);
  const primary = context.primaryAgency || context.defaultAgency;
  const lastStopKey = context.lastEndStopName
    ? getStopFeature(context.lastEndStopName, context.stopsLibrary).replace('stop_', '')
    : 'none';
  const prevRoute = scopedRouteKey(context.lastRoute, context.agency, primary) || 'none';
  const route = String(scopedRouteKey(context.route, context.agency, primary)).toLowerCase();
  const { gapLog, gapMissing } = getGapFeatures(context.minutesSinceLastTrip);
  const dirNorm = normalizeDirectionForMl(context.direction);
  const f = {
    hour_sin: Math.sin(2 * Math.PI * hour / 24),
    hour_cos: Math.cos(2 * Math.PI * hour / 24),
    day_sin: Math.sin(2 * Math.PI * pyDay / 7),
    day_cos: Math.cos(2 * Math.PI * pyDay / 7),
    gap_log: gapLog,
    gap_missing: gapMissing,
    [`agency_${sanitizeFeature(context.agency || 'unknown')}`]: 1.0,
    [getStopFeature(context.startStopName, context.stopsLibrary)]: 1.0,
    [`route_${route}`]: 1.0,
    [`prev_route_${prevRoute.toString().toLowerCase()}`]: 1.0,
    [`last_stop_${lastStopKey}`]: 1.0,
  };
  if (dirNorm) f[`dir_${dirNorm}`] = 1.0;
  return f;
}

/** Dense vector in the artifact's feature order. */
function toFeatureVector(features, featureNames, ArrayType = Array) {
  const x = new ArrayType(featureNames.length).fill(0);
  for (let i = 0; i < featureNames.length; i++) {
    const v = features[featureNames[i]];
    if (v !== undefined) x[i] = v;
  }
  return x;
}

module.exports = {
  canonicalizeStop,
  getStopFeature,
  normalizeDirectionForMl,
  normalizeRouteForMl,
  agencyId,
  scopedRouteKey,
  displayScopedRouteLabel,
  displayScopedStopLabel,
  getGapFeatures,
  getHourAndDay,
  buildEndStopFeatures,
  toFeatureVector,
  // Policy configuration (full parity with Python side)
  registerPolicy,
  configurePolicies,
  configureFromDict,
  loadPoliciesFromFile,
  loadPolicies,
  resetPolicies,
  getDefaultConfig,
  listAvailablePolicies,
};
