import ePub from "epubjs";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { escapeHtml, pct, timeAgo, toast } from "./util.js";
import * as pageturn from "./pageturn.js";
import * as readera from "./readera.js";

const THEMES = {
  light: { bg: "#fbfaf7", fg: "#1d1b18", link: "#3b5bdb" },
  sepia: { bg: "#f4ecd8", fg: "#4a3b28", link: "#8a4b14" },
  dark: { bg: "#23232b", fg: "#d9d6cf", link: "#9db4ff" },
  black: { bg: "#000000", fg: "#bdbab3", link: "#9db4ff" },
};

let book = null;      // epub.js Book
let rendition = null; // epub.js Rendition
let meta = null;      // our stored book record
let toc = [];         // flattened table of contents
let current = null;   // { cfi, percent, chapter }
let lastSavedCfi = null;
let holdSaves = false; // true while we check the sheet on open
let initialCfi = null; // where the book first landed, so merely opening never counts as reading
let pendingRemote = null;
let hooks = { close: () => {}, onFinished: () => {}, onKey: () => {} };
let finishOffered = false;
let turner = null;     // page-turn animator (pageturn.js)
let tocIndex = -1;     // the contents entry for the current page

const NIGHT = new Set(["dark", "black"]);
/** Theme names; the ReadEra look uses ReadEra's own (Day, Sepia, Night, Console). */
function themeName(t) {
  const names = readera.on()
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
  // ReadEra look: the same tools, along the bottom bar.
  $("re-toc").addEventListener("click", () => toggle("toc-drawer"));
  $("re-aa").addEventListener("click", () => toggle("aa-panel"));
  $("re-daynight").addEventListener("click", () => dayNight());
  nameSwatches();
  window.addEventListener("harmonarium:readera", () => { nameSwatches(); applyUserStyle(); relayout(); });
  for (const b of document.querySelectorAll("[data-dismiss]")) {
    b.addEventListener("click", () => $(b.dataset.dismiss).classList.add("hidden"));
  }
  // Edge tap zones: tap to turn; on touch they also let you drag the page from the edge.
  for (const [id, dir] of [["tap-prev", -1], ["tap-next", 1]]) {
    const z = $(id);
    z.addEventListener("click", () => turn(dir));
    z.addEventListener("touchstart", (e) => turner?.touch.start(e), { passive: true });
    z.addEventListener("touchmove", (e) => turner?.touch.move(e), { passive: true });
    z.addEventListener("touchend", (e) => turner?.touch.end(e), { passive: true });
  }
  // Mouse wheel / trackpad on desktop turns pages too.
  $("viewer-wrap").addEventListener("wheel", onWheel, { passive: true });
  $("page-turn").addEventListener("change", async (e) => {
    await settings.update({ pageTurn: e.target.value });
    if (rendition) await rebuild();
  });

  $("font-dec").addEventListener("click", () => setFontSize(settings.get().fontSize - 10));
  $("font-inc").addEventListener("click", () => setFontSize(settings.get().fontSize + 10));
  for (const sw of document.querySelectorAll(".swatch")) {
    sw.addEventListener("click", () => setTheme(sw.dataset.theme));
  }
  $("font-family").addEventListener("change", async (e) => {
    await settings.update({ fontFamily: e.target.value });
    applyUserStyle();
  });
  $("line-height").addEventListener("change", async (e) => {
    await settings.update({ lineHeight: e.target.value });
    applyUserStyle();
  });

  const slider = $("progress-slider");
  slider.addEventListener("change", () => {
    if (!book?.locations?.length()) return;
    rendition.display(book.locations.cfiFromPercentage(slider.value / 1000));
  });

  $("sync-jump").addEventListener("click", () => {
    if (pendingRemote) rendition.display(pendingRemote.cfi);
    hideBanner();
  });
  $("sync-stay").addEventListener("click", async () => {
    if (pendingRemote) await db.put("kv", Number(pendingRemote.updated_at), `dismissed:${meta.id}`);
    hideBanner();
  });

  // Keys are handled by dpad.js (see api() below).
  // Re-paginate on rotation / window resize.
  window.addEventListener("resize", relayout);
}

function toggle(id) {
  for (const other of ["toc-drawer", "aa-panel"]) if (other !== id) $(other).classList.add("hidden");
  $(id).classList.toggle("hidden");
  if (id === "toc-drawer" && !$(id).classList.contains("hidden")) {
    $("toc-list").querySelector("a.current")?.scrollIntoView({ block: "center" });
  }
}

/** Day ↔ Night, remembering which day and night themes were last used. */
async function dayNight() {
  const s = settings.get();
  await setTheme(NIGHT.has(s.theme) ? s.dayTheme || "light" : s.nightTheme || "dark");
  toast(themeName(settings.get().theme));
}

