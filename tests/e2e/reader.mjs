// End-to-end check of the reader with the real epub.js, in headless Chromium.
//   npm run test:reader      (builds, then runs this)
// Measures page turns frame by frame to prove they animate, and saves screenshots to
// test-results/. Exits non-zero if any check fails.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { createHash } from "node:crypto";

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
const epubBuf = await makeEpub();
await page.setInputFiles("#file-input", { name: "test-of-pages.epub", mimeType: "application/epub+zip", buffer: epubBuf });
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
  await page.click("#re-aa");
  await page.selectOption("#page-turn", mode);
  await page.waitForTimeout(1200);
  await page.click("#re-aa");
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

// ---------------------------------------------------------------- bookmarks, quotes, search (ReadEra's free tools)
await page.waitForTimeout(500);
await page.evaluate(() => document.body.classList.remove("immersive"));
await page.click("#re-bm");
await page.waitForTimeout(400);
check("The bookmark button bookmarks the page", await page.evaluate(() => document.getElementById("btn-bm").classList.contains("on")));
check("…and a ribbon marks it", await page.isVisible("#bm-ribbon"));
check("ReadEra-style top bar shows the chapter and its pages", /page \d+\/\d+/.test(await page.innerText("#re-where")), await page.innerText("#re-where"));
check("…and the bottom bar the pages of the book", /\d+ of \d+|%/.test(await page.innerText("#re-pages")), await page.innerText("#re-pages"));
await page.evaluate(() => document.body.classList.add("immersive"));
await page.waitForTimeout(400);
check("Hidden bars leave nothing over the page", !(await page.isVisible("#reader-bar")) && !(await page.isVisible("#reader-foot")) && !(await page.isVisible("#re-light")));
await page.evaluate(() => document.body.classList.remove("immersive"));
await page.waitForTimeout(300);

// Select a few words in the page: the selection bar appears, and Quote highlights them.
const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() !== "about:blank") || page.frames()[1];
await frame.evaluate(() => {
  const p = [...document.querySelectorAll("p")].find((el) => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().left < innerWidth && el.textContent.length > 40);
  const t = p.firstChild;
  const r = document.createRange();
  r.setStart(t, 4); r.setEnd(t, 30);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
});
await page.waitForSelector("#sel-bar:not([hidden])", { timeout: 5000 }).catch(() => {});
check("Selecting text shows the Copy / Quote / Note / Find bar", await page.isVisible("#sel-bar"));
if (await page.isVisible("#sel-bar")) {
  await page.click('#sel-bar [data-sel="quote"]');
  await page.waitForTimeout(600);
}
check("Quote draws a highlight in the book", (await page.$$("#viewer svg .hm-hl, #viewer g.hm-hl, #viewer .hm-hl")).length > 0);
await page.click("#re-toc");
await page.click('[data-nav="quotes"]');
check("The quote is listed under Contents → Quotes", (await page.$$("#q-list .mark-row")).length === 1);
await page.click('[data-nav="bookmarks"]');
check("…and the bookmark under Bookmarks", (await page.$$("#bm-list .mark-row")).length === 1);
await page.click('[data-dismiss="toc-drawer"]');
await page.screenshot({ path: `${OUT}/quote.png` });

await page.click("#btn-find");
await page.fill("#find-q", "shield wall");
await page.press("#find-q", "Enter");
await page.waitForFunction(() => /found|Nothing/.test(document.getElementById("find-status").textContent), null, { timeout: 20000 });
const hits = (await page.$$("#find-results .find-hit")).length;
check("Find in book searches every chapter", hits > 4, `${hits} hits · ${await page.innerText("#find-status")}`);
await page.screenshot({ path: `${OUT}/find.png` });
const before = await cfi();
await page.click("#find-results .find-hit:last-child");
await page.waitForTimeout(1200);
check("A result jumps there", (await cfi()) !== before, `${before} → ${await cfi()}`);
check("…leaving a Back chip", await page.isVisible("#jump-back"));
await page.click("#jump-back button:first-child");
await page.waitForTimeout(1200);
check("Back returns to the page before the jump", (await page.evaluate(() => document.getElementById("btn-bm").classList.contains("on"))), await cfi());

// Scroll mode: one long scroll instead of pages.
await page.evaluate(() => document.body.classList.remove("immersive"));
await page.click("#re-aa");
await page.selectOption("#flow", "scrolled");
await page.waitForTimeout(1500);
await page.click("#re-aa");
const sc = await page.evaluate(() => { const c = document.querySelector("#viewer .epub-container"); return c ? { h: c.scrollHeight, ch: c.clientHeight } : null; });
check("Scroll mode lays the book out as one long scroll", sc && sc.h > sc.ch * 1.5, JSON.stringify(sc));
await page.screenshot({ path: `${OUT}/scroll.png` });
await page.click("#re-aa");
await page.selectOption("#flow", "paginated");
await page.waitForTimeout(1200);
await page.click("#re-aa");

