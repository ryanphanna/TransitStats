import { addMapZoomControl, installPopupZoomGuard } from './map-presentation.js';

export const DEFAULT_MAP_CENTER = [43.6532, -79.3832];
export const DEFAULT_MAP_ZOOM = 10;
export const DEFAULT_MAP_OVERVIEW_ZOOM = 6;

export function createMapSurface({ containerId, center = DEFAULT_MAP_CENTER, zoom = DEFAULT_MAP_ZOOM, tileTheme = 'light_all' }) {
    const map = L.map(containerId, {
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true,
        inertia: false,
    }).setView(center, zoom);

    addMapZoomControl(map);
    installPopupZoomGuard(map);

    const base = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        opacity: 0.58,
        className: 'minimal-basemap',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const renderer = L.canvas({ padding: 0.5 });
    const markers = L.layerGroup().addTo(map);

    return { map, base, renderer, markers };
}
