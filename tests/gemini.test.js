const { aggregateTripStats } = require('../functions/lib/gemini');

describe('Gemini aggregateTripStats', () => {
  const mockTrips = [
    {
      route: '501',
      startStopName: 'Union',
      endStopName: 'King',
      startTime: new Date('2026-03-20T08:00:00Z'),
      duration: 10,
    },
    {
      route: '501',
      startStopName: 'Union',
      endStopName: 'King',
      startTime: new Date('2026-03-21T08:05:00Z'),
      duration: 12,
    },
    {
      route: '510',
      startStopName: 'Spadina',
      endStopName: 'Dundas',
      startTime: new Date('2026-03-22T15:00:00Z'),
      duration: 20,
    },
  ];

  test('calculates basic stats correctly', () => {
    const stats = aggregateTripStats(mockTrips);
    expect(stats.total).toBe(3);
    expect(stats.routeStats).toHaveLength(2);
    expect(stats.routeStats[0].route).toBe('501');
    expect(stats.routeStats[0].count).toBe(2);
  });

  test('calculates boarding/exit stop counts', () => {
    const stats = aggregateTripStats(mockTrips);
    expect(stats.boardingStops).toContainEqual({ stop: 'Union', count: 2 });
    expect(stats.boardingStops).toContainEqual({ stop: 'Spadina', count: 1 });
    expect(stats.exitStops).toContainEqual({ stop: 'King', count: 2 });
  });

  test('groups by time of day', () => {
    const stats = aggregateTripStats(mockTrips, 'America/Toronto');
    expect(stats.timeOfDay.night).toBe(2);
    expect(stats.timeOfDay.midday).toBe(1);
    const total = stats.timeOfDay.morning + stats.timeOfDay.midday + stats.timeOfDay.afternoon +
                  stats.timeOfDay.evening + stats.timeOfDay.night;
    expect(total).toBe(3);
  });

  test('includes full stop list', () => {
    const stats = aggregateTripStats(mockTrips);
    expect(stats.allStops).toContain('Union');
    expect(stats.allStops).toContain('King');
    expect(stats.allStops).toContain('Spadina');
    expect(stats.allStops).toContain('Dundas');
    expect(stats.allStops).toHaveLength(4);
  });

  test('handles trips without duration', () => {
    const trip = { route: '501', startStopName: 'Union', startTime: new Date() };
    const stats = aggregateTripStats([trip]);
    expect(stats.total).toBe(1);
    expect(stats.routeStats[0].avgDuration).toBeNull();
  });

  test('handles incomplete trip fields', () => {
    const trip = { startTime: null }; // No route, no stop
    const stats = aggregateTripStats([trip]);
    expect(stats.total).toBe(1);
    expect(stats.routeStats[0].route).toBe('Unknown');
    expect(stats.routeStats).toHaveLength(1);
  });

  test('includes day of week breakdown', () => {
    const stats = aggregateTripStats(mockTrips);
    const total = Object.values(stats.dayOfWeek).reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
    expect(typeof stats.dayOfWeek).toBe('object');
    const validDays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    Object.keys(stats.dayOfWeek).forEach(day => expect(validDays).toContain(day));
  });

  test('includes window date range', () => {
    const stats = aggregateTripStats(mockTrips);
    expect(stats.windowStart).toBe('2026-03-20');
    expect(stats.windowEnd).toBe('2026-03-22');
  });

  test('returns null window dates for empty trips', () => {
    const stats = aggregateTripStats([]);
    expect(stats.windowStart).toBeNull();
    expect(stats.windowEnd).toBeNull();
  });

  test('uses requested timezone for day-of-week bucketing', () => {
    const trip = {
      route: 'A',
      startStopName: 'Start',
      endStopName: 'End',
      startTime: new Date('2026-03-20T00:30:00Z'),
      duration: 15,
    };

    const toronto = aggregateTripStats([trip], 'America/Toronto');
    const tokyo = aggregateTripStats([trip], 'Asia/Tokyo');

    expect(toronto.dayOfWeek.Thursday).toBe(1);
    expect(tokyo.dayOfWeek.Friday).toBe(1);
  });
});
