import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { PredictionEngine } from '../predict.js';
import { MapEngine } from '../map-engine.js';
import { loadAtlasStops } from '../atlas-stops.js';
import { loadAtlasRoutes } from '../atlas-routes.js';
import { fitMapToDensePoints } from '../map-presentation.js';
import { getTripRouteLabel, getTripStopLabel } from '../trip-display.js';
import {
    buildCorridorPopup,
    clipTripToRoute,
    getCorridorStyle,
    getDensestCorridorViewport,
    routeMatches,
} from '../route-heatmap.js';

const status = document.getElementById('route-heatmap-status');
const corridorLayer = L.layerGroup();
let routeFeatures = [];
let hasFitToCorridors = false;

function setStatus(message) {
    if (status) status.textContent = message;
}

function renderCorridors(trips) {
    if (!MapEngine.map) return;
    const endpoints = MapEngine.getTripEndpointLocations(trips);
    corridorLayer.clearLayers();
    const clipped = new Map();
    endpoints.forEach(({ trip, boarding, exiting }) => {
        const start = boarding?.location;
        const end = exiting?.location;
        if (!start || !end) return;
        routeFeatures
            .filter(feature => feature.__agency === trip.agency)
            .filter(feature => routeMatches(feature.properties?.routeShortName || feature.properties?.routeId, trip.route))
            .map(feature => ({ feature, line: clipTripToRoute(feature, trip, start, end) }))
            .filter(candidate => candidate.line)
            .slice(0, 1)
            .forEach(({ feature, line }) => {
                const key = [routeFeatures.indexOf(feature), trip.startStopCode || '', trip.endStopCode || ''].join(':');
                const existing = clipped.get(key);
                if (existing) existing.count += 1;
                else clipped.set(key, {
                    line,
                    count: 1,
                    start,
                    end,
                    agency: feature.__agency || trip.agency,
                    route: feature.properties?.routeShortName || getTripRouteLabel(trip),
                    startLabel: getTripStopLabel(trip, 'boarding', boarding),
                    endLabel: getTripStopLabel(trip, 'exiting', exiting),
                });
            });
    });
    const maxCount = Math.max(1, ...[...clipped.values()].map(item => item.count));
    clipped.forEach(corridor => {
        const layer = L.polyline(corridor.line, {
            ...getCorridorStyle(corridor.count, maxCount),
            interactive: true,
            lineCap: 'round',
            lineJoin: 'round',
        });
        layer.bindPopup(buildCorridorPopup(corridor));
        layer.addTo(corridorLayer);
    });
    const completeTrips = [...clipped.values()].reduce((total, corridor) => total + corridor.count, 0);
    setStatus(`${clipped.size} corridors · ${completeTrips} trips with verified route paths`);

    if (!hasFitToCorridors && clipped.size > 0) {
        const viewportPoints = [...clipped.values()].flatMap(({ start, end, count }) => [
            { ...start, usage: count },
            { ...end, usage: count },
        ]);
        hasFitToCorridors = fitMapToDensePoints(
            MapEngine.map,
            getDensestCorridorViewport(viewportPoints),
            { maxZoom: 12 },
        );
    }
}

async function init() {
    MapEngine.init([], null, { deferInitialView: true });
    // This surface is a corridor heatmap, not a stop map. Keep the dashboard's
    // stop markers intact while hiding them here so route colour stays legible.
    MapEngine.layers.markers.remove();
    corridorLayer.addTo(MapEngine.map);
    const { user, isAdmin } = await requireAuth();
    initHeader({ isAdmin, currentPage: 'route-heatmap' });

    TripController.listen(user.uid, trips => {
        MapEngine.updateTrips(trips);
        renderCorridors(trips);
        loadAtlasRoutes(trips).then(features => {
            routeFeatures = features;
            renderCorridors(trips);
        }).catch(error => {
            console.warn('Route geometry unavailable:', error);
            setStatus('Route geometry unavailable; no corridors drawn.');
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
        setStatus('Using saved stop locations; some corridors may be incomplete.');
    }
    // The stop layer is hidden on this surface, so do not release its
    // dashboard-style auto-fit. The corridor layer performs the single
    // initial fit once route geometry is ready.
    renderCorridors(TripController.allTrips);
}

init().catch(error => {
    console.error('Route heatmap failed to load:', error);
    setStatus('The corridor map could not load. Return to your dashboard and try again.');
});
