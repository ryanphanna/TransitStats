import { db, auth, Timestamp } from '../../js/firebase.js';
import { requireAuth } from '../../js/shared/auth-guard.js';
import { initHeader } from '../../js/shared/header.js';
import { UI } from '../../js/ui-utils.js';

/**
 * Rocket — High-precision transit data collection instrument.
 */

const State = {
    active: false,
    sessionId: null,
    route: '',
    direction: '',
    startStop: '',
    doors: 'CLOSED',
    signal: 'RED',
    motion: 'IDLE',
    events: [],
    startTime: null
};

const DOM = {
    setupView: document.getElementById('setup-view'),
    instrumentView: document.getElementById('instrument-view'),
    btnDoors: document.getElementById('btn-doors'),
    valDoors: document.getElementById('val-doors'),
    btnSignal: document.getElementById('btn-signal'),
    valSignal: document.getElementById('val-signal'),
    btnMotion: document.getElementById('btn-motion'),
    valMotion: document.getElementById('val-motion'),
    btnStart: document.getElementById('btn-start'),
    routeId: document.getElementById('route-id'),
    routeDir: document.getElementById('route-dir'),
    startStop: document.getElementById('start-stop'),
    finalizeBox: document.querySelector('.finalize-box')
};

// --- GPS Management ---
let _lastPosition = null;
let _gpsGranted = false;

function requestGPSPermission() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        (pos) => { _lastPosition = pos; _gpsGranted = true; },
        () => { _gpsGranted = false; },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
}

function getPosition() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => { _lastPosition = pos; resolve(pos); },
            () => resolve(_lastPosition),
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 }
        );
    });
}

// --- Instrument Logic ---
function updateInstrumentUI() {
    DOM.valDoors.textContent = State.doors;
    DOM.btnDoors.className = `control-btn btn-doors ${State.doors.toLowerCase()}`;
    DOM.valSignal.textContent = State.signal;
    DOM.btnSignal.className = `control-btn btn-signal ${State.signal.toLowerCase()}`;
    DOM.valMotion.textContent = State.motion;
    DOM.btnMotion.className = `control-btn btn-motion motion-full ${State.motion.toLowerCase()}`;
}

async function logEvent(type, data = {}) {
    const pos = await getPosition();
    const event = {
        type,
        timestamp: Date.now(),
        location: pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } : null,
        ...data
    };
    State.events.push(event);

    if (State.active && auth.currentUser) {
        await db.collection('rocket_trips').doc(State.sessionId).set({
            userId: auth.currentUser.uid,
            route: State.route,
            direction: State.direction,
            start_stop: State.startStop,
            startTime: Timestamp.fromMillis(State.startTime),
            lastUpdate: Timestamp.now(),
            events: State.events,
            status: 'active'
        }, { merge: true });
    }
}

// --- Session Lifecycle ---
async function startSession() {
    const route = DOM.routeId?.value.trim() || '';
    const direction = DOM.routeDir?.value.trim() || '';
    const startStop = DOM.startStop?.value.trim() || '';

    if (!route || !direction || !startStop) {
        UI.showNotification('Telemetry parameters incomplete. Mission aborted.');
        return;
    }

    State.active = true;
    State.route = route;
    State.direction = direction;
    State.startStop = startStop;
    State.startTime = Date.now();
    const randomBytes = new Uint8Array(4);
    window.crypto.getRandomValues(randomBytes);
    const randomHex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    State.sessionId = `rocket_${Date.now()}_${randomHex}`;
    State.events = [];
    
    await logEvent('SESSION_START', { route, direction, startStop });
    _enterRecordingMode();
}

function _enterRecordingMode() {
    DOM.setupView.style.display = 'none';
    DOM.instrumentView.style.display = 'grid';
    if (DOM.finalizeBox) DOM.finalizeBox.style.display = 'block';
    
    updateInstrumentUI();

    const mainBtn = document.getElementById('main-action');
    if (mainBtn) {
        mainBtn.innerHTML = '<i data-lucide="check-circle" class="icon-inline"></i> <span>FINALIZE RESEARCH</span>';
        if (window.lucide) lucide.createIcons();
    }

    if (window.lucide) lucide.createIcons();
}

