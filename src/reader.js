// The reader. Books are drawn by foliate-js, the reading engine inside Readest (see
// src/foliate/README.md): EPUBs by its paginator, PDFs by its fixed-layout renderer with pdf.js.
//
// Places are stored as before, so old saves, backups, synced places and other devices still agree:
//   EPUB  an EPUB CFI, e.g. "epubcfi(/6/14!/4/2/1:0)"
//   PDF   "pdf:<page>:<fraction of that page>", e.g. "pdf:12:0.000"
import "./foliate/view.js";
import { Overlayer } from "./foliate/overlayer.js";
import * as CFI from "./foliate/epubcfi.js";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { escapeHtml, pct, timeAgo, toast } from "./util.js";
import * as readera from "./readera.js";
import * as marks from "./marks.js";
import * as finder from "./finder.js";
import * as about from "./aboutbook.js";
import * as sheet from "./sheet.js";

const THEMES = {
  light: { bg: "#fbfaf7", fg: "#1d1b18", link: "#3b5bdb" },
  sepia: { bg: "#f4ecd8", fg: "#4a3b28", link: "#8a4b14" },
  dark: { bg: "#000000", fg: "#d9d6cf", link: "#9db4ff" },  // Night: black page, bright text
  black: { bg: "#000000", fg: "#bdbab3", link: "#9db4ff" },
};
const MARGIN = { s: 0.55, m: 1, l: 1.7, xl: 2.6 };
export const TURNS = ["slide", "curl", "fade", "none"];

let view = null;      // the <foliate-view> element
let meta = null;      // our stored book record
let pdf = false;      // is the open book a PDF?
let toc = [];         // flattened table of contents: { label, href, depth, index }
let current = null;   // { cfi, percent, chapter }
let lastSavedCfi = null;
let holdSaves = false; // true while we check the sheet on open
let initialCfi = null; // where the book first landed, so merely opening never counts as reading
// A place reached by opening the book or from another device is kept exactly as it was until you
// turn a page yourself: the page that holds it here starts a little earlier, and saving that start
// would walk two devices backwards through the book. (foliate-js itself keeps the page steady
// through re-layouts, so this is the only anchoring left to do.)
let anchorCfi = null;
let anchored = false;
let pendingRemote = null;
let hooks = { close: () => {}, onFinished: () => {}, onKey: () => {}, onBookChanged: () => {} };
let finishOffered = false;
let tocIndex = -1;     // the contents entry for the current page
let wakeLock = null;
let chapterPages = null; // { page, total } within the current chapter
let loc = null;          // foliate's last location: { fraction, location, section, tocItem, cfi, range }
let pdfZoom = 1;         // 1 = fit the page's width
let annotationTapAt = 0; // a tap on a highlight opens it instead of bringing the bars up

const NIGHT = new Set(["dark", "black"]);
const scrolled = () => settings.get().flow === "scrolled";
const turnMode = () => (TURNS.includes(settings.get().pageTurn) ? settings.get().pageTurn : "slide");

