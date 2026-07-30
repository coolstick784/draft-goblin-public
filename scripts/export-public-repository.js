import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PUBLIC_ROOT_ENTRIES = Object.freeze([
  ".gitignore",
  "PRIVACY.md",
  "PROJECT_GOAL.md",
  "README.md",
  "RELEASE_CHECKLIST.md",
  "SECURITY.md",
  "STORE_LISTING.md",
  "core",
  "docs",
  "extension",
  "owned_model",
  "package.json",
  "pnpm-lock.yaml",
  "requirements-owned-model.txt",
  "scripts",
  "server",
  "shared",
  "store-assets",
  "test"
]);

export const PUBLIC_DATA_FILES = Object.freeze([
  "data/generated/current-baseline.json",
  "data/generated/owned-projections-2026.json",
  "data/generated/sleeper-current-catalog.json",
  "data/projection-model-policy.json",
  "data/research/player-performance-ranges.json",
  "data/research/player-season-distribution-runtime.json",
  "data/research/player-weekly-distributions-quantile-v1.json",
  "data/source-policy.json"
]);

const forbiddenPath = /(^|\/)(?:\.git|\.github|data\/(?:cache|historical|private|reports|snapshots|vendor))(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:key|pem|pfx|p12|zip|log))$/i;

function relativeFiles(directory) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Public export refuses symbolic link: ${path.relative(directory, absolute)}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
    }
  };
  visit(directory);
  return files;
}

function copyEntry(relative, destination) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`Required public export source is missing: ${relative}`);
  const output = path.join(destination, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.cpSync(source, output, { recursive: true, force: false, errorOnExist: true });
}

export function exportPublicRepository(destination, { sourceCommit } = {}) {
  const output = path.resolve(destination);
  if (output === root || output.startsWith(`${root}${path.sep}`)) throw new Error("Public export destination must be outside the private repository.");
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("Public export destination must be empty.");
  fs.mkdirSync(output, { recursive: true });

  for (const entry of PUBLIC_ROOT_ENTRIES) copyEntry(entry, output);
  for (const entry of PUBLIC_DATA_FILES) copyEntry(entry, output);

  const commit = sourceCommit || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const receipt = {
    schemaVersion: 1,
    sourceRepository: "https://github.com/coolstick784/draft-goblin",
    sourceCommit: commit,
    publicationModel: "sanitized-snapshot",
    excluded: [
      "Git history and non-main branches",
      "Private data, caches, reports, and credentials",
      "Raw provider projections and snapshots",
      "Historical draft records",
      "Vendored datasets and archives",
      "Private-repository GitHub workflows"
    ]
  };
  fs.writeFileSync(path.join(output, "PUBLIC_EXPORT.json"), `${JSON.stringify(receipt, null, 2)}\n`);

  const files = relativeFiles(output);
  const forbidden = files.filter(file => forbiddenPath.test(file));
  if (forbidden.length) throw new Error(`Forbidden public export paths:\n${forbidden.join("\n")}`);
  for (const required of ["PRIVACY.md", "README.md", "extension/manifest.json", "extension/background.js"]) {
    if (!files.includes(required)) throw new Error(`Public export omitted required file: ${required}`);
  }
  return { destination: output, sourceCommit: commit, files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: node scripts/export-public-repository.js <empty-output-directory>");
  console.log(JSON.stringify(exportPublicRepository(destination, { sourceCommit: process.env.GITHUB_SHA }), null, 2));
}
