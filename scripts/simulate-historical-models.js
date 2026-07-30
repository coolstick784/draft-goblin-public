import fs from "node:fs";
import { pathToFileURL } from "node:url";

// This uses only data that existed when each draft ended: draft order, positions,
// settings, and its eventual champion. Player points, league/user identifiers, and
// future seasons are deliberately not inputs.
const FEATURE_LIBRARY = {
  slot: (record, slot) => [(slot - 1) / Math.max(1, record.teams - 1)],
  early: (record, slot) => features(record, slot).slice(1, 5),
  depth: (record, slot) => features(record, slot).slice(5),
  all: (record, slot) => features(record, slot)
};
const FAMILIES = [
  { id: "uniform", parts: [] },
  { id: "draft_slot", parts: ["slot"] },
  { id: "early_starts", parts: ["early"] },
  { id: "roster_depth", parts: ["depth"] },
  { id: "slot_and_roster", parts: ["slot", "early", "depth"] },
  { id: "roster_only", parts: ["early", "depth"] }
];
const LAMBDAS = [.01, .03, .1, .3, 1, 3, 10];

function round(record, pick) { return Math.ceil(pick.pickNo / record.teams); }
function features(record, slot) {
  const picks = record.picks.filter(p => p.slot === slot), count = (position, max = Infinity) => picks.filter(p => p.position === position && round(record, p) <= max).length;
  const first = position => Math.min(99, ...picks.filter(p => p.position === position).map(p => round(record, p)));
  const rb = count("RB"), wr = count("WR");
  return [(slot - 1) / Math.max(1, record.teams - 1), count("RB", 3), count("WR", 3), count("QB", 5), count("TE", 5), count("RB", 8), count("WR", 8), count("QB", 8), count("TE", 8), first("QB") >= 6 ? 1 : 0, first("TE") >= 6 ? 1 : 0, rb, wr, Math.abs(rb - wr)];
}
function group(record, family) { return { champion: record.championSlot - 1, teams: Array.from({ length: record.teams }, (_, i) => family.parts.flatMap(part => FEATURE_LIBRARY[part](record, i + 1))), teamCount: record.teams }; }
function scale(groups) { const all = groups.flatMap(x => x.teams), width = all[0]?.length || 0; const mean = Array.from({ length: width }, (_, j) => all.reduce((n, x) => n + x[j], 0) / all.length); const sd = mean.map((m, j) => Math.sqrt(all.reduce((n, x) => n + (x[j] - m) ** 2, 0) / all.length) || 1); return { mean, sd }; }
function normalise(row, s) { return row.map((x, j) => (x - s.mean[j]) / s.sd[j]); }
function probabilities(group, model) { if (!model.weights.length) return Array(group.teamCount).fill(1 / group.teamCount); const scores = group.teams.map(x => model.weights.reduce((n, w, j) => n + w * normalise(x, model.scale)[j], 0)), max = Math.max(...scores), values = scores.map(x => Math.exp(x - max)), total = values.reduce((a, b) => a + b, 0); return values.map(x => x / total); }
function fit(groups, lambda) { if (!groups[0]?.teams[0]?.length) return { weights: [], scale: { mean: [], sd: [] }, lambda }; const s = scale(groups), weights = s.mean.map(() => 0); for (let step = 0; step < 1800; step++) { const gradient = weights.map(() => 0); for (const row of groups) { const p = probabilities(row, { weights, scale: s }); for (let team = 0; team < row.teamCount; team++) { const error = p[team] - (team === row.champion ? 1 : 0); for (let j = 0; j < weights.length; j++) gradient[j] += error * normalise(row.teams[team], s)[j]; } } for (let j = 0; j < weights.length; j++) weights[j] -= .035 * (gradient[j] / groups.length + lambda * weights[j]); } return { weights, scale: s, lambda }; }
function evaluate(groups, model) { let logLoss = 0, brier = 0, top1 = 0, rank = 0; for (const row of groups) { const p = probabilities(row, model), sorted = p.map((value, i) => ({ value, i })).sort((a, b) => b.value - a.value); logLoss -= Math.log(Math.max(1e-12, p[row.champion])); brier += p.reduce((n, value, i) => n + (value - (i === row.champion ? 1 : 0)) ** 2, 0); const championRank = sorted.findIndex(x => x.i === row.champion) + 1; top1 += championRank === 1; rank += championRank; } const uniformLoss = groups.reduce((n, x) => n + Math.log(x.teamCount), 0) / groups.length; return { drafts: groups.length, logLoss: logLoss / groups.length, uniformLogLoss: uniformLoss, logLossImprovement: uniformLoss - logLoss / groups.length, brier: brier / groups.length, top1Accuracy: top1 / groups.length, meanChampionRank: rank / groups.length }; }
function random(seed = 20260712) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function bootstrap(groups, model, draws = 5000) { const next = random(), deltas = []; for (let draw = 0; draw < draws; draw++) { const sample = Array.from({ length: groups.length }, () => groups[Math.floor(next() * groups.length)]); deltas.push(evaluate(sample, model).logLossImprovement); } deltas.sort((a, b) => a - b); return { draws, probabilityBetter: deltas.filter(x => x > 0).length / draws, improvementInterval95: [deltas[Math.floor(draws * .025)], deltas[Math.floor(draws * .975)]] }; }
function candidates(train, validation) { return FAMILIES.map(family => { const trainRows = train.map(x => group(x, family)), validationRows = validation.map(x => group(x, family)); const options = LAMBDAS.map(lambda => { const model = fit(trainRows, lambda); return { lambda, validation: evaluate(validationRows, model) }; }); const best = [...options].sort((a, b) => a.validation.logLoss - b.validation.logLoss)[0]; return { family, lambda: best.lambda, validation: best.validation }; }).sort((a, b) => a.validation.logLoss - b.validation.logLoss); }

