import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapSurface } from '../js/map-surface.js';

describe('createMapSurface', () => {
    beforeEach(() => {
        const map = {
            setView: vi.fn().mockReturnThis(),
            on: vi.fn(),
        };
        globalThis.L = {
            map: vi.fn(() => map),
            control: vi.fn(() => ({
                addTo: vi.fn(),
            })),
            tileLayer: vi.fn(() => ({
                addTo: vi.fn(),
            })),
            canvas: vi.fn(),
            layerGroup: vi.fn(() => ({
                addTo: vi.fn(),
            })),
        };
    });

    it('disables drag inertia so panning stops with the pointer', () => {
        createMapSurface({ containerId: 'main-map' });

        expect(L.map).toHaveBeenCalledWith('main-map', expect.objectContaining({
            inertia: false,
        }));
    });
});
