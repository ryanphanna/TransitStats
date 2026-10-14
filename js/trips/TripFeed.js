import { Utils } from '../utils.js';
import { UI } from '../ui-utils.js';
import { TripController } from './TripController.js';
import { getTripRouteLabel, getTripStatusLabel, getTripStopLabel } from '../trip-display.js';

/**
 * TripFeed - Manages the UI rendering for the trip cards and feed.
 */
export const TripFeed = {
    _visibleCount: 20,
    _PAGE_SIZE: 20,

    render(container, trips, onEdit, reset = false) {
        if (!container) return;
        if (!trips || trips.length === 0) {
            container.innerHTML = '<div class="loading-state">No trips yet.</div>';
            return;
        }

        if (reset) this._visibleCount = this._PAGE_SIZE;

        container.innerHTML = '';
        const visible = trips.slice(0, this._visibleCount);

        for (let i = 0; i < visible.length;) {
            const trip = visible[i];
            const group = trip.journeyId ? [trip] : [];

            while (
                group.length > 0 &&
                i + group.length < visible.length &&
                visible[i + group.length].journeyId === trip.journeyId
            ) {
                group.push(visible[i + group.length]);
            }

            if (group.length > 1) {
                container.appendChild(this._createJourneyGroup(group, onEdit));
                i += group.length;
                continue;
            }

            container.appendChild(this._createCard(trip, onEdit));
            i++;
        }

        if (this._visibleCount < trips.length) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-outline full-width mt-3';
            const remaining = (trips.length - this._visibleCount).toLocaleString('en-US');
            btn.textContent = `Show more (${remaining} remaining)`;
            btn.addEventListener('click', () => {
                this._visibleCount += this._PAGE_SIZE;
                this.render(container, trips, onEdit);
            });
            container.appendChild(btn);
        }

        if (window.lucide) lucide.createIcons();
    },

    _createJourneyGroup(trips, onEdit) {
        const group = document.createElement('div');
        group.className = 'journey-group';
        group.innerHTML = `
            <div class="journey-group-header">
                <span>Connected journey</span>
                <span>${trips.length.toLocaleString('en-US')} legs</span>
            </div>
        `;

        trips.forEach((trip, index) => {
            group.appendChild(this._createCard(trip, onEdit));
            const next = trips[index + 1];
            if (next) group.appendChild(this._createConnector(trip, next));
        });

        return group;
    },

    _createCard(trip, onEdit) {
        const card = document.createElement('div');
        card.className = `trip-card ${trip.needs_review ? 'trip-needs-review' : ''}`;

        const startTime = trip.startTime?.toDate ? trip.startTime.toDate() : new Date(trip.startTime || Date.now());
        const dateStr = isNaN(startTime.getTime()) ? '—' : startTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        const startStop = Utils.normalizeIntersectionStop(getTripStopLabel(trip, 'boarding'));
        const endStop = Utils.normalizeIntersectionStop(getTripStopLabel(trip, 'exiting'));
        const route = getTripRouteLabel(trip);
        const status = getTripStatusLabel(trip);
        const duration = parseInt(trip.duration, 10);
        const hasDuration = !trip.incomplete && Number.isFinite(duration) && duration > 0;

        const dirAbbr = { Northbound: 'NB', Southbound: 'SB', Eastbound: 'EB', Westbound: 'WB', Inbound: 'IB', Outbound: 'OB' };
        const direction = trip.direction ? (dirAbbr[trip.direction] || trip.direction) : '';

        card.innerHTML = `
            ${trip.needs_review ? `
                <div class="trip-review-banner">
                    <i data-lucide="alert-triangle"></i>
                    <span>Unrecognized route — confirm validity.</span>
                    <div class="trip-review-actions">
                        <button class="btn btn-sm btn-outline btn-confirm-trip">Confirm</button>
                        <button class="btn btn-sm btn-danger-outline btn-delete-trip">Discard</button>
                    </div>
                </div>
            ` : ''}
            <div class="trip-card-body">
                <div class="trip-info">
                    <div class="trip-main">
                        <div class="trip-route-pill">${Utils.hide(route)}</div>
                        <div class="trip-path">
                            <span class="stop-name">${Utils.hide(startStop)}</span>
                            <span class="path-arrow">→</span>
                            <span class="stop-name">${Utils.hide(endStop)}</span>
                        </div>
                    </div>
                    <button class="btn-edit-trip" title="Edit Parameters"><i data-lucide="edit-3"></i></button>
                </div>
                <div class="trip-meta text-right">
                    <div class="trip-date">${Utils.hide(dateStr)}</div>
                    ${status ? `<div class="trip-status text-xxs">${Utils.hide(status)}</div>` : ''}
                    ${direction ? `<div class="trip-direction font-bold text-xxs">${Utils.hide(direction)}</div>` : ''}
                    ${trip.vehicle ? `<div class="trip-vehicle text-xxs opacity-70">${Utils.hide(trip.vehicle)}</div>` : ''}
                    ${hasDuration ? `<div class="trip-duration text-secondary text-xs">${duration} min</div>` : ''}
                </div>
            </div>
        `;

        // Interaction Handlers
        card.querySelector('.btn-edit-trip').addEventListener('click', () => onEdit(trip));

        if (trip.needs_review) {
            card.querySelector('.btn-confirm-trip').addEventListener('click', () => TripController.confirmTrip(trip.id));
            let deleteArmed = false;
            let deleteTimer = null;
            card.querySelector('.btn-delete-trip').addEventListener('click', (e) => {
                const btn = e.currentTarget;
                if (!deleteArmed) {
                    deleteArmed = true;
                    btn.textContent = 'Confirm Discard';
                    btn.classList.add('btn-danger');
                    btn.classList.remove('btn-danger-outline');
                    deleteTimer = setTimeout(() => {
                        deleteArmed = false;
                        btn.textContent = 'Discard';
                        btn.classList.remove('btn-danger');
                        btn.classList.add('btn-danger-outline');
                    }, 3000);
                    return;
                }
                clearTimeout(deleteTimer);
                deleteArmed = false;
                TripController.delete(trip.id);
            });
        }

        return card;
    },

    _createConnector(later, earlier) {
        const el = document.createElement('div');
        el.className = 'journey-connector';

        let gapStr = 'Transfer';
        try {
            const lStart = later.startTime?.toDate ? later.startTime.toDate() : new Date(later.startTime);
            const eEnd = earlier.endTime?.toDate ? earlier.endTime.toDate() : new Date(earlier.endTime);
            const gapMin = Math.round((lStart - eEnd) / 60000);
            gapStr = gapMin < 1 ? 'Transfer · <1 min' : `Transfer · ${gapMin} min`;
        } catch (_) {}

        el.innerHTML = `
            <div class="journey-line"></div>
            <div class="journey-badge">
                <span class="text-xxs">${gapStr}</span>
                <button class="btn-break-journey" title="Unlink journey" aria-label="Unlink journey">Unlink</button>
            </div>
            <div class="journey-line"></div>
        `;

        const unlinkButton = el.querySelector('.btn-break-journey');
        let unlinkArmed = false;
        let unlinkTimer = null;

        const resetUnlinkButton = () => {
            unlinkArmed = false;
            unlinkButton.disabled = false;
            unlinkButton.classList.remove('confirming');
            unlinkButton.title = 'Unlink journey';
            unlinkButton.setAttribute('aria-label', 'Unlink journey');
            unlinkButton.textContent = 'Unlink';
        };

        unlinkButton.addEventListener('click', async () => {
            if (!unlinkArmed) {
                unlinkArmed = true;
                unlinkButton.classList.add('confirming');
                unlinkButton.title = 'Tap again to unlink journey';
                unlinkButton.setAttribute('aria-label', 'Tap again to unlink journey');
                unlinkButton.textContent = 'Tap again';
                unlinkTimer = setTimeout(resetUnlinkButton, 3000);
                return;
            }

            clearTimeout(unlinkTimer);
            unlinkArmed = false;
            unlinkButton.disabled = true;
            unlinkButton.textContent = 'Unlinking…';
            try {
                await TripController.breakJourneyLink(later.id, earlier.id);
            } catch (error) {
                resetUnlinkButton();
                UI.showNotification('Could not unlink these trips. Please try again.');
            }
        });

        return el;
    }
};
