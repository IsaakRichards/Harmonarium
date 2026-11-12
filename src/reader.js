import ePub from "epubjs";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { escapeHtml, pct, timeAgo, toast } from "./util.js";
import * as pageturn from "./pageturn.js";
import * as readera from "./readera.js";
import * as pdfengine from "./pdfengine.js";
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

let book = null;      // epub.js Book
let rendition = null; // epub.js Rendition
let pdfDoc = null;    // pdf.js document
let pdfView = null;   // pdfengine view
let meta = null;      // our stored book record
let toc = [];         // flattened table of contents: { label, href | page, depth }
let current = null;   // { cfi, percent, chapter }
let lastSavedCfi = null;
let holdSaves = false; // true while we check the sheet on open
let initialCfi = null; // where the book first landed, so merely opening never counts as reading
// The page you're reading, as you reached it. Re-laying the book out (opening it, the phone's bars
// hiding, rotating, a font or picture loading late, changing the text size) re-flows the pages, and
// epub.js then reports the start of whichever page now holds your place, which begins a little
// earlier. Saving that and reopening drifted you back a bit more each time. So until you turn a
// page yourself, the anchor stays put: it's what gets saved, and the book is kept showing it.
let anchorCfi = null;
let anchored = false;  // true while the page shown is the result of a re-layout, not of your turning
let anchorTimer = 0;
const cfiCmp = (() => { const c = new ePub.CFI(); return (a, b) => { try { return c.compare(a, b); } catch { return 0; } }; })();
let pendingRemote = null;
let hooks = { close: () => {}, onFinished: () => {}, onKey: () => {}, onBookChanged: () => {} };
let finishOffered = false;
let turner = null;     // page-turn animator (pageturn.js)
let tocIndex = -1;     // the contents entry for the current page
let wakeLock = null;
let chapterPages = null; // { page, total } within the current chapter

const NIGHT = new Set(["dark", "black"]);
const isPdf = () => !!pdfView;
const scrolled = () => settings.get().flow === "scrolled";

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
  window.addEventListener("harmonarium:readera", () => { nameSwatches(); applyUserStyle(); relayout(); });
  for (const b of document.querySelectorAll("[data-dismiss]")) {
    b.addEventListener("click", () => $(b.dataset.dismiss).classList.add("hidden"));
  }
  // Navigation panel tabs: Contents, Bookmarks, Quotes, Notes.
  for (const t of document.querySelectorAll("[data-nav]")) t.addEventListener("click", () => navTab(t.dataset.nav));

  // Edge tap zones: tap to turn; on touch they also let you drag the page from the edge.
  for (const [id, dir] of [["tap-prev", -1], ["tap-next", 1]]) {
    const z = $(id);
    z.addEventListener("click", () => { marks.hideSelection(); turn(dir); });
    z.addEventListener("touchstart", (e) => turner?.touch.start(e), { passive: true });
    z.addEventListener("touchmove", (e) => turner?.touch.move(e), { passive: true });
    z.addEventListener("touchend", (e) => turner?.touch.end(e), { passive: true });
    z.addEventListener("touchcancel", () => turner?.touch.cancel(), { passive: true });
  }
  // Mouse wheel / trackpad on desktop turns pages too.
  $("viewer-wrap").addEventListener("wheel", onWheel, { passive: true });
  $("page-turn").addEventListener("change", async (e) => {
    await settings.update({ pageTurn: e.target.value });
    if (rendition) await rebuild();
  });
  $("flow").addEventListener("change", async (e) => {
    await settings.update({ flow: e.target.value });
    syncPanelState();
    if (rendition) await rebuild();
  });

  $("font-dec").addEventListener("click", () => setFontSize(settings.get().fontSize - 10));
  $("font-inc").addEventListener("click", () => setFontSize(settings.get().fontSize + 10));
  $("zoom-dec").addEventListener("click", () => setZoom(pdfView ? pdfView.zoom / 1.2 : 1));
  $("zoom-inc").addEventListener("click", () => setZoom(pdfView ? pdfView.zoom * 1.2 : 1));
  $("zoom-fit").addEventListener("click", () => setZoom(1));
  for (const sw of document.querySelectorAll(".swatch")) {
    sw.addEventListener("click", () => setTheme(sw.dataset.theme));
  }
  for (const [id, key] of [["font-family", "fontFamily"], ["line-height", "lineHeight"], ["text-align", "textAlign"], ["margins", "margin"]]) {
    $(id).addEventListener("change", async (e) => {
      await settings.update({ [key]: e.target.value });
      applyUserStyle();
      if (key === "margin") relayout();
    });
  }
  $("hyphens").addEventListener("change", async (e) => { await settings.update({ hyphens: e.target.checked }); applyUserStyle(); });
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
  slider.addEventListener("change", () => {
    finder.noteJump();
    const f = slider.value / 1000;
    if (pdfView) pdfView.goToPercent(f);
    else if (book?.locations?.length()) display(book.locations.cfiFromPercentage(f));
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
      const st = document.getElementById("view-reader").style;
      st.setProperty("--re-bar-h", `${$("reader-bar").offsetHeight}px`);
      st.setProperty("--re-foot-h", `${$("reader-foot").offsetHeight}px`);
    });
    ro.observe($("reader-bar"));
    ro.observe($("reader-foot"));
  }
  marks.init();
  finder.init();

  // Keys are handled by dpad.js (see api() below).
  // Re-paginate on rotation / window resize.
  window.addEventListener("resize", relayout);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { awake(!!meta); fullScreen(!!meta); return; }
    // Leaving the app (home button, switching apps): save the exact page now, as Android may close us.
    if (meta && !holdSaves) { syncLocation(); if (current && current.cfi !== lastSavedCfi) saveProgress(); }
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
function turn(dir) {
  if (pdfView) return pdfView.turn(dir);
  if (!rendition) return;
  userMoved();
  // Whatever the animation, check where we landed once it's done (see syncLocation).
  clearTimeout(turnCheck);
  turnCheck = setTimeout(syncLocation, 700);
  if (turner) return turner.turn(dir);
  return dir > 0 ? rendition.next() : rendition.prev();
}

