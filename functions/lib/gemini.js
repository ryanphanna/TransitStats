/**
 * Gemini AI helper for stop-sign photos, plus the recent-trips summary and date helper used for the ASK prompt.
 * Trip text parsing, ASK answers and agency time zones live in claude.js.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { defineSecret } = require('firebase-functions/params');
const logger = require('./logger');

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-2.5-flash';

function getTimezoneDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Retry helper with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Initial delay in milliseconds
 * @returns {Promise<any>} Result of function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, traceId = null) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;

      // Don't retry on permanent errors
      if (error.message && (
        error.message.includes('API key') ||
        error.message.includes('unauthorized') ||
        error.message.includes('no longer available') ||
        error.message.includes('404') ||
        (error.message.includes('invalid') && !error.message.includes('invalid response'))
      )) {
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt);
      logger.info('Gemini retrying', { attempt: attempt + 1, maxRetries, delayMs: delay }, traceId);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Aggregate trip data into summary stats for AI context
 * @param {Array} trips - List of trip objects
 * @returns {object} Aggregated stats
 */
function aggregateTripStats(trips, defaultTimezone = 'America/Toronto') {
  const routeMap = {};
  const pairMap = {};
  const boardingStopMap = {};
  const exitStopMap = {};
  const hourMap = {};
  const dayOfWeekMap = {};
  let windowStart = null;
  let windowEnd = null;

  trips.forEach((trip) => {
    const route = trip.route || 'Unknown';
    const dur = trip.duration || 0;
    const startStop = trip.startStopName || trip.startStop || trip.startStopCode || 'Unknown';
    const endStop = trip.endStopName || trip.endStop || trip.endStopCode || 'Unknown';
    const pairKey = `${startStop} → ${endStop}`;

    // Respect per-trip timezone, fallback to provided default
    const tripTimezone = trip.timezone || defaultTimezone;

    if (!routeMap[route]) routeMap[route] = { count: 0, durations: [] };
    routeMap[route].count++;
    if (dur > 0) routeMap[route].durations.push(dur);

    if (!pairMap[pairKey]) pairMap[pairKey] = { route, count: 0, durations: [] };
    pairMap[pairKey].count++;
    if (dur > 0) pairMap[pairKey].durations.push(dur);

    if (startStop !== 'Unknown') {
      boardingStopMap[startStop] = (boardingStopMap[startStop] || 0) + 1;
    }
    if (endStop !== 'Unknown') {
      exitStopMap[endStop] = (exitStopMap[endStop] || 0) + 1;
    }

    if (trip.startTime) {
      const date = trip.startTime.toDate ? trip.startTime.toDate() : new Date(trip.startTime);
      const parts = getTimezoneDateParts(date, tripTimezone);
      hourMap[parts.hour] = (hourMap[parts.hour] || 0) + 1;
      dayOfWeekMap[parts.weekday] = (dayOfWeekMap[parts.weekday] || 0) + 1;
      if (!windowStart || date < windowStart) windowStart = date;
      if (!windowEnd || date > windowEnd) windowEnd = date;
    }
  });

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const routeStats = Object.entries(routeMap).map(([route, data]) => ({
    route,
    count: data.count,
    avgDuration: avg(data.durations),
    minDuration: data.durations.length ? Math.min(...data.durations) : null,
    maxDuration: data.durations.length ? Math.max(...data.durations) : null,
  })).sort((a, b) => b.count - a.count).slice(0, 10);

  const pairStats = Object.entries(pairMap).map(([pair, data]) => ({
    pair,
    route: data.route,
    count: data.count,
    avgDuration: avg(data.durations),
    minDuration: data.durations.length ? Math.min(...data.durations) : null,
    maxDuration: data.durations.length ? Math.max(...data.durations) : null,
  })).sort((a, b) => b.count - a.count).slice(0, 20);

  const boardingStops = Object.entries(boardingStopMap)
    .map(([stop, count]) => ({ stop, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const exitStops = Object.entries(exitStopMap)
    .map(([stop, count]) => ({ stop, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const timeOfDay = { morning: 0, midday: 0, afternoon: 0, evening: 0, night: 0 };
  Object.entries(hourMap).forEach(([hour, count]) => {
    const h = parseInt(hour);
    if (h >= 6 && h <= 9) timeOfDay.morning += count;
    else if (h >= 10 && h <= 14) timeOfDay.midday += count;
    else if (h >= 15 && h <= 18) timeOfDay.afternoon += count;
    else if (h >= 19 && h <= 22) timeOfDay.evening += count;
    else timeOfDay.night += count;
  });

  const allStops = Array.from(new Set([
    ...Object.keys(boardingStopMap),
    ...Object.keys(exitStopMap),
  ])).sort();

  return {
    total: trips.length,
    routeStats, pairStats, boardingStops, exitStops, timeOfDay, allStops,
    dayOfWeek: dayOfWeekMap,
    windowStart: windowStart ? windowStart.toLocaleDateString('en-CA', { timeZone: defaultTimezone }) : null,
    windowEnd: windowEnd ? windowEnd.toLocaleDateString('en-CA', { timeZone: defaultTimezone }) : null,
  };
}

/**
 * Construct stop input from an AI parse result
 * Prefer stop_id (code) if available, otherwise stop_name
 * @param {object} result - AI parse result object
 * @returns {string|null} Stop input string or null
 */
function constructStopInput(result) {
  if (!result) return null;
  return result.stop_id || result.stop_name || null;
}

/**
 * Parse a transit stop sign photo and extract stop/route information.
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g. 'image/jpeg')
 * @returns {Promise<{stopCode: string|null, stopName: string|null, routes: Array<{route: string, agency: string|null}>}|null>}
 */
async function parseStopSignImage(imageBase64, mimeType, traceId = null) {
  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = `Analyze this photo of a transit stop sign, pole, or shelter. Extract stop information and return ONLY valid JSON with no other text:
{
  "stopCode": "numeric stop ID or code if visible (often on 'Next Vehicle' or 'SMS' stickers, e.g. 'Text 12345'), otherwise null",
  "stopName": "intersection, station name, or landmark if visible, otherwise null",
  "routes": [
    { "route": "route identifier as a string (e.g. '510', 'Line 1', 'Blue')", "agency": "transit agency name if determinable, otherwise null" }
  ]
}

Rules:
1. Only include routes clearly visible on the signage.
2. If multiple route numbers are shown, list all of them.
3. For stop codes, look for numeric IDs of any length (typically 3-6 digits, e.g. '110', '8128', '11985'), especially near 'Next Vehicle' or text-messaging instructions.
4. If no transit stop information is found, return null.`;

  const result = await retryWithBackoff(async () => {
    return model.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      { text: prompt },
    ]);
  }, 3, 1000, traceId);

  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || !Array.isArray(parsed.routes)) return null;
    parsed.routes = parsed.routes.filter(r => r.route && typeof r.route === 'string');
    if (parsed.routes.length === 0) return null;
  } catch {
    return null;
  }

  // If routes were found but stop code is missing, do a focused second pass
  // specifically looking for the small "Next Vehicle" SMS sticker text.
  if (!parsed.stopCode) {
    try {
      const focusedPrompt = `Look carefully at this transit stop pole photo. Find any small sticker or label with the words "Next Vehicle", "Text stop", or "SMS". These stickers contain a short numeric stop code (usually 4-6 digits) and a phone number (e.g. "Text 11985 to 898882" — the stop code would be 11985). Return ONLY the numeric stop code as plain text, or the word null if you cannot find one.`;
      const focusedResult = await retryWithBackoff(async () => {
        return model.generateContent([
          { inlineData: { data: imageBase64, mimeType } },
          { text: focusedPrompt },
        ]);
      }, 3, 1000, traceId);
      const focusedText = focusedResult.response.text().trim();
      const codeMatch = focusedText.match(/\b\d{4,6}\b/);
      if (codeMatch) parsed.stopCode = codeMatch[0];
    } catch {
      // Non-fatal — proceed without stop code
    }
  }

  return parsed;
}

module.exports = {
  getTimezoneDateParts,
  retryWithBackoff,
  aggregateTripStats,
  constructStopInput,
  parseStopSignImage,
};
