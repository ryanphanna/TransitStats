/**
 * Transit Wrapped card — Canvas PNG export (Stories 1080×1920).
 * Pure drawing helpers; no DOM writes of user data.
 */

export const WRAPPED_CARD = Object.freeze({
    width: 1080,
    height: 1920,
});

function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

function drawStatTile(ctx, { x, y, w, h, value, label }) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    roundRect(ctx, x, y, w, h, 28);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 64px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(value ?? '—'), x + 36, y + 78);

    ctx.fillStyle = 'rgba(238, 248, 244, 0.72)';
    ctx.font = '600 28px Inter, system-ui, sans-serif';
    ctx.fillText(String(label), x + 36, y + 122);
}

function formatCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US');
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ displayName?: string, wrapped: object }} options
 */
export function drawWrappedCard(ctx, { displayName = 'Traveler', wrapped } = {}) {
    const { width: W, height: H } = WRAPPED_CARD;
    const name = String(displayName || 'Traveler').trim() || 'Traveler';

    const gradient = ctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, '#0b9f6e');
    gradient.addColorStop(0.45, '#0a7f65');
    gradient.addColorStop(1, '#102a2a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    // Soft glow
    const glow = ctx.createRadialGradient(W * 0.7, H * 0.18, 40, W * 0.7, H * 0.18, 420);
    glow.addColorStop(0, 'rgba(66, 201, 151, 0.45)');
    glow.addColorStop(1, 'rgba(66, 201, 151, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(238, 248, 244, 0.7)';
    ctx.font = '700 34px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Transit Wrapped', 72, 120);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 92px Inter, system-ui, sans-serif';
    ctx.fillText(wrapped?.label || 'Your month', 72, 230);

    ctx.fillStyle = 'rgba(238, 248, 244, 0.85)';
    ctx.font = '600 36px Inter, system-ui, sans-serif';
    ctx.fillText(`${name}'s rides`, 72, 290);

    // Hero trip count
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 180px Inter, system-ui, sans-serif';
    ctx.fillText(formatCount(wrapped?.trips ?? 0), 72, 520);

    ctx.fillStyle = 'rgba(238, 248, 244, 0.8)';
    ctx.font = '700 42px Inter, system-ui, sans-serif';
    ctx.fillText(wrapped?.trips === 1 ? 'trip' : 'trips', 72, 580);

    const tileW = 440;
    const tileH = 150;
    const gap = 28;
    const left = 72;
    const right = left + tileW + gap;
    let row = 680;

    const tiles = [
        { value: formatCount(wrapped?.hours ?? 0), label: 'hours riding' },
        { value: formatCount(wrapped?.daysRidden ?? 0), label: 'days ridden' },
        { value: formatCount(wrapped?.routes ?? 0), label: wrapped?.routes === 1 ? 'route' : 'routes' },
        { value: formatCount(wrapped?.bestStreak ?? 0), label: 'best streak (days)' },
    ];

    tiles.forEach((tile, i) => {
        const x = i % 2 === 0 ? left : right;
        if (i > 0 && i % 2 === 0) row += tileH + gap;
        drawStatTile(ctx, { x, y: row, w: tileW, h: tileH, ...tile });
    });

    row += tileH + 56;

    // Highlights panel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    roundRect(ctx, 72, row, W - 144, 470, 36);
    ctx.fill();

    const lines = [
        ['Top route', wrapped?.topRoute ? `${wrapped.topRoute.name} · ${wrapped.topRoute.count}×` : '—'],
        ['Favorite stop', wrapped?.favoriteStop ? wrapped.favoriteStop.name : '—'],
        ['Busiest day', wrapped?.busiestDay
            ? `${wrapped.busiestDay.label} · ${wrapped.busiestDay.count} ${wrapped.busiestDay.count === 1 ? 'trip' : 'trips'}`
            : '—'],
        ['Peak time', wrapped?.peak ? wrapped.peak.name : '—'],
    ];

    let lineY = row + 86;
    lines.forEach(([label, value]) => {
        ctx.fillStyle = 'rgba(238, 248, 244, 0.65)';
        ctx.font = '600 28px Inter, system-ui, sans-serif';
        ctx.fillText(label, 108, lineY);

        ctx.fillStyle = '#ffffff';
        ctx.font = '700 40px Inter, system-ui, sans-serif';
        const clipped = String(value).length > 34 ? `${String(value).slice(0, 33)}…` : String(value);
        ctx.fillText(clipped, 108, lineY + 48);
        lineY += 104;
    });

    ctx.fillStyle = 'rgba(238, 248, 244, 0.55)';
    ctx.font = '600 30px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('transitstats.fyi', W / 2, H - 80);
}

/**
 * Build a PNG blob for the given Wrapped summary.
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
            else reject(new Error('Could not render Wrapped card'));
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
