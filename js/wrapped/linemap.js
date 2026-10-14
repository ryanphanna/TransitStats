// Concept B: top routes drawn as transit-map lines, stats as station labels.
import { roundRect, formatCount, plural, fitFont, ellipsize, monthName } from './util.js';

const SANS = '"Hanken Grotesk", "Helvetica Neue", Arial, sans-serif';
export const LINEMAP_FONTS = [`500 30px "Hanken Grotesk"`, `700 30px "Hanken Grotesk"`, `800 30px "Hanken Grotesk"`, `900 30px "Hanken Grotesk"`];

const BG = '#eef1f2';
const INK = '#14202b';
const FADED = '#5c6a75';
const LINES = ['#e0301e', '#0b6fc2', '#0f9d58'];
const GREY = '#8a96a0';

// Hand-laid paths: straight runs and 45 degree bends only. All three cross at the interchange.
const HUB = { x: 540, y: 960 };
const PATHS = [
    [[110, 740], [330, 740], [540, 950], [760, 1170], [960, 1170]],
    [[540, 520], [540, 960], [540, 1180], [380, 1340], [120, 1340]],
    [[970, 760], [740, 760], [540, 960], [320, 1180], [120, 1180]],
];

function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return total;
}

function pointAt(points, distance) {
    let left = distance;
    for (let i = 1; i < points.length; i++) {
        const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        if (left <= seg) {
            const t = seg ? left / seg : 0;
            return {
                x: points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
                y: points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
                dx: (points[i][0] - points[i - 1][0]) / (seg || 1),
                dy: (points[i][1] - points[i - 1][1]) / (seg || 1),
            };
        }
        left -= seg;
    }
    const last = points[points.length - 1];
    return { x: last[0], y: last[1], dx: 1, dy: 0 };
}

function strokePath(ctx, points, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
}

function haloText(ctx, text, x, y, color) {
    ctx.lineWidth = 12;
    ctx.strokeStyle = BG;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}

function stationLabel(ctx, { x, y, side, value, label }) {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = side === 'left' ? 'right' : 'left';
    const tx = x + (side === 'left' ? -34 : 34);
    ctx.font = `900 54px ${SANS}`;
    haloText(ctx, value, tx, y - 2, INK);
    ctx.font = `500 30px ${SANS}`;
    haloText(ctx, label, tx, y + 36, FADED);
}

