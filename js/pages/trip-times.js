import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { Trips } from '../trips.js';
import { TripController } from '../trips/TripController.js';
import { PredictionEngine } from '../predict.js';
import { buildTripPairs, summarizePair } from '../trip-times.js';

const statusEl = document.getElementById('trip-times-status');
const resultsEl = document.getElementById('trip-times-results');
const routeSelect = document.getElementById('trip-times-route');
const startSelect = document.getElementById('trip-times-start');
const endSelect = document.getElementById('trip-times-end');

let pairs = [];
let selectedKey = null;

const minutes = value => (value === null || value === undefined ? '–' : String(Math.round(value)));
const tripWord = n => `${n} ${n === 1 ? 'trip' : 'trips'}`;

function setStatus(message) {
    statusEl.textContent = message;
    statusEl.hidden = !message;
}

// Options are built with textContent: route and stop names are user data.
function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(({ value: v, label }) => {
        const option = document.createElement('option');
        option.value = v;
        option.textContent = label;
        return option;
    }));
    select.value = value;
    select.disabled = options.length === 0;
}

function uniqueBy(list, keyOf) {
    const seen = new Map();
    list.forEach(item => { if (!seen.has(keyOf(item))) seen.set(keyOf(item), item); });
    return [...seen.values()];
}

function routeLabel(pair, showAgency) {
    const variants = pair.variants.filter(v => v !== pair.route);
    const base = variants.length ? `${pair.route} (with ${variants.join(', ')})` : pair.route;
    return showAgency && pair.agency ? `${base} · ${pair.agency}` : base;
}

function renderPicker() {
    const selected = pairs.find(p => p.key === selectedKey) || pairs[0];
    selectedKey = selected.key;
    const showAgency = new Set(pairs.map(p => p.agency || '')).size > 1;

    // Pairs are sorted most-ridden first, so the first pair per route/start/end is the busiest.
    const routes = uniqueBy(pairs, p => p.routeKey);
    fillSelect(routeSelect, routes.map(p => ({ value: p.routeKey, label: routeLabel(p, showAgency) })), selected.routeKey);

    const onRoute = pairs.filter(p => p.routeKey === selected.routeKey);
    fillSelect(startSelect, uniqueBy(onRoute, p => p.startKey).map(p => ({ value: p.startKey, label: p.startLabel })), selected.startKey);

    const fromStart = onRoute.filter(p => p.startKey === selected.startKey);
    fillSelect(endSelect, uniqueBy(fromStart, p => p.endKey).map(p => ({ value: p.endKey, label: p.endLabel })), selected.endKey);
}

function renderResults() {
    const pair = pairs.find(p => p.key === selectedKey);
    if (!pair) return;
    const summary = summarizePair(pair);

    document.getElementById('trip-times-median').textContent = minutes(summary.median);
    document.getElementById('trip-times-count').textContent = `Based on ${tripWord(summary.count)}`;
    document.getElementById('trip-times-middle').textContent = `${minutes(summary.p25)}–${minutes(summary.p75)}`;
    document.getElementById('trip-times-fastest').textContent = minutes(summary.fastest);
    document.getElementById('trip-times-slowest').textContent = minutes(summary.slowest);

    const list = document.getElementById('trip-times-buckets');
    list.replaceChildren(...summary.timeOfDay.map(row => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'trip-times-bucket-name';
        name.textContent = row.label;
        const hours = document.createElement('small');
        hours.textContent = row.hours;
        name.append(hours);
        const value = document.createElement('strong');
        value.textContent = `${minutes(row.median)} min`;
        const count = document.createElement('span');
        count.className = 'trip-times-bucket-count';
        count.textContent = tripWord(row.count);
        item.append(name, value, count);
        return item;
    }));
    document.getElementById('trip-times-buckets-empty').hidden = summary.timeOfDay.length > 0;

    const variants = pair.variants.filter(v => v !== pair.route);
    document.getElementById('trip-times-note').textContent = variants.length
        ? `Includes trips logged as ${pair.variants.join(', ')}.`
        : '';
    resultsEl.hidden = false;
}

function render(trips) {
    pairs = buildTripPairs(trips, {
        canonicalizeStop: (name, agency) => PredictionEngine._canonicalizeStop(name, agency),
    });
    if (!pairs.length) {
        resultsEl.hidden = true;
        [routeSelect, startSelect, endSelect].forEach(select => fillSelect(select, [], ''));
        setStatus('No finished trips with a route, a start stop and an end stop yet.');
        return;
    }
    setStatus('');
    renderPicker();
    renderResults();
}

function choose(match) {
    const pair = pairs.find(match);
    if (pair) selectedKey = pair.key;
    renderPicker();
    renderResults();
}

routeSelect.addEventListener('change', () => choose(p => p.routeKey === routeSelect.value));
startSelect.addEventListener('change', () => choose(p => p.routeKey === routeSelect.value && p.startKey === startSelect.value));
endSelect.addEventListener('change', () => choose(p => p.routeKey === routeSelect.value && p.startKey === startSelect.value && p.endKey === endSelect.value));

async function init() {
    const { user } = await requireAuth({ returnToPage: true });
    initHeader({ currentPage: 'trip-times', showRecap: true, showTripTimes: true });

    TripController.listen(user.uid, render, err => {
        console.error('Trip times failed to load trips:', err);
        setStatus('Your trips could not be loaded. Check your connection and refresh to try again.');
    });
    // Stop names group through the stops library, so regroup once it is in.
    await Trips.loadStopsLibrary();
    if (TripController.allTrips?.length) render(TripController.allTrips);
}

init().catch(error => {
    console.error('Trip times failed to load:', error);
    setStatus('Trip times could not load. Return to your dashboard and try again.');
});