// Every turn is counted, and leaving + coming back lands on the very same page.
await page.evaluate(() => document.body.classList.remove("immersive"));
const whereNow = () => page.textContent("#re-where"); // works while the bars are hidden
let missed = 0; // reused below
for (let i = 0; i < 8; i++) {
  const before = await whereNow();
  await page.click("#tap-next", { force: true });
  await page.waitForTimeout(450);
  if ((await whereNow()) === before) missed++;
}
check("Each page turn moves the page counter", missed === 0, `${missed} of 8 turns not counted · now ${await whereNow()}`);
const leftAt = await cfi(), leftWhere = await whereNow();
await page.click("#btn-back");
await page.waitForTimeout(800);
await page.click(".lib-open");
await page.waitForTimeout(2500);
check("Reopening lands on the same page", (await cfi()) === leftAt && (await whereNow()) === leftWhere, `left ${leftWhere} (${leftAt}) · back at ${await whereNow()} (${await cfi()})`);
await page.evaluate(() => document.body.classList.remove("immersive"));

// ---- Phone conditions -------------------------------------------------------------------
const showBars = () => page.evaluate(() => document.body.classList.remove("immersive"));
async function reopen() {
  await showBars();
  await page.click("#btn-back");
  await page.waitForTimeout(800);
  await page.click(".lib-open");
  await page.waitForTimeout(2500);
}

// A screen that isn't a whole number of pixels wide (most Android phones): pages are fractional.
await page.evaluate(() => { const v = document.getElementById("viewer"); v.style.right = "auto"; v.style.width = "392.73px"; window.dispatchEvent(new Event("resize")); });
await page.waitForTimeout(1500);
// Start a quarter of the way in, so eight turns don't run off the end of the test book.
await page.evaluate(() => { const sl = document.getElementById("progress-slider"); sl.disabled = false; sl.value = "250"; sl.dispatchEvent(new Event("change")); });
await page.waitForTimeout(1500);
missed = 0;
for (let i = 0; i < 8; i++) {
  const before = await whereNow();
  await page.click("#tap-next", { force: true });
  await page.waitForTimeout(450);
  if ((await whereNow()) === before) missed++;
}
check("On a fractional-width screen each turn moves the counter", missed === 0, `${missed} of 8 not counted · now ${await whereNow()}`);
await page.click("#jump-back [data-dismiss-back]").catch(() => {});
let at = await cfi(), atWhere = await whereNow();
await reopen();
check("…and reopening lands on the same page", (await cfi()) === at && (await whereNow()) === atWhere, `left ${atWhere} · back at ${await whereNow()}`);

// Android's back gesture: a swipe from the left edge starts dragging the page, then the system
// takes the touch away (touchcancel) and closes the book.
for (let i = 0; i < 3; i++) { await page.click("#tap-next", { force: true }); await page.waitForTimeout(450); }
at = await cfi(); atWhere = await whereNow();
await page.evaluate(async () => {
  const el = document.getElementById("tap-prev");
  const mk = (x) => new Touch({ identifier: 7, target: el, clientX: x, clientY: 400, screenX: x, screenY: 400, pageX: x, pageY: 400 });
  const fire = (type, x) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchcancel" ? [] : [mk(x)], changedTouches: [mk(x)] }));
  fire("touchstart", 4);
  for (const x of [20, 45, 80, 120]) { fire("touchmove", x); await new Promise((r) => setTimeout(r, 16)); }
  fire("touchcancel", 120);
});
await page.waitForTimeout(200);
await reopen();
check("A back swipe from the edge doesn't lose a page", (await cfi()) === at && (await whereNow()) === atWhere, `left ${atWhere} · back at ${await whereNow()}`);

// The status bar hiding and showing (the screen grows and shrinks) re-flows the pages.
await page.evaluate(() => { const v = document.getElementById("viewer"); v.style.right = ""; v.style.width = ""; window.dispatchEvent(new Event("resize")); });
await page.waitForTimeout(1200);
for (let i = 0; i < 2; i++) { await page.click("#tap-next", { force: true }); await page.waitForTimeout(450); }
at = await cfi(); atWhere = await whereNow();
for (const h of [900, 860, 900, 860]) { await page.setViewportSize({ width: 412, height: h }); await page.waitForTimeout(700); }
await reopen();
check("Screen re-sizes don't drift the saved place", (await cfi()) === at, `left ${atWhere} (${at}) · back at ${await whereNow()} (${await cfi()})`);
await showBars();

