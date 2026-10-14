import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { Profile } from '../profile.js';
import { Stats } from '../stats.js';
import { UI } from '../ui-utils.js';
import { db } from '../firebase.js';
import { buildPrestoTrips, projectPrestoTripsForStats } from '../presto-stop-matcher.js';
import {
    DEFAULT_CONCEPT, WRAPPED_CONCEPTS, downloadBlob, drawWrappedCard, loadConceptFonts, renderWrappedPngBlob, WRAPPED_CARD,
} from '../wrapped-card.js';

const conceptGroup = document.getElementById('wrapped-concept');
// Dev-only sample data: /wrapped?demo=1 skips sign-in. Stripped from production builds.
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
let activeConcept = DEFAULT_CONCEPT;
const monthSelect = document.getElementById('wrapped-month');
const statusEl = document.getElementById('wrapped-status');
const previewCanvas = document.getElementById('wrapped-preview');
const downloadBtn = document.getElementById('wrapped-download');
const shareBtn = document.getElementById('wrapped-share');
const emptyEl = document.getElementById('wrapped-empty');
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

function currentConcept() {
    return activeConcept;
}

function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
}

function monthKey({ year, monthIndex }) {
    return `${year}-${monthIndex}`;
}

function populateMonths(trips) {
    const months = Stats.listAvailableMonths(trips);
    if (!monthSelect) return months;

    monthSelect.replaceChildren();
    if (months.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No trips yet';
        monthSelect.appendChild(option);
        monthSelect.disabled = true;
        return months;
    }

    months.forEach(({ year, monthIndex }) => {
        const option = document.createElement('option');
        option.value = monthKey({ year, monthIndex });
        option.textContent = Stats.formatMonthLabel(year, monthIndex);
        monthSelect.appendChild(option);
    });
    monthSelect.disabled = false;
    return months;
}

function selectedMonth() {
    const value = monthSelect?.value || '';
    const [year, monthIndex] = value.split('-').map(Number);
    if (!Number.isInteger(year) || !Number.isInteger(monthIndex)) return null;
    return { year, monthIndex };
}

function renderPreview(wrapped, displayName) {
    if (!previewCanvas) return;
    const scale = 0.5;
    previewCanvas.width = Math.round(WRAPPED_CARD.width * scale);
    previewCanvas.height = Math.round(WRAPPED_CARD.height * scale);
    const ctx = previewCanvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawWrappedCard(ctx, { displayName, wrapped, concept: currentConcept() });
}

function showEmpty(show) {
    emptyEl?.toggleAttribute('hidden', !show);
    stageEl?.toggleAttribute('hidden', show);
    if (downloadBtn) downloadBtn.disabled = show;
    if (shareBtn) shareBtn.disabled = show;
}

function refresh() {
    const month = selectedMonth();
    if (!month) {
        showEmpty(true);
        setStatus('Log a few trips, then your Wrapped will show up here.');
        currentWrapped = null;
        return;
    }

    const wrapped = Stats.computeWrapped(allTrips, month.year, month.monthIndex);
    currentWrapped = wrapped;
    const displayName = displayNameForCard();

    if (!wrapped.trips) {
        showEmpty(true);
        setStatus(`No trips in ${wrapped.label}.`);
        return;
    }

    showEmpty(false);
    renderPreview(wrapped, displayName);
    setStatus(`${wrapped.label} · ${wrapped.trips} trip${wrapped.trips === 1 ? '' : 's'}`);
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
        const blob = await renderWrappedPngBlob({ displayName, wrapped: currentWrapped, concept: currentConcept() });
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
        const blob = await renderWrappedPngBlob({ displayName, wrapped: currentWrapped, concept: currentConcept() });
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
    const previous = monthSelect?.value;
    const months = populateMonths(allTrips);
    if (months.length && monthSelect) {
        const keepPrevious = months.some(month => monthKey(month) === previous);
        monthSelect.value = keepPrevious ? previous : monthKey(months[0]);
    }
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

    Object.entries(WRAPPED_CONCEPTS).forEach(([key, concept]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wrapped-concept-btn';
        button.dataset.concept = key;
        button.textContent = concept.label;
        button.setAttribute('aria-pressed', String(key === activeConcept));
        button.addEventListener('click', async () => {
            activeConcept = key;
            conceptGroup?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
            await loadConceptFonts(key);
            refresh();
        });
        conceptGroup?.appendChild(button);
    });
    await loadConceptFonts(DEFAULT_CONCEPT);
    monthSelect?.addEventListener('change', refresh);
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
    onTrips(TripController.allTrips);
    // The card is drawn on a canvas, which doesn't wait for web fonts.
    loadConceptFonts(currentConcept()).then(() => currentWrapped && refresh());
}

init().catch(error => {
    console.error('Wrapped failed to load:', error);
    setStatus('Wrapped could not load. Return to your dashboard and try again.');
});
