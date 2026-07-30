import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(root, "test");
const tests = fs.readdirSync(testRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.js"))
  .map(entry => path.join("test", entry.name))
  .sort();

if (!tests.length) throw new Error("No test files were found.");

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
