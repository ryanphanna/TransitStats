const { defineSecret } = require('firebase-functions/params');

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhone = defineSecret('TWILIO_PHONE_NUMBER');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

/**
 * Validate required environment configuration on cold start
 * @returns {object} { errors, warnings }
 */
function validateConfiguration() {
  const warnings = [];
  const errors = [];

  // Check Twilio configuration
  if (!twilioAccountSid.value()) errors.push('Missing twilio.account_sid');
  if (!twilioAuthToken.value()) errors.push('Missing twilio.auth_token');
  if (!twilioPhone.value()) warnings.push('Missing twilio.phone_number (SMS replies disabled)');

  // Check Gemini configuration
  const gemini = geminiApiKey.value();
  if (!gemini) {
    warnings.push('Missing gemini.api_key (stop-sign photo reading disabled)');
  }

  // Check Claude configuration
  if (!anthropicApiKey.value()) {
    warnings.push('Missing anthropic.api_key (AI parsing disabled, will use heuristics)');
  }

  // Log results
  if (errors.length > 0) {
    console.error('❌ Configuration errors:', errors.join(', '));
    console.error('Set missing config with: firebase functions:config:set <key>=<value>');
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Configuration warnings:', warnings.join(', '));
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ Configuration validated successfully');
  }

  return { errors, warnings };
}

module.exports = {
  validateConfiguration,
};
