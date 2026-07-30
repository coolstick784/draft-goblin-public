export const PLAYER_DISTRIBUTION_SCHEMA_VERSION = "quantile-v1";

export const QUANTILE_V1_PROBABILITIES = Object.freeze([
  .01, .05, .10, .20, .30, .40, .50, .60, .70, .80, .90, .95, .99
]);

export const DISTRIBUTION_ESTIMATION_LEVELS = Object.freeze([
  "player", "archetype", "position", "legacy-three-point"
]);

export const CORRELATION_KINDS = Object.freeze([
  "offense", "pass-game", "backfield", "position-room", "quarterback"
]);

const forbiddenAvailabilityFields = [
  "availability", "availabilityProbability", "activeProbability", "injuryRisk",
  "injuryStatus", "inactiveProbability", "limitedProbability", "missedGameRate"
];

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const close = (a, b) => Math.abs(a - b) <= 1e-9;
const validIsoTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * Validate the versioned marginal performance distribution carried by a player.
 * Availability is intentionally outside this envelope and must be composed by
 * the simulator rather than encoded as a wider or lower performance curve.
 */
export function validatePlayerDistribution(distribution, { season, scoringFormat } = {}) {
  const errors = [], warnings = [];
  if (!isObject(distribution)) return { valid: false, errors: ["distribution must be an object"], warnings };

  if (distribution.schemaVersion !== PLAYER_DISTRIBUTION_SCHEMA_VERSION) errors.push(`unsupported distribution schemaVersion: ${String(distribution.schemaVersion || "missing")}`);
  if (distribution.unit !== "season-fantasy-points") errors.push("distribution.unit must be season-fantasy-points");
  if (distribution.conditionedOn !== "active-role") errors.push("distribution.conditionedOn must be active-role");
  if (!Number.isInteger(distribution.season) || distribution.season < 2000 || distribution.season > 2100) errors.push("distribution.season must be a plausible integer season");
  if (season !== undefined && Number(distribution.season) !== Number(season)) errors.push("distribution season does not match the draft season");

  const scoring = String(distribution.scoringFormat || "").toLowerCase();
  if (!["standard", "half-ppr", "ppr", "custom"].includes(scoring)) errors.push("distribution.scoringFormat is invalid");
  if (scoringFormat !== undefined && scoring !== String(scoringFormat).toLowerCase()) errors.push("distribution scoringFormat does not match the draft scoring format");
  if (!finite(distribution.mean)) errors.push("distribution.mean must be finite");

  if (!Array.isArray(distribution.quantiles)) errors.push("distribution.quantiles must be an array");
  else {
    if (distribution.quantiles.length !== QUANTILE_V1_PROBABILITIES.length) errors.push("quantile-v1 requires the fixed 13-point probability grid");
    let previousValue = -Infinity;
    distribution.quantiles.forEach((quantile, index) => {
      const expectedProbability = QUANTILE_V1_PROBABILITIES[index];
      if (!isObject(quantile) || !finite(quantile.p) || !finite(quantile.value)) {
        errors.push(`quantile ${index} must contain finite p and value numbers`);
        return;
      }
      if (expectedProbability === undefined || !close(quantile.p, expectedProbability)) errors.push(`quantile ${index} must use probability ${String(expectedProbability)}`);
      if (quantile.value < previousValue) errors.push("quantile values must be non-decreasing");
      previousValue = quantile.value;
    });
    const first = distribution.quantiles[0], last = distribution.quantiles.at(-1);
    if (finite(distribution.mean) && finite(first?.value) && finite(last?.value) && (distribution.mean < first.value || distribution.mean > last.value)) warnings.push("distribution.mean lies outside P01-P99; confirm tail integration is intentional");
  }

  if (!isObject(distribution.provenance)) errors.push("distribution.provenance must be an object");
  else {
    const provenance = distribution.provenance;
    if (typeof provenance.modelId !== "string" || !provenance.modelId.trim()) errors.push("provenance.modelId is required");
    if (typeof provenance.modelVersion !== "string" || !provenance.modelVersion.trim()) errors.push("provenance.modelVersion is required");
    if (!validIsoTimestamp(provenance.generatedAt)) errors.push("provenance.generatedAt must be an ISO timestamp");
    if (!validIsoTimestamp(provenance.forecastAsOf)) errors.push("provenance.forecastAsOf must be an ISO timestamp");
    if (!validIsoTimestamp(provenance.trainedThrough)) errors.push("provenance.trainedThrough must be an ISO date or timestamp");
    if (validIsoTimestamp(provenance.forecastAsOf) && validIsoTimestamp(provenance.trainedThrough) && Date.parse(provenance.trainedThrough) >= Date.parse(provenance.forecastAsOf)) errors.push("provenance.trainedThrough must precede provenance.forecastAsOf");
    if (typeof provenance.calibrationId !== "string" || !provenance.calibrationId.trim()) errors.push("provenance.calibrationId is required");
    if (!Array.isArray(provenance.sourceSnapshotIds)) errors.push("provenance.sourceSnapshotIds must be an array");
    else if (!provenance.sourceSnapshotIds.length || provenance.sourceSnapshotIds.some(id => typeof id !== "string" || !id.trim())) errors.push("provenance.sourceSnapshotIds must contain non-empty snapshot identifiers");
    if (!DISTRIBUTION_ESTIMATION_LEVELS.includes(provenance.estimationLevel)) errors.push("provenance.estimationLevel is invalid");
    if (provenance.estimationLevel !== "player" && (typeof provenance.fallbackReason !== "string" || !provenance.fallbackReason.trim())) errors.push("non-player distributions require provenance.fallbackReason");
  }

  if (distribution.correlationRefs !== undefined) {
    if (!Array.isArray(distribution.correlationRefs)) errors.push("distribution.correlationRefs must be an array");
    else {
      const seen = new Set();
      distribution.correlationRefs.forEach((reference, index) => {
        if (!isObject(reference) || !CORRELATION_KINDS.includes(reference.kind) || typeof reference.key !== "string" || !reference.key.trim()) errors.push(`correlationRefs[${index}] is invalid`);
        else {
          const identity = `${reference.kind}:${reference.key}`;
          if (seen.has(identity)) errors.push(`duplicate correlation reference: ${identity}`);
          seen.add(identity);
        }
      });
    }
  }

  for (const field of forbiddenAvailabilityFields) if (Object.hasOwn(distribution, field)) errors.push(`distribution.${field} is forbidden; keep availability and injury state on the player availability model`);
  return { valid: errors.length === 0, errors, warnings };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

/**
 * Stable, unhashed cache material. Callers may hash this string with their
 * platform's existing digest implementation.
 */
export function playerDistributionFingerprintMaterial(player) {
  return JSON.stringify(canonicalize({
    playerId: String(player?.id || ""),
    distribution: player?.distribution || null,
    availability: player?.availability || null
  }));
}
