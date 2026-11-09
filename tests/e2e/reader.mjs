// End-to-end check of the reader with the real epub.js, in headless Chromium.
//   npm run test:reader      (builds, then runs this)
// Measures page turns frame by frame to prove they animate, and saves screenshots to
// test-results/. Exits non-zero if any check fails.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const DIST = path.resolve("dist");
const OUT = path.resolve("test-results");
await mkdir(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ---------------------------------------------------------------- static server for dist/
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  try {
    const data = await readFile(path.join(DIST, path.normalize(p)));
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(4173, "127.0.0.1", r));

// ---------------------------------------------------------------- a test EPUB, four chapters
async function makeEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const words = "the night came down over the dunes like a slow tide far out past the shield wall sand sang to itself in a low voice that only the old ones claimed to understand".split(" ");
  const para = (i) => Array.from({ length: 70 }, (_, k) => words[(i * 7 + k) % words.length]).join(" ");
  const chapters = [1, 2, 3, 4];
  for (const n of chapters) {
    const body = Array.from({ length: 30 }, (_, i) => `<p>${n}.${i + 1} ${para(n * 31 + i)}.</p>`).join("\n");
    zip.file(`OEBPS/ch${n}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body><h1>Chapter ${n}</h1>${body}</body></html>`);
  }
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((n) => `<li><a href="ch${n}.xhtml">Chapter ${n}</a></li>`).join("")}</ol></nav></body></html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">harmonarium-test</dc:identifier><dc:title>The Test of Pages</dc:title><dc:creator>Harmonarium</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((n) => `<item id="c${n}" href="ch${n}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((n) => `<itemref idref="c${n}"/>`).join("")}</spine></package>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// Known noise: the web fonts this test blocks, and Chrome's notice about epub.js's unload listener.
const BENIGN = [/Failed to load resource: net::ERR_FAILED/, /Permissions policy violation: unload/];
page.on("console", (m) => { if (m.type() === "error" && !BENIGN.some((re) => re.test(m.text()))) errors.push("console: " + m.text()); });
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

await page.goto("http://127.0.0.1:4173/");
await page.setInputFiles("#file-input", { name: "test-of-pages.epub", mimeType: "application/epub+zip", buffer: await makeEpub() });
await page.waitForSelector(".lib-card", { timeout: 15000 });
check("EPUB imports onto the shelf", true, await page.innerText(".lib-title"));
await page.click(".lib-open");
await page.waitForSelector("#viewer iframe", { timeout: 15000 });
await page.waitForTimeout(1500);
await page.evaluate(() => document.activeElement && document.activeElement.blur());

const container = () => page.evaluate(() => { const c = document.querySelector("#viewer .epub-container"); return c ? { left: c.scrollLeft, width: c.offsetWidth, scrollWidth: c.scrollWidth } : null; });

