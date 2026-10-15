import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/firebase.js', () => ({ auth: { currentUser: null }, db: {} }));

const { MapEngine } = await import('../js/map-engine.js');

const atlasStops = [
    { agency: 'TTC', code: '1', name: 'Union Station', lat: 43.645, lng: -79.38 },
    { agency: 'TTC', code: '2', name: 'College Station', lat: 43.66, lng: -79.38 },
];

const forgotTrip = {
    agency: 'TTC',
    startStopName: 'Union Station',
    incomplete: true,
    endStopPrediction: { stop: 'College Station', confidence: 95 },
};

const completeTrip = {
    agency: 'TTC',
    startStopName: 'Union Station',
    endStopName: 'College Station',
};

describe('MapEngine estimated exits', () => {
    beforeEach(async () => {
        MapEngine.map = null;
        MapEngine._showEstimatedExits = false;
        await MapEngine.setStopSources({ atlasStops, firestoreStops: [] });
    });

    it('gives non-admins no exit for a trip with no exit recorded', () => {
        const [endpoints] = MapEngine.getTripEndpointLocations([forgotTrip]);
        expect(endpoints.exiting).toEqual({ source: 'unresolved', location: null });
        expect(endpoints.boarding.location).toEqual({ lat: 43.645, lng: -79.38 });
    });

    it('gives admins the guessed exit flagged as estimated', async () => {
        await MapEngine.setShowEstimatedExits(true);
        const [endpoints] = MapEngine.getTripEndpointLocations([forgotTrip]);
        expect(endpoints.exiting.match).toBe('prediction-gtfs');
        expect(endpoints.exiting.estimated).toBe(true);
        expect(endpoints.exiting.location).toEqual({ lat: 43.66, lng: -79.38 });
    });

    it('leaves real exits unchanged for both', async () => {
        const [nonAdmin] = MapEngine.getTripEndpointLocations([completeTrip]);
        await MapEngine.setShowEstimatedExits(true);
        const [admin] = MapEngine.getTripEndpointLocations([completeTrip]);
        expect(admin.exiting).toEqual(nonAdmin.exiting);
        expect(admin.exiting.estimated).toBeUndefined();
        expect(admin.exiting.location).toEqual({ lat: 43.66, lng: -79.38 });
    });
});

describe('MapEngine point cache', () => {
    it('ignores and removes caches saved before guessed exits became admin-only', () => {
        window.currentUser = { uid: 'user_1' };
        const legacyKey = 'transitstats-map-points:user_1:exiting';
        localStorage.setItem(legacyKey, JSON.stringify({
            timestamp: Date.now(),
            points: [{ lat: 43.66, lng: -79.38, type: 'exiting', label: 'Guessed stop' }],
        }));
        MapEngine.map = {};
        MapEngine.layers.markers = { clearLayers: vi.fn(), addLayer: vi.fn() };
        MapEngine.filter = 'exiting';

        expect(MapEngine._getPointsCacheKey()).not.toBe(legacyKey);
        expect(MapEngine._loadCachedPoints()).toBe(false);
        expect(localStorage.getItem(legacyKey)).toBeNull();

        MapEngine.map = null;
        MapEngine.layers.markers = null;
        delete window.currentUser;
    });
});
