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

async function assertSignedOutRedirect(page, path, consoleErrors, pageErrors) {
    consoleErrors.length = 0;
    pageErrors.length = 0;
    const startedAt = Date.now();
    await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${baseUrl}/`, { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, '/');
    assert.ok(Date.now() - startedAt < 10_000, `${path} took too long to redirect`);
    assert.deepEqual(consoleErrors, [], `${path} logged browser errors`);
    assert.deepEqual(pageErrors, [], `${path} threw page errors`);
}

await startServerIfNeeded();
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    assert.equal(new URL(page.url()).pathname, '/');
    assert.ok(await page.getByRole('link', { name: 'Import your ride history' }).isVisible());
    assert.ok(await page.getByRole('link', { name: 'Log in' }).isVisible());

    await assertSignedOutRedirect(page, '/dashboard', consoleErrors, pageErrors);
    await assertSignedOutRedirect(page, '/routes', consoleErrors, pageErrors);
    await assertSignedOutRedirect(page, '/route-heatmap', consoleErrors, pageErrors);

    consoleErrors.length = 0;
    pageErrors.length = 0;
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-phone').waitFor();
    await page.locator('#btn-auth-request-code').waitFor();
    assert.equal(await page.locator('#auth-phone').getAttribute('type'), 'tel');
    assert.match(await page.locator('#btn-auth-request-code').textContent(), /Text me a code/);
    await page.locator('#btn-auth-email-mode').click();
    await page.locator('#auth-email').waitFor();
    await page.locator('#btn-auth-phone-mode').click();
    await page.locator('#auth-phone').waitFor();
    assert.deepEqual(consoleErrors, [], '/login logged browser errors');
    assert.deepEqual(pageErrors, [], '/login threw page errors');

    consoleErrors.length = 0;
    pageErrors.length = 0;
    await page.goto(`${baseUrl}/import`, { waitUntil: 'domcontentloaded' });
    await page.locator('#import-email').waitFor();
    await page.locator('#btn-import-use-phone').click();
    await page.locator('#import-phone').waitFor();
    assert.deepEqual(consoleErrors, [], '/import logged browser errors');
    assert.deepEqual(pageErrors, [], '/import threw page errors');

    for (const [path, heading] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
        consoleErrors.length = 0;
        pageErrors.length = 0;
        await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: heading }).waitFor();
        assert.deepEqual(consoleErrors, [], `${path} logged browser errors`);
        assert.deepEqual(pageErrors, [], `${path} threw page errors`);
    }

    console.log('Browser smoke checks passed.');
} finally {
    await browser.close();
    devServer?.kill('SIGTERM');
}
