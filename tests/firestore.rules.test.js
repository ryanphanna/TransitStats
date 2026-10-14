import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, test, expect } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { getDocs, collection, query, where } from 'firebase/firestore';

const PROJECT_ID = 'transit-stats-rules-test';
const RULES_PATH = resolve(process.cwd(), 'firestore.rules');

let testEnv;

function authedDb(uid, email, extraClaims = {}) {
    return testEnv.authenticatedContext(uid, { email, email_verified: true, ...extraClaims }).firestore();
}

// Phone-login accounts sign in with a custom token and carry no email.
function phoneDb(uid) {
    return testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: 'custom' } }).firestore();
}

async function invite(email, data = {}) {
    await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `allowedUsers/${email.toLowerCase()}`), { email, ...data });
    });
}

describe('firestore.rules: profile privilege boundaries', () => {
    beforeAll(async () => {
        testEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: {
                rules: readFileSync(RULES_PATH, 'utf8'),
            },
        });
    });

    beforeEach(async () => {
        if (testEnv) {
            await testEnv.clearFirestore();
        }
    });

    afterAll(async () => {
        if (testEnv) {
            await testEnv.cleanup();
        }
    });

    test('owner can create their own profile with non-privileged defaults', async () => {
        await invite('user@example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertSucceeds(setDoc(doc(db, 'profiles/user_1'), {
            displayName: 'User',
            defaultAgency: 'TTC',
            isPublic: false,
            isPremium: false,
            isAdmin: false,
        }));
    });

    test('owner cannot create their own profile with premium enabled', async () => {
        const db = authedDb('user_1', 'user@example.com');
        await assertFails(setDoc(doc(db, 'profiles/user_1'), {
            displayName: 'User',
            defaultAgency: 'TTC',
            isPublic: false,
            isPremium: true,
            isAdmin: false,
        }));
    });

    test('owner cannot promote themselves to premium via profile update', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'profiles/user_1'), {
                displayName: 'User',
                defaultAgency: 'TTC',
                isPublic: false,
                isPremium: false,
                isAdmin: false,
            });
        });

        const db = authedDb('user_1', 'user@example.com');
        await assertFails(updateDoc(doc(db, 'profiles/user_1'), { isPremium: true }));
    });

    test('owner cannot promote themselves to admin via profile update', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'profiles/user_1'), {
                displayName: 'User',
                defaultAgency: 'TTC',
                isPublic: false,
                isPremium: false,
                isAdmin: false,
            });
        });

        const db = authedDb('user_1', 'user@example.com');
        await assertFails(updateDoc(doc(db, 'profiles/user_1'), { isAdmin: true }));
    });

    test('admin can update privileged profile fields', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            const db = context.firestore();
            await setDoc(doc(db, 'allowedUsers/admin@example.com'), {
                email: 'admin@example.com',
                isAdmin: true,
            });
            await setDoc(doc(db, 'profiles/user_1'), {
                displayName: 'User',
                defaultAgency: 'TTC',
                isPublic: false,
                isPremium: false,
                isAdmin: false,
            });
        });

        const db = authedDb('admin_1', 'admin@example.com');
        await assertSucceeds(updateDoc(doc(db, 'profiles/user_1'), {
            isPremium: true,
            isAdmin: true,
        }));

        const snap = await getDoc(doc(db, 'profiles/user_1'));
        expect(snap.data().isPremium).toBe(true);
        expect(snap.data().isAdmin).toBe(true);
    });

    test('public profile docs are not readable by anonymous or other signed-in users', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'profiles/user_1'), {
                displayName: 'User',
                isPublic: true,
                isPremium: true,
                isAdmin: false,
            });
        });

        await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), 'profiles/user_1')));
        await assertFails(getDoc(doc(authedDb('user_2', 'other@example.com'), 'profiles/user_1')));
        await assertSucceeds(getDoc(doc(authedDb('user_1', 'user@example.com'), 'profiles/user_1')));
    });

    // isAdmin() in these rules is keyed entirely on request.auth.token.email, which is
    // populated for this app's real admin account but is not guaranteed for every sign-in
    // path (e.g. a phone-only Auth user with no email ever attached). Pin the deny-by-default
    // behavior for that case so a future rules change can't silently assume email is always set.
    test('an authenticated user with no email claim cannot exercise admin rules privileges', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            const db = context.firestore();
            await setDoc(doc(db, 'allowedUsers/admin@example.com'), {
                email: 'admin@example.com',
                isAdmin: true,
            });
            await setDoc(doc(db, 'profiles/user_1'), {
                displayName: 'User',
                defaultAgency: 'TTC',
                isPublic: false,
                isPremium: false,
                isAdmin: false,
            });
        });

        // Same uid an admin might have, but no email on the auth token - e.g. a bare
        // phone-only Auth user record that was never linked to an email account.
        const db = authedDb('admin_1', undefined);
        await assertFails(updateDoc(doc(db, 'profiles/user_1'), {
            isPremium: true,
            isAdmin: true,
        }));
    });

    test('owner can update legitimate profile fields together', async () => {
        await invite('user@example.com');
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'profiles/user_1'), {
                displayName: 'User',
                defaultAgency: 'TTC',
                isPublic: false,
                isPremium: false,
                isAdmin: false,
            });
        });

        const db = authedDb('user_1', 'user@example.com');
        await assertSucceeds(updateDoc(doc(db, 'profiles/user_1'), {
            displayName: 'New Name',
            defaultAgency: 'GO',
            isPublic: true,
            betaFeatures: { predictions: true },
            updatedAt: new Date(),
        }));
    });

    test('owner cannot write an unlisted field via profile update', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'profiles/user_1'), {
                displayName: 'User',
                defaultAgency: 'TTC',
                isPublic: false,
                isPremium: false,
                isAdmin: false,
            });
        });

        const db = authedDb('user_1', 'user@example.com');
        await assertFails(updateDoc(doc(db, 'profiles/user_1'), {
            secretRole: 'superuser',
        }));
    });
});