let turnCheck = 0;

/** You moved (a turn, a drag, a jump): your new page becomes the anchor. */
function userMoved() { anchored = false; clearTimeout(anchorTimer); }

/** The pages are about to be laid out again: hold on to the page you were reading. */
function holdAnchor() { if (anchorCfi && !pdfView && !scrolled()) anchored = true; }

/** After a re-layout, make sure the anchored page is still the one on screen; if not, go back to it. */
function checkAnchor(delay = 60, recount = true) {
  clearTimeout(anchorTimer);
  anchorTimer = setTimeout(() => {
    if (!anchorCfi || !rendition || pdfView || turner?.busy()) return;
    try {
      const loc = rendition.currentLocation();
      const s = loc?.start?.cfi, e = loc?.end?.cfi;
      if (!s || !e) return;
      if (anchored && (cfiCmp(anchorCfi, s) < 0 || cfiCmp(anchorCfi, e) > 0)) rendition.display(anchorCfi);
      // Still on the right page, but the chapter may now have more or fewer pages: recount.
      else if (recount) onRelocated(loc);
    } catch { /* busy; the next layout check will try again */ }
  }, delay);
}
/** Ask epub.js where the page is right now and take that as the current place, in case a
 *  turn went unreported. Runs after turns, before leaving the book and when the app is hidden. */
function syncLocation() {
  if (pdfView || !rendition || !book || turner?.busy()) return;
  try {
    const loc = rendition.currentLocation();
    if (loc?.start?.cfi && loc.start.cfi !== current?.cfi) onRelocated(loc);
  } catch { /* the rendition is busy or gone */ }
}

