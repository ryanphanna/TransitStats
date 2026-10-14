import { getApps, initializeApp } from 'firebase/app';
import { resolveDocRef } from './shared/firestore-refs.js';
import {
    browserLocalPersistence,
    EmailAuthProvider,
    getAuth,
    isSignInWithEmailLink,
    linkWithCredential,
    onAuthStateChanged,
    sendPasswordResetEmail,
    sendSignInLinkToEmail,
    setPersistence,
    signInWithCustomToken,
    signInWithEmailAndPassword,
    signInWithEmailLink,
    signOut,
} from 'firebase/auth';
import {
    addDoc,
    arrayUnion,
    collection as firestoreCollection,
    deleteDoc,
    deleteField,
    doc as firestoreDoc,
    enableMultiTabIndexedDbPersistence,
    getDoc,
    getDocs,
    getFirestore,
    limit as firestoreLimit,
    onSnapshot,
    orderBy as firestoreOrderBy,
    query as firestoreQuery,
    serverTimestamp,
    setDoc,
    Timestamp,
    updateDoc,
    where as firestoreWhere,
    writeBatch,
} from 'firebase/firestore';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

if (!firebaseConfig.apiKey) {
    console.error('❌ Firebase Configuration Error: API Key is missing. Check your environment variables.');
}

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
const authClient = getAuth(app);
const firestoreClient = getFirestore(app);

function wrapDocument(reference) {
    return {
        _ref: reference,
        async get() {
            return getDoc(reference);
        },
        async set(data, options) {
            return setDoc(reference, data, options);
        },
        async update(data) {
            return updateDoc(reference, data);
        },
        async delete() {
            return deleteDoc(reference);
        },
    };
}

function wrapQuery(reference) {
    const api = {
        where(field, operator, value) {
            return wrapQuery(firestoreQuery(reference, firestoreWhere(field, operator, value)));
        },
        orderBy(field, direction) {
            return wrapQuery(firestoreQuery(reference, firestoreOrderBy(field, direction)));
        },
        limit(count) {
            return wrapQuery(firestoreQuery(reference, firestoreLimit(count)));
        },
        async get() {
            return getDocs(reference);
        },
        onSnapshot(...args) {
            return onSnapshot(reference, ...args);
        },
    };
    return api;
}

function wrapCollection(reference) {
    return {
        ...wrapQuery(reference),
        doc(id) {
            return wrapDocument(firestoreDoc(reference, id));
        },
        async add(data) {
            return addDoc(reference, data);
        },
    };
}

function createBatch() {
    const batch = writeBatch(firestoreClient);
    return {
        set(document, data, options) {
            batch.set(resolveDocRef(document), data, options);
            return this;
        },
        update(document, data) {
            batch.update(resolveDocRef(document), data);
            return this;
        },
        delete(document) {
            batch.delete(resolveDocRef(document));
            return this;
        },
        commit() {
            return batch.commit();
        },
    };
}

// Keep the small existing app-facing surface stable while its implementation
// uses the tree-shakeable modular Firestore API underneath.
export const db = {
    collection(path) {
        return wrapCollection(firestoreCollection(firestoreClient, path));
    },
    batch: createBatch,
};

// Keep the existing app-facing auth calls stable while using modular Auth.
export const auth = {
    get currentUser() {
        return authClient.currentUser;
    },
    onAuthStateChanged(callback) {
        return onAuthStateChanged(authClient, callback);
    },
    authStateReady() {
        return typeof authClient.authStateReady === 'function'
            ? authClient.authStateReady()
            : Promise.resolve();
    },
    signInWithEmailAndPassword(email, password) {
        return signInWithEmailAndPassword(authClient, email, password);
    },
    sendSignInLinkToEmail(email, settings) {
        return sendSignInLinkToEmail(authClient, email, settings);
    },
    isSignInWithEmailLink(url) {
        return isSignInWithEmailLink(authClient, url);
    },
    signInWithEmailLink(email, url) {
        return signInWithEmailLink(authClient, email, url);
    },
    sendPasswordResetEmail(email) {
        return sendPasswordResetEmail(authClient, email);
    },
    signInWithCustomToken(token) {
        return signInWithCustomToken(authClient, token);
    },
    signOut() {
        return signOut(authClient);
    },
    linkEmailPassword(email, password) {
        const credential = EmailAuthProvider.credential(email, password);
        return linkWithCredential(authClient.currentUser, credential);
    },
};

// Tracked separately from the *Ready promises (which always resolve, never
// reject, so a caller awaiting them can't tell success from swallowed
// failure) so the auth breadcrumb can report whether local storage actually
// came up, instead of just assuming it did.
export const authPersistenceStatus = { ok: null, error: null };
export const firestorePersistenceStatus = { ok: null, error: null };

// Finish configuring persistence before any page guard decides that a page
// reload means the user is signed out.
export const authPersistenceReady = setPersistence(authClient, browserLocalPersistence)
    .then(() => {
        authPersistenceStatus.ok = true;
    })
    .catch(error => {
        authPersistenceStatus.ok = false;
        authPersistenceStatus.error = error.code || error.message;
        console.warn('Firebase local persistence unavailable:', error.message);
    });

// Let repeat visits render the last authorized snapshot immediately while
// Firestore refreshes it from the server. This remains best-effort because
// some browsers or multi-tab configurations do not support persistent storage.
export const firestorePersistenceReady = enableMultiTabIndexedDbPersistence(firestoreClient)
    .then(() => {
        firestorePersistenceStatus.ok = true;
    })
    .catch(error => {
        firestorePersistenceStatus.ok = false;
        firestorePersistenceStatus.error = error.code || error.message;
        console.warn('Firebase offline cache unavailable:', error.code || error.message);
    });

export { arrayUnion, deleteField, serverTimestamp, Timestamp };