/** What the d-pad navigator needs to drive the reader. */
/** Turn a page (+1 forward, -1 back) with the chosen animation. */
function turn(dir) {
  if (!rendition) return;
  if (turner) return turner.turn(dir);
  return dir > 0 ? rendition.next() : rendition.prev();
}

let wheelAt = 0;
function onWheel(e) {
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (Math.abs(d) < 4 || Date.now() - wheelAt < 350) return;
  wheelAt = Date.now();
  turn(d > 0 ? 1 : -1);
}

export const api = {
  next: () => turn(1),
  prev: () => turn(-1),
  barsVisible: () => !document.body.classList.contains("immersive"),
  showBars: () => document.body.classList.remove("immersive"),
  hideBars: () => { closeOverlays(); document.body.classList.add("immersive"); },
  overlayOpen: () => ["toc-drawer", "aa-panel", "sync-banner"].some((id) => !$(id).classList.contains("hidden")),
  closeOverlays,
  close: () => closeBook(),
  // Keypad shortcuts (see dpad.js)
  toggleContents: () => { document.body.classList.remove("immersive"); toggle("toc-drawer"); },
  toggleText: () => { document.body.classList.remove("immersive"); toggle("aa-panel"); },
  textSize: (step) => setFontSize(settings.get().fontSize + step * 10),
  cycleTheme: () => {
    const order = ["light", "sepia", "dark", "black"];
    const next = order[(order.indexOf(settings.get().theme) + 1) % order.length];
    setTheme(next);
    toast(themeName(next));
  },
};

function closeOverlays() {
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
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
  // ReadEra opens a book full-screen; a tap in the middle brings the toolbars up.
  if (readera.on()) document.body.classList.add("immersive");
  tocIndex = -1;
  $("viewer").innerHTML = "";
  $("progress-slider").disabled = true;
  document.body.dataset.rtheme = settings.get().theme;

  book = ePub(buf);
  await book.ready;
  const nav = await book.loaded.navigation;
  toc = flattenToc(nav.toc);
  renderToc();

  makeRendition();

  // Cached location index → accurate percentages immediately.
  const savedLocations = await db.get("locations", id);
  if (savedLocations) book.locations.load(savedLocations);

  await rendition.display(local?.cfi || undefined);
  tuneManager();

  if (!savedLocations) {
    book.locations.generate(1600).then(async () => {
      if (!book) return;
      await db.put("locations", book.locations.save(), id);
      enableSlider();
      if (current) updateFooter();
    }).catch(() => {});
  } else {
    enableSlider();
  }

  await db.put("books", { ...meta, lastOpenedAt: Date.now() });
  checkRemote(local); // runs in the background, then releases holdSaves
  return true;
}

/** ReadEra look: the text runs nearly to the screen's edges, with a slim margin each side. */
function pageGap() {
  const w = $("viewer")?.clientWidth || window.innerWidth;
  return 2 * Math.round(Math.min(48, Math.max(14, w * 0.05)));
}
/** Recalculate margins (ReadEra look) and re-paginate, e.g. after rotating the phone. */
function relayout() {
  if (!rendition) return;
  const gap = readera.on() ? pageGap() : undefined;
  rendition.settings.gap = gap;
  if (rendition.manager?.settings) rendition.manager.settings.gap = gap;
  rendition.resize();
}

/** Create the rendition for the current page-turn mode (slide needs epub.js's continuous manager). */
function makeRendition() {
  const mode = pageturn.MODES.includes(settings.get().pageTurn) ? settings.get().pageTurn : "slide";
  rendition = book.renderTo("viewer", {
    manager: pageturn.managerFor(mode),
    width: "100%",
    height: "100%",
    flow: "paginated",
    spread: "auto",
    minSpreadWidth: 900,
    ...(readera.on() ? { gap: pageGap() } : {}),
  });
  for (const [name, t] of Object.entries(THEMES)) {
    rendition.themes.register(name, {
      body: { background: `${t.bg} !important`, color: `${t.fg} !important` },
      "a, a:link, a:visited": { color: `${t.link} !important` },
    });
  }
  rendition.themes.select(settings.get().theme);
  rendition.themes.fontSize(`${settings.get().fontSize}%`);
  rendition.hooks.content.register((contents) => {
    injectUserStyle(contents);
    guardLinks(contents);
    contents.document.addEventListener("wheel", onWheel, { passive: true });
  });
  wireGestures(mode);
  rendition.on("relocated", onRelocated);
  turner = pageturn.attach(rendition, mode, $("viewer"));
}

/** Slide mode: load the next chapter a couple of pages early so sliding into it stays smooth. */
function tuneManager() {
  const m = rendition?.manager;
  if (m && m.layout && turner?.mode === "slide") m.settings.offset = Math.max(500, m.layout.width * 2);
}

