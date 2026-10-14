#!/usr/bin/env node
/**
 * Upload the trained prediction models to the private Cloud Storage path the functions read.
 *
 *   node scripts/upload-models.js [--dir ../ml] [--bucket <name>] [--dry-run]
 *
 * --dir     folder that holds the model_v*.json / model_v*.onnx files (default: lib/, the old location)
 * --bucket  bucket name (default: the project's default bucket, or ML_MODEL_BUCKET)
 * Needs Admin credentials (GOOGLE_APPLICATION_CREDENTIALS) with write access to the bucket.
 * Every file must exist, so a half-finished upload can't leave the functions on a mixed model set.
 */
const fs = require('fs');
const path = require('path');
const { MODEL_FILE_NAMES, PREFIX } = require('../lib/model-store');

function parseArgs(argv) {
  const args = { dryRun: false, dir: path.join(__dirname, '..', 'lib') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--dir') args.dir = path.resolve(argv[++i]);
    else if (argv[i] === '--bucket') args.bucket = argv[++i];
  }
  return args;
}

/** `bucket` is injectable for tests. Returns the list of files handled. */
async function uploadModels({ dir, bucket, dryRun = false, log = console.log }) {
  const missing = MODEL_FILE_NAMES.filter(name => !fs.existsSync(path.join(dir, name)));
  if (missing.length) throw new Error(`Missing model files in ${dir}: ${missing.join(', ')}`);

  for (const name of MODEL_FILE_NAMES) {
    const size = fs.statSync(path.join(dir, name)).size;
    if (dryRun) {
      log(`[dry-run] would upload ${name} (${size} bytes) to ${PREFIX}${name}`);
    } else {
      await bucket.upload(path.join(dir, name), { destination: PREFIX + name, resumable: false });
      log(`uploaded ${name} (${size} bytes)`);
    }
  }
  return MODEL_FILE_NAMES;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let bucket = null;
  if (!args.dryRun) {
    const { initializeApp, applicationDefault } = require('firebase-admin/app');
    const { getStorage } = require('firebase-admin/storage');
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || 'transitstats-21ba4',
      storageBucket: args.bucket || process.env.ML_MODEL_BUCKET || undefined,
    });
    bucket = getStorage().bucket();
    console.log(`Uploading to gs://${bucket.name}/${PREFIX}`);
  }
  await uploadModels({ dir: args.dir, bucket, dryRun: args.dryRun });
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { uploadModels, parseArgs };
