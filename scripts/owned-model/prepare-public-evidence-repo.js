import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_SOURCE = ".github/workflows/attest-owned-prospective-freeze.yml";
const VALIDATOR_SOURCE = "scripts/owned-model/verify-public-freeze-receipt.js";
export const PUBLIC_TEMPLATE_FILES = Object.freeze([
  ".gitignore",
  ".github/workflows/attest-owned-prospective-freeze.yml",
  "README.md",
  "package.json",
  "scripts/owned-model/verify-public-freeze-receipt.js",
  "template-manifest.json",
]);
export const PUBLIC_RECEIPT_FILE =
  "data/research/owned-prospective-freeze-2026.json";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const normalized = value => String(value).replaceAll("\\", "/");

function writeExclusive(fileSystem, destination, bytes) {
  fileSystem.mkdirSync(path.dirname(destination), { recursive: true });
  fileSystem.writeFileSync(destination, bytes, { flag: "wx" });
}

function templateReadme() {
  return `# Draft Goblin owned-model evidence

This public repository contains only the validator, GitHub attestation workflow,
and aggregate receipt for the preregistered 2026 owned-model freeze.

It must never contain player rows, provider projections, source snapshots,
private ledgers, salts, model binaries, or private candidate bytes. The
attestation workflow validates the aggregate receipt and submits checksum-only
subjects for the private candidate and ledger.

When the private freeze succeeds, copy only:

\`${PUBLIC_RECEIPT_FILE}\`

into the same path here. The workflow runs on that receipt and uploads no
artifact.
`;
}

function templateGitignore() {
  return `node_modules/
data/private/
data/snapshots/
*.joblib
*.parquet
*.csv
*.private.*
owned-projections-*.json
owned-prospective-ledger-*.json
*.sha256
`;
}

function templatePackage() {
  return `${JSON.stringify({
    name: "draft-goblin-owned-evidence",
    version: "1.0.0",
    private: true,
    type: "module",
    engines: { node: ">=20" },
  }, null, 2)}\n`;
}

function assertSafeSources(workflow, validator) {
  if (workflow.includes("actions/upload-artifact")
      || workflow.includes("data/private/")
      || workflow.includes("data/snapshots/")
      || workflow.includes("owned-projections-2026.json")
      || !workflow.includes("subject-checksums:")
      || !workflow.includes(PUBLIC_RECEIPT_FILE)
      || !workflow.includes(VALIDATOR_SOURCE)) {
    throw new Error(
      "Evidence workflow is not checksum-only or references private artifacts.",
    );
  }
  if (!validator.includes("assertNoPrivateFields")
      || !validator.includes("checksumSubjects")
      || !validator.includes("FORBIDDEN_PRIVATE_KEYS")) {
    throw new Error("Evidence receipt validator lacks required privacy guards.");
  }
}

export function preparePublicEvidenceRepo({
  sourceRoot = process.cwd(),
  outputDirectory =
    "data/private/owned-model/public-evidence-repo",
  fileSystem = fs,
} = {}) {
  const output = path.resolve(outputDirectory);
  if (fileSystem.existsSync(output)) {
    throw new Error("Refusing to overwrite an existing public-evidence template.");
  }
  const workflow = fileSystem.readFileSync(
    path.resolve(sourceRoot, WORKFLOW_SOURCE),
  );
  const validator = fileSystem.readFileSync(
    path.resolve(sourceRoot, VALIDATOR_SOURCE),
  );
  assertSafeSources(workflow.toString("utf8"), validator.toString("utf8"));

  const files = new Map([
    [".gitignore", Buffer.from(templateGitignore())],
    [WORKFLOW_SOURCE, workflow],
    ["README.md", Buffer.from(templateReadme())],
    ["package.json", Buffer.from(templatePackage())],
    [VALIDATOR_SOURCE, validator],
  ]);
  const manifest = {
    schemaVersion: 1,
    artifactType: "owned-public-evidence-repository-template",
    receiptPath: PUBLIC_RECEIPT_FILE,
    allowedFilesBeforeFreeze: [
      ".gitignore",
      WORKFLOW_SOURCE,
      "README.md",
      "package.json",
      VALIDATOR_SOURCE,
      "template-manifest.json",
    ],
    allowedAdditionalFileAfterFreeze: PUBLIC_RECEIPT_FILE,
    forbiddenPathPrefixes: ["data/private/", "data/snapshots/"],
    files: [...files.entries()].map(([file, bytes]) => ({
      file,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  files.set(
    "template-manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );

  try {
    for (const [file, bytes] of files) {
      writeExclusive(fileSystem, path.join(output, file), bytes);
    }
  } catch (error) {
    if (fileSystem.existsSync(output)) {
      fileSystem.rmSync(output, { recursive: true, force: true });
    }
    throw error;
  }

  const actual = [];
  for (const file of PUBLIC_TEMPLATE_FILES) {
    const destination = path.join(output, file);
    if (!fileSystem.existsSync(destination)) {
      throw new Error(`Prepared evidence template is missing ${file}.`);
    }
    actual.push(normalized(path.relative(output, destination)));
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(
    [...PUBLIC_TEMPLATE_FILES].sort(),
  )) {
    throw new Error("Prepared evidence template failed its exact allowlist.");
  }
  return {
    outputDirectory: output,
    files: actual.length,
    manifestSha256: sha256(
      fileSystem.readFileSync(path.join(output, "template-manifest.json")),
    ),
  };
}

if (process.argv[1]
    && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [outputDirectory] = process.argv.slice(2);
  const result = preparePublicEvidenceRepo({
    ...(outputDirectory ? { outputDirectory } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}