export function drawLineMap(ctx, { displayName = 'Traveler', wrapped } = {}) {
    const W = 1080;
    const H = 1920;
    const w = wrapped || {};
    const name = String(displayName || 'Traveler').trim() || 'Traveler';

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    // Faint survey grid
    ctx.strokeStyle = 'rgba(20,32,43,0.06)';
    ctx.lineWidth = 2;
    for (let x = 60; x < W; x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 60; y < H; y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Title block
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `700 40px ${SANS}`;
    ctx.fillText('Transit Wrapped', 80, 130);
    fitFont(ctx, monthName(w) || 'This month', { weight: 900, size: 150, min: 80, family: SANS, maxWidth: 900 });
    ctx.fillText(monthName(w) || 'This month', 74, 280);
    ctx.fillStyle = FADED;
    ctx.font = `500 44px ${SANS}`;
    ctx.fillText(`${name}'s network, ${w.year}`, 80, 350);

    // Route lines
    const routes = (w.topRoutes || []).slice(0, 3);
    const lineSpecs = routes.length
        ? routes.map((route, i) => ({ route, color: LINES[i], points: PATHS[i] }))
        : [{ route: null, color: GREY, points: PATHS[0] }];

    const mostRides = Math.max(...lineSpecs.map(spec => spec.route?.count || 1));
    lineSpecs.forEach(spec => strokePath(ctx, spec.points, spec.color, 34));

    // Stops along each line: more rides, more stops drawn
    lineSpecs.forEach(spec => {
        const total = pathLength(spec.points);
        const share = (spec.route?.count || 1) / mostRides;
        const stops = Math.max(4, Math.round(4 + share * 6));
        for (let i = 0; i <= stops; i++) {
            const p = pointAt(spec.points, (total * i) / stops);
            if (Math.hypot(p.x - HUB.x, p.y - HUB.y) < 70) continue;
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = INK;
            ctx.lineWidth = 4;
            ctx.stroke();
        }
    });

    // Line badges at the starts
    lineSpecs.forEach(spec => {
        const start = spec.points[0];
        const text = spec.route ? String(spec.route.name) : 'imported';
        ctx.font = `900 40px ${SANS}`;
        const bw = Math.max(76, ctx.measureText(text).width + 40);
        ctx.fillStyle = spec.color;
        roundRect(ctx, start[0] - bw / 2, start[1] - 88, bw, 64, 32);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(text, start[0], start[1] - 42);
    });

    // Interchange ring: the favourite stop
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(HUB.x, HUB.y, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 12;
    ctx.stroke();

    // Station labels carrying the stats, placed in clear map space
    const labels = [
        { value: formatCount(w.trips ?? 0), label: plural(w.trips, 'ride', 'rides'), x: 80, y: 520 },
        { value: formatCount(w.hours ?? 0), label: 'hours aboard', x: 610, y: 560 },
        { value: formatCount(w.daysRidden ?? 0), label: plural(w.daysRidden, 'day ridden', 'days ridden'), x: 640, y: 1320 },
    ];
    labels.forEach(item => {
        ctx.textAlign = 'left';
        ctx.fillStyle = INK;
        ctx.font = `900 76px ${SANS}`;
        ctx.fillText(item.value, item.x, item.y);
        ctx.fillStyle = FADED;
        ctx.font = `500 32px ${SANS}`;
        ctx.fillText(item.label, item.x + 2, item.y + 40);
    });

    // Interchange label: the favourite stop
    if (w.favoriteStop) {
        ctx.textAlign = 'left';
        ctx.fillStyle = FADED;
        ctx.font = `500 30px ${SANS}`;
        ctx.fillText('boarded most at', 650, 925);
        fitFont(ctx, w.favoriteStop.name, { weight: 800, size: 44, min: 28, family: SANS, maxWidth: 400 });
        ctx.fillStyle = INK;
        ctx.fillText(w.favoriteStop.name, 650, 975);
    }

    // Key, drawn like a line diagram legend
    const keyY = 1450;
    ctx.fillStyle = '#fff';
    const factCount = Math.min(3, [w.busiestDay && w.busiestDay.count > 1, w.peak, (w.bestStreak ?? 0) > 1].filter(Boolean).length) || 1;
    const keyH = 110 + Math.max(lineSpecs.length * 62, factCount * 84) + 30;
    roundRect(ctx, 70, keyY, W - 140, keyH, 10);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `800 34px ${SANS}`;
    ctx.fillText('Lines this month', 110, keyY + 62);
    lineSpecs.forEach((spec, i) => {
        const y = keyY + 130 + i * 62;
        strokePath(ctx, [[110, y - 10], [190, y - 10]], spec.color, 22);
        ctx.fillStyle = INK;
        ctx.textAlign = 'left';
        ctx.font = `800 38px ${SANS}`;
        const text = spec.route ? String(spec.route.name) : 'imported rides';
        ctx.fillText(ellipsize(ctx, text, 260), 220, y);
        ctx.textAlign = 'right';
        ctx.font = `500 36px ${SANS}`;
        const count = spec.route?.count ?? w.trips ?? 0;
        ctx.fillText(`${formatCount(count)} ${plural(count, 'ride', 'rides')}`, 520, y);
    });

    const facts = [];
    if (w.busiestDay && w.busiestDay.count > 1) facts.push(['Busiest day', `${w.busiestDay.label}, ${w.busiestDay.count} rides`]);
    if (w.peak) facts.push(['Busiest time', w.peak.name.toLowerCase().replace(/^./, c => c.toUpperCase())]);
    if ((w.bestStreak ?? 0) > 1) facts.push(['Longest streak', `${w.bestStreak} days`]);
    if (!facts.length && (w.stops ?? 0) > 0) facts.push(['Stops touched', formatCount(w.stops)]);
    facts.slice(0, 3).forEach(([label, value], i) => {
        const y = keyY + 130 + i * 84;
        ctx.textAlign = 'left';
        ctx.fillStyle = FADED;
        ctx.font = `500 30px ${SANS}`;
        ctx.fillText(label, 560, y - 22);
        ctx.fillStyle = INK;
        ctx.font = `800 36px ${SANS}`;
        ctx.fillText(ellipsize(ctx, value, 420), 560, y + 14);
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = FADED;
    ctx.font = `500 30px ${SANS}`;
    ctx.fillText('transitstats.fyi', W / 2, 1860);
}
