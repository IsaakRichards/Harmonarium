// Stamps one version into every place a build reads it from:
//   node scripts/set-version.mjs v0.3.0     (a leading "v" is fine)
// The release workflow runs this with the tag, so the Android APK's versionName matches the
// release and the in-app updater can tell whether it is up to date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = String(process.argv[2] || "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`set-version: "${process.argv[2] || ""}" is not a version like 0.3.0 or v0.3.0`);
  process.exit(1);
}

function edit(file, fn) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return;
  const before = fs.readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before && !before.includes(version)) throw new Error(`no version found in ${file}`);
  fs.writeFileSync(p, after);
  console.log(`set-version: ${file} → ${version}`);
}

const jsonVersion = (s) => s.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
edit("package.json", jsonVersion);
edit("src-tauri/tauri.conf.json", jsonVersion);
edit("src-tauri/Cargo.toml", (s) => s.replace(/^(version\s*=\s*")[^"]*(")/m, `$1${version}$2`));
edit("sailfish/rpm/harbour-starborn.spec", (s) => s.replace(/^(Version:\s*).*$/m, `$1${version}`));