let wheelAt = 0;
function onWheel(e) {
  if (pdfView || scrolled()) return; // those scroll natively
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
  textSize: (step) => (pdfView ? setZoom(pdfView.zoom * (step > 0 ? 1.2 : 1 / 1.2)) : setFontSize(settings.get().fontSize + step * 10)),
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
  $("viewer").innerHTML = "";
  $("progress-slider").disabled = true;
  document.body.dataset.rtheme = settings.get().theme;

  const pdf = meta.format === "pdf" || pdfengine.isPdf("", "", buf);
  document.body.classList.toggle("pdf-mode", pdf);
  document.body.classList.toggle("flow-scroll", !pdf && scrolled());
  syncPanelState();

  if (pdf) {
    pdfDoc = await pdfengine.load(buf);
    toc = await pdfengine.outline(pdfDoc);
    renderToc();
    pdfView = pdfengine.view($("viewer"), pdfDoc, {
      onMove: onPdfMove,
      onTap: (zone) => {
        marks.hideSelection();
        if (zone === "middle") toggleBars();
        else { if (!document.body.classList.contains("immersive") && readera.readerOn()) closeOverlays(); turn(zone === "next" ? 1 : -1); }
      },
    });
    loadAnnotations();
    await pdfView.start(local?.cfi);
    $("progress-slider").disabled = false;
    if (!meta.pages) meta = { ...meta, pages: pdfDoc.numPages };
  } else {
    book = ePub(buf);
    await book.ready;
    const nav = await book.loaded.navigation;
    toc = flattenToc(nav.toc);
    renderToc();

    makeRendition();
    loadAnnotations();

    // Cached location index → accurate percentages immediately.
    let savedLocations = await db.get("locations", id);
    if (savedLocations) { book.locations.load(savedLocations); renderToc(); }

    // A place imported from ReadEra is a fraction of the book: turn it into an exact spot, once.
    let startAt = local?.cfi || null;
    if (!startAt && local?.fromReadEra != null) {
      try {
        if (!savedLocations) {
          toast("Finding your place from ReadEra…");
          await book.locations.generate(1600);
          savedLocations = book.locations.save();
          await db.put("locations", savedLocations, id);
          renderToc();
        }
        startAt = book.locations.cfiFromPercentage(local.fromReadEra);
        // The page index gives a span of text; keep its first spot, like every other saved place.
        const c = new ePub.CFI(startAt);
        if (c.range) { c.collapse(true); startAt = c.toString(); }
        const entry = { ...local, cfi: startAt };
        delete entry.fromReadEra;
        await db.put("progress", entry);
        lastSavedCfi = startAt;
        sync.queue(meta, entry);
      } catch (err) { console.warn("ReadEra place", err); }
    }

    anchorCfi = startAt;
    anchored = !!anchorCfi && !scrolled();
    await rendition.display(startAt || undefined);
    tuneManager();

    if (!savedLocations) {
      book.locations.generate(1600).then(async () => {
        if (!book) return;
        await db.put("locations", book.locations.save(), id);
        enableSlider();
        renderToc(); // now with page numbers
        if (current) updateFooter();
      }).catch(() => {});
    } else {
      enableSlider();
    }
  }

  await db.put("books", { ...meta, lastOpenedAt: Date.now() });
  awake(true);
  fullScreen(true);
  checkRemote(local); // runs in the background, then releases holdSaves
  return true;
}

/** What marks.js and finder.js need to know about the open book. */
function loadAnnotations() {
  const ctx = {
    bookId: meta.id,
    isPdf: !!pdfView,
    book,
    pdfDoc,
    rendition: () => rendition,
    current: () => current,
    display,
    jump: (at) => { finder.go(at); if (window.innerWidth < 700) $("toc-drawer").classList.add("hidden"); },
    chapterFor,
    night: () => NIGHT.has(settings.get().theme),
    find: (q) => { closeOverlays(); finder.open(q); },
    pdfSnippet: (n) => pdfengine.pageSnippet(pdfDoc, n),
    pageOf: (at) => {
      if (pdfView) return pdfengine.parsePos(at)?.page || 0;
      try { return book?.locations?.length() ? book.locations.locationFromCfi(at) + 1 : 0; } catch { return 0; }
    },
    pages: () => (pdfView ? pdfView.pages : book?.locations?.length() || 0),
    pageNow: () => (pdfView ? pdfView.position().page : current && book?.locations?.length() ? book.locations.locationFromCfi(current.cfi) + 1 : 0),
    goToPage: (n) => (pdfView ? pdfView.goTo(n) : display(book.locations.cfiFromLocation(n - 1))),
    goToPercent: (f) => (pdfView ? pdfView.goToPercent(f) : book?.locations?.length() ? display(book.locations.cfiFromPercentage(f)) : display(book.spine.get(Math.floor(f * (book.spine.length - 1)))?.href)),
  };
  marks.load(ctx);
  finder.load(ctx);
}

/** Go to a stored position (an EPUB CFI or href, or a PDF "pdf:…" position). */
function display(at) {
  if (!at) return;
  userMoved();
  if (pdfView) return pdfView.display(at);
  return rendition?.display(at);
}

/** Go to a reading place from another device. Its screen or text size may differ, so the page
 *  here that holds that place starts a little earlier; saving that start would send this device's
 *  earlier place back, and the two would walk each other backwards. So the exact place is kept as
 *  the anchor (saved and synced unchanged) until you turn a page here. */
