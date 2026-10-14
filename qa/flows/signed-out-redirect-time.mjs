import { launch, BASE } from '../lib.mjs';
const { browser, context } = await launch();
const page = await context.newPage();
const t0 = Date.now();
await page.goto(BASE + '/dashboard');
await page.waitForURL(u => !u.pathname.startsWith('/dashboard'), { timeout: 90000 }).catch(() => {});
console.log('redirected after', Math.round((Date.now() - t0) / 1000), 's ->', page.url().replace(BASE, ''));
await browser.close();
