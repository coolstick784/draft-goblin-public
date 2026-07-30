import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const json = relative => JSON.parse(read(relative));
const manifest = json("extension/manifest.json");
const pkg = json("package.json");
const failures = [];
const checks = [];
const check = (condition, message) => {
  (condition ? checks : failures).push(message);
};

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

function pngDimensions(relative) {
  const bytes = fs.readFileSync(path.join(root, relative));
  check(bytes.subarray(1, 4).toString("ascii") === "PNG", `${relative} is a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

check(manifest.manifest_version === 3, "manifest uses Manifest V3");
check(/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version), "manifest has a valid store version");
check(pkg.name === "draft-goblin", "package name matches the product");
check(pkg.version === manifest.version, "package and extension versions match");
check(String(manifest.description || "").length <= 132, "manifest description fits the store limit");
check(Number(manifest.minimum_chrome_version) >= 116, "minimum Chrome version supports sidePanel.open");
check(!manifest.update_url, "manifest does not bypass Chrome Web Store updates");

const expectedPermissions = ["activeTab", "alarms", "offscreen", "scripting", "sidePanel", "storage"];
check(
  JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(expectedPermissions.sort()),
  "permissions match the reviewed least-privilege set",
);
check(!manifest.permissions.includes("cookies"), "extension does not request cookie access");
check(!manifest.permissions.includes("tabs"), "extension does not request browsing-history access");
check(
  manifest.host_permissions.every(value =>
    /^https:\/\/(?:api\.sleeper\.app|(?:www\.)?sleeper\.(?:app|com)|fantasy\.espn\.com|lm-api-reads\.fantasy\.espn\.com|coolstick784\.github\.io)\/\*$/.test(value)
      || value === "https://api.sleeper.com/projections/nfl/*",
  ),
  "host permissions are restricted to supported draft and projection hosts",
);

for (const size of [16, 32, 48, 128]) {
  const relative = `extension/${manifest.icons?.[size] || ""}`;
  check(fs.existsSync(path.join(root, relative)), `${size}px manifest icon exists`);
  if (fs.existsSync(path.join(root, relative))) {
    const dimensions = pngDimensions(relative);
    check(dimensions[0] === size && dimensions[1] === size, `${size}px manifest icon has exact dimensions`);
  }
}

const extensionFiles = filesBelow(extensionRoot);
const forbiddenSuffixes = [".pem", ".key", ".p12", ".env", ".map"];
check(
  !extensionFiles.some(file => forbiddenSuffixes.some(suffix => file.toLowerCase().endsWith(suffix))),
  "package contains no keys, environment files, or source maps",
);
const js = extensionFiles.filter(file => file.endsWith(".js")).map(file => fs.readFileSync(file, "utf8")).join("\n");
check(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(js), "extension contains no string-to-code execution");
check(!/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']https?:\/\//.test(js), "extension imports no remote code");
for (const htmlFile of extensionFiles.filter(file => file.endsWith(".html"))) {
  const html = fs.readFileSync(htmlFile, "utf8");
  const label = path.relative(root, htmlFile).replaceAll("\\", "/");
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${label} contains no inline script`);
  check(!/<script[^>]+\bsrc=["']https?:\/\//i.test(html), `${label} loads no remote script`);
}

const privacy = read("PRIVACY.md");
for (const phrase of [
  "Website content",
  "local installation identifier",
  "does not sell",
  "personalized advertising",
  "human review",
  "Chrome Web Store User Data Policy",
  "retention",
]) check(privacy.toLowerCase().includes(phrase.toLowerCase()), `privacy notice covers ${phrase}`);

const listing = read("STORE_LISTING.md");
for (const permission of manifest.permissions) {
  check(listing.includes(`\`${permission}\``), `store listing explains ${permission}`);
}
for (const host of ["ESPN", "Sleeper", "coolstick784.github.io"]) {
  check(listing.includes(host), `store listing explains ${host} access`);
}

const requiredStoreAssets = [
  ["store-assets/screenshot-01.png", 1280, 800],
  ["store-assets/small-promo-tile.png", 440, 280],
];
for (const [relative, width, height] of requiredStoreAssets) {
  check(fs.existsSync(path.join(root, relative)), `${relative} exists`);
  if (fs.existsSync(path.join(root, relative))) {
    const dimensions = pngDimensions(relative);
    check(dimensions[0] === width && dimensions[1] === height, `${relative} has exact dimensions`);
  }
}

if (failures.length) {
  console.error(`Extension release audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Extension release audit passed (${checks.length} checks).`);
}
