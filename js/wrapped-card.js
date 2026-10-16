/**
 * Recap card: Canvas PNG export (Stories 1080x1920).
 * The card is a monthly transfer ticket (see wrapped/ticket.js).
 */

import { drawTicket, TICKET_FONTS, TICKET_RECT } from './wrapped/ticket.js';

export { TICKET_RECT };

const WRAPPED_CARD = Object.freeze({
    width: 1080,
    height: 1920,
});

/** Load the web fonts the card uses; canvas text does not wait for them. */
export function loadCardFonts() {
    if (!document.fonts) return Promise.resolve();
    return Promise.all(TICKET_FONTS.map(font => document.fonts.load(font).catch(() => null)));
}

export function drawWrappedCard(ctx, { displayName, wrapped, anim } = {}) {
    drawTicket(ctx, { displayName, wrapped, anim });
}

/**
 * Build a PNG blob for the given Recap summary.
 * @returns {Promise<Blob>}
 */
export function renderWrappedPngBlob({ displayName, wrapped } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = WRAPPED_CARD.width;
    canvas.height = WRAPPED_CARD.height;
    const ctx = canvas.getContext('2d');
    drawWrappedCard(ctx, { displayName, wrapped });
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('Could not render Recap card'));
        }, 'image/png');
    });
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}
