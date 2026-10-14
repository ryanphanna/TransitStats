// Final regression checks: identity save combos, public toggle, plain-user import, all-caps scan,
// phone dashboard band, signed-out redirects.
import { fileURLToPath } from 'node:url';
import { launch, signIn, BASE } from '../lib.mjs';

const errsOf = page => { const e = []; page.on('console', m => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) e.push(m.text().slice(0, 170).replace(/\s+/g, ' ')); }); page.on('pageerror', x => e.push('pageerror ' + x.message.slice(0, 120))); return e; };
const toasts = page => page.evaluate(() => [...document.querySelectorAll('.notification, .toast, [class*="notif"]')].map(e => e.textContent.trim()).filter(Boolean).slice(-2));
const authUser = page => page.evaluate(async () => { const { auth } = await import('/js/firebase.js'); await auth.authStateReady?.(); await new Promise(r => setTimeout(r, 800)); return auth.currentUser ? auth.currentUser.email : null; });

const FROM = Number(process.env.QA_FROM || 1);
// 1. signed-out redirects
if (FROM <= 1) { const { browser, context } = await launch(); const page = await context.newPage();
  for (const p of ['/dashboard', '/import', '/wrapped']) { const t0 = Date.now(); await page.goto(BASE + p); await page.waitForURL(u => !u.pathname.startsWith(p), { timeout: 30000 }).catch(() => {}); console.log(`signed-out ${p} -> ${page.url().replace(BASE, '')} after ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
  await browser.close(); }

// 2. identity save with different combos (fresh page each; each needs a user without an identity -> use 'empty' then reload quirks)
async function tryIdentity(who, picks, label) {
  const { browser, context } = await launch(); const page = await context.newPage(); const errs = errsOf(page);
  await signIn(page, who); await page.goto(BASE + '/dashboard'); await page.waitForTimeout(3500); await page.click('text=Settings');
  await page.click('.settings-panel-tab:has-text("Sharing")'); await page.waitForTimeout(400);
  if (picks) for (const [i, e] of picks.entries()) { await page.locator(`.emoji-slot[data-index="${i}"]`).click(); await page.waitForTimeout(150); await page.locator('.emoji-grid > *', { hasText: e }).first().click(); await page.waitForTimeout(150); }
  const slots = (await page.locator('.emoji-slot').allTextContents()).join(' ');
  await page.click('#btn-save-identity'); await page.waitForTimeout(2800);
  console.log(`identity [${label}] slots=${slots} -> ${(await page.locator('#settings-username-display').innerText()).trim() || '(none)'} | link: ${(await page.locator('#settings-public-link').innerText()).replace(/\s+/g, ' ').slice(0, 70)} | toasts ${JSON.stringify(await toasts(page))} | errors ${JSON.stringify(errs.slice(0, 2))}`);
  await browser.close(); }
if (FROM <= 2) {
await tryIdentity('plain', null, 'default picker, untouched');
await tryIdentity('empty', ['🚈', '🛴', '🚆'], 'long combo lightrail-scooter-train');
await tryIdentity('admin', ['🚇', '🚇', '🚇'], 'same emoji x3 on purpose');
}

// 3. public toggle (user public: has identity from step 2)
if (FROM <= 3) { const { browser, context } = await launch(); const page = await context.newPage(); const errs = errsOf(page);
  await signIn(page, 'plain'); await page.goto(BASE + '/dashboard'); await page.waitForTimeout(3500); await page.click('text=Settings'); await page.click('.settings-panel-tab:has-text("Sharing")'); await page.waitForTimeout(400);
  for (const label of ['on', 'off']) { await page.locator('#settings-public-profile').click(); await page.waitForTimeout(2500); console.log(`public toggle ${label}: checked=${await page.locator('#settings-public-profile').isChecked()} toasts ${JSON.stringify(await toasts(page))} errors ${JSON.stringify(errs.filter(x => /sync|firestore/i.test(x)).slice(0, 2))}`); }
  await browser.close(); }

// 4. import for a plain (non-pilot) user
{ const { browser, context } = await launch(); const page = await context.newPage(); const errs = errsOf(page);
  await signIn(page, 'plain'); await page.goto(BASE + '/import'); await page.waitForTimeout(5000);
  const active = await page.locator('#import-active:not(.hidden)').count();
  console.log(`plain /import: import UI visible=${active} text="${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 100)}"`);
  if (active) { await page.setInputFiles('#presto-file-input', fileURLToPath(new URL('../fixtures/presto-sample.csv', import.meta.url))); await page.click('#presto-preview-button'); await page.waitForTimeout(2000); await page.click('#presto-import-button'); await page.waitForTimeout(4000);
    console.log('plain import status:', (await page.locator('#presto-import-status').innerText().catch(() => '?')).replace(/\s+/g, ' ').slice(0, 110), '| errors', JSON.stringify(errs.slice(0, 2))); }
  await page.goto(BASE + '/privacy'); console.log('plain still signed in after /import:', await authUser(page)); await browser.close(); }

// 5. all-caps scan on every main page, desktop + phone (visible text in caps, or text-transform: uppercase on visible text)
for (const phone of [false, true]) {
  const { browser, context } = await launch({ phone }); const page = await context.newPage(); await signIn(page, 'pilot');
  const found = new Set();
  for (const p of ['/dashboard', '/import', '/wrapped', '/route-heatmap', '/privacy', '/terms']) {
    await page.goto(BASE + p); await page.waitForTimeout(3500);
    if (p === '/dashboard') { await page.click('text=Settings').catch(() => {}); await page.waitForTimeout(500); }
    const hits = await page.evaluate(() => { const out = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { const t = n.textContent.trim(); const el = n.parentElement; if (!t || !el || el.closest('script,style,noscript')) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; const tt = getComputedStyle(el).textTransform; const letters = t.replace(/[^A-Za-z]/g, ''); if (tt === 'uppercase' && letters.length > 1) out.push(`css-uppercase: "${t.slice(0, 40)}"`); else if (letters.length >= 4 && t === t.toUpperCase() && !/^[A-Z]{2,5}$/.test(t)) out.push(`typed-caps: "${t.slice(0, 40)}"`); } return out; });
    hits.forEach(h => found.add(`${p} ${h}`));
  }
  console.log(`all-caps scan ${phone ? 'phone' : 'desktop'}: ${found.size ? JSON.stringify([...found].slice(0, 12)) : 'none found'}`);
  await browser.close(); }

// 6. phone dashboard band
{ const { browser, context } = await launch({ phone: true }); const page = await context.newPage(); await signIn(page, 'pilot'); await page.goto(BASE + '/dashboard'); await page.waitForTimeout(5000);
  console.log('phone dashboard map:', JSON.stringify(await page.evaluate(() => { const m = document.getElementById('main-map').getBoundingClientRect(); return { viewportH: innerHeight, mapBottom: Math.round(m.bottom), mapH: Math.round(m.height), scrollH: document.documentElement.scrollHeight }; })));
  await page.screenshot({ path: '/private/tmp/claude-501/qa-shots/final-phone-dashboard.png' }); await browser.close(); }
process.exit(0);