/** Record the container's scrollLeft on every frame while `action` runs. */
async function sampleWhile(action, ms = 700) {
  await page.evaluate(() => {
    window.__s = []; window.__run = true;
    const c = () => document.querySelector("#viewer .epub-container");
    const tick = () => { if (!window.__run) return; const el = c(); window.__s.push({ t: performance.now(), left: el ? el.scrollLeft : null, op: getComputedStyle(document.getElementById("viewer")).opacity }); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await action();
  await page.waitForTimeout(ms);
  return page.evaluate(() => { window.__run = false; return window.__s; });
}
const distinct = (s) => new Set(s.map((x) => x.left)).size;
const percent = () => page.innerText("#foot-percent");
const cfi = () => page.getAttribute("#viewer", "data-cfi");
const chapter = () => page.innerText("#foot-chapter");

// ---------------------------------------------------------------- slide (default)
const c0 = await container();
check("Slide mode uses a scrolling page strip", c0 && c0.scrollWidth > c0.width, JSON.stringify(c0));
const p0 = await cfi();
let shotTaken = false;
const s1 = await sampleWhile(async () => {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(110);
  await page.screenshot({ path: `${OUT}/slide-mid.png` }); shotTaken = true;
});
const c1 = await container();
check("ArrowRight slides through several in-between frames", distinct(s1) >= 6, `${distinct(s1)} distinct positions`);
check("…and lands exactly one page on", c1.left - c0.left === c0.width, `${c0.left} → ${c1.left} (page ${c0.width})`);
await page.waitForTimeout(200);
check("The reading position updates after the slide", (await cfi()) && (await cfi()) !== p0, `${p0} → ${await cfi()}`);
await page.screenshot({ path: `${OUT}/slide-after.png` });

const sb = await sampleWhile(() => page.keyboard.press("ArrowLeft"));
const cb = await container();
check("ArrowLeft slides back", distinct(sb) >= 6 && cb.left === c0.left, `${distinct(sb)} frames, back at ${cb.left}`);

const before3 = (await container()).left;
await sampleWhile(async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(60); } }, 900);
const after3 = (await container()).left;
check("Three quick presses chain into three pages", after3 - before3 === 3 * c0.width, `${before3} → ${after3}`);

// cross into the next chapter
const ch0 = await chapter();
let crossed = false, crossFrames = 0;
for (let i = 0; i < 40 && !crossed; i++) {
  const s = await sampleWhile(() => page.keyboard.press("ArrowRight"), 450);
  if ((await chapter()) !== ch0) { crossed = true; crossFrames = distinct(s); }
}
check("Slides across a chapter break", crossed, `${ch0} → ${await chapter()}`);
check("…smoothly (animated, not a jump)", crossFrames >= 4, `${crossFrames} distinct positions on the crossing turn`);
await page.screenshot({ path: `${OUT}/after-chapter.png` });

// ---------------------------------------------------------------- finger drag
const cdp = await context.newCDPSession(page);
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
async function drag(fromX, toX, steps = 12, stepMs = 16) {
  const y = 430;
  await touch("touchStart", fromX, y);
  for (let i = 1; i <= steps; i++) { await touch("touchMove", fromX + ((toX - fromX) * i) / steps, y); await page.waitForTimeout(stepMs); }
}
const d0 = (await container()).left;
await drag(300, 160, 14, 30);           // slow drag 140px left (about a third of a page)
const mid = (await container()).left;
check("During a drag the page follows the finger", Math.abs((mid - d0) - 140) <= 6, `moved ${mid - d0}px for a 140px drag`);
await page.screenshot({ path: `${OUT}/drag-mid.png` });
await touch("touchEnd", 160, 430);
await page.waitForTimeout(600);
const d1 = (await container()).left;
check("Releasing past a third of the page completes the turn", d1 - d0 === c0.width, `${d0} → ${d1}`);

await drag(250, 210, 6, 40);            // short slow drag: should spring back
await touch("touchEnd", 210, 430);
await page.waitForTimeout(600);
const d2 = (await container()).left;
check("A short drag springs back", d2 === d1, `${d1} → ${d2}`);

await drag(300, 240, 4, 8);             // quick flick, 60px
await touch("touchEnd", 240, 430);
await page.waitForTimeout(600);
const d3 = (await container()).left;
check("A quick flick turns the page", d3 - d2 === c0.width, `${d2} → ${d3}`);

// ---------------------------------------------------------------- fade and none
async function setMode(mode) {
  await page.evaluate(() => document.body.classList.remove("immersive"));
  await page.click("#btn-aa");
  await page.selectOption("#page-turn", mode);
  await page.waitForTimeout(1200);
  await page.click("#btn-aa");
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
}
await setMode("fade");
const pf = await cfi();
const sf = await sampleWhile(() => page.keyboard.press("ArrowRight"), 600);
const opacities = sf.map((x) => Number(x.op));
check("Fade mode dips the page out and back", Math.min(...opacities) < 0.5 && opacities[opacities.length - 1] === 1, `min opacity ${Math.min(...opacities).toFixed(2)}`);
check("…and still turns the page", (await cfi()) !== pf, `${pf} → ${await cfi()}`);

await setMode("none");
const n0 = await container();
const sn = await sampleWhile(() => page.keyboard.press("ArrowRight"), 400);
const n1 = await container();
check("None mode turns instantly", distinct(sn) <= 3 && n1.left > n0.left, `${distinct(sn)} distinct positions, ${n0.left} → ${n1.left}`);

await setMode("slide");
const r0 = await container();
const sr = await sampleWhile(() => page.keyboard.press("ArrowRight"));
check("Switching back to Slide keeps the place and slides again", distinct(sr) >= 6, `${distinct(sr)} frames from ${r0.left}`);

check("No page errors", errors.length === 0, errors.slice(0, 5).join(" | "));

await writeFile(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 2));
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
