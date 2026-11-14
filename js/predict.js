/**
 * TransitStats - browser stop canonicalizer.
 * Predictions run server-side (functions/lib/predict_v3.js); the browser only
 * needs the stops library and stop-name canonicalizing for the map.
 */
import { canonicalAgency } from './shared/agency-aliases.js';

const agencyKey = agency => canonicalAgency(String(agency)).toLowerCase();

export const PredictionEngine = {
    /**
     * Stops library for name canonicalization. Replacing it resets the caches
     * built from the previous library.
     */
    _stopsLibrary: [],
    _stopsIndex: new Map(),
    _normCache: new Map(),

    get stopsLibrary() {
        return this._stopsLibrary;
    },

    set stopsLibrary(library) {
        this._stopsLibrary = library;
        this._stopsIndex = new Map();
        this._normCache = new Map();
    },

    /**
     * Canonical stop name. The same name can belong to stops at different agencies
     * (TTC and LA Metro both have a "Union Station"), so a stop at `agency` wins;
     * other agencies fill in only when that agency has no stop by this name.
     */
    _canonicalizeStop(name, agency = null) {
        if (!name) return null;
        const cacheKey = `${agency ? agencyKey(agency) : ''}\u0000${name}`;
        if (this._normCache.has(cacheKey)) return this._normCache.get(cacheKey);

        const norm = n => n.trim().toLowerCase()
            .replace(/\s*[\/&@]\s*/g, '/')
            .replace(/\s+at\s+/g, '/');

        const lower = norm(name);

        if (this._stopsIndex.size === 0 && this.stopsLibrary && this.stopsLibrary.length > 0) {
            // name/alias -> every stop listing it, in library order.
            const add = (key, entry) => {
                if (!this._stopsIndex.has(key)) this._stopsIndex.set(key, []);
                this._stopsIndex.get(key).push(entry);
            };
            for (const s of this.stopsLibrary) {
                const entry = {
                    canonical: norm(s.name),
                    agencies: new Set([s.agency, ...(s.agencies || [])].filter(Boolean).map(agencyKey)),
                };
                add(entry.canonical, entry);
                if (s.aliases) {
                    s.aliases.forEach(a => add(norm(a), entry));
                }
            }
        }
        const entries = this._stopsIndex.get(lower);
        let result = lower;
        if (entries) {
            const want = agency ? agencyKey(agency) : null;
            // No stop at the trip's agency: the last library entry wins, as before.
            const own = want ? entries.filter(e => e.agencies.has(want)) : [];
            result = (own.length ? own : entries).at(-1).canonical;
        }
        this._normCache.set(cacheKey, result);
        return result;
    },
};
