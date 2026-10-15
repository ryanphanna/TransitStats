const DEFAULT_THRESHOLDS = Object.freeze({
  endStopTrips: 15,
});

function agencyKey(value) {
  return value == null ? null : String(value).trim().toLowerCase() || null;
}

function cleanTripsForAgency(history, agency) {
  const key = agencyKey(agency);
  if (!key) return [];
  return (history || []).filter(trip => {
    if (agencyKey(trip.agency) !== key) return false;
    if (!trip.route) return false;
    if (!(trip.startStopName || trip.startStopCode || trip.startStop)) return false;
    if (!(trip.endStopName || trip.endStopCode || trip.endStop)) return false;
    if (trip.incomplete || trip.discarded || trip.needs_review) return false;
    if (trip.needs_reprocess || trip.exclude_from_training || trip.exclude_from_accuracy) return false;
    if (Array.isArray(trip.correctedFields) && trip.correctedFields.length > 0) return false;
    return trip.stop_matched != null ? !!trip.stop_matched : !!trip.verified;
  });
}

function artifactSupportsAgency(meta, agency, labelSchema = null) {
  const key = agencyKey(agency);
  if (!key || !meta || meta.feature_schema_version !== 2) return false;
  if (labelSchema && meta.label_schema !== labelSchema) return false;
  const agencies = Array.isArray(meta.agencies) ? meta.agencies.map(agencyKey) : [];
  return agencies.includes(key);
}

function getEligibility(history, agency, thresholds = DEFAULT_THRESHOLDS) {
  const clean = cleanTripsForAgency(history, agency);
  return {
    agency,
    cleanTripCount: clean.length,
    endStopEligible: clean.length >= thresholds.endStopTrips,
    thresholds: { ...thresholds },
  };
}

/** End-stop models only (the route models were removed). */
function isModelReady(history, agency, metaA, metaB, thresholds = DEFAULT_THRESHOLDS) {
  const eligibility = getEligibility(history, agency, thresholds);
  return eligibility.endStopEligible && artifactSupportsAgency(metaA, agency, 'agency::end_stop') &&
    artifactSupportsAgency(metaB, agency, 'agency::end_stop');
}

module.exports = {
  DEFAULT_THRESHOLDS,
  agencyKey,
  cleanTripsForAgency,
  artifactSupportsAgency,
  getEligibility,
  isModelReady,
};
