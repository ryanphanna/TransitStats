// Visits the main pages as each fake user at desktop and phone width; reports console errors,
// failed requests, redirects and screenshots. Run after `bash qa/up.sh`.
import fs from 'node:fs';
import { launch, signIn, BASE } from './lib.mjs';

const OUT = process.env.QA_OUT || '/private/tmp/claude-501/qa-shots';
fs.mkdirSync(OUT, { recursive: true });
const plan = [
    ['pilot', ['/dashboard', '/import', '/wrapped', '/route-heatmap', '/']],
    ['plain', ['/dashboard', '/import', '/wrapped']],
    ['empty', ['/dashboard', '/import', '/wrapped']],
    ['admin', ['/dashboard', '/import']],
    [null, ['/', '/dashboard', '/import', '/wrapped', '/terms', '/privacy', '/user/qapublic', '/public?user=qapublic']],
];
const results = [];
for (const phone of [false, true]) {
    for (const [who, paths] of plan) {
        const { browser, context } = await launch({ phone });
        const page = await context.newPage();
        let notes = [];
        page.on('console', m => { if (m.type() === 'error') notes.push(`console: ${m.text().slice(0, 200)}`); });
        page.on('pageerror', e => notes.push(`pageerror: ${e.message.slice(0, 200)}`));
        page.on('requestfailed', r => { if (!/google-analytics|googletagmanager|openstreetmap|ipapi/.test(r.url())) notes.push(`requestfailed: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`); });
        page.on('response', r => { if (r.status() >= 400 && !/google-analytics|googletagmanager|openstreetmap/.test(r.url())) notes.push(`HTTP ${r.status()}: ${r.url().slice(0, 120)}`); });
        if (who) await signIn(page, who);
        for (const path of paths) {
            notes = [];
            await page.goto(BASE + path, { waitUntil: 'domcontentloaded' }).catch(e => notes.push(`goto: ${e.message}`));
            await page.waitForTimeout(4500);
            const h1 = await page.locator('h1').first().textContent({ timeout: 500 }).catch(() => '');
            const file = `${OUT}/sweep-${phone ? 'phone' : 'desktop'}-${who || 'anon'}-${path.replace(/[^a-z0-9]+/gi, '_')}.png`;
            await page.screenshot({ path: file, fullPage: false }).catch(() => {});
            const horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
            results.push({ viewport: phone ? 'phone' : 'desktop', who: who || 'anon', path, finalUrl: page.url().replace(BASE, ''), h1: (h1 || '').trim().slice(0, 50), hScroll: horizontalScroll, notes: [...new Set(notes)].slice(0, 5) });
        }
        await browser.close();
    }
}
for (const r of results) console.log(JSON.stringify(r));
