import { getFunctionUrl } from './shared/function-urls.js';

const ATLAS_ROUTES_PROXY = import.meta.env.VITE_ATLAS_ROUTES_URL
    || (import.meta.env.DEV ? '/atlas-dev/routes' : getFunctionUrl('atlasRoutes', import.meta.env));

function routeValues(trips) {
    const routes = new Set();
    trips.forEach(trip => {
        const route = String(trip.route || '').trim();
        if (!route) return;
        routes.add(route);
        const base = route.match(/^(\d+)/)?.[1];
        if (base) routes.add(base);
    });
    return [...routes];
}

export async function loadAtlasRoutes(trips = []) {
    const byAgency = new Map();
    trips.forEach(trip => {
        const agency = String(trip.agency || '').trim();
        if (!agency) return;
        if (!byAgency.has(agency)) byAgency.set(agency, []);
        byAgency.get(agency).push(trip);
    });

    const responses = await Promise.allSettled([...byAgency.entries()].map(async ([agency, agencyTrips]) => {
        const routes = routeValues(agencyTrips);
        if (routes.length === 0) return [];
        const response = await fetch(`${ATLAS_ROUTES_PROXY}?agency=${encodeURIComponent(agency)}&routes=${encodeURIComponent(routes.join(','))}`);
        if (!response.ok) throw new Error(`Atlas route data unavailable for ${agency}`);
        const data = await response.json();
        return (data.features || []).map(feature => ({ ...feature, __agency: agency }));
    }));

    return responses
        .filter(result => result.status === 'fulfilled')
        .flatMap(result => result.value);
}