/** Theme names; the ReadEra look uses ReadEra's own (Day, Sepia, Night, Console). */
function themeName(t) {
  const names = readera.readerOn()
    ? { light: "Day", sepia: "Sepia", dark: "Night", black: "Console" }
    : { light: "Day", sepia: "Parchment", dark: "Night", black: "Midnight" };
  return names[t] || t;
}
function nameSwatches() {
  for (const sw of document.querySelectorAll(".swatch")) {
    const n = themeName(sw.dataset.theme);
    sw.title = n; sw.setAttribute("aria-label", n);
  }
}

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function init(h) {
  hooks = { ...hooks, ...h };

  $("btn-back").addEventListener("click", () => closeBook());
  $("btn-toc").addEventListener("click", () => toggle("toc-drawer"));
  $("btn-aa").addEventListener("click", () => toggle("aa-panel"));
  $("btn-find").addEventListener("click", () => { closeOverlays(); finder.open(); });
  $("btn-more").addEventListener("click", () => moreMenu());
  // ReadEra look: the same tools, along the bottom bar.
  $("re-toc").addEventListener("click", () => toggle("toc-drawer"));
  $("re-aa").addEventListener("click", () => toggle("aa-panel"));
  $("re-daynight").addEventListener("click", () => dayNight());
  nameSwatches();
  window.addEventListener("harmonarium:readera", () => { nameSwatches(); applyStyles(); applyLayout(); });
  for (const b of document.querySelectorAll("[data-dismiss]")) {
    b.addEventListener("click", () => $(b.dataset.dismiss).classList.add("hidden"));
  }
  // Navigation panel tabs: Contents, Bookmarks, Quotes, Notes.
  for (const t of document.querySelectorAll("[data-nav]")) t.addEventListener("click", () => navTab(t.dataset.nav));

  // The page itself takes taps and swipes (see onLoad); these edge zones stay out of its way and
  // only answer a click that somehow lands on them.
  for (const [id, dir] of [["tap-prev", -1], ["tap-next", 1]]) {
    $(id).addEventListener("click", () => { marks.hideSelection(); turn(dir); });
  }
  // Mouse wheel / trackpad on desktop turns pages too.
  $("viewer-wrap").addEventListener("wheel", onWheel, { passive: true });
  $("page-turn").addEventListener("change", async (e) => {
    await settings.update({ pageTurn: e.target.value });
    applyLayout();
  });
  $("flow").addEventListener("change", async (e) => {
    await settings.update({ flow: e.target.value });
    syncPanelState();
    document.body.classList.toggle("flow-scroll", scrolled());
    applyLayout();
  });

  $("font-dec").addEventListener("click", () => setFontSize(settings.get().fontSize - 10));
  $("font-inc").addEventListener("click", () => setFontSize(settings.get().fontSize + 10));
  $("zoom-dec").addEventListener("click", () => setZoom(pdfZoom / 1.2));
  $("zoom-inc").addEventListener("click", () => setZoom(pdfZoom * 1.2));
  $("zoom-fit").addEventListener("click", () => setZoom(1));
  for (const sw of document.querySelectorAll(".swatch")) {
    sw.addEventListener("click", () => setTheme(sw.dataset.theme));
  }
  for (const [id, key] of [["font-family", "fontFamily"], ["line-height", "lineHeight"], ["text-align", "textAlign"], ["margins", "margin"]]) {
    $(id).addEventListener("change", async (e) => {
      await settings.update({ [key]: e.target.value });
      if (key === "fontFamily") { await rebuild(); return; } // fonts are woven into the book's own styles
      applyStyles();
      if (key === "margin") applyLayout();
    });
  }
  $("embedded-fonts").addEventListener("change", async (e) => {
    await settings.update({ embeddedFonts: e.target.checked });
    await rebuild(); // the book's fonts are put back or taken out as each chapter loads
  });
  $("hyphens").addEventListener("change", async (e) => { await settings.update({ hyphens: e.target.checked }); applyStyles(); });
  $("keep-awake").addEventListener("change", async (e) => { await settings.update({ keepAwake: e.target.checked }); awake(!!meta); });
  for (const id of ["brightness", "re-bright"]) {
    $(id).addEventListener("input", (e) => {
      applyBrightness(Number(e.target.value) / 100);
      for (const other of ["brightness", "re-bright"]) if (other !== id) $(other).value = e.target.value;
    });
    $(id).addEventListener("change", (e) => settings.update({ brightness: Number(e.target.value) / 100 }));
  }
  // ReadEra-style reader: the brightness strip under the top bar folds away with its chevron.
  $("re-light-fold").addEventListener("click", async () => {
    await settings.update({ lightStrip: settings.get().lightStrip === false });
    $("re-light").classList.toggle("folded", settings.get().lightStrip === false);
  });
  $("re-light-aa").addEventListener("click", () => toggle("aa-panel"));
  $("toc-more").addEventListener("click", () => moreMenu());
  $("re-bm").addEventListener("click", () => marks.toggleBookmark());

  const slider = $("progress-slider");
  // The bar sits where Android's home gesture starts, so only a deliberate sideways drag moves
  // the book: a touch that heads upward, is taken by the system, or is just a tap snaps back.
  let scrub = null; // { x, y, lx, ly, value, cancelled, fromEdge }
  const track = (e) => { if (scrub) { scrub.lx = e.clientX; scrub.ly = e.clientY; } };
  slider.addEventListener("pointerdown", (e) => {
    scrub = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, value: slider.value, cancelled: false,
      fromEdge: e.pointerType === "touch" && e.clientY > window.innerHeight - 18 };
  }, { passive: true });
  slider.addEventListener("pointermove", track, { passive: true });
  slider.addEventListener("pointerup", track, { passive: true });
  slider.addEventListener("pointercancel", () => { if (scrub) { scrub.cancelled = true; slider.value = scrub.value; } });
  slider.addEventListener("change", () => {
    const s = scrub;
    scrub = null;
    if (s) {
      const dx = Math.abs(s.lx - s.x), dy = Math.abs(s.ly - s.y);
      if (s.cancelled || s.fromEdge || dx < 12 || dy > dx) { slider.value = s.value; return; }
    }
    finder.noteJump();
    goToPercent(slider.value / 1000);
  });

  $("sync-jump").addEventListener("click", () => {
    if (pendingRemote) goToPlace(pendingRemote.cfi);
    hideBanner();
  });
  $("sync-stay").addEventListener("click", async () => {
    if (pendingRemote) await db.put("kv", Number(pendingRemote.updated_at), `dismissed:${meta.id}`);
    hideBanner();
  });

  // The brightness strip and the back link sit just inside the bars, whatever their height.
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      const st = document.documentElement.style; // read by the reader and by messages (toasts)
      st.setProperty("--re-bar-h", `${$("reader-bar").offsetHeight}px`);
      st.setProperty("--re-foot-h", `${$("reader-foot").offsetHeight}px`);
    });
    ro.observe($("reader-bar"));
    ro.observe($("reader-foot"));
  }
  marks.init();
  finder.init();

  // Keys are handled by dpad.js (see api() below). foliate-js lays the pages out again by itself
  // whenever its frame changes size (rotation, Android's bars hiding, split screen), keeping the
  // page you were reading; only the side margins, which follow the width, are ours to update.
  window.addEventListener("resize", scheduleLayout);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { awake(!!meta); fullScreen(!!meta); return; }
    // Leaving the app (home button, switching apps): save the exact page now, as Android may close us.
    if (meta && !holdSaves && current && current.cfi !== lastSavedCfi) saveProgress();
    sync.flushNow();
  });
  window.addEventListener("harmonarium:readera", () => fullScreen(!!meta));
  applyBrightness(settings.get()?.brightness ?? 1);
}

function toggle(id) {
  for (const other of ["toc-drawer", "aa-panel"]) if (other !== id) $(other).classList.add("hidden");
  finder.close();
  marks.hideSelection();
  $(id).classList.toggle("hidden");
  if (id === "toc-drawer" && !$(id).classList.contains("hidden")) {
    navTab(document.querySelector("[data-nav][aria-selected='true']")?.dataset.nav || "contents");
  }
}

function navTab(name) {
  for (const t of document.querySelectorAll("[data-nav]")) t.setAttribute("aria-selected", String(t.dataset.nav === name));
  for (const p of document.querySelectorAll("[data-navpane]")) p.hidden = p.dataset.navpane !== name;
  if (name === "contents") $("toc-list").querySelector("a.current")?.scrollIntoView({ block: "center" });
}

