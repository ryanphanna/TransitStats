import { PredictionEngine } from './predict.js';
import { auth } from './firebase.js';
import { buildStopIndex, resolveStopLocation } from './atlas-stop-resolver.js';
import { preparePrestoStops, resolvePrestoStopLocation } from './presto-stop-matcher.js';
import { getTripStopLabel } from './trip-display.js';
import { createMapSurface, DEFAULT_MAP_CENTER, DEFAULT_MAP_OVERVIEW_ZOOM } from './map-surface.js';
import {
    addMapPointMarkers,
    fitMapToDensePoints,
    getAtlasMapFitOptions,
} from './map-presentation.js';

function buildMapPointKey(trip, side, resolution, location, fallbackLabel) {
    const code = side === 'boarding' ? trip.startStopCode : trip.endStopCode;
    const identity = resolution?.label || code || fallbackLabel || '';
    const agency = String(trip.agency || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const label = String(identity).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const lat = Number(location.lat).toFixed(4);
    const lng = Number(location.lng).toFixed(4);
    return `${agency}:${label}:${lat}:${lng}`;
}

const MAP_POINTS_CACHE_PREFIX = 'transitstats-map-points:';
const MAP_POINTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getMapMarkerLabel(trip = {}, side = 'boarding', resolution = null) {
    return getTripStopLabel(trip, side, resolution);
}

/**
 * TransitStats V2 Map Engine
 * Handles Leaflet integration and geospatial visualization of trip data.
 */
export const MapEngine = {
    map: null,
    trips: [],
    filter: localStorage.getItem('transitstats-map-stop-mode') === 'exiting' ? 'exiting' : 'boarding',
    layers: {
        base: null,
        transit: null,
        markers: null
    },
    _stopLookup: new Map(),
    _skipLookup: new Set(),
    _hasIndexedStops: false,
    _isFirstLoad: true,
    _renderTimer: null,
    _lastLibSize: 0,
    _stopIndex: new Map(),
    _prestoStops: [],
    _prestoTrips: [],
    _stopSourcesReady: false,
    _canvasRenderer: null,
    _renderGeneration: 0,
    _deferInitialView: false,
    _isDragging: false,
    _renderQueued: false,

    init(initialTrips = [], initialCenter = null, { deferInitialView = false } = {}) {
        console.log("MapEngine.init: Started", { tripsCount: initialTrips.length });
        this.trips = initialTrips;
        this._deferInitialView = deferInitialView;
        if (this.map) {
            console.log("MapEngine.init: Map already exists");
            return;
        }

        const container = document.getElementById('main-map');
        if (!container) {
            console.error("MapEngine: main-map container not found.");
            return;
        }

        // Avoid Leaflet error if container already initialized
        if (container._leaflet_id) {
            console.warn("MapEngine: Leaflet already initialized on this container");
            return;
        }

        console.log("MapEngine: Initializing Leaflet map instance...");

        const center = initialCenter || DEFAULT_MAP_CENTER;

        try {
            const isDark = document.body.classList.contains('dark')
                || document.documentElement.dataset.theme === 'dark';
            const tileTheme = document.body.classList.contains('dashboard-surface')
                ? (isDark ? 'dark_all' : 'light_all')
                : (isDark ? 'dark_nolabels' : 'light_nolabels');
            const surface = createMapSurface({
                containerId: 'main-map',
                center,
                zoom: deferInitialView ? DEFAULT_MAP_OVERVIEW_ZOOM : 13,
                tileTheme,
            });
            this.map = surface.map;
            this.layers.base = surface.base;
            this.layers.markers = surface.markers;
            this._canvasRenderer = surface.renderer;
            this.layers.transit = null;
            this._isDragging = false;
            this._renderQueued = false;
            this.map.on('dragstart', () => {
                this._isDragging = true;
            });
            this.map.on('dragend', () => {
                this._isDragging = false;
                if (!this._renderQueued) return;
                this._renderQueued = false;
                this.renderMarkers();
            });
            console.log("MapEngine: Leaflet map instance created");
            this.renderMarkers();
            this._loadCachedPoints();
            this.setupControls();
            console.log("MapEngine: Setup complete");
        } catch (err) {
            console.error("MapEngine: Failed to initialize Leaflet:", err);
        }
    },

    setupControls() {
        const pills = document.querySelectorAll('.map-controls .pill');
        pills.forEach(pill => {
            pill.addEventListener('click', () => {
                pills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.setFilter(pill.dataset.filter);
            });
        });

    },

    setFilter(filter) {
        this.filter = filter === 'exiting' ? 'exiting' : 'boarding';
        localStorage.setItem('transitstats-map-stop-mode', this.filter);
        this.renderMarkers();
        if (this.trips.length === 0) this._loadCachedPoints();
    },

    _getPointsCacheKey() {
        const userId = window.currentUser?.uid || auth.currentUser?.uid;
        return userId ? `${MAP_POINTS_CACHE_PREFIX}${userId}:${this.filter}` : null;
    },

    _loadCachedPoints() {
        if (!this.map || !this.layers.markers) return false;
        const cacheKey = this._getPointsCacheKey();
        if (!cacheKey) return false;

        try {
            const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (!cached || Date.now() - cached.timestamp > MAP_POINTS_CACHE_TTL_MS
                || !Array.isArray(cached.points) || cached.points.length === 0) return false;
            addMapPointMarkers({
                map: this.map,
                markers: this.layers.markers,
                renderer: this._canvasRenderer,
                points: cached.points,
                getLabel: () => null,
                baseRadius: document.body.classList.contains('v2-clean') ? 4 : 4.5,
            });
            console.log(`MapEngine: Loaded ${cached.points.length} cached markers`);
            return true;
        } catch (error) {
            console.warn('MapEngine: Cached markers unavailable', error);
            return false;
        }
    },

    _cachePoints(points) {
        const cacheKey = this._getPointsCacheKey();
        if (!cacheKey || !points?.length) return;
        try {
            localStorage.setItem(cacheKey, JSON.stringify({
                timestamp: Date.now(),
                points,
            }));
        } catch (error) {
            console.warn('MapEngine: Could not cache markers', error);
        }
    },

    updateTrips(newTrips) {
        this.trips = newTrips;
        if (!this.map) return;

        if (this._deferInitialView && this._isFirstLoad) {
            this._renderQuickSavedMarkers(newTrips);
        }

        if (this._renderTimer) cancelAnimationFrame(this._renderTimer);
        this._renderTimer = requestAnimationFrame(() => {
            this.renderMarkers();
            this._renderTimer = null;
        });
    },

    // Imported PRESTO activity is map-only: it has no duration/route/stats
    // shape, so it stays out of `this.trips` (which feeds the trip feed and
    // stats view) and is rendered as an additional set of points instead.
    updatePrestoTrips(prestoTrips) {
        this._prestoTrips = prestoTrips;
        if (!this.map) return;

        if (this._renderTimer) cancelAnimationFrame(this._renderTimer);
        this._renderTimer = requestAnimationFrame(() => {
            this.renderMarkers();
            this._renderTimer = null;
        });
    },

    _renderQuickSavedMarkers(trips = []) {
        if (!this.map || !this.layers.markers) return;
        const renderId = ++this._renderGeneration;
        const points = [];
        const showExiting = this.filter === 'exiting';

        trips.forEach(trip => {
            const location = showExiting
                ? trip.exitLocation
                : (trip.boardingLocation || trip.boardLocation);
            const lat = Number(location?.lat);
            const lng = Number(location?.lng ?? location?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return;
            points.push({
                lat,
                lng,
                type: showExiting ? 'exiting' : 'boarding',
                label: location?.name || '',
            });
        });

        addMapPointMarkers({
            map: this.map,
            markers: this.layers.markers,
            renderer: this._canvasRenderer,
            points,
            getLabel: () => null,
            baseRadius: 4.5,
        });
    },

    setStopSources({ atlasStops = [], firestoreStops = [] } = {}) {
        PredictionEngine.stopsLibrary = firestoreStops;
        this._stopIndex = buildStopIndex({ atlasStops, normalizedStops: firestoreStops });
        this._prestoStops = preparePrestoStops({ atlasStops, firestoreStops });
        this._stopSourcesReady = true;
        this._skipLookup.clear();
        return this.map ? this.renderMarkers() : Promise.resolve();
    },

    releaseInitialView() {
        this._deferInitialView = false;
        this._isFirstLoad = true;
        return this.map ? this.renderMarkers() : Promise.resolve();
    },

    /**
     * Build an O(1) lookup Map for stop locations from the stopsLibrary.
     * Dramatically improves performance over linear searching.
     */
    _rebuildStopIndex() {
        const lib = PredictionEngine.stopsLibrary;
        if (!lib || lib.length === 0) return;
        
        console.log(`MapEngine: Reindexing ${lib.length} stops...`);
        const start = performance.now();
        this._stopLookup.clear();
        
        lib.forEach(stop => {
            if (!stop.lat || (!stop.lng && !stop.lon)) return;
            const loc = { lat: stop.lat, lng: stop.lng || stop.lon };
            
            // Index by canonical name
            const canon = PredictionEngine._canonicalizeStop(stop.name);
            if (canon) this._stopLookup.set(canon, loc);
            
            // Index by aliases
            if (stop.aliases) {
                stop.aliases.forEach(alias => {
                    const cAlias = PredictionEngine._canonicalizeStop(alias);
                    if (cAlias) this._stopLookup.set(cAlias, loc);
                });
            }

            // Index by code
            if (stop.code) {
                const cCode = PredictionEngine._canonicalizeStop(stop.code);
                if (cCode) this._stopLookup.set(cCode, loc);
            }
        });

        this._hasIndexedStops = true;
        this._lastLibSize = lib.length;
        console.log(`MapEngine: Reindex complete in ${Math.round(performance.now() - start)}ms`);
    },

    _getStopLocation(stopName) {
        if (!stopName) return null;
        
        // Fast skip for known unresolvable stops
        if (this._skipLookup.has(stopName)) return null;

        // Ensure index is ready
        const currentLibSize = PredictionEngine.stopsLibrary?.length || 0;
        if (!this._hasIndexedStops || this._lastLibSize !== currentLibSize) {
            this._rebuildStopIndex();
        }

        const canon = PredictionEngine._canonicalizeStop(stopName);
        const loc = this._stopLookup.get(canon);
        
        if (!loc) {
            this._skipLookup.add(stopName);
            return null;
        }
        return loc;
    },

    _resolveStop(trip, side) {
        if (trip.source === 'presto') {
            const record = side === 'boarding' ? trip.startRecord : trip.endRecord;
            return record
                ? resolvePrestoStopLocation(record, this._prestoStops)
                : { source: 'unresolved', location: null, matchStatus: 'not_applicable', candidates: [] };
        }

        if (this._stopSourcesReady) return resolveStopLocation(trip, side, this._stopIndex);

        const saved = side === 'boarding'
            ? (trip.boardingLocation || trip.boardLocation)
            : trip.exitLocation;
        if (saved && Number.isFinite(Number(saved.lat)) && Number.isFinite(Number(saved.lng ?? saved.lon))) {
            return { location: { lat: Number(saved.lat), lng: Number(saved.lng ?? saved.lon) }, source: 'saved' };
        }

        const stopName = side === 'boarding'
            ? (trip.startStopName || trip.startStop)
            : (trip.endStopName || trip.endStop);
        const location = this._getStopLocation(stopName);
        return { location, source: location ? 'firestore' : 'unresolved' };
    },

    getTripEndpointLocations(trips = this.trips) {
        return trips.map(trip => ({
            trip,
            boarding: this._resolveStop(trip, 'boarding'),
            exiting: this._resolveStop(trip, 'exiting'),
        }));
    },

    _renderDiagnostics(stats, tripCount) {
        const container = document.getElementById('map-diagnostics');
        if (!container) return;
        const totals = ['saved', 'atlas', 'firestore', 'unresolved'].reduce((result, source) => {
            result[source] = stats.boarding[source] + stats.exiting[source];
            return result;
        }, {});
        const resolved = totals.saved + totals.atlas + totals.firestore;
        container.innerHTML = `
            <strong>Stop locations</strong>
            <span><b>${resolved}</b> matched</span>
            <span><b>${totals.atlas}</b> Atlas</span>
            <span><b>${totals.firestore}</b> Firestore fallback</span>
            <span><b>${totals.unresolved}</b> unresolved</span>
            <small>Boarding ${stats.boarding.saved + stats.boarding.atlas + stats.boarding.firestore}/${tripCount} · Exiting ${stats.exiting.saved + stats.exiting.atlas + stats.exiting.firestore}/${tripCount}</small>
        `;
    },

    renderMarkers() {
        if (!this.map || !this.layers.markers) return Promise.resolve();
        if (this._isDragging) {
            this._renderQueued = true;
            return Promise.resolve();
        }
        const renderId = ++this._renderGeneration;
        const renderPromise = this._renderMarkersAsync(renderId);
        renderPromise.catch(error => {
            if (renderId === this._renderGeneration) {
                console.error('MapEngine: Marker render failed:', error);
            }
        });
        return renderPromise;
    },

    async _renderMarkersAsync(renderId) {
        if (renderId !== this._renderGeneration || !this.map || !this.layers.markers) return;

        const start = performance.now();
        // Always check if we need to rebuild the index (e.g. library finished loading)
        const currentLibSize = PredictionEngine.stopsLibrary?.length || 0;
        if (currentLibSize > 0 && (!this._hasIndexedStops || this._lastLibSize !== currentLibSize)) {
            this._rebuildStopIndex();
        }

        const points = [];
        const resolutionStats = {
            boarding: { saved: 0, atlas: 0, firestore: 0, unresolved: 0 },
            exiting: { saved: 0, atlas: 0, firestore: 0, unresolved: 0 },
        };
        const isBoth = this.filter === 'both';
        const showBoarding = this.filter === 'boarding' || isBoth;
        const showExiting = this.filter === 'exiting' || isBoth;

        // The map represents the complete trip history. Repeated trips at the
        // same GTFS stop are collapsed into one point below. Imported PRESTO
        // activity renders alongside logged trips but isn't part of `this.trips`.
        const limitedTrips = [...this.trips, ...this._prestoTrips];

        for (let index = 0; index < limitedTrips.length; index += 1) {
            const trip = limitedTrips[index];
            // Process Boarding
            const boarding = this._resolveStop(trip, 'boarding');
            resolutionStats.boarding[boarding.source] += 1;
            if (showBoarding) {
                const bLoc = boarding.location;
                if (bLoc && bLoc.lat !== 0 && bLoc.lng !== 0 && !isNaN(bLoc.lat)) {
                    points.push({
                        lat: bLoc.lat,
                        lng: bLoc.lng,
                        type: 'boarding',
                        key: buildMapPointKey(trip, 'boarding', boarding, bLoc, getMapMarkerLabel(trip, 'boarding', boarding)),
                        label: getMapMarkerLabel(trip, 'boarding', boarding)
                    });
                }
            }

            // Process Exiting
            const exiting = this._resolveStop(trip, 'exiting');
            resolutionStats.exiting[exiting.source] += 1;
            if (showExiting) {
                const eLoc = exiting.location;
                if (eLoc && eLoc.lat !== 0 && eLoc.lng !== 0 && !isNaN(eLoc.lat)) {
                    points.push({
                        lat: eLoc.lat,
                        lng: eLoc.lng,
                        type: 'exiting',
                        key: buildMapPointKey(trip, 'exiting', exiting, eLoc, getMapMarkerLabel(trip, 'exiting', exiting)),
                        label: getMapMarkerLabel(trip, 'exiting', exiting)
                    });
                }
            }

            // Let the header and navigation respond while a large trip history
            // is being resolved into map points.
            if (index > 0 && index % 200 === 0) {
                await new Promise(resolve => requestAnimationFrame(resolve));
                if (renderId !== this._renderGeneration) return;
            }
        }

        const baseRadius = document.body.classList.contains('v2-clean') ? 4 : 4.5;

        if (renderId !== this._renderGeneration || this._isDragging) {
            if (this._isDragging) this._renderQueued = true;
            return;
        }
        addMapPointMarkers({
            map: this.map,
            markers: this.layers.markers,
            renderer: this._canvasRenderer,
            points,
            getLabel: () => null,
            baseRadius,
        });
        this._cachePoints(points);

        this._renderDiagnostics(resolutionStats, limitedTrips.length);

        // Fit bounds only on first load or when filters change
        // A global history should open on the region with the highest trip
        // density instead of fitting every continent into one unusable view.
        if (this._isFirstLoad && !this._deferInitialView) {
            try {
                const fitOptions = getAtlasMapFitOptions();
                if (fitMapToDensePoints(this.map, points, fitOptions)) this._isFirstLoad = false;
            } catch (err) {
                console.warn("MapEngine: Fit bounds failed", err);
            }
        }
        console.log(`MapEngine: Rendered ${points.length} markers in ${Math.round(performance.now() - start)}ms`);
    },

};