describe('firestore.rules: trips are never publicly readable', () => {
    beforeAll(async () => {
        testEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: {
                rules: readFileSync(RULES_PATH, 'utf8'),
            },
        });
    });

    beforeEach(async () => {
        if (testEnv) {
            await testEnv.clearFirestore();
        }
    });

    afterAll(async () => {
        if (testEnv) {
            await testEnv.cleanup();
        }
    });

    // Regression test for the Public Profile trip data exposure (see INCIDENTS.md,
    // July 2026): the trips rule once granted read on the *entire* document when
    // isPublic was true, leaking userId/route/stop names/timestamps. Trip data must
    // only ever reach a public profile page through the publicProfile Cloud Function
    // (Admin SDK, aggregate fields only) — never a direct client-side Firestore read.
    test('unauthenticated client cannot read a trip doc, even when isPublic is true', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'trips/trip_1'), {
                userId: 'user_1',
                isPublic: true,
                route: '510',
                startStopName: 'Spadina Station',
                endStopName: 'Union Station',
            });
        });

        const anonDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(getDoc(doc(anonDb, 'trips/trip_1')));
        await assertFails(getDocs(query(collection(anonDb, 'trips'), where('isPublic', '==', true))));
    });

    test('a different authenticated user cannot read a trip doc, even when isPublic is true', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'trips/trip_1'), {
                userId: 'user_1',
                isPublic: true,
                route: '510',
            });
        });

        const otherDb = authedDb('user_2', 'other@example.com');
        await assertFails(getDoc(doc(otherDb, 'trips/trip_1')));
    });

    test('the owner can still read their own trip', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'trips/trip_1'), {
                userId: 'user_1',
                isPublic: true,
                route: '510',
            });
        });

        const ownerDb = authedDb('user_1', 'user@example.com');
        await assertSucceeds(getDoc(doc(ownerDb, 'trips/trip_1')));
    });
});

