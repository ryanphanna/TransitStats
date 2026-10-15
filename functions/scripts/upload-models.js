#!/usr/bin/env node
/**
 * Upload the trained prediction models to the private Cloud Storage path the functions read.
 *
 *   node scripts/upload-models.js [--dir ../ml] [--bucket <name>] [--dry-run]
 *
 * --dir     folder that holds the model_v*.json / model_v*.onnx files (default: lib/, the old location)
 * --bucket  bucket name (default: ML_MODEL_BUCKET, else transitstats-21ba4.firebasestorage.app)
 * Files go to models/<version>/ and models/latest.json (the pointer) is written last, so the
 * functions never load a half-uploaded set.
 * --check-bucket  with --dry-run, also connect and fail if the bucket doesn't exist (needs credentials)
 * --version <v>   publish under this version (the retrain passes the one the eval gate recorded)
 * --require-eval-rows  fail unless eval_rows.json (the retrain gate's per-trip results, ml/eval_gate.py)
 *                 is in --dir. It is uploaded next to the models but is not a model file, so
 *                 model-store never loads it.
 * Needs Admin credentials (GOOGLE_APPLICATION_CREDENTIALS) with write access to the bucket.
 * Every file must exist, so a half-finished upload can't leave the functions on a mixed model set.
 */
const fs = require('fs');
const path = require('path');
const { MODEL_FILE_NAMES, PREFIX, POINTER, bucketName } = require('../lib/model-store');

// Uploaded with the model set when present (required with --require-eval-rows), never loaded at serve time.
const EVAL_ROWS_FILE = 'eval_rows.json';

function parseArgs(argv) {
  const args = { dryRun: false, dir: path.join(__dirname, '..', 'lib') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--dir') args.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--bucket') args.bucket = argv[++i];
    else if (argv[i] === '--check-bucket') args.checkBucket = true;
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--require-eval-rows') args.requireEvalRows = true;
  }
  return args;
}

function newVersion() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** `bucket` is injectable for tests. Returns the version that was (or would be) published. */
async function uploadModels({ dir, bucket, bucketLabel = '', dryRun = false, version = newVersion(), requireEvalRows = false, log = console.log }) {
  const missing = MODEL_FILE_NAMES.filter(name => !fs.existsSync(path.join(dir, name)));
  const hasEvalRows = fs.existsSync(path.join(dir, EVAL_ROWS_FILE));
  if (requireEvalRows && !hasEvalRows) missing.push(EVAL_ROWS_FILE);
  if (missing.length) throw new Error(`Missing model files in ${dir}: ${missing.join(', ')}`);
  const names = hasEvalRows ? [...MODEL_FILE_NAMES, EVAL_ROWS_FILE] : MODEL_FILE_NAMES;

  if (bucket && typeof bucket.exists === 'function') {
    const [exists] = await bucket.exists();
    if (!exists) throw new Error(`Bucket ${bucketLabel || bucket.name} does not exist. Is Firebase Storage enabled for the project?`);
  }
  log(`${dryRun ? '[dry-run] ' : ''}target gs://${bucketLabel || bucket?.name}/${PREFIX}${version}/`);
  for (const name of names) {
    const size = fs.statSync(path.join(dir, name)).size;
    if (dryRun) {
      log(`[dry-run] would upload ${name} (${size} bytes)`);
    } else {
      await bucket.upload(path.join(dir, name), { destination: `${PREFIX}${version}/${name}`, resumable: false });
      log(`uploaded ${name} (${size} bytes)`);
    }
  }
  if (dryRun) {
    log(`[dry-run] would point ${POINTER} at ${version}`);
  } else {
    await bucket.file(POINTER).save(JSON.stringify({ version, files: MODEL_FILE_NAMES }), { contentType: 'application/json' });
    log(`published ${POINTER} -> ${version}`);
  }
  return version;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.bucket || bucketName();
  let bucket = null;
  if (!args.dryRun || args.checkBucket) {
    const { initializeApp, applicationDefault } = require('firebase-admin/app');
    const { getStorage } = require('firebase-admin/storage');
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || 'transitstats-21ba4',
      storageBucket: name,
    });
    bucket = getStorage().bucket(name);
  }
  await uploadModels({
    dir: args.dir, bucket, bucketLabel: name, dryRun: args.dryRun,
    requireEvalRows: Boolean(args.requireEvalRows), ...(args.version ? { version: args.version } : {}),
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { uploadModels, parseArgs, EVAL_ROWS_FILE };