/** Day ↔ Night, remembering which day and night themes were last used. */
async function dayNight() {
  const s = settings.get();
  await setTheme(NIGHT.has(s.theme) ? s.dayTheme || "light" : s.nightTheme || "dark");
  toast(themeName(settings.get().theme));
}

/** Turn a page (+1 forward, -1 back) with the chosen animation. */
let fading = false;
async function turn(dir) {
  if (!view?.renderer) return;
  userMoved();
  const go = () => (dir > 0 ? view.next() : view.prev());
  if (turnMode() !== "fade" || scrolled() || pdf) return go();
  // Fade: the page dips out and comes back on the new one.
  const el = $("viewer");
  if (fading) return go();
  fading = true;
  try {
    el.style.transition = "opacity 110ms ease-in";
    el.style.opacity = "0";
    await wait(110);
    await go();
    el.style.transition = "opacity 160ms ease-out";
    el.style.opacity = "1";
    await wait(160);
  } finally {
    el.style.transition = ""; el.style.opacity = "";
    fading = false;
  }
}

/** You moved (a turn, a drag, a jump): the page you land on becomes your place. */
function userMoved() { anchored = false; }

let wheelAt = 0;
function onWheel(e) {
  if (pdf || scrolled()) return; // those scroll by themselves
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (Math.abs(d) < 4 || Date.now() - wheelAt < 350) return;
  wheelAt = Date.now();
  turn(d > 0 ? 1 : -1);
}

/** The reader's ⋮ menu. */
async function moreMenu() {
  if (!meta) return;
  const fav = !!meta.favorite;
  const v = await sheet.menu({
    title: meta.title,
    items: [
      { label: "Find in book", value: "find", icon: "⌕" },
      { label: "Go to page", value: "goto", icon: "↧" },
      { label: $("btn-bm").classList.contains("on") ? "Remove bookmark" : "Add bookmark", value: "bm", icon: "🔖" },
      { label: fav ? "Remove from Favorites" : "Add to Favorites", value: "fav", icon: fav ? "★" : "☆" },
      { label: "About this book", value: "about", icon: "ⓘ" },
    ],
  });
  if (v === "find") finder.open();
  else if (v === "goto") finder.goTo();
  else if (v === "bm") marks.toggleBookmark();
  else if (v === "about") about.show(meta.id);
  else if (v === "fav") {
    meta = { ...meta, favorite: !fav };
    await db.put("books", meta);
    toast(fav ? "Removed from Favorites" : "Added to Favorites");
  }
}

export const api = {
  next: () => turn(1),
  prev: () => turn(-1),
  barsVisible: () => !document.body.classList.contains("immersive"),
  showBars: () => document.body.classList.remove("immersive"),
  hideBars: () => { closeOverlays(); document.body.classList.add("immersive"); },
  overlayOpen: () => sheet.isOpen() || finder.isOpen() || marks.selectionOpen() ||
    ["toc-drawer", "aa-panel", "sync-banner"].some((id) => !$(id).classList.contains("hidden")),
  closeOverlays,
  close: () => closeBook(),
  // Keypad shortcuts (see dpad.js)
  toggleContents: () => { document.body.classList.remove("immersive"); toggle("toc-drawer"); },
  toggleText: () => { document.body.classList.remove("immersive"); toggle("aa-panel"); },
  textSize: (step) => (pdf ? setZoom(pdfZoom * (step > 0 ? 1.2 : 1 / 1.2)) : setFontSize(settings.get().fontSize + step * 10)),
  cycleTheme: () => {
    const order = ["light", "sepia", "dark", "black"];
    const next = order[(order.indexOf(settings.get().theme) + 1) % order.length];
    setTheme(next);
    toast(themeName(next));
  },
  bookmark: () => marks.toggleBookmark(),
  find: () => finder.open(),
};

function closeOverlays() {
  if (sheet.isOpen()) sheet.close(null);
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
  finder.close();
  marks.hideSelection();
  if (pendingRemote) hideBanner();
}

// ------------------------------------------------------------------ places

/** A stored place → what foliate-js navigates to: a page index for PDFs, else the CFI or href. */
function target(at) {
  if (at == null || at === "") return null;
  const m = /^pdf:(\d+)/.exec(String(at));
  if (m) return Math.max(0, Number(m[1]) - 1);
  return at;
}
const pdfPos = (page, frac = 0) => `pdf:${page}:${Math.max(0, Math.min(0.999, frac)).toFixed(3)}`;

/** The page number (1-based) of a stored place, or 0 if it can't be told without loading. */
function pageOf(at) {
  if (pdf) return (target(at) ?? -1) + 1;
  return 0;
}

const pages = () => (pdf ? view?.book?.sections.length || 0 : loc?.location?.total || 0);
const pageNow = () => (pdf ? (loc?.section?.current ?? 0) + 1 : loc?.location ? loc.location.current + 1 : 0);

function goToPercent(f) {
  if (!view?.book) return;
  userMoved();
  f = Math.max(0, Math.min(1, f));
  if (pdf) return view.goTo(Math.round(f * (view.book.sections.length - 1)));
  return view.goToFraction(f);
}

function goToPage(n) {
  if (!view?.book) return;
  userMoved();
  if (pdf) return view.goTo(Math.max(0, n - 1));
  const total = pages();
  return total ? view.goToFraction((n - 1) / total) : null;
}

// ------------------------------------------------------------------ open

