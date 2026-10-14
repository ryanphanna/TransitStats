import { launch, signIn, BASE } from '../lib.mjs';
const { browser, context } = await launch({ phone: true }); const page = await context.newPage();
await signIn(page, 'pilot'); await page.goto(BASE + '/dashboard'); await page.waitForTimeout(5000);
console.log(await page.evaluate(() => { const m = document.getElementById('main-map').getBoundingClientRect(); return { viewportH: innerHeight, mapTop: Math.round(m.top), mapH: Math.round(m.height), bodyScrollH: document.documentElement.scrollHeight }; }));
process.exit(0);
