import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// Every top-level page shares the same core head. Pages may add to it (wrapped
// loads its ticket fonts, route-heatmap its own CSS) but must not drop any of it.
// Intentional gaps go in the allow-lists below, with the reason.
const PAGES = readdirSync('.').filter(f => f.endsWith('.html'));

// No Google Analytics: legal pages.
const NO_GA = ['privacy.html', 'terms.html'];
// No Lucide: legal pages have no header or icons.
const NO_LUCIDE = ['privacy.html', 'terms.html'];

const head = page => /<head>([\s\S]*?)<\/head>/i.exec(readFileSync(page, 'utf8'))?.[1] ?? '';

describe('top-level pages share the core head', () => {
    it('finds the pages', () => {
        expect(PAGES).toEqual(expect.arrayContaining(['index.html', 'dashboard.html', 'wrapped.html', 'public.html']));
    });

    it.each(PAGES)('%s has the core tags', page => {
        const h = head(page);
        expect(h, 'viewport').toMatch(/<meta name="viewport"/);
        expect(h, 'Inter font').toMatch(/fonts\.googleapis\.com\/css2\?[^"]*family=Inter[:&"]/);
        expect(h, 'main.css').toMatch(/<link rel="stylesheet" href="\/?styles\/main\.css">/);
        if (!NO_LUCIDE.includes(page)) expect(h, 'Lucide').toMatch(/<script[^>]*src="https:\/\/unpkg\.com\/lucide@[^"]*"/);
        if (!NO_GA.includes(page)) expect(h, 'GA snippet').toContain("var ID = 'G-Z8L60LPC8G'");
    });

    it('allow-listed pages exist and really lack the tag', () => {
        for (const p of NO_GA) expect(head(p), p).not.toContain('G-Z8L60LPC8G');
        for (const p of NO_LUCIDE) expect(head(p), p).not.toMatch(/lucide/);
    });
});
