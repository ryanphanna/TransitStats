/**
 * Every user-facing text reply, in one place, so wording can be reviewed
 * together. Fixed texts are constants; texts that fill in details are small
 * functions that take already-formatted values (route and stop displays,
 * durations) and return the finished string.
 *
 * test_sms_text.js checks every export here for first-person wording.
 * test_sms_text.js also fails if a handler sends an inline string literal.
 */

// --- Help and status ---

const HELP_COMMANDS = [
  'STATUS - view active trip',
  'STATS - your last 30 days',
  'FORGOT - forgot to end a trip',
  'DISCARD - didn\'t board, delete the trip',
  'UNLINK - separate a linked journey',
  'SETTINGS - view/change settings',
];
const HELP_ASK_COMMAND = 'ASK [question] - AI stats';

function helpText(commands) {
  return `TransitStats

To start a trip, send:

ROUTE STOP DIRECTION
or on separate lines:
ROUTE
STOP NAME
DIRECTION (optional)
AGENCY (optional)

To end a trip, send:
END
WHERE YOU GOT OFF
NOTES (optional)

Commands:
${commands.join('\n')}`;
}

function activeTripStatus(routeDisplay, startStopDisplay, timeStr, elapsedMin) {
  return `Active trip:
${routeDisplay} from ${startStopDisplay}
Started ${timeStr} (${elapsedMin} min ago)

END [stop] to finish. FORGOT if you forgot to end. INFO for help.`;
}

// --- Trip commands (DISCARD, NOTES, UNLINK, FORGOT) ---

const NO_ACTIVE_TRIP = 'No active trip.';
const NOTES_USAGE = 'Send NOTES followed by your note text.';
const NO_TRIP_FOR_NOTES = 'No recent completed trip to attach notes to.';
const NO_LINKED_TRIP = 'No linked trip to unlink.';

function tripDeleted(routeDisplay) {
  return `Deleted ${routeDisplay}.`;
}

function notesAdded(routeDisplay) {
  return `Added notes to ${routeDisplay}.`;
}

function journeyUnlinked(routeDisplay) {
  return `Unlinked ${routeDisplay} journey.`;
}

function tripSavedIncomplete(routeDisplay) {
  return `${routeDisplay} saved as incomplete.`;
}

// --- REGISTER and phone confirmation ---

const INVALID_EMAIL_FORMAT = 'Invalid email format. Text REGISTER [email].';
const NO_PENDING_REGISTRATION = 'No pending registration.';
const TOO_MANY_ATTEMPTS = 'Too many failed attempts. Try again in 10 minutes.';
const INVALID_CODE = 'Invalid code.';
const ACCOUNT_NOT_FOUND = 'Account not found.';
const PHONE_LINKED = 'Phone linked! Text "[route] [stop]" to log trips.';
const REGISTER_FROM_PHONE = 'To link a phone, text REGISTER from that phone.';

function phoneAlreadyLinked(email) {
  return `Phone already linked to ${email}.`;
}

function tooManyAttemptsTryIn(minutesLeft) {
  return `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`;
}

function registerCodeSent(email) {
  return `Code sent to ${email}. Reply with the 6-digit code within 20 minutes.`;
}

// Replies an unconfirmed number (see phone-confirmation.js) can get.
const UNLOCK_PROMPT_TEXT = 'A code was emailed to you. Reply with it to unlock that.';
const UNLOCK_UNAVAILABLE_TEXT = 'That isn\'t available on this number yet.';
const UNLOCKED_TEXT = 'Unlocked. You can use every command from this number now.';
const EMAIL_NOT_FOUND_TEXT = 'No account found for that email. Try the one you signed in with, or visit transitstats.fyi.';
const LINKED_NEUTRAL_TEXT = 'This number is already linked to an account.';
// Shown on the website's phone sign-in (an HTTP error), not sent as a text.
const OTP_UNCONFIRMED_TEXT = 'This number isn\'t unlocked yet. Text TransitStats, then reply with the emailed code.';
// Neutral on purpose: it must not reveal whether the owner has a trip running.
const LOCKED_TRIP_TEXT = 'Couldn\'t do that from this number right now.';

// --- Invite setup (sms-invite.js) ---

const WELCOME_TEXT = [
  'Next stop: TransitStats. You\'re in! Two ways to add trips:',
  '1. Text them here as you ride, like \'504 King to Spadina\'',
  '2. Import your PRESTO history at transitstats.fyi/import',
  'Reply STOP to opt out.',
].join('\n');