// Text size: bigger letters re-flow the chapter (more pages), but the place you were reading
// stays on screen and stays the saved place; going back to the old size shows the same page.
for (let i = 0; i < 2; i++) { await page.click("#tap-next", { force: true }); await page.waitForTimeout(450); }
// Step back from any chapter's first page, so the place is mid-chapter.
await page.click("#tap-prev", { force: true }); await page.waitForTimeout(450);
at = await cfi(); atWhere = await whereNow();
await showBars();
await page.click("#re-aa");
await page.click("#font-inc"); await page.waitForTimeout(900);
await page.click("#font-inc"); await page.waitForTimeout(900);
const bigWhere = await whereNow(), bigCfi = await cfi();
await page.click("#font-dec"); await page.waitForTimeout(900);
await page.click("#font-dec"); await page.waitForTimeout(900);
await page.click("#re-aa");
check("Bigger text keeps your place as the saved place", bigCfi === at, `${atWhere} → ${bigWhere} (${bigCfi})`);
check("…and the old size shows the same page again", (await whereNow()) === atWhere && (await cfi()) === at, `${atWhere} → ${await whereNow()}`);
await reopen();
check("…and reopening after a size change lands on it", (await cfi()) === at && (await whereNow()) === atWhere, `${atWhere} → ${await whereNow()}`);
await showBars();

// Library sections: the EPUB is under Books, and Favorites starts empty.
await page.evaluate(() => document.body.classList.remove("immersive"));
await page.click("#btn-back");
await page.waitForTimeout(600);
check("The EPUB sits in Books", (await page.$$(".lib-card")).length === 1 && (await page.innerText(".lib-fmt")).startsWith("EPUB"));
await page.selectOption("#lib-section", "favorites");
await page.waitForTimeout(400);
check("Favorites starts empty", (await page.$$(".lib-card")).length === 0);
await page.selectOption("#lib-section", "books");