function goToPlace(at) {
  if (!at) return;
  if (pdfView) return pdfView.display(at);
  anchorCfi = at;
  anchored = !scrolled();
  return rendition?.display(at);
}

function toggleBars() {
  document.body.classList.toggle("immersive");
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
}

/** The side margins: ReadEra's slim default, scaled by the Margins setting. */
function pageGap() {
  const w = $("viewer")?.clientWidth || window.innerWidth;
  const f = MARGIN[settings.get().margin] || 1;
  return 2 * Math.round(Math.min(48, Math.max(14, w * 0.05)) * f);
}
const wantGap = () => (readera.readerOn() || (settings.get().margin && settings.get().margin !== "m") ? pageGap() : undefined);

/** Recalculate margins and re-paginate, e.g. after rotating the phone. */
function relayout() {
  if (pdfView) { pdfView.resize(); return; }
  if (!rendition) return;
  const gap = wantGap();
  rendition.settings.gap = gap;
  if (rendition.manager?.settings) rendition.manager.settings.gap = gap;
  holdAnchor();
  rendition.resize(undefined, undefined, anchorCfi || undefined);
  checkAnchor(400);
}

/** Create the rendition for the current page-turn mode (slide needs epub.js's continuous manager). */
function makeRendition() {
  const flow = scrolled() ? "scrolled" : "paginated";
  let mode = pageturn.MODES.includes(settings.get().pageTurn) ? settings.get().pageTurn : "slide";
  if (flow === "scrolled") mode = "none";
  const gap = wantGap();
  rendition = book.renderTo("viewer", {
    manager: flow === "scrolled" ? "continuous" : pageturn.managerFor(mode),
    width: "100%",
    height: "100%",
    flow,
    spread: flow === "scrolled" ? "none" : "auto",
    minSpreadWidth: 900,
    ...(gap ? { gap } : {}),
  });
  for (const [name, t] of Object.entries(THEMES)) {
    rendition.themes.register(name, {
      body: { background: `${t.bg} !important`, color: `${t.fg} !important` },
      "a, a:link, a:visited": { color: `${t.link} !important` },
      "::selection": { background: "rgba(66, 133, 244, 0.35)" },
    });
  }
  rendition.themes.select(settings.get().theme);
  rendition.themes.fontSize(`${settings.get().fontSize}%`);
  rendition.hooks.content.register((contents) => {
    injectUserStyle(contents);
    guardLinks(contents);
    contents.document.addEventListener("wheel", onWheel, { passive: true });
    contents.document.addEventListener("selectionchange", () => marks.onSelectionChange(contents.document));
    // Android's back swipe takes the touch away mid-drag: put the page back.
    contents.document.addEventListener("touchcancel", () => turner?.touch.cancel(), { passive: true });
    // Fonts and pictures that arrive late re-flow the chapter: keep the anchored page on screen.
    contents.document.fonts?.ready?.then(() => checkAnchor(80)).catch(() => {});
    for (const img of contents.document.images || []) if (!img.complete) img.addEventListener("load", () => checkAnchor(120), { once: true });
    contents.on?.("resize", () => checkAnchor(120));
  });
  wireGestures(mode);
  rendition.on("relocated", onRelocated);
  rendition.on("selected", (cfiRange, contents) => marks.onSelected(cfiRange, contents));
  turner = pageturn.attach(rendition, mode, $("viewer"), { onUserMove: userMoved });
}

/** Slide mode: load the next chapter a couple of pages early so sliding into it stays smooth. */
function tuneManager() {
  const m = rendition?.manager;
  if (m && m.layout && turner?.mode === "slide") m.settings.offset = Math.max(500, m.layout.width * 2);
}

/** Switch page-turn mode or flow on an open book, keeping the reader's place. */
async function rebuild() {
  if (!book) return;
  const cfi = anchorCfi || current?.cfi;
  holdAnchor();
  turner?.destroy(); turner = null;
  try { rendition.destroy(); } catch { /* ignore */ }
  $("viewer").innerHTML = "";
  document.body.classList.toggle("flow-scroll", scrolled());
  makeRendition();
  await rendition.display(cfi || undefined);
  tuneManager();
  marks.applyHighlights();
}

function enableSlider() {
  $("progress-slider").disabled = !pdfView && !book?.locations?.length();
}

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

// ------------------------------------------------------------- progress