const SETUP_TEXT = 'You\'re all set! Text your trips here as you ride, like \'504 King to Spadina\'. '
  + 'A sign-in link for the website was also emailed to you.';
const CONFIRM_TEXT = 'Almost there! A 6-digit code was emailed to the address on your account. Reply with it to finish setting up.';
const SETUP_PROBLEM_TEXT = 'Could not finish setting up this number. Please get in touch for help.';
const NOT_INVITED_TEXT = 'This number isn\'t linked to a TransitStats account yet. Text REGISTER and your account email to link it.';

// --- Phone sign-in code (otp.js) ---

function otpLoginCode(code) {
  return `Your TransitStats login verification code is: ${code}.\n\nThis code expires in 10 minutes.\n\n@transitstats.fyi #${code}`;
}

// --- Emails (the `message` field of a mail document) ---

function registerCodeEmail(code) {
  return {
    subject: 'TransitStats SMS Verification Code',
    text: `Your code is: ${code}\n\nReply to SMS with this code.`,
    html: `<p>Your code is: <strong>${code}</strong></p>`,
  };
}

function signInEmail(link) {
  return {
    subject: 'Your TransitStats sign-in link',
    text: `Your TransitStats account is ready. Open this link to sign in on the website:\n\n${link}\n\nYou can also just text your trips to the TransitStats number.`,
    html: `<p>Your TransitStats account is ready. <a href="${link}">Sign in on the website</a>.</p><p>You can also just text your trips to the TransitStats number.</p>`,
  };
}

function phoneCodeEmail(code) {
  return {
    subject: 'Your TransitStats text code',
    text: `Your code is: ${code}\n\nReply to the text message with this code to finish connecting your phone. If this wasn't you, ignore this email.`,
    html: `<p>Your code is: <strong>${code}</strong></p><p>Reply to the text message with this code to finish connecting your phone. If this wasn't you, ignore this email.</p>`,
  };
}

// --- SETTINGS ---

const AGENCY_SET_AUTOMATIC = 'Primary agency set to automatic detection.';
const SETTINGS_USAGE = 'Usage: SETTINGS AGENCY [name|AUTO]\nExample: SETTINGS AGENCY GO Transit';

function settingsSummary(currentAgency) {
  return `Settings:\nPrimary agency: ${currentAgency}\n\nTo change: SETTINGS AGENCY [name]\nUse SETTINGS AGENCY AUTO to detect it automatically.\nExample: SETTINGS AGENCY GO Transit`;
}

function unknownAgency(name) {
  return `Unknown agency "${name}". Try: TTC, GO Transit, MiWay, YRT, OC Transpo, etc.`;
}

function agencySet(agency) {
  return `Primary agency set to ${agency}.`;
}

// --- Starting a trip ---

const BOARDING_STOP_UNKNOWN = 'Could not identify the boarding stop. Send the route and stop again.';
const AGENCY_UNKNOWN = 'Could not identify the transit agency. Include it on a new line, such as TTC or GO Transit.';
const TRIP_START_FAILED = 'Could not start your trip. Please try again.';

/** Appended to a stop when the trip's agency isn't the rider's default. */
function viaAgency(agency) {
  return ` via ${agency}`;
}

function tripStarted(routeDisplay, stopDisplay, agencySuffix) {
  return `Started ${routeDisplay} from ${stopDisplay}${agencySuffix}.`;
}

function startedAfterIncomplete(oldRouteDisplay, routeDisplay, stopDisplay, agencySuffix) {
  return `${oldRouteDisplay} marked as incomplete.\n\nStarted ${routeDisplay} from ${stopDisplay}${agencySuffix}.`;
}

/** A new trip arrived while another is still active. */
function activeTripConflict(stale, activeRouteDisplay, activeStopDisplay, elapsedMin, newRouteDisplay, newStopDisplay) {
  const timePhrase = `${elapsedMin} min ago`;
  const promptPrefix = stale
    ? `${activeRouteDisplay} from ${activeStopDisplay} looks like it ended (started ${timePhrase}).`
    : `${activeRouteDisplay} from ${activeStopDisplay} was not ended (started ${timePhrase}).`;

  return `${promptPrefix}

START to begin ${newRouteDisplay} from ${newStopDisplay}, and save ${activeRouteDisplay} from ${activeStopDisplay} as incomplete.

FORGOT to save as incomplete. DISCARD to cancel new trip.`;
}

