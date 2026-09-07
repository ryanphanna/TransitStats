import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { refreshIcons } from '../shared/icons.js';
import { Profile } from '../profile.js';
import { Identity } from '../identity.js';
import { openSettingsPanel } from '../shared/settings-panel.js';

const LEADERBOARD_URL = import.meta.env.VITE_LEADERBOARD_URL
    || 'https://us-central1-transitstats-21ba4.cloudfunctions.net/leaderboard';

function appendText(parent, tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
}

function renderStatus(container, text, action = false) {
    container.replaceChildren();
    const status = appendText(container, 'p', text, 'leaderboard-status');
    if (action) {
        const button = appendText(container, 'button', 'Open Sharing settings', 'btn btn-sm btn-primary');
        button.type = 'button';
        button.addEventListener('click', () => openSettingsPanel({ tab: 'sharing' }));
    }
    return status;
}

function renderLeaderboard(container, data, viewerUsername, viewerOptedIn) {
    container.replaceChildren();

    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0) {
        renderStatus(container, 'Nobody has joined yet. You can be first from Sharing settings.', true);
        return;
    }

    if (!viewerOptedIn || (!data.viewer && viewerUsername)) {
        const note = document.createElement('div');
        note.className = 'leaderboard-viewer-note';
        appendText(note, 'span', viewerOptedIn ? 'You are not listed yet.' : 'You are not listed.', 'leaderboard-viewer-note-title');
        appendText(note, 'span', 'Join from Sharing settings to add your score.', 'leaderboard-viewer-note-copy');
        container.appendChild(note);
    }

    const list = document.createElement('div');
    list.className = 'leaderboard-list';
    entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = `leaderboard-row${entry.username?.toLowerCase() === viewerUsername ? ' is-viewer' : ''}`;
        appendText(row, 'span', `#${entry.rank}`, 'leaderboard-rank');

        const identity = document.createElement('div');
        identity.className = 'leaderboard-identity';
        const emoji = Identity.toEmojis(entry.emojiUsername || '');
        appendText(identity, 'span', emoji || '🚇', 'leaderboard-emoji');
        appendText(identity, 'strong', entry.displayName || `@${entry.username || 'traveler'}`, 'leaderboard-name');
        if (entry.username) appendText(identity, 'span', `@${entry.username}`, 'leaderboard-username');
        row.appendChild(identity);

        const score = document.createElement('div');
        score.className = 'leaderboard-score';
        appendText(score, 'strong', Number(entry.score || 0).toLocaleString('en-US'), 'leaderboard-score-value');
        appendText(score, 'span', 'rides', 'leaderboard-score-label');
        row.appendChild(score);
        list.appendChild(row);
    });
    container.appendChild(list);

    if (data.viewer) {
        const viewer = document.createElement('div');
        viewer.className = 'leaderboard-your-rank';
        appendText(viewer, 'span', 'Your rank', 'leaderboard-your-rank-label');
        appendText(viewer, 'strong', `#${data.viewer.rank} · ${Number(data.viewer.score || 0).toLocaleString('en-US')} rides`, 'leaderboard-your-rank-value');
        container.appendChild(viewer);
    }
}

async function init() {
    const { user } = await requireAuth();
    await Profile.load(user);
    initHeader({ currentPage: 'leaderboard', profileHref: Profile.data?.isPublic && Profile.data?.username
        ? `/user/${encodeURIComponent(Profile.data.username)}` : '', routesHref: '/routes', leaderboardHref: '/leaderboard' });

    const container = document.getElementById('leaderboard-content');
    const username = String(Profile.data?.username || '').trim().toLowerCase();
    try {
        const query = username && Profile.data?.leaderboardOptIn ? `?user=${encodeURIComponent(username)}` : '';
        const response = await fetch(`${LEADERBOARD_URL}${query}`);
        if (!response.ok) throw new Error(`Leaderboard returned ${response.status}`);
        renderLeaderboard(container, await response.json(), username, Profile.data?.leaderboardOptIn === true);
    } catch (error) {
        console.error('Leaderboard load failed:', error);
        renderStatus(container, 'The leaderboard could not load right now. Try again later.');
    }
    refreshIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
