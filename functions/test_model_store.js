const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ModelStore = require('./lib/model-store');
const { uploadModels } = require('./scripts/upload-models');

function writeFixtureModels(dir) {
  for (const name of ModelStore.MODEL_FILE_NAMES) {
    const full = path.join(dir, name);
    if (name.endsWith('.onnx')) fs.writeFileSync(full, Buffer.from([1, 2, 3]));
    else fs.writeFileSync(full, JSON.stringify({ classes: ['x'], feature_names: [], file: name }));
  }
}

test.afterEach(() => {
  delete process.env.ML_MODEL_DIR;
  delete process.env.ML_ALLOWED_USER_IDS;
  ModelStore.resetForTests();
});

test('loads models from the configured directory and exposes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  writeFixtureModels(dir);
  process.env.ML_MODEL_DIR = dir;
  const models = await ModelStore.ensure();
  assert.equal(models.routeV4Meta.file, 'model_v4_meta.json');
  assert.ok(Buffer.isBuffer(models.routeV5Onnx));
  assert.equal(ModelStore.current(), models);
});

test('missing models resolve to null so predictions fall back to rules', async () => {
  process.env.ML_MODEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'models-empty-'));
  assert.equal(await ModelStore.ensure(), null);
  assert.equal(ModelStore.current(), null);
});

test('only allowlisted users may use the models, and an empty list allows nobody', () => {
  assert.equal(ModelStore.isUserAllowed('u1'), false);
  process.env.ML_ALLOWED_USER_IDS = ' u1 , u2 ';
  assert.equal(ModelStore.isUserAllowed('u1'), true);
  assert.equal(ModelStore.isUserAllowed('u2'), true);
  assert.equal(ModelStore.isUserAllowed('u3'), false);
  assert.equal(ModelStore.isUserAllowed(''), false);
  assert.equal(ModelStore.isUserAllowed(null), false);
});

test('upload script: dry run lists every file and uploads nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up-'));
  writeFixtureModels(dir);
  const uploads = [];
  const logs = [];
  await uploadModels({ dir, dryRun: true, bucket: { upload: async (...a) => uploads.push(a) }, log: m => logs.push(m) });
  assert.equal(uploads.length, 0);
  assert.equal(logs.length, ModelStore.MODEL_FILE_NAMES.length);
});

test('upload script: uploads to models/ and refuses a partial set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up2-'));
  writeFixtureModels(dir);
  const uploads = [];
  await uploadModels({ dir, bucket: { upload: async (src, opts) => uploads.push(opts.destination) }, log: () => {} });
  assert.deepEqual(uploads.sort(), ModelStore.MODEL_FILE_NAMES.map(n => `models/${n}`).sort());

  fs.rmSync(path.join(dir, 'model_v4.json'));
  await assert.rejects(() => uploadModels({ dir, bucket: { upload: async () => {} }, log: () => {} }), /Missing model files/);
});
