/**
 * MMS + prediction fill handlers.
 */
const {
  sendSmsReply,
} = require('./twilio');
const {
  setPendingState,
  getUserProfile,
  getRecentCompletedTrips,
  getStopsLibrary,
  isExperimentalIntelligenceEnabled,
  db,
} = require('./db');
const { getConfiguredPrimaryAgency } = require('./primary-agency');
const { NetworkEngine } = require('./network.js');
const { PredictionEngineV4 } = require('./predict_v4.js');
const { PredictionEngineV5 } = require('./predict_v5.js');
const {
  parseStopSignImage,
} = require('./gemini');
const logger = require('./logger');
const {
  correctPredictionByGtfs,
} = require('./handlers-utils');
const { handleTripLog } = require('./handlers-trip');
const { isModelReady } = require('./intelligence-eligibility');
const routeV4Meta = require('./model_v4_meta.json');
const routeV5Meta = require('./model_v5_meta.json');
const endStopV4Meta = require('./model_v4_endstop_meta.json');
const endStopV5Meta = require('./model_v5_endstop_meta.json');

/**
 * Run V4/V5 predictions for a trip that was created during stop disambiguation
 * (predictions are null at create time because the stop wasn't known yet).
 * Fire-and-forget — errors are logged but never surface to the user.
 */
async function fillPredictions(user, tripId, stopName, route, direction, agency, traceId = null) {
  try {
    const profile = await getUserProfile(user.userId);
    if (!(await isExperimentalIntelligenceEnabled(user.email))) return;
    const defaultAgency = getConfiguredPrimaryAgency(profile);

    const [history, stopsLibrary, networkGraph] = await Promise.all([
      getRecentCompletedTrips(user.userId, 200),
      getStopsLibrary(),
      NetworkEngine.load(db, user.userId, agency, route),
    ]);

    const now = new Date();
    const routeReady = isModelReady(history, agency, routeV4Meta, routeV5Meta);
    const endStopReady = isModelReady(history, agency, endStopV4Meta, endStopV5Meta, 'endStop');
    if (!routeReady && !endStopReady) return;
    const lastTrip = history.length > 0 ? history[0] : null;
    const lastEndStopName = lastTrip?.endStopName || null;
    const lastRoute = lastTrip?.route || null;
    const minutesSinceLastTrip = lastTrip?.startTime?.toDate
      ? Math.max(0, Math.round((now.getTime() - lastTrip.startTime.toDate().getTime()) / 60000))
      : null;
    const routeContext = {
      stopName,
      time: now,
      lastEndStopName,
      lastRoute,
      agency,
      stopsLibrary,
      primaryAgency: defaultAgency,
    };
    const endStopContext = {
      route,
      startStopName: stopName,
      direction,
      time: now,
      lastEndStopName,
      lastRoute,
      minutesSinceLastTrip,
      agency,
      primaryAgency: defaultAgency,
      stopsLibrary,
      networkGraph,
    };

    const [rawTopV4, rawTopV5, topV4, topV5] = await Promise.all([
      routeReady ? Promise.resolve(PredictionEngineV4.guessTopRoutes(routeContext, 5)) : [],
      routeReady ? PredictionEngineV5.guessTopRoutes(routeContext, 5) : [],
      endStopReady ? PredictionEngineV4.guessTopEndStops(endStopContext, 1) : [],
      endStopReady ? PredictionEngineV5.guessTopEndStops(endStopContext, 1) : [],
    ]);

    // No routesAtStop available here — apply confidence floor only
    const predictionV4 = correctPredictionByGtfs(rawTopV4, null);
    const predictionV5 = correctPredictionByGtfs(rawTopV5, null);

    const update = {};
    if (predictionV4) update.predictionV4 = predictionV4;
    if (predictionV5) update.predictionV5 = predictionV5;
    if (topV4.length > 0) update.endStopPredictionV4 = topV4[0];
    if (topV5.length > 0) update.endStopPredictionV5 = topV5[0];

    if (Object.keys(update).length > 0) {
      await db.collection('trips').doc(tripId).update(update);
    }
  } catch (err) {
    console.error('fillPredictions failed', err.message);
  }
}

/**
 * Handle an incoming MMS photo message — parse the stop sign and start a trip.
 * receivedAt is captured at the top of dispatch() so startTime reflects when
 * the photo was sent, not when AI processing finishes.
 */