/** Switch page-turn mode on an open book, keeping the reader's place. */
async function rebuild() {
  const cfi = current?.cfi;
  turner?.destroy(); turner = null;
  try { rendition.destroy(); } catch { /* ignore */ }
  $("viewer").innerHTML = "";
  makeRendition();
  await rendition.display(cfi || undefined);
  tuneManager();
}

function enableSlider() {
  $("progress-slider").disabled = !book?.locations?.length();
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
      await rendition.display(remote.cfi);
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
  current = { cfi, percent, chapter: hit?.label || "" };
  $("viewer").dataset.cfi = cfi; // where the reader is (handy for tests and debugging)
  if (holdSaves && initialCfi === null) initialCfi = cfi;
  if (!holdSaves && !finishOffered && (loc.atEnd || (book.locations.length() && percent >= 0.995))) {
    finishOffered = true;
    hooks.onFinished(meta.title);
  }
  updateFooter();
  if (!holdSaves && cfi !== lastSavedCfi) saveProgress();
}

function updateFooter() {
  if (book?.locations?.length() && current) {
    current.percent = book.locations.percentageFromCfi(current.cfi);
  }
  $("foot-chapter").textContent = current?.chapter || "";
  $("foot-percent").textContent = pct(current?.percent);
  $("progress-slider").value = Math.round((current?.percent || 0) * 1000);
  for (const a of $("toc-list").querySelectorAll("a")) a.classList.toggle("current", Number(a.dataset.i) === tocIndex);
  if (readera.on()) readera.track(current?.percent, chapterMarks());
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

function renderToc() {
  const list = $("toc-list");
  list.innerHTML = toc.length
    ? toc.map((t, i) =>
        `<a href="#" data-i="${i}" style="padding-left:${12 + t.depth * 16}px">${escapeHtml(t.label)}</a>`
      ).join("")
    : `<p class="hint">This book has no table of contents.</p>`;
  for (const a of list.querySelectorAll("a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      rendition.display(toc[Number(a.dataset.i)].href);
      $("toc-drawer").classList.add("hidden");
    });
  }
}

// ---------------------------------------------------------- appearance

async function setFontSize(v) {
  const size = Math.min(250, Math.max(60, v));
  await settings.update({ fontSize: size });
  $("font-size-label").textContent = `${size}%`;
  rendition?.themes.fontSize(`${size}%`);
}

async function setTheme(name) {
  await settings.update({ theme: name, [NIGHT.has(name) ? "nightTheme" : "dayTheme"]: name });
  document.body.dataset.rtheme = name;
  rendition?.themes.select(name);
}

/** Where each top-level chapter starts, 0–1 (exact once the location index exists). */
function chapterMarks() {
  if (!book || !toc.length) return [];
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

/** ReadEra look: little top and bottom padding, justified and hyphenated text. */
function readeraCss() {
  if (!readera.on()) return "";
  return `body { padding-top: 12px !important; padding-bottom: 4px !important; }
p { text-align: justify; -webkit-hyphens: auto; hyphens: auto; }`;
}

function userCss() {
  const { fontFamily, lineHeight } = settings.get();
  const rules = [];
  if (fontFamily) rules.push(`font-family: ${fontFamily} !important;`);
  if (lineHeight) rules.push(`line-height: ${lineHeight} !important;`);
  const extra = readeraCss();
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
  for (const c of rendition.getContents()) injectUserStyle(c);
}

export function syncPanelState() {
  const s = settings.get();
  $("font-size-label").textContent = `${s.fontSize}%`;
  $("font-family").value = s.fontFamily;
  $("line-height").value = s.lineHeight;
  $("page-turn").value = s.pageTurn || "slide";
}

// ------------------------------------------------------------ gestures

function wireGestures(mode) {
  // In slide mode the page follows the finger (pageturn.js); otherwise a swipe turns the page.
  if (mode !== "slide") {
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
    document.body.classList.toggle("immersive");
    $("toc-drawer").classList.add("hidden");
    $("aa-panel").classList.add("hidden");
  });
  // Keys pressed while the book's frame has focus.
  rendition.on("keydown", (e) => hooks.onKey(e));
}

// ---------------------------------------------------------------- close

export async function closeBook() {
  const moved = current && current.cfi !== lastSavedCfi && (!holdSaves || current.cfi !== initialCfi);
  if (moved) await saveProgress();
  sync.flushNow();
  turner?.destroy(); turner = null;
  try { rendition?.destroy(); } catch { /* ignore */ }
  try { book?.destroy(); } catch { /* ignore */ }
  book = rendition = meta = current = null;
  hideBanner();
  document.body.classList.remove("immersive");
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
  hooks.close();
}
