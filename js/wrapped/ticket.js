// Concept A: a printed monthly transfer ticket with a perforated stub and a punched day grid.
import {
    roundRect, formatCount, plural, fitFont, ellipsize, shortMonth, monthName, seeded, seedFor, serialFor,
} from './util.js';

const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const DISPLAY = 'Archivo, "Helvetica Neue", Arial, sans-serif';

export const TICKET_FONTS = [`800 40px Archivo`, `900 40px Archivo`, `400 24px "IBM Plex Mono"`, `600 24px "IBM Plex Mono"`];

const FIELD = '#d63a2a';
const PAPER = '#f5f4ee';
const INK = '#17202e';
const FADED = '#6b7280';
const STAMP = '#5b3fb0';

function leaderRow(ctx, { x, w, y, label, value }) {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `400 34px ${MONO}`;
    ctx.fillText(label, x, y);
    const labelW = ctx.measureText(label).width;

    ctx.textAlign = 'right';
    ctx.font = `800 50px ${DISPLAY}`;
    ctx.fillText(value, x + w, y + 4);
    const valueW = ctx.measureText(value).width;

    ctx.fillStyle = FADED;
    ctx.font = `400 34px ${MONO}`;
    ctx.textAlign = 'left';
    const startX = x + labelW + 16;
    const endX = x + w - valueW - 16;
    const dot = ctx.measureText('.').width;
    const count = Math.max(0, Math.floor((endX - startX) / dot));
    ctx.fillText('.'.repeat(count), startX, y);
}

