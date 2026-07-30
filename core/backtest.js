export function brierScore(rows) { return rows.reduce((n, r) => n + (r.probability - r.outcome) ** 2, 0) / Math.max(1, rows.length); }
export function calibration(rows, bins = 10) {
  const groups = Array.from({ length: bins }, () => []); rows.forEach(r => groups[Math.min(bins - 1, Math.floor(r.probability * bins))].push(r));
  const detail = groups.filter(g => g.length).map(g => ({ count: g.length, predicted: g.reduce((n, r) => n + r.probability, 0) / g.length, observed: g.reduce((n, r) => n + r.outcome, 0) / g.length }));
  return { bins: detail, expectedCalibrationError: detail.reduce((n, g) => n + g.count / Math.max(1, rows.length) * Math.abs(g.predicted - g.observed), 0) };
}
export function walkForward(records, predictor) {
  const seasons = [...new Set(records.map(r => r.season))].sort(), results = [];
  for (let i = 1; i < seasons.length; i++) { const training = records.filter(r => r.season < seasons[i]), test = records.filter(r => r.season === seasons[i]); for (const row of test) { if (row.snapshotAt > row.draftAt) throw new Error("data leakage: snapshot created after draft"); results.push({ season: row.season, probability: predictor(row, training), outcome: row.champion ? 1 : 0 }); } }
  return { rows: results, brier: brierScore(results), ...calibration(results) };
}
