// Shared canvas helpers for the Wrapped card concepts.

export function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

export function formatCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    return value.toLocaleString('en-US');
}

export function plural(count, one, many) {
    return count === 1 ? one : many;
}

/** Set a font, shrinking the size until the text fits maxWidth. Returns the size used. */
export function fitFont(ctx, text, { weight = 700, size, min = 20, family, maxWidth }) {
    let px = size;
    do {
        ctx.font = `${weight} ${px}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth || px <= min) break;
        px -= 2;
    } while (px > min);
    return px;
}

export function ellipsize(ctx, text, maxWidth) {
    const value = String(text);
    if (ctx.measureText(value).width <= maxWidth) return value;
    let cut = value.length;
    while (cut > 1 && ctx.measureText(`${value.slice(0, cut)}…`).width > maxWidth) cut--;
    return `${value.slice(0, cut)}…`;
}

const SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function shortMonth(monthIndex) {
    return SHORT_MONTHS[monthIndex] || '';
}

export function monthName(wrapped) {
    return String(wrapped?.label || '').replace(/\s*\d{4}$/, '');
}

/** Deterministic pseudo-random sequence so a month always draws the same barcode/serial. */
export function seeded(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

export function seedFor(wrapped) {
    return ((wrapped?.year || 0) * 100 + (wrapped?.monthIndex || 0)) * 7919
        + (wrapped?.trips || 0) * 131 + Math.round((wrapped?.hours || 0) * 10);
}

export function serialFor(wrapped) {
    const rand = seeded(seedFor(wrapped));
    const block = () => String(Math.floor(rand() * 10000)).padStart(4, '0');
    const mm = String((wrapped?.monthIndex || 0) + 1).padStart(2, '0');
    return `${mm}${String(wrapped?.year || 0).slice(-2)}-${block()}-${block()}`;
}
