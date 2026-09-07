import { loadAtlasRouteInventory } from './atlas-routes.js';
import { TripController } from './trips/TripController.js';
import { UI } from './ui-utils.js';

function normalizeRoute(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^(route|line)\s+/i, '')
        .replace(/\s+/g, ' ');
}

function routeKey(value) {
    const normalized = normalizeRoute(value);
    const numericBase = normalized.match(/^(\d+)/)?.[1];
    if (numericBase) return numericBase;
    return normalized.replace(/-(?:n|s|e|w)$/i, '');
}

function routeLabel(value) {
    const raw = String(value || '').trim();
    const numericBase = raw.match(/^(\d+)/)?.[1];
    if (numericBase) return numericBase;
    return raw.replace(/-(?:N|S|E|W)$/i, '');
}

export function isEligibleRouteTrip(trip = {}) {
    const route = normalizeRoute(trip.route);
    return Boolean(
        String(trip.agency || '').trim()
        && route
        && !/^(incomplete|unknown)(\s+trip)?$/i.test(route)
        && !trip.discarded
        && !trip.needs_review,
    );
}

export function buildAgencyCoverage(agency, inventory = [], trips = []) {
    const routeMap = new Map();
    inventory.forEach(route => {
        const key = routeKey(route.routeShortName);
        if (!key || routeMap.has(key)) return;
        routeMap.set(key, {
            key,
            routeShortName: routeLabel(route.routeShortName),
            routeLongName: String(route.routeLongName || '').trim(),
        });
    });

    const ridden = new Set(
        trips
            .filter(trip => isEligibleRouteTrip(trip) && String(trip.agency).trim() === agency)
            .map(trip => routeKey(trip.route))
            .filter(key => routeMap.has(key)),
    );
    const routes = [...routeMap.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const riddenRoutes = routes.filter(route => ridden.has(route.key));

    return {
        agency,
        routes,
        riddenRoutes,
        riddenCount: riddenRoutes.length,
        total: routes.length,
        percentage: routes.length ? Math.round((riddenRoutes.length / routes.length) * 100) : 0,
    };
}

export function buildObservedAgencies(trips = []) {
    return [...new Set(trips.filter(isEligibleRouteTrip).map(trip => String(trip.agency).trim()))]
        .sort((a, b) => a.localeCompare(b));
}

export const RouteTracker = {
    async render(container, trips = TripController.allTrips) {
        if (!container) return;
        container.innerHTML = '<p class="routes-status">Loading route progress…</p>';

        const agencies = buildObservedAgencies(trips);
        if (agencies.length === 0) {
            container.innerHTML = '<p class="routes-status">Log a ride with a route to start tracking your route progress.</p>';
            return;
        }

        const inventoryResults = await loadAtlasRouteInventory(agencies);
        const sections = inventoryResults.map(result => ({
            ...result,
            coverage: buildAgencyCoverage(result.agency, result.routes, trips),
        }));
        const available = sections.filter(section => section.routes.length > 0);

        if (available.length === 0) {
            container.innerHTML = '<p class="routes-status">Route inventory is not available for your agencies yet.</p>';
            return;
        }

        container.innerHTML = available.map(({ agency, coverage }) => `
            <section class="route-agency-section" aria-labelledby="route-agency-${UI.escapeHtml(coverage.agency).replace(/[^a-z0-9]+/gi, '-')}">
                <div class="route-agency-heading">
                    <div>
                        <h2 id="route-agency-${UI.escapeHtml(coverage.agency).replace(/[^a-z0-9]+/gi, '-')}">${UI.escapeHtml(agency)}</h2>
                        <p>${coverage.riddenCount} of ${coverage.total} routes ridden</p>
                    </div>
                    <strong>${coverage.percentage}%</strong>
                </div>
                <div class="route-progress" role="progressbar" aria-label="${UI.escapeHtml(agency)}: ${coverage.percentage}% of routes ridden" aria-valuenow="${coverage.percentage}" aria-valuemin="0" aria-valuemax="100">
                    <span style="width: ${coverage.percentage}%"></span>
                </div>
                <details class="route-ridden-details">
                    <summary>Routes you’ve ridden <strong>${coverage.riddenCount}</strong></summary>
                    <div class="route-ridden-list">
                        ${coverage.riddenRoutes.length
                            ? coverage.riddenRoutes.map(route => `
                                <div class="route-ridden-row">
                                    <strong>${UI.escapeHtml(route.routeShortName)}</strong>
                                    <span>${UI.escapeHtml(route.routeLongName || '')}</span>
                                </div>`).join('')
                            : '<p class="routes-status">No routes matched yet.</p>'}
                    </div>
                </details>
            </section>
        `).join('');
    },
};

window.RouteTracker = RouteTracker;