describe('firestore.rules: PRESTO activity is user-scoped', () => {
    beforeAll(async () => {
        testEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: {
                rules: readFileSync(RULES_PATH, 'utf8'),
            },
        });
    });

    beforeEach(async () => {
        if (testEnv) await testEnv.clearFirestore();
    });

    afterAll(async () => {
        if (testEnv) await testEnv.cleanup();
    });

    test('owner can create and read their own PRESTO activity', async () => {
        await invite('user@example.com', { pilot: 'presto' });
        const ownerDb = authedDb('user_1', 'user@example.com');
        const activity = doc(ownerDb, 'prestoTransactions/transaction_1');
        await assertSucceeds(setDoc(activity, {
            userId: 'user_1',
            source: 'presto',
            type: 'fare_payment',
        }));
        await assertSucceeds(getDoc(activity));
    });

    test('another user cannot read or create activity for the owner', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'prestoTransactions/transaction_1'), {
                userId: 'user_1',
                source: 'presto',
            });
        });

        const otherDb = authedDb('user_2', 'other@example.com');
        await assertFails(getDoc(doc(otherDb, 'prestoTransactions/transaction_1')));
        await assertFails(setDoc(doc(otherDb, 'prestoTransactions/transaction_2'), {
            userId: 'user_1',
            source: 'presto',
        }));
    });

    test('owner cannot change activity ownership', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'prestoTransactions/transaction_1'), {
                userId: 'user_1',
                source: 'presto',
            });
        });

        const ownerDb = authedDb('user_1', 'user@example.com');
        await assertFails(updateDoc(doc(ownerDb, 'prestoTransactions/transaction_1'), {
            userId: 'user_2',
        }));
    });
});

describe('firestore.rules: rocket_trips are denied to everyone', () => {
    beforeAll(async () => {
        testEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: {
                rules: readFileSync(RULES_PATH, 'utf8'),
            },
        });
    });

    beforeEach(async () => {
        if (testEnv) await testEnv.clearFirestore();
    });

    afterAll(async () => {
        if (testEnv) await testEnv.cleanup();
    });

    test('signed-in owner cannot read or create rocket sessions', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'rocket_trips/rocket_1'), {
                userId: 'user_1',
                status: 'active',
            });
        });

        const ownerDb = authedDb('user_1', 'user@example.com');
        await assertFails(getDoc(doc(ownerDb, 'rocket_trips/rocket_1')));
        await assertFails(setDoc(doc(ownerDb, 'rocket_trips/rocket_2'), { userId: 'user_1' }));
    });

    test('unauthenticated client cannot read rocket sessions', async () => {
        const anonDb = testEnv.unauthenticatedContext().firestore();
        await assertFails(getDocs(collection(anonDb, 'rocket_trips')));
    });
});

