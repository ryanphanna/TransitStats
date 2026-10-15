const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ModelStore = require('./lib/model-store');
const { uploadModels, parseArgs, EVAL_ROWS_FILE } = require('./scripts/upload-models');

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
  assert.equal(logs.length, ModelStore.MODEL_FILE_NAMES.length + 2);  // target line + every file + pointer line
});

test('upload script: versioned folder first, pointer last, refuses a partial set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up2-'));
  writeFixtureModels(dir);
  const events = [];
  const bucket = {
    name: 'b',
    upload: async (src, opts) => events.push(opts.destination),
    file: name => ({ save: async body => events.push(`${name}=${body}`) }),
  };
  const version = await uploadModels({ dir, bucket, version: 'v1', log: () => {} });
  assert.equal(version, 'v1');
  assert.equal(events.length, ModelStore.MODEL_FILE_NAMES.length + 1);
  assert.deepEqual(events.slice(0, -1).sort(), ModelStore.MODEL_FILE_NAMES.map(n => `models/v1/${n}`).sort());
  assert.match(events.at(-1), /^models\/latest\.json=.*"version":"v1"/);

  fs.rmSync(path.join(dir, 'model_v4.json'));
  await assert.rejects(() => uploadModels({ dir, bucket, log: () => {} }), /Missing model files/);
});

test('upload script: dry run names the resolved bucket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up3-'));
  writeFixtureModels(dir);
  const logs = [];
  await uploadModels({ dir, dryRun: true, bucketLabel: ModelStore.bucketName(), log: m => logs.push(m) });
  assert.match(logs[0], /gs:\/\/transitstats-21ba4\.firebasestorage\.app\/models\//);
});

test('bucket defaults to the project bucket and can be overridden', () => {
  assert.equal(ModelStore.bucketName(), 'transitstats-21ba4.firebasestorage.app');
  process.env.ML_MODEL_BUCKET = 'other-bucket';
  assert.equal(ModelStore.bucketName(), 'other-bucket');
  delete process.env.ML_MODEL_BUCKET;
});

test('loads the version named by the pointer, never a mix', async () => {
  const files = new Map();
  for (const n of ModelStore.MODEL_FILE_NAMES) {
    const body = n.endsWith('.onnx') ? Buffer.from([9]) : Buffer.from(JSON.stringify({ file: n, v: 'new' }));
    files.set(`models/new/${n}`, body);
    files.set(`models/old/${n}`, Buffer.from(JSON.stringify({ file: n, v: 'old' })));
  }
  files.set('models/latest.json', Buffer.from(JSON.stringify({ version: 'new' })));
  const bucket = { file: name => ({ download: async () => { if (!files.has(name)) throw new Error('404 ' + name); return [files.get(name)]; } }) };
  const storage = require('firebase-admin/storage');
  const original = storage.getStorage;
  Object.defineProperty(storage, 'getStorage', { value: () => ({ bucket: () => bucket }), configurable: true });
  try {
    const models = await ModelStore.ensure();
    assert.equal(models.routeV4Meta.v, 'new');
  } finally {
    Object.defineProperty(storage, 'getStorage', { value: original, configurable: true });
  }
});

test('upload script: fails loudly when the bucket does not exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up4-'));
  writeFixtureModels(dir);
  const bucket = { name: 'nope', exists: async () => [false], upload: async () => { throw new Error('should not upload'); } };
  await assert.rejects(() => uploadModels({ dir, bucket, bucketLabel: 'nope', log: () => {} }), /does not exist.*Firebase Storage/);
  await assert.rejects(() => uploadModels({ dir, bucket, bucketLabel: 'nope', dryRun: true, log: () => {} }), /does not exist/);
});

test('upload script: eval_rows.json goes with the set, pointer still last; required when asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up5-'));
  writeFixtureModels(dir);
  const events = [];
  const bucket = {
    name: 'b',
    upload: async (src, opts) => events.push(opts.destination),
    file: name => ({ save: async body => events.push(`${name}=${body}`) }),
  };
  await assert.rejects(() => uploadModels({ dir, bucket, requireEvalRows: true, log: () => {} }), /Missing model files.*eval_rows\.json/);
  assert.equal(events.length, 0);

  fs.writeFileSync(path.join(dir, EVAL_ROWS_FILE), JSON.stringify({ rows: [] }));
  await uploadModels({ dir, bucket, version: 'v2', requireEvalRows: true, log: () => {} });
  assert.ok(events.includes(`models/v2/${EVAL_ROWS_FILE}`));
  assert.equal(events.length, ModelStore.MODEL_FILE_NAMES.length + 2);
  assert.match(events.at(-1), /^models\/latest\.json=.*"version":"v2"/);
});

test('eval_rows.json is never a model file, so serving never loads it', async () => {
  assert.ok(!ModelStore.MODEL_FILE_NAMES.includes(EVAL_ROWS_FILE));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-up6-'));
  writeFixtureModels(dir);
  fs.writeFileSync(path.join(dir, EVAL_ROWS_FILE), 'not json at all');
  process.env.ML_MODEL_DIR = dir;
  const models = await ModelStore.ensure();
  assert.ok(models);
  assert.ok(!Object.values(models).some(v => v && v.rows));
});

test('upload script: --version and --require-eval-rows parse', () => {
  const a = parseArgs(['--dir', 'ml', '--version', '20261019T040000Z', '--require-eval-rows']);
  assert.equal(a.version, '20261019T040000Z');
  assert.equal(a.requireEvalRows, true);
});
