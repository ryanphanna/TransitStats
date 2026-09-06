import { auth } from '../firebase.js';
import { Auth } from '../auth.js';
import { normalizePhone } from '../phone-fields.js';
import { getPhoneCooldownSeconds, persistPhoneCooldown, clearPhoneCooldown } from '../shared/phone-cooldown.js';

const DOM = {
    phoneStep: document.getElementById('auth-phone-step'),
    emailStep: document.getElementById('auth-email-step'),
    codeStep: document.getElementById('auth-code-step'),
    stepFrame: document.querySelector('.auth-step-frame'),
    heading: document.getElementById('auth-heading'),
    phoneInput: document.getElementById('auth-phone'),
    phoneWrap: document.getElementById('auth-phone-wrap'),
    codeInput: document.getElementById('auth-code'),
    codeWrap: document.querySelector('.auth-code-wrap'),
    requestCode: document.getElementById('btn-auth-request-code'),
    emailMode: document.getElementById('btn-auth-email-mode'),
    phoneMode: document.getElementById('btn-auth-phone-mode'),
    emailInput: document.getElementById('auth-email'),
    passwordInput: document.getElementById('auth-password'),
    turnstile: document.getElementById('auth-turnstile'),
    emailLogin: document.getElementById('btn-auth-email-login'),
    resetPassword: document.getElementById('btn-auth-reset-password'),
    verifyCode: document.getElementById('btn-auth-verify-code'),
    resendCode: document.getElementById('btn-auth-resend-code'),
    status: document.getElementById('auth-status')
};

let normalizedPhone = '';
let requestBusy = false;
let adminSession = false;
let resendSeconds = 0;
let resendTimer = null;
let phoneCooldownTimer = null;
const RESEND_COOLDOWN_SECONDS = 60;

// Cloudflare Turnstile (invisible) blocks bots from hitting the OTP-send
// endpoint directly. The widget auto-executes on load and re-executes after
// each reset, so a fresh token is usually already waiting by the time the
// user submits; getTurnstileToken() falls back to waiting for the callback
// if it isn't ready yet.
let turnstileToken = '';
let turnstileWaiters = [];
let turnstileWidgetId = null;
let turnstileLoadPromise = null;
const TURNSTILE_SITE_KEY = '0x4AAAAAAEk8ciKktVYaFU9J';
window.onTurnstileToken = (token) => {
    turnstileToken = token;
    turnstileWaiters.forEach(waiter => waiter.resolve(token));
    turnstileWaiters = [];
};
function rejectTurnstileWaiters(message) {
    turnstileWaiters.forEach(waiter => waiter.reject(new Error(message)));
    turnstileWaiters = [];
}
function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoadPromise) return turnstileLoadPromise;

    turnstileLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Cloudflare security check loaded without its API.'));
        script.onerror = () => reject(new Error('Security check did not load. Please disable any blocker for challenges.cloudflare.com and refresh.'));
        document.head.appendChild(script);
    });
    return turnstileLoadPromise;
}
async function initTurnstile() {
    if (turnstileWidgetId !== null || !DOM.turnstile) return;
    const turnstile = await loadTurnstile();
    await new Promise(resolve => turnstile.ready(resolve));
    turnstileWidgetId = turnstile.render(DOM.turnstile, {
        sitekey: TURNSTILE_SITE_KEY,
        size: 'invisible',
        action: 'turnstile-spin-v1',
        callback: window.onTurnstileToken,
        'error-callback': () => {
            rejectTurnstileWaiters('Cloudflare security check failed.');
            return true;
        },
        'expired-callback': () => { turnstileToken = ''; },
    });
    turnstile.execute(DOM.turnstile);
}
async function getTurnstileToken() {
    await initTurnstile();
    if (turnstileToken) return Promise.resolve(turnstileToken);
    return new Promise((resolve, reject) => {
        const waiter = {
            resolve: token => {
                window.clearTimeout(timeout);
                resolve(token);
            },
        };
        const timeout = window.setTimeout(() => {
            turnstileWaiters = turnstileWaiters.filter(candidate => candidate !== waiter);
            reject(new Error('Security check did not load. Please refresh and try again.'));
        }, 8000);
        turnstileWaiters.push(waiter);
    });
}
function resetTurnstile() {
    turnstileToken = '';
    if (window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId);
        window.turnstile.execute(turnstileWidgetId);
    }
}

