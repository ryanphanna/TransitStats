/**
 * Handler modules — barrel re-export for dispatcher compatibility.
 */
const {
  handleHelp,
  handleStatus,
  handleDiscard,
  handleAddNotes,
  handleUnlink,
  handleIncomplete,
  handleRegister,
  handleVerificationCode,
  handleQuickLinkCode,
  handleSettings,
} = require('./handlers-commands');

const {
  determineStaleness,
  handleTripLog,
  handleConfirmStart,
  handleEndTrip,
} = require('./handlers-trip');

const finalization = require('./finalization');

const {
  handleQuery,
  handleStatsCommand,
  handleJourneyLink,
} = require('./handlers-query');

const {
  fillPredictions,
  handleMmsTrip,
} = require('./handlers-intelligence');

module.exports = {
  handleHelp,
  handleStatus,
  handleDiscard,
  handleAddNotes,
  handleUnlink,
  handleIncomplete,
  handleRegister,
  handleVerificationCode,
  handleQuickLinkCode,
  handleSettings,
  handleTripLog,
  handleConfirmStart,
  handleEndTrip,
  handleQuery,
  handleStatsCommand,
  handleJourneyLink,
  handleMmsTrip,
  fillPredictions,
};
