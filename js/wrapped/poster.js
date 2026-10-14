// Concept C: Swiss transit poster, with the ride count on split-flap tiles and a departure strip.
import { roundRect, formatCount, plural, fitFont, ellipsize, monthName } from './util.js';

const GROTESK = 'Archivo, "Helvetica Neue", Arial, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
export const POSTER_FONTS = [`800 40px Archivo`, `900 40px Archivo`, `400 24px "IBM Plex Mono"`, `600 24px "IBM Plex Mono"`];

const PAPER = '#f7f7f4';
const INK = '#101010';
const SIGNAL = '#ffd200';
const FADED = '#6a6a66';

function flapTile(ctx, { x, y, w, h, char }) {
    ctx.fillStyle = INK;
    roundRect(ctx, x, y, w, h, 18);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${Math.round(h * 0.78)}px ${GROTESK}`;
    ctx.fillText(char, x + w / 2, y + h * 0.8);
    // Hinge and lower-half shade, the split-flap tell
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y + h / 2, w, h / 2 - 18);
    ctx.fillStyle = PAPER;
    ctx.fillRect(x - 2, y + h / 2 - 3, w + 4, 6);
    ctx.fillStyle = '#000';
    [x + 18, x + w - 18].forEach(px => {
        ctx.beginPath();
        ctx.arc(px, y + h / 2, 6, 0, Math.PI * 2);
        ctx.fill();
    });
}

export function drawPoster(ctx, { displayName = 'Traveler', wrapped } = {}) {
    const W = 1080;
    const H = 1920;
    const w = wrapped || {};
    const name = String(displayName || 'Traveler').trim() || 'Traveler';

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);

    // Signal-yellow column carries the month, set vertically
    const colW = 190;
    ctx.fillStyle = SIGNAL;
    ctx.fillRect(0, 0, colW, H);
    ctx.save();
    ctx.translate(colW / 2 + 20, H - 80);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = INK;
    const month = `${monthName(w) || 'This month'} ${w.year || ''}`.trim();
    fitFont(ctx, month, { weight: 900, size: 132, min: 70, family: GROTESK, maxWidth: H - 460 });
    ctx.fillText(month, 0, 0);
    ctx.restore();

    const x0 = colW + 70;
    const innerW = W - x0 - 70;

    // Masthead
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = INK;
    ctx.font = `900 54px ${GROTESK}`;
    ctx.fillText('Transit Wrapped', x0, 130);
    ctx.fillStyle = FADED;
    ctx.font = `400 32px ${MONO}`;
    ctx.fillText(`${name}'s month`, x0, 182);
    ctx.fillStyle = INK;
    ctx.fillRect(x0, 218, innerW, 10);

    // Hero: ride count on flap tiles
    const digits = formatCount(w.trips ?? 0).split('');
    const tileH = 400;
    const gap = 14;
    const tileW = Math.min(330, Math.floor((innerW - gap * (digits.length - 1)) / digits.length));
    let fx = x0;
    digits.forEach(ch => {
        if (ch === ',') {
            ctx.fillStyle = INK;
            ctx.beginPath();
            ctx.arc(fx + 8, 278 + tileH - 24, 9, 0, Math.PI * 2);
            ctx.fill();
            fx += 28;
            return;
        }
        flapTile(ctx, { x: fx, y: 278, w: tileW, h: tileH, char: ch });
        fx += tileW + gap;
    });
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.font = `800 64px ${GROTESK}`;
    ctx.fillText(plural(w.trips, 'ride', 'rides'), x0, 770);

    // Three facts on a ruled grid
    const facts = [
        [formatCount(w.hours ?? 0), 'hours aboard'],
        [formatCount(w.daysRidden ?? 0), plural(w.daysRidden, 'day ridden', 'days ridden')],
        (w.bestStreak ?? 0) > 1
            ? [formatCount(w.bestStreak), 'days in a row']
            : [formatCount(w.stops ?? 0), plural(w.stops, 'stop touched', 'stops touched')],
    ];
    const cellW = (innerW - 40) / 3;
    facts.forEach(([value, label], i) => {
        const cx = x0 + i * (cellW + 20);
        ctx.fillStyle = INK;
        ctx.fillRect(cx, 826, cellW, 8);
        ctx.textAlign = 'left';
        fitFont(ctx, value, { weight: 900, size: 120, min: 60, family: GROTESK, maxWidth: cellW - 28 });
        ctx.fillText(value, cx - 4, 956);
        ctx.fillStyle = FADED;
        ctx.font = `400 28px ${MONO}`;
        ctx.fillText(ellipsize(ctx, label, cellW), cx, 1004);
    });

    // Departure strip: top routes on a dark board
    const routes = (w.topRoutes || []).slice(0, 3);
    const boardY = 1070;
    const rowH = 104;
    const boardH = 90 + Math.max(1, routes.length) * rowH + 24;
    ctx.fillStyle = INK;
    roundRect(ctx, x0, boardY, innerW, boardH, 22);
    ctx.fill();
    ctx.fillStyle = SIGNAL;
    ctx.font = `600 30px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText('most ridden', x0 + 36, boardY + 58);
    ctx.textAlign = 'right';
    ctx.fillText('rides', x0 + innerW - 36, boardY + 58);

    const most = routes[0]?.count || 1;
    (routes.length ? routes : [{ name: 'no route details', count: w.trips ?? 0 }]).forEach((route, i) => {
        const ry = boardY + 90 + i * rowH;
        // Route cell in flap style
        ctx.font = `800 54px ${GROTESK}`;
        const label = ellipsize(ctx, String(route.name), 220);
        const cw = Math.max(110, ctx.measureText(label).width + 44);
        ctx.fillStyle = SIGNAL;
        roundRect(ctx, x0 + 36, ry, cw, 80, 12);
        ctx.fill();
        ctx.fillStyle = INK;
        ctx.textAlign = 'center';
        ctx.fillText(label, x0 + 36 + cw / 2, ry + 58);
        // Bar
        const barX = x0 + 36 + cw + 28;
        const barMax = innerW - (barX - x0) - 150;
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        roundRect(ctx, barX, ry + 26, barMax, 28, 14);
        ctx.fill();
        ctx.fillStyle = '#fff';
        roundRect(ctx, barX, ry + 26, Math.max(28, barMax * (route.count / most)), 28, 14);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'right';
        ctx.font = `600 44px ${MONO}`;
        ctx.fillText(String(route.count), x0 + innerW - 36, ry + 56);
    });

    // Favourite stop on the signal band
    const bandY = boardY + boardH + 60;
    const bandH = 210;
    ctx.fillStyle = SIGNAL;
    ctx.fillRect(x0, bandY, innerW, bandH);
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `400 32px ${MONO}`;
    ctx.fillText('boarded most at', x0 + 36, bandY + 64);
    const stopName = w.favoriteStop?.name || 'Every stop once';
    fitFont(ctx, stopName, { weight: 900, size: 88, min: 44, family: GROTESK, maxWidth: innerW - 72 });
    ctx.fillText(stopName, x0 + 32, bandY + 160);

    // Footer lines: busiest day, peak time
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.font = `400 32px ${MONO}`;
    let fy = bandY + bandH + 58;
    if (w.busiestDay && w.busiestDay.count > 1) {
        ctx.fillText(ellipsize(ctx, `busiest day ${w.busiestDay.label}, ${w.busiestDay.count} rides`, innerW), x0, fy);
        fy += 48;
    }
    if (w.peak) ctx.fillText(`mostly ${w.peak.name.toLowerCase()}`, x0, fy);

    ctx.textAlign = 'right';
    ctx.fillStyle = FADED;
    ctx.font = `400 28px ${MONO}`;
    ctx.fillText('transitstats.fyi', W - 70, 1888);
}
