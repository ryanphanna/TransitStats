import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncPublicProfileTemplate } from '../scripts/sync-public-profile-template.mjs';

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

function paths() {
    dir = mkdtempSync(join(tmpdir(), 'ts-template-'));
    return { builtPage: join(dir, 'public.html'), template: join(dir, 'public-profile-template.html') };
}

describe('public profile template sync', () => {
    it('copies the built page to the template byte for byte', () => {
        const { builtPage, template } = paths();
        writeFileSync(builtPage, '<html><head></head><body>built</body></html>');
        expect(syncPublicProfileTemplate({ builtPage, template })).toBeNull();
        expect(readFileSync(template, 'utf8')).toBe(readFileSync(builtPage, 'utf8'));
        expect(syncPublicProfileTemplate({ builtPage, template, check: true })).toBeNull();
    });

    it('check fails when the template is missing or has drifted, and never writes', () => {
        const { builtPage, template } = paths();
        writeFileSync(builtPage, '<html>new build</html>');
        expect(syncPublicProfileTemplate({ builtPage, template, check: true })).toMatch(/missing or differs/);
        writeFileSync(template, '<html>hand edited</html>');
        expect(syncPublicProfileTemplate({ builtPage, template, check: true })).toMatch(/missing or differs/);
        expect(readFileSync(template, 'utf8')).toBe('<html>hand edited</html>');
    });

    it('fails when there is no build to copy from', () => {
        const { builtPage, template } = paths();
        expect(syncPublicProfileTemplate({ builtPage, template })).toMatch(/run npm run build/);
    });

    it('runs after every build and before every functions deploy', () => {
        expect(readFileSync('vite.config.js', 'utf8')).toMatch(/syncPublicProfileTemplate\(\)/);
        const functionsConfig = JSON.parse(readFileSync('firebase.json', 'utf8')).functions[0];
        expect(functionsConfig.predeploy).toContain('node "$PROJECT_DIR/scripts/sync-public-profile-template.mjs" --check');
    });
});
