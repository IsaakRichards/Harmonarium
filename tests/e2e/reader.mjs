// End-to-end check of the reader with its real reading engine (foliate-js), in headless Chromium.
//   npm run test:reader      (builds, then runs this)
//   BASE_URL=http://…/  test an app already being served instead of dist/ (no server started)
// Opens EPUBs and a PDF, turns pages, bookmarks, quotes, searches, re-sizes and reopens, and
// saves screenshots to test-results/. Exits non-zero if any check fails.

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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  try {
    const data = await readFile(path.join(DIST, path.normalize(p)));
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
const BASE = process.env.BASE_URL || "http://127.0.0.1:4173/";
if (!process.env.BASE_URL) await new Promise((r) => server.listen(4173, "127.0.0.1", r));

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
    // Chapter 1 carries scripts, inline and in a file, which the reader must never run.
    const evil = n === 1 ? `<script>try { window.top.__bookScript = 1 } catch (e) {}</script><script src="evil.js"></script>` : "";
    zip.file(`OEBPS/ch${n}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body>${evil}<h1>Chapter ${n}</h1>${body}</body></html>`);
  }
  zip.file("OEBPS/evil.js", "try { window.top.__bookScriptFile = 1 } catch (e) {}");
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((n) => `<li><a href="ch${n}.xhtml">Chapter ${n}</a></li>`).join("")}</ol></nav></body></html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">harmonarium-test</dc:identifier><dc:title>The Test of Pages</dc:title><dc:creator>Harmonarium</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="evil" href="evil.js" media-type="application/javascript"/>${chapters.map((n) => `<item id="c${n}" href="ch${n}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((n) => `<itemref idref="c${n}"/>`).join("")}</spine></package>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

// ---------------------------------------------------------------- browser
// CHROME: a Chrome to use instead of Playwright's own (handy outside CI).
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const context = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// Known noise: the web fonts this test blocks; the engine's iframe sandbox notice; and the book
// scripts this test plants, which the reader's policy blocks on purpose.
const BENIGN = [/Failed to load resource/, /allow-scripts and allow-same-origin/, /Content Security Policy/];
const consoleLog = []; // everything the page says, shown when a check about a PDF fails
page.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
page.on("console", (m) => { if (m.type() === "error" && !BENIGN.some((re) => re.test(m.text()))) errors.push("console: " + m.text()); });
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

await page.goto(BASE);
const epubBuf = await makeEpub();
await page.setInputFiles("#file-input", { name: "test-of-pages.epub", mimeType: "application/epub+zip", buffer: epubBuf });
await page.waitForSelector(".lib-card", { timeout: 15000 });
check("EPUB imports onto the shelf", true, await page.innerText(".lib-title"));
await page.click(".lib-open");
await page.waitForSelector("#viewer iframe", { timeout: 15000 });
await page.waitForTimeout(1500);
await page.evaluate(() => document.activeElement && document.activeElement.blur());

const percent = () => page.textContent("#foot-percent");
const cfi = () => page.getAttribute("#viewer", "data-cfi");
const chapter = () => page.textContent("#foot-chapter");
const whereNow = () => page.textContent("#re-where"); // works while the bars are hidden
const showBars = () => page.evaluate(() => document.body.classList.remove("immersive"));
const setSelect = (id, value) => page.evaluate(([id, value]) => { const s = document.getElementById(id); s.value = value; s.dispatchEvent(new Event("change")); }, [id, value]);
/** Tap the page itself (the engine's frame takes taps; the edges turn, the middle toggles the bars). */
const tapAt = (x, y = 430) => page.touchscreen.tap(x, y);
const W = 412;

check("Books open in the reading engine (foliate-js)", await page.evaluate(() => !!document.querySelector("#viewer foliate-view")?.renderer));
check("A book's own scripts never run", await page.evaluate(() => !window.__bookScript && !window.__bookScriptFile));