export function simulateHistoricalModels(dataset) {
  const redraft = dataset.records.filter(x => !String(x.scoringType).includes("dynasty"));
  const train = redraft.filter(x => x.season === 2023), validation = redraft.filter(x => x.season === 2024), test = redraft.filter(x => x.season === 2025);
  if (!train.length || !validation.length || !test.length) throw new Error("Requires redraft champion outcomes from 2023, 2024, and 2025.");
  const sweep = candidates(train, validation);
  const selected = sweep[0], trainAndValidation = [...train, ...validation].map(x => group(x, selected.family)), holdout = test.map(x => group(x, selected.family)), model = fit(trainAndValidation, selected.lambda), result = evaluate(holdout, model), uncertainty = bootstrap(holdout, model);
  return { generatedAt: new Date().toISOString(), method: "Nested model-family and regularization search: fit on 2023, select exclusively on 2024, refit on 2023-2024, then simulate 5,000 draft-level bootstrap samples of untouched 2025 champions.", dataBoundary: "Uses only sanitized draft positions, draft slots, roster settings, and season-ending champion slot. It cannot calibrate live title odds without timestamped projections, weekly scores, and lineup outcomes.", records: { redraft: redraft.length, train2023: train.length, validation2024: validation.length, test2025: test.length }, families: sweep.map(x => ({ family: x.family.id, selectedLambda: x.lambda, validation: x.validation })), selected: { family: selected.family.id, selectedLambda: selected.lambda, holdout: result, uncertainty, eligible: result.logLossImprovement > 0 && uncertainty.probabilityBetter >= .8 }, decision: result.logLossImprovement > 0 && uncertainty.probabilityBetter >= .8 ? "Eligible only as a capped historical roster-construction prior." : "Not promoted: holdout evidence is insufficient for a production model change." };
}

const input = process.argv[2] || "data/historical/sleeper-drafts.json", output = process.argv[3] || "data/research/historical-simulation-report.json";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const report = simulateHistoricalModels(JSON.parse(fs.readFileSync(input, "utf8"))); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2)); }
