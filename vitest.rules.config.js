import { defineConfig } from 'vite';

// Separate config for the rules tests (Firestore and Storage) — they need the
// emulators (run via `firebase emulators:exec`, see package.json's test:rules
// script) and a Node environment, not jsdom. Kept out of vite.config.js's
// default test run so `npm test` doesn't require an emulator to be running.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/firestore.rules.test.js', 'tests/storage.rules.test.js'],
    },
});
