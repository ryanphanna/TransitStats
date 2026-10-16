import { launch, signIn, BASE } from '../lib.mjs';
const OUT='/private/tmp/claude-501/qa-shots';
for (const phone of [false, true]) for (const who of ['pilot', 'plain', 'empty']) {
  const { browser, context } = await launch({ phone }); const page = await context.newPage();
  const errs=[]; page.on('pageerror', e => errs.push(e.message.slice(0,120))); page.on('console', m => { if (m.type()==='error' && !/401/.test(m.text())) errs.push(m.text().slice(0,120)); });
  await signIn(page, who);
  await page.goto(BASE + '/recap'); await page.waitForSelector('#wrapped-stage:not([hidden])', { timeout: 20000 }).catch(()=>{}); await page.waitForTimeout(1500);
  const status = (await page.textContent('#wrapped-status')).trim();
  const printVisible = await page.locator('#wrapped-print').isVisible();
  let dl = '-';
  if (printVisible && !(await page.locator('#wrapped-print').isDisabled())) {
    await page.click('#wrapped-print'); await page.waitForTimeout(3300);
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(()=>null), page.click('#wrapped-download').catch(()=>{})]);
    dl = d ? d.suggestedFilename() : 'NO DOWNLOAD';
  }
  const hs = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  await page.screenshot({ path: `${OUT}/qa-wrapped-${phone?'phone':'desktop'}-${who}.png`, fullPage: true });
  console.log(`${phone?'phone':'desktop'} ${who}: status="${status}" print=${printVisible} download=${dl} hscroll=${hs} errs=${JSON.stringify(errs.slice(0,2))}`);
  await browser.close();
}
