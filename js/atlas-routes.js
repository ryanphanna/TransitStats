const ATLAS_ROUTES_PROXY = import.meta.env.VITE_ATLAS_ROUTES_URL
    || (import.meta.env.DEV ? '/atlas-dev/routes' : 'https://us-central1-transitstats-21ba4.cloudfunctions.net/atlasRoutes');

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

export async function loadAtlasRouteInventory(agencies = []) {
    const uniqueAgencies = [...new Set(agencies.map(agency => String(agency || '').trim()).filter(Boolean))];
    const results = await Promise.all(uniqueAgencies.map(async agency => {
        try {
            const response = await fetch(`${ATLAS_ROUTES_PROXY}?agency=${encodeURIComponent(agency)}&all=true`);
            if (!response.ok) throw new Error(`Atlas route inventory unavailable for ${agency}`);
            const data = await response.json();
            return {
                agency,
                routes: Array.isArray(data.routes) ? data.routes : [],
                error: null,
            };
        } catch (error) {
            return { agency, routes: [], error };
        }
    }));

    return results;
}