/** End-of-reply prompt after a trip start, listing up to three likely end stops. */
function endStopPrompt(stops) {
  stops = stops || [];
  if (stops.length === 0) {
    return '\n\nEND [stop] to finish. FORGOT if forgot to end.';
  }

  if (stops.length === 1) {
    return `\n\nHeading to ${stops[0]}? END 1 to end.\n\nEND [stop] to finish. FORGOT if forgot to end.`;
  }

  const predLines = stops.map((stop, i) => `${i + 1}. ${stop}`).join('\n');
  const shortcuts = stops.map((_, i) => `END ${i + 1}`).join(', ');
  const lastComma = shortcuts.lastIndexOf(', ');
  const shortcutStr = lastComma >= 0
    ? shortcuts.slice(0, lastComma) + ', or ' + shortcuts.slice(lastComma + 2)
    : shortcuts;
  return `\n\nWhere to?\n${predLines}\n\n${shortcutStr} to end.\n\nEND [stop] to finish. FORGOT if forgot to end.`;
}

const ACHIEVEMENT_MILESTONES = {
  1: '🎉 Your 1st trip! Welcome to the network.',
  10: '🔟 Your 10th trip! Frequent Rider status.',
  25: '🏅 Your 25th trip! System Regular status.',
  50: '🥈 Your 50th trip! Commuter Pro status.',
  100: '🥇 Your 100th trip! Network Veteran status.',
  250: '👑 Your 250th trip! Elite Commuter status.',
  500: '🏟️ Your 500th trip! System Analyst status.',
  1000: '🌌 Your 1,000th trip! Transit Authority status.',
};

/** Milestone note for a trip count, or '' when the count isn't a milestone. */
function achievementNote(tripCount) {
  return ACHIEVEMENT_MILESTONES[tripCount] ? `\n\n${ACHIEVEMENT_MILESTONES[tripCount]}` : '';
}

// --- Choosing an agency or stop ---

const AGENCY_CHOICE_REMINDER = 'Reply 1 or 2 to select an agency, SKIP for default, or DISCARD to cancel.';
const STOP_SKIPPED = 'No problem — trip continues.\n\nEND [stop] to finish.';

function agencyChoicePrompt(stopDisplay, lastAgency, defaultAgency) {
  return `Which ${stopDisplay}?
1. ${lastAgency}
2. ${defaultAgency}

Reply 1, 2, or SKIP to use default.`;
}

/** candidates: [{ name, code }] in the order they are numbered. */
function stopMatchesMultiple(routeDisplay, stopDisplay, candidates) {
  const candidateList = candidates
    .map((candidate, index) => `${index + 1}. ${candidate.name}${candidate.code ? ` (${candidate.code})` : ''}`)
    .join('\n');
  return `${routeDisplay} started from ${stopDisplay}, which matches more than one stop:\n${candidateList}\nReply with a number to set the stop, SKIP to leave it unverified, or DISCARD to cancel the trip.`;
}

function stopSet(stopName) {
  return `Stop set to ${stopName}.\n\nEND [stop] to finish. FORGOT if you forgot to end.`;
}

// --- Pending prompts (dispatcher.js) ---

const TRIP_CANCELLED = 'Trip cancelled.';
const CHOICE_EXPIRED = 'That choice expired, so there is nothing to select. Text STATUS to check your trip.';
const NOT_UNDERSTOOD = 'Could not understand. Try:\n[Route]\n[Stop]';

function newTripCancelled(activeRouteDisplay, activeStopDisplay) {
  return `New trip cancelled. ${activeRouteDisplay} from ${activeStopDisplay} still active.\n\n` +
    'END [stop] to finish. FORGOT if you forgot to end.';
}

function activeSavedNewCancelled(activeRouteDisplay, activeStopDisplay) {
  return `${activeRouteDisplay} from ${activeStopDisplay} saved as incomplete. New trip cancelled.`;
}

function confirmStartReminder(newTripDisplay) {
  return `Reply START to begin ${newTripDisplay}, DISCARD to cancel, or FORGOT to save existing trip as incomplete.`;
}

// --- Photo (MMS) trips ---

const PHOTO_LOAD_FAILED = 'Could not load your photo. Try again or log by text:\n[Route]\n[Stop]';
const STOP_SIGN_UNREADABLE = 'Could not read the stop sign. Try a clearer shot or log by text.';
const NO_STOP_IN_PHOTO = 'No transit stop found in that photo. Try a closer shot of the sign.';

function numberedRouteList(routes) {
  return routes.map((route, i) => `${i + 1}. Route ${route}`).join('\n');
}

function mmsStopNeeded(routes) {
  return `Got ${routes.join(' and ')} — what stop are you at? (or DISCARD to cancel)`;
}

