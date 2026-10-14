import { launch, signIn, BASE } from '../lib.mjs';
const OUT='/private/tmp/claude-501/qa-shots';
const cur = page => page.evaluate(async () => { const { auth } = await import('/js/firebase.js'); return auth.currentUser ? auth.currentUser.email : null; });
// 1. denied /import signs plain user out?
{
  const { browser, context } = await launch(); const page = await context.newPage();
  await signIn(page, 'plain');
  console.log('1. before /import, signed in as:', await cur(page));
  await page.goto(BASE + '/import'); await page.waitForTimeout(4000);
  console.log('1. /import shows:', (await page.locator('#view-denied, .auth-content, main').first().innerText()).replace(/\s+/g,' ').slice(0,160));
  await page.goto(BASE + '/privacy'); await page.waitForTimeout(1500);
  console.log('1. after visiting /import, signed in as:', await cur(page));
  await browser.close();
}
// 2. dashboard + settings (pilot)
{
  const { browser, context } = await launch(); const page = await context.newPage();
  const errs=[]; page.on('pageerror', e => errs.push(e.message.slice(0,150)));
  await signIn(page, 'pilot');
  await page.goto(BASE + '/dashboard'); await page.waitForTimeout(5000);
  console.log('2. markers on map:', await page.locator('.leaflet-interactive, .leaflet-marker-icon').count());
  console.log('2. stats text:', (await page.locator('.atlas-card, [data-atlas-card]').first().innerText()).replace(/\s+/g,' ').slice(0,200));
  await page.click('text=Settings'); await page.waitForTimeout(800);
  const tabs = await page.locator('.settings-panel-tab:not(.hidden)').allTextContents(); console.log('2. settings tabs:', tabs);
  await page.screenshot({ path: `${OUT}/flow-settings-account.png` });
  for (const t of tabs) { await page.click(`.settings-panel-tab:has-text("${t}")`); await page.waitForTimeout(500); const pane = await page.locator('.settings-panel-pane.active').innerText(); console.log(`2. tab ${t}:`, pane.replace(/\s+/g,' ').slice(0,170)); await page.screenshot({ path: `${OUT}/flow-settings-${t}.png` }); }
  console.log('2. page errors:', errs);
  await browser.close();
}
