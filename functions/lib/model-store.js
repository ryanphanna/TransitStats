/**
 * Private store for the trained prediction models.
 *
 * The models contain real stop and route names, so they live in a private Cloud Storage
 * path (models/ in the default bucket), never in the repo. They are read with the Admin SDK,
 * cached in memory, and refreshed hourly. If any file is missing the store reports no models
 * and predictions fall back to the rule-based engine.
 *
 * Only users listed in ML_ALLOWED_USER_IDS get ML predictions; an empty list means nobody.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const PREFIX = 'models/';
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

const JSON_FILES = {
  routeV4: 'model_v4.json',
  routeV4Meta: 'model_v4_meta.json',
  endStopV4: 'model_v4_endstop.json',
  endStopV4Meta: 'model_v4_endstop_meta.json',
  routeV5Meta: 'model_v5_meta.json',
  endStopV5Meta: 'model_v5_endstop_meta.json',
};
const BINARY_FILES = {
  routeV5Onnx: 'model_v5.onnx',
  endStopV5Onnx: 'model_v5_endstop.onnx',
};
const MODEL_FILE_NAMES = [...Object.values(JSON_FILES), ...Object.values(BINARY_FILES)];

let _models = null;
let _checkedAt = 0;
let _inflight = null;

async function readModelFile(name) {
  // ML_MODEL_DIR reads from disk instead of Cloud Storage (local runs and tests).
  if (process.env.ML_MODEL_DIR) {
    return fs.promises.readFile(path.join(process.env.ML_MODEL_DIR, name));
  }
  const { getStorage } = require('firebase-admin/storage');
  const bucket = getStorage().bucket(process.env.ML_MODEL_BUCKET || undefined);
  const [contents] = await bucket.file(PREFIX + name).download();
  return contents;
}

async function loadFromSource() {
  const models = {};
  for (const [key, name] of Object.entries(JSON_FILES)) {
    models[key] = JSON.parse((await readModelFile(name)).toString('utf8'));
  }
  for (const [key, name] of Object.entries(BINARY_FILES)) {
    models[key] = await readModelFile(name);
  }
  return models;
}

/** Loads (or refreshes) the models. Resolves to the model set, or null when unavailable. */
async function ensure() {
  const age = Date.now() - _checkedAt;
  if (_models ? age < REFRESH_MS : age < RETRY_AFTER_FAILURE_MS && _checkedAt) return _models;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const loaded = await loadFromSource();
      _models = loaded;
      _session.reset();
    } catch (error) {
      logger.warn('[ModelStore] Models unavailable; predictions fall back to rules.', { error: error.message });
      // Keep serving the last good set if a refresh fails.
    } finally {
      _checkedAt = Date.now();
      _inflight = null;
    }
    return _models;
  })();
  return _inflight;
}

/** The currently loaded models (no I/O). Call ensure() first. */
function current() {
  return _models;
}

// Declared at module level so `firebase deploy` sees the param (set it in functions/.env or at deploy).
let allowedParam = null;
try {
  allowedParam = require('firebase-functions/params').defineString('ML_ALLOWED_USER_IDS', { default: '' });
} catch (_) {
  // Outside the Functions tooling the plain env var is used.
}

function allowedUserIds() {
  let raw = process.env.ML_ALLOWED_USER_IDS || '';
  try {
    raw = allowedParam?.value() || raw;
  } catch (_) {
    // Param not resolved in this context; keep the env var.
  }
  return new Set(String(raw).split(',').map(id => id.trim()).filter(Boolean));
}

/** True only for users the models were trained on. Fail-closed: an empty list allows nobody. */
function isUserAllowed(userId) {
  if (!userId) return false;
  return allowedUserIds().has(String(userId));
}

// ONNX sessions are built from the loaded buffers and dropped when the models refresh.
const _session = {
  route: null,
  endStop: null,
  reset() {
    this.route = null;
    this.endStop = null;
  },
};

async function getOnnxSession(kind) {
  const models = _models;
  if (!models) return null;
  const ort = require('onnxruntime-node');
  const key = kind === 'route' ? 'routeV5Onnx' : 'endStopV5Onnx';
  if (!_session[kind]) _session[kind] = await ort.InferenceSession.create(models[key]);
  return _session[kind];
}

function resetForTests() {
  _models = null;
  _checkedAt = 0;
  _inflight = null;
  _session.reset();
}

module.exports = { ensure, current, isUserAllowed, getOnnxSession, resetForTests, MODEL_FILE_NAMES, PREFIX };
