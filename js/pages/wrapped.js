import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { Profile } from '../profile.js';
import { Stats } from '../stats.js';
import { UI } from '../ui-utils.js';
import { db } from '../firebase.js';
import { buildPrestoTrips, projectPrestoTripsForStats } from '../presto-stop-matcher.js';
import { downloadBlob, drawWrappedCard, loadCardFonts, renderWrappedPngBlob, WRAPPED_CARD } from '../wrapped-card.js';

// Dev-only sample data: /wrapped?demo=1 skips sign-in. Stripped from production builds.
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
const statusEl = document.getElementById('wrapped-status');
const previewCanvas = document.getElementById('wrapped-preview');
const downloadBtn = document.getElementById('wrapped-download');
const shareBtn = document.getElementById('wrapped-share');
const stageEl = document.getElementById('wrapped-stage');

// Imported PRESTO rides count toward Wrapped like they do on the dashboard totals.
// Set to false to use logged trips only.
const INCLUDE_PRESTO_TRIPS = true;

let loggedTrips = [];
let prestoRides = [];
let allTrips = [];
let currentWrapped = null;

function displayNameForCard() {
    if (DEMO) return 'Ryan';
    return Profile.getDisplayName?.(window.currentUser) || Profile.data?.displayName || 'Traveler';
}

function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
}

// Wrapped always shows last calendar month, like a transfer that expires.
// Dev-only override for checking other months: /wrapped?demo=1&month=2026-08
function targetMonth() {
    const override = DEMO ? new URLSearchParams(location.search).get('month') : null;
    const match = override && /^(\d{4})-(\d{1,2})$/.exec(override);
    if (match) return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
    return Stats.previousMonth();
}

function renderPreview(wrapped, displayName) {
    if (!previewCanvas) return;
    const scale = 0.5;
    previewCanvas.width = Math.round(WRAPPED_CARD.width * scale);
    previewCanvas.height = Math.round(WRAPPED_CARD.height * scale);
    const ctx = previewCanvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawWrappedCard(ctx, { displayName, wrapped });
}

function refresh() {
    const month = targetMonth();
    const wrapped = Stats.computeWrapped(allTrips, month.year, month.monthIndex);
    currentWrapped = wrapped;
    renderPreview(wrapped, displayNameForCard());
    stageEl?.removeAttribute('hidden');

    const hasRides = wrapped.trips > 0;
    if (downloadBtn) downloadBtn.disabled = !hasRides;
    if (shareBtn) shareBtn.disabled = !hasRides;
    setStatus(hasRides
        ? `${wrapped.label} · ${wrapped.trips} ${wrapped.trips === 1 ? 'ride' : 'rides'}`
        : `No transfer issued for ${Stats.formatMonthLabel(month.year, month.monthIndex, { style: 'long' }).replace(/\s\d{4}$/, '')}.`);
}

function fileStem(wrapped) {
    const month = String(wrapped.monthIndex + 1).padStart(2, '0');
    return `transit-wrapped-${wrapped.year}-${month}`;
}

async function handleDownload() {
    if (!currentWrapped?.trips) return;
    try {
        downloadBtn.disabled = true;
        const displayName = displayNameForCard();
        const blob = await renderWrappedPngBlob({ displayName, wrapped: currentWrapped });
        downloadBlob(blob, `${fileStem(currentWrapped)}.png`);
        UI.showNotification('Wrapped card downloaded.', 'success');
    } catch (error) {
        console.error(error);
        UI.showNotification('Could not download your Wrapped card.');
    } finally {
        downloadBtn.disabled = false;
    }
}

async function handleShare() {
    if (!currentWrapped?.trips) return;
    try {
        shareBtn.disabled = true;
        const displayName = displayNameForCard();
        const blob = await renderWrappedPngBlob({ displayName, wrapped: currentWrapped });
        const file = new File([blob], `${fileStem(currentWrapped)}.png`, { type: 'image/png' });
        const shareData = {
            title: `Transit Wrapped · ${currentWrapped.label}`,
            text: `My ${currentWrapped.label} on TransitStats — ${currentWrapped.trips} trips.`,
            files: [file],
        };

        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share(shareData);
            return;
        }
        if (navigator.share) {
            await navigator.share({ title: shareData.title, text: shareData.text });
            return;
        }
        await handleDownload();
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error(error);
        UI.showNotification('Could not share your Wrapped card.');
    } finally {
        shareBtn.disabled = false;
    }
}

function onTrips(trips) {
    loggedTrips = trips || [];
    rebuildTrips();
}

function rebuildTrips() {
    allTrips = INCLUDE_PRESTO_TRIPS
        ? Stats.mergeImportedRides(loggedTrips, prestoRides)
        : [...loggedTrips];
    refresh();
}

async function init() {
    let user = null;
    if (!DEMO) {
        const auth = await requireAuth();
        user = auth.user;
        await Profile.load(user);
        initHeader({ isAdmin: auth.isAdmin, currentPage: 'wrapped' });
    }

    await loadCardFonts();
    downloadBtn?.addEventListener('click', handleDownload);
    shareBtn?.addEventListener('click', handleShare);

    if (DEMO) {
        const demo = await import('../wrapped/demo-data.js');
        prestoRides = demo.demoPrestoRides();
        onTrips(demo.demoTrips());
        return;
    }

    TripController.listen(user.uid, onTrips);
    if (INCLUDE_PRESTO_TRIPS) {
        db.collection('prestoTransactions').where('userId', '==', user.uid).onSnapshot(
            snap => {
                prestoRides = projectPrestoTripsForStats(buildPrestoTrips(snap.docs.map(doc => doc.data())));
                rebuildTrips();
            },
            err => console.error('PRESTO rides failed to load:', err),
        );
    }
    await Trips.loadStopsLibrary();
    // Cached trips only; an empty list may just mean the first snapshot hasn't arrived.
    if (TripController.allTrips?.length) onTrips(TripController.allTrips);
    // The card is drawn on a canvas, which doesn't wait for web fonts.
    loadCardFonts().then(() => currentWrapped && refresh());
}

init().catch(error => {
    console.error('Wrapped failed to load:', error);
    setStatus('Wrapped could not load. Return to your dashboard and try again.');
});
