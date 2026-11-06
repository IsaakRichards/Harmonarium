import ePub from "epubjs";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { escapeHtml, pct, timeAgo, toast } from "./util.js";

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
let onClose = () => {};

const $ = (id) => document.getElementById(id);

export function init({ close }) {
  onClose = close;

  $("btn-back").addEventListener("click", () => closeBook());
  $("btn-toc").addEventListener("click", () => toggle("toc-drawer"));
  $("btn-aa").addEventListener("click", () => toggle("aa-panel"));
  for (const b of document.querySelectorAll("[data-close]")) {
    b.addEventListener("click", () => $(b.dataset.close).classList.add("hidden"));
  }
  $("tap-prev").addEventListener("click", () => rendition?.prev());
  $("tap-next").addEventListener("click", () => rendition?.next());

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

  document.addEventListener("keydown", onKey);
  // Re-paginate on rotation / window resize.
  window.addEventListener("resize", () => rendition?.resize());
}

function toggle(id) {
  for (const other of ["toc-drawer", "aa-panel"]) if (other !== id) $(other).classList.add("hidden");
  $(id).classList.toggle("hidden");
}

function onKey(e) {
  if (!rendition || $("view-reader").classList.contains("hidden")) return;
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); rendition.next(); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); rendition.prev(); }
  else if (e.key === "Escape") closeBook();
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
  hideBanner();

  $("reader-title").textContent = meta.title;
  $("viewer").innerHTML = "";
  $("progress-slider").disabled = true;
  document.body.dataset.theme = settings.get().theme;

  book = ePub(buf);
  await book.ready;
  const nav = await book.loaded.navigation;
  toc = flattenToc(nav.toc);
  renderToc();

  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    flow: "paginated",
    spread: "auto",
    minSpreadWidth: 900,
  });
  for (const [name, t] of Object.entries(THEMES)) {
    rendition.themes.register(name, {
      body: { background: `${t.bg} !important`, color: `${t.fg} !important` },
      "a, a:link, a:visited": { color: `${t.link} !important` },
    });
  }
  rendition.themes.select(settings.get().theme);
  rendition.themes.fontSize(`${settings.get().fontSize}%`);
  rendition.hooks.content.register((contents) => injectUserStyle(contents));

  wireGestures();
  rendition.on("relocated", onRelocated);

  // Cached location index → accurate percentages immediately.
  const savedLocations = await db.get("locations", id);
  if (savedLocations) book.locations.load(savedLocations);

  await rendition.display(local?.cfi || undefined);

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
    `On <b>${escapeHtml(remote.device_name || "another device")}</b> thou didst reach ` +
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
  current = { cfi, percent, chapter: chapterFor(loc.start.href) };
  if (holdSaves && initialCfi === null) initialCfi = cfi;
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

function chapterFor(href) {
  if (!href) return "";
  const base = href.split("#")[0];
  const hit = toc.find((t) => {
    const h = (t.href || "").split("#")[0];
    return h && (h === base || base.endsWith(h) || h.endsWith(base));
  });
  return hit?.label || "";
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
  await settings.update({ theme: name });
  document.body.dataset.theme = name;
  rendition?.themes.select(name);
}

function userCss() {
  const { fontFamily, lineHeight } = settings.get();
  const rules = [];
  if (fontFamily) rules.push(`font-family: ${fontFamily} !important;`);
  if (lineHeight) rules.push(`line-height: ${lineHeight} !important;`);
  if (!rules.length) return "";
  return `body, p, div, span, li, blockquote, td { ${rules.join(" ")} }`;
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
}

// ------------------------------------------------------------ gestures

function wireGestures() {
  let startX = 0, startY = 0, startT = 0;
  rendition.on("touchstart", (e) => {
    const t = e.changedTouches[0];
    startX = t.screenX; startY = t.screenY; startT = Date.now();
  });
  rendition.on("touchend", (e) => {
    const t = e.changedTouches[0];
    const dx = t.screenX - startX, dy = t.screenY - startY;
    if (Date.now() - startT < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dx < 0 ? rendition.next() : rendition.prev();
    }
  });
  rendition.on("click", (e) => {
    // Center tap toggles the bars; ignore taps on links or while selecting text.
    if (e.target?.closest?.("a")) return;
    const sel = e.view?.getSelection?.();
    if (sel && String(sel).length) return;
    document.body.classList.toggle("immersive");
    $("toc-drawer").classList.add("hidden");
    $("aa-panel").classList.add("hidden");
  });
  rendition.on("keydown", onKey);
}

// ---------------------------------------------------------------- close

export async function closeBook() {
  const moved = current && current.cfi !== lastSavedCfi && (!holdSaves || current.cfi !== initialCfi);
  if (moved) await saveProgress();
  sync.flushNow();
  try { rendition?.destroy(); } catch { /* ignore */ }
  try { book?.destroy(); } catch { /* ignore */ }
  book = rendition = meta = current = null;
  hideBanner();
  document.body.classList.remove("immersive");
  $("toc-drawer").classList.add("hidden");
  $("aa-panel").classList.add("hidden");
  onClose();
}