// The real shape of the TTC subway/LRT network (Lines 1, 2, 4, 5), simplified
// from Atlas route geometry and fitted to the same viewBox/paths the abstract
// map uses, so Toronto visitors see their own network instead of a generic
// squiggle. Every other city keeps the abstract shape — sourcing and fitting
// real geometry per city is its own project, not a quick swap.
const TORONTO_REAL_MAP = {
    paths: {
        gold: 'M328.9 204.2Q388.5 574.4 420.7 686.9Q452.9 799.4 445.2 805.5Q437.5 811.5 418.1 759.8Q398.8 708.1 382.7 709.6Q366.6 711.1 356.6 678.7Q346.6 646.3 306.5 612.9Q266.3 579.5 240.8 491.1Q215.2 402.6 193.9 365.1Q172.7 327.6 134.9 324.6Q97.2 321.5 87.0 284.1Q76.8 246.6 32.4 225.7Q-12.0 204.8 -23.4 168.6L-34.7 132.4',
        blue: 'M-58.3 845.5Q-33.4 814.8 31.9 806.3Q97.3 797.8 401.9 705.2Q706.5 612.7 735.0 593.5Q763.4 574.4 775.1 518.5Q786.8 462.6 803.4 442.2L820.0 421.9',
        red: 'M344.7 290.9Q482.9 248.2 494.6 245.9Q506.3 243.7 529.0 236.8L551.8 229.9',
        green: 'M100.3 622.3Q526.8 496.5 584.2 473.4Q641.7 450.3 670.2 453.0Q698.6 455.6 758.8 437.1L819.0 418.6',
    },
    stations: [
        [423.1, 699.1], // Bloor-Yonge
        [387.1, 707.2], // St George
        [341.4, 288.9], // Sheppard-Yonge
        [448.2, 810.3], // Union
        [-60.0, 847.6], // Kipling
        [385.8, 546.0], // Eglinton
        [263.0, 567.9], // Cedarvale
    ],
};

function applyRealTorontoMap(view) {
    Object.entries(TORONTO_REAL_MAP.paths).forEach(([slot, d]) => {
        view.querySelector(`.auth-route-${slot}`)?.setAttribute('d', d);
    });

    // Real lines vary a lot in length (Line 4 is ~200px, Line 2 ~800px), but
    // the shared flowing-dash animation is a fixed fraction of each path's
    // own length, so the same dash/gap ratio reads as smooth on long lines
    // and as a chunky dotted line on short ones. Set an absolute dash size
    // on each path instead, so they all look like the same kind of line.
    view.querySelectorAll('.auth-route').forEach(path => {
        const length = path.getTotalLength();
        if (!length) return;
        path.style.strokeDasharray = `${(46 / length).toFixed(4)} ${(23 / length).toFixed(4)}`;
    });

    const svgNS = 'http://www.w3.org/2000/svg';
    const stationGroup = view.querySelector('.auth-station');
    if (stationGroup) {
        stationGroup.textContent = '';
        TORONTO_REAL_MAP.stations.forEach(([cx, cy]) => {
            const circle = document.createElementNS(svgNS, 'circle');
            circle.setAttribute('cx', cx);
            circle.setAttribute('cy', cy);
            circle.setAttribute('r', 7);
            stationGroup.appendChild(circle);
        });
    }
    // The small dots along each route were placed to match the abstract
    // curves; they don't line up with real geometry, so hide them here.
    view.querySelector('.auth-route-dots')?.classList.add('hidden');
}

