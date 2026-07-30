import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  preparePublicEvidenceRepo,
  PUBLIC_RECEIPT_FILE,
  PUBLIC_TEMPLATE_FILES,
} from "../scripts/owned-model/prepare-public-evidence-repo.js";

const allFiles = root => {
  const result = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const value = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(value);
      else result.push(path.relative(root, value).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return result.sort();
};

test("public evidence template contains only the exact privacy-audited allowlist", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-evidence-template-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "repo");
  const result = preparePublicEvidenceRepo({ outputDirectory: output });
  assert.equal(result.files, PUBLIC_TEMPLATE_FILES.length);
  assert.deepEqual(allFiles(output), [...PUBLIC_TEMPLATE_FILES].sort());
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);

  const packageValue = JSON.parse(fs.readFileSync(
    path.join(output, "package.json"),
  ));
  assert.equal(packageValue.type, "module");
  assert.equal(packageValue.private, true);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(output, "template-manifest.json"),
  ));
  assert.equal(manifest.receiptPath, PUBLIC_RECEIPT_FILE);
  assert.equal(manifest.files.length, PUBLIC_TEMPLATE_FILES.length - 1);
});

test("public evidence template workflow is checksum-only and uploads no bytes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-evidence-workflow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "repo");
  preparePublicEvidenceRepo({ outputDirectory: output });
  const workflow = fs.readFileSync(
    path.join(
      output,
      ".github/workflows/attest-owned-prospective-freeze.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /subject-checksums:/);
  assert.match(workflow, new RegExp(
    PUBLIC_RECEIPT_FILE.replaceAll(".", "\\."),
  ));
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /data\/private\//);
  assert.doesNotMatch(workflow, /data\/snapshots\//);
});

test("public evidence template refuses overwrite", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-evidence-refuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "repo");
  preparePublicEvidenceRepo({ outputDirectory: output });
  assert.throws(
    () => preparePublicEvidenceRepo({ outputDirectory: output }),
    /Refusing to overwrite/,
  );
});
