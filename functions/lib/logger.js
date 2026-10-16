/**
 * Logging utility with PII redaction and optional trace correlation.
 *
 * All functions are backward-compatible. Pass `traceId` inside the data object
 * (or as the third argument to info/error for convenience) to get prefixed logs
 * that are easy to correlate across an SMS request.
 */

/**
 * Generate a short trace ID suitable for logs and Cloud Logging correlation.
 * 8 characters is enough to uniquely identify a request in practice.
 */
function generateTraceId() {
  // Use crypto.randomUUID when available (Node 19+ / Cloud Functions)
  try {
    const { randomUUID } = require('crypto');
    return randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return Date.now().toString(36).slice(-8);
  }
}

/**
 * Redact phone numbers (e.g., +16471234567 -> +1647***4567)
 * @param {string} phone - raw phone number
 * @returns {string} masked phone number
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return 'Unknown';
  if (phone.length < 5) return '***';
  return phone.substring(0, 5) + '***' + phone.substring(phone.length - 4);
}

/**
 * Normalize a data object for logging: apply PII redaction and extract traceId.
 * @param {object} data
 * @returns {{ logData: object, traceId: string|null }}
 */
function normalizeLogData(data = {}) {
  const logData = { ...data };

  // Extract traceId if present (support both camelCase and snake_case)
  const traceId = logData.traceId || logData.trace_id || null;
  if (traceId) {
    delete logData.traceId;
    delete logData.trace_id;
  }

  // Automatically mask known PII fields
  if (logData.phoneNumber) logData.phoneNumber = maskPhone(logData.phoneNumber);
  if (logData.phone) logData.phone = maskPhone(logData.phone);
  if (logData.From) logData.From = maskPhone(logData.From);

  // Redact message body/content if it might contain private info
  if (logData.body) logData.body = `[REDACTED (Length: ${logData.body.length})]`;
  if (logData.Body) logData.Body = `[REDACTED (Length: ${logData.Body.length})]`;

  return { logData, traceId };
}

/**
 * Format a log prefix including optional short trace ID.
 */
function formatPrefix(level, traceId) {
  if (traceId) {
    return `[${level}][t:${traceId}]`;
  }
  return `[${level}]`;
}

/**
 * Log information with optional PII masking and trace correlation.
 * @param {string} message
 * @param {object} [data]
 * @param {string} [traceId] - optional convenience param
 */
function info(message, data = {}, traceId = null) {
  let finalTrace = traceId;
  let logData;

  if (typeof data === 'string' && !traceId) {
    // allow info(msg, traceId) calls for convenience
    finalTrace = data;
    logData = {};
  } else {
    const normalized = normalizeLogData(data);
    logData = normalized.logData;
    if (!finalTrace) finalTrace = normalized.traceId;
  }

  const prefix = formatPrefix('INFO', finalTrace);
  console.log(`${prefix} ${message}`, Object.keys(logData).length ? logData : '');
}

/**
 * Log error events with optional trace correlation.
 * Plain-object payloads are always PII-masked; Error instances are logged as-is.
 * @param {string} message
 * @param {Error|object} [err]
 * @param {string} [traceId]
 */
function error(message, err = {}, traceId = null) {
  let finalTrace = traceId;
  let errorPayload = err;

  if (typeof err === 'string' && !traceId) {
    finalTrace = err;
    errorPayload = {};
  } else if (err && typeof err === 'object' && !(err instanceof Error)) {
    const normalized = normalizeLogData(err);
    errorPayload = normalized.logData;
    if (!finalTrace) finalTrace = normalized.traceId;
  }

  const prefix = formatPrefix('ERROR', finalTrace);
  console.error(`${prefix} ${message}`, errorPayload);
}

/**
 * Log warning events with PII masking and optional trace correlation.
 * @param {string} message
 * @param {object|string} [data] - details to log (a string is treated as a traceId)
 * @param {string} [traceId] - optional convenience param
 */
function warn(message, data = {}, traceId = null) {
  let finalTrace = traceId;
  let logData;

  if (typeof data === 'string' && !traceId) {
    finalTrace = data;
    logData = {};
  } else {
    const normalized = normalizeLogData(data || {});
    logData = normalized.logData;
    if (!finalTrace) finalTrace = normalized.traceId;
  }

  const prefix = formatPrefix('WARN', finalTrace);
  console.warn(`${prefix} ${message}`, Object.keys(logData).length ? logData : '');
}

module.exports = {
  info,
  error,
  warn,
  maskPhone,
  generateTraceId,
};
