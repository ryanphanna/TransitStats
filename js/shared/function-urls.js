// Cloud Function URLs come from config, not a hardcoded production host, so
// local dev and an emulator don't silently hit production.
//   VITE_<NAME>_URL                 full override (e.g. a local emulator URL)
//   VITE_FIREBASE_PROJECT_ID        derives https://us-central1-<project>.cloudfunctions.net/<name>
const DEFAULT_PROJECT_ID = 'transitstats-21ba4';
const FUNCTION_REGION = 'us-central1';

export function getFunctionUrl(name, env = {}, overrideKey = null) {
    const override = overrideKey ? env[overrideKey] : null;
    if (override) return String(override).replace(/\/+$/, '');
    const projectId = env.VITE_FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
    return `https://${FUNCTION_REGION}-${projectId}.cloudfunctions.net/${name}`;
}

export const getPublicProfileUrl = (env = import.meta.env) =>
    getFunctionUrl('publicProfile', env, 'VITE_PUBLIC_PROFILE_URL');
