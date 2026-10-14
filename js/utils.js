/**
 * Shared Utilities for TransitStats V2
 */

export const Utils = {
    /**
     * Normalize intersection-format stops to a canonical form.
     * "Spadina & Nassau", "spadina/nassau" → "Spadina / Nassau"
     */
    normalizeIntersectionStop(str) {
        if (!str) return str;
        const trimmed = str.trim();

        // Helper for proper title casing
        const titleCase = s => s.replace(/\b\w+/g, w =>
            ['at', 'and', 'the', 'of', 'for', 'on'].includes(w.toLowerCase())
                ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        );

        // Check for "1234 Stop Name" format
        const codePrefix = trimmed.match(/^(\d{4,6})\s+(.+)$/);
        const core = codePrefix ? codePrefix[2] : trimmed;

        // Intersection patterns: "/", "&", "-", " at ", " and "
        const intersectionMatch = core.match(/^(.+?)\s*(?:\/|&|-|\bat\b|\band\b)\s*(.+)$/i);

        if (intersectionMatch) {
            const a = titleCase(intersectionMatch[1].trim());
            const b = titleCase(intersectionMatch[2].trim());
            const intersectionPart = `${a} / ${b}`;
            return codePrefix ? `${codePrefix[1]} ${intersectionPart}` : intersectionPart;
        }

        return codePrefix ? trimmed : titleCase(trimmed);
    },

    /**
     * Canonicalize a stop name purely for comparison/grouping — never stored.
     * Collapses all separator variants and casing so variants map to the same key.
     */
    canonicalizeForMatch(str) {
        if (!str) return null;
        return str.trim().toLowerCase()
            .replace(/\s*(?:\/|&|-|\bat\b|\band\b)\s*/gi, '/')
            .replace(/\s+/g, ' ');
    },

    /**
     * HTML escape for text and quoted attribute values
     */
    hide(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};
