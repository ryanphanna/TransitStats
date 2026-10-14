function createCommandHandler({ db, apiContextStorage, dispatch, logger, generateTraceId }) {
  return async function handleAuthenticatedCommand(req, res, { uid, email, emailVerified, traceId }) {
    // An unverified email proves nothing about who owns it.
    if (!email || emailVerified !== true) {
      logger.warn('API access denied: email not verified', { uid, traceId }, traceId);
      res.status(403).json({ error: 'Access denied: User is not whitelisted' });
      return;
    }

    const allowedDoc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
    if (!allowedDoc.exists) {
      logger.warn('API access denied: User not whitelisted', { email, traceId }, traceId);
      res.status(403).json({ error: 'Access denied: User is not whitelisted' });
      return;
    }

    const command = (req.body.command || '').trim();
    if (!command) {
      res.status(400).json({ error: 'Missing command' });
      return;
    }

    // The app has its own identity, never a phone number: its pending prompts,
    // trip tags and rate limits can't be shared with, or reached from, any phone.
    const phoneNumber = `web:${uid}`;
    logger.info('API Command received', { uid, email, command, traceId }, traceId);

    const apiContext = { isApiRequest: true, replies: [] };
    await apiContextStorage.run(apiContext, async () => {
      const mockMessageSid = `api_${generateTraceId()}_${Date.now()}`;
      // The owner is authenticated by their verified email, so commands run with
      // the owner's own authority, whatever state any phone link is in. The API
      // can never unlock or confirm a phone: only a signed inbound text can.
      await dispatch(phoneNumber, command, mockMessageSid, { numMedia: 0, apiOwner: { userId: uid, email } }, traceId);
    });

    res.status(200).json({
      success: true,
      replies: apiContext.replies,
      traceId,
    });
  };
}

module.exports = { createCommandHandler };
