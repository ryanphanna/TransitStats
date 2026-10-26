import { Auth } from '../auth.js';
import { openSettingsPanel } from './settings-panel.js';
import { refreshIcons } from './icons.js';

/**
 * Shared Header Component
 * Injects navigation into the page.
 */
export function initHeader({ currentPage = '', profileHref = '', shareAction = false, showRecap = false } = {}) {
    _render(currentPage, profileHref, shareAction, showRecap);
}

function _render(currentPage, profileHref, shareAction, showRecap) {
    const root = document.getElementById('app-root');
    if (!root) return;

    const logoHref = '/dashboard';

    const headerHtml = `
        <header class="header">
            <div class="header-container">
                <a href="${logoHref}" class="logo">
                     <div class="logo-icon"><i data-lucide="zap"></i></div>
                     <span class="logo-text">TransitStats</span>
                </a>

                <div class="header-actions">
                    ${shareAction ? `
                        <button id="btn-header-share" class="header-action-link" title="Share your map" type="button">
                            <span>Share</span>
                        </button>` : ''}
                    ${showRecap ? `
                        <a href="/recap" class="header-action-link ${currentPage === 'recap' ? 'active' : ''}" title="Recap">
                            <span>Recap</span>
                        </a>` : ''}
                    ${profileHref ? `
                        <a href="${profileHref}" class="header-action-link ${currentPage === 'profile' ? 'active' : ''}" title="Profile">
                            <span>Profile</span>
                        </a>` : ''}
                    <button id="btn-header-settings" class="header-action-link" title="Settings" type="button">
                        <span>Settings</span>
                    </button>
                    <button id="btn-header-logout" class="header-action-link header-logout" title="Log out" aria-label="Log out">
                        <span>Log out</span>
                    </button>
                </div>
            </div>
        </header>
    `;

    root.insertAdjacentHTML('afterbegin', headerHtml);
    refreshIcons();

    document.getElementById('btn-header-settings')?.addEventListener('click', () => openSettingsPanel());

    const logout = document.getElementById('btn-header-logout');
    let armed = false;
    let timer = null;
    logout?.addEventListener('click', async () => {
        if (!armed) {
            armed = true;
            logout.classList.add('confirming');
            logout.setAttribute('aria-label', 'Tap again to sign out');
            logout.title = 'Tap again to sign out';
            timer = setTimeout(() => {
                armed = false;
                logout.classList.remove('confirming');
                logout.setAttribute('aria-label', 'Sign out');
                logout.title = 'Sign out';
            }, 3000);
            return;
        }

        clearTimeout(timer);
        logout.disabled = true;
        await Auth.signOut();
        window.location.href = '/';
    });
}
