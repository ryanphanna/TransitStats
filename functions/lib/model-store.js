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
// The pointer is written last, so a half-finished upload is never loaded: files live in
// models/<version>/ and models/latest.json names the complete version.
const POINTER = PREFIX + 'latest.json';
const DEFAULT_BUCKET = 'transitstats-21ba4.firebasestorage.app';
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

const JSON_FILES = {
  endStopV4: 'model_v4_endstop.json',
  endStopV4Meta: 'model_v4_endstop_meta.json',
  endStopV5Meta: 'model_v5_endstop_meta.json',
};
const BINARY_FILES = {
  endStopV5Onnx: 'model_v5_endstop.onnx',
};
// End-stop models only. The route models were removed; a published set that still holds their
// files loads fine, because only the files named here are read.
const MODEL_FILE_NAMES = [...Object.values(JSON_FILES), ...Object.values(BINARY_FILES)];
// models/<version>/ also holds eval_rows.json (the retrain gate's per-trip results). It is not a
// model file: it is deliberately absent from these lists, so serving never downloads it.

let _models = null;
let _checkedAt = 0;
let _inflight = null;

function bucketName() {
  return process.env.ML_MODEL_BUCKET || DEFAULT_BUCKET;
}

function getBucket() {
  // The admin app is initialised without a default bucket, so always name it.
  return require('firebase-admin/storage').getStorage().bucket(bucketName());
}

async function loadFromSource() {
  let read;
  if (process.env.ML_MODEL_DIR) {
    // Local runs and tests: a plain folder of model files, no pointer.
    read = name => fs.promises.readFile(path.join(process.env.ML_MODEL_DIR, name));
  } else {
    const bucket = getBucket();
    const [pointerBytes] = await bucket.file(POINTER).download();
    const { version } = JSON.parse(pointerBytes.toString('utf8'));
    if (!version) throw new Error('models/latest.json has no version');
    read = async name => (await bucket.file(`${PREFIX}${version}/${name}`).download())[0];
  }
  const models = {};
  for (const [key, name] of Object.entries(JSON_FILES)) {
    models[key] = JSON.parse((await read(name)).toString('utf8'));
  }
  for (const [key, name] of Object.entries(BINARY_FILES)) {
    models[key] = await read(name);
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
  endStop: null,
  reset() {
    this.endStop = null;
  },
};

async function getOnnxSession(kind = 'endStop') {
  const models = _models;
  if (!models || kind !== 'endStop') return null;
  const ort = require('onnxruntime-node');
  if (!_session.endStop) _session.endStop = await ort.InferenceSession.create(models.endStopV5Onnx);
  return _session.endStop;
}

function resetForTests() {
  _models = null;
  _checkedAt = 0;
  _inflight = null;
  _session.reset();
}

module.exports = { ensure, current, isUserAllowed, getOnnxSession, resetForTests, bucketName, MODEL_FILE_NAMES, PREFIX, POINTER };
