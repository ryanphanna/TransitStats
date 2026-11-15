import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { PredictionEngine } from '../predict.js';
import { MapEngine } from '../map-engine.js';
import { loadAtlasStops } from '../atlas-stops.js';
import { loadAgencyRouteList, loadAgencyRouteShapes, loadAtlasRoutes } from '../atlas-routes.js';
import { fitMapToDensePoints } from '../map-presentation.js';
import { getTripRouteLabel, getTripStopLabel } from '../trip-display.js';
import {
    buildCorridorPopup,
    clipTripToRoute,
    countRiddenRoutes,
    formatRiddenHeadline,
    getCorridorStyle,
    getDensestCorridorViewport,
    pickRiddenAgency,
    routeMatches,
} from '../route-heatmap.js';
import { tripAgency } from '../shared/trip-stats.js';

const status = document.getElementById('route-heatmap-status');
const intro = document.getElementById('route-heatmap-intro');
const viewButtons = [...document.querySelectorAll('[data-route-heatmap-view]')];
const INTRO_TEXT = intro?.textContent || '';
const corridorLayer = L.layerGroup();
const networkLayer = L.layerGroup();
let routeFeatures = [];
let hasFitToCorridors = false;
let hasFitToRidden = false;
let currentView = new URLSearchParams(location.search).get('view') === 'ridden' ? 'ridden' : 'trips';
// Ridden view: every route of one agency, loaded once on first open.
let ridden = null;
let riddenRequest = null;

function setStatus(message) {
    if (status) status.textContent = message;
}

function drawCorridors(trips, features) {
    const endpoints = MapEngine.getTripEndpointLocations(trips);
    corridorLayer.clearLayers();
    const clipped = new Map();
    endpoints.forEach(({ trip, boarding, exiting }) => {
        const start = boarding?.location;
        const end = exiting?.location;
        if (!start || !end) return;
        // Only admins ever get a guessed exit; it is drawn dashed and kept
        // out of the trip count so it never reads as a real ride.
        const estimated = exiting.estimated === true;
        features
            .filter(feature => feature.__agency === trip.agency)
            .filter(feature => routeMatches(feature.properties?.routeShortName || feature.properties?.routeId, trip.route))
            .map(feature => ({ feature, line: clipTripToRoute(feature, trip, start, end) }))
            .filter(candidate => candidate.line)
            .slice(0, 1)
            .forEach(({ feature, line }) => {
                const key = [estimated ? 'estimated' : 'recorded', features.indexOf(feature), trip.startStopCode || '', trip.endStopCode || '', estimated ? exiting.label || '' : ''].join(':');
                const existing = clipped.get(key);
                if (existing) existing.count += 1;
                else clipped.set(key, {
                    line,
                    count: 1,
                    start,
                    end,
                    estimated,
                    agency: feature.__agency || trip.agency,
                    route: feature.properties?.routeShortName || getTripRouteLabel(trip),
                    startLabel: getTripStopLabel(trip, 'boarding', boarding),
                    endLabel: getTripStopLabel(trip, 'exiting', exiting),
                });
            });
    });
    const maxCount = Math.max(1, ...[...clipped.values()].filter(item => !item.estimated).map(item => item.count));
    clipped.forEach(corridor => {
        const layer = L.polyline(corridor.line, {
            ...getCorridorStyle(corridor.count, maxCount, { estimated: corridor.estimated }),
            interactive: true,
            lineCap: 'round',
            lineJoin: 'round',
        });
        layer.bindPopup(buildCorridorPopup(corridor));
        layer.addTo(corridorLayer);
    });
    return clipped;
}

function fitToCorridors(clipped) {
    if (clipped.size === 0) return false;
    const viewportPoints = [...clipped.values()].filter(corridor => !corridor.estimated).flatMap(({ start, end, count }) => [
        { ...start, usage: count },
        { ...end, usage: count },
    ]);
    return fitMapToDensePoints(
        MapEngine.map,
        getDensestCorridorViewport(viewportPoints),
        { maxZoom: 12 },
    );
}

function renderCorridors(trips) {
    if (!MapEngine.map || currentView !== 'trips') return;
    const clipped = drawCorridors(trips, routeFeatures);
    const completeTrips = [...clipped.values()]
        .filter(corridor => !corridor.estimated)
        .reduce((total, corridor) => total + corridor.count, 0);
    const estimatedTrips = [...clipped.values()]
        .filter(corridor => corridor.estimated)
        .reduce((total, corridor) => total + corridor.count, 0);
    setStatus(estimatedTrips > 0
        ? `${completeTrips} trips shown, plus ${estimatedTrips} with an estimated exit (dashed)`
        : `${completeTrips} trips shown`);

    if (!hasFitToCorridors) hasFitToCorridors = fitToCorridors(clipped);
}

function loadRiddenRoutes(agency) {
    if (ridden?.agency === agency) return Promise.resolve(ridden);
    if (riddenRequest?.agency === agency) return riddenRequest.promise;
    const promise = (async () => {
        const routes = await loadAgencyRouteList(agency);
        const names = [...new Set(routes.map(route => String(route.routeShortName || '').trim()).filter(Boolean))];
        const features = await loadAgencyRouteShapes(agency, names);
        ridden = { agency, routes, features };
        return ridden;
    })();
    riddenRequest = { agency, promise };
    promise.catch(() => { riddenRequest = null; });
    return promise;
}