// ---------------------------------------------------------------- turning pages
const p0 = await cfi();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(700);
check("ArrowRight turns the page", (await cfi()) && (await cfi()) !== p0, `${p0} → ${await cfi()}`);
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(700);
check("ArrowLeft turns back to the same page", (await cfi()) === p0, `${p0} → ${await cfi()}`);
await tapAt(W - 20);
await page.waitForTimeout(700);
check("A tap at the right edge turns the page", (await cfi()) !== p0, await cfi());
await tapAt(20);
await page.waitForTimeout(700);
check("A tap at the left edge turns back", (await cfi()) === p0, await cfi());
const imm0 = await page.evaluate(() => document.body.classList.contains("immersive"));
await tapAt(W / 2);
await page.waitForTimeout(300);
check("A tap in the middle shows or hides the bars", imm0 !== (await page.evaluate(() => document.body.classList.contains("immersive"))));
await page.evaluate(() => document.body.classList.add("immersive"));

async function setMode(mode) { await setSelect("page-turn", mode); await page.waitForTimeout(200); }
check("Slide mode animates the turns", await page.evaluate(() => document.querySelector("foliate-view").renderer.hasAttribute("animated")));
await setMode("curl");
check("Curl mode asks the engine for its page curl", await page.evaluate(() => document.querySelector("foliate-view").renderer.getAttribute("turn-style") === "curl"));
await setMode("fade");
await page.evaluate(() => {
  window.__op = []; window.__run = true;
  const tick = () => { if (!window.__run) return; window.__op.push(Number(getComputedStyle(document.getElementById("viewer")).opacity)); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const pf = await cfi();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(600);
const ops = await page.evaluate(() => { window.__run = false; return window.__op; });
check("Fade mode dips the page out and back", Math.min(...ops) < 0.5 && ops[ops.length - 1] === 1, `min opacity ${Math.min(...ops)}`);
check("…and still turns the page", (await cfi()) !== pf, `${pf} → ${await cfi()}`);
await setMode("none");
check("None mode turns without animation", await page.evaluate(() => !document.querySelector("foliate-view").renderer.hasAttribute("animated")));
const pn = await cfi();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(400);
check("…and turns the page", (await cfi()) !== pn);
await setMode("slide");

// cross into the next chapter
const ch0 = await chapter();
let crossed = false;
for (let i = 0; i < 40 && !crossed; i++) {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(350);
  crossed = (await chapter()) !== ch0;
}
check("Turns across a chapter break", crossed, `${ch0} → ${await chapter()}`);
await page.screenshot({ path: `${OUT}/after-chapter.png` });

// ---------------------------------------------------------------- bookmarks, quotes, search (ReadEra's free tools)
await showBars();
await page.click("#re-bm");
await page.waitForTimeout(400);
check("The bookmark button bookmarks the page", await page.evaluate(() => document.getElementById("btn-bm").classList.contains("on")));
check("…and a ribbon marks it", await page.isVisible("#bm-ribbon"));
check("ReadEra-style top bar shows the chapter and its pages", /page \d+\/\d+/.test(await whereNow()), await whereNow());
check("…and the bottom bar the pages of the book", /\d+ of \d+/.test(await page.textContent("#re-pages")), await page.textContent("#re-pages"));
await page.evaluate(() => document.body.classList.add("immersive"));
await page.waitForTimeout(400);
check("Hidden bars leave nothing over the page", !(await page.isVisible("#reader-bar")) && !(await page.isVisible("#reader-foot")) && !(await page.isVisible("#re-light")));
await showBars();
await page.waitForTimeout(300);

const selected = await page.evaluate(() => {
  const v = document.querySelector("foliate-view");
  const all = v.renderer.getContents();
  const { doc } = all.find((x) => x.index === v.renderer.primaryIndex) || all[0];
  const p = [...doc.querySelectorAll("p")].find((el) => { const r = el.getBoundingClientRect(); return r.width && r.left >= 0; }) || doc.querySelector("p");
  const t = p.firstChild, r = doc.createRange();
  r.setStart(t, 0); r.setEnd(t, Math.min(40, t.length));
  const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r);
  return s.toString();
});
await page.waitForTimeout(700);
check("Selecting text shows the Copy / Quote / Note / Find bar", await page.isVisible("#sel-bar"), selected);
await page.click("[data-sel='quote']");
await page.waitForTimeout(800);
const drawn = await page.evaluate(() => [...document.querySelector("foliate-view").renderer.getContents()].some((c) => c.overlayer?.element?.querySelector?.("g[fill]")));
check("Quote draws a highlight in the book", drawn);
check("The quote is listed under Contents → Quotes", (await page.$$("#q-list .mark-row")).length === 1);
check("…and the bookmark under Bookmarks", (await page.$$("#bm-list .mark-row")).length === 1);

await page.click("#btn-find").catch(() => page.evaluate(() => document.getElementById("btn-find").click()));
await page.fill("#find-q", "shield wall");
await page.press("#find-q", "Enter");
await page.waitForFunction(() => /found|Nothing/.test(document.getElementById("find-status").textContent), null, { timeout: 20000 });
const hits = (await page.$$("#find-results .find-hit")).length;
check("Find in book searches every chapter", hits > 4, `${hits} hits · ${await page.textContent("#find-status")}`);
const before = await cfi();
await page.click("#find-results .find-hit >> nth=-1");
await page.waitForTimeout(1200);
check("A result jumps there", (await cfi()) !== before, `${before} → ${await cfi()}`);
check("…leaving a Back chip", await page.isVisible("#jump-back"));
await page.evaluate(() => document.getElementById("find-panel").classList.add("hidden"));
await page.click("#jump-back button:not([data-dismiss-back])");
await page.waitForTimeout(1200);
check("Back returns to the page before the jump", (await cfi()) === before, `${before} → ${await cfi()}`);

// Scroll mode: one long scroll instead of pages.
await setSelect("flow", "scrolled");
await page.waitForTimeout(1500);
check("Scroll mode keeps the chapter you were in", (await chapter()) && (await cfi()), `${await chapter()} · ${await cfi()}`);
const sa = await cfi();
await page.mouse.move(W / 2, 430);
await page.mouse.wheel(0, 2500);
await page.waitForTimeout(1500);
check("Scrolling moves the reading place", (await cfi()) !== sa, `${sa} → ${await cfi()}`);
await page.screenshot({ path: `${OUT}/scroll.png` });
await setSelect("flow", "paginated");
await page.waitForTimeout(1200);

// Every turn is counted, and leaving + coming back lands on the very same page.
async function reopen() {
  await showBars();
  await page.click("#btn-back");
  await page.waitForTimeout(800);
  await page.click(".lib-open");
  await page.waitForTimeout(2500);
}
let missed = 0;
for (let i = 0; i < 6; i++) {
  const b = await cfi();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(450);
  if ((await cfi()) === b) missed++;
}
check("Each page turn moves the reading place", missed === 0, `${missed} of 6 turns not counted · now ${await whereNow()}`);
const leftAt = await cfi(), leftWhere = await whereNow();
await reopen();
check("Reopening lands on the same page", (await cfi()) === leftAt && (await whereNow()) === leftWhere, `left ${leftWhere} (${leftAt}) · back at ${await whereNow()} (${await cfi()})`);

// ---- Phone conditions -------------------------------------------------------------------
// Rotating, Android's bars hiding, split screen: the frame changes size again and again.
let at = await cfi();
for (const [w, h] of [[860, 412], [412, 860], [400, 820], [412, 860]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(700);
}
await page.waitForTimeout(800);
check("Screen re-sizes don't drift the saved place", (await cfi()) === at, `${at} → ${await cfi()}`);
await reopen();
check("…and reopening still lands on it", (await cfi()) === at, `${at} → ${await cfi()}`);

// Bigger text: more pages in the chapter, and the same place.
const smallWhere = await whereNow();
await page.evaluate(() => { document.getElementById("font-inc").click(); document.getElementById("font-inc").click(); document.getElementById("font-inc").click(); });
await page.waitForTimeout(1500);
const bigWhere = await whereNow(), bigCfi = await cfi();
check("Bigger text lays the chapter out on more pages", bigWhere !== smallWhere, `${smallWhere} → ${bigWhere}`);
check("…and keeps your place as the saved place", bigCfi === at, `${at} → ${bigCfi}`);
await page.evaluate(() => { document.getElementById("font-dec").click(); document.getElementById("font-dec").click(); document.getElementById("font-dec").click(); });
await page.waitForTimeout(1500);
check("…and the old size shows the same page again", (await whereNow()) === smallWhere && (await cfi()) === at, `${smallWhere} → ${await whereNow()}`);
await reopen();
check("…and reopening after a size change lands on it", (await cfi()) === at, `${at} → ${await cfi()}`);

// A place saved by the old engine (epub.js wrote the spine item's id into its CFIs) still opens.
await showBars();
await page.click("#btn-back");
await page.waitForTimeout(600);
const oldId = await page.getAttribute(".lib-card", "data-id");
await page.evaluate((id) => new Promise((res) => {
  const r = indexedDB.open("harmonarium");
  r.onsuccess = () => {
    const st = r.result.transaction("progress", "readwrite").objectStore("progress");
    const g = st.get(id);
    g.onsuccess = () => { st.put({ ...g.result, cfi: "epubcfi(/6/6[c3]!/4/2/1:0)" }); st.transaction.oncomplete = () => { r.result.close(); res(); }; };
  };
}), oldId);
await page.click(".lib-open");
await page.waitForTimeout(2500);
check("A place saved by the old reading engine still opens there", (await chapter()) === "Chapter 3", `${await cfi()} · ${await chapter()}`);
await showBars();

// ---- PDFs: the same engine, a page at a time --------------------------------------------
await page.click("#btn-back");
await page.waitForTimeout(600);
const pdfPage = await context.newPage();
await pdfPage.setContent(`<html><body style="font:16px serif">${[1, 2, 3, 4].map((n) => `<h1 style="page-break-before:always">Part ${n}</h1><p>${"words on a page ".repeat(80)}</p>`).join("")}</body></html>`);
const pdfBuf = await pdfPage.pdf({ format: "A5" });
await pdfPage.close();
await page.setInputFiles("#file-input", { name: "Pages of a Document.pdf", mimeType: "application/pdf", buffer: pdfBuf });
await page.waitForFunction(() => [...document.querySelectorAll(".lib-fmt")].some((t) => t.textContent.startsWith("PDF")), null, { timeout: 20000 }).catch(() => {});
await page.selectOption("#lib-section", "documents").catch(() => {});
await page.waitForTimeout(500);
const pdfCard = page.locator(".lib-card", { hasText: "Pages of a Document" });
const pdfImported = (await pdfCard.count()) === 1;
check("A PDF imports onto the shelf", pdfImported, pdfImported ? "" : `${await page.textContent("#toast").catch(() => "")}\n${consoleLog.slice(-25).join("\n")}`);
if (!pdfImported) throw new Error("The PDF didn't import; see the page's messages above");
await pdfCard.locator(".lib-open").click();
await page.waitForSelector("#viewer iframe", { timeout: 20000, state: "attached" });
await page.waitForTimeout(2500);
check("A PDF opens on its first page", (await cfi()) === "pdf:1:0.000", await cfi());
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(1200);
check("…turns to the next page", (await cfi()) === "pdf:2:0.000", await cfi());
await showBars();
await page.click("#zoom-inc").catch(() => page.evaluate(() => document.getElementById("zoom-inc").click()));
check("…zooms", (await page.textContent("#zoom-label")) === "120%", await page.textContent("#zoom-label"));
await page.evaluate(() => document.getElementById("zoom-fit").click());
await page.screenshot({ path: `${OUT}/pdf.png` });
const pdfAt = await cfi();
await reopen(); // the shelf still shows Documents, so this opens the PDF again
check("…and reopens on the page you left", (await page.isVisible("#view-reader")) && (await cfi()) === pdfAt, `${pdfAt} → ${await cfi()}`);
await showBars();
await page.click("#btn-back");
await page.waitForTimeout(600);
await page.selectOption("#lib-section", "books");
await page.waitForTimeout(400);
// Library sections: the EPUB is under Books (the PDF under Documents), and Favorites starts empty.
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
await page2.goto(BASE);
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
if (!process.env.BASE_URL) server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
