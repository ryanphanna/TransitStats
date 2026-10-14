import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { Profile } from '../profile.js';
import { Stats } from '../stats.js';
import { UI } from '../ui-utils.js';
import { db } from '../firebase.js';
import { buildPrestoTrips, projectPrestoTripsForStats } from '../presto-stop-matcher.js';
import { downloadBlob, drawWrappedCard, loadCardFonts, renderWrappedPngBlob, TICKET_RECT } from '../wrapped-card.js';

// Dev-only sample data: /wrapped?demo=1 skips sign-in. Stripped from production builds.
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');
const statusEl = document.getElementById('wrapped-status');
const previewCanvas = document.getElementById('wrapped-preview');
const downloadBtn = document.getElementById('wrapped-download');
const shareBtn = document.getElementById('wrapped-share');
const printBtn = document.getElementById('wrapped-print');
const actionsEl = document.getElementById('wrapped-actions');
const reprintBtn = document.getElementById('wrapped-reprint');
const stageEl = document.getElementById('wrapped-stage');
const printerEl = document.querySelector('.wrapped-printer');

// Imported PRESTO rides count toward Wrapped like they do on the dashboard totals.
// Set to false to use logged trips only.
const INCLUDE_PRESTO_TRIPS = true;

let loggedTrips = [];
let prestoRides = [];
let allTrips = [];
let currentWrapped = null;
let printed = false;
let printing = null;

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

// The preview shows just the paper (cropped from the 1080x1920 card); the red field is the page.
function renderPreview(wrapped, displayName, anim = null) {
    if (!previewCanvas) return;
    const scale = 0.5;
    previewCanvas.width = Math.round(TICKET_RECT.w * scale);
    previewCanvas.height = Math.round(TICKET_RECT.h * scale);
    const ctx = previewCanvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, -TICKET_RECT.x * scale, -TICKET_RECT.y * scale);
    drawWrappedCard(ctx, { displayName, wrapped, anim });
}

// Print animation (on-page only; the exported PNG is always the finished card):
// the ticket feeds out of the slot in short printer jerks, the days punch in order,
// then the stamp thumps down.
const FEED_MS = 1200;
const PUNCH_START = 1250;
const PUNCH_MS = 650;
const STAMP_START = 1950;
const STAMP_MS = 420;
let printRun = 0;
let feedAnimation = null;

function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function playPrint(wrapped, displayName) {
    const run = ++printRun;
    previewCanvas.style.visibility = 'visible';
    feedAnimation?.cancel();
    printerEl?.classList.remove('is-printing');
    if (prefersReducedMotion() || !previewCanvas?.animate) {
        renderPreview(wrapped, displayName);
        return Promise.resolve();
    }
    printerEl?.classList.add('is-printing');

    // Stepped feed: a quick move, then a short hold, like a ticket printer advancing.
    const stops = [0.14, 0.3, 0.45, 0.6, 0.74, 0.86, 0.95, 1];
    const cycle = FEED_MS / stops.length;
    const at = progress => `translateY(${(progress - 1) * 100}%)`;
    const frames = [{ transform: at(0), offset: 0 }];
    stops.forEach((progress, k) => {
        frames.push({ transform: at(progress), offset: (k * cycle + cycle * 0.38) / FEED_MS, easing: 'ease-out' });
        frames.push({ transform: at(progress), offset: ((k + 1) * cycle) / FEED_MS });
    });
    feedAnimation = previewCanvas.animate(frames, { duration: FEED_MS, fill: 'backwards' });

    const ridden = wrapped.dayCounts.filter(count => count > 0).length;
    const start = performance.now();
    const total = STAMP_START + STAMP_MS;
    return new Promise(resolve => {
    const frame = now => {
        if (run !== printRun) {
            resolve();
            return;
        }
        const elapsed = now - start;
        if (elapsed >= total) {
            renderPreview(wrapped, displayName);
            printerEl?.classList.remove('is-printing');
            resolve();
            return;
        }
        const punchProgress = Math.min(1, Math.max(0, (elapsed - PUNCH_START) / PUNCH_MS));
        const stamp = Math.min(1, Math.max(0, (elapsed - STAMP_START) / STAMP_MS));
        renderPreview(wrapped, displayName, { punches: punchProgress * ridden, stamp });
        requestAnimationFrame(frame);
    };
    renderPreview(wrapped, displayName, { punches: 0, stamp: 0 });
    requestAnimationFrame(frame);
    });
}

