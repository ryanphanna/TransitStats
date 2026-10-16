import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const PAGES = [...readdirSync('.').filter(f => f.endsWith('.html')), 'functions/public-profile-template.html'];
const GA = /<script>\s*\(function \(\) \{\s*var ID = 'G-Z8L60LPC8G'[\s\S]*?<\/script\s*>/i;

function snippetOf(page) {
    return GA.exec(readFileSync(page, 'utf8'))?.[0].replace(/^<script>|<\/script\s*>$/gi, '');
}

function run(url, store = {}) {
    window.history.replaceState(null, '', url);
    localStorage.clear();
    Object.entries(store).forEach(([k, v]) => localStorage.setItem(k, v));
    delete window['ga-disable-G-Z8L60LPC8G'];
    document.head.querySelectorAll('script[src*="googletagmanager"]').forEach(el => el.remove());
    new Function(snippetOf('index.html'))();
    return {
        disabled: window['ga-disable-G-Z8L60LPC8G'] === true,
        loaded: !!document.head.querySelector('script[src*="googletagmanager"]'),
    };
}

describe('GA internal-session guard', () => {
    afterEach(() => localStorage.clear());

    it('every page that loads GA uses the same guarded snippet', () => {
        const withGa = PAGES.filter(p => readFileSync(p, 'utf8').includes('G-Z8L60LPC8G'));
        expect(withGa).toEqual(expect.arrayContaining(['index.html', 'dashboard.html', 'import.html', 'recap.html', 'public.html', 'functions/public-profile-template.html']));
        for (const p of withGa) {
            expect(snippetOf(p), p).toBe(snippetOf('index.html'));
            expect(readFileSync(p, 'utf8'), p).not.toMatch(/<script async src="https:\/\/www\.googletagmanager/);
        }
    });

    it('public profile pages send nothing beyond the default page view', () => {
        for (const p of ['public.html', 'functions/public-profile-template.html']) {
            const snippet = snippetOf(p);
            expect(snippet, p).not.toMatch(/gtag\('(event|set|get)'/);
            expect(snippet, p).not.toMatch(/user_id|user_properties|username/i);
        }
    });

    it('skips GA on localhost (jsdom default host)', () => {
        expect(run('/')).toEqual({ disabled: true, loaded: false });
    });

    it('?ts_internal=1 sets the flag, skips GA and is stripped from the URL', () => {
        const r = run('/dashboard?ts_internal=1&x=2');
        expect(r).toEqual({ disabled: true, loaded: false });
        expect(localStorage.getItem('ts.internal-test')).toBe('1');
        expect(location.search).toBe('?x=2');
    });

    it('a saved flag keeps skipping GA', () => {
        expect(run('/', { 'ts.internal-test': '1' }).disabled).toBe(true);
    });
});
