// Vite config for QA: runs the real app against the Firebase emulators, with no app code changes.
// Usage (from the repo root): npx vite --config qa/vite.qa.config.js
import { defineConfig } from 'vite';
import baseConfig from '../vite.config.js';

const AUTH = 'http://127.0.0.1:9150';
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8150;

// Points the app's Firebase client at the emulators. Function URLs come from config now
// (VITE_PUBLIC_PROFILE_URL, set by qa/up.sh), so nothing else needs rewriting.
function emulatorPlugin() {
    return {
        name: 'qa-emulators',
        enforce: 'pre',
        configResolved(config) {
            const projectId = config.env.VITE_FIREBASE_PROJECT_ID || '';
            if (!projectId.startsWith('demo-')) {
                throw new Error(`QA refuses to run with project "${projectId}". Use up.sh (it sets a demo- project).`);
            }
        },
        transform(code, id) {
            const path = id.split('?')[0];
            if (!path.includes('/js/')) return null;
            let out = code;
            if (path.endsWith('/js/firebase.js')) {
                out = out.replace(
                    'const firestoreClient = getFirestore(app);',
                    `const firestoreClient = getFirestore(app);
connectAuthEmulator(authClient, '${AUTH}', { disableWarnings: true });
connectFirestoreEmulator(firestoreClient, '${FIRESTORE_HOST}', ${FIRESTORE_PORT});`,
                );
                out = `import { connectAuthEmulator } from 'firebase/auth';\nimport { connectFirestoreEmulator } from 'firebase/firestore';\n${out}`;
                if (!out.includes('connectAuthEmulator(authClient')) {
                    throw new Error('QA could not patch js/firebase.js; the emulator hook is missing.');
                }
            }
            return out === code ? null : { code: out, map: null };
        },
    };
}

export default defineConfig(env => {
    const base = typeof baseConfig === 'function' ? baseConfig(env) : baseConfig;
    return {
        ...base,
        plugins: [emulatorPlugin(), ...(base.plugins || [])],
        server: {
            ...(base.server || {}),
            port: 5188,
            strictPort: true,
            proxy: {
                '/auth/session': {
                    target: 'http://127.0.0.1:5150',
                    rewrite: () => '/demo-transitstats/us-central1/authSession',
                },
            },
        },
    };
});
