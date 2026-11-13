// Does any line of text run past the bottom of the visible page? Opens a long book in the
// ReadEra-style reader at many screen sizes, pixel densities and text sizes, turns pages, and
// reports every line whose bottom is below the visible page. Exits non-zero if any is found.
//   npm run build && node tests/e2e/clip.mjs
//   INSET=1  first shrink the page's frame without a window resize event, as a phone's safe-area
//            margins do when Android's bars hide (what used to cut off the bottom line)
//   EARLY=1  change the frame's size again and again while the book is still opening, as Android
//            does when it hides its bars just as a book comes up (what cut off the first page)
//   DPRS=1,2.625  FONTS=100,140  pick pixel densities and text sizes

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const DIST = path.resolve("dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".ttf": "font/ttf", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  try { const d = await readFile(path.join(DIST, path.normalize(p))); res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(d); }
  catch { res.writeHead(404); res.end(); }
}).listen(4174);

async function longEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("OEBPS/style.css", `p { margin: 0; text-indent: 1.4em; line-height: 1.35; } p.gap { margin-top: 0.9em; } h1 { font-size: 1.6em; margin: 1.2em 0 0.8em; }`);
  const words = "the keeper of the long field walked out at dusk with a lantern swinging low and counted the herons standing in the reeds as the water rose".split(" ");
  const para = (i, n) => Array.from({ length: n }, (_, k) => words[(i * 11 + k) % words.length]).join(" ");
  const chapters = [1, 2, 3];
  for (const c of chapters) {
    const body = Array.from({ length: 40 }, (_, i) => `<p${i % 7 === 0 ? ' class="gap"' : ""}>${para(c * 50 + i, 25 + ((i * 13) % 60))}.</p>`).join("\n");
    zip.file(`OEBPS/ch${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${c}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>Chapter ${c}</h1>${body}</body></html>`);
  }
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((c) => `<li><a href="ch${c}.xhtml">Chapter ${c}</a></li>`).join("")}</ol></nav></body></html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">clip-test</dc:identifier><dc:title>Clip Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${chapters.map((c) => `<item id="c${c}" href="ch${c}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((c) => `<itemref idref="c${c}"/>`).join("")}</spine></package>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

/** Lines (text fragments) inside the visible page whose bottom runs below it. */
function measure() {
  const v = document.getElementById("viewer").getBoundingClientRect();
  const visBottom = Math.min(v.bottom, innerHeight), visLeft = Math.max(v.left, 0), visRight = Math.min(v.right, innerWidth);
  const out = { clipped: [], visBottom: +visBottom.toFixed(2) };
  for (const f of document.querySelectorAll("#viewer iframe")) {
    const fr = f.getBoundingClientRect(), doc = f.contentDocument;
    if (!doc?.body) continue;
    out.frame = { top: +fr.top.toFixed(2), h: +fr.height.toFixed(2), bodyH: +doc.body.getBoundingClientRect().height.toFixed(2), pad: getComputedStyle(doc.body).paddingBottom, inner: doc.defaultView.innerHeight };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.textContent.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const L = fr.left + r.left, R = fr.left + r.right;
        if (R <= visLeft + 1 || L >= visRight - 1 || r.width < 1) continue;
        const B = fr.top + r.bottom;
        if (B > visBottom + 0.5) out.clipped.push({ top: +(fr.top + r.top).toFixed(1), bottom: +B.toFixed(1) });
      }
    }
  }
  return out;
}

const book = await longEpub();
const browser = await chromium.launch();
const SIZES = process.env.INSET || process.env.EARLY ? [[412, 860], [393, 851], [360, 740]] : [[412, 860], [393, 851], [360, 740], [412, 915], [384, 789]];
const DPRS = (process.env.DPRS || "1,2.625").split(",").map(Number);
const FONTS = (process.env.FONTS || "100,120,140,170").split(",").map(Number);
let bad = 0, total = 0;
for (const dpr of DPRS) for (const [w, h] of SIZES) for (const fs of FONTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("http://127.0.0.1:4174/");
  await page.evaluate((size) => new Promise((res) => {
    const r = indexedDB.open("harmonarium");
    r.onsuccess = () => {
      const t = r.result.transaction("kv", "readwrite"), st = t.objectStore("kv"), g = st.get("settings");
      g.onsuccess = () => st.put({ ...(g.result || {}), fontSize: size }, "settings");
      t.oncomplete = () => { r.result.close(); res(); };
    };
  }), fs);
  await page.reload();
  await page.setInputFiles("#file-input", { name: "clip.epub", mimeType: "application/epub+zip", buffer: book });
  await page.waitForSelector(".lib-card", { timeout: 15000 });
  if (process.env.EARLY) {
    // Frame changes with no window resize event (safe-area margins) at moments spread through the
    // opening, ending on the full screen the book is read at.
    await page.evaluate(() => {
      const steps = [[30, 24, 48], [140, 0, 0], [260, 24, 31], [420, 0, 48], [600, 24, 0], [850, 0, 0]];
      for (const [t, top, bottom] of steps) setTimeout(() => { const v = document.getElementById("viewer"); v.style.top = `${top}px`; v.style.bottom = `${bottom}px`; }, t);
    });
  }
  await page.click(".lib-open");
  if (process.env.EARLY) {
    // ...and the window itself growing as the bars go, in steps, while the pages are laid out.
    for (const [t, dh] of [[80, -56], [200, -24], [330, -40], [520, 0]]) { await page.waitForTimeout(t > 80 ? 110 : 80); await page.setViewportSize({ width: w, height: h + dh }); }
  }
  await page.waitForSelector("#viewer iframe", { timeout: 15000, state: "attached" });
  await page.waitForTimeout(2200);
  if (process.env.INSET) {
    // As on a phone whose safe-area margins change when Android's bars hide: the page's frame
    // changes size, but no window resize event is fired.
    await page.evaluate(() => { const v = document.getElementById("viewer"); v.style.top = "24px"; v.style.bottom = "31px"; });
    await page.waitForTimeout(1500);
  }
  let worst = null, pagesBad = 0;
  for (let i = 0; i < 8; i++) {
    const m = await page.evaluate(measure);
    total++;
    if (!m.frame || m.frame.h < 50) m.clipped.push({ blank: true, frame: m.frame || null });
    if (m.clipped.length) { pagesBad++; bad++; worst = worst || { page: i + 1, ...m, clipped: m.clipped.slice(0, 3) }; }
    await page.click("#tap-next", { force: true });
    await page.waitForTimeout(420);
  }
  console.log(`${pagesBad ? "CLIP" : "ok  "}  dpr ${dpr}  ${w}x${h}  text ${fs}%  ${pagesBad}/8 pages${worst ? "  " + JSON.stringify(worst) : ""}`);
  await ctx.close();
}
console.log(`${bad} of ${total} pages had a line cut off at the bottom`);
await browser.close();
server.close();
process.exit(bad ? 1 : 0);
