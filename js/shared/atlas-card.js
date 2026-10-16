export const ATLAS_COPY = Object.freeze({
    recentHeading: 'Recent activity',
    totalRides: 'total rides',
    weekLabel: 'Last 7<br>days',
    monthLabel: 'Last 30<br>days',
    daysLabel: 'Days ridden',
    agenciesLabel: 'Agencies',
    countriesLabel: 'Countries',
});

export function formatAtlasNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('en-US')
        : value;
}

const atlasFacts = [
    ['week', 'stat-trips-week', ATLAS_COPY.weekLabel],
    ['month', 'stat-trips-month', ATLAS_COPY.monthLabel],
    ['days', 'stat-days-ridden', ATLAS_COPY.daysLabel],
    ['agencies', 'stat-agencies-ridden', ATLAS_COPY.agenciesLabel],
    ['countries', 'stat-countries-ridden', ATLAS_COPY.countriesLabel],
];

export function renderAtlasCard({ publicProfile = false, signedIn = false, loading = false } = {}) {
    const container = document.querySelector('[data-atlas-card]');
    if (!container) return null;

    container.classList.toggle('is-loading', loading);
    container.setAttribute('aria-busy', loading ? 'true' : 'false');

    const action = publicProfile && !signedIn
        ? '<a class="atlas-card-cta" href="/">Make your own map <span aria-hidden="true">→</span></a>'
        : `<button id="atlas-share-map" class="atlas-card-cta" type="button">Share your map <span aria-hidden="true">→</span></button>`;
    const initialName = loading ? '' : signedIn ? 'Your' : 'Traveler';
    const initialValue = loading ? '' : '0';

    container.innerHTML = `
        <h1><span id="profile-name">${initialName}</span><span class="atlas-title-tail">${signedIn ? '' : '’s'}</span><span class="atlas-title-product">TransitStats</span></h1>
        <div class="atlas-hero-count">
            <strong id="stat-trips-lifetime">${initialValue}</strong>
            <span>${ATLAS_COPY.totalRides}</span>
        </div>
        <div class="atlas-card-period" aria-label="Recent trip totals">
            <div class="atlas-period-heading"><span>${ATLAS_COPY.recentHeading}</span></div>
            <div class="atlas-period-grid">
                ${atlasFacts.map(([name, id, label]) => `
                    <div class="atlas-fact atlas-fact-${name}"><strong id="${id}">${initialValue}</strong><span>${label}</span></div>
                `).join('')}
            </div>
        </div>
        ${action}
        <div id="atlas-empty-cta" class="atlas-empty-cta hidden">
            <span>No rides yet — import your PRESTO history to get started.</span>
            <a class="atlas-card-cta" href="/import">Import PRESTO history <span aria-hidden="true">→</span></a>
        </div>
    `;

    return container;
}

// Shown only for a genuinely empty, error-free account — never during a
// trip-load failure, where the same blank state must not tell someone with a
// broken connection to go import data instead of just retrying.
export function setAtlasCardEmptyState(isEmpty) {
    const empty = document.getElementById('atlas-empty-cta');
    const shareButton = document.getElementById('atlas-share-map');
    if (empty) empty.classList.toggle('hidden', !isEmpty);
    if (shareButton) shareButton.classList.toggle('hidden', isEmpty);
}

function getPossessiveSuffix(name) {
    return /s$/i.test(name) ? '’' : '’s';
}

export function getAtlasPageTitle(displayName) {
    const name = String(displayName || '').trim() || 'Traveler';
    return `${name}${getPossessiveSuffix(name)} TransitStats`;
}

export function setAtlasDisplayName(displayName) {
    const name = String(displayName || '').trim() || 'Traveler';
    const profileName = document.getElementById('profile-name');
    if (profileName) profileName.textContent = name;

    const titleTail = document.querySelector('.atlas-title-tail');
    if (titleTail) titleTail.textContent = getPossessiveSuffix(name);
}