describe('firestore.rules: account isolation and invite-only writes', () => {
    beforeAll(async () => {
        testEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
        });
    });
    beforeEach(async () => { if (testEnv) await testEnv.clearFirestore(); });
    afterAll(async () => { if (testEnv) await testEnv.cleanup(); });

    const base = { displayName: 'U', isPublic: false, isPremium: false, isAdmin: false };

    async function seedProfile(uid, data = base) {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), `profiles/${uid}`), data);
        });
    }

    // 1b: client-writable profile fields are an allowlist
    test.each(['email', 'pilot', 'phoneNumber', 'phone', 'phoneVerified', 'smsLinked'])(
        'invited owner cannot create a profile containing %s', async (field) => {
            await invite('user@example.com');
            const db = authedDb('user_1', 'user@example.com');
            await assertFails(setDoc(doc(db, 'profiles/user_1'), { ...base, [field]: 'x' }));
        });

    test.each(['email', 'pilot', 'phoneNumber', 'isAdmin', 'isPremium'])(
        'invited owner cannot set or change %s on an existing profile', async (field) => {
            await invite('user@example.com');
            await seedProfile('user_1');
            const db = authedDb('user_1', 'user@example.com');
            await assertFails(updateDoc(doc(db, 'profiles/user_1'), { [field]: field.startsWith('is') ? true : 'victim@example.com' }));
        });

    test('invited owner can still write every normal profile setting', async () => {
        await invite('user@example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertSucceeds(setDoc(doc(db, 'profiles/user_1'), {
            userId: 'user_1', ...base, username: 'bus-taco-panda', emojiUsername: 'bus-taco-panda',
            usernameAliases: ['bus-taco-panda'], usernameType: 'emoji', mapStopMode: 'boarding',
            defaultAgency: null, defaultAgencyMode: 'automatic', primaryAgency: null,
            betaFeatures: {}, createdAt: new Date(), updatedAt: new Date(),
        }));
        await assertSucceeds(updateDoc(doc(db, 'profiles/user_1'), { mapStopMode: 'exiting', isPublic: true }));
    });

    test('profile update cannot repoint userId at someone else', async () => {
        await invite('user@example.com');
        await seedProfile('user_1', { ...base, userId: 'user_1' });
        const db = authedDb('user_1', 'user@example.com');
        await assertFails(updateDoc(doc(db, 'profiles/user_1'), { userId: 'victim' }));
        await assertSucceeds(updateDoc(doc(db, 'profiles/user_1'), { userId: 'user_1', isPublic: true }));
    });

    test('a profile cannot be created for another uid', async () => {
        await invite('user@example.com');
        await assertFails(setDoc(doc(authedDb('user_1', 'user@example.com'), 'profiles/user_2'), base));
    });

    // 2: invite-only
    test('a signed-in but uninvited account cannot write any user data', async () => {
        const db = authedDb('stranger', 'stranger@example.com');
        await assertFails(setDoc(doc(db, 'profiles/stranger'), base));
        await assertFails(setDoc(doc(db, 'trips/t1'), { userId: 'stranger' }));
        await assertFails(setDoc(doc(db, 'templates/t1'), { userId: 'stranger' }));
        await assertFails(setDoc(doc(db, 'prestoTransactions/p1'), { userId: 'stranger' }));
        await assertFails(setDoc(doc(db, 'predictionStats/s1'), { userId: 'stranger' }));
        await assertFails(setDoc(doc(db, 'usernames/bus-taco-panda'), { uid: 'stranger', type: 'emoji' }));
    });

    test('an unverified email does not count as invited', async () => {
        await invite('user@example.com');
        const db = testEnv.authenticatedContext('user_1', { email: 'user@example.com', email_verified: false }).firestore();
        await assertFails(setDoc(doc(db, 'trips/t1'), { userId: 'user_1' }));
    });

    test('invited email accounts can write their own data', async () => {
        await invite('User@Example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertSucceeds(setDoc(doc(db, 'trips/t1'), { userId: 'user_1' }));
        await assertSucceeds(setDoc(doc(db, 'templates/t1'), { userId: 'user_1' }));
        await assertSucceeds(setDoc(doc(db, 'predictionStats/s1'), { userId: 'user_1' }));
        await assertSucceeds(setDoc(doc(db, 'usernames/bus-taco-panda'), { uid: 'user_1', type: 'emoji' }));
    });

    test('phone (custom token) accounts can write their own trips, anonymous and other providers cannot', async () => {
        await assertSucceeds(setDoc(doc(phoneDb('phone_1'), 'trips/t1'), { userId: 'phone_1' }));
        const anon = testEnv.authenticatedContext('anon_1', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
        await assertFails(setDoc(doc(anon, 'trips/t2'), { userId: 'anon_1' }));
        const google = testEnv.authenticatedContext('g_1', { firebase: { sign_in_provider: 'google.com' } }).firestore();
        await assertFails(setDoc(doc(google, 'trips/t3'), { userId: 'g_1' }));
    });

    test('owners can still delete their own data and read it', async () => {
        await invite('user@example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertSucceeds(setDoc(doc(db, 'trips/t1'), { userId: 'user_1' }));
        await assertSucceeds(getDoc(doc(db, 'trips/t1')));
        await assertSucceeds(deleteDoc(doc(db, 'trips/t1')));
    });

    // 3: trips/templates cannot be reassigned
    test.each(['trips', 'templates'])('%s update cannot reassign userId', async (collectionName) => {
        await invite('user@example.com');
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), `${collectionName}/x1`), { userId: 'user_1', note: 'a' });
        });
        const db = authedDb('user_1', 'user@example.com');
        await assertSucceeds(updateDoc(doc(db, `${collectionName}/x1`), { note: 'b' }));
        await assertFails(updateDoc(doc(db, `${collectionName}/x1`), { userId: 'victim' }));
    });

    // 5: admin needs a verified email
    test('an admin email that is not verified has no admin powers', async () => {
        await invite('admin@example.com', { isAdmin: true });
        await seedProfile('user_1');
        const unverified = testEnv.authenticatedContext('admin_1', { email: 'admin@example.com', email_verified: false }).firestore();
        await assertFails(updateDoc(doc(unverified, 'profiles/user_1'), { isPremium: true }));
        await assertSucceeds(updateDoc(doc(authedDb('admin_1', 'admin@example.com'), 'profiles/user_1'), { isPremium: true }));
    });

    // 5: emoji usernames must be real emoji identities
    test('emoji usernames must be three distinct known emoji keys', async () => {
        await invite('user@example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertFails(setDoc(doc(db, 'usernames/hello-world'), { uid: 'user_1', type: 'emoji' }));
        await assertFails(setDoc(doc(db, 'usernames/bus-bus-taco'), { uid: 'user_1', type: 'emoji' }));
        await assertFails(setDoc(doc(db, 'usernames/bus-taco'), { uid: 'user_1', type: 'emoji' }));
        await assertFails(setDoc(doc(db, 'usernames/admin'), { uid: 'user_1', type: 'emoji' }));
        await assertSucceeds(setDoc(doc(db, 'usernames/fox-taco-owl'), { uid: 'user_1', type: 'emoji' }));
    });

    test('the rules emoji list matches js/identity.js', async () => {
        const rules = readFileSync(RULES_PATH, 'utf8');
        const listed = [...rules.match(/function emojiKeys\(\) \{\s*return \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
        const { Identity } = await import('../js/identity.js');
        expect(listed.sort()).toEqual(Object.keys(Identity.LIBRARY).sort());
    });
});

describe('firestore.rules: PRESTO import is pilot-only', () => {
    beforeAll(async () => {
        testEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
        });
    });
    beforeEach(async () => { if (testEnv) await testEnv.clearFirestore(); });
    afterAll(async () => { if (testEnv) await testEnv.cleanup(); });

    const row = uid => ({ userId: uid, source: 'presto', type: 'fare_payment' });

    test('an invited user who is not in the pilot cannot write PRESTO activity', async () => {
        await invite('user@example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertFails(setDoc(doc(db, 'prestoTransactions/t1'), row('user_1')));
    });

    test('a user cannot make themselves a pilot through their own profile', async () => {
        await invite('user@example.com');
        const db = authedDb('user_1', 'user@example.com');
        await assertFails(setDoc(doc(db, 'profiles/user_1'), { displayName: 'U', pilot: 'presto' }));
        await assertFails(setDoc(doc(db, 'prestoTransactions/t1'), row('user_1')));
    });

    test('a pilot (allowedUsers.pilot) can write; the wrong pilot name cannot', async () => {
        await invite('pilot@example.com', { pilot: 'presto' });
        await invite('other@example.com', { pilot: 'something-else' });
        await assertSucceeds(setDoc(doc(authedDb('p1', 'pilot@example.com'), 'prestoTransactions/t1'), row('p1')));
        await assertFails(setDoc(doc(authedDb('o1', 'other@example.com'), 'prestoTransactions/t2'), row('o1')));
    });

    test('an admin email can write PRESTO activity', async () => {
        await invite('admin@example.com', { isAdmin: true });
        await assertSucceeds(setDoc(doc(authedDb('a1', 'admin@example.com'), 'prestoTransactions/t1'), row('a1')));
    });

    test('an unverified pilot email cannot write', async () => {
        await invite('pilot@example.com', { pilot: 'presto' });
        const db = testEnv.authenticatedContext('p1', { email: 'pilot@example.com', email_verified: false }).firestore();
        await assertFails(setDoc(doc(db, 'prestoTransactions/t1'), row('p1')));
    });

    test('phone accounts follow the server-managed profile flag', async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'profiles/phone_pilot'), { pilot: 'presto' });
            await setDoc(doc(context.firestore(), 'profiles/phone_admin'), { isAdmin: true });
            await setDoc(doc(context.firestore(), 'profiles/phone_plain'), { displayName: 'x' });
        });
        await assertSucceeds(setDoc(doc(phoneDb('phone_pilot'), 'prestoTransactions/t1'), row('phone_pilot')));
        await assertSucceeds(setDoc(doc(phoneDb('phone_admin'), 'prestoTransactions/t2'), row('phone_admin')));
        await assertFails(setDoc(doc(phoneDb('phone_plain'), 'prestoTransactions/t3'), row('phone_plain')));
        await assertFails(setDoc(doc(phoneDb('no_profile'), 'prestoTransactions/t4'), row('no_profile')));
    });

    test('anyone can still delete their own PRESTO rows, and a pilot can re-import (update)', async () => {
        await invite('pilot@example.com', { pilot: 'presto' });
        const db = authedDb('p1', 'pilot@example.com');
        const ref = doc(db, 'prestoTransactions/t1');
        await assertSucceeds(setDoc(ref, row('p1')));
        await assertSucceeds(setDoc(ref, { ...row('p1'), amountCents: -330 }, { merge: true }));
        await assertSucceeds(deleteDoc(ref));
    });
});
