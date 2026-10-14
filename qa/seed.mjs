// Seeds the Firebase emulators with fake users and data. Refuses to run against anything real.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../functions/package.json', import.meta.url)));

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error('Refusing to seed: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must both be set.');
    process.exit(1);
}
process.env.GCLOUD_PROJECT = 'demo-transitstats';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
initializeApp({ projectId: 'demo-transitstats' });
const db = getFirestore();
const auth = getAuth();

export const PASSWORD = 'qa-password';
export const USERS = {
    pilot: { uid: 'qa_pilot', email: 'pilot@qa.test', name: 'Pilot Penny', pilot: 'presto' },
    plain: { uid: 'qa_plain', email: 'plain@qa.test', name: 'Plain Pat' },
    admin: { uid: 'qa_admin', email: 'admin@qa.test', name: 'Admin Alex', isAdmin: true },
    public: { uid: 'qa_public', email: 'public@qa.test', name: 'Public Pia', isPublic: true, username: 'qapublic' },
    empty: { uid: 'qa_empty', email: 'empty@qa.test', name: 'Empty Eli' },
};

const STOPS = [
    ['Spadina Ave at Dundas St W', '3001', 43.6532, -79.3977],
    ['Bathurst St at King St W', '3002', 43.6446, -79.4026],
    ['Kipling Station', '14000', 43.6371, -79.5359],
    ['Bloor-Yonge Station', '14001', 43.6709, -79.3857],
    ['Wilson Station', '14002', 43.7345, -79.4501],
    ['Dufferin Mall', '3003', 43.6559, -79.4363],
    ['Union Station', '14003', 43.6453, -79.3806],
    ['Queen St W at Spadina Ave', '3004', 43.6498, -79.3957],
];
const ROUTES = ['501', '504', '510', '29', '2'];

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function tripDoc(uid, { start, minutes, route, from, to, isPublic = false, open = false, extra = {} }) {
    const end = new Date(start.getTime() + minutes * 60000);
    return {
        userId: uid,
        agency: 'TTC',
        route,
        direction: 'Eastbound',
        startStopName: from[0], startStopCode: from[1], startStop: from[0],
        endStopName: open ? null : to[0], endStopCode: open ? null : to[1], endStop: open ? null : to[0],
        startTime: Timestamp.fromDate(start),
        endTime: open ? null : Timestamp.fromDate(end),
        duration: open ? null : minutes,
        source: 'sms',
        timing_reliability: 'actual',
        stop_matched: true,
        isPublic,
        timezone: 'America/Toronto',
        ...extra,
    };
}

async function seedUser(user) {
    await auth.createUser({ uid: user.uid, email: user.email, password: PASSWORD, displayName: user.name, emailVerified: true });
    const profile = {
        displayName: user.name,
        isAdmin: user.isAdmin === true,
        isPremium: false,
        isPublic: user.isPublic === true,
        defaultAgency: 'TTC',
        updatedAt: new Date(),
    };
    if (user.pilot) profile.pilot = user.pilot;
    if (user.username) profile.username = user.username;
    await db.doc(`profiles/${user.uid}`).set(profile);
    await db.doc(`allowedUsers/${user.email}`).set({ isAdmin: user.isAdmin === true, ...(user.pilot ? { pilot: user.pilot } : {}) });
    if (user.username) await db.doc(`usernames/${user.username}`).set({ uid: user.uid, type: 'emoji' });
}

async function seedTrips(user, count, seed) {
    const rand = rng(seed);
    const now = new Date();
    const writes = [];
    for (let i = 0; i < count; i++) {
        const daysBack = 1 + Math.floor(rand() * 85);
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
        const hour = rand() < 0.5 ? 7 + Math.floor(rand() * 3) : 16 + Math.floor(rand() * 3);
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, Math.floor(rand() * 60));
        const a = STOPS[Math.floor(rand() * STOPS.length)];
        let b = STOPS[Math.floor(rand() * STOPS.length)];
        if (b === a) b = STOPS[(STOPS.indexOf(a) + 1) % STOPS.length];
        writes.push(tripDoc(user.uid, {
            start, minutes: 8 + Math.floor(rand() * 35), route: ROUTES[Math.floor(rand() * ROUTES.length)],
            from: a, to: b, isPublic: user.isPublic === true,
        }));
    }
    // Edge cases: a ride that crosses midnight at the end of last month, a ride awaiting review, one still open.
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    writes.push(tripDoc(user.uid, {
        start: new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), lastMonthEnd.getDate(), 23, 50),
        minutes: 20, route: '501', from: STOPS[0], to: STOPS[1], isPublic: user.isPublic === true,
    }));
    writes.push(tripDoc(user.uid, {
        start: new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 2), 9, 0),
        minutes: 15, route: '29', from: STOPS[4], to: STOPS[5], isPublic: user.isPublic === true,
        extra: { needs_review: true, stop_matched: false },
    }));
    if (user.uid === USERS.pilot.uid) {
        writes.push(tripDoc(user.uid, {
            start: new Date(Date.now() - 10 * 60000), route: '504', from: STOPS[2], to: STOPS[2],
            open: true,
        }));
    }
    for (let i = 0; i < writes.length; i += 400) {
        const batch = db.batch();
        writes.slice(i, i + 400).forEach(doc => batch.set(db.collection('trips').doc(), doc));
        await batch.commit();
    }
    return writes.length;
}

async function seedPresto(user) {
    const rand = rng(99);
    const now = new Date();
    const batch = db.batch();
    let n = 0;
    for (let d = 1; d <= 50; d += 2) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, 8, 10);
        const go = d % 6 === 1;
        const taps = go ? 2 : 1;
        for (let t = 0; t < taps; t++) {
            const when = new Date(day.getTime() + t * 45 * 60000 + Math.floor(rand() * 600000));
            const location = go ? (t === 0 ? 'Union Station' : 'Kipling GO') : 'Spadina Station';
            const fingerprint = `qa${d}${t}`;
            batch.set(db.doc(`prestoTransactions/${user.uid}_${fingerprint}`), {
                source: 'presto', sourceFileName: 'qa-sample.csv', sourceRowNumber: ++n,
                occurredAtLocal: when.toISOString(), occurredAtSortKey: when.getTime(),
                agency: go ? 'GO Transit' : 'TTC', agencySource: go ? 'GO Transit' : 'TTC',
                type: 'fare_payment', amountCents: go ? 480 : 335,
                location, locationLabel: location, locationAliasApplied: false,
                stopMatchStatus: 'pending', raw: {}, fingerprint, userId: user.uid,
                importedAt: FieldValue.serverTimestamp(),
            });
        }
    }
    await batch.commit();
    return n;
}

async function main() {
    for (const user of Object.values(USERS)) await seedUser(user);
    const batch = db.batch();
    STOPS.forEach(([name, code, lat, lng], i) => {
        batch.set(db.doc(`stops/qa_stop_${i}`), {
            name, code, agencies: ['TTC'], aliases: [], lat, lng, location: { lat, lng },
        });
    });
    await batch.commit();
    const counts = {
        pilot: await seedTrips(USERS.pilot, 70, 1),
        plain: await seedTrips(USERS.plain, 25, 2),
        public: await seedTrips(USERS.public, 40, 3),
        admin: await seedTrips(USERS.admin, 10, 4),
        presto: await seedPresto(USERS.pilot),
    };
    console.log('Seeded:', JSON.stringify(counts));
    console.log(`Users (password "${PASSWORD}"): ${Object.values(USERS).map(u => u.email).join(', ')}`);
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
