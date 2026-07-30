import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_STATUSES = new Set([
  "production",
  "production-runtime-only",
  "production-feature",
  "prospective-shadow",
  "research-candidate",
  "disabled-pending-commercial-agreement",
  "prohibited"
]);
const REQUIRED_PROHIBITED = new Set([
  "sleeper-undocumented-projections",
  "unlicensed-publisher-news-scraping"
]);
const LICENSED_RUNTIME_STATUSES = new Set([
  "production",
  "production-feature",
  "prospective-shadow",
  "research-candidate"
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyModelSignalPolicy(policy, sourcePolicy) {
  invariant(policy?.schemaVersion === 1, "model signal policy must use schemaVersion 1");
  invariant(policy.runtimeProjection?.method === "draft-goblin-primary-user-selectable-current-site", "runtime projection method is not pinned");
  invariant(policy.runtimeProjection?.defaultDriver === "draftGoblin", "Draft Goblin must remain the default projection driver");
  invariant(JSON.stringify(policy.runtimeProjection?.allowedDrivers)===JSON.stringify(["draftGoblin","platform"]),"runtime projection drivers are not pinned");
  const siteBoundary = policy.runtimeProjection?.siteDataBoundary || {};
  invariant(siteBoundary.rawValuesRuntimeOnly === true, "raw site projections must remain runtime-only");
  invariant(siteBoundary.rawValuesPersisted === false, "raw site projections must not be persisted");
  invariant(siteBoundary.rawValuesTransmitted === false, "raw site projections must not be transmitted");
  invariant(siteBoundary.rawValuesRedistributed === false, "raw site projections must not be redistributed");
  invariant(siteBoundary.localSelectedProjectionMayBePersisted === true, "private reports must explicitly declare selected-projection persistence");

  const gate = policy.promotionGate || {};
  invariant(gate.minimumTimestampedSeasons >= 3, "promotion requires at least three timestamped seasons");
  invariant(gate.requireUntouchedFinalSeason === true, "promotion requires an untouched final season");
  invariant(gate.requireOverallImprovement === true, "promotion must improve overall accuracy");
  invariant(gate.requireNoMaterialRegressionByPosition === true, "promotion must guard every position");
  invariant(gate.requireLicenseReview === true, "promotion requires a license review");
  invariant(gate.requirePreEventTimestamps === true, "promotion requires pre-event timestamps");
  invariant(gate.requireImmutableHashes === true, "promotion requires immutable hashes");
  invariant(gate.shadowOnlyUntilPromoted === true, "candidate signals must stay shadow-only");
  for (const metric of ["mae", "rmse", "spearman", "topNRecall"]) {
    invariant(gate.requiredMetrics?.includes(metric), `promotion metric is missing: ${metric}`);
  }
  for (const baseline of ["draft-goblin-production", "current-site-projection"]) {
    invariant(gate.requiredBaselines?.includes(baseline), `promotion baseline is missing: ${baseline}`);
  }

  invariant(policy.newsPolicy?.publisherPageScraping === false, "publisher news scraping must remain disabled");
  invariant(policy.newsPolicy?.rawArticleRedistribution === false, "raw article redistribution must remain disabled");
  invariant(policy.newsPolicy?.licensedTextRequiredForAutomatedNewsExtraction === true, "news extraction must require licensed text");

  invariant(Array.isArray(policy.signals) && policy.signals.length > 0, "signal registry is empty");
  const ids = new Set();
  for (const signal of policy.signals) {
    invariant(typeof signal.id === "string" && signal.id.length > 0, "signal id is required");
    invariant(!ids.has(signal.id), `duplicate signal id: ${signal.id}`);
    ids.add(signal.id);
    invariant(ALLOWED_STATUSES.has(signal.status), `unsupported signal status for ${signal.id}: ${signal.status}`);
    invariant(signal.redistributeRaw === false, `raw provider redistribution is forbidden: ${signal.id}`);
    if (LICENSED_RUNTIME_STATUSES.has(signal.status)) {
      invariant(!["not-established", "not-configured"].includes(signal.license), `licensed signal required for ${signal.id}`);
    }
    if (signal.status === "prospective-shadow") {
      invariant(signal.capture?.immutableHash === "sha256", `shadow signal must be hash-pinned: ${signal.id}`);
      invariant(signal.redistributeDerivedProjection === false, `shadow signal cannot affect public projections: ${signal.id}`);
    }
    if (signal.status === "disabled-pending-commercial-agreement") {
      invariant(!signal.authorizationId, `unapproved commercial source unexpectedly has authorization: ${signal.id}`);
      invariant(signal.redistributeDerivedProjection === false, `unapproved commercial source cannot affect outputs: ${signal.id}`);
    }
    if (signal.status === "prohibited") {
      invariant(signal.persistRaw === false, `prohibited source cannot be persisted: ${signal.id}`);
      invariant(signal.redistributeDerivedProjection === false, `prohibited source cannot affect outputs: ${signal.id}`);
    }
  }
  for (const id of REQUIRED_PROHIBITED) {
    const signal = policy.signals.find(candidate => candidate.id === id);
    invariant(signal?.status === "prohibited", `required prohibition is missing: ${id}`);
  }
  const currentSite = policy.signals.find(signal => signal.id === "current-site-projection");
  invariant(currentSite?.status === "production-runtime-only", "current-site projection must be runtime-only");
  invariant(
    currentSite.persistRaw === false && currentSite.redistributeDerivedProjection === false,
    "raw current-site values cannot be persisted and derived values cannot be redistributed",
  );
  invariant(currentSite.persistLocalSelectedProjection === true, "local selected-projection report persistence must be explicit");
  if (sourcePolicy) {
    invariant(sourcePolicy.rules?.allowBrowserVisibleAlone === false, "browser visibility cannot authorize collection");
    invariant(sourcePolicy.rules?.allowBrowserVisibleRuntimeOnly === true, "source policy must allow the runtime-only site exception");
    const runtimeSource = sourcePolicy.sources?.find(source => source.id === "current-site-visible-projection");
    invariant(runtimeSource?.status === "runtime-only-user-session", "source policy runtime-only site exception is missing");
    const sleeperProjection = sourcePolicy.sources?.find(source => source.id === "sleeper-projections");
    invariant(sleeperProjection?.status === "pending-redistribution-rights", "Sleeper projection redistribution must remain disabled pending written rights");
  }
  return { valid: true, signals: policy.signals.length, schemaVersion: policy.schemaVersion };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const policyPath = path.resolve(process.argv[2] || "data/model-signal-policy.json");
  const sourcePolicyPath = path.resolve(process.argv[3] || "data/source-policy.json");
  const result = verifyModelSignalPolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")), JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
