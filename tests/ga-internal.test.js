import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const PAGES = readdirSync('.').filter(f => f.endsWith('.html'));
const GA = /<script>\s*\(function \(\) \{\s*var ID = 'G-Z8L60LPC8G'[\s\S]*?<\/script>/;

function snippetOf(page) {
    return GA.exec(readFileSync(page, 'utf8'))?.[0].replace(/^<script>|<\/script>$/g, '');
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
        expect(withGa.length).toBeGreaterThan(0);
        for (const p of withGa) {
            expect(snippetOf(p), p).toBe(snippetOf('index.html'));
            expect(readFileSync(p, 'utf8'), p).not.toMatch(/<script async src="https:\/\/www\.googletagmanager/);
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
