// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/auth.js', () => ({ Auth: { signOut: vi.fn() } }));
vi.mock('../js/shared/settings-panel.js', () => ({ openSettingsPanel: vi.fn() }));
vi.mock('../js/shared/icons.js', () => ({ refreshIcons: vi.fn() }));

import { initHeader } from '../js/shared/header.js';

const root = path.resolve(process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Recap page', () => {
    it('is named Recap, with no "Wrapped" wording visible to users', () => {
        const html = read('recap.html');
        expect(html).toContain('<title>TransitStats — Recap</title>');
        expect(html).toContain('>Recap</h1>');
        expect(html).not.toMatch(/Wrapped</);
        expect(html).not.toMatch(/aria-label="[^"]*Wrapped/);
        const js = read('js/pages/recap.js');
        const strings = js.match(/(['"`])(?:(?!\1)[^\\\n])*\1/g) || [];
        expect(strings.filter(str => /Wrapped/.test(str.replace(/\$\{[^}]*\}/g, '')))).toEqual([]);
        expect(js).toContain('Recap card downloaded.');
        expect(fs.existsSync(path.join(root, 'wrapped.html'))).toBe(false);
    });

    it('is served at /recap and /wrapped redirects there', () => {
        const firebase = JSON.parse(read('firebase.json'));
        const hosting = firebase.hosting[0];
        expect(hosting.rewrites).toContainEqual({ source: '/recap', destination: '/recap.html' });
        expect(hosting.redirects).toContainEqual({ source: '/wrapped', destination: '/recap', type: 301 });
        expect(hosting.redirects).toContainEqual({ source: '/wrapped.html', destination: '/recap', type: 301 });
        const vite = read('vite.config.js');
        expect(vite).toContain("recap: './recap.html'");
        expect(vite).toContain("'/wrapped'");
        expect(vite).toContain("'/recap']");
    });

    it('the stats card no longer links to the recap', () => {
        expect(read('js/shared/atlas-card.js')).not.toMatch(/Wrapped|\/recap/);
    });
});

describe('header Recap link', () => {
    beforeEach(() => { document.body.innerHTML = '<div id="app-root"></div>'; });

    it('shows a Recap nav link, styled like the other nav items, when signed in', () => {
        initHeader({ currentPage: 'dashboard', showRecap: true });
        const link = document.querySelector('.header-actions a[href="/recap"]');
        expect(link).not.toBeNull();
        expect(link.classList.contains('header-action-link')).toBe(true);
        expect(link.textContent.trim()).toBe('Recap');
        expect(link.classList.contains('active')).toBe(false);
    });

    it('marks Recap active on the recap page', () => {
        initHeader({ currentPage: 'recap', showRecap: true });
        expect(document.querySelector('a[href="/recap"]').classList.contains('active')).toBe(true);
    });

    it('is hidden when not signed in', () => {
        initHeader({ currentPage: 'dashboard' });
        expect(document.querySelector('a[href="/recap"]')).toBeNull();
    });

    it('is turned on by the signed-in pages', () => {
        for (const file of ['js/pages/dashboard.js', 'js/pages/route-heatmap.js', 'js/pages/recap.js', 'js/public.js']) {
            expect(read(file)).toMatch(/showRecap: true/);
        }
    });
});
