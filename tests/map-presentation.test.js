import { describe, expect, it } from 'vitest';
import {
    addZoomGatedPopup,
    clusterMapPoints,
    formatStopPopup,
    getUsageMarkerStyle,
    groupMapPoints,
} from '../js/map-presentation.js';

describe('groupMapPoints', () => {
    it('groups nearby saved coordinates into one weighted stop marker', () => {
        const grouped = groupMapPoints([
            { lat: 43.65321, lng: -79.38320, type: 'boarding', label: 'Union Station' },
            { lat: 43.65324, lng: -79.38318, type: 'boarding', label: 'Union Station' },
        ]);

        expect(grouped).toHaveLength(1);
        expect(grouped[0].usage).toBe(2);
    });

    it('keeps explicitly different stop identities separate', () => {
        const grouped = groupMapPoints([
            { lat: 43.65321, lng: -79.38320, type: 'boarding', key: 'ttc:union:43.6532:-79.3832' },
            { lat: 43.65321, lng: -79.38320, type: 'boarding', key: 'ttc:union-platform-2:43.6532:-79.3832' },
        ]);

        expect(grouped).toHaveLength(2);
    });
});

describe('getUsageMarkerStyle', () => {
    it('makes more-used stops darker without changing their size', () => {
        const lowUsage = getUsageMarkerStyle({ usage: 1 }, 64);
        const highUsage = getUsageMarkerStyle({ usage: 64 }, 64);

        expect(lowUsage.fillColor).not.toBe(highUsage.fillColor);
        expect(lowUsage.radius).toBe(highUsage.radius);
        expect(lowUsage.fillOpacity).toBeLessThan(highUsage.fillOpacity);
        expect(highUsage.fillColor).toBe('#066b4b');
    });

    it('uses a cluster peak rather than its arbitrary total for darkness', () => {
        const cluster = getUsageMarkerStyle({ usage: 200, intensityUsage: 6 }, 204);
        const stop = getUsageMarkerStyle({ usage: 6 }, 204);

        expect(cluster.fillColor).toBe(stop.fillColor);
    });
});

describe('clusterMapPoints', () => {
    const map = {
        project: ([lat, lng]) => ({ x: lng * 100, y: lat * 100 }),
    };

    it('shows every grouped stop at city zoom and above', () => {
        const points = [
            { lat: 1, lng: 1, type: 'boarding', usage: 1 },
            { lat: 1.01, lng: 1.01, type: 'boarding', usage: 1 },
        ];

        expect(clusterMapPoints(points, map, { zoom: 10 })).toHaveLength(2);
    });

    it('clusters only nearby stops below city zoom', () => {
        const points = [
            { lat: 1, lng: 1, type: 'boarding', usage: 1 },
            { lat: 1.01, lng: 1.01, type: 'boarding', usage: 1 },
        ];

        expect(clusterMapPoints(points, map, { zoom: 9 })).toHaveLength(1);
    });

    it('preserves the busiest stop usage when combining nearby stops', () => {
        const points = [
            { lat: 1, lng: 1, type: 'boarding', usage: 2 },
            { lat: 1.01, lng: 1.01, type: 'boarding', usage: 6 },
        ];

        const [cluster] = clusterMapPoints(points, map, { zoom: 9 });

        expect(cluster.usage).toBe(8);
        expect(cluster.peakUsage).toBe(6);
    });

    it('keeps more distinct locations visible in the wide view', () => {
        const points = [
            { lat: 1, lng: 1, type: 'boarding', usage: 1 },
            { lat: 1, lng: 1.15, type: 'boarding', usage: 1 },
        ];

        expect(clusterMapPoints(points, map, { zoom: 8 })).toHaveLength(2);
    });
});

describe('addZoomGatedPopup', () => {
    it('zooms toward a pin before opening its popup', () => {
        const events = {};
        const marker = {
            _transitStatsPointKey: 'boarding:43.65:-79.38',
            _transitStatsBaseStyle: { color: '#eaf8f2', weight: 1.25 },
            on: (event, callback) => { events[event] = callback; },
            setStyle: vi.fn(),
            closePopup: vi.fn(),
            getLatLng: () => [43.65, -79.38],
        };
        const map = {
            getZoom: () => 10,
            flyTo: vi.fn(),
        };

        addZoomGatedPopup(marker, map, 'Union Station');
        events.click();

        expect(map.flyTo).toHaveBeenCalledWith([43.65, -79.38], 12, { animate: true, duration: 0.35 });
        expect(marker.closePopup).toHaveBeenCalled();
    });

    it('opens a stop popup at the readable zoom threshold', () => {
        const events = {};
        const marker = {
            _transitStatsPointKey: 'boarding:43.65:-79.38',
            _transitStatsBaseStyle: { color: '#eaf8f2', weight: 1.25 },
            on: (event, callback) => { events[event] = callback; },
            setStyle: vi.fn(),
            closePopup: vi.fn(),
            bindPopup: vi.fn(),
            openPopup: vi.fn(),
            getLatLng: () => [43.65, -79.38],
        };
        const map = { getZoom: () => 14 };

        addZoomGatedPopup(marker, map, 'Boarding: Union Station');
        events.click();

        expect(marker.bindPopup).toHaveBeenCalledWith('Boarding: Union Station');
        expect(marker.openPopup).toHaveBeenCalled();
    });
});

it('formats stop names with boarding or exit context and escapes HTML', () => {
    expect(formatStopPopup('Union <Station>', { type: 'boarding' }))
        .toBe('Boarding: Union &lt;Station&gt;');
    expect(formatStopPopup('Spadina & Bloor', { type: 'exiting' }))
        .toBe('Exit: Spadina &amp; Bloor');
});
