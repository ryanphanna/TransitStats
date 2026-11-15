/**
 * set-admin.js
 *
 * Grants or revokes admin in one atomic write across both places the app
 * checks admin status: allowedUsers/{email} (Firestore rules, SMS backend)
 * and profiles/{userId} (web client UI gating). These two
 * flags are independent and nothing in the app keeps them in sync - this
 * script exists so granting/revoking admin is one command instead of two
 * manual Firestore edits that are easy to forget one half of.
 *
 * Usage:
 *   node Tools/set-admin.js <email> [--revoke] [--apply]
 *
 * Without --apply, prints what would change and writes nothing.
 *
 * Requires the Firebase Admin SDK service account key at:
 *   /Users/ryan/Desktop/Dev/Credentials/Firebase for Transit Stats.json
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const KEY_PATH = '/Users/ryan/Desktop/Dev/Credentials/Firebase for Transit Stats.json';
const APPLY = process.argv.includes('--apply');
const REVOKE = process.argv.includes('--revoke');

function parseEmail(argv) {
  return argv.slice(2).find((arg) => !arg.startsWith('--')) || null;
}

async function run() {
  const email = parseEmail(process.argv);
  if (!email) {
    console.error('Usage: node Tools/set-admin.js <email> [--revoke] [--apply]');
    process.exit(1);
  }
  const normalizedEmail = email.toLowerCase();
  const targetValue = !REVOKE;

  initializeApp({ credential: cert(require(KEY_PATH)) });
  const db = getFirestore();
  const auth = getAuth();

  let uid;
  try {
    uid = (await auth.getUserByEmail(normalizedEmail)).uid;
  } catch (error) {
    console.error(`No Firebase Auth user found for ${normalizedEmail}: ${error.message}`);
    process.exit(1);
  }

  const allowedRef = db.collection('allowedUsers').doc(normalizedEmail);
  const profileRef = db.collection('profiles').doc(uid);
  const [allowedDoc, profileDoc] = await Promise.all([allowedRef.get(), profileRef.get()]);

  console.log(`Email:   ${normalizedEmail}`);
  console.log(`UID:     ${uid}`);
  console.log(`Action:  ${REVOKE ? 'revoke' : 'grant'} admin`);
  console.log(`allowedUsers/${normalizedEmail}  isAdmin: ${allowedDoc.data()?.isAdmin ?? '(missing doc)'} -> ${targetValue}`);
  if (!profileDoc.exists) {
    console.log(`profiles/${uid}  (no profile doc - only allowedUsers will be written)`);
  } else {
    console.log(`profiles/${uid}  isAdmin: ${profileDoc.data()?.isAdmin ?? false} -> ${targetValue}`);
  }

  if (!APPLY) {
    console.log('\nDry run - no changes written. Re-run with --apply to commit.');
    return;
  }

  const batch = db.batch();
  batch.set(allowedRef, { email: normalizedEmail, isAdmin: targetValue }, { merge: true });
  if (profileDoc.exists) batch.set(profileRef, { isAdmin: targetValue }, { merge: true });
  await batch.commit();

  console.log(`\nDone - both flags set for ${normalizedEmail}.`);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
