function createCommandHandler({ db, apiContextStorage, dispatch, logger, generateTraceId }) {
  return async function handleAuthenticatedCommand(req, res, { uid, email, traceId }) {
    const allowedDoc = await db.collection('allowedUsers').doc(email.toLowerCase()).get();
    if (!allowedDoc.exists) {
      logger.warn('API access denied: User not whitelisted', { email, traceId }, traceId);
      res.status(403).json({ error: 'Access denied: User is not whitelisted' });
      return;
    }

    const phoneQuery = await db.collection('phoneNumbers')
      .where('userId', '==', uid)
      .limit(1)
      .get();
    if (phoneQuery.empty) {
      logger.warn('API request failed: No registered phone number', { uid, email, traceId }, traceId);
      res.status(400).json({
        error: 'Failed: No phone number linked to this account. Connect your phone from Settings first.',
      });
      return;
    }

    const command = (req.body.command || '').trim();
    if (!command) {
      res.status(400).json({ error: 'Missing command' });
      return;
    }

    const phoneNumber = phoneQuery.docs[0].id;
    logger.info('API Command received', { uid, email, phoneNumber, command, traceId }, traceId);

    const apiContext = { isApiRequest: true, replies: [] };
    await apiContextStorage.run(apiContext, async () => {
      const mockMessageSid = `api_${generateTraceId()}_${Date.now()}`;
      await dispatch(phoneNumber, command, mockMessageSid, { numMedia: 0 }, traceId);
    });

    res.status(200).json({
      success: true,
      replies: apiContext.replies,
      traceId,
    });
  };
}

module.exports = { createCommandHandler };
