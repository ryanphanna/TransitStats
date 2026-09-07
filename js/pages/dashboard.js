import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { refreshIcons } from '../shared/icons.js';
import { ModalManager } from '../shared/modal-engine.js';
import { Trips } from '../trips.js';
import { Stats } from '../stats.js';
import { Profile } from '../profile.js';
import { PredictionEngine } from '../predict.js';
import { Utils } from '../utils.js';
import { UI } from '../ui-utils.js';
import { db } from '../firebase.js';
import { MapEngine } from '../map-engine.js';
import { TripController } from '../trips/TripController.js';
import { loadAtlasStops } from '../atlas-stops.js';
import { renderAtlasCard } from '../shared/atlas-card.js';
import { openSettingsPanel } from '../shared/settings-panel.js';

window.Trips = Trips;
window.Utils = Utils;
window.refreshIcons = refreshIcons;

function setupShareMap() {
    const shareButton = document.getElementById('atlas-share-map');
    if (!shareButton) return;

    shareButton.addEventListener('click', async () => {
        const username = Profile.data?.username;
        if (!username || !Profile.data?.isPublic) {
            UI.showNotification(username ? 'Turn on your public profile first.' : 'Set up your public identity first.');
            openSettingsPanel({ tab: 'sharing' });
            return;
        }

        const url = `${window.location.origin}/user/${encodeURIComponent(username)}`;
        if (navigator.share) {
            try {
                await navigator.share({
                    title: `${Profile.getDisplayName() || 'My'} TransitStats map`,
                    url,
                });
                return;
            } catch (error) {
                if (error?.name === 'AbortError') return;
            }
        }

        try {
            if (!navigator.clipboard?.writeText) return;
            await navigator.clipboard.writeText(url);
            UI.showNotification('Map link copied to clipboard.', 'success');
        } catch {
            // Sharing is optional; avoid surfacing a generic failure toast.
        }
    });
}

async function loadDashboardAtlasStops() {
    // Let the map show immediately, then improve its markers with Atlas data.
    const initialRender = MapEngine.releaseInitialView();
    await initialRender;

    const agencies = [...new Set((TripController.allTrips || [])
        .map(trip => String(trip.agency || '').trim())
        .filter(Boolean))];
    if (agencies.length === 0) {
        return;
    }

    try {
        const atlasStops = await loadAtlasStops(agencies);
        await MapEngine.setStopSources({
            atlasStops,
            firestoreStops: PredictionEngine.stopsLibrary || [],
        });
    } catch (error) {
        console.warn('Dashboard: Atlas stop data unavailable', error);
    }
}

async function init() {
    // Keep the page visibly active while Firebase restores a persisted session.
    // The card is replaced with the signed-in content after auth resolves.
    renderAtlasCard({ loading: true });
    if (window.L) {
        MapEngine.init([], null, { deferInitialView: true });
    }

    const { user, isAdmin } = await requireAuth();
    ModalManager.init();

    await Profile.load(user);
    renderAtlasCard({ signedIn: true });
    const profileHref = Profile.data?.isPublic && Profile.data?.username
        ? `/user/${encodeURIComponent(Profile.data.username)}`
        : '';
    initHeader({ isAdmin, currentPage: 'dashboard', profileHref });
    setupShareMap();

    const tripsInitPromise = Trips.init();
    Promise.all([Trips._readyPromise, tripsInitPromise]).then(() => {
        Stats.init();
        loadDashboardAtlasStops();
        Profile.setAgenciesFromTrips(TripController.allTrips || []);
        refreshIcons();
    });

    refreshIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
