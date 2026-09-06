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

module.exports = {
  canonicalizeStop,
  getStopFeature,
  normalizeDirectionForMl,
  normalizeRouteForMl,
  getGapFeatures,
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
