import { validLocation } from './atlas-stop-resolver.js';
import { Utils } from './utils.js';

export function aggregateTripCorridors(endpointTrips = []) {
    const corridors = new Map();

    endpointTrips.forEach(({ trip = {}, boarding, exiting }) => {
        const start = validLocation(boarding?.location);
        const end = validLocation(exiting?.location);
        if (!start || !end || (start.lat === end.lat && start.lng === end.lng)) return;

        const agency = String(trip.agency || 'Unknown').trim() || 'Unknown';
        const key = [agency.toLowerCase(), start.lat.toFixed(5), start.lng.toFixed(5), end.lat.toFixed(5), end.lng.toFixed(5)].join(':');
        const existing = corridors.get(key);
        if (existing) {
            existing.count += 1;
            return;
        }

        corridors.set(key, {
            key,
            count: 1,
            agency,
            start,
            end,
            startLabel: boarding.label || trip.startStopName || trip.startStop || 'Boarding stop',
            endLabel: exiting.label || trip.endStopName || trip.endStop || 'Exit stop',
        });
    });

    return [...corridors.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function getCorridorStyle(count, maxCount = count) {
    const ratio = Math.log1p(Math.max(0, count)) / Math.log1p(Math.max(1, maxCount));
    const low = [166, 224, 202];
    const high = [6, 107, 75];
    const color = `#${low.map((value, index) => Math.round(value + ((high[index] - value) * ratio))
        .toString(16).padStart(2, '0')).join('')}`;
    return {
        color,
        weight: 4,
        opacity: 0.72,
    };
}

export function buildCorridorPopup({
    agency = 'Unknown agency',
    route = 'Unknown route',
    count = 0,
    startLabel = 'Boarding stop',
    endLabel = 'Exit stop',
} = {}) {
    const safe = value => Utils.hide(String(value ?? '').trim());
    const tripCount = Number(count) === 1 ? '1 trip' : `${Number(count) || 0} trips`;

    return [
        `<strong>${safe(agency)} · Route ${safe(route)}</strong>`,
        tripCount,
        `From ${safe(startLabel)}`,
        `To ${safe(endLabel)}`,
    ].join('<br>');
}

export function getDensestCorridorViewport(points = [], cellSize = 0.5) {
    const cells = new Map();
    points.forEach(point => {
        const lat = Number(point?.lat);
        const lng = Number(point?.lng ?? point?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const key = `${Math.floor(lat / cellSize)}:${Math.floor(lng / cellSize)}`;
        const cell = cells.get(key) || { weight: 0, points: [] };
        cell.weight += Math.max(1, Number(point.usage ?? point.count ?? 1));
        cell.points.push({ lat, lng });
        cells.set(key, cell);
    });
    return [...cells.values()].sort((first, second) => second.weight - first.weight)[0]?.points || [];
}

export function routeMatches(featureRoute, tripRoute) {
    const feature = String(featureRoute || '').trim().toLowerCase().replace(/^(route|line)\s*/i, '');
    const trip = String(tripRoute || '').trim().toLowerCase().replace(/^(route|line)\s*/i, '');
    const featureBase = feature.match(/^(\d+)/)?.[1] || feature;
    const tripBase = trip.match(/^(\d+)/)?.[1] || trip;
    return Boolean(feature && trip && (feature === trip || featureBase === tripBase));
}

function projectPoint(point, coordinates) {
    if (!point || coordinates.length < 2) return null;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    let best = null;
    let distanceBefore = 0;
    let totalLength = 0;
    for (let index = 0; index < coordinates.length - 1; index += 1) {
        totalLength += Math.hypot(
            coordinates[index + 1][0] - coordinates[index][0],
            coordinates[index + 1][1] - coordinates[index][1],
        );
    }
    if (!totalLength) return null;

    for (let index = 0; index < coordinates.length - 1; index += 1) {
        const [x1, y1] = coordinates[index];
        const [x2, y2] = coordinates[index + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        const t = length ? Math.max(0, Math.min(1, ((lng - x1) * dx + (lat - y1) * dy) / (length * length))) : 0;
        const projected = [x1 + dx * t, y1 + dy * t];
        const distance = Math.hypot(lng - projected[0], lat - projected[1]);
        if (!best || distance < best.distance) {
            best = { fraction: (distanceBefore + length * t) / totalLength, distance };
        }
        distanceBefore += length;
    }
    return best;
}

function pointAtFraction(coordinates, fraction) {
    const target = Math.max(0, Math.min(1, fraction));
    let totalLength = 0;
    const lengths = coordinates.slice(0, -1).map((point, index) => {
        const next = coordinates[index + 1];
        const length = Math.hypot(next[0] - point[0], next[1] - point[1]);
        totalLength += length;
        return length;
    });
    let remaining = totalLength * target;
    for (let index = 0; index < lengths.length; index += 1) {
        if (remaining <= lengths[index] || index === lengths.length - 1) {
            const [x1, y1] = coordinates[index];
            const [x2, y2] = coordinates[index + 1];
            const t = lengths[index] ? remaining / lengths[index] : 0;
            return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
        }
        remaining -= lengths[index];
    }
    return coordinates.at(-1);
}

export function clipRouteGeometry(coordinates, startFraction, endFraction) {
    if (!Array.isArray(coordinates) || coordinates.length < 2 || endFraction <= startFraction) return null;
    const lengths = coordinates.slice(0, -1).map((point, index) => Math.hypot(
        coordinates[index + 1][0] - point[0], coordinates[index + 1][1] - point[1],
    ));
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    if (!totalLength) return null;
    const line = [pointAtFraction(coordinates, startFraction)];
    let distance = 0;
    lengths.forEach((length, index) => {
        distance += length;
        const fraction = distance / totalLength;
        if (fraction > startFraction && fraction < endFraction) line.push(coordinates[index + 1]);
    });
    line.push(pointAtFraction(coordinates, endFraction));
    return line.map(([lng, lat]) => [lat, lng]);
}

export function clipTripToRoute(feature, trip, boarding, exiting) {
    if (feature?.geometry?.type !== 'LineString') return null;
    const start = projectPoint(boarding, feature.geometry.coordinates);
    const end = projectPoint(exiting, feature.geometry.coordinates);
    if (!start || !end || end.fraction <= start.fraction || start.distance > 0.02 || end.distance > 0.02) return null;
    return clipRouteGeometry(feature.geometry.coordinates, start.fraction, end.fraction);
}
