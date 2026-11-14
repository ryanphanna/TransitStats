const STOP_FIELDS = {
    boarding: ['startStopName', 'startStop', 'boardingStopName', 'boardingStop'],
    exiting: ['endStopName', 'endStop', 'exitingStopName', 'exitingStop'],
};

const PLACEHOLDER_STOPS = new Set([
    'incomplete',
    'incomplete trip',
    'unknown boarding stop',
    'unknown exit stop',
    'unknown exiting stop',
    'unknown stop',
]);

function usableStopLabel(value) {
    if (typeof value !== 'string') return null;
    const label = value.trim();
    return label && !PLACEHOLDER_STOPS.has(label.toLowerCase()) ? label : null;
}

export function getTripStopLabel(trip = {}, side = 'boarding', resolution = null) {
    const resolvedLabel = usableStopLabel(resolution?.label);
    if (resolvedLabel) return resolvedLabel;

    const fields = STOP_FIELDS[side] || STOP_FIELDS.boarding;
    for (const field of fields) {
        const value = usableStopLabel(trip[field]);
        if (value) return value;
    }
    if (resolution?.source === 'saved') return 'Saved stop location';
    return side === 'boarding' ? 'No boarding stop recorded' : (trip.incomplete ? 'Trip ended early' : 'No exit recorded');
}

export function getTripRouteLabel(trip = {}) {
    const route = typeof trip.route === 'string' ? trip.route.trim() : '';
    if (!route) return 'Unknown route';
    if (trip.incomplete && /^(incomplete|unknown)(\s+trip)?$/i.test(route)) return 'Trip ended early';

    // Stored route values can be all-caps display names (for example, PURPLE).
    // Keep route numbers and short agency-style codes unchanged, but make longer
    // rider-facing names read naturally in map popups and trip cards.
    if (/^[A-Z][A-Z\s-]+$/.test(route) && route.replace(/[^A-Z]/g, '').length > 3) {
        return route.toLowerCase().replace(/(^|[\s-])[a-z]/g, match => match.toUpperCase());
    }

    return route;
}

export function getTripStatusLabel(trip = {}) {
    if (trip.incomplete) return 'Incomplete';
    if (!trip.endTime) return 'In progress';
    if (trip.discarded) return 'Discarded';
    return '';
}
