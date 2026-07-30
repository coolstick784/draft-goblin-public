import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function verifyPreseasonAvailabilityDataGap(report) {
  if (report?.decision?.status !== "rejected-before-modeling"
      || report?.decision?.buildHarness !== false
      || report?.decision?.productionAction !== "Do not add an availability feature and do not alter the owned model or live consensus.") {
    throw new Error("Preseason availability data-gap decision is invalid.");
  }
  return {
    valid: true,
    baseModelVersion: report.baseModelVersion,
    status: report.decision.status,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const reportPath = process.argv[2] || "data/research/owned-model-preseason-availability-data-gap.json";
  console.log(JSON.stringify(
    verifyPreseasonAvailabilityDataGap(JSON.parse(fs.readFileSync(reportPath, "utf8"))),
    null,
    2,
  ));
}