export async function open(id) {
  meta = await db.get("books", id);
  const buf = await db.get("files", id);
  if (!meta || !buf) { toast("That book is missing from this device"); return false; }

  const local = await db.get("progress", id);
  lastSavedCfi = local?.cfi || null;
  holdSaves = true;
  initialCfi = null;
  finishOffered = false;
  hideBanner();

  $("reader-title").textContent = meta.title;
  $("re-book").textContent = meta.title;
  $("toc-book").textContent = meta.title;
  $("re-author").textContent = meta.author || "";
  $("re-where").textContent = "";
  $("re-pages").textContent = "";
  $("re-light").classList.toggle("folded", settings.get().lightStrip === false);
  // ReadEra opens a book full-screen; a tap in the middle brings the toolbars up.
  if (readera.readerOn()) document.body.classList.add("immersive");
  tocIndex = -1;
  current = null;
  loc = null;
  chapterPages = null;
  pdfZoom = 1;
  $("progress-slider").disabled = true;
  document.body.dataset.rtheme = settings.get().theme;

  pdf = meta.format === "pdf" || isPdfBytes(buf);
  document.body.classList.add("foliate");
  document.body.classList.toggle("pdf-mode", pdf);
  document.body.classList.toggle("flow-scroll", scrolled());
  syncPanelState();

  try {
    await mountView(buf);
  } catch (err) {
    console.error("open", err);
    toast("This book couldn't be opened");
    await closeBook();
    return false;
  }

  // A place imported from ReadEra is a fraction of the book: turn it into an exact spot, once.
  let startAt = local?.cfi || null;
  if (!startAt && local?.fromReadEra != null) {
    try {
      await goToPercent(local.fromReadEra);
      // The page found holds a span of text; keep its first spot, like every other saved place.
      startAt = pdf ? pdfPos(pageNow()) : view.lastLocation?.cfi ? CFI.collapse(view.lastLocation.cfi) : null;
      if (startAt) {
        const entry = { ...local, cfi: startAt };
        delete entry.fromReadEra;
        await db.put("progress", entry);
        lastSavedCfi = startAt;
        sync.queue(meta, entry);
      }
    } catch (err) { console.warn("ReadEra place", err); }
  }

  anchorCfi = startAt;
  anchored = !!anchorCfi && !pdf;
  await showAt(startAt);
  $("progress-slider").disabled = false;
  renderToc(); // with page numbers, now that the page count is known
  if (pdf && !meta.pages) meta = { ...meta, pages: view.book.sections.length };

  await db.put("books", { ...meta, lastOpenedAt: Date.now() });
  awake(true);
  fullScreen(true);
  checkRemote(local); // runs in the background, then releases holdSaves
  return true;
}

function isPdfBytes(buf) {
  const h = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
  return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46;
}

/** Create the <foliate-view>, open the book in it and wire it up. */
async function mountView(buf) {
  $("viewer").innerHTML = "";
  view = document.createElement("foliate-view");
  view.id = "foliate";
  $("viewer").append(view);
  view.addEventListener("load", (e) => onLoad(e.detail));
  // Links to websites inside a book would turn the reader into a browser (and on phones
  // without one, like the Commodore Callback, strand you there), so they're turned off.
  view.addEventListener("external-link", (e) => { e.preventDefault(); toast("Links to websites are turned off in books"); });
  view.addEventListener("link", () => { finder.noteJump(); userMoved(); }); // a footnote: leave a way back
  view.addEventListener("draw-annotation", onDrawAnnotation);
  view.addEventListener("show-annotation", (e) => { annotationTapAt = Date.now(); marks.onAnnotationTap(e.detail.value); });

  const name = pdf ? `${meta.id}.pdf` : `${meta.id}.epub`;
  const file = new File([buf], name, { type: pdf ? "application/pdf" : "application/epub+zip" });
  await view.open(file);
  noScripts(view.book);
  // foliate-view hears the renderer first and works out the location (view.lastLocation); this
  // runs just after, with both the location and the renderer's own place in the chapter.
  view.renderer.addEventListener("relocate", (e) => onRelocate(e.detail));
  applyLayout();
  applyStyles();

  toc = flattenToc(view.book.toc);
  renderToc();
  loadAnnotations();
}

/** Books never run code. foliate-js shows each chapter in a frame that must allow scripts (for a
 *  WebKit bug), and that frame shares the app's origin, so a book's script could reach your sync
 *  link and key. Script files aren't loaded at all, and every chapter gets a policy that forbids
 *  scripts inside it (inline ones and onclick-style attributes included). */
const NO_SCRIPT = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'" />`;
function noScripts(book) {
  const t = book?.transformTarget;
  if (!t) return;
  t.addEventListener("load", (e) => { if (e.detail.isScript) e.detail.allow = false; });
  t.addEventListener("data", (e) => {
    const d = e.detail;
    if (!/html/i.test(d.type || "")) return;
    d.data = Promise.resolve(d.data).then((x) => {
      if (typeof x !== "string") return x;
      if (/<head[\s>]/i.test(x)) return x.replace(/<head(\s[^>]*)?>/i, (h) => h + NO_SCRIPT);
      return x.replace(/<html(\s[^>]*)?>/i, (h) => `${h}<head>${NO_SCRIPT}</head>`);
    });
  });
}

/** Put the first page up. */
async function showAt(at) {
  const t = target(at);
  try {
    if (t == null) await view.init({ showTextStart: false });
    else await view.init({ lastLocation: t });
  } catch (err) {
    console.warn("place", err);
    await view.init({ showTextStart: false });
  }
  if (!loc) await view.goTo(0); // a place that no longer resolves: start at the beginning
}

/** What marks.js and finder.js need to know about the open book. */
function loadAnnotations() {
  const ctx = {
    bookId: meta.id,
    isPdf: pdf,
    view: () => view,
    current: () => current,
    location: () => loc,
    display,
    jump: (at) => { finder.go(at); if (window.innerWidth < 700) $("toc-drawer").classList.add("hidden"); },
    chapterFor,
    night: () => NIGHT.has(settings.get().theme),
    find: (q) => { closeOverlays(); finder.open(q); },
    pageOf,
    pages,
    pageNow,
    goToPage,
    goToPercent,
    pdfPos,
  };
  marks.load(ctx);
  finder.load(ctx);
}

