import { db } from '../firebase.js';
import { isActiveTrip, isHistoryTrip } from '../shared/trip-stats.js';

/**
 * TripController - Manages the trip data stream.
 */
export const TripController = {
    allTrips: [],
    activeTrip: null,
    unsubscribe: null,

    listen(userId, onUpdate, onError) {
        if (!userId) return;
        if (this.unsubscribe) this.unsubscribe();

        this.unsubscribe = db.collection('trips')
            .where('userId', '==', userId)
            .orderBy('startTime', 'desc')
            .onSnapshot({ includeMetadataChanges: true }, snap => {
                const now = Date.now();
                const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Active is < 6h old and has no end time; history is finished,
                // discarded, or timed out. Same rule as the public profile.
                this.activeTrip = docs.find(t => isActiveTrip(t, now));
                this.allTrips = docs.filter(t => isHistoryTrip(t, now));

                if (onUpdate) onUpdate(this.allTrips, this.activeTrip);
            }, err => {
                console.error("TripController Error:", err);
                if (onError) onError(err);
            });
    },
};
