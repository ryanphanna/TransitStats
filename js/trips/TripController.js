import { db } from '../firebase.js';

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

        const sixHoursMs = 6 * 60 * 60 * 1000;

        this.unsubscribe = db.collection('trips')
            .where('userId', '==', userId)
            .orderBy('startTime', 'desc')
            .onSnapshot({ includeMetadataChanges: true }, snap => {
                const now = Date.now();
                const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Filter Active vs Completed (Active is < 6h old and has no end time)
                this.activeTrip = docs.find(t => {
                    if (t.endTime || t.discarded) return false;
                    const startTime = t.startTime?.toDate ? t.startTime.toDate().getTime() : new Date(t.startTime).getTime();
                    return (now - startTime) < sixHoursMs;
                });

                // Completed trips or those that timed out
                this.allTrips = docs.filter(t => 
                    t.endTime || 
                    t.discarded || 
                    (now - (t.startTime?.toDate ? t.startTime.toDate().getTime() : new Date(t.startTime).getTime())) >= sixHoursMs
                );

                if (onUpdate) onUpdate(this.allTrips, this.activeTrip);
            }, err => {
                console.error("TripController Error:", err);
                if (onError) onError(err);
            });
    },
};