function onRelocated(loc) {
  const cfi = loc.start.cfi;
  let percent;
  if (book.locations.length()) percent = book.locations.percentageFromCfi(cfi);
  else percent = book.spine.length ? loc.start.index / book.spine.length : 0;
  const hit = tocEntryFor(loc.start.href);
  tocIndex = hit ? toc.indexOf(hit) : -1;
  chapterPages = chapterPage(loc);
  moved(cfi, percent, hit?.label || "", loc.atEnd || (book.locations.length() && percent >= 0.995));
  marks.onRelocated(loc);
  if (anchored) checkAnchor(60, false); // (no recount from here, or it would never stop)
}

/** Pages within this chapter (its spine file). epub.js rounds the page down, and on phones whose
 *  screens aren't a whole number of pixels wide a settled page sits a hair short of its edge, so
 *  the count could repeat; work it out from where the page actually is instead. */
function chapterPage(loc) {
  const d = loc.start.displayed || {};
  if (!(d.total > 0) || scrolled()) return null;
  try {
    const m = rendition.manager;
    const view = m.views.all().find((v) => v.section?.index === loc.start.index);
    const pw = m.layout?.pageWidth;
    if (view && pw > 0) {
      const into = m.container.getBoundingClientRect().left - view.position().left;
      return { page: Math.min(d.total, Math.max(1, Math.round(into / pw) + 1)), total: d.total };
    }
  } catch { /* fall back to epub.js's count */ }
  return { page: Math.min(d.page, d.total), total: d.total };
}

function onPdfMove({ page, frac, percent, atEnd }) {
  const hit = pdfTocFor(page);
  tocIndex = hit ? toc.indexOf(hit) : -1;
  // This chapter runs from its outline entry to the page before the next one.
  const start = hit ? hit.page : 1;
  const next = toc.filter((t) => t.page > start).reduce((m, t) => Math.min(m, t.page), (pdfView?.pages || page) + 1);
  chapterPages = { page: page - start + 1, total: Math.max(1, next - start) };
  moved(pdfengine.pos(page, frac), percent, hit?.label || "", atEnd);
  marks.onRelocated({ page });
  $("foot-page").textContent = `${page} / ${pdfView?.pages || ""}`;
}

/** Shared by both engines: the reader is now at `cfi`. */
function moved(cfi, percent, chapter, atEnd) {
  // A re-layout doesn't move your place: keep the anchor as the place to save (it's on screen).
  if (anchored && anchorCfi && !pdfView) cfi = anchorCfi;
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
  if (!pdfView && book?.locations?.length() && current) {
    current.percent = book.locations.percentageFromCfi(current.cfi);
    $("foot-page").textContent = `${book.locations.locationFromCfi(current.cfi) + 1} / ${book.locations.length()}`;
  } else if (!pdfView) $("foot-page").textContent = "";
  $("foot-chapter").textContent = current?.chapter || "";
  // ReadEra-style reader: "Chapter 11 • page 14/15" up top, "227 of 1918" down below.
  const cp = chapterPages ? `page ${chapterPages.page}/${chapterPages.total}` : "";
  $("re-where").textContent = [current?.chapter, cp].filter(Boolean).join(" • ");
  const total = pdfView ? pdfView.pages : book?.locations?.length() || 0;
  const now = pdfView ? pdfView.position().page : total && current ? book.locations.locationFromCfi(current.cfi) + 1 : 0;
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
    out.push({ label: (it.label || "").trim(), href: it.href, depth });
    flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

/** The contents entry for a spine file (the first one pointing into it). */
function tocEntryFor(href) {
  if (!href) return null;
  const base = href.split("#")[0];
  return toc.find((t) => {
    const h = (t.href || "").split("#")[0];
    return h && (h === base || base.endsWith(h) || h.endsWith(base));
  }) || null;
}
/** PDFs: the last outline entry that starts on or before the page. */
function pdfTocFor(page) {
  let hit = null;
  for (const t of toc) if (t.page <= page && (!hit || t.page >= hit.page)) hit = t;
  return hit;
}
/** The chapter title for a CFI, an href or (PDF) a page number. */
function chapterFor(where) {
  if (pdfView) return pdfTocFor(typeof where === "number" ? where : pdfengine.parsePos(where)?.page || 0)?.label || "";
  try {
    const s = String(where || "");
    const sec = s.startsWith("epubcfi(") ? book.spine.get(s) : null;
    return tocEntryFor(sec ? sec.href : s)?.label || "";
  } catch { return ""; }
}

/** The page each contents entry starts on: PDFs know it; EPUBs, once the location index exists. */
function tocPageNo(t) {
  if (t.page) return t.page;
  const locs = book?.locations?.length() ? book.locations._locations || [] : [];
  if (!locs.length || !t.href) return "";
  const sec = book.spine.get(t.href.split("#")[0]);
  if (!sec?.cfiBase) return "";
  const i = locs.findIndex((c) => c.startsWith(`epubcfi(${sec.cfiBase}!`));
  return i >= 0 ? i + 1 : "";
}

function renderToc() {
  const list = $("toc-list");
  list.innerHTML = toc.length
    ? toc.map((t, i) => {
        const n = tocPageNo(t);
        return `<a href="#" data-i="${i}" style="padding-left:${14 + t.depth * 16}px"><span>${escapeHtml(t.label)}</span>${n ? `<small>${n}</small>` : ""}</a>`;
      }
      ).join("")
    : `<p class="hint">This book has no table of contents.</p>`;
  for (const a of list.querySelectorAll("a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = toc[Number(a.dataset.i)];
      finder.go(t.page ? pdfengine.pos(t.page) : t.href);
      $("toc-drawer").classList.add("hidden");
    });
  }
}

