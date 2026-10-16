// Dev-only sample data for /recap?demo=1. Never imported in production builds.
const add = (list, date, route, from, to, duration) =>
    list.push({ startTime: date, route, startStopName: from, endStopName: to, duration });

export function demoTrips() {
    const trips = [];
    for (let day = 1; day <= 30; day++) {
        if (day % 3 === 0) continue;
        add(trips, new Date(2026, 8, day, 8, 15), day % 4 ? '501' : '504',
            'Spadina Ave at Dundas St W', 'Bathurst St at King St W', 18 + (day % 7));
        add(trips, new Date(2026, 8, day, 17, 40), '501',
            'Bathurst St at King St W', 'Spadina Ave at Dundas St W', 21);
        if (day % 5 === 0) add(trips, new Date(2026, 8, day, 23, 50), '2', 'Kipling Station', 'Bloor-Yonge Station', 35);
    }
    for (let day = 1; day <= 9; day++) {
        add(trips, new Date(2026, 7, day * 3, 9), '29', 'Wilson Station', 'Dufferin Mall', 14);
    }
    return trips;
}

export function demoPrestoRides() {
    return [1, 2, 3, 4, 5].map(i => ({ startTime: new Date(2026, 8, 10 + i, 7, 30), agency: 'GO' }));
}
