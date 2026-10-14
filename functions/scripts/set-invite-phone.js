#!/usr/bin/env node
/**
 * Add (or change) the phone number on an invite, so that person can start by
 * texting. Saving the number also triggers the one-time welcome text.
 *
 *   node scripts/set-invite-phone.js --email someone@example.com --phone "(416) 555-0123" [--dry-run]
 *
 * Needs Admin credentials, e.g. GOOGLE_APPLICATION_CREDENTIALS pointing at a
 * service account for the transitstats-21ba4 project.
 */
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { normalizePhoneNumber } = require('../lib/otp');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--email') args.email = argv[++i];
    else if (argv[i] === '--phone') args.phone = argv[++i];
  }
  return args;
}

/** Validates and applies the change. `db` is injectable for tests. */
async function setInvitePhone({ db, email, phone, dryRun = false, FieldValueImpl = FieldValue }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail.includes('@')) throw new Error('A valid --email is required.');
  const normalized = normalizePhoneNumber(phone);
  if (!/^\+[1-9]\d{9,14}$/.test(normalized)) throw new Error(`"${phone}" is not a valid phone number.`);

  const ref = db.collection('allowedUsers').doc(cleanEmail);
  const invite = await ref.get();
  if (!invite.exists) throw new Error(`No invite found for ${cleanEmail}. Add the invite first.`);

  const holders = await db.collection('allowedUsers').where('phone', '==', normalized).get();
  const other = holders.docs.find(doc => doc.id.toLowerCase() !== cleanEmail);
  if (other) throw new Error(`${normalized} is already on the invite for ${other.id}.`);

  const linked = await db.collection('phoneNumbers').doc(normalized).get();
  if (linked.exists && String(linked.data().email || '').toLowerCase() !== cleanEmail) {
    throw new Error(`${normalized} is already linked to another account.`);
  }

  if (!dryRun) await ref.update({ phone: normalized, phoneUpdatedAt: FieldValueImpl.serverTimestamp() });
  return { email: cleanEmail, phone: normalized, applied: !dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  initializeApp({ credential: applicationDefault(), projectId: 'transitstats-21ba4' });
  const result = await setInvitePhone({ db: getFirestore(), ...args });
  console.log(result.applied
    ? `Saved ${result.phone} on ${result.email}. The welcome text will go out shortly.`
    : `Dry run: would save ${result.phone} on ${result.email}.`);
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { setInvitePhone, parseArgs };