const TRANSIT_THEMES = [
    { match: ['toronto'], label: 'Toronto transit colours', featuredLine: 'Line 2 · Bloor–Danforth', colors: ['#f8c84b', '#009b4e', '#8b4a9c', '#e87511'], realMap: true },
    { match: ['mississauga'], label: 'MiWay colours', featuredLine: 'MiWay · Route 10', colors: ['#f58220', '#0072bc', '#00a99d', '#f8c84b'] },
    { match: ['vaughan', 'markham', 'richmond hill', 'york region'], label: 'YRT colours', featuredLine: 'Viva Blue', colors: ['#0072bc', '#f8c84b', '#ee6a52', '#3bb58a'] },
    { match: ['montreal'], label: 'Montréal transit colours', featuredLine: 'Orange line', colors: ['#0072bc', '#ee6a52', '#f8c84b', '#3bb58a'] },
    { match: ['vancouver', 'burnaby', 'surrey'], label: 'TransLink colours', featuredLine: 'Expo Line', colors: ['#0072bc', '#f8c84b', '#ee6a52', '#3bb58a'] },
    { match: ['new york', 'brooklyn', 'queens', 'bronx'], label: 'MTA colours', featuredLine: '7 · Flushing–Main St', colors: ['#ee6a52', '#4a6cf7', '#3bb58a', '#f8c84b'] },
    { match: ['chicago'], label: 'CTA colours', featuredLine: 'Red Line', colors: ['#ee6a52', '#4a6cf7', '#8b4a9c', '#3bb58a'] },
    { match: ['san francisco'], label: 'Muni colours', featuredLine: 'Muni Metro', colors: ['#ee6a52', '#4a6cf7', '#f8c84b', '#3bb58a'] },
    { match: ['london'], label: 'TfL colours', featuredLine: 'Central line', colors: ['#ee6a52', '#4a6cf7', '#f8c84b', '#3bb58a'] }
];

async function applyLocalTransitTheme() {
    const view = document.querySelector('.auth-view');
    const featuredLine = document.getElementById('auth-featured-line');
    if (!view) return;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const response = await fetch('https://ipapi.co/json/', { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) throw new Error('Location lookup unavailable');

        const location = await response.json();
        const searchText = `${location.city || ''} ${location.region || ''}`.toLowerCase();
        const theme = TRANSIT_THEMES.find((candidate) => candidate.match.some((name) => searchText.includes(name)));
        if (!theme) return;

        ['gold', 'blue', 'red', 'green'].forEach((name, index) => {
            view.style.setProperty(`--auth-route-${name}`, theme.colors[index]);
        });
        if (featuredLine) featuredLine.textContent = theme.featuredLine;
        if (theme.realMap) applyRealTorontoMap(view);
    } catch { /* Default colours remain in place. */ }
}

function setStatus(message, type = 'error') {
    DOM.status.textContent = message;
    DOM.status.className = `status-msg auth-status ${type}`;
    DOM.status.classList.remove('hidden');
}

function clearStatus() {
    DOM.status.textContent = '';
    DOM.status.className = 'status-msg auth-status hidden';
}

function setBusy(button, busy, busyText, idleText) {
    button.disabled = busy;
    button.innerHTML = busy ? busyText : `${idleText} <i data-lucide="arrow-right" aria-hidden="true"></i>`;
    if (window.lucide) lucide.createIcons();
}

function syncButtons() {
    if (!requestBusy) updateRequestButton();
    DOM.verifyCode.disabled = DOM.codeInput.value.trim().length !== 6;
    DOM.codeWrap?.classList.toggle('ready', !DOM.verifyCode.disabled);
}