// ---------------------------------------------------------- appearance

async function setFontSize(v) {
  const size = Math.min(250, Math.max(60, v));
  await settings.update({ fontSize: size });
  $("font-size-label").textContent = `${size}%`;
  holdAnchor();
  rendition?.themes.fontSize(`${size}%`);
  checkAnchor(300);
}

function setZoom(z) {
  if (!pdfView) return;
  const now = pdfView.setZoom(z);
  $("zoom-label").textContent = `${Math.round(now * 100)}%`;
}

async function setTheme(name) {
  const wasNight = NIGHT.has(settings.get().theme);
  await settings.update({ theme: name, [NIGHT.has(name) ? "nightTheme" : "dayTheme"]: name });
  document.body.dataset.rtheme = name;
  rendition?.themes.select(name);
  if (wasNight !== NIGHT.has(name)) marks.retint();
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

/** Where each top-level chapter starts, 0–1 (exact once the location index exists). */
function chapterMarks() {
  if (!toc.length) return [];
  if (pdfView) {
    const n = Math.max(1, pdfView.pages - 1);
    const out = toc.filter((t) => t.depth === 0).map((t) => (t.page - 1) / n).filter((p) => p > 0.001 && p < 0.999);
    return out.length > 80 ? [] : [...new Set(out)];
  }
  if (!book) return [];
  const locs = book.locations?.length() ? book.locations._locations || [] : [];
  const n = book.spine?.length || 1;
  const out = [];
  for (const t of toc) {
    if (t.depth !== 0 || !t.href) continue;
    const sec = book.spine.get(t.href.split("#")[0]);
    if (!sec) continue;
    let p = sec.index / n;
    if (locs.length && sec.cfiBase) {
      const i = locs.findIndex((c) => c.startsWith(`epubcfi(${sec.cfiBase}!`));
      if (i >= 0) p = i / locs.length;
    }
    if (p > 0.001 && p < 0.999) out.push(p);
  }
  return out.length > 80 ? [] : [...new Set(out)];
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

/** ReadEra look: little top and bottom padding. */
function readeraCss() {
  if (!readera.readerOn()) return "";
  return "body { padding-top: 12px !important; padding-bottom: 4px !important; }";
}

function userCss() {
  const { fontFamily, lineHeight } = settings.get();
  const rules = [];
  if (fontFamily) rules.push(`font-family: ${fontFamily} !important;`);
  if (lineHeight) rules.push(`line-height: ${lineHeight} !important;`);
  const extra = `${readeraCss()}\n${alignCss()}`;
  if (!rules.length) return extra;
  return `body, p, div, span, li, blockquote, td { ${rules.join(" ")} }\n${extra}`;
}

/** Links to websites inside a book would turn the reader into a browser (and on phones
 *  without one, like the Commodore Callback, strand you there), so they're disabled. */
function guardLinks(contents) {
  contents.document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (a && /^(https?:|mailto:|tel:)/i.test(a.getAttribute("href"))) {
      e.preventDefault(); e.stopPropagation();
      toast("Links to websites are turned off in books");
    } else if (a) {
      finder.noteJump(); // a footnote or cross-reference: leave a way back
      userMoved();
    }
  }, true);
}

