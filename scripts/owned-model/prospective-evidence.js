import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectionConsensus } from "../../extension/projection-consensus.js";
import {
  assertPreregisteredOwnedOverlay,
  MINIMUM_FROZEN_ROWS_PER_SLICE,
  OWNED_OVERLAY_CLOSENESS_LIMITS,
  OWNED_OVERLAY_FORMATS,
  OWNED_OVERLAY_METHOD,
  OWNED_OVERLAY_POSITIONS,
  OWNED_OVERLAY_POSITION_WEIGHTS,
} from "./overlay-policy.js";

const POSITIONS = OWNED_OVERLAY_POSITIONS;
const FORMATS = OWNED_OVERLAY_FORMATS;
const SOURCES = ["espn", "sleeper", "fantasyPros"];
const TRAINING_SOURCE_POLICY_SHA256 = "8ef96ed7c7fdc852a2b28b0bad260fd2d1285b14c27b9663f9b78d65df95c3d2";
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => String(value ?? "").trim().toLowerCase();
const normalizeName = value => canonical(value).replace(/[^a-z0-9]/g, "");
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (values, probability) => { const ordered = [...values].sort((a, b) => a - b), index = (ordered.length - 1) * probability, lower = Math.floor(index), upper = Math.ceil(index); return lower === upper ? ordered[lower] : ordered[lower] * (upper - index) + ordered[upper] * (index - lower); };
const ranks = values => { const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value), result = []; for (let i = 0; i < order.length;) { let j = i + 1; while (j < order.length && order[j].value === order[i].value) j++; for (let k = i; k < j; k++) result[order[k].index] = (i + j + 1) / 2; i = j; } return result; };
const correlation = (a, b) => { if (a.length < 2) return null; const x = ranks(a), y = ranks(b), mx = mean(x), my = mean(y), numerator = x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0), dx = Math.sqrt(x.reduce((sum, value) => sum + (value - mx) ** 2, 0)), dy = Math.sqrt(y.reduce((sum, value) => sum + (value - my) ** 2, 0)); return dx && dy ? numerator / (dx * dy) : null; };
const metrics = (rows, projected) => { const errors = rows.map(row => Number(row[projected]) - Number(row.actual)); return { players: rows.length, mae: rows.length ? mean(errors.map(Math.abs)) : null, rmse: rows.length ? Math.sqrt(mean(errors.map(value => value ** 2))) : null, bias: rows.length ? mean(errors) : null, spearman: rows.length > 1 ? correlation(rows.map(row => Number(row[projected])), rows.map(row => Number(row.actual))) : null }; };
const digestJson = value => sha256(Buffer.from(`${JSON.stringify(value)}\n`));
export const MAX_FROZEN_OWNED_AGE_MS = 72 * 60 * 60 * 1000;

function candidateCloseness(rows) {
  const deviations = [], coveredSlices = [], sliceRows = {};
  for (const scoring of FORMATS) for (const position of POSITIONS) {
    const selected = rows.filter(row => row.scoring === scoring && row.position === position);
    sliceRows[`${scoring}:${position}`] = selected.length;
    if (!selected.length) continue;
    coveredSlices.push(`${scoring}:${position}`);
    const average = mean(selected.map(row => row.consensus));
    const scale = selected.length > 1 ? Math.sqrt(mean(selected.map(row => (row.consensus - average) ** 2))) || 1 : 1;
    deviations.push(...selected.map(row => Math.abs(row.candidate - row.consensus) / scale));
  }
  const value = {
    rows: rows.length, coveredSlices,
    spearman: rows.length > 1 ? correlation(rows.map(row => row.candidate), rows.map(row => row.consensus)) : null,
    medianStandardizedDistance: deviations.length ? quantile(deviations, .5) : null,
    p90StandardizedDistance: deviations.length ? quantile(deviations, .9) : null,
  };
  const evaluable = FORMATS.every(scoring => POSITIONS.every(position =>
    sliceRows[`${scoring}:${position}`] >= MINIMUM_FROZEN_ROWS_PER_SLICE
  ));
  const passed = evaluable
    && value.spearman >= OWNED_OVERLAY_CLOSENESS_LIMITS.minimumSpearman
    && value.medianStandardizedDistance <= OWNED_OVERLAY_CLOSENESS_LIMITS.maximumMedianStandardizedDistance
    && value.p90StandardizedDistance <= OWNED_OVERLAY_CLOSENESS_LIMITS.maximumP90StandardizedDistance;
  return {
    ...value,
    sliceRows,
    minimumRowsPerSlice: MINIMUM_FROZEN_ROWS_PER_SLICE,
    evaluable,
    passed,
    limits: OWNED_OVERLAY_CLOSENESS_LIMITS,
  };
}

