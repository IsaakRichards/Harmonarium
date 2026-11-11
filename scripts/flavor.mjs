// Switch the Tauri project to one of the two apps this repo builds, before `tauri … init/build`:
//   node scripts/flavor.mjs solo          → Scriptorium (src-tauri/tauri.solo.conf.json merged in,
//                                            app-icon-solo.png as the icon source)
//   node scripts/flavor.mjs harmonarium   → leaves Harmonarium's config as it is
// CI runs this on a fresh checkout, so the change is never committed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flavor = process.argv[2] || "harmonarium";
if (!["solo", "harmonarium"].includes(flavor)) {
  console.error(`flavor: unknown flavor "${flavor}" (use solo or harmonarium)`);
  process.exit(1);
}
if (flavor === "harmonarium") { console.log("flavor: Harmonarium (unchanged)"); process.exit(0); }

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

const confPath = path.join(root, "src-tauri/tauri.conf.json");
const base = JSON.parse(fs.readFileSync(confPath, "utf8"));
const solo = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.solo.conf.json"), "utf8"));
fs.writeFileSync(confPath, JSON.stringify(merge(base, solo), null, 2) + "\n");

// The icon source the workflows feed to `tauri icon`.
fs.copyFileSync(path.join(root, "app-icon-solo.png"), path.join(root, "app-icon.png"));
console.log(`flavor: Scriptorium (${solo.identifier})`);