function renderRidden(trips) {
    if (!MapEngine.map || currentView !== 'ridden') return;
    const agency = pickRiddenAgency(trips);
    if (!agency) {
        networkLayer.clearLayers();
        corridorLayer.clearLayers();
        setStatus('No trips yet, so no routes ridden.');
        return;
    }
    if (ridden?.agency !== agency) {
        networkLayer.clearLayers();
        corridorLayer.clearLayers();
        setStatus(`Loading ${agency} routes…`);
        loadRiddenRoutes(agency)
            .then(() => renderRidden(TripController.allTrips))
            .catch(error => {
                console.warn('Ridden routes unavailable:', error);
                if (currentView === 'ridden') setStatus(`${agency} routes are unavailable right now.`);
            });
        return;
    }

    if (intro) intro.textContent = `Every ${agency} route in grey, with the parts you have ridden in colour.`;
    const grey = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#748784';
    networkLayer.clearLayers();
    L.geoJSON({ type: 'FeatureCollection', features: ridden.features }, {
        interactive: false,
        // Atlas has several shapes per route (directions, days), so the grey is
        // drawn fully opaque; see-through lines would stack darker where they overlap.
        style: { color: grey, weight: 1.5, opacity: 1 },
    }).addTo(networkLayer);

    // Trips are compared by canonical agency so "ttc" and "TTC" both draw.
    const agencyTrips = trips
        .filter(trip => tripAgency(trip) === agency)
        .map(trip => ({ ...trip, agency }));
    const clipped = drawCorridors(agencyTrips, ridden.features);
    setStatus(formatRiddenHeadline({ ...countRiddenRoutes(ridden.routes, trips, agency), agency }));

    if (!hasFitToRidden) {
        hasFitToRidden = fitToCorridors(clipped);
        if (!hasFitToRidden) {
            const bounds = L.geoJSON({ type: 'FeatureCollection', features: ridden.features }).getBounds();
            if (bounds.isValid()) {
                MapEngine.map.fitBounds(bounds, { maxZoom: 12 });
                hasFitToRidden = true;
            }
        }
    }
}

function render(trips) {
    if (currentView === 'ridden') renderRidden(trips);
    else renderCorridors(trips);
}

function syncViewControls() {
    viewButtons.forEach(button => {
        const active = button.dataset.routeHeatmapView === currentView;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function setView(view) {
    currentView = view === 'ridden' ? 'ridden' : 'trips';
    syncViewControls();
    const params = new URLSearchParams(location.search);
    if (currentView === 'ridden') params.set('view', 'ridden');
    else params.delete('view');
    const query = params.toString();
    history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash);

    corridorLayer.clearLayers();
    networkLayer.clearLayers();
    if (currentView === 'trips' && intro) intro.textContent = INTRO_TEXT;
    render(TripController.allTrips);
}

async function init() {
    MapEngine.init([], null, { deferInitialView: true });
    // This surface is a corridor heatmap, not a stop map. Keep the dashboard's
    // stop markers intact while hiding them here so route colour stays legible.
    MapEngine.layers.markers.remove();
    networkLayer.addTo(MapEngine.map);
    corridorLayer.addTo(MapEngine.map);
    syncViewControls();
    viewButtons.forEach(button => button.addEventListener('click', () => setView(button.dataset.routeHeatmapView)));
    const { user, isAdmin } = await requireAuth();
    // Exit guesses for trips with no exit recorded are admin-only.
    MapEngine.setShowEstimatedExits(isAdmin === true);
    initHeader({ currentPage: 'route-heatmap', showRecap: true });

    TripController.listen(user.uid, trips => {
        MapEngine.updateTrips(trips);
        render(trips);
        loadAtlasRoutes(trips).then(features => {
            routeFeatures = features;
            renderCorridors(trips);
        }).catch(error => {
            console.warn('Route geometry unavailable:', error);
            if (currentView === 'trips') setStatus('Trip lines unavailable; nothing to draw.');
        });
    });

    await Trips.loadStopsLibrary();
    const agencies = TripController.allTrips.map(trip => trip.agency).filter(Boolean);
    try {
        const atlasStops = await loadAtlasStops(agencies);
        await MapEngine.setStopSources({ atlasStops, firestoreStops: PredictionEngine.stopsLibrary || [] });
    } catch (error) {
        console.warn('Route heatmap stop enrichment failed:', error);
        await MapEngine.setStopSources({ firestoreStops: PredictionEngine.stopsLibrary || [] });
        if (currentView === 'trips') setStatus('Using saved stop locations; some trip lines may be missing.');
    }
    // The stop layer is hidden on this surface, so do not release its
    // dashboard-style auto-fit. The corridor layer performs the single
    // initial fit once route geometry is ready.
    render(TripController.allTrips);
}

init().catch(error => {
    console.error('Route heatmap failed to load:', error);
    setStatus('Your trip map could not load. Return to your dashboard and try again.');
});
