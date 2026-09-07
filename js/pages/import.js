import { auth } from '../firebase.js';
import { Auth } from '../auth.js';
import { initPrestoImporter } from '../presto-importer.js';
import { normalizePhone } from '../phone-fields.js';
import { getPhoneCooldownSeconds, persistPhoneCooldown, clearPhoneCooldown } from '../shared/phone-cooldown.js';

const DOM = {
    emailStep: document.getElementById('import-email-step'),
    phoneStep: document.getElementById('import-phone-step'),
    codeStep: document.getElementById('import-code-step'),
    checkEmailStep: document.getElementById('import-check-email-step'),
    deniedStep: document.getElementById('import-denied-step'),
    loadingStep: document.getElementById('import-loading-step'),
    active: document.getElementById('import-active'),
    deniedMessage: document.getElementById('import-denied-message'),
    heading: document.getElementById('import-heading'),
    emailInput: document.getElementById('import-email'),
    sendLink: document.getElementById('btn-import-send-link'),
    useEmail: document.getElementById('btn-import-use-email'),
    usePhone: document.getElementById('btn-import-use-phone'),
    sentTo: document.getElementById('import-sent-to'),
    status: document.getElementById('import-status'),
    phoneInput: document.getElementById('import-phone'),
    phoneWrap: document.getElementById('import-phone-wrap'),
    requestCode: document.getElementById('btn-import-request-code'),
    codeInput: document.getElementById('import-code'),
    verifyCode: document.getElementById('btn-import-verify-code'),
};

const STEPS = ['emailStep', 'phoneStep', 'codeStep', 'checkEmailStep', 'deniedStep', 'loadingStep', 'active'];

let normalizedPhone = '';
let requestBusy = false;

function showStep(name) {
    STEPS.forEach(step => DOM[step].classList.toggle('hidden', step !== name));
}

function setStatus(message, type = 'error') {
    if (!message) {
        DOM.status.classList.add('hidden');
        return;
    }
    DOM.status.textContent = message;
    DOM.status.className = `status-msg ${type}`;
    DOM.status.classList.remove('hidden');
}

async function sendLink() {
    const email = DOM.emailInput.value.trim();
    if (!email || !email.includes('@')) {
        setStatus('Enter a valid email address.');
        return;
    }
    setStatus('');
    DOM.sendLink.disabled = true;
    DOM.sendLink.textContent = 'Sending…';
    try {
        await Auth.sendMagicLink(email, '/import');
        DOM.sentTo.textContent = email;
        DOM.heading.textContent = 'Check your email';
        showStep('checkEmailStep');
    } catch (error) {
        setStatus(Auth.getErrorMessage(error.code));
    } finally {
        DOM.sendLink.disabled = false;
        DOM.sendLink.innerHTML = 'Email me a sign-in link <i data-lucide="arrow-right" aria-hidden="true"></i>';
        if (window.lucide) lucide.createIcons();
    }
}

function hasValidPhone() {
    return normalizePhone(DOM.phoneInput.value).replace(/\D/g, '').length >= 10;
}

async function requestCode() {
    if (requestBusy) return;
    if (!hasValidPhone()) {
        DOM.phoneWrap.classList.remove('auth-input-shake');
        void DOM.phoneWrap.offsetWidth;
        DOM.phoneWrap.classList.add('auth-input-shake');
        DOM.phoneInput.focus();
        return;
    }

    normalizedPhone = normalizePhone(DOM.phoneInput.value);
    const cooldown = getPhoneCooldownSeconds(normalizedPhone);
    if (cooldown > 0) {
        setStatus(`Please wait ${cooldown} seconds before requesting another code.`);
        return;
    }

    setStatus('');
    requestBusy = true;
    DOM.requestCode.disabled = true;
    DOM.requestCode.textContent = 'Sending…';
    try {
        const result = await Auth.requestPhoneCode(normalizedPhone);
        if (result.isAdmin) clearPhoneCooldown(normalizedPhone);
        else persistPhoneCooldown(normalizedPhone);
        DOM.codeInput.value = '';
        DOM.heading.textContent = 'Enter the 6-digit code';
        showStep('codeStep');
        DOM.codeInput.focus();
    } catch (error) {
        setStatus(error.message);
    } finally {
        requestBusy = false;
        DOM.requestCode.innerHTML = 'Text me a code <i data-lucide="arrow-right" aria-hidden="true"></i>';
        if (window.lucide) lucide.createIcons();
    }
}

async function verifyCode() {
    setStatus('');
    DOM.verifyCode.disabled = true;
    DOM.verifyCode.textContent = 'Verifying…';
    try {
        await Auth.verifyPhoneCode(normalizedPhone, DOM.codeInput.value.trim());
    } catch (error) {
        setStatus(error.message);
        DOM.codeInput.select();
        DOM.verifyCode.disabled = false;
        DOM.verifyCode.innerHTML = 'Continue <i data-lucide="arrow-right" aria-hidden="true"></i>';
        if (window.lucide) lucide.createIcons();
    }
}

async function handleSignedInUser(user) {
    showStep('loadingStep');
    const verification = await Auth.checkWhitelist(user.email || null, user.uid);
    if (!verification.allowed) {
        await Auth.signOut();
        DOM.deniedMessage.textContent = verification.error || 'This account is not invited yet.';
        DOM.heading.textContent = 'Not available';
        showStep('deniedStep');
        return;
    }
    DOM.heading.textContent = 'Import your rides';
    showStep('active');
    initPrestoImporter({ user });
}

async function init() {
    if (auth.isSignInWithEmailLink(window.location.href)) {
        showStep('loadingStep');
        try {
            await Auth.completeMagicLinkSignIn();
        } catch (error) {
            setStatus(Auth.getErrorMessage(error.code));
            showStep('emailStep');
            return;
        }
    }

    DOM.sendLink.addEventListener('click', sendLink);
    DOM.emailInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') sendLink();
    });
    DOM.requestCode.addEventListener('click', requestCode);
    DOM.phoneInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') requestCode();
    });
    DOM.codeInput.addEventListener('input', () => {
        DOM.codeInput.value = DOM.codeInput.value.replace(/\D/g, '').slice(0, 6);
        DOM.verifyCode.disabled = DOM.codeInput.value.length !== 6;
    });
    DOM.codeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !DOM.verifyCode.disabled) verifyCode();
    });
    DOM.verifyCode.addEventListener('click', verifyCode);
    DOM.useEmail.addEventListener('click', () => {
        setStatus('');
        DOM.heading.textContent = 'Sign in to import';
        showStep('emailStep');
    });
    DOM.usePhone.addEventListener('click', () => {
        setStatus('');
        DOM.heading.textContent = 'Sign in to import';
        showStep('phoneStep');
    });

    auth.onAuthStateChanged((user) => {
        if (user) handleSignedInUser(user);
    });

    if (window.lucide) lucide.createIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
