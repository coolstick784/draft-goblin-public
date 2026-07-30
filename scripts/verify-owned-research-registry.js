import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REGISTRY = "data/research/owned-model-research-registry.json";
const DEFAULT_POLICY = "data/projection-model-policy.json";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalTextDigest = bytes => digest(
  Buffer.from(bytes).toString("utf8").replace(/\r\n|\r/g, "\n"),
);
const plainObject = value => value && typeof value === "object" && !Array.isArray(value);

function fail(message) {
  throw new Error(`Owned research registry invalid: ${message}`);
}

function safePath(rootDir, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    fail(`invalid relative path ${String(relativePath)}`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.includes("data/private/") || normalized.startsWith("../") || normalized.includes("/../")) {
    fail(`private or escaping path is forbidden: ${relativePath}`);
  }
  const resolved = path.resolve(rootDir, relativePath);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`path escapes repository: ${relativePath}`);
  }
  return resolved;
}

function pointer(object, dotted) {
  return String(dotted || "").split(".").filter(Boolean).reduce((value, key) => value?.[key], object);
}

export function verifyOwnedResearchRegistry({
  rootDir = process.cwd(),
  registry = JSON.parse(fs.readFileSync(path.resolve(rootDir, DEFAULT_REGISTRY), "utf8")),
  policy = JSON.parse(fs.readFileSync(path.resolve(rootDir, DEFAULT_POLICY), "utf8")),
  readBytes = file => fs.readFileSync(file),
  readJson = file => JSON.parse(fs.readFileSync(file, "utf8")),
} = {}) {
  if (registry.schemaVersion !== 1 || registry.registryType !== "owned-model-research-governance") {
    fail("unsupported registry schema");
  }
  if (!/adaptive development caveat/i.test(String(registry.adaptiveDevelopmentCaveat || ""))
      || String(registry.adaptiveDevelopmentCaveat).length < 120) {
    fail("adaptive-development caveat is missing or inadequate");
  }
  if (!Array.isArray(registry.entries) || !registry.entries.length) fail("entries are missing");
  const ids = new Set();
  const policyModels = new Map((policy.models || []).map(model => [model.id, model]));
  let accepted = 0;
  let rejected = 0;
  for (const entry of registry.entries) {
    if (!plainObject(entry) || !entry.id || ids.has(entry.id)) fail(`duplicate or missing entry id ${entry?.id}`);
    ids.add(entry.id);
    if (!["accepted", "rejected"].includes(entry.status)) fail(`${entry.id} has invalid status`);
    if (entry.caveatApplies !== true) fail(`${entry.id} omits adaptive-development caveat acknowledgement`);
    if (typeof entry.productionChanged !== "boolean") fail(`${entry.id} omits productionChanged`);
    for (const key of ["baseModelVersion", "modelVersion", "script", "scriptSha256", "report", "reportSha256"]) {
      if (!entry[key]) fail(`${entry.id} omits ${key}`);
    }
    const scriptFile = safePath(rootDir, entry.script);
    const reportFile = safePath(rootDir, entry.report);
    if (canonicalTextDigest(readBytes(scriptFile)) !== entry.scriptSha256) fail(`${entry.id} script hash drift`);
    if (canonicalTextDigest(readBytes(reportFile)) !== entry.reportSha256) fail(`${entry.id} report hash drift`);
    const report = readJson(reportFile);
    if (entry.status === "accepted") {
      accepted += 1;
      if (!entry.productionChanged || report.productionChanged !== true) {
        fail(`${entry.id} accepted evidence does not declare its shadow production change`);
      }
      const model = policyModels.get(entry.modelVersion);
      if (!model || !(model.acceptedResearchPolicies || []).includes(entry.id)) {
        fail(`${entry.id} accepted policy is absent from projection-model-policy`);
      }
      const canonical = pointer(report, entry.canonicalPointer);
      if (!plainObject(canonical) || canonical.accepted !== true) {
        fail(`${entry.id} canonical accepted subsection is missing`);
      }
    } else {
      rejected += 1;
      if (entry.productionChanged || report.productionChanged === true) {
        fail(`${entry.id} rejected evidence claims a production change`);
      }
    }
    if (entry.supersedes) {
      const supersededFile = safePath(rootDir, entry.supersedes.report);
      if (canonicalTextDigest(readBytes(supersededFile)) !== entry.supersedes.reportSha256) {
        fail(`${entry.id} superseded report hash drift`);
      }
      const superseded = readJson(supersededFile);
      if (!String(superseded.validationStatus || "").startsWith("superseded")
          || superseded.correctionReport !== entry.report) {
        fail(`${entry.id} canonical/superseded relationship is invalid`);
      }
      if (report.supersedes !== entry.supersedes.report) {
        fail(`${entry.id} correction does not identify the superseded report`);
      }
    }
  }
  if (accepted !== 1) fail(`expected exactly one accepted v2026.12 policy, found ${accepted}`);
  return { entries: registry.entries.length, accepted, rejected, modelVersion: registry.modelVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const registryPath = process.argv[2] || DEFAULT_REGISTRY;
  const policyPath = process.argv[3] || DEFAULT_POLICY;
  const result = verifyOwnedResearchRegistry({
    rootDir,
    registry: JSON.parse(fs.readFileSync(path.resolve(rootDir, registryPath), "utf8")),
    policy: JSON.parse(fs.readFileSync(path.resolve(rootDir, policyPath), "utf8")),
  });
  console.log(JSON.stringify({ valid: true, registry: registryPath, ...result }, null, 2));
}
