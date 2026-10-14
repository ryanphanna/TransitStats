import { auth } from '../firebase.js';
import { Auth } from '../auth.js';
import { Profile } from '../profile.js';
import { UI } from '../ui-utils.js';
import { ModalManager } from './modal-engine.js';
import { refreshIcons } from './icons.js';
import { initPrestoImporter } from '../presto-importer.js';

const TABS = [
    { id: 'account', label: 'Account' },
    { id: 'map', label: 'Map' },
    { id: 'profile', label: 'Profile' },
    { id: 'sharing', label: 'Sharing' },
    { id: 'import', label: 'Import' },
];

let injected = false;
let initialized = false;

function panelMarkup() {
    return `
        <div id="modal-settings" class="modal modal-settings hidden">
            <div class="modal-header">
                <h2>Settings</h2>
                <button class="btn-close" data-close-modal><i data-lucide="x"></i></button>
            </div>
            <div class="settings-panel-body">
                <nav class="settings-panel-nav">
                    ${TABS.map((tab, index) => `
                        <button type="button" class="settings-panel-tab ${index === 0 ? 'active' : ''}" data-settings-tab="${tab.id}">${tab.label}</button>
                    `).join('')}
                </nav>
                <div class="settings-panel-content">
                    <div class="settings-panel-pane active" data-settings-pane="account">
                        <div class="settings-card premium-card">
                            <div class="settings-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Email</span>
                                    <div class="settings-name-value-row">
                                        <span id="settings-email" class="settings-main-label settings-account-value text-xs">—</span>
                                        <button id="btn-link-email" class="btn btn-link settings-text-action hidden" title="Link an email to this account">Link email</button>
                                    </div>
                                </div>
                            </div>
                            <div id="link-email-editor" class="settings-row settings-link-email-editor hidden">
                                <div class="settings-label-group">
                                    <span class="settings-sub-label">Adding an email lets you sign in with it later (e.g. on the Import page) as the same account, instead of a separate one.</span>
                                    <input type="email" id="link-email-address" class="minimal-input" placeholder="Email address" autocomplete="email">
                                    <input type="password" id="link-email-password" class="minimal-input" placeholder="Choose a password" autocomplete="new-password">
                                    <div class="settings-link-email-actions">
                                        <button id="btn-save-link-email" class="btn btn-sm btn-primary">Link account</button>
                                        <button id="btn-cancel-link-email" class="btn btn-sm btn-ghost" type="button">Cancel</button>
                                    </div>
                                </div>
                            </div>
                            <div class="settings-row settings-password-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Password</span>
                                    <div class="settings-password-value-row">
                                        <span class="settings-sub-label settings-password-mask" aria-label="Password managed through email">••••••••</span>
                                        <button id="btn-reset-password" class="btn btn-link settings-text-action">Reset password</button>
                                    </div>
                                </div>
                            </div>
                            <div class="settings-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Phone</span>
                                    <span id="settings-phone" class="settings-main-label settings-account-value text-xs">Loading...</span>
                                </div>
                            </div>
                            <div class="settings-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Plan</span>
                                    <span id="settings-plan" class="settings-main-label settings-account-value text-xs">—</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="settings-panel-pane" data-settings-pane="map">
                        <div class="settings-card premium-card">
                            <div id="settings-agency-no-phone" class="settings-coming-soon hidden">
                                Available once your phone number is linked for text trip logging.
                            </div>
                            <div id="settings-agency-row" class="settings-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Primary agency</span>
                                    <div class="settings-agency-value-row">
                                        <span id="settings-agency-display" class="settings-main-label settings-account-value">Automatic</span>
                                        <button id="btn-change-agency" class="btn btn-link settings-text-action" title="Change primary agency">Change</button>
                                    </div>
                                </div>
                                <div id="settings-agency-field" class="settings-agency-field hidden">
                                    <input type="search" id="settings-agency" class="minimal-input settings-agency-input" autocomplete="off" placeholder="Automatic" aria-label="Primary agency">
                                    <button type="button" id="btn-clear-agency" class="btn btn-sm btn-ghost settings-agency-clear" title="Use automatic detection" aria-label="Use automatic detection">Auto</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div id="public-profile-settings" class="settings-panel-pane settings-public-profile-group" data-settings-pane="profile">
                        <div class="settings-card premium-card">
                            <div class="settings-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Display name</span>
                                    <div class="settings-name-value-row">
                                        <span id="settings-name-display" class="settings-main-label settings-account-value">Not set</span>
                                        <input type="text" id="settings-name" class="minimal-input hidden" placeholder="Enter name...">
                                        <button id="btn-change-name" class="btn btn-link settings-text-action" title="Change display name">Change</button>
                                        <button id="btn-save-name" class="btn btn-link settings-text-action hidden" title="Save name">Save</button>
                                    </div>
                                </div>
                            </div>
                            <div class="settings-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Map stops</span>
                                    <span class="settings-sub-label">Choose boarding or exiting stops</span>
                                </div>
                                <select id="settings-map-stop-mode" class="minimal-select" aria-label="Map stops">
                                    <option value="boarding">Boarding</option>
                                    <option value="exiting">Exiting</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div id="sharing-settings" class="settings-panel-pane settings-public-profile-group" data-settings-pane="sharing">
                        <div class="settings-card premium-card">
                            <div id="settings-admin-username" class="settings-row settings-admin-username-row hidden">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Custom username</span>
                                    <div class="settings-custom-username-value-row">
                                        <span id="settings-custom-username-display" class="settings-main-label settings-account-value">Not set</span>
                                        <button id="btn-change-custom-username" class="btn btn-link settings-text-action">Change</button>
                                    </div>
                                </div>
                                <div id="settings-custom-username-editor" class="settings-custom-username-editor hidden">
                                    <input id="settings-custom-username" class="minimal-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. r" aria-label="Custom username">
                                    <button id="btn-save-custom-username" class="btn btn-link settings-text-action">Save</button>
                                </div>
                            </div>
                            <div id="settings-sharing-content">
                                <div class="settings-row">
                                    <div class="settings-label-group">
                                        <span class="settings-sub-label">Allow others to view your shared stats page</span>
                                    </div>
                                    <input type="checkbox" id="settings-public-profile" aria-label="Allow others to view your shared stats page">
                                </div>
                                <div class="settings-row settings-identity-row">
                                    <span class="settings-main-label">Public identity</span>
                                    <div id="emoji-identity-picker" class="emoji-picker-container">
                                        <div class="emoji-slots">
                                            <div class="emoji-slot" data-index="0">❓</div>
                                            <div class="emoji-slot" data-index="1">❓</div>
                                            <div class="emoji-slot" data-index="2">❓</div>
                                        </div>
                                        <button id="btn-save-identity" class="btn btn-sm btn-primary">Save identity</button>
                                    </div>
                                    <span id="settings-identity-help" class="settings-sub-label">Choose carefully — this identity can’t be changed later.</span>
                                    <div id="settings-username-display" class="settings-main-label settings-account-value text-xxs text-muted"></div>
                                </div>
                                <div class="settings-row">
                                    <div class="settings-label-group">
                                        <span class="settings-main-label">Profile URLs</span>
                                        <div id="settings-public-link" class="settings-profile-links settings-main-label text-xs">Pick your identity to enable sharing.</div>
                                    </div>
                                </div>
                                <div id="emoji-popover" class="emoji-popover hidden">
                                    <div class="emoji-grid"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="settings-panel-pane" data-settings-pane="import">
                        <div id="presto-import-group" class="settings-card premium-card">
                            <div class="settings-row settings-presto-import-row">
                                <div class="settings-label-group">
                                    <span class="settings-main-label">Import PRESTO activity</span>
                                    <span class="settings-sub-label">Upload your PRESTO Transit Usage Report to add past rides to your map.</span>
                                </div>
                                <ol class="presto-howto">
                                    <li>Sign in at <a href="https://www.prestocard.ca" target="_blank" rel="noopener">prestocard.ca</a></li>
                                    <li>In the sidebar, click <strong>Transit Usage Report</strong> (not "Transaction History")</li>
                                    <li>Pick a year, then click <strong>Get Report</strong></li>
                                    <li>Click <strong>Export CSV</strong> (not "Download PDF")</li>
                                    <li>Upload that file below</li>
                                </ol>
                                <input id="presto-file-input" type="file" accept=".csv,text/csv" multiple>
                                <button id="presto-preview-button" class="btn btn-sm btn-primary" type="button" disabled>Preview</button>
                            </div>
                            <div id="presto-import-status" class="settings-row hidden" role="status" aria-live="polite"></div>
                            <div id="presto-import-preview" class="settings-row hidden"></div>
                            <div id="presto-import-actions" class="settings-row hidden">
                                <button id="presto-import-button" class="btn btn-primary" type="button">Import activity</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function showTab(tabId) {
    document.querySelectorAll('.settings-panel-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.settingsTab === tabId);
    });
    document.querySelectorAll('.settings-panel-pane').forEach(pane => {
        pane.classList.toggle('active', pane.dataset.settingsPane === tabId);
    });
}

function injectPanel() {
    if (injected) return;
    injected = true;
    document.body.insertAdjacentHTML('beforeend', panelMarkup());
    if (window.lucide) lucide.createIcons();

    document.querySelectorAll('.settings-panel-tab').forEach(tab => {
        tab.addEventListener('click', () => showTab(tab.dataset.settingsTab));
    });
}

// Pages other than dashboard/routes don't call requireAuth() (the
// public profile page only checks Firebase auth state directly), so window.currentUser
// and window.isAdmin aren't guaranteed to be set. Reuse them when present;
// otherwise resolve isAdmin the same way requireAuth() does.
async function resolveAuthContext() {
    if (window.currentUser) {
        return { user: window.currentUser, isAdmin: !!window.isAdmin };
    }
    const user = auth.currentUser;
    if (!user) return null;
    const verification = await Auth.checkWhitelist(user.email || null, user.uid);
    return { user, isAdmin: !!verification.isAdmin };
}

async function initPanelData() {
    if (initialized) return;
    const context = await resolveAuthContext();
    if (!context) return;
    initialized = true;

    const { user, isAdmin } = context;
    await Profile.load(user);
    await Profile.loadAgencies(user);
    await Profile.init();

    // Admins already get every premium perk (see hasPremiumAccess on the
    // backend), so the plan shown here reflects what the account actually
    // gets, not just the raw isPremium flag.
    const planEl = document.getElementById('settings-plan');
    if (planEl) planEl.textContent = isAdmin ? 'Admin' : (Profile.data?.isPremium ? 'Premium' : 'Free');

    // Map only holds the primary-agency setting, which only affects text-in
    // trip logging — pointless to show at all without a linked phone.
    if (!Profile.phone) {
        document.querySelector('.settings-panel-tab[data-settings-tab="map"]')?.classList.add('hidden');
    }

    // PRESTO import is open to every signed-in (invited) user.
    initPrestoImporter({ user });

    // Phone-only accounts have no email in Firebase at all, so the password
    // row (which only makes sense once there's an email/password to reset)
    // stays hidden until one is linked. Linking uses the same Firebase
    // 'password' provider as email-link sign-in, so the account is then
    // reachable — as the same account — from either the homepage phone flow
    // or an email sign-in (e.g. on /import) instead of creating a second,
    // disconnected one.
    const emailEl = document.getElementById('settings-email');
    const passwordRow = document.querySelector('.settings-password-row');
    const linkButton = document.getElementById('btn-link-email');
    const linkEditor = document.getElementById('link-email-editor');
    const linkEmailInput = document.getElementById('link-email-address');
    const linkPasswordInput = document.getElementById('link-email-password');
    const saveLinkButton = document.getElementById('btn-save-link-email');

    if (!user.email) {
        passwordRow?.classList.add('hidden');
        linkButton?.classList.remove('hidden');
    }

    linkButton?.addEventListener('click', () => {
        linkButton.classList.add('hidden');
        linkEditor?.classList.remove('hidden');
        linkEmailInput?.focus();
    });

    document.getElementById('btn-cancel-link-email')?.addEventListener('click', () => {
        linkEditor?.classList.add('hidden');
        linkButton?.classList.remove('hidden');
        if (linkEmailInput) linkEmailInput.value = '';
        if (linkPasswordInput) linkPasswordInput.value = '';
    });

    saveLinkButton?.addEventListener('click', async () => {
        const email = linkEmailInput?.value.trim();
        const password = linkPasswordInput?.value || '';
        if (!email || !password) {
            UI.showNotification('Enter an email and password.');
            return;
        }
        saveLinkButton.disabled = true;
        saveLinkButton.textContent = 'Linking…';
        try {
            await Auth.linkEmail(email, password);
            if (emailEl) emailEl.textContent = email;
            linkEditor?.classList.add('hidden');
            passwordRow?.classList.remove('hidden');
            UI.showNotification('Email linked to your account.', 'success');
        } catch (error) {
            UI.showNotification(Auth.getErrorMessage(error.code));
        } finally {
            saveLinkButton.disabled = false;
            saveLinkButton.textContent = 'Link account';
        }
    });

    document.getElementById('btn-reset-password')?.addEventListener('click', async () => {
        const button = document.getElementById('btn-reset-password');
        if (!user.email || button?.disabled) return;
        button.disabled = true;
        button.textContent = 'Sending…';
        try {
            await Auth.sendPasswordReset(user.email);
            UI.showNotification('Password reset email sent.', 'success');
        } catch (error) {
            UI.showNotification(error.message || 'Could not send password reset email.');
        } finally {
            button.disabled = false;
            button.textContent = 'Reset password';
        }
    });

    refreshIcons();
}

export async function openSettingsPanel({ tab } = {}) {
    injectPanel();
    ModalManager.init();
    await initPanelData();
    if (tab) showTab(tab);
    ModalManager.open('modal-settings');
}
