/**
 * TransitStats - browser stop canonicalizer.
 * Predictions run server-side (functions/lib/predict_v3.js); the browser only
 * needs the stops library and stop-name canonicalizing for the map.
 */
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

    _canonicalizeStop(name) {
        if (!name) return null;
        if (this._normCache.has(name)) return this._normCache.get(name);

        const norm = n => n.trim().toLowerCase()
            .replace(/\s*[\/&@]\s*/g, '/')
            .replace(/\s+at\s+/g, '/');

        const lower = norm(name);

        if (this._stopsIndex.size === 0 && this.stopsLibrary && this.stopsLibrary.length > 0) {
            for (const s of this.stopsLibrary) {
                const cName = norm(s.name);
                this._stopsIndex.set(cName, cName);
                if (s.aliases) {
                    s.aliases.forEach(a => this._stopsIndex.set(norm(a), cName));
                }
            }
        }
        const result = this._stopsIndex.get(lower) || lower;
        this._normCache.set(name, result);
        return result;
    },
};
