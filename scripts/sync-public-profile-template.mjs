// Copies the built public profile page (dist/public.html) to functions/public-profile-template.html,
// which the publicProfilePage function serves for /user/** with the profile's preview tags added.
// The copy is a build output (gitignored), so the template is always the exact page Vite built:
// same asset paths, preloads, theme bootstrap and build id as the hosting deploy next to it.
// Runs after every `vite build` (vite.config.js); --check runs before every functions deploy
// (firebase.json predeploy) and fails when the template is missing or differs from dist.
// Usage: node scripts/sync-public-profile-template.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILT_PAGE = resolve(root, 'dist/public.html');
export const TEMPLATE = resolve(root, 'functions/public-profile-template.html');

function read(path) {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** Writes (or with check, compares) the template. Returns a problem message, or null when in sync. */
export function syncPublicProfileTemplate({ builtPage = BUILT_PAGE, template = TEMPLATE, check = false } = {}) {
    const built = read(builtPage);
    if (built === null) return `${builtPage} is missing; run npm run build`;
    if (read(template) === built) return null;
    if (check) return `${template} is missing or differs from ${builtPage}; run npm run build`;
    writeFileSync(template, built);
    return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const problem = syncPublicProfileTemplate({ check: process.argv.includes('--check') });
    if (problem) {
        console.error(problem);
        process.exit(1);
    }
}