function updateRequestButton() {
    const phone = normalizePhone(DOM.phoneInput.value);
    const cooldownSeconds = hasValidPhone() ? (adminSession ? 0 : getPhoneCooldownSeconds(phone)) : 0;
    if (cooldownSeconds > 0) {
        DOM.requestCode.disabled = true;
        DOM.requestCode.textContent = `Try again in ${cooldownSeconds}s`;
        if (!phoneCooldownTimer) {
            phoneCooldownTimer = window.setInterval(() => {
                updateRequestButton();
                if (!getPhoneCooldownSeconds(normalizePhone(DOM.phoneInput.value))) {
                    window.clearInterval(phoneCooldownTimer);
                    phoneCooldownTimer = null;
                }
            }, 1000);
        }
        return;
    }
    DOM.requestCode.disabled = false;
    DOM.requestCode.innerHTML = 'Text me a code <i data-lucide="arrow-right" aria-hidden="true"></i>';
    if (window.lucide) lucide.createIcons();
}

function updateResendButton() {
    const coolingDown = resendSeconds > 0;
    DOM.resendCode.disabled = coolingDown;
    DOM.resendCode.textContent = coolingDown ? `Resend (${resendSeconds}s)` : 'Resend code';
}

function startResendCooldown(skipCooldown = false) {
    window.clearInterval(resendTimer);
    resendSeconds = skipCooldown ? 0 : RESEND_COOLDOWN_SECONDS;
    updateResendButton();
    if (skipCooldown) return;
    resendTimer = window.setInterval(() => {
        resendSeconds -= 1;
        updateResendButton();
        if (resendSeconds <= 0) window.clearInterval(resendTimer);
    }, 1000);
}

function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function showEmailStep() {
    DOM.phoneStep.classList.add('hidden');
    DOM.codeStep.classList.add('hidden');
    DOM.emailStep.classList.remove('hidden');
    DOM.heading.textContent = 'Log in with email';
    DOM.emailInput.focus();
}

function showPhoneStep() {
    DOM.emailStep.classList.add('hidden');
    DOM.codeStep.classList.add('hidden');
    DOM.phoneStep.classList.remove('hidden');
    DOM.heading.textContent = 'Get started or log in';
    DOM.phoneInput.focus();
}

async function signInWithEmail() {
    const email = DOM.emailInput.value.trim();
    const password = DOM.passwordInput.value;
    if (!email || !password) {
        setStatus('Enter your email and password.');
        return;
    }

    clearStatus();
    setBusy(DOM.emailLogin, true, 'Opening…', 'Log in with email');
    try {
        await Auth.signInWithPassword(email, password);
        await Auth.syncSharedSession(auth.currentUser);
    } catch (error) {
        setStatus(Auth.getErrorMessage(error.code));
    } finally {
        setBusy(DOM.emailLogin, false, 'Opening…', 'Log in with email');
    }
}

async function sendPasswordReset() {
    const email = DOM.emailInput.value.trim();
    if (!email) {
        setStatus('Enter your email address first.');
        DOM.emailInput.focus();
        return;
    }

    clearStatus();
    DOM.resetPassword.disabled = true;
    try {
        await Auth.sendPasswordReset(email);
        setStatus('Password reset email sent.', 'success');
    } catch (error) {
        setStatus(Auth.getErrorMessage(error.code));
    } finally {
        DOM.resetPassword.disabled = false;
    }
}

async function transitionAuthStep(fromStep, toStep) {
    const frame = DOM.stepFrame;
    const startHeight = frame.offsetHeight;
    frame.style.height = `${startHeight}px`;
    fromStep.classList.add('is-exiting');
    await wait(140);
    fromStep.classList.add('hidden');
    fromStep.classList.remove('is-exiting');
    toStep.classList.remove('hidden');
    toStep.classList.add('is-entering');
    const endHeight = frame.scrollHeight;
    requestAnimationFrame(() => {
        frame.style.height = `${endHeight}px`;
        toStep.classList.remove('is-entering');
    });
    await wait(230);
    frame.style.height = '';
}

function hasValidPhone() {
    return normalizePhone(DOM.phoneInput.value).replace(/\D/g, '').length >= 10;
}