function mmsMultipleRoutes(stopLabel, routes) {
  return `Multiple routes at ${stopLabel}:\n${numberedRouteList(routes)}\n\nWhich route? Reply with a number, or DISCARD to cancel.`;
}

function mmsWhichRoute(routes) {
  return `Which route?\n${numberedRouteList(routes)}\nor DISCARD to cancel`;
}

function mmsRouteReminder(count) {
  return `Reply with a number (1–${count}) to select a route, or DISCARD to cancel.`;
}

// --- Ending a trip ---

const NO_ACTIVE_TRIP_TO_END = 'No active trip to end.';
const END_TRIP_FAILED = 'Could not end your trip. Please try again.';

function routeMismatch(activeRouteDisplay, route) {
  return `Route mismatch. Active trip is ${activeRouteDisplay}, ` +
    `not Route ${route}.`;
}

/** End reply for an unconfirmed number: just the facts of the trip. */
function tripEndedBasic(routeDisplay, endStopDisplay, duration) {
  return `Ended ${routeDisplay} at ${endStopDisplay} (${duration} min trip).`;
}

/** notes: the journey, anomaly and next-leg notes joined (each starts with \n\n, or is ''). */
function tripEnded(routeDisplay, endStopDisplay, agencySuffix, duration, notes) {
  return `Ended ${routeDisplay} at ${endStopDisplay}${agencySuffix} (${duration} min trip)` +
    `${notes}\n\nReply NOTES (your note) to add a note.`;
}

function journeyLinkedNote(prevRouteDisplay, gapMinutes) {
  return `\n\nLinked to your ${prevRouteDisplay} trip ` +
    `(${gapMinutes < 1 ? '<1' : gapMinutes} min transfer). UNLINK to separate.`;
}

function slowTripNote(duration, typicalMinutes) {
  return `\n\nThis trip took longer than usual (${duration} min vs. typical ${typicalMinutes} min).`;
}

function nextLegNote(toLabel) {
  return `\n\nUsually take the ${toLabel} from here.`;
}

// --- ASK and STATS ---

const ASK_PREMIUM_ONLY = 'AI Stats is a premium feature. Text STATS for your 30-day summary.';
// The quoted ASK question is example rider input, so its "I" stays.
const ASK_HELP = 'Ask anything about your trips, ' +
  'e.g. "ASK how many trips have I taken on Fridays?"';
const NO_COMPLETED_TRIPS = 'You don\'t have any completed trips yet!';
const AI_LIMIT_REACHED = 'AI limit reached. Try again later.';
// Sent when the AI answer fails (gemini.js).
const ASK_FAILED = 'Could not search your trips. Try again.';
const NO_RECENT_TRIPS = 'No trips logged in the last 60 days.';

/**
 * STATS reply. A trend percent of null leaves that trend out.
 * @param {object} s
 * @param {number} s.weekCount trips in the past 7 days
 * @param {number|null} s.weekTrendPct change vs the prior week
 * @param {number} s.monthCount trips in the last 30 days
 * @param {number|null} s.monthTrendPct change vs the prior 30 days
 * @param {number} s.routeCount distinct routes in the last 30 days
 * @param {number} s.totalMinutes minutes riding in the last 30 days
 * @param {[string, number]|undefined} s.topRoute [route, count]
 */
function statsSummary({ weekCount, weekTrendPct, monthCount, monthTrendPct, routeCount, totalMinutes, topRoute }) {
  const trend = (pct, label) => {
    if (pct === null || pct === undefined) return '';
    const arrow = pct >= 0 ? '↑' : '↓';
    return ` (${arrow}${Math.abs(pct)}% vs ${label})`;
  };
  const totalHours = totalMinutes / 60;
  const timeStr = totalHours >= 1 ? `${totalHours.toFixed(1)}h` : `${Math.round(totalMinutes)}min`;

  const weekLine = `Past 7 days: ${weekCount} trip${weekCount !== 1 ? 's' : ''}${trend(weekTrendPct, 'prior week')}`;
  const topLine = topRoute ? `Top route: ${topRoute[0]} (${topRoute[1]}×)` : '';
  const thirtyLine = `Last 30 days: ${monthCount} trips across ${routeCount} route${routeCount !== 1 ? 's' : ''}, ${timeStr} riding${trend(monthTrendPct, 'prior 30')}`;

  const parts = [weekLine, thirtyLine];
  if (topLine) parts.push(topLine);
  return parts.join('\n\n');
}

// --- Linking trips into a journey ---

const NOT_ENOUGH_TRIPS_TO_LINK = 'Not enough trips to link. Complete at least one trip first.';
const TRIPS_OVERLAP = 'Trips overlap in time — cannot link.';
const ALREADY_LINKED = 'These trips are already linked as a journey.';

