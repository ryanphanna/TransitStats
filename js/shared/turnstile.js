// Cloudflare Turnstile for the phone-login "text me a code" request (#257).
// Loaded with ?render=explicit&onload=... (never async + turnstile.ready()),
// rendered once with execution:'execute' so a challenge only runs when a code
// is requested, and reset before every request because tokens are single-use.
// The server decides whether a missing token blocks the request, so a failure
// here resolves to '' instead of throwing.

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=';
const ONLOAD_CALLBACK = '__transitStatsTurnstileLoaded';
const PRODUCTION_SITE_KEY = '0x4AAAAAAEk8ciKktVYaFU9J';
export const TURNSTILE_ACTION = 'otp_request'; // must match functions/lib/turnstile.js
const LOAD_TIMEOUT_MS = 10000;
const TOKEN_TIMEOUT_MS = 15000;
const INTERACTIVE_TIMEOUT_MS = 120000;

export function createTurnstileClient({
    win = window,
    doc = document,
    container,
    siteKey = import.meta.env?.VITE_TURNSTILE_SITE_KEY || PRODUCTION_SITE_KEY,
} = {}) {
    let loadPromise = null;
    let widgetId = null;
    let pending = null;

    function settle(token) {
        if (!pending) return;
        const { resolve, timer } = pending;
        pending = null;
        win.clearTimeout(timer);
        resolve(token);
    }

    function load() {
        if (win.turnstile) return Promise.resolve(win.turnstile);
        if (loadPromise) return loadPromise;
        loadPromise = new Promise((resolve, reject) => {
            const timer = win.setTimeout(() => reject(new Error('Turnstile script load timed out')), LOAD_TIMEOUT_MS);
            win[ONLOAD_CALLBACK] = () => {
                win.clearTimeout(timer);
                if (win.turnstile) resolve(win.turnstile);
                else reject(new Error('Turnstile loaded without its API'));
            };
            const script = doc.createElement('script');
            script.src = SCRIPT_SRC + ONLOAD_CALLBACK;
            script.onerror = () => {
                win.clearTimeout(timer);
                reject(new Error('Turnstile script failed to load'));
            };
            doc.head.appendChild(script);
        }).catch(error => {
            loadPromise = null; // allow a retry on the next request
            throw error;
        });
        return loadPromise;
    }

    function render(turnstile) {
        if (widgetId !== null) return;
        widgetId = turnstile.render(container, {
            sitekey: siteKey,
            action: TURNSTILE_ACTION,
            execution: 'execute',
            appearance: 'interaction-only',
            callback: token => settle(token),
            'error-callback': code => {
                win.console?.warn?.('Turnstile error', code);
                settle('');
                return true;
            },
            'timeout-callback': () => settle(''),
            // The visitor may need a moment to answer a challenge, so give it longer.
            'before-interactive-callback': () => {
                if (!pending) return;
                win.clearTimeout(pending.timer);
                pending.timer = win.setTimeout(() => settle(''), INTERACTIVE_TIMEOUT_MS);
            },
        });
    }

    // Resolves to a fresh token, or '' if Turnstile couldn't produce one.
    async function getToken() {
        if (!container) return '';
        try {
            const turnstile = await load();
            render(turnstile);
            settle('');
            const token = new Promise(resolve => {
                pending = { resolve, timer: win.setTimeout(() => settle(''), TOKEN_TIMEOUT_MS) };
            });
            turnstile.reset(widgetId);
            turnstile.execute(widgetId);
            return await token;
        } catch (error) {
            win.console?.warn?.('Turnstile unavailable', error?.message);
            return '';
        }
    }

    return { load, getToken };
}