async function requestCode() {
    if (requestBusy) return;
    if (!hasValidPhone()) {
        clearStatus();
        DOM.phoneWrap.classList.remove('auth-input-shake');
        void DOM.phoneWrap.offsetWidth;
        DOM.phoneWrap.classList.add('auth-input-shake');
        DOM.phoneInput.focus();
        return;
    }

    normalizedPhone = normalizePhone(DOM.phoneInput.value);
    const existingCooldown = getPhoneCooldownSeconds(normalizedPhone);
    if (!adminSession && existingCooldown > 0) {
        setStatus(`Please wait ${existingCooldown} seconds before requesting another code.`);
        updateRequestButton();
        return;
    }
    clearStatus();
    requestBusy = true;
    setBusy(DOM.requestCode, true, 'Sending…', 'Text me a code');

    try {
        const turnstileToken = await getTurnstileToken();
        const result = await Auth.requestPhoneCode(normalizedPhone, turnstileToken);
        adminSession = result.isAdmin === true;
        if (adminSession) clearPhoneCooldown(normalizedPhone);
        else persistPhoneCooldown(normalizedPhone);
        DOM.requestCode.innerHTML = 'Code sent <i data-lucide="check" aria-hidden="true"></i>';
        if (window.lucide) lucide.createIcons();
        await wait(350);
        DOM.codeInput.value = '';
        DOM.heading.textContent = 'Enter the 6-digit code';
        await transitionAuthStep(DOM.phoneStep, DOM.codeStep);
        DOM.codeInput.focus();
        startResendCooldown(adminSession);
    } catch (error) {
        setStatus(error.message);
    } finally {
        resetTurnstile();
        requestBusy = false;
        setBusy(DOM.requestCode, false, 'Sending…', 'Text me a code');
        syncButtons();
    }
}

async function verifyCode() {
    clearStatus();
    setBusy(DOM.verifyCode, true, 'Opening…', 'Open TransitStats');

    try {
        await Auth.verifyPhoneCode(normalizedPhone, DOM.codeInput.value.trim());
        setStatus('Verified. You’re all set.', 'success');
    } catch (error) {
        setStatus(error.message);
        DOM.codeInput.select();
    } finally {
        setBusy(DOM.verifyCode, false, 'Opening…', 'Open TransitStats');
        syncButtons();
    }
}

function setupListeners() {
    DOM.phoneInput.addEventListener('input', () => {
        DOM.phoneWrap.classList.remove('auth-input-shake');
        syncButtons();
    });
    DOM.phoneInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !DOM.requestCode.disabled) requestCode();
    });
    DOM.codeInput.addEventListener('input', () => {
        DOM.codeInput.value = DOM.codeInput.value.replace(/\D/g, '').slice(0, 6);
        syncButtons();
    });
    DOM.codeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !DOM.verifyCode.disabled) verifyCode();
    });
    DOM.requestCode.addEventListener('click', requestCode);
    DOM.emailMode.addEventListener('click', showEmailStep);
    DOM.phoneMode.addEventListener('click', showPhoneStep);
    DOM.emailLogin.addEventListener('click', signInWithEmail);
    DOM.resetPassword.addEventListener('click', sendPasswordReset);
    DOM.passwordInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') signInWithEmail();
    });
    DOM.verifyCode.addEventListener('click', verifyCode);
    DOM.resendCode.addEventListener('click', requestCode);
}

function init() {
    window.TransitTheme?.apply(window.TransitTheme.getPreference());

    let restoring = false;
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            window.location.href = '/dashboard';
            return;
        }
        if (restoring) return;
        restoring = true;
        const restoredUser = await Auth.restoreSharedSession();
        if (restoredUser) {
            window.location.href = '/dashboard';
        }
    });

    setupListeners();
    syncButtons();
    applyLocalTransitTheme();
    if (window.lucide) lucide.createIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