// ---- Import from ReadEra: a backup's place goes to a book with none here -------------------
if (await page.isVisible("#view-reader")) { await showBars(); await page.click("#btn-back"); await page.waitForTimeout(600); }
const bookId = await page.getAttribute(".lib-card", "data-id");
// Forget this book's place (and page index) here, as if it had never been opened.
await page.evaluate((id) => new Promise((res, rej) => {
  const r = indexedDB.open("harmonarium");
  r.onerror = rej;
  r.onsuccess = () => {
    const t = r.result.transaction(["progress", "locations"], "readwrite");
    t.objectStore("progress").delete(id);
    t.objectStore("locations").delete(id);
    t.oncomplete = () => { r.result.close(); res(); };
    t.onerror = rej;
  };
}), bookId);
// Laid out as ReadEra 26 writes it: meta.json and others beside docs_1.json, a plain list.
const backup = new JSZip();
backup.file("meta.json", JSON.stringify({ date: Date.now(), type: 1, database: 111, appname: "ReadEra" }));
backup.file("prefs.xml", "<map></map>");
const sha = createHash("sha1").update(epubBuf).digest("hex");
backup.file("docs_1.json", JSON.stringify([
  { uri: `sha-1:${sha}`, data: { doc_sha1: sha, doc_format: "EPUB", doc_position: JSON.stringify({ ratio: 0.5, page: 14, pagesCount: 29, version: 2 }), doc_last_read_time: Date.now() - 60000 }, aliases: [], bookmarks: [], citations: [] },
  { uri: "sha-1:x", data: { doc_sha1: "ab".repeat(20), doc_format: "EPUB", doc_position: JSON.stringify({ ratio: -1, page: 0, pagesCount: 0 }) }, aliases: [], bookmarks: [], citations: [] },
]));
await page.click("#open-settings");
await page.setInputFiles("#s-readera-import", { name: "ReadEra.bak", mimeType: "application/octet-stream", buffer: await backup.generateAsync({ type: "nodebuffer" }) });
await page.waitForFunction(() => /place|Couldn't|No books/.test(document.getElementById("s-readera-import-status").textContent), null, { timeout: 15000 });
const importStatus = await page.textContent("#s-readera-import-status");
check("A ReadEra backup imports the place of a book with none here", /1 book has its place from ReadEra/.test(importStatus), importStatus);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("…and its card shows ReadEra's progress", (await page.innerText(".lib-sub")).includes("50%"), await page.innerText(".lib-sub"));
await page.click(".lib-open");
await page.waitForSelector("#viewer iframe", { timeout: 15000 });
await page.waitForTimeout(5000);
const [nowP, ofP] = ((await page.textContent("#re-pages")).match(/(\d+) of (\d+)/) || []).slice(1).map(Number);
check("…and the book opens halfway through", ofP > 0 && Math.abs(nowP / ofP - 0.5) < 0.08, `${nowP} of ${ofP} · ${await cfi()}`);

// ---- Fonts: Comfortaa, and ReadEra's "Embedded" ---------------------------------------------
// A second little book whose headings use a font built into it ("BookFace"); its paragraphs name
// an ordinary font (Georgia), which the chosen font should replace.
async function makeFontEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("OEBPS/face.ttf", await readFile(path.resolve("public/fonts/Comfortaa.ttf")));
  zip.file("OEBPS/style.css", `@font-face { font-family: "BookFace"; src: url(face.ttf); } h1 { font-family: "BookFace", serif; } p { font-family: Georgia, serif; }`);
  const body = Array.from({ length: 12 }, (_, i) => `<p>Line ${i + 1} of a short chapter about fonts and the pages they sit on.</p>`).join("");
  zip.file("OEBPS/ch1.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>Of Fonts</h1>${body}</body></html>`);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Of Fonts</a></li></ol></nav></body></html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">harmonarium-fonts</dc:identifier><dc:title>The Font Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="f" href="face.ttf" media-type="font/ttf"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}
if (await page.isVisible("#view-reader")) { await showBars(); await page.click("#btn-back"); await page.waitForTimeout(600); }
await page.setInputFiles("#file-input", { name: "font-test.epub", mimeType: "application/epub+zip", buffer: await makeFontEpub() });
await page.waitForFunction(() => [...document.querySelectorAll(".lib-title")].some((t) => t.textContent.includes("Font Test")), null, { timeout: 15000 });
await page.click('.lib-card:has-text("The Font Test") .lib-open');
await page.waitForSelector("#viewer iframe", { timeout: 15000 });
await page.waitForTimeout(1500);
const fontsNow = async () => {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const r = await f.evaluate(async () => {
      const h = document.querySelector("h1"), p = document.querySelector("p");
      if (!h || !p) return null;
      await document.fonts.ready;
      return {
        h1: getComputedStyle(h).fontFamily, p: getComputedStyle(p).fontFamily,
        bookFace: [...document.fonts].some((x) => x.family.replace(/"/g, "") === "BookFace"),
        comfortaa: (await document.fonts.load("16px Comfortaa")).length > 0,
      };
    }).catch(() => null);
    if (r) return r;
  }
  return null;
};
async function pickFont(value) { await showBars(); await page.click("#re-aa"); await page.selectOption("#font-family", value); await page.waitForTimeout(1800); await page.click("#re-aa").catch(() => {}); }
async function setEmbedded(on) { await showBars(); await page.click("#re-aa"); if ((await page.isChecked("#embedded-fonts")) !== on) await page.click("#embedded-fonts"); await page.waitForTimeout(1800); await page.click("#re-aa").catch(() => {}); }

await pickFont("'Courier New', monospace");
let f = await fontsNow();
check("Embedded on: the book's own heading font stays", f && /BookFace/.test(f.h1), JSON.stringify(f));
check("…and the chosen font replaces the font the book merely names", f && /Courier New/.test(f.p), JSON.stringify(f));
await setEmbedded(false);
f = await fontsNow();
check("Embedded off: the chosen font everywhere, the built-in font left out", f && /Courier New/.test(f.h1) && /Courier New/.test(f.p) && !f.bookFace, JSON.stringify(f));
await pickFont("Comfortaa, sans-serif");
f = await fontsNow();
check("Comfortaa is offered and loads from the app", f && /Comfortaa/.test(f.p) && f.comfortaa, JSON.stringify(f));
await setEmbedded(true);
await pickFont("");

// ---- Adding a whole folder ------------------------------------------------------------------
async function tinyEpub(title) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file("c.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`);
  zip.file("a.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><p>${title}</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}
const { mkdtemp, mkdir: mkdirp } = await import("node:fs/promises");
const os = await import("node:os");
const shelfDir = path.join(await mkdtemp(path.join(os.tmpdir(), "hm-folder-")), "My Books");
await mkdirp(path.join(shelfDir, "Series", "Deep"), { recursive: true });
await mkdirp(path.join(shelfDir, ".hidden"), { recursive: true });
await writeFile(path.join(shelfDir, "already.epub"), epubBuf);                       // on the shelf already
await writeFile(path.join(shelfDir, "Series", "Deep", "folder-one.epub"), await tinyEpub("Folder Book One"));
await writeFile(path.join(shelfDir, "Series", "folder-two.epub"), await tinyEpub("Folder Book Two"));
await writeFile(path.join(shelfDir, ".hidden", "skip.epub"), await tinyEpub("Hidden Book"));
await writeFile(path.join(shelfDir, "notes.txt"), "not a book");
if (await page.isVisible("#view-reader")) { await showBars(); await page.click("#btn-back"); await page.waitForTimeout(600); }
await page.click(".add-btn");
await page.waitForSelector("#sheet:not([hidden])");
const chooser = page.waitForEvent("filechooser");
await page.click('#sheet .sh-menu button:has-text("whole folder")');
await (await chooser).setFiles(shelfDir);
await page.waitForSelector("#sheet [data-go]", { timeout: 15000 });
const folderCard = (await page.textContent("#sheet")).replace(/\s+/g, " ");
check("Adding a folder finds its EPUBs, subfolders too, hidden ones skipped", /EPUB · 3 books/.test(folderCard), folderCard);
await page.click("#sheet [data-go]");
await page.waitForFunction(() => /added/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
const folderMsg = await page.textContent("#toast");
check("…and adds the new ones, skipping one already on the shelf", /2 books added/.test(folderMsg) && /1 already on your shelf/.test(folderMsg), folderMsg);
const shelfTitles = await page.evaluate(() => [...document.querySelectorAll(".lib-title")].map((t) => t.textContent));
check("…which then sit on the shelf", shelfTitles.includes("Folder Book One") && shelfTitles.includes("Folder Book Two") && !shelfTitles.includes("Hidden Book"), shelfTitles.join(", "));

// ---- Harmonarium's own backup: make one, restore it on a fresh device ------------------------
const shelfState = (pg) => pg.evaluate(() => new Promise((res) => { const r = indexedDB.open("harmonarium"); r.onsuccess = () => {
  const t = r.result.transaction(["books", "progress", "files"]), out = {};
  t.objectStore("books").getAll().onsuccess = (e) => { out.books = e.target.result.map((b) => b.title).sort(); };
  t.objectStore("progress").getAll().onsuccess = (e) => { out.places = Object.fromEntries(e.target.result.map((p) => [p.bookId, p.cfi])); };
  t.objectStore("files").count().onsuccess = (e) => { out.files = e.target.result; };
  t.oncomplete = () => { r.result.close(); res(out); };
}; }));
const shelfBefore = await shelfState(page);
await page.click("#open-settings");
await page.click("#s-backup-export");
await page.waitForSelector("#sheet [data-go]");
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sheet [data-go]")]);
const backupFile = `${OUT}/${download.suggestedFilename()}`;
await download.saveAs(backupFile);
await page.waitForFunction(() => /saved|Couldn't/.test(document.getElementById("s-backup-status").textContent), null, { timeout: 30000 });
const savedMsg = await page.textContent("#s-backup-status");
check("A backup of the whole library is made", /Backup saved/.test(savedMsg) && new RegExp(`${shelfBefore.books.length} books`).test(savedMsg), savedMsg);
await page.keyboard.press("Escape");

const page2 = await (await browser.newContext({ viewport: { width: 412, height: 860 } })).newPage();
page2.on("pageerror", (e) => errors.push(String(e)));
await page2.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await page2.goto("http://127.0.0.1:4173/");
await page2.click("#open-settings");
await page2.setInputFiles("#s-backup-import", backupFile);
await page2.waitForSelector("#sheet [data-go]", { timeout: 15000 });
await page2.click("#sheet [data-go]");
await page2.waitForFunction(() => /added|Couldn't/.test(document.getElementById("s-backup-status")?.textContent || ""), null, { timeout: 60000 });
const restoredMsg = await page2.textContent("#s-backup-status");
await page2.waitForTimeout(3000); // it restarts to apply the restored settings
const shelfAfter = await shelfState(page2);
check("…and restoring it on a fresh device brings back every book, file and reading place",
  JSON.stringify(shelfAfter) === JSON.stringify(shelfBefore), `${restoredMsg} · ${JSON.stringify(shelfAfter).slice(0, 300)}`);
await page2.click('.lib-card:has-text("Test of Pages") .lib-open').catch(() => page2.click(".lib-open"));
await page2.waitForSelector("#viewer iframe", { timeout: 15000 });
await page2.waitForTimeout(2500);
check("…and a restored book opens", (await page2.$$("#viewer iframe")).length > 0, await page2.textContent("#re-pages"));

check("No page errors", errors.length === 0, errors.slice(0, 5).join(" | "));

await writeFile(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 2));
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