/** Go to a stored position (an EPUB CFI or href, or a PDF "pdf:…" position). */
function display(at) {
  const t = target(at);
  if (t == null || !view) return;
  userMoved();
  return view.goTo(t);
}

/** Go to a reading place from another device, keeping it as your place until you turn a page. */
function goToPlace(at) {
  if (!at || !view) return;
  if (!pdf) { anchorCfi = at; anchored = !scrolled(); }
  return view.goTo(target(at));
}

function toggleBars() {
  document.body.classList.toggle("immersive");
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
}

// ------------------------------------------------------------ the pages

/** Every chapter (EPUB) or page (PDF) as foliate-js loads it into its frame. */
function onLoad({ doc, index }) {
  if (!pdf) {
    try { weaveFonts(doc); } catch (err) { console.warn("fonts", err); }
    // Hyphenation needs a language; borrow the book's when the chapter file has none.
    const html = doc.documentElement;
    const lang = view?.book?.metadata?.language;
    if (!html.getAttribute("lang") && lang) html.setAttribute("lang", Array.isArray(lang) ? lang[0] : lang);
  }
  doc.addEventListener("click", (e) => onPageClick(e, doc));
  doc.addEventListener("wheel", onWheel, { passive: true });
  doc.addEventListener("keydown", (e) => hooks.onKey(e));
  if (!pdf) {
    let selTimer = 0;
    doc.addEventListener("selectionchange", () => {
      marks.onSelectionChange(doc);
      clearTimeout(selTimer);
      selTimer = setTimeout(() => onSelection(doc, index), 300);
    });
  }
}

/** A tap on the page: the edges turn it, the middle brings the bars up or hides them. */
function onPageClick(e, doc) {
  if (e.defaultPrevented || e.target?.closest?.("a[href]")) return;
  const sel = doc.getSelection?.();
  if (sel && String(sel).trim()) return;
  if (marks.selectionOpen()) { marks.hideSelection(); return; }
  const fr = doc.defaultView?.frameElement?.getBoundingClientRect?.();
  const x = (fr ? fr.left : 0) + e.clientX;
  const wrap = $("viewer-wrap").getBoundingClientRect();
  const w = wrap.width || window.innerWidth;
  const rel = x - wrap.left;
  // Let foliate's own click on a highlight (show-annotation) go first.
  setTimeout(() => {
    if (Date.now() - annotationTapAt < 400) return;
    const edge = readera.readerOn() ? 1 / 3 : 0.3;
    if (rel < w * edge) {
      if (!document.body.classList.contains("immersive") && readera.readerOn()) closeOverlays();
      return turn(-1);
    }
    if (rel > w * (1 - edge)) {
      if (!document.body.classList.contains("immersive") && readera.readerOn()) closeOverlays();
      return turn(1);
    }
    toggleBars();
  }, 0);
}

/** Text selected in the book: show the Copy / Quote / Note / Find bar over it. */
function onSelection(doc, index) {
  const sel = doc.getSelection?.();
  if (!sel || sel.isCollapsed || !String(sel).trim() || !view) return;
  try {
    const range = sel.getRangeAt(0);
    const cfi = view.getCFI(index, range);
    marks.onSelected(cfi, { document: doc, window: doc.defaultView });
  } catch (err) { console.warn("selection", err); }
}

/** foliate-js asks how to draw a highlight: quotes in gold, a found word in blue. */
function onDrawAnnotation(e) {
  const { draw, annotation } = e.detail;
  if (annotation.kind === "find") return draw(Overlayer.highlight, { color: "#4fa3f7" });
  draw(Overlayer.highlight, { color: "#ffd54f" });
}

let layoutTimer = 0;
function scheduleLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => applyLayout(), 120);
}

/** The side margins: ReadEra's slim default, scaled by the Margins setting. */
function pageGap() {
  const w = $("viewer")?.clientWidth || window.innerWidth;
  const f = MARGIN[settings.get().margin] || 1;
  return 2 * Math.round(Math.min(48, Math.max(14, w * 0.05)) * f);
}

/** Pages or scroll, page turns, margins and columns: the renderer's own settings. */
function applyLayout() {
  const r = view?.renderer;
  if (!r) return;
  const flow = scrolled() ? "scrolled" : "paginated";
  if (r.getAttribute("flow") !== flow) r.setAttribute("flow", flow);
  if (pdf) {
    r.setAttribute("zoom", "fit-width");
    r.setAttribute("scale-factor", String(Math.round(pdfZoom * 100)));
    r.setAttribute("spread", window.innerWidth >= 900 && !scrolled() ? "auto" : "none");
    return;
  }
  const mode = turnMode();
  r.toggleAttribute("animated", mode === "slide" || mode === "curl");
  if (mode === "curl") r.setAttribute("turn-style", "curl"); else r.removeAttribute("turn-style");
  const side = Math.round(pageGap() / 2);
  const tight = readera.readerOn();
  r.setAttribute("margin-left", `${side}px`);
  r.setAttribute("margin-right", `${side}px`);
  r.setAttribute("margin-top", `${tight ? 10 : 22}px`);
  r.setAttribute("margin-bottom", `${tight ? 6 : 22}px`);
  r.setAttribute("gap", "0%");
  r.setAttribute("column-gap", `${2 * side}px`);
  // One page on phones and narrow windows, two side by side from 900 px.
  r.setAttribute("max-inline-size", scrolled() ? "760px" : "899px");
  r.setAttribute("max-column-count", "2");
}

// ------------------------------------------------------------- progress

