import { db, firestorePersistenceReady } from './firebase.js';
import { TripController } from './trips/TripController.js';
import { TripStatsView } from './trips/TripStatsView.js';
import { MapEngine } from './map-engine.js';
import { PredictionEngine } from './predict.js';
import { buildPrestoTrips } from './presto-stop-matcher.js';
import { setAtlasCardEmptyState } from './shared/atlas-card.js';

/**
 * TransitStats Trips Orchestrator
 */
export const Trips = {
    _readyPromise: null,
    _resolveReady: null,
    _prestoTrips: [],
    loadError: false,

    async init() {
        this._readyPromise = new Promise(resolve => { this._resolveReady = resolve; });

        // Let Firestore finish opening its local cache before attaching the
        // trip listener, so repeat visits can render cached trips immediately.
        await firestorePersistenceReady;
        
        // Connect to Firestore
        if (window.currentUser) {
            TripController.listen(
                window.currentUser.uid,
                (trips, active) => {
                    this.loadError = false;
                    this.sync(trips, active);
                    if (this._resolveReady) {
                        this._resolveReady();
                        this._resolveReady = null;
                    }
                },
                () => {
                    // A broken listener must not hang dashboard init forever —
                    // downstream setup (Stats, Profile agencies, icons) still
                    // needs to run, just against whatever data is already local.
                    this.loadError = true;
                    this.sync(TripController.allTrips, TripController.activeTrip);
                    if (this._resolveReady) {
                        this._resolveReady();
                        this._resolveReady = null;
                    }
                },
            );
            this._listenPrestoTrips(window.currentUser.uid);
        }

        // Stop metadata is enrichment, not a prerequisite for showing the
        // rider's trips. Let the map render saved coordinates first and load
        // the larger fallback library in the background.
        void this.loadStopsLibrary();
    },

    // Imported PRESTO activity lives in its own collection and has no
    // duration/route/stop shape, so it's kept out of TripController's stream
    // (which the trip feed and richer metrics assume is logged trips) and
    // fed separately into the map and the summary counts in sync().
    _listenPrestoTrips(userId) {
        db.collection('prestoTransactions').where('userId', '==', userId).onSnapshot(
            snap => {
                const records = snap.docs.map(doc => doc.data());
                this._prestoTrips = buildPrestoTrips(records);
                MapEngine.updatePrestoTrips(this._prestoTrips);
                this.sync(TripController.allTrips, TripController.activeTrip);
            },
            err => console.error('PRESTO trips sync failed:', err),
        );
    },

    async loadStopsLibrary() {
        const CACHE_KEY = 'ts_stops_library';
        const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

        try {
            // 1. Try Cache
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const { data, timestamp } = JSON.parse(cached);
                if (Date.now() - timestamp < CACHE_TTL) {
                    console.log(`Loaded ${data.length} stops from cache`);
                    PredictionEngine.stopsLibrary = data;
                    MapEngine.setStopSources({ firestoreStops: data });
                    this.sync(TripController.allTrips, TripController.activeTrip);
                    MapEngine.renderMarkers();
                    return;
                }
            }

            // 2. Fallback to Network
            console.log("Fetching stops library from Firestore...");
            const snap = await db.collection('stops').get();
            const data = snap.docs.map(doc => doc.data());
            
            PredictionEngine.stopsLibrary = data;
            MapEngine.setStopSources({ firestoreStops: data });
            this.sync(TripController.allTrips, TripController.activeTrip);
            MapEngine.renderMarkers();

            // 3. Save to Cache
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                data,
                timestamp: Date.now()
            }));
        } catch (err) {
            console.error("Library sync failed:", err);
        }
    },

    /**
     * Primary Sync Loop - Re-renders all dependent views when data changes
     */
    sync(trips, active) {
        // Render Analytics
        TripStatsView.render(trips, this._prestoTrips);

        // Update Global Map
        MapEngine.updateTrips(trips);

        // A load error must never be mistaken for "no rides yet" — the CTA
        // stays hidden whenever the trip listener is broken.
        const isEmpty = trips.length === 0 && this._prestoTrips.length === 0;
        // /import is limited to admins and the PRESTO pilot, so only they get the CTA.
        const canImport = window.isAdmin === true || window.userPilot === 'presto';
        setAtlasCardEmptyState(isEmpty && !this.loadError && canImport);
    },
};
