import { getFunctionUrl } from './shared/function-urls.js';

const ATLAS_STOPS_PROXY = import.meta.env.VITE_ATLAS_STOPS_URL
    || (import.meta.env.DEV ? '/atlas-dev/stops' : getFunctionUrl('atlasStops', import.meta.env));
const STOP_CACHE_DB = 'transitstats-map-cache';
const STOP_CACHE_STORE = 'agency-stops';
const STOP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const stopCacheMemory = new Map();
const stopCacheRequests = new Map();
let stopSupplementsPromise;

function loadStopSupplements() {
    if (!stopSupplementsPromise) {
        stopSupplementsPromise = import('./stop-supplements.json')
            .then(module => module.default)
            .catch(() => ({ local: {}, oldTrips: {} }));
    }
    return stopSupplementsPromise;
}

// Some user agencies share physical stops with an Atlas agency. Keep the
// trip's agency on the returned stop while loading every verified GTFS source
// needed to resolve that trip endpoint.
const ATLAS_STOP_SOURCE_SLUGS = {
    Amtrak: ['sdmts', 'lacmta'],
    'Flagship Cruises & Events': ['sdmts'],
    'GTAA Terminal Link': ['ttc'],
};

function openStopCache() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        const request = indexedDB.open(STOP_CACHE_DB, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STOP_CACHE_STORE, { keyPath: 'slug' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

async function readCachedStops(slug) {
    if (stopCacheMemory.has(slug)) return stopCacheMemory.get(slug);
    const database = await openStopCache();
    if (!database) return null;
    return new Promise((resolve) => {
        const request = database.transaction(STOP_CACHE_STORE, 'readonly')
            .objectStore(STOP_CACHE_STORE)
            .get(slug);
        request.onsuccess = () => {
            const entry = request.result || null;
            if (entry) stopCacheMemory.set(slug, entry);
            resolve(entry);
        };
        request.onerror = () => resolve(null);
    });
}

async function writeCachedStops(slug, index) {
    const entry = { slug, index, fetchedAt: Date.now() };
    stopCacheMemory.set(slug, entry);
    const database = await openStopCache();
    if (!database) return;
    await new Promise((resolve) => {
        const request = database.transaction(STOP_CACHE_STORE, 'readwrite')
            .objectStore(STOP_CACHE_STORE)
            .put(entry);
        request.onsuccess = request.onerror = () => resolve();
    });
}

function formatAgencyStops(agency, index) {
    return Object.entries(index || {})
        .map(([code, stop]) => ({
            code,
            name: stop.name,
            lat: Number(stop.lat),
            lng: Number(stop.lon),
            agency,
            source: 'atlas'
        }))
        .filter(stop => stop.name && Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
}

async function fetchAgencyStops(agency, slug) {
    const cached = await readCachedStops(slug);
    if (cached && Date.now() - cached.fetchedAt < STOP_CACHE_TTL_MS) {
        return formatAgencyStops(agency, cached.index);
    }

    let request = stopCacheRequests.get(slug);
    if (!request) {
        request = (async () => {
            const response = await fetch(`${ATLAS_STOPS_PROXY}?agency=${encodeURIComponent(slug)}`);
            if (!response.ok) throw new Error(`Atlas stop data unavailable for ${slug}`);
            const index = await response.json();
            await writeCachedStops(slug, index);
            return index;
        })();
        stopCacheRequests.set(slug, request);
    }

    try {
        const index = await request;
        return formatAgencyStops(agency, index);
    } catch (error) {
        // A stale cache is still better than making a loaded map unusable when
        // the network or Atlas is temporarily unavailable.
        if (cached) return formatAgencyStops(agency, cached.index);
        throw error;
    } finally {
        if (stopCacheRequests.get(slug) === request) stopCacheRequests.delete(slug);
    }
}

export async function loadAtlasStops(agencies) {
    const agencySlugs = [...new Set(agencies)]
        .filter(Boolean)
        .flatMap(agency => (ATLAS_STOP_SOURCE_SLUGS[agency] || [agency])
            .map(slug => [agency, slug]));
    if (agencySlugs.length === 0) return [];

    const [results, supplementsData] = await Promise.all([
        Promise.allSettled(agencySlugs.map(([agency, slug]) => fetchAgencyStops(agency, slug))),
        loadStopSupplements(),
    ]);
    const publishedStops = results
        .filter(result => result.status === 'fulfilled')
        .flatMap(result => result.value);
    const supplements = agencySlugs.flatMap(([agency]) => [
        ...(supplementsData.local[agency] || []),
        ...(supplementsData.oldTrips[agency] || []),
    ].map(stop => ({
            ...stop,
            agency,
            source: 'atlas',
        })));
    return [...publishedStops, ...supplements];
}