async function checkRemote(local) {
  try {
    if (!sync.isConfigured()) return;
    const entries = await Promise.race([
      sync.fetchBook(meta.id),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    const remote = sync.newestFromOthers(entries);
    if (!remote) return;
    const localAt = local?.updatedAt || 0;
    if (Number(remote.updated_at) <= localAt) return;
    if (remote.cfi === local?.cfi) return;
    const dismissed = await db.get("kv", `dismissed:${meta.id}`);
    if (dismissed && Number(dismissed) >= Number(remote.updated_at)) return;

    if (settings.get().autoJump) {
      await goToPlace(remote.cfi);
      toast(`Resumed from ${remote.device_name} · ${pct(remote.percent)}`);
    } else {
      showBanner(remote);
    }
  } catch (err) {
    console.warn("Sync check failed:", err);
  } finally {
    holdSaves = false;
    if (current && current.cfi !== initialCfi && current.cfi !== lastSavedCfi) saveProgress();
    else if (current) lastSavedCfi = current.cfi;
  }
}

function showBanner(remote) {
  pendingRemote = remote;
  $("sync-banner-text").innerHTML =
    `On <b>${escapeHtml(remote.device_name || "another device")}</b> you reached ` +
    `<b>${pct(remote.percent)}</b>${remote.chapter ? ` — ${escapeHtml(remote.chapter)}` : ""} ` +
    `<span class="muted">(${timeAgo(Number(remote.updated_at))})</span>`;
  $("sync-banner").classList.remove("hidden");
}

function hideBanner() {
  pendingRemote = null;
  $("sync-banner").classList.add("hidden");
}

/** foliate-js moved: work out the place, chapter and percent. `r` is the renderer's own report
 *  (which chapter, and how far into it), `loc` the location foliate-view made of it. */
function onRelocate(r) {
  loc = view?.lastLocation;
  if (!loc) return;
  const index = r.index ?? loc.section?.current ?? 0;
  let cfi, percent;
  if (pdf) {
    const n = view.book.sections.length;
    cfi = pdfPos(index + 1);
    percent = n > 1 ? index / (n - 1) : 1;
    const hit = pdfTocFor(index);
    tocIndex = hit ? toc.indexOf(hit) : -1;
    const start = hit ? hit.index : 0;
    const next = toc.filter((t) => t.index > start).reduce((m, t) => Math.min(m, t.index), n);
    chapterPages = { page: index - start + 1, total: Math.max(1, next - start) };
  } else {
    // foliate reports the whole visible page as a range; a place is where that page starts.
    try { cfi = CFI.collapse(loc.cfi); } catch { cfi = loc.cfi; }
    // How far through the book this page starts (foliate's own fraction is where it ends).
    const fr = view.getSectionFractions?.() || [];
    const a = fr[index], b = fr[index + 1];
    percent = a != null && b != null ? a + (b - a) * (r.fraction || 0) : loc.fraction ?? 0;
    percent = Math.max(0, Math.min(1, percent));
    const hit = tocEntryFor(loc.tocItem);
    tocIndex = hit ? toc.indexOf(hit) : -1;
    chapterPages = null;
    if (!scrolled() && r.size > 0) {
      const total = Math.max(1, Math.round(1 / r.size));
      chapterPages = { page: Math.min(total, Math.max(1, Math.round((r.fraction || 0) / r.size) + 1)), total };
    }
  }
  const atEnd = pdf ? index >= view.book.sections.length - 1 : !!view.renderer?.atEnd;
  if (atEnd) percent = 1; // the last page starts a little before the end, but it is the end
  moved(cfi, percent, tocIndex >= 0 ? toc[tocIndex].label : loc.tocItem?.label || "", atEnd);
  marks.onRelocated(loc);
}

function moved(cfi, percent, chapter, atEnd) {
  // A re-layout doesn't move your place: keep the anchor as the place to save (it's on screen).
  if (anchored && anchorCfi && !pdf) cfi = anchorCfi;
  else anchorCfi = cfi;
  current = { cfi, percent, chapter };
  $("viewer").dataset.cfi = cfi; // where the reader is (handy for tests and debugging)
  if (holdSaves && initialCfi === null) initialCfi = cfi;
  if (!holdSaves && !finishOffered && atEnd) {
    finishOffered = true;
    hooks.onFinished(meta.title, meta.id);
  }
  updateFooter();
  if (!holdSaves && cfi !== lastSavedCfi) saveProgress();
}

function updateFooter() {
  const total = pages();
  const now = pageNow();
  $("foot-page").textContent = total ? `${now} / ${total}` : "";
  $("foot-chapter").textContent = current?.chapter || "";
  // ReadEra-style reader: "Chapter 11 • page 14/15" up top, "227 of 1918" down below.
  const cp = chapterPages ? `page ${chapterPages.page}/${chapterPages.total}` : "";
  $("re-where").textContent = [current?.chapter, cp].filter(Boolean).join(" • ");
  $("re-pages").textContent = total ? `${now} of ${total}` : pct(current?.percent);
  $("foot-percent").textContent = pct(current?.percent);
  $("progress-slider").value = Math.round((current?.percent || 0) * 1000);
  for (const a of $("toc-list").querySelectorAll("a")) a.classList.toggle("current", Number(a.dataset.i) === tocIndex);
  if (readera.readerOn()) readera.track(current?.percent, chapterMarks());
}

async function saveProgress() {
  if (!current || !meta) return;
  const entry = { bookId: meta.id, ...current, updatedAt: Date.now() };
  lastSavedCfi = current.cfi;
  await db.put("progress", entry);
  await sync.queue(meta, entry);
}

// ------------------------------------------------------------------ toc

function flattenToc(items, depth = 0, out = []) {
  for (const it of items || []) {
    const label = (typeof it.label === "string" ? it.label : String(it.label ?? "")).trim();
    let index = null;
    try { const r = view?.book?.resolveHref?.(it.href); if (r && typeof r.then !== "function") index = r.index ?? null; } catch { /* unresolvable */ }
    out.push({ label, href: it.href, depth, index });
    flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

/** PDFs: foliate resolves outline links asynchronously, so look up each entry's page once. */
async function resolvePdfToc() {
  for (const t of toc) {
    if (t.index != null || !t.href) continue;
    try { t.index = (await view.book.resolveHref(t.href))?.index ?? null; } catch { /* leave it */ }
  }
}

/** The contents entry for foliate's current TOC item. */
function tocEntryFor(item) {
  if (!item) return null;
  return toc.find((t) => t.href === item.href) || toc.find((t) => t.label === item.label) || null;
}
/** PDFs: the last outline entry that starts on or before the page (0-based). */
function pdfTocFor(index) {
  let hit = null;
  for (const t of toc) if (t.index != null && t.index <= index && (!hit || t.index >= hit.index)) hit = t;
  return hit;
}
/** The chapter title for a stored place. */
function chapterFor(where) {
  if (pdf) return pdfTocFor((target(where) ?? 0))?.label || "";
  try {
    const r = view.resolveNavigation(target(where));
    if (r?.index == null) return "";
    let hit = null;
    for (const t of toc) if (t.index != null && t.index <= r.index && (!hit || t.index >= hit.index)) hit = t;
    return hit?.label || "";
  } catch { return ""; }
}

/** The page each contents entry starts on. */
function tocPageNo(t) {
  if (t.index == null) return "";
  if (pdf) return t.index + 1;
  const total = loc?.location?.total;
  const fr = view?.getSectionFractions?.()[t.index];
  if (!total || fr == null) return "";
  return Math.min(total, Math.floor(fr * total) + 1);
}

async function renderToc() {
  if (pdf) await resolvePdfToc();
  const list = $("toc-list");
  list.innerHTML = toc.length
    ? toc.map((t, i) => {
        const n = tocPageNo(t);
        return `<a href="#" data-i="${i}" style="padding-left:${14 + t.depth * 16}px"><span>${escapeHtml(t.label)}</span>${n ? `<small>${n}</small>` : ""}</a>`;
      }).join("")
    : `<p class="hint">This book has no table of contents.</p>`;
  for (const a of list.querySelectorAll("a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = toc[Number(a.dataset.i)];
      finder.go(t.href);
      $("toc-drawer").classList.add("hidden");
    });
  }
  if (current) updateFooter();
}

/** Where each top-level chapter starts, 0–1. */
function chapterMarks() {
  if (!toc.length) return [];
  const n = pdf ? Math.max(1, (view?.book?.sections.length || 1) - 1) : 0;
  const fr = pdf ? null : view?.getSectionFractions?.() || [];
  const out = [];
  for (const t of toc) {
    if (t.depth !== 0 || t.index == null) continue;
    const p = pdf ? t.index / n : fr[t.index];
    if (p > 0.001 && p < 0.999) out.push(p);
  }
  return out.length > 80 ? [] : [...new Set(out)];
}

// ---------------------------------------------------------- appearance

async function setFontSize(v) {
  const size = Math.min(250, Math.max(60, v));
  await settings.update({ fontSize: size });
  $("font-size-label").textContent = `${size}%`;
  applyStyles();
}

function setZoom(z) {
  if (!pdf) return;
  pdfZoom = Math.min(5, Math.max(0.5, z));
  view?.renderer?.setAttribute("scale-factor", String(Math.round(pdfZoom * 100)));
  $("zoom-label").textContent = `${Math.round(pdfZoom * 100)}%`;
}

async function setTheme(name) {
  await settings.update({ theme: name, [NIGHT.has(name) ? "nightTheme" : "dayTheme"]: name });
  document.body.dataset.rtheme = name;
  applyStyles(); // PDFs are tinted in styles.css
}

function applyBrightness(b) {
  const v = Math.max(0.2, Math.min(1, Number.isFinite(b) ? b : 1));
  $("dim").style.opacity = String((1 - v) * 0.85);
}

/** Android: hide the status and navigation bars while a book is open in the ReadEra-style reader. */
function fullScreen(on) {
  try { window.HarmonariumScreen?.setImmersive(!!on && readera.readerOn()); } catch { /* not on Android */ }
}

/** Keep the screen on while a book is open (Settings → Text → Keep screen on). */
async function awake(on) {
  try {
    if (on && settings.get().keepAwake && "wakeLock" in navigator && document.visibilityState === "visible") {
      if (!wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener?.("release", () => { wakeLock = null; }); }
    } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}

/** Alignment and hyphenation: "auto" justifies in the ReadEra look and keeps the publisher's otherwise. */
function alignCss() {
  const { textAlign = "auto", hyphens = true } = settings.get();
  const justify = textAlign === "justify" || (textAlign === "auto" && readera.readerOn());
  const rules = [];
  if (justify) rules.push("p { text-align: justify !important; }");
  else if (textAlign === "left") rules.push("p, div, li, blockquote { text-align: left !important; }");
  if (hyphens && (justify || textAlign === "left")) rules.push("p { -webkit-hyphens: auto; hyphens: auto; }");
  if (!hyphens) rules.push("p, div, span, li { -webkit-hyphens: manual !important; hyphens: manual !important; }");
  return rules.join("\n");
}

/** Fonts we ship (they work offline). Comfortaa: SIL Open Font License, see public/fonts/. */
const FONT_FACES = () => {
  const url = (f) => new URL(`fonts/${f}`, document.baseURI).href;
  return `@font-face { font-family: "Comfortaa"; src: url("${url("Comfortaa.ttf")}") format("truetype"); font-weight: 300 700; font-display: swap; }`;
};

/** The stylesheet foliate-js puts into every chapter: theme, text size, font, spacing, alignment. */
function bookCss() {
  const s = settings.get();
  const t = THEMES[s.theme] || THEMES.light;
  const { fontFamily, lineHeight, embeddedFonts } = s;
  const rules = [];
  // With Embedded on, the chosen font is woven into the book's own styles instead (weaveFonts),
  // so the book's built-in fonts keep their places; here it only sets the page's default.
  if (fontFamily && embeddedFonts === false) rules.push(`font-family: ${fontFamily} !important;`);
  if (lineHeight) rules.push(`line-height: ${lineHeight} !important;`);
  return [
    FONT_FACES(),
    `html { color-scheme: ${NIGHT.has(s.theme) ? "dark" : "light"}; }`,
    `html, body { background: ${t.bg} !important; color: ${t.fg} !important; }`,
    `body { font-size: ${s.fontSize}% !important; }`,
    `a, a:link, a:visited { color: ${t.link} !important; }`,
    `::selection { background: rgba(66, 133, 244, 0.35); }`,
    `img, svg, video { max-width: 100%; }`,
    fontFamily && embeddedFonts !== false ? `body { font-family: ${fontFamily} !important; }` : "",
    rules.length ? `body, p, div, span, li, blockquote, td, h1, h2, h3, h4, h5, h6 { ${rules.join(" ")} }` : "",
    alignCss(),
  ].filter(Boolean).join("\n");
}

function applyStyles() {
  if (!view?.renderer || pdf) return;
  view.renderer.setStyles?.(bookCss());
}

const famName = (v) => String(v || "").trim().replace(/^["']|["']$/g, "").toLowerCase();

/**
 * ReadEra's "Embedded" setting, applied to a chapter as it loads.
 *   Off: the book's built-in fonts (@font-face) are taken out, so its text falls back to your font.
 *   On:  they stay wherever the book uses them, and your chosen font replaces every other font
 *        the book names (so "serif", "Georgia"… become your font, its own typefaces don't).
 */
function weaveFonts(doc) {
  const { fontFamily, embeddedFonts } = settings.get();
  // foliate-js puts its own two <style> elements (ours, via setStyles) last in <head>.
  const sheets = [...doc.styleSheets].filter((s) => !s.ownerNode?.textContent?.includes("color-scheme:"));
  const rulesOf = (s) => { try { return s.cssRules ? [...s.cssRules] : []; } catch { return []; } };
  const walk = (list, fn) => { for (const r of list) { fn(r); if (r.cssRules) walk([...r.cssRules], fn); } };
  if (embeddedFonts === false) {
    for (const s of sheets) {
      for (let i = rulesOf(s).length - 1; i >= 0; i--) {
        try { if (s.cssRules[i].type === CSSRule.FONT_FACE_RULE) s.deleteRule(i); } catch { /* leave it */ }
      }
    }
    return;
  }
  if (!fontFamily) return; // "Publisher": the book exactly as made
  const embedded = new Set();
  for (const s of sheets) walk(rulesOf(s), (r) => { if (r.type === CSSRule.FONT_FACE_RULE) embedded.add(famName(r.style.getPropertyValue("font-family"))); });
  const ownFont = (value) => String(value).split(",").some((f) => embedded.has(famName(f)));
  for (const s of sheets) {
    walk(rulesOf(s), (r) => {
      const v = r.style?.getPropertyValue?.("font-family");
      if (v && !ownFont(v)) r.style.setProperty("font-family", fontFamily, "important");
    });
  }
  for (const el of doc.querySelectorAll("[style*='font-family']")) {
    if (!ownFont(el.style.fontFamily)) el.style.setProperty("font-family", fontFamily, "important");
  }
}

/** Open the book again where you are (after a font change, which rewrites the book's own styles). */
async function rebuild() {
  if (!view || !meta) return;
  const at = anchorCfi || current?.cfi;
  const buf = await db.get("files", meta.id);
  if (!buf) return;
  try { view.close(); } catch { /* ignore */ }
  view.remove();
  view = null;
  loc = null;
  await mountView(buf);
  // The text is laid out anew, so the page holding your place starts a little earlier: keep the
  // exact place until you turn a page, or each font change would move you back a bit.
  anchorCfi = at;
  anchored = !pdf && !scrolled() && !!at;
  await showAt(at);
}

export function syncPanelState() {
  const s = settings.get();
  $("font-size-label").textContent = `${s.fontSize}%`;
  $("font-family").value = s.fontFamily;
  $("embedded-fonts").checked = s.embeddedFonts !== false;
  $("line-height").value = s.lineHeight;
  $("page-turn").value = turnMode();
  $("flow").value = s.flow || "paginated";
  $("text-align").value = s.textAlign || "auto";
  $("margins").value = s.margin || "m";
  $("hyphens").checked = s.hyphens !== false;
  $("keep-awake").checked = !!s.keepAwake;
  $("brightness").value = String(Math.round((s.brightness ?? 1) * 100));
  $("re-bright").value = $("brightness").value;
  $("page-turn-row").hidden = s.flow === "scrolled";
  $("zoom-label").textContent = `${Math.round(pdfZoom * 100)}%`;
  applyBrightness(s.brightness ?? 1);
}

// ---------------------------------------------------------------- close

export async function closeBook() {
  const moved = current && current.cfi !== lastSavedCfi && (!holdSaves || current.cfi !== initialCfi);
  if (moved) await saveProgress();
  sync.flushNow();
  marks.unload();
  finder.unload();
  if (sheet.isOpen()) sheet.close(null);
  try { view?.close(); } catch { /* ignore */ }
  try { view?.book?.destroy?.(); } catch { /* ignore */ }
  view?.remove();
  view = null;
  meta = current = loc = null;
  pdf = false;
  anchorCfi = null; anchored = false;
  awake(false);
  chapterPages = null;
  fullScreen(false);
  hideBanner();
  document.body.classList.remove("immersive", "pdf-mode", "flow-scroll", "foliate");
  $("viewer").innerHTML = "";
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
  $("foot-page").textContent = "";
  hooks.close();
}
