// Playwright helpers for QA runs against qa/up.sh.
import { chromium } from 'playwright';

export const BASE = process.env.QA_BASE_URL || 'http://localhost:5188';
export const PASSWORD = 'qa-password';
export const EMAILS = {
    pilot: 'pilot@qa.test',
    plain: 'plain@qa.test',
    admin: 'admin@qa.test',
    public: 'public@qa.test',
    empty: 'empty@qa.test',
};

export async function launch({ phone = false, reducedMotion = false } = {}) {
    const browser = await chromium.launch({ channel: 'chrome' });
    const context = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        deviceScaleFactor: 2,
        acceptDownloads: true,
        timezoneId: 'America/Toronto',
        locale: 'en-CA',
        reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    // Safety net: nothing from this session may reach the real Firebase project.
    const productionHosts = /(^|\.)(transitstats-21ba4\.[a-z.]+|firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|firebaseio\.com)$/;
    await context.route('**/*', route => {
        const { hostname } = new URL(route.request().url());
        if (productionHosts.test(hostname)) {
            console.error('QA BLOCKED a production request:', route.request().url());
            return route.abort();
        }
        return route.continue();
    });
    return { browser, context };
}

/** Signs in through the app's own Firebase client (talking to the auth emulator). */
export async function signIn(page, who) {
    await page.goto(`${BASE}/privacy`);
    await page.evaluate(async ({ email, password }) => {
        const { auth } = await import('/js/firebase.js');
        await auth.signInWithEmailAndPassword(email, password);
    }, { email: EMAILS[who], password: PASSWORD });
}
