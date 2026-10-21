/**
 * RCS tap-to-end buttons on trip-start replies.
 *
 * Switched off unless Firestore config/rcsButtons says otherwise, so it can be
 * flipped without a deploy (same pattern as config/turnstile):
 *   {
 *     enabled: true,
 *     allowlist: ['+1416...'],            // optional; when non-empty, only these numbers
 *     messagingServiceSid: 'MG...',       // service holding the RCS sender + the SMS number
 *     templates: { 1: 'HX...', 2: 'HX...', 3: 'HX...' }, // twilio/card, END 1..END n buttons
 *   }
 * Each template is a twilio/card whose text is the content variable {{1}} (the
 * normal reply text), plus a twilio/text type with body {{1}} so phones without
 * RCS get exactly today's text.
 *
 * Twilio setup still needed before turning it on (none of this exists yet):
 *   1. A Messaging Service with both the RCS sender (rcs:transitstats_kcjk6lek_agent)
 *      and +13433160660 in its sender pool, so non-RCS phones fall back to SMS.
 *   2. Its inbound webhook pointed at the sms function, or button taps never arrive.
 *   3. Three Content templates (1, 2 and 3 QUICK_REPLY buttons titled "END n",
 *      ids end1..endn), each with twilio/card + twilio/text using {{1}}.
 *   4. The config/rcsButtons doc above; use the allowlist for tester phones until
 *      the carrier approves the sender.
 */

const CONFIG_CACHE_MS = 30 * 1000;
// Keep the card text well under Twilio's card limits; longer replies go as plain SMS.
const MAX_CARD_BODY = 1000;
const OFF = Object.freeze({ enabled: false });

function normalizeConfig(data) {
  if (!data || data.enabled !== true) return OFF;
  const templates = {};
  for (const n of [1, 2, 3]) {
    const sid = data.templates?.[n] ?? data.templates?.[String(n)];
    if (typeof sid === 'string' && /^HX[0-9a-f]{32}$/i.test(sid)) templates[n] = sid;
  }
  const allowlist = Array.isArray(data.allowlist)
    ? data.allowlist.filter(p => typeof p === 'string' && p)
    : [];
  const mg = data.messagingServiceSid;
  const messagingServiceSid = typeof mg === 'string' && /^MG[0-9a-f]{32}$/i.test(mg) ? mg : null;
  return { enabled: true, allowlist, messagingServiceSid, templates };
}

/**
 * Cached reader for config/rcsButtons. Never throws; defaults to off.
 */
function createRcsConfigReader(db, { logger, now = Date.now } = {}) {
  let cached = null;
  let cachedAt = 0;
  return async function getRcsConfig() {
    if (cached && now() - cachedAt < CONFIG_CACHE_MS) return cached;
    try {
      const snapshot = await db.collection('config').doc('rcsButtons').get();
      cached = normalizeConfig(snapshot.exists ? snapshot.data() : null);
      cachedAt = now();
    } catch (error) {
      // Keep the last known value on a read error; with none yet (cold start), stay off.
      logger?.warn?.('RCS buttons config read failed', { error: error.message });
      if (!cached) return OFF;
    }
    return cached;
  };
}

/**
 * Content API params for a card reply with END 1..END n buttons, or null when
 * the plain SMS should be sent instead.
 */
function buildEndButtonCardParams(config, to, body, choiceCount) {
  if (!config?.enabled || !config.messagingServiceSid) return null;
  if (!Number.isInteger(choiceCount) || choiceCount < 1 || choiceCount > 3) return null;
  const contentSid = config.templates?.[choiceCount];
  if (!contentSid) return null;
  if (config.allowlist?.length && !config.allowlist.includes(to)) return null;
  if (typeof body !== 'string' || !body || body.length > MAX_CARD_BODY) return null;
  return {
    contentSid,
    contentVariables: JSON.stringify({ 1: body }),
    messagingServiceSid: config.messagingServiceSid,
    to,
  };
}

/**
 * Send a reply, as a button card when the config allows it. A failed card send
 * always falls back to the plain SMS so the reply is never lost. Errors from
 * the plain send propagate to the caller.
 * @returns {Promise<'card'|'sms'>}
 */
async function deliverReply(client, {
  from, to, message, endButtons = 0, rcsConfig = null, logger = console,
}) {
  const card = buildEndButtonCardParams(rcsConfig, to, message, endButtons);
  if (card) {
    try {
      await client.messages.create(card);
      return 'card';
    } catch (error) {
      logger.warn?.('RCS button card send failed; falling back to plain SMS', { code: error?.code, error: error?.message });
    }
  }
  await client.messages.create({ body: message, from, to });
  return 'sms';
}

/**
 * Normalize an inbound Twilio webhook body. A tapped END n button arrives with
 * ButtonPayload end1..end3 (Body may be the button title or empty); it becomes
 * the text "END n" so the existing END shortcut runs unchanged. RCS senders
 * arrive as "rcs:+1..."; strip that so the number matches the user's phone.
 * Does not mutate the request body (signature validation reads it).
 */
function normalizeInbound(reqBody = {}) {
  let from = typeof reqBody.From === 'string' ? reqBody.From.trim() : reqBody.From;
  if (typeof from === 'string' && /^rcs:/i.test(from)) from = from.slice(4);
  let body = (reqBody.Body || '').trim();
  const payload = typeof reqBody.ButtonPayload === 'string' ? reqBody.ButtonPayload.trim() : '';
  const match = payload.match(/^end([123])$/i);
  if (match) body = `END ${match[1]}`;
  return { from, body };
}

module.exports = {
  createRcsConfigReader,
  normalizeConfig,
  buildEndButtonCardParams,
  deliverReply,
  normalizeInbound,
  MAX_CARD_BODY,
};
