import { describe, expect, it } from 'vitest';
import { getFunctionUrl, getPublicProfileUrl } from '../js/shared/function-urls.js';

describe('function URLs', () => {
    it('derives the host from the Firebase project id', () => {
        expect(getPublicProfileUrl({ VITE_FIREBASE_PROJECT_ID: 'my-qa-project' }))
            .toBe('https://us-central1-my-qa-project.cloudfunctions.net/publicProfile');
    });

    it('lets an explicit URL (e.g. the emulator) win', () => {
        expect(getPublicProfileUrl({
            VITE_FIREBASE_PROJECT_ID: 'x',
            VITE_PUBLIC_PROFILE_URL: 'http://127.0.0.1:5001/x/us-central1/publicProfile/',
        })).toBe('http://127.0.0.1:5001/x/us-central1/publicProfile');
    });

    it('falls back to the production project when nothing is configured', () => {
        expect(getFunctionUrl('publicProfile', {}))
            .toBe('https://us-central1-transitstats-21ba4.cloudfunctions.net/publicProfile');
    });
});
