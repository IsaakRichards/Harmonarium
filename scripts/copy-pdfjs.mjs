// Copy pdf.js's worker and data files (CMaps, standard fonts, decoders) from node_modules into
// public/vendor/pdfjs/, where the reading engine (src/foliate/pdf.js) loads them at run time.
// Runs before every dev server and build (see package.json); the copies are git-ignored.
import { cp, mkdir, access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const from = path.join(root, "node_modules", "pdfjs-dist");
const to = path.join(root, "public", "vendor", "pdfjs");
await mkdir(to, { recursive: true });

const items = [
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["cmaps", "cmaps"],
  ["standard_fonts", "standard_fonts"],
  ["wasm", "wasm"],
];
for (const [src, dest] of items) {
  const s = path.join(from, src);
  try { await access(s); } catch { if (dest !== "wasm") console.warn(`copy-pdfjs: ${src} is missing`); continue; }
  await cp(s, path.join(to, dest), { recursive: true });
}
console.log("copy-pdfjs: pdf.js files are in public/vendor/pdfjs");