export function assertProspectiveOverlayLedger(ledger) {
  if (ledger?.candidateMethod !== OWNED_OVERLAY_METHOD) {
    throw new Error("Prospective ledger candidate method does not match the preregistered overlay.");
  }
  if (Number(ledger.ownedWeight) !== 0.5 || Number(ledger.consensusWeight) !== 0.5) {
    throw new Error("Prospective ledger default weights do not match the preregistered overlay.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(ledger.modelRecipeSha256 || ""))
      || ledger.trainingProjectionSourcePolicySha256 !== TRAINING_SOURCE_POLICY_SHA256) {
    throw new Error("Prospective ledger is not bound to a verified model recipe and training-source policy.");
  }
  if (JSON.stringify(ledger.trainingProjectionSourcePolicy) !== JSON.stringify({
    projectionFeatureSources: ["nflverse"],
    identityOnlySources: ["sleeper-player-catalog"],
    prohibitedProjectionFeatureSources: ["espn", "sleeper-projections", "fantasypros"],
  })) {
    throw new Error("Prospective ledger training-source policy is not independent of provider projections.");
  }
  if (ledger.ownedForecastMethod !== "pure-independent-owned"
      || ledger.privateClusteringMethod !== "stable-private-player-v1") {
    throw new Error("Prospective ledger does not identify the independent-owned forecast and clustering design.");
  }
  assertPreregisteredOwnedOverlay(ledger.positionOwnedWeights);
  for (const row of ledger.rows || []) {
    const weight = ledger.positionOwnedWeights[row.position];
    if (!Number.isFinite(Number(row.ownedProjection))
        || !Number.isFinite(Number(row.consensus))
        || !Number.isFinite(Number(row.candidate))
        || Number(row.ownedWeight) !== weight) {
      throw new Error("Prospective ledger lacks an exact independent-owned projection row.");
    }
    const expected = Number((weight * Number(row.ownedProjection)
      + (1 - weight) * Number(row.consensus)).toFixed(4));
    if (Number(row.candidate) !== expected) {
      throw new Error("Prospective ledger candidate is inconsistent with its frozen owned projection and weights.");
    }
  }
}

export function publicReceiptFromLedger(ledger) {
  const rows = Array.isArray(ledger?.rows) ? ledger.rows : [];
  const formats = [...new Set(rows.map(row => row.scoring))].sort();
  const byPosition = Object.fromEntries(POSITIONS.map(position => [position, rows.filter(row => row.position === position).length]));
  const sourceAvailability = Object.fromEntries(formats.map(scoring => [scoring, { oneSource: 0, twoSources: 0, threeSources: 0 }]));
  const sourceEvidenceCoverage = Object.fromEntries(formats.map(scoring => [scoring, Object.fromEntries(SOURCES.map(source => [source, 0]))]));
  for (const row of rows) {
    const availability = sourceAvailability[row.scoring];
    if (availability) availability[row.sourceCount === 1 ? "oneSource" : row.sourceCount === 2 ? "twoSources" : "threeSources"]++;
    for (const source of Object.keys(row.sourceProjections || {})) {
      if (sourceEvidenceCoverage[row.scoring]?.[source] !== undefined) sourceEvidenceCoverage[row.scoring][source]++;
    }
  }
  const baseDiagnosticRows = rows.filter(row => Number.isFinite(row.baseCandidate)).length;
  const pureOwnedRows = rows.filter(row => Number.isFinite(row.ownedProjection)).length;
  return {
    schemaVersion: 1, artifactType: "owned-prospective-freeze-receipt", projectionSeason: ledger.projectionSeason,
    modelVersion: ledger.modelVersion, frozenAt: ledger.frozenAt, cutoffAt: ledger.cutoffAt,
    modelRecipeSha256: ledger.modelRecipeSha256,
    trainingProjectionSourcePolicy: ledger.trainingProjectionSourcePolicy,
    trainingProjectionSourcePolicySha256: ledger.trainingProjectionSourcePolicySha256,
    evaluationOnly: true, eligibleForLivePromotion: false,
    candidateMethod: ledger.candidateMethod, ownedForecastMethod: ledger.ownedForecastMethod,
    ownedWeight: ledger.ownedWeight, consensusWeight: ledger.consensusWeight,
    positionOwnedWeights: ledger.positionOwnedWeights,
    privateClusteringMethod: ledger.privateClusteringMethod,
    ledgerSha256: digestJson(ledger), inputDigests: ledger.inputDigests, formats, players: rows.length,
    byPosition, sourceAvailability, candidateCloseness: candidateCloseness(rows), sourceEvidenceCoverage,
    pureOwnedEvidence: {
      privateRows: pureOwnedRows,
      complete: pureOwnedRows === rows.length && rows.length > 0,
      eligibleForLivePromotion: false,
    },
    diagnosticVariants: {
      noWrRookieSpecialistBase: {
        evaluationOnly: true,
        eligibleForLivePromotion: false,
        rows: baseDiagnosticRows,
        method: "Same frozen consensus overlay using the owned base forecast before the WR-rookie direct-total specialist.",
      },
    },
    method: "Public aggregate receipt for a private, salted-identity ledger containing the preregistered consensus-anchored owned candidate, final weighted consensus, and exact source projections needed to prove individual-source superiority. Provider values remain private and are never emitted in public receipts or outcome reports.",
  };
}

function aliases(player) {
  const values = [
    ["id", player.id], ["gsis", player.gsisId], ["nflverse", player.nflverseId],
    ["owned", player.ownedPlayerId], ["espn", player.espnId],
    ["namePosition", `${normalizeName(player.name)}:${String(player.position || "").toUpperCase()}`],
  ];
  return [...new Set(values.filter(([, value]) => canonical(value)).map(([kind, value]) => `${kind}:${canonical(value)}`))];
}

function snapshotIndex(snapshot) {
  return new Map((snapshot?.players || []).filter(row => Number(row.points) > 0).map(row => [String(row.id), row]));
}

function ownedPoints(player, scoring) {
  return Number(scoring === "STD" ? player.meanStd : scoring === "HALF" ? player.meanHalf : player.meanPpr ?? player.mean);
}

function ownedBasePoints(player, scoring) {
  return Number(scoring === "STD" ? player.baseMeanStd : scoring === "HALF" ? player.baseMeanHalf : player.baseMeanPpr);
}

export function captureProspectiveEvidence({ owned, snapshotsByFormat, cutoffAt, frozenAt = new Date().toISOString(), salt = crypto.randomBytes(32).toString("hex"), inputDigests = {}, requireClosenessGate = false, requireFreshOwnedCandidate = true, ownedWeight, positionOwnedWeights }) {
  if (owned.runtimeStatus !== "shadow" || owned.eligibleAsLiveProjection !== false) throw new Error("Only a shadow-only owned candidate may be frozen.");
  const cutoffTime = Date.parse(cutoffAt), frozenTime = Date.parse(frozenAt), candidateTime = Date.parse(owned.generatedAt);
  if (![cutoffTime, frozenTime, candidateTime].every(Number.isFinite)) throw new Error("Candidate, freeze, and cutoff timestamps must be valid.");
  if (candidateTime > cutoffTime || frozenTime > cutoffTime) throw new Error("Candidate and freeze must occur on or before the prospective cutoff.");
  if (requireFreshOwnedCandidate && cutoffTime - candidateTime > MAX_FROZEN_OWNED_AGE_MS) throw new Error("Owned candidate must be generated within 72 hours of the prospective cutoff.");
  if (ownedWeight !== undefined && Number(ownedWeight) !== 0.5) {
    throw new Error("Default owned weight does not match the preregistered overlay.");
  }
  if (positionOwnedWeights !== undefined) assertPreregisteredOwnedOverlay(positionOwnedWeights);
  const appliedPositionOwnedWeights = { ...OWNED_OVERLAY_POSITION_WEIGHTS };
  const rows = [], formats = [];
  let featureMaxObservedAt = owned.generatedAt;
  for (const [scoringRaw, snapshots] of Object.entries(snapshotsByFormat || {})) {
    const scoring = scoringRaw.toUpperCase();
    if (!FORMATS.includes(scoring)) throw new Error(`Unsupported scoring format: ${scoring}`);
    formats.push(scoring);
    for (const snapshot of Object.values(snapshots)) {
      const capturedAt = snapshot.capturedAt || snapshot.fetchedAt;
      if (Number(snapshot.season) !== Number(owned.projectionSeason) || String(snapshot.scoring).toUpperCase() !== scoring) throw new Error("Snapshot season/scoring does not match the frozen candidate.");
      if (!Number.isFinite(Date.parse(capturedAt)) || Date.parse(capturedAt) > Date.parse(cutoffAt)) throw new Error("Source snapshot was captured after the prospective cutoff.");
      if (Date.parse(capturedAt) > Date.parse(featureMaxObservedAt)) featureMaxObservedAt = capturedAt;
    }
    const maps = Object.fromEntries(Object.entries(snapshots).map(([source, snapshot]) => [source, snapshotIndex(snapshot)]));
    for (const player of owned.players || []) {
      const id = String(player.id), espn = maps.espn?.get(id), sleeper = maps.sleeper?.get(id), fantasyPros = maps.fantasyPros?.get(id);
      const sourceCount = Number(Boolean(espn)) + Number(Boolean(sleeper)) + Number(Boolean(fantasyPros));
      const ownedProjection = ownedPoints(player, scoring);
      if (!sourceCount || !(ownedProjection > 0)) continue;
      const sources = {};
      if (sleeper) sources.sleeper = { points: sleeper.points, season: sleeper.projectionSeason, kind: "cross-platform-draft-site" };
      if (fantasyPros) sources.fantasyPros = { points: fantasyPros.points, season: fantasyPros.projectionSeason, kind: "public-html" };
      const consensus = projectionConsensus({ season: owned.projectionSeason, platform: "espn", platformProjection: espn?.points, sources });
      if (!(consensus.points > 0)) continue;
      const appliedOwnedWeight = appliedPositionOwnedWeights[player.position];
      const candidate = Number((appliedOwnedWeight * ownedProjection + (1 - appliedOwnedWeight) * consensus.points).toFixed(4));
      const baseProjection = ownedBasePoints(player, scoring);
      const playerAliases = aliases(player);
      const clusterAlias = playerAliases.find(value => value.startsWith("gsis:"))
        || playerAliases.find(value => value.startsWith("nflverse:"))
        || playerAliases.find(value => value.startsWith("owned:"))
        || playerAliases.find(value => value.startsWith("espn:"))
        || playerAliases.find(value => value.startsWith("namePosition:"))
        || playerAliases[0];
      const evidenceRow = {
        identityHashes: playerAliases.map(value => sha256(`${salt}\0${value}`)).sort(),
        playerClusterId: sha256(`owned-private-player-cluster-v1\0${clusterAlias}`),
        teamClusterId: sha256(`owned-private-team-cluster-v1\0${owned.projectionSeason}:${canonical(player.team)}`),
        position: player.position, scoring, candidate, consensus: consensus.points, sourceCount,
        ownedProjection: Number(ownedProjection),
        ownedWeight: appliedOwnedWeight,
        sourceProjections: Object.fromEntries([
          ["espn", espn?.points],
          ["sleeper", sleeper?.points],
          ["fantasyPros", fantasyPros?.points],
        ].filter(([, points]) => Number(points) > 0).map(([source, points]) => [source, Number(points)])),
      };
      if (player.position === "WR" && baseProjection > 0 && baseProjection !== ownedProjection) {
        evidenceRow.baseCandidate = Number((appliedOwnedWeight * baseProjection + (1 - appliedOwnedWeight) * consensus.points).toFixed(4));
      }
      rows.push(evidenceRow);
    }
  }
  const ledger = {
    schemaVersion: 1, artifactType: "owned-prospective-ledger-private", privateEvidence: true,
    projectionSeason: owned.projectionSeason, modelVersion: owned.modelVersion, frozenAt, cutoffAt, featureMaxObservedAt,
    runtimeStatus: "shadow", eligibleForLivePromotion: false, candidateMethod: OWNED_OVERLAY_METHOD,
    ownedForecastMethod: "pure-independent-owned",
    modelRecipeSha256: owned.modelRecipeSha256,
    trainingProjectionSourcePolicy: owned.trainingProjectionSourcePolicy,
    trainingProjectionSourcePolicySha256: owned.trainingProjectionSourcePolicySha256,
    privateClusteringMethod: "stable-private-player-v1",
    ownedWeight: 0.5, consensusWeight: 0.5,
    positionOwnedWeights: appliedPositionOwnedWeights, salt, inputDigests, rows,
  };
  assertProspectiveOverlayLedger(ledger);
  const closeness = candidateCloseness(rows);
  if (requireClosenessGate && !closeness.evaluable) throw new Error(`Prospective candidate lacks enough joined format/position coverage for the consensus-closeness gate: ${JSON.stringify(closeness)}`);
  const receipt = publicReceiptFromLedger(ledger);
  return { ledger, receipt };
}

export function writeProspectiveEvidence({ ledger, receipt = publicReceiptFromLedger(ledger), ledgerFile, receiptFile, fileSystem = fs }) {
  assertProspectiveOverlayLedger(ledger);
  const expectedReceipt = publicReceiptFromLedger(ledger);
  if (JSON.stringify(receipt) !== JSON.stringify(expectedReceipt)) {
    throw new Error("Prospective receipt does not exactly match the canonical private-ledger receipt.");
  }
  if (expectedReceipt.candidateCloseness?.evaluable !== true
      || expectedReceipt.candidateCloseness?.coveredSlices?.length !== 18) {
    throw new Error("Refusing to write immutable evidence without complete evaluable 18-slice coverage.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(ledger.inputDigests?.owned || ""))
      || !/^[a-f0-9]{64}$/.test(String(ledger.inputDigests?.finalRefreshManifest || ""))) {
    throw new Error("Refusing immutable evidence not bound to a verified final-refresh candidate.");
  }
  const anchorFile = `${ledgerFile}.sha256`;
  if ([ledgerFile, anchorFile, receiptFile].some(file => fileSystem.existsSync(file))) {
    throw new Error("Refusing to overwrite frozen prospective evidence.");
  }
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger)}\n`);
  const ledgerDigest = sha256(ledgerBytes);
  if (receipt.ledgerSha256 !== ledgerDigest) throw new Error("Prospective receipt does not match the private ledger.");
  const ledgerStage = path.join(path.dirname(ledgerFile), `.${path.basename(ledgerFile)}.staging-${crypto.randomUUID()}`);
  const anchorStage = path.join(path.dirname(anchorFile), `.${path.basename(anchorFile)}.staging-${crypto.randomUUID()}`);
  const receiptStage = path.join(path.dirname(receiptFile), `.${path.basename(receiptFile)}.staging-${crypto.randomUUID()}`);
  fileSystem.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fileSystem.mkdirSync(path.dirname(receiptFile), { recursive: true });
  try {
    fileSystem.writeFileSync(ledgerStage, ledgerBytes, { flag: "wx" });
    fileSystem.writeFileSync(anchorStage, `${ledgerDigest}\n`, { flag: "wx" });
    fileSystem.writeFileSync(receiptStage, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    fileSystem.renameSync(anchorStage, anchorFile);
    fileSystem.renameSync(ledgerStage, ledgerFile);
    fileSystem.renameSync(receiptStage, receiptFile);
  } catch (error) {
    for (const file of [ledgerStage, anchorStage, receiptStage]) {
      if (fileSystem.existsSync(file)) fileSystem.rmSync(file, { force: true });
    }
    if (fileSystem.existsSync(anchorFile) && !fileSystem.existsSync(ledgerFile)) fileSystem.rmSync(anchorFile, { force: true });
    if (fileSystem.existsSync(ledgerFile) && fileSystem.existsSync(anchorFile) && !fileSystem.existsSync(receiptFile)) {
      throw new Error(`Private projection evidence froze successfully but public receipt publication failed. Run recovery; private bytes were preserved. Cause: ${error?.message || error}`);
    }
    throw error;
  }
  return { ledgerFile, anchorFile, receiptFile, receipt };
}

export function recoverProspectiveReceipt({ ledgerFile, receiptFile, fileSystem = fs }) {
  const anchorFile = `${ledgerFile}.sha256`;
  if (fileSystem.existsSync(receiptFile)) throw new Error("Refusing to overwrite an existing prospective receipt.");
  if (!fileSystem.existsSync(ledgerFile) || !fileSystem.existsSync(anchorFile)) {
    throw new Error("Private projection ledger and digest anchor are required for recovery.");
  }
  const ledgerBytes = fileSystem.readFileSync(ledgerFile);
  const anchoredDigest = String(fileSystem.readFileSync(anchorFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(anchoredDigest) || sha256(ledgerBytes) !== anchoredDigest) {
    throw new Error("Private projection ledger failed digest-anchor validation.");
  }
  const ledger = JSON.parse(ledgerBytes);
  if (ledger.artifactType !== "owned-prospective-ledger-private"
      || ledger.runtimeStatus !== "shadow"
      || ledger.eligibleForLivePromotion !== false
      || Date.parse(ledger.frozenAt) > Date.parse(ledger.cutoffAt)) {
    throw new Error("Private projection ledger failed recovery boundary validation.");
  }
  assertProspectiveOverlayLedger(ledger);
  if (!/^[a-f0-9]{64}$/.test(String(ledger.inputDigests?.owned || ""))
      || !/^[a-f0-9]{64}$/.test(String(ledger.inputDigests?.finalRefreshManifest || ""))) {
    throw new Error("Private projection ledger is not bound to a verified final-refresh candidate.");
  }
  const receipt = publicReceiptFromLedger(ledger);
  if (receipt.candidateCloseness?.evaluable !== true
      || receipt.candidateCloseness?.coveredSlices?.length !== 18) {
    throw new Error("Private projection ledger lacks complete evaluable 18-slice coverage.");
  }
  if (receipt.ledgerSha256 !== anchoredDigest) throw new Error("Recovered receipt does not match the digest anchor.");
  fileSystem.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fileSystem.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return { ledgerFile, anchorFile, receiptFile, receipt, recovered: true };
}

export function scoreProspectiveEvidence({ ledger, receipt, actuals, generatedAt = new Date().toISOString() }) {
  if (receipt.ledgerSha256 !== digestJson(ledger)) throw new Error("Frozen ledger digest does not match its public receipt.");
  if (JSON.stringify(receipt) !== JSON.stringify(publicReceiptFromLedger(ledger))) throw new Error("Public receipt metadata does not match the frozen private ledger.");
  if (ledger.runtimeStatus !== "shadow" || ledger.eligibleForLivePromotion !== false) throw new Error("Prospective ledger is not shadow-only.");
  assertProspectiveOverlayLedger(ledger);
  if (Number(actuals.season) !== Number(ledger.projectionSeason) || actuals.complete !== true) throw new Error("Completed same-season outcomes are required.");
  if (ledger.inputDigests?.owned) {
    if (actuals.populationBoundary !== "frozen-owned-candidate"
        || actuals.populationComplete !== true
        || actuals.frozenCandidateSha256 !== ledger.inputDigests.owned
        || Number(actuals.population?.unmatchedCandidateRows) !== 0
        || Number(actuals.population?.candidateRows) !== (actuals.players || []).length) {
      throw new Error("Completed outcomes do not cover the exact frozen candidate population.");
    }
  }
  const paired = buildPromotionRows({ ledger, actuals });
  if (paired.length !== ledger.rows.length) throw new Error("Completed outcomes do not match every frozen projection row.");
  const summarize = selected => ({ candidate: metrics(selected, "candidate"), consensus: metrics(selected, "consensus"), pairedMaeDelta: selected.length ? mean(selected.map(row => Math.abs(row.candidate - row.actual) - Math.abs(row.consensus - row.actual))) : null });
  const summarizeOwned = selected => ({ owned: metrics(selected, "ownedProjection"), consensus: metrics(selected, "consensus"), pairedMaeDelta: selected.length ? mean(selected.map(row => Math.abs(row.ownedProjection - row.actual) - Math.abs(row.consensus - row.actual))) : null });
  const summarizeBase = selected => ({ candidate: metrics(selected, "baseCandidate"), consensus: metrics(selected, "consensus"), pairedMaeDelta: selected.length ? mean(selected.map(row => Math.abs(row.baseCandidate - row.actual) - Math.abs(row.consensus - row.actual))) : null });
  const byFormatPosition = {};
  for (const scoring of FORMATS) for (const position of POSITIONS) byFormatPosition[`${scoring}:${position}`] = summarize(paired.filter(row => row.scoring === scoring && row.position === position));
  const ownedByFormatPosition = {};
  for (const scoring of FORMATS) for (const position of POSITIONS) ownedByFormatPosition[`${scoring}:${position}`] = summarizeOwned(paired.filter(row => row.scoring === scoring && row.position === position));
  const bySourceAvailability = Object.fromEntries([1, 2, 3].map(sourceCount => [String(sourceCount), summarize(paired.filter(row => row.sourceCount === sourceCount))]));
  const basePaired = paired.filter(row => Number.isFinite(row.baseCandidate));
  const baseByFormatPosition = {};
  for (const scoring of FORMATS) for (const position of POSITIONS) baseByFormatPosition[`${scoring}:${position}`] = summarizeBase(basePaired.filter(row => row.scoring === scoring && row.position === position));
  const individualSources = Object.fromEntries(SOURCES.map(source => {
    const selected = paired.filter(row => Number.isFinite(row.sourceProjections?.[source]));
    const sourceRows = selected.map(row => ({ ...row, sourceProjection: row.sourceProjections[source] }));
    return [source, {
      rows: selected.length,
      candidate: metrics(selected, "candidate"),
      source: metrics(sourceRows, "sourceProjection"),
      pairedMaeDelta: selected.length ? mean(selected.map(row => Math.abs(row.candidate - row.actual) - Math.abs(row.sourceProjections[source] - row.actual))) : null,
    }];
  }));
  const ownedIndividualSources = Object.fromEntries(SOURCES.map(source => {
    const selected = paired.filter(row => Number.isFinite(row.sourceProjections?.[source]));
    const sourceRows = selected.map(row => ({ ...row, sourceProjection: row.sourceProjections[source] }));
    return [source, {
      rows: selected.length,
      owned: metrics(selected, "ownedProjection"),
      source: metrics(sourceRows, "sourceProjection"),
      pairedMaeDelta: selected.length ? mean(selected.map(row => Math.abs(row.ownedProjection - row.actual) - Math.abs(row.sourceProjections[source] - row.actual))) : null,
    }];
  }));
  return {
    schemaVersion: 1, artifactType: "owned-prospective-outcome-report", generatedAt,
    projectionSeason: ledger.projectionSeason, modelVersion: ledger.modelVersion, cutoffAt: ledger.cutoffAt,
    candidateMethod: ledger.candidateMethod, ownedForecastMethod: ledger.ownedForecastMethod,
    ownedWeight: ledger.ownedWeight, consensusWeight: ledger.consensusWeight,
    positionOwnedWeights: ledger.positionOwnedWeights,
    ledgerSha256: receipt.ledgerSha256, outcomesDigest: digestJson(actuals), evaluationOnly: true,
    eligibleForLivePromotion: false, promotionStatus: "unchanged-shadow", prospectiveShadowSeasonCompleted: true,
    matchedRows: paired.length, unmatchedRows: ledger.rows.length - paired.length, overall: summarize(paired),
    outcomePopulation: {
      boundary: actuals.populationBoundary || "legacy-unspecified",
      complete: actuals.populationComplete === true,
      candidateRows: Number(actuals.population?.candidateRows) || null,
      zeroRecordedProductionRows: Number(actuals.population?.zeroRecordedProductionRows) || 0,
      unmatchedCandidateRows: Number(actuals.population?.unmatchedCandidateRows) || 0,
    },
    allThreeSources: summarize(paired.filter(row => row.sourceCount === 3)), bySourceAvailability, byFormatPosition,
    individualSources,
    independentOwnedReplacement: {
      evaluationOnly: true,
      eligibleForLivePromotion: false,
      overall: summarizeOwned(paired),
      allThreeSources: summarizeOwned(paired.filter(row => row.sourceCount === 3)),
      byFormatPosition: ownedByFormatPosition,
      individualSources: ownedIndividualSources,
      method: "Aggregate-only scoring of the independent owned forecast itself. Runtime replacement remains forbidden unless this forecast, not only the consensus-anchored overlay, passes every promotion gate.",
    },
    diagnosticVariants: {
      noWrRookieSpecialistBase: {
        evaluationOnly: true,
        eligibleForLivePromotion: false,
        matchedRows: basePaired.length,
        overall: summarizeBase(basePaired),
        allThreeSources: summarizeBase(basePaired.filter(row => row.sourceCount === 3)),
        byFormatPosition: baseByFormatPosition,
      },
    },
    method: "Aggregate-only paired outcome scoring of both the frozen consensus-anchored candidate and the independent owned forecast versus the frozen final weighted consensus and each individual source on its matched cohort. No provider rows or player identities are emitted.",
  };
}

export function buildPromotionRows({ ledger, actuals }) {
  if (Number(actuals.season) !== Number(ledger.projectionSeason) || actuals.complete !== true) throw new Error("Completed same-season outcomes are required.");
  const actualByHash = new Map();
  for (const player of actuals.players || []) {
    for (const value of aliases(player)) actualByHash.set(sha256(`${ledger.salt}\0${value}`), player);
  }
  const paired = [];
  for (const row of ledger.rows) {
    const actualPlayer = row.identityHashes.map(value => actualByHash.get(value)).find(Boolean);
    if (!actualPlayer) continue;
    const actual = Number(row.scoring === "STD" ? actualPlayer.pointsStd : row.scoring === "HALF" ? actualPlayer.pointsHalf : actualPlayer.pointsPpr);
    if (!Number.isFinite(actual)) continue;
    paired.push({
      season: Number(ledger.projectionSeason), scoring: row.scoring, position: row.position,
      playerId: row.identityHashes[0], candidate: row.candidate, consensus: row.consensus,
      ownedProjection: row.ownedProjection,
      actual, sourceCount: row.sourceCount, cutoffAt: ledger.cutoffAt,
      featureMaxObservedAt: ledger.featureMaxObservedAt,
      playerClusterId: row.playerClusterId,
      teamClusterId: row.teamClusterId,
      ...(Number.isFinite(row.baseCandidate) ? { baseCandidate: row.baseCandidate } : {}),
      sourceProjections: Object.fromEntries(Object.entries(row.sourceProjections || {}).filter(([, value]) => Number.isFinite(Number(value))).map(([source, value]) => [source, Number(value)])),
    });
  }
  return paired;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "capture") {
    throw new Error("Lower-level capture is retired. Use owned:freeze-latest so evidence is bound to the verified final-refresh manifest.");
  } else if (command === "score") {
    const [ledgerFile, receiptFile, actualsFile, reportFile] = args, report = scoreProspectiveEvidence({ ledger: readJson(ledgerFile), receipt: readJson(receiptFile), actuals: readJson(actualsFile) });
    fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }); console.log(JSON.stringify({ report: reportFile, matchedRows: report.matchedRows }, null, 2));
  } else if (command === "recover") {
    const [ledgerFile, receiptFile] = args;
    if (!ledgerFile || !receiptFile) throw new Error("Usage: prospective-evidence.js recover <private-ledger> <receipt>");
    const result = recoverProspectiveReceipt({ ledgerFile, receiptFile });
    console.log(JSON.stringify({ ledger: ledgerFile, receipt: receiptFile, recovered: true, ledgerSha256: result.receipt.ledgerSha256 }, null, 2));
  } else throw new Error("Usage: prospective-evidence.js score <ledger> <receipt> <actuals> <report> | recover <private-ledger> <receipt>");
}
