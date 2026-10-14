import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn(async () => {});
const checkWhitelist = vi.fn();
let authListener = null;

vi.mock('../js/firebase.js', () => ({
    auth: {
        isSignInWithEmailLink: () => false,
        onAuthStateChanged: (cb) => { authListener = cb; },
    },
}));
vi.mock('../js/auth.js', () => ({ Auth: { checkWhitelist, signOut } }));
vi.mock('../js/presto-importer.js', () => ({ initPrestoImporter: vi.fn() }));

const IDS = [
    'import-email-step', 'import-phone-step', 'import-code-step', 'import-check-email-step',
    'import-denied-step', 'import-loading-step', 'import-active', 'import-denied-message',
    'import-heading', 'import-email', 'btn-import-send-link', 'btn-import-use-email',
    'btn-import-use-phone', 'import-sent-to', 'import-status', 'import-phone', 'import-phone-wrap',
    'btn-import-request-code', 'import-code', 'btn-import-verify-code',
];

describe('/import page access', () => {
    beforeEach(async () => {
        vi.resetModules();
        signOut.mockClear();
        checkWhitelist.mockReset();
        document.body.innerHTML = IDS.map(id => `<div id="${id}" class="hidden"></div>`).join('');
        const { initPrestoImporter } = await import('../js/presto-importer.js');
        initPrestoImporter.mockClear();
        await import('../js/pages/import.js');
    });

    it('opens the importer for any invited user, pilot or not, without signing them out', async () => {
        checkWhitelist.mockResolvedValue({ allowed: true, isAdmin: false, pilot: null });
        await authListener({ uid: 'u1', email: 'a@example.com' });
        const { initPrestoImporter } = await import('../js/presto-importer.js');
        await vi.waitFor(() => expect(initPrestoImporter).toHaveBeenCalled());
        expect(document.getElementById('import-active').classList.contains('hidden')).toBe(false);
        expect(signOut).not.toHaveBeenCalled();
    });

    it('still signs out an account that is not allowed at all', async () => {
        checkWhitelist.mockResolvedValue({ allowed: false, error: 'Access denied.' });
        await authListener({ uid: 'u1', email: 'a@example.com' });
        await vi.waitFor(() => expect(signOut).toHaveBeenCalled());
    });
});