function journeyGapTooLong(gapMinutes) {
  return `Gap between trips is ${Math.round(gapMinutes)} min. Only trips within 60 min can be linked as a journey.`;
}

function journeyLinked(earlierRouteDisplay, laterRouteDisplay, gapMinutes) {
  const gapStr = gapMinutes < 1 ? '<1' : Math.round(gapMinutes);
  return `${earlierRouteDisplay} → ${laterRouteDisplay} ` +
    `linked as a journey (${gapStr} min transfer).`;
}

// --- ML check-in reminders (ml-tasks.js) ---

function mlCheckIn({ description, count, agency, tripsSince, linearUrl }) {
  const lines = [
    `ML Check-in: ${description}`,
    `(${count} ${agency || 'total'} trips since ${tripsSince || 'start'})`,
  ];
  if (linearUrl) lines.push(linearUrl);
  return lines.join('\n');
}

module.exports = {
  // Help and status
  HELP_COMMANDS,
  HELP_ASK_COMMAND,
  helpText,
  activeTripStatus,
  // Trip commands
  NO_ACTIVE_TRIP,
  NOTES_USAGE,
  NO_TRIP_FOR_NOTES,
  NO_LINKED_TRIP,
  tripDeleted,
  notesAdded,
  journeyUnlinked,
  tripSavedIncomplete,
  // REGISTER and phone confirmation
  INVALID_EMAIL_FORMAT,
  NO_PENDING_REGISTRATION,
  TOO_MANY_ATTEMPTS,
  INVALID_CODE,
  ACCOUNT_NOT_FOUND,
  PHONE_LINKED,
  REGISTER_FROM_PHONE,
  phoneAlreadyLinked,
  tooManyAttemptsTryIn,
  registerCodeSent,
  UNLOCK_PROMPT_TEXT,
  UNLOCK_UNAVAILABLE_TEXT,
  UNLOCKED_TEXT,
  EMAIL_NOT_FOUND_TEXT,
  LINKED_NEUTRAL_TEXT,
  OTP_UNCONFIRMED_TEXT,
  LOCKED_TRIP_TEXT,
  // Invite setup
  WELCOME_TEXT,
  SETUP_TEXT,
  CONFIRM_TEXT,
  SETUP_PROBLEM_TEXT,
  NOT_INVITED_TEXT,
  // Phone sign-in code
  otpLoginCode,
  // Emails
  registerCodeEmail,
  signInEmail,
  phoneCodeEmail,
  // SETTINGS
  AGENCY_SET_AUTOMATIC,
  SETTINGS_USAGE,
  settingsSummary,
  unknownAgency,
  agencySet,
  // Starting a trip
  BOARDING_STOP_UNKNOWN,
  AGENCY_UNKNOWN,
  TRIP_START_FAILED,
  viaAgency,
  tripStarted,
  startedAfterIncomplete,
  activeTripConflict,
  endStopPrompt,
  ACHIEVEMENT_MILESTONES,
  achievementNote,
  // Choosing an agency or stop
  AGENCY_CHOICE_REMINDER,
  STOP_SKIPPED,
  agencyChoicePrompt,
  stopMatchesMultiple,
  stopSet,
  // Pending prompts
  TRIP_CANCELLED,
  CHOICE_EXPIRED,
  NOT_UNDERSTOOD,
  newTripCancelled,
  activeSavedNewCancelled,
  confirmStartReminder,
  // Photo trips
  PHOTO_LOAD_FAILED,
  STOP_SIGN_UNREADABLE,
  NO_STOP_IN_PHOTO,
  mmsStopNeeded,
  mmsMultipleRoutes,
  mmsWhichRoute,
  mmsRouteReminder,
  // Ending a trip
  NO_ACTIVE_TRIP_TO_END,
  END_TRIP_FAILED,
  routeMismatch,
  tripEndedBasic,
  tripEnded,
  journeyLinkedNote,
  slowTripNote,
  nextLegNote,
  // ASK and STATS
  ASK_PREMIUM_ONLY,
  ASK_HELP,
  NO_COMPLETED_TRIPS,
  AI_LIMIT_REACHED,
  ASK_FAILED,
  NO_RECENT_TRIPS,
  statsSummary,
  // Linking trips
  NOT_ENOUGH_TRIPS_TO_LINK,
  TRIPS_OVERLAP,
  ALREADY_LINKED,
  journeyGapTooLong,
  journeyLinked,
  // ML check-ins
  mlCheckIn,
};
