import { requireAuth } from '../shared/auth-guard.js';
import { initHeader } from '../shared/header.js';
import { refreshIcons } from '../shared/icons.js';
import { Profile } from '../profile.js';
import { Trips } from '../trips.js';
import { RouteTracker } from '../route-tracker.js';

async function init() {
    const { user } = await requireAuth();
    await Profile.load(user);
    initHeader({ currentPage: 'routes', routesHref: '/routes', leaderboardHref: '/leaderboard' });
    await Trips.init();
    await Trips._readyPromise;
    await RouteTracker.render(document.getElementById('route-tracker-content'));
    refreshIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
