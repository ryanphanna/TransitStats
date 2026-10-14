import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, test, expect } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { getDocs, collection, query, where } from 'firebase/firestore';

const PROJECT_ID = 'transit-stats-rules-test';
const RULES_PATH = resolve(process.cwd(), 'firestore.rules');

let testEnv;

function authedDb(uid, email) {
    return testEnv.authenticatedContext(uid, { email }).firestore();
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
            betaFeatures: { rocket: true },
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
