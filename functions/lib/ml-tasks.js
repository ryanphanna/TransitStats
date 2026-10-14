/**
 * ML check-in task system.
 *
 * After a trip ends, checks if any pending mlTasks have hit their trip threshold
 * for this user and fires an SMS reminder if so.
 *
 * mlTasks schema:
 *   userId       string   — Firestore user ID to target (phone looked up at fire time)
 *   description  string   — what to check (shown in the SMS)
 *   tripTarget   number   — number of qualifying trips to wait for
 *   tripsSince   string   — ISO date; only count trips on or after this date
 *   agency       string?  — optional agency filter (e.g. "TTC")
 *   linearUrl    string?  — Linear issue URL to include in SMS
 *   triggered    boolean  — true once the SMS has been sent
 *   createdAt    Timestamp
 */

const { db } = require('./db');
const { sendSmsReply } = require('./twilio');
const logger = require('./logger');
const { isPhoneConfirmed } = require('./phone-confirmation');

async function getPhoneForUser(userId) {
  // Only a confirmed number gets texts about the account's activity.
  const snap = await db.collection('phoneNumbers').where('userId', '==', userId).get();
  const confirmed = snap.docs.find(doc => isPhoneConfirmed(doc.data()));
  return confirmed ? confirmed.id : null; // doc ID is the phone number
}

/**
 * Called after a trip ends. Checks all pending mlTasks for this user
 * and fires SMS if any threshold has been crossed.
 */
async function checkMlTasks(userId) {
  try {
    const tasksSnap = await db.collection('mlTasks')
      .where('userId', '==', userId)
      .where('triggered', '==', false)
      .get();

    if (tasksSnap.empty) return;

    const phoneNumber = await getPhoneForUser(userId);
    if (!phoneNumber) {
      logger.warn('checkMlTasks: no phone found for user', { userId });
      return;
    }

    await Promise.all(tasksSnap.docs.map(doc => evaluateTask(doc, userId, phoneNumber)));
  } catch (err) {
    logger.error('checkMlTasks error', { userId, err: err.message });
  }
}

async function evaluateTask(taskDoc, userId, phoneNumber) {
  const task = taskDoc.data();

  let query = db.collection('trips')
    .where('userId', '==', userId)
    .where('endTime', '!=', null);

  if (task.tripsSince) {
    query = query.where('startTime', '>=', task.tripsSince);
  }

  const tripsSnap = await query.get();

  let trips = tripsSnap.docs.map(d => d.data());
  if (task.agency) {
    trips = trips.filter(t => t.agency === task.agency);
  }

  const count = trips.length;
  if (count < task.tripTarget) return;

  // Threshold crossed — fire SMS and mark triggered
  const lines = [
    `ML Check-in: ${task.description}`,
    `(${count} ${task.agency || 'total'} trips since ${task.tripsSince || 'start'})`,
  ];
  if (task.linearUrl) lines.push(task.linearUrl);

  await sendSmsReply(phoneNumber, lines.join('\n'));
  await taskDoc.ref.update({ triggered: true, triggeredAt: new Date().toISOString() });

  logger.info('mlTask triggered', { taskId: taskDoc.id, userId, count });
}

module.exports = { checkMlTasks };