export function drawTicket(ctx, { displayName = 'Traveler', wrapped } = {}) {
    const W = 1080;
    const H = 1920;
    const w = wrapped || {};
    const name = String(displayName || 'Traveler').trim() || 'Traveler';

    // Field behind the ticket
    ctx.fillStyle = FIELD;
    ctx.fillRect(0, 0, W, H);

    // Ticket body
    const tx = 70;
    const ty = 90;
    const tw = W - 140;
    const th = H - 180;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 16;
    ctx.fillStyle = PAPER;
    roundRect(ctx, tx, ty, tw, th, 14);
    ctx.fill();
    ctx.restore();

    const perfY = 690;
    // Notches at the perforation
    ctx.fillStyle = FIELD;
    [tx, tx + tw].forEach(cx => {
        ctx.beginPath();
        ctx.arc(cx, perfY, 36, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.save();
    ctx.strokeStyle = FADED;
    ctx.lineWidth = 4;
    ctx.setLineDash([16, 14]);
    ctx.beginPath();
    ctx.moveTo(tx + 50, perfY);
    ctx.lineTo(tx + tw - 50, perfY);
    ctx.stroke();
    ctx.restore();

    const px = tx + 56;
    const pw = tw - 112;

    // Stub header
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `800 42px ${DISPLAY}`;
    ctx.fillText('transitstats', px, ty + 90);
    ctx.textAlign = 'right';
    ctx.fillStyle = FADED;
    ctx.font = `400 28px ${MONO}`;
    ctx.fillText(ellipsize(ctx, `issued to ${name}`, 460), px + pw, ty + 88);
    ctx.fillStyle = INK;
    ctx.fillRect(px, ty + 112, pw, 8);

    // Month
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    const month = monthName(w) || 'This month';
    fitFont(ctx, month, { weight: 900, size: 190, min: 90, family: DISPLAY, maxWidth: pw });
    ctx.fillText(month, px - 6, ty + 290);

    ctx.fillStyle = FADED;
    ctx.font = `400 32px ${MONO}`;
    const last = w.daysInMonth || 30;
    ctx.fillText(`valid ${shortMonth(w.monthIndex)} 1 to ${shortMonth(w.monthIndex)} ${last}, ${w.year}`, px, ty + 384);
    // A transfer expires: this card is only on offer through the end of the next month.
    const expiry = new Date(w.year, w.monthIndex + 2, 0);
    ctx.textAlign = 'right';
    ctx.fillStyle = STAMP;
    ctx.fillText(`expires ${shortMonth(expiry.getMonth())} ${expiry.getDate()}`, px + pw, ty + 384);
    ctx.textAlign = 'left';

    // Punch grid: one cell per day, punched where a ride happened
    const cols = 16;
    const cell = Math.floor(pw / cols);
    const gridY = ty + 416;
    const counts = w.dayCounts || [];
    for (let i = 0; i < last; i++) {
        const cx = px + (i % cols) * cell + cell / 2;
        const cy = gridY + Math.floor(i / cols) * 72 + 30;
        const ridden = (counts[i] || 0) > 0;
        if (ridden) {
            ctx.fillStyle = FIELD;
            ctx.beginPath();
            ctx.arc(cx, cy, 20, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = INK;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        } else {
            ctx.fillStyle = FADED;
            ctx.font = `400 24px ${MONO}`;
            ctx.textAlign = 'center';
            ctx.fillText(String(i + 1), cx, cy + 8);
        }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = FADED;
    ctx.font = `400 26px ${MONO}`;
    ctx.fillText(`${formatCount(w.daysRidden ?? 0)} ${plural(w.daysRidden, 'day', 'days')} punched`, px, gridY + 160);

    if (!w.trips) {
        drawEmptyBody(ctx, { px, pw, perfY, ty, th, w, W });
        return;
    }

    // Body: the ride count as the fare
    let y = perfY + 150;
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    fitFont(ctx, formatCount(w.trips ?? 0), { weight: 900, size: 250, min: 140, family: DISPLAY, maxWidth: 560 });
    ctx.fillText(formatCount(w.trips ?? 0), px - 8, y + 115);
    ctx.font = `600 44px ${MONO}`;
    ctx.fillText(plural(w.trips, 'ride', 'rides'), px + 4, y + 172);

    // Stamp
    ctx.save();
    ctx.translate(px + pw - 150, y + 60);
    ctx.rotate(-0.2);
    ctx.strokeStyle = STAMP;
    ctx.fillStyle = STAMP;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, -140, -70, 280, 140, 14);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = `800 40px ${DISPLAY}`;
    ctx.fillText('fully used', 0, -6);
    ctx.font = `400 26px ${MONO}`;
    ctx.fillText(`${w.year}-${String((w.monthIndex || 0) + 1).padStart(2, '0')}`, 0, 38);
    ctx.restore();

    // Lower half: blocks share any spare height so short months don't leave a hole.
    const routes = (w.topRoutes || []).slice(0, 3);
    const rows = [['hours aboard', formatCount(w.hours ?? 0)]];
    if ((w.bestStreak ?? 0) > 1) rows.push(['longest streak', `${w.bestStreak} days`]);
    else if ((w.stops ?? 0) > 0) rows.push(['stops touched', formatCount(w.stops)]);
    const showBusiest = w.busiestDay && w.busiestDay.count > 1;
    const heights = [
        rows.length * 70,
        routes.length ? 44 + routes.length * 52 : 0,
        w.favoriteStop ? 92 : 0,
        showBusiest ? 36 : 0,
    ];
    const blocks = heights.filter(Boolean).length;
    const top = y + 205;
    const bottom = ty + th - 150 - 36;
    const gap = Math.max(14, Math.min(84, (bottom - top - heights.reduce((a, c) => a + c, 0)) / Math.max(1, blocks)));

    y = top;
    rows.forEach(([label, value]) => {
        leaderRow(ctx, { x: px, w: pw, y: y + 40, label, value });
        y += 70;
    });
    y += gap;

    if (routes.length) {
        ctx.textAlign = 'left';
        ctx.fillStyle = FADED;
        ctx.font = `400 28px ${MONO}`;
        ctx.fillText('routes ridden most', px, y + 20);
        y += 44;
        routes.forEach(route => {
            y += 52;
            ctx.fillStyle = INK;
            ctx.textAlign = 'left';
            ctx.font = `800 46px ${DISPLAY}`;
            ctx.fillText(ellipsize(ctx, route.name, 360), px, y - 8);
            ctx.textAlign = 'right';
            ctx.font = `400 32px ${MONO}`;
            ctx.fillText(`${route.count} ${plural(route.count, 'ride', 'rides')}`, px + pw, y - 8);
        });
        y += gap;
    }

    ctx.textAlign = 'left';
    if (w.favoriteStop) {
        ctx.fillStyle = FADED;
        ctx.font = `400 28px ${MONO}`;
        ctx.fillText('boarded most at', px, y + 20);
        ctx.fillStyle = INK;
        fitFont(ctx, w.favoriteStop.name, { weight: 800, size: 50, min: 32, family: DISPLAY, maxWidth: pw });
        ctx.fillText(w.favoriteStop.name, px, y + 76);
        y += 92 + gap;
    }
    if (showBusiest) {
        ctx.fillStyle = FADED;
        ctx.font = `400 28px ${MONO}`;
        ctx.fillText(`busiest day  ${w.busiestDay.label}, ${w.busiestDay.count} rides`, px, y + 20);
    }

    // Barcode and footer
    const rand = seeded(seedFor(w));
    let bx = px;
    const by = ty + th - 150;
    ctx.fillStyle = INK;
    while (bx < px + pw) {
        const bw = 3 + Math.floor(rand() * 3) * 3;
        if (rand() > 0.38) ctx.fillRect(bx, by, bw, 72);
        bx += bw + 3 + Math.floor(rand() * 4);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = FADED;
    ctx.font = `400 26px ${MONO}`;
    ctx.fillText(`${serialFor(w)}   transitstats.fyi`, W / 2, by + 118);
}

// Shown when nothing was ridden that month: a ticket that was never issued.
function drawEmptyBody(ctx, { px, pw, perfY, ty, th, w, W }) {
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    fitFont(ctx, 'no transfer', { weight: 900, size: 170, min: 90, family: DISPLAY, maxWidth: pw });
    ctx.fillText('no transfer', px - 6, perfY + 230);
    ctx.fillText('issued', px - 6, perfY + 400);

    ctx.fillStyle = FADED;
    ctx.font = `400 34px ${MONO}`;
    ctx.fillText(`no rides were logged in ${monthName(w).toLowerCase()}.`, px, perfY + 500);
    ctx.fillText('ride this month and your next', px, perfY + 590);
    ctx.fillText('transfer prints on the 1st.', px, perfY + 636);

    ctx.save();
    ctx.translate(px + pw - 130, perfY + 400);
    ctx.rotate(0.12);
    ctx.strokeStyle = STAMP;
    ctx.fillStyle = STAMP;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, -120, -56, 240, 112, 14);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = `800 44px ${DISPLAY}`;
    ctx.fillText('not valid', 0, 14);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.fillStyle = FADED;
    ctx.font = `400 26px ${MONO}`;
    ctx.fillText('transitstats.fyi', W / 2, ty + th - 60);
}
