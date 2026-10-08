import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { Profile } from '../profile.js';
import { Stats } from '../stats.js';
import { UI } from '../ui-utils.js';
import { downloadBlob, drawWrappedCard, renderWrappedPngBlob, WRAPPED_CARD } from '../wrapped-card.js';

const monthSelect = document.getElementById('wrapped-month');
const statusEl = document.getElementById('wrapped-status');
const previewCanvas = document.getElementById('wrapped-preview');
const downloadBtn = document.getElementById('wrapped-download');
const shareBtn = document.getElementById('wrapped-share');
const emptyEl = document.getElementById('wrapped-empty');
const stageEl = document.getElementById('wrapped-stage');

let allTrips = [];
let currentWrapped = null;

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

function fillFact(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function renderFacts(wrapped) {
    fillFact('fact-trips', wrapped.trips.toLocaleString('en-US'));
    fillFact('fact-hours', String(wrapped.hours));
    fillFact('fact-days', wrapped.daysRidden.toLocaleString('en-US'));
    fillFact('fact-streak', wrapped.bestStreak.toLocaleString('en-US'));
    fillFact('fact-route', wrapped.topRoute
        ? `${wrapped.topRoute.name} (${wrapped.topRoute.count}×)`
        : '—');
    fillFact('fact-stop', wrapped.favoriteStop?.name || '—');
    fillFact('fact-busiest', wrapped.busiestDay
        ? `${wrapped.busiestDay.label} · ${wrapped.busiestDay.count} trips`
        : '—');
    fillFact('fact-peak', wrapped.peak?.name || '—');
}

function renderPreview(wrapped, displayName) {
    if (!previewCanvas) return;
    const scale = 0.35;
    previewCanvas.width = Math.round(WRAPPED_CARD.width * scale);
    previewCanvas.height = Math.round(WRAPPED_CARD.height * scale);
    const ctx = previewCanvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawWrappedCard(ctx, { displayName, wrapped });
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
    const displayName = Profile.getDisplayName?.(window.currentUser)
        || Profile.data?.displayName
        || 'Traveler';

    if (!wrapped.trips) {
        showEmpty(true);
        setStatus(`No trips in ${wrapped.label}.`);
        return;
    }

    showEmpty(false);
    renderFacts(wrapped);
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
        const displayName = Profile.getDisplayName?.(window.currentUser)
            || Profile.data?.displayName
            || 'Traveler';
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
        const displayName = Profile.getDisplayName?.(window.currentUser)
            || Profile.data?.displayName
            || 'Traveler';
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
    allTrips = trips || [];
    const months = populateMonths(allTrips);
    if (months.length && monthSelect && !monthSelect.value) {
        monthSelect.value = monthKey(months[0]);
    }
    refresh();
}

async function init() {
    const { user, isAdmin } = await requireAuth();
    await Profile.load(user);
    initHeader({ isAdmin, currentPage: 'wrapped' });

    monthSelect?.addEventListener('change', refresh);
    downloadBtn?.addEventListener('click', handleDownload);
    shareBtn?.addEventListener('click', handleShare);

    TripController.listen(user.uid, onTrips);
    await Trips.loadStopsLibrary();
    onTrips(TripController.allTrips);
}

init().catch(error => {
    console.error('Wrapped failed to load:', error);
    setStatus('Wrapped could not load. Return to your dashboard and try again.');
});