async function recoverActiveSession(user) {
    try {
        const snap = await db.collection('rocket_trips')
            .where('userId', '==', user.uid)
            .where('status', '==', 'active')
            .orderBy('startTime', 'desc')
            .limit(1)
            .get();

        if (snap.empty) return false;

        const doc = snap.docs[0];
        const data = doc.data();

        State.active = true;
        State.sessionId = doc.id;
        State.route = data.route;
        State.direction = data.direction;
        State.startStop = data.start_stop;
        State.startTime = data.startTime?.toMillis?.() ?? Date.now();
        State.events = data.events || [];

        // Restore last known instrument state
        const lastDoor = State.events.filter(e => e.type === 'DOOR_CHANGE').pop();
        if (lastDoor) State.doors = lastDoor.value;
        
        const lastSignal = State.events.filter(e => e.type === 'SIGNAL_CHANGE').pop();
        if (lastSignal) State.signal = lastSignal.value;
        
        const lastMotion = State.events.filter(e => e.type === 'MOTION_CHANGE').pop();
        if (lastMotion) State.motion = lastMotion.value;

        _enterRecordingMode();
        UI.showNotification('Telecommunications re-established. Session recovered.');
        return true;
    } catch (e) {
        console.warn('Telemetry recovery failed:', e);
        return false;
    }
}

async function finalizeSession() {
    const endStopInput = document.getElementById('end-stop-input');
    const endStop = endStopInput?.value.trim();
    
    if (!endStop) {
        UI.showNotification('Final destination required for signal closure.');
        endStopInput?.focus();
        return;
    }

    const btn = document.getElementById('main-action');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader" class="icon-inline spin"></i> <span>DOCKING...</span>';
        if (window.lucide) lucide.createIcons();
    }

    try {
        const dwellTotal = State.events.reduce((acc, e, i, arr) => {
            if (e.type === 'DOOR_CHANGE' && e.value === 'OPEN' && arr[i+1]) {
                return acc + (arr[i+1].timestamp - e.timestamp);
            }
            return acc;
        }, 0);

        const stats = { dwell_ms: dwellTotal, event_count: State.events.length };
        await logEvent('SESSION_END', { endStop, ...stats });

        const finalTripId = `trip_${Date.now()}`;
        await db.collection('trips').doc(finalTripId).set({
            userId: auth.currentUser.uid,
            route: State.route,
            direction: State.direction,
            startStop: State.startStop,
            endStop,
            startTime: Timestamp.fromMillis(State.startTime),
            endTime: Timestamp.now(),
            duration: Math.round((Date.now() - State.startTime) / 60000),
            rocketTripId: State.sessionId,
            agency: 'TTC',
            source: 'rocket',
            stats
        });

        await db.collection('rocket_trips').doc(State.sessionId).update({
            status: 'completed',
            finalizeTime: Timestamp.now()
        });

        UI.showNotification('Mission accomplished. Instrumentation cleared.');
        setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
        UI.showNotification('Docking sequence failed: ' + err.message);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="check-circle" class="icon-inline"></i> <span>FINALIZE RESEARCH</span>';
            if (window.lucide) lucide.createIcons();
        }
    }
}

function handleInstrumentUpdate(type) {
    if (!State.active) return;
    if (type === 'doors') {
        State.doors = State.doors === 'CLOSED' ? 'OPEN' : 'CLOSED';
        logEvent('DOOR_CHANGE', { value: State.doors });
    } else if (type === 'signal') {
        State.signal = State.signal === 'RED' ? 'GREEN' : 'RED';
        logEvent('SIGNAL_CHANGE', { value: State.signal });
    } else if (type === 'motion') {
        State.motion = State.motion === 'IDLE' ? 'MOVING' : 'IDLE';
        logEvent('MOTION_CHANGE', { value: State.motion });
    }
    updateInstrumentUI();
}

function setupEventListeners() {
    DOM.btnStart?.addEventListener('click', startSession);
    
    // Instrument Controls
    DOM.btnDoors?.addEventListener('click', () => handleInstrumentUpdate('doors'));
    DOM.btnSignal?.addEventListener('click', () => handleInstrumentUpdate('signal'));
    DOM.btnMotion?.addEventListener('click', () => handleInstrumentUpdate('motion'));

    // Finalize
    document.getElementById('btn-finalize')?.addEventListener('click', finalizeSession);
    
    // Main action button (if different from btnStart)
    document.getElementById('main-action')?.addEventListener('click', () => {
        if (!State.active) startSession();
        else finalizeSession();
    });
}

async function init() {
    const { user } = await requireAuth({ adminOnly: true });
    initHeader({ currentPage: 'rocket' });

    // Request GPS permission upfront so it's granted before recording starts
    requestGPSPermission();

    setupEventListeners();

    // Recover any in-progress session
    await recoverActiveSession(user);

    if (window.lucide) lucide.createIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
