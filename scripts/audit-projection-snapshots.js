import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assessProjectionSnapshot } from "../server/projection-snapshots.js";

export function auditProjectionSnapshots(directory, options = {}) {
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith(".json")) : [];
  const rows = files.map(file => {
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      return { file, snapshotId: snapshot.snapshotId || null, source: snapshot.source, season: snapshot.season, scoring: snapshot.scoring, capturedAt: snapshot.capturedAt || snapshot.fetchedAt, ...assessProjectionSnapshot(snapshot, options) };
    } catch (error) { return { file, valid: false, promotableInput: false, errors: ["invalid-json"], detail: String(error.message) }; }
  });
  const accepted = rows.filter(row => row.valid).length, rejected = rows.length - accepted;
  return { schemaVersion: "projection-snapshot-audit-v1", generatedAt: new Date().toISOString(), promotionBoundary: "Integrity acceptance only. Forecasting models still require untouched outcome holdouts before promotion.", summary: { files: rows.length, accepted, rejected, acceptanceRate: rows.length ? accepted / rows.length : 0 }, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url))), directory = path.resolve(process.argv[2] || path.join(root, "data/snapshots"));
  const report = auditProjectionSnapshots(directory), output = path.resolve(process.argv[3] || path.join(root, "data/research/projection-snapshot-integrity.json"));
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report.summary));
}
