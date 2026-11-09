// Writes latest.json, the file the desktop in-app updater reads, from a folder of release files:
//   node scripts/latest-json.mjs <release-dir> <tag>
// It lists each platform whose update file came with a .sig (made only when the
// TAURI_SIGNING_PRIVATE_KEY secret is set). With no signatures it writes nothing, and the
// desktop app falls back to offering the releases page.
import fs from "node:fs";
import path from "node:path";

const [dir, tag] = process.argv.slice(2);
if (!dir || !tag) {
  console.error("usage: node scripts/latest-json.mjs <release-dir> <tag>");
  process.exit(1);
}
const base = `https://github.com/IsaakRichards/Starborn/releases/download/${tag}/`;
const files = fs.readdirSync(dir);

function entry(test) {
  const file = files.find((f) => test(f) && files.includes(f + ".sig"));
  if (!file) return null;
  return {
    signature: fs.readFileSync(path.join(dir, file + ".sig"), "utf8").trim(),
    url: base + encodeURIComponent(file),
  };
}

const appimage = entry((f) => f.endsWith(".AppImage"));
const nsis = entry((f) => f.endsWith("-setup.exe"));
const msi = entry((f) => f.endsWith(".msi"));

const platforms = {};
if (appimage) Object.assign(platforms, { "linux-x86_64": appimage, "linux-x86_64-appimage": appimage });
if (nsis) Object.assign(platforms, { "windows-x86_64": nsis, "windows-x86_64-nsis": nsis });
if (msi) Object.assign(platforms, { "windows-x86_64-msi": msi });
if (!nsis && msi) platforms["windows-x86_64"] = msi;

if (!Object.keys(platforms).length) {
  console.log("latest-json: no signed update files, so no latest.json");
  process.exit(0);
}
const out = {
  version: tag.replace(/^v/, ""),
  notes: `Starborn ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`latest-json: wrote latest.json for ${Object.keys(platforms).join(", ")}`);
