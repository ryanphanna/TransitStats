import { launch, signIn, BASE } from '../lib.mjs';
const OUT='/private/tmp/claude-501/qa-shots';
const { browser, context } = await launch(); const page = await context.newPage();
const errs=[]; page.on('pageerror', e => errs.push(e.message.slice(0,150))); page.on('console', m => { if (m.type()==='error' && !/401/.test(m.text())) errs.push('console: '+m.text().slice(0,150)); });
await signIn(page, 'plain');
await page.goto(BASE + '/dashboard'); await page.waitForTimeout(3500);
await page.click('text=Settings'); await page.click('.settings-panel-tab:has-text("Sharing")'); await page.waitForTimeout(500);
await page.click('#btn-save-identity'); await page.waitForTimeout(2500);
console.log('after save identity:', (await page.locator('#settings-username-display').innerText()).trim(), '|', (await page.locator('#settings-public-link').innerText()).replace(/\s+/g,' ').trim().slice(0,200));
await page.screenshot({ path: `${OUT}/flow-sharing-saved.png` });
const checked = await page.locator('#settings-public-profile').isChecked();
console.log('public toggle initially checked:', checked);
await page.locator('#settings-public-profile').click(); await page.waitForTimeout(2000);
console.log('toggle now checked:', await page.locator('#settings-public-profile').isChecked(), '|', (await page.locator('#settings-public-link').innerText()).replace(/\s+/g,' ').trim().slice(0,220));
const link = await page.locator('#settings-public-link a').first().getAttribute('href').catch(()=>null);
console.log('public link:', link);
// anon view
const anon = await (await launch()).context.newPage();
const path = link ? new URL(link, BASE).pathname : '/user/subway-subway-subway';
await anon.goto(BASE + path); await anon.waitForTimeout(4000);
console.log('anon sees (public ON):', (await anon.locator('body').innerText()).replace(/\s+/g,' ').slice(0,160));
// turn off
await page.locator('#settings-public-profile').click(); await page.waitForTimeout(2000);
await anon.goto(BASE + path); await anon.waitForTimeout(4000);
console.log('anon sees (public OFF):', (await anon.locator('body').innerText()).replace(/\s+/g,' ').slice(0,160));
await anon.screenshot({ path: `${OUT}/flow-public-off.png` });
// logout
await page.keyboard.press('Escape'); await page.click('text=Log out'); await page.waitForTimeout(3000);
console.log('after logout url:', page.url().replace(BASE,''));
console.log('errors:', errs.slice(0,5));
process.exit(0);