async function handleMmsTrip(phoneNumber, user, mediaUrl, receivedAt, traceId = null) {
  // Validate and fetch in a single block so the allowlist check directly guards fetch().
  // CodeQL requires the guard and the sink to be in the same try block to resolve js/request-forgery.
  let imageBase64, mimeType;
  try {
    const parsedUrl = new URL(mediaUrl);
    const TRUSTED_TWILIO_HOSTS = ['api.twilio.com', 'media.twiliocdn.com', 'mms.twilio.com', 'mms.twiliocdn.com'];
    const isTwilioHost = TRUSTED_TWILIO_HOSTS.includes(parsedUrl.hostname);

    if (parsedUrl.protocol !== 'https:' || !isTwilioHost) {
      console.warn(`Rejected untrusted MMS media URL: ${parsedUrl.hostname}`);
      await sendSmsReply(phoneNumber, 'Could not load your photo. Try again or log by text:\n[Route]\n[Stop]');
      return;
    }

    // Re-construct the URL to ensure no bypass via components (js/request-forgery)
    const targetUrl = `https://${parsedUrl.hostname}${parsedUrl.pathname}${parsedUrl.search}`;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const response = await fetch(targetUrl, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mimeType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    imageBase64 = Buffer.from(buffer).toString('base64');
  } catch (err) {
    console.error('MMS image fetch failed', err.message);
    await sendSmsReply(phoneNumber, 'Could not load your photo. Try again or log by text:\n[Route]\n[Stop]');
    return;
  }

  // Parse the stop sign with Gemini Vision
  let parsed;
  try {
    parsed = await parseStopSignImage(imageBase64, mimeType, traceId);
  } catch (err) {
    console.error('MMS vision parsing failed', err.message);
    await sendSmsReply(phoneNumber, 'Could not read the stop sign. Try a clearer shot or log by text.');
    return;
  }

  if (!parsed || !parsed.routes || parsed.routes.length === 0) {
    await sendSmsReply(phoneNumber, 'No transit stop found in that photo. Try a closer shot of the sign.');
    return;
  }

  const stopInput = parsed.stopCode || parsed.stopName;

  // Routes found but no stop — ask for just the stop and pre-save routes
  if (!stopInput) {
    const userProfile2 = await getUserProfile(user.userId);
    const defaultAgency2 = getConfiguredPrimaryAgency(userProfile2);
    const { normalizeAgency: normalizeAg } = require('./utils');
    const candidates = parsed.routes.map(r => ({
      route: r.route,
      agency: r.agency ? normalizeAg(r.agency) : defaultAgency2,
    }));
    const routeList = candidates.map(r => r.route).join(' and ');
    await setPendingState(phoneNumber, {
      type: 'mms_stop_needed',
      routeCandidates: candidates,
      defaultAgency: defaultAgency2,
      receivedAt,
    });
    await sendSmsReply(phoneNumber, `Got ${routeList} — what stop are you at? (or DISCARD to cancel)`);
    return;
  }


  const userProfile = await getUserProfile(user.userId);
  const defaultAgency = getConfiguredPrimaryAgency(userProfile);

  const tripOptions = { parsed_by: 'mms', startTime: receivedAt, source: 'mms', timing_reliability: 'approximate' };

  if (parsed.routes.length === 1) {
    const { route, agency } = parsed.routes[0];
    const { normalizeAgency } = require('./utils');
    await handleTripLog(
      phoneNumber, user, stopInput, route, null,
      agency ? normalizeAgency(agency) : defaultAgency,
      tripOptions,
      traceId,
    );
    return;
  }

  // Multiple routes at this stop — ask user to pick
  const { normalizeAgency } = require('./utils');
  const candidates = parsed.routes.map(r => ({
    route: r.route,
    agency: r.agency ? normalizeAgency(r.agency) : defaultAgency,
  }));
  const list = candidates.map((r, i) => `${i + 1}. Route ${r.route}`).join('\n');
  const stopLabel = parsed.stopName || stopInput;

  await setPendingState(phoneNumber, {
    type: 'confirm_mms_route',
    stopInput,
    routeCandidates: candidates,
    defaultAgency,
    receivedAt,
  });
  await sendSmsReply(phoneNumber, `Multiple routes at ${stopLabel}:\n${list}\n\nWhich route? Reply with a number, or DISCARD to cancel.`);
}

module.exports = {
  fillPredictions,
  handleMmsTrip,
};