function injectUserStyle(contents) {
  const doc = contents.document;
  let el = doc.getElementById("kls-user-style");
  if (!el) {
    el = doc.createElement("style");
    el.id = "kls-user-style";
    doc.head.appendChild(el);
  }
  el.textContent = userCss();
  // Hyphenation needs a language; borrow the book's when the chapter file has none.
  const html = doc.documentElement;
  if (!html.getAttribute("lang") && !html.getAttribute("xml:lang")) {
    const lang = book?.packaging?.metadata?.language;
    if (lang) html.setAttribute("lang", lang);
  }
}

function applyUserStyle() {
  if (!rendition) return;
  holdAnchor();
  checkAnchor(300);
  for (const c of rendition.getContents()) injectUserStyle(c);
}

export function syncPanelState() {
  const s = settings.get();
  $("font-size-label").textContent = `${s.fontSize}%`;
  $("font-family").value = s.fontFamily;
  $("line-height").value = s.lineHeight;
  $("page-turn").value = s.pageTurn || "slide";
  $("flow").value = s.flow || "paginated";
  $("text-align").value = s.textAlign || "auto";
  $("margins").value = s.margin || "m";
  $("hyphens").checked = s.hyphens !== false;
  $("keep-awake").checked = !!s.keepAwake;
  $("brightness").value = String(Math.round((s.brightness ?? 1) * 100));
  $("re-bright").value = $("brightness").value;
  $("page-turn-row").hidden = s.flow === "scrolled";
  $("zoom-label").textContent = `${Math.round((pdfView?.zoom || 1) * 100)}%`;
  applyBrightness(s.brightness ?? 1);
}

// ------------------------------------------------------------ gestures

function wireGestures(mode) {
  // In slide mode the page follows the finger (pageturn.js); otherwise a swipe turns the page.
  if (mode !== "slide" && !scrolled()) {
    let startX = 0, startY = 0, startT = 0;
    rendition.on("touchstart", (e) => {
      const t = e.changedTouches[0];
      startX = t.screenX; startY = t.screenY; startT = Date.now();
    });
    rendition.on("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.screenX - startX, dy = t.screenY - startY;
      if (Date.now() - startT < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        turn(dx < 0 ? 1 : -1);
      }
    });
  }
  rendition.on("click", (e) => {
    // Center tap toggles the bars; ignore taps on links or while selecting text.
    if (e.target?.closest?.("a")) return;
    const sel = e.view?.getSelection?.();
    if (sel && String(sel).length) return;
    if (marks.selectionOpen()) { marks.hideSelection(); return; }
    // Scroll mode has no tap zones over the page (they'd block scrolling): the frame decides.
    if (scrolled()) {
      const fr = e.view?.frameElement?.getBoundingClientRect?.();
      const x = (fr ? fr.left : 0) + e.clientX;
      const w = $("viewer-wrap").clientWidth || window.innerWidth;
      if (x < w * 0.3) return turn(-1);
      if (x > w * 0.7) return turn(1);
    }
    toggleBars();
  });
  // Keys pressed while the book's frame has focus.
  rendition.on("keydown", (e) => hooks.onKey(e));
}

// ---------------------------------------------------------------- close

export async function closeBook() {
  clearTimeout(turnCheck);
  clearTimeout(anchorTimer);
  turner?.finish(); // land a sliding page, or put back a half-dragged one (the back swipe)
  syncLocation(); // the page actually on screen, not merely the last one reported
  const moved = current && current.cfi !== lastSavedCfi && (!holdSaves || current.cfi !== initialCfi);
  if (moved) await saveProgress();
  sync.flushNow();
  marks.unload();
  finder.unload();
  if (sheet.isOpen()) sheet.close(null);
  turner?.destroy(); turner = null;
  try { rendition?.destroy(); } catch { /* ignore */ }
  try { book?.destroy(); } catch { /* ignore */ }
  try { pdfView?.destroy(); } catch { /* ignore */ }
  pdfengine.close(pdfDoc);
  book = rendition = meta = current = pdfDoc = pdfView = null;
  anchorCfi = null; anchored = false;
  awake(false);
  chapterPages = null;
  fullScreen(false);
  hideBanner();
  document.body.classList.remove("immersive", "pdf-mode", "flow-scroll");
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
  $("foot-page").textContent = "";
  hooks.close();
}