// The ticket is only printed when someone presses "Print transfer"; it then stays out.
async function startPrint() {
    if (printing || !currentWrapped?.trips) return;
    printing = playPrint(currentWrapped, displayNameForCard());
    showButtons();
    await printing;
    printing = null;
    printed = true;
    showButtons();
}

// One fixed-size button row: Print fills it, then splits into Download and Share in place.
function showButtons() {
    const hasRides = currentWrapped?.trips > 0;
    let state = 'none';
    if (hasRides) state = printed ? 'ready' : (printing ? 'printing' : 'print');
    actionsEl.dataset.state = state;
    if (state === 'print' || state === 'printing') {
        printBtn.textContent = state === 'printing' ? 'Printing…' : 'Print transfer';
        printBtn.disabled = state === 'printing';
    }
    const ready = state === 'ready';
    downloadBtn.tabIndex = ready ? 0 : -1;
    shareBtn.tabIndex = ready ? 0 : -1;
    reprintBtn.classList.toggle('is-visible', ready);
    reprintBtn.tabIndex = ready ? 0 : -1;
    reprintBtn.disabled = !!printing;
}

// "Download by Oct 31": the last day of this month, when the card switches to the next month.
function showDeadline() {
    const el = document.getElementById('wrapped-deadline');
    if (!el) return;
    const end = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
    el.textContent = `Download by ${end.toLocaleString('en-US', { month: 'short' })} ${end.getDate()}.`;
}

function refresh() {
    showDeadline();
    const month = targetMonth();
    const wrapped = Stats.computeWrapped(allTrips, month.year, month.monthIndex);
    currentWrapped = wrapped;
    const hasRides = wrapped.trips > 0;
    stageEl?.removeAttribute('hidden');
    if (!hasRides) {
        // Nothing to print: show the "no transfer issued" ticket straight away.
        printed = false;
        printRun++;
        printerEl?.classList.remove('is-printing');
        previewCanvas.style.visibility = 'visible';
        renderPreview(wrapped, displayNameForCard());
    } else if (printed && !printing) {
        renderPreview(wrapped, displayNameForCard());
    } else if (!printing) {
        // Empty slot until the user asks for the ticket.
        previewCanvas.style.visibility = 'hidden';
    }

    showButtons();
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
        shareBtn.disabled = true;
        const displayName = displayNameForCard();
        const blob = await renderWrappedPngBlob({ displayName, wrapped: currentWrapped });
        downloadBlob(blob, `${fileStem(currentWrapped)}.png`);
        UI.showNotification('Wrapped card downloaded.', 'success');
    } catch (error) {
        console.error(error);
        UI.showNotification('Could not download your Wrapped card.');
    } finally {
        downloadBtn.disabled = false;
        shareBtn.disabled = false;
    }
}

async function handleShare() {
    if (!currentWrapped?.trips) return;
    try {
        shareBtn.disabled = true;
        downloadBtn.disabled = true;
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
        if (error?.name === 'NotAllowedError') {
            // The browser can refuse to share once the print animation has used up the click's permission.
            await handleDownload();
            return;
        }
        console.error(error);
        UI.showNotification('Could not share your Wrapped card.');
    } finally {
        shareBtn.disabled = false;
        downloadBtn.disabled = false;
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
    printBtn?.addEventListener('click', startPrint);
    reprintBtn?.addEventListener('click', startPrint);

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
