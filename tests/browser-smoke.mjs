import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = process.env.BROWSER_PORT || '5199';
const baseUrl = process.env.BROWSER_BASE_URL || `http://127.0.0.1:${port}`;
let devServer;

async function isReady() {
    try {
        const response = await fetch(`${baseUrl}/`);
        return response.ok;
    } catch {
        return false;
    }
}

async function startServerIfNeeded() {
    if (await isReady()) return;
    devServer = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', port], {
        cwd: new URL('..', import.meta.url),
        stdio: 'ignore',
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await isReady()) return;
        await wait(250);
    }
    throw new Error(`Vite did not become ready at ${baseUrl}`);
}

async function assertSignedOutRedirect(page, path, expected = '/') {
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${baseUrl}${expected}`, { timeout: 20_000 });
    const url = new URL(page.url());
    assert.equal(url.pathname + url.search, expected);
}

await startServerIfNeeded();
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    // The dev server has no /auth/session endpoint (it answers with index.html),
    // which the auth guard reads as "unsure" and waits 60s. Production answers
    // 401 when nobody is signed in, so do the same here.
    await page.route('**/auth/session', route => route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'no session' }),
    }));
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await assertSignedOutRedirect(page, '/dashboard');
    await assertSignedOutRedirect(page, '/wrapped', '/?next=%2Fwrapped');

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-phone').waitFor();
    await page.locator('#btn-auth-request-code').waitFor();
    assert.equal(await page.locator('#auth-phone').getAttribute('type'), 'tel');
    assert.match(await page.locator('#btn-auth-request-code').textContent(), /Text me a code/);
    console.log('Browser smoke checks passed.');
} finally {
    await browser.close();
    devServer?.kill('SIGTERM');
}
