import { describe, expect, it, vi } from 'vitest';
import { resolveDocRef } from '../js/shared/firestore-refs.js';

const batchCalls = [];
vi.mock('firebase/app', () => ({ getApps: () => [{}], initializeApp: () => ({}) }));
vi.mock('firebase/auth', () => ({
    browserLocalPersistence: {}, EmailAuthProvider: {}, getAuth: () => ({}), isSignInWithEmailLink: () => false,
    linkWithCredential: vi.fn(), onAuthStateChanged: vi.fn(), sendPasswordResetEmail: vi.fn(),
    sendSignInLinkToEmail: vi.fn(), setPersistence: async () => {}, signInWithCustomToken: vi.fn(),
    signInWithEmailAndPassword: vi.fn(), signInWithEmailLink: vi.fn(), signOut: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
    addDoc: vi.fn(), arrayUnion: vi.fn(), collection: vi.fn(), deleteDoc: vi.fn(), deleteField: vi.fn(), doc: vi.fn(),
    enableMultiTabIndexedDbPersistence: async () => {}, getDoc: vi.fn(), getDocs: vi.fn(), getFirestore: () => ({}),
    limit: vi.fn(), onSnapshot: vi.fn(), orderBy: vi.fn(), query: vi.fn(), serverTimestamp: vi.fn(), setDoc: vi.fn(),
    Timestamp: {}, updateDoc: vi.fn(), where: vi.fn(),
    writeBatch: () => ({
        set: (ref, ...rest) => batchCalls.push(['set', ref, ...rest]),
        update: (ref, ...rest) => batchCalls.push(['update', ref, ...rest]),
        delete: (ref) => batchCalls.push(['delete', ref]),
        commit: async () => {},
    }),
}));

describe('resolveDocRef', () => {
    it('accepts wrapper documents, query snapshot docs and raw references', () => {
        const ref = { path: 'trips/a' };
        expect(resolveDocRef({ _ref: ref })).toBe(ref);
        expect(resolveDocRef({ id: 'a', ref })).toBe(ref);
        expect(resolveDocRef(ref)).toBe(ref);
    });

    it('fails loudly instead of passing undefined to the SDK', () => {
        expect(() => resolveDocRef(undefined)).toThrow(/Firestore document/);
        expect(() => resolveDocRef('trips/a')).toThrow(/Firestore document/);
    });
});

describe('db.batch', () => {
    it('updates a query snapshot document, as the public-profile toggle does', async () => {
        const { db } = await import('../js/firebase.js');
        const snapshotDoc = { id: 'trip1', ref: { path: 'trips/trip1' } };
        const batch = db.batch();
        batch.update(snapshotDoc, { isPublic: true });
        await batch.commit();
        expect(batchCalls).toContainEqual(['update', snapshotDoc.ref, { isPublic: true }]);
    });
});
