// Shelf tab: the EPUB and PDF files stored on this device, in ReadEra's sections:
//   Books (EPUB) · Documents (PDF) · Favorites · To read · Have read
//   Authors · Series · Collections (each a list of groups, then the books in one) · Trash
import ePub from "epubjs";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { bookIdFor, escapeHtml, pct, timeAgo, toast } from "./util.js";
import * as native from "./native.js";
import * as pdfengine from "./pdfengine.js";
import * as sheet from "./sheet.js";
import * as about from "./aboutbook.js";
import * as readeraImport from "./readeraimport.js";

let hooks = { open: () => {}, onShelf: () => {}, listFor: () => null, onSection: () => {} };
let remoteHints = new Map(); // bookId -> newest entry from another device
const coverUrls = new Map();
const $ = (id) => document.getElementById(id);

export const SECTIONS = {
  books: "Books", docs: "Documents", favorites: "Favorites", toread: "To read", haveread: "Have read",
  authors: "Authors", series: "Series", collections: "Collections", trash: "Trash",
};
const GROUPED = new Set(["authors", "series", "collections"]);
let group = null;       // the author / series / collection being shown, or null for the list of groups
let groupEntry = false; // a history entry, so Back leaves the group rather than the app

export const section = () => (SECTIONS[settings.get().section] ? settings.get().section : "books");
export function sectionTitle() { return group || SECTIONS[section()]; }

export function init(h) {
  hooks = { ...hooks, ...h };

  $("file-input").addEventListener("change", async (e) => {
    await importFiles([...e.target.files]);
    e.target.value = "";
  });

  // Desktop drag-and-drop of book files from the file manager.
  const tab = $("tab-shelf");
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!isFiles(e) || document.body.dataset.tab !== "shelf") return;
    e.preventDefault();
    tab.classList.add("dropping");
  });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) tab.classList.remove("dropping"); });
  window.addEventListener("drop", async (e) => {
    if (!isFiles(e) || document.body.dataset.tab !== "shelf") return;
    e.preventDefault();
    tab.classList.remove("dropping");
    await importFiles([...e.dataTransfer.files]);
  });

  if (native.canBrowseDevice) initDeviceBooks();

  $("lib-search").addEventListener("input", render);
  const sort = $("lib-sort");
  sort.value = settings.get().sort;
  sort.addEventListener("change", async () => { await settings.update({ sort: sort.value }); render(); });
  const sec = $("lib-section");
  sec.value = section();
  sec.addEventListener("change", () => setSection(sec.value));

  $("lib-groups").addEventListener("click", (e) => {
    const more = e.target.closest("[data-gmore]");
    if (more) { collectionMenu(more.dataset.gmore); return; }
    const g = e.target.closest("[data-group]");
    if (g) enterGroup(g.dataset.group);
  });
  $("lib-head").addEventListener("click", (e) => {
    if (e.target.closest("[data-empty-trash]")) emptyTrash();
    else if (e.target.closest("[data-new-coll]")) newCollection();
    else if (e.target.closest("[data-leave]")) leaveGroup();
  });
  window.addEventListener("popstate", () => {
    if (groupEntry) { groupEntry = false; leaveGroup(true); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !group || document.body.classList.contains("reading") || sheet.isOpen()) return;
    if (document.querySelector("#re-drawer:not([hidden]), #panel:not([hidden])")) return;
    e.preventDefault(); leaveGroup();
  });

  window.addEventListener("harmonarium:shelf", () => render()); // e.g. after importing places from ReadEra
  backfill(); // series and format for books added before this version
}

export async function setSection(s) {
  if (!SECTIONS[s]) s = "books";
  if (group) leaveGroup(false, true);
  await settings.update({ section: s });
  $("lib-section").value = s;
  await render();
  hooks.onSection(s);
}

function enterGroup(name) {
  group = name;
  document.body.classList.add("in-group");
  try { history.pushState({ group: 1 }, ""); groupEntry = true; } catch { /* ignore */ }
  render();
  hooks.onSection(section());
  window.scrollTo(0, 0);
}
/** Back from a group to the list of groups. */
export function leaveGroup(fromHistory = false, quiet = false) {
  if (!group) return;
  group = null;
  document.body.classList.remove("in-group");
  if (groupEntry && !fromHistory) { groupEntry = false; try { history.back(); } catch { /* ignore */ } }
  if (!quiet) { render(); hooks.onSection(section()); }
}

// ---------------------------------------------------------------- import

const BOOK_FILE = /\.(epub|pdf)$/i;

/** "epub", "pdf", or null, from the file's first bytes: PDFs start "%PDF", EPUBs are ZIP files ("PK"). */
function kindOf(buf) {
  if (!buf || buf.byteLength < 8) return null;
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  if (pdfengine.isPdf("", "", buf)) return "pdf";
  // %PDF can come after a little junk at the start
  for (let i = 0; i < b.length - 4; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "epub"; // a ZIP; epub.js checks the rest
  return null;
}

/** Add EPUB and PDF files to the shelf. Returns each file's book id (null if it couldn't be read). */
export async function importFiles(files, { quiet = false } = {}) {
  // Judge each file by what's inside, not its name: Android's file picker often hands over
  // names without ".epub" (or none at all) and a generic type.
  let added = 0, restored = 0, refused = 0, fromReadEra = 0;
  const ids = [];
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const kind = kindOf(buf);
      if (!kind) { refused++; ids.push(null); continue; }
      const id = await bookIdFor(buf);
      ids.push(id);
      const have = await db.get("books", id);
      if (have) {
        if (have.trashedAt) { await db.put("books", { ...have, trashedAt: 0 }); restored++; }
        else if (!quiet) toast(`Already on your shelf: ${file.name}`);
        continue;
      }
      const pdf = kind === "pdf";
      const meta = pdf ? await pdfengine.metadata(buf, file.name) : await readMetadata(buf.slice(0), file.name);
      await db.put("files", buf, id);
      const record = {
        id, ...meta, format: pdf ? "pdf" : "epub", size: buf.byteLength, addedAt: Date.now(), lastOpenedAt: 0,
        favorite: false, status: "", collections: [], metaV: 2,
      };
      await db.put("books", record);
      added++;
      // A place imported from ReadEra may be waiting for this very file.
      try { if (await readeraImport.applyPending(record, buf)) fromReadEra++; } catch (err) { console.warn("ReadEra place", err); }
    } catch (err) {
      console.error(err);
      ids.push(null);
      toast(`Could not read ${file.name}`);
    }
  }
  if (refused && !added && !restored) toast(refused === 1 ? "That file isn't an EPUB or a PDF" : "Those files aren't EPUBs or PDFs");
  else if (refused) toast(`${refused} ${refused === 1 ? "file wasn't an EPUB or PDF" : "files weren't EPUBs or PDFs"}; the rest were added`);
  if (added) toast((added === 1 ? "A new book lands on your shelf" : `${added} new books land on your shelf`)
    + (fromReadEra ? ` · ${fromReadEra === added ? "" : `${fromReadEra} `}with your place from ReadEra` : ""));
  else if (restored) toast(restored === 1 ? "Brought back from the Trash" : `${restored} books brought back from the Trash`);
  // Only PDFs added while looking at Books (or only EPUBs in Documents): show where they went.
  const fresh = (await Promise.all(ids.filter(Boolean).map((id) => db.get("books", id)))).filter(Boolean);
  const s = section();
  if (fresh.length && (s === "books" || s === "docs") && !fresh.some((b) => inSection(b, s))) {
    await setSection(s === "books" ? "docs" : "books");
    refreshRemote(false);
    return ids;
  }
  await render();
  refreshRemote(false);
  return ids;
}

/** "+ Add books": the device list on Sailfish, otherwise the file picker. */
export function openAddBooks() {
  if (native.canBrowseDevice) openDeviceBooks();
  else $("file-input").click();
}

// ---------------------------------------------------------------- Sailfish: books on the device

let deviceBooks = [];

function initDeviceBooks() {
  // "+ Add books" opens the list of books on the phone instead of a file picker.
  document.querySelector(".add-btn").addEventListener("click", (e) => { e.preventDefault(); openDeviceBooks(); });
  document.querySelector("[data-devclose]").addEventListener("click", closeDeviceBooks);
  $("scrim").addEventListener("click", closeDeviceBooks);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("device-books").hidden) closeDeviceBooks(); });
  $("dev-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-dev]");
    if (b) await addDeviceBooks([deviceBooks[Number(b.dataset.dev)]]);
  });
  $("dev-add-all").addEventListener("click", async () => {
    const known = (await db.get("kv", "devicePaths")) || {};
    const fresh = deviceBooks.filter((b) => !known[b.path]);
    if (!fresh.length) { toast("Every book here is already on your shelf"); return; }
    await addDeviceBooks(fresh);
  });
}

async function openDeviceBooks() {
  $("device-books").hidden = false;
  $("scrim").hidden = false;
  $("dev-list").innerHTML = `<p class="p-desc">Looking for books…</p>`;
  try {
    deviceBooks = (await native.listDeviceBooks()).sort((a, b) => b.mtime - a.mtime);
    await renderDeviceBooks();
  } catch (err) {
    $("dev-list").innerHTML = `<p class="p-desc">Couldn't look through your folders (${escapeHtml(err.message)}).</p>`;
  }
  setTimeout(() => { if (document.body.classList.contains("dpad")) $("device-books").querySelector("button")?.focus(); }, 50);
}

function closeDeviceBooks() {
  if ($("device-books").hidden) return;
  $("device-books").hidden = true;
  if ($("panel").hidden) $("scrim").hidden = true;
  if (document.body.classList.contains("dpad")) setTimeout(() => document.querySelector(".add-btn")?.focus(), 30);
}

async function renderDeviceBooks() {
  const known = (await db.get("kv", "devicePaths")) || {};
  const onShelf = new Set((await db.getAll("books")).filter((b) => !b.trashedAt).map((b) => b.id));
  $("dev-list").innerHTML = deviceBooks.length
    ? deviceBooks.map((b, i) => {
        const have = known[b.path] && onShelf.has(known[b.path]);
        return `<button class="dev-book${have ? " have" : ""}" data-dev="${i}">
          <span class="dev-name">${escapeHtml(b.name.replace(BOOK_FILE, ""))}</span>
          <span class="dev-meta">${escapeHtml(b.folder)} · ${(b.name.match(BOOK_FILE)?.[1] || "").toUpperCase()} · ${mb(b.size)}${have ? " · <b>On your shelf</b>" : ""}</span>
        </button>`;
      }).join("")
    : `<p class="p-desc">No EPUB or PDF files found. Copy some into Documents or Downloads (or a folder named Books), then open this again.</p>`;
}

async function addDeviceBooks(list) {
  const known = (await db.get("kv", "devicePaths")) || {};
  const files = [];
  for (const b of list) {
    try { files.push(await native.readDeviceBook(b)); }
    catch { toast(`Could not open ${b.name}`); files.push(null); }
  }
  const ok = list.filter((_, i) => files[i]);
  const ids = await importFiles(files.filter(Boolean), { quiet: list.length > 1 });
  ok.forEach((b, i) => { if (ids[i]) known[b.path] = ids[i]; });
  await db.put("kv", known, "devicePaths");
  await renderDeviceBooks();
}

// ---------------------------------------------------------------- metadata

/** Series from the package file: Calibre's calibre:series, or EPUB 3's belongs-to-collection. */
async function seriesOf(book) {
  try {
    const path = book.container?.packagePath || book.packaging?.packagePath;
    const zip = book.archive?.zip;
    if (!path || !zip) return {};
    const file = zip.file(path) || zip.file(path.replace(/^\//, ""));
    const opf = file ? await file.async("string") : "";
    const attr = (name) => {
      const m = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(opf)
        || new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, "i").exec(opf);
      return m ? m[1] : "";
    };
    let series = attr("calibre:series"), index = attr("calibre:series_index");
    if (!series) {
      const c = /<meta[^>]*property=["']belongs-to-collection["'][^>]*?(?:id=["']([^"']+)["'])?[^>]*>([^<]+)<\/meta>/i.exec(opf);
      if (c) {
        series = c[2];
        if (c[1]) {
          const pos = new RegExp(`<meta[^>]*refines=["']#${c[1]}["'][^>]*property=["']group-position["'][^>]*>([^<]+)<`, "i").exec(opf);
          if (pos) index = pos[1];
        }
      }
    }
    const decode = (s) => s.replace(/&amp;/g, "&").replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
    const n = parseFloat(index);
    return series ? { series: decode(series), seriesIndex: Number.isFinite(n) ? n : null } : {};
  } catch { return {}; }
}

async function readMetadata(buf, fallbackName) {
  const book = ePub(buf);
  try {
    await book.ready;
    const md = book.packaging?.metadata || {};
    let cover = null;
    try {
      const url = await book.coverUrl();
      if (url) cover = await (await fetch(url)).blob();
    } catch { /* no cover */ }
    return {
      title: (md.title || fallbackName.replace(/\.epub$/i, "")).trim(),
      author: (md.creator || "").trim(),
      cover,
      ...(await seriesOf(book)),
    };
  } finally {
    book.destroy();
  }
}

/** Books added by earlier versions: note their format and look up their series, once. */
async function backfill() {
  try {
    const old = (await db.getAll("books")).filter((b) => (b.metaV || 0) < 2);
    for (const b of old) {
      const extra = { format: b.format || "epub", metaV: 2 };
      if (extra.format === "epub") {
        const buf = await db.get("files", b.id);
        if (buf) {
          const book = ePub(buf.slice(0));
          try { await book.ready; Object.assign(extra, await seriesOf(book)); } catch { /* keep going */ } finally { book.destroy(); }
        }
      }
      const now = await db.get("books", b.id);
      if (now) await db.put("books", { ...now, ...extra });
    }
    if (old.length) render();
  } catch (err) { console.warn("backfill", err); }
}

// ---------------------------------------------------------------- render

const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

function coverUrl(book) {
  if (!book.cover) return null;
  if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.cover));
  return coverUrls.get(book.id);
}

function hue(s) {
  let h = 5381;
  for (const c of String(s)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

const isDoc = (b) => b.format === "pdf";
function inSection(b, s) {
  if (s === "trash") return !!b.trashedAt;
  if (b.trashedAt) return false;
  switch (s) {
    case "books": return !isDoc(b);
    case "docs": return isDoc(b);
    case "favorites": return !!b.favorite;
    case "toread": return b.status === "toread";
    case "haveread": return b.status === "haveread";
    default: return true;
  }
}
const groupsOf = (b, s) => {
  if (s === "authors") return (b.author || "Unknown author").split(/\s*(?:;|&| and )\s*/).filter(Boolean);
  if (s === "series") return b.series ? [b.series] : [];
  if (s === "collections") return b.collections || [];
  return [];
};

/** How many books in each section (for the drawer). */
export async function counts() {
  const books = await db.getAll("books");
  const n = {};
  for (const s of Object.keys(SECTIONS)) if (!GROUPED.has(s)) n[s] = books.filter((b) => inSection(b, s)).length;
  return n;
}

export async function render() {
  const [all, progress] = await Promise.all([db.getAll("books"), db.getAll("progress")]);
  const prog = new Map(progress.map((p) => [p.bookId, p]));
  const live = all.filter((b) => !b.trashedAt);
  hooks.onShelf(live, prog);

  const s = section();
  const q = $("lib-search").value.trim().toLowerCase();
  const sort = settings.get().sort;
  const match = (b) => !q || `${b.title} ${b.author} ${b.series || ""}`.toLowerCase().includes(q);
  const grid = $("lib-grid"), groups = $("lib-groups"), head = $("lib-head");

  // Authors / Series / Collections: first the groups…
  if (GROUPED.has(s) && !group) {
    const map = new Map();
    for (const b of live) for (const g of groupsOf(b, s)) {
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(b);
    }
    if (s === "collections") for (const c of await collections()) if (!map.has(c)) map.set(c, []);
    const names = [...map.keys()].filter((g) => !q || g.toLowerCase().includes(q) || map.get(g).some(match))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
    grid.innerHTML = "";
    groups.hidden = false;
    head.hidden = s !== "collections";
    head.innerHTML = s === "collections" ? `<button class="btn small" data-new-coll>+ New collection</button>` : "";
    groups.innerHTML = names.map((g) => {
      const list = map.get(g);
      const read = list.filter((b) => (prog.get(b.id)?.percent || 0) >= 0.99 || b.status === "haveread").length;
      const covers = list.filter((b) => b.cover).slice(0, 3).map((b) => `<img src="${coverUrl(b)}" alt="" loading="lazy">`).join("");
      return `<div class="lib-group">
        <button class="lib-group-open" data-group="${escapeHtml(g)}">
          <span class="lib-group-cv">${covers || `<i>${escapeHtml(g.slice(0, 1).toUpperCase())}</i>`}</span>
          <span class="lib-group-t">${escapeHtml(g)}</span>
          <span class="lib-group-n">${list.length} ${list.length === 1 ? "book" : "books"}${s === "series" && list.length ? ` · ${read} read` : ""}</span>
        </button>
        ${s === "collections" ? `<button class="lib-more lib-group-more" data-gmore="${escapeHtml(g)}" aria-label="Collection options"><span class="lib-more-h">⋯</span><span class="lib-more-v">⋮</span></button>` : ""}
      </div>`;
    }).join("");
    showEmpty(names.length === 0, s);
    return;
  }

  // …otherwise the books.
  groups.hidden = true;
  groups.innerHTML = "";
  let list = all.filter((b) => (GROUPED.has(s) ? !b.trashedAt && groupsOf(b, s).includes(group) : inSection(b, s))).filter(match);
  list.sort((a, b) => {
    if (s === "series" && group) return (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9) || a.title.localeCompare(b.title);
    if (s === "trash") return (b.trashedAt || 0) - (a.trashedAt || 0);
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "author") return (a.author || "").localeCompare(b.author || "");
    if (sort === "added") return b.addedAt - a.addedAt;
    return (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt);
  });
  head.hidden = !(group || (s === "trash" && list.length));
  head.innerHTML = group
    ? `<button class="btn small lib-leave" data-leave>← ${escapeHtml(SECTIONS[s])}</button><b class="lib-head-t">${escapeHtml(group)}</b>`
    : s === "trash" ? `<span class="lib-head-t">Books here stay on this device until you empty the trash.</span><button class="btn small danger" data-empty-trash>Empty trash</button>` : "";

  grid.innerHTML = list.map((b) => cardHtml(b, prog.get(b.id))).join("");
  for (const card of grid.querySelectorAll(".lib-card")) {
    const id = card.dataset.id;
    card.querySelector(".lib-open").addEventListener("click", () => (s === "trash" ? bookMenu(id) : hooks.open(id)));
    card.querySelector(".lib-more").addEventListener("click", (e) => { e.stopPropagation(); bookMenu(id); });
  }
  showEmpty(list.length === 0, s, all.filter((b) => !b.trashedAt).length === 0);
}

function showEmpty(on, s, shelfEmpty = false) {
  $("lib-empty").hidden = !on;
  if (!on) return;
  const q = $("lib-search").value.trim();
  const [h, p] = q ? ["Nothing found", `No books match “${escapeHtml(q)}”.`]
    : shelfEmpty && (s === "books" || s === "docs") ? ["Your shelf is empty", "Add EPUB or PDF files with <b>+ Add books</b>. Put the very same files on each device and your place follows you."]
    : {
      books: ["No books", "EPUB books you add appear here."],
      docs: ["No documents", "PDF files you add appear here."],
      favorites: ["No favorites", "Choose <b>Add to Favorites</b> in a book's ⋮ menu."],
      toread: ["Nothing to read yet", "Choose <b>To read</b> in a book's ⋮ menu."],
      haveread: ["Nothing finished yet", "Books you finish, or mark <b>Have read</b>, appear here."],
      authors: ["No authors", "Add some books first."],
      series: ["No series", "Books that name their series (as Calibre does) are grouped here."],
      collections: ["No collections", "Make one with <b>+ New collection</b>, or from a book's ⋮ menu."],
      trash: ["The trash is empty", "Books you move to the trash wait here."],
    }[s] || ["Nothing here", ""];
  $("lib-empty-h").textContent = h;
  $("lib-empty-p").innerHTML = p;
}

function cardHtml(b, p) {
  const url = coverUrl(b);
  const percent = p?.percent || 0;
  const hint = remoteHints.get(b.id);
  const ahead = hint && Number(hint.updated_at) > (p?.updatedAt || 0);
  const where = hooks.listFor(b.title);
  const h = hue(b.title);
  const fmt = (b.format || "epub").toUpperCase();
  const badges = [b.favorite ? "★" : "", b.status === "toread" ? "To read" : b.status === "haveread" ? "Have read" : ""].filter(Boolean);
  return `
    <article class="lib-card${b.trashedAt ? " trashed" : ""}" data-id="${escapeHtml(b.id)}">
      <button class="lib-open">
        <div class="cv lib-cv${url ? " real" : ""}" style="--h1:${h};--h2:${(h + 60) % 360}">
          ${url ? `<img src="${url}" alt="" loading="lazy" draggable="false" />` : `<span class="cv-t">${escapeHtml(b.title)}</span>`}
          ${ahead ? `<span class="lib-ahead" title="Further along on ${escapeHtml(hint.device_name)}">⟳ ${pct(hint.percent)}</span>` : ""}
        </div>
        <div class="lib-title">${escapeHtml(b.title)}</div>
        <div class="lib-author">${escapeHtml(b.author)}${b.series ? ` · <span class="lib-series">${escapeHtml(b.series)}${b.seriesIndex ? ` #${b.seriesIndex}` : ""}</span>` : ""}</div>
        <div class="lib-fmt">${fmt}${b.size ? ` · ${mb(b.size)}` : ""}${badges.length ? ` · ${badges.map(escapeHtml).join(" · ")}` : ""}</div>
        <div class="lib-bar"><span style="width:${(percent * 100).toFixed(1)}%"></span></div>
        <div class="lib-sub">${p ? `${pct(percent)} · ${timeAgo(p.updatedAt)}` : "Unread"}${where ? ` · <span class="lib-list${where.done ? " done" : ""}">${escapeHtml(where.name)}</span>` : ""}</div>
      </button>
      <button class="lib-more" title="More" aria-label="More for ${escapeHtml(b.title)}"><span class="lib-more-h">⋯</span><span class="lib-more-v">⋮</span></button>
    </article>`;
}

// ---------------------------------------------------------------- book menu

async function update(id, patch) {
  const b = await db.get("books", id);
  if (!b) return null;
  const next = { ...b, ...patch };
  await db.put("books", next);
  return next;
}

/** A book's ⋮ menu (ReadEra's: open, about, favorite, shelves, collections, trash). */
export async function bookMenu(id) {
  const b = await db.get("books", id);
  if (!b) return;
  if (b.trashedAt) {
    const v = await sheet.menu({ title: b.title, subtitle: b.author, items: [
      { label: "Restore", value: "restore", icon: "↺" },
      { label: "About", value: "about", icon: "ⓘ" },
      { label: "Delete for good", value: "delete", icon: "🗑", danger: true },
    ] });
    if (v === "restore") { await update(id, { trashedAt: 0 }); toast("Restored"); render(); }
    else if (v === "about") about.show(id);
    else if (v === "delete") await deleteForGood([b]);
    return;
  }
  const v = await sheet.menu({ title: b.title, subtitle: b.author, items: [
    { label: "Read", value: "open", icon: "▶" },
    { label: "About", value: "about", icon: "ⓘ" },
    "-",
    { label: b.favorite ? "Remove from Favorites" : "Add to Favorites", value: "fav", icon: b.favorite ? "★" : "☆" },
    { label: "To read", value: "toread", checked: b.status === "toread", icon: "◷" },
    { label: "Have read", value: "haveread", checked: b.status === "haveread", icon: "✓" },
    { label: "Collections…", value: "coll", icon: "▣", hint: b.collections?.length ? b.collections.join(", ") : "" },
    "-",
    { label: "Move to trash", value: "trash", icon: "🗑", danger: true },
  ] });
  if (!v) return;
  if (v === "open") hooks.open(id);
  else if (v === "about") about.show(id);
  else if (v === "fav") { await update(id, { favorite: !b.favorite }); toast(b.favorite ? "Removed from Favorites" : "Added to Favorites"); }
  else if (v === "toread" || v === "haveread") {
    const status = b.status === v ? "" : v;
    await update(id, { status });
    toast(status ? `Moved to ${SECTIONS[v]}` : `Removed from ${SECTIONS[v]}`);
  } else if (v === "coll") await pickCollections(id);
  else if (v === "trash") {
    await update(id, { trashedAt: Date.now() });
    toast("Moved to the trash", async () => { await update(id, { trashedAt: 0 }); render(); });
  }
  render();
}

/** Mark a book as finished (the reader calls this at the last page). */
export async function markRead(id) {
  const b = await db.get("books", id);
  if (b && b.status !== "haveread") await update(id, { status: "haveread" });
}

// ---------------------------------------------------------------- collections

async function collections() {
  const saved = (await db.get("kv", "collections")) || [];
  const used = (await db.getAll("books")).flatMap((b) => b.collections || []);
  return [...new Set([...saved, ...used])].sort((a, b) => a.localeCompare(b));
}
async function saveCollections(list) { await db.put("kv", [...new Set(list)], "collections"); }

async function newCollection(forBook = null) {
  const name = await sheet.ask({ title: "New collection", placeholder: "e.g. Fantasy, Course readings", ok: "Create" });
  if (!name) return null;
  await saveCollections([...(await collections()), name]);
  if (forBook) {
    const b = await db.get("books", forBook);
    await update(forBook, { collections: [...new Set([...(b.collections || []), name])] });
  }
  render();
  return name;
}

async function pickCollections(id) {
  const all = await collections();
  const b = await db.get("books", id);
  const mine = new Set(b.collections || []);
  const res = await sheet.card({
    title: "Collections",
    subtitle: b.title,
    html: `<div class="coll-pick">${all.length ? all.map((c, i) => `<label class="check"><input type="checkbox" data-c="${i}"${mine.has(c) ? " checked" : ""}> ${escapeHtml(c)}</label>`).join("") : `<p class="sh-text">No collections yet.</p>`}</div>
      <div class="sh-actions"><button class="btn" data-new>+ New</button><button class="btn primary" data-done>Done</button></div>`,
    wire: (box, done) => {
      box.querySelector("[data-done]").addEventListener("click", () => {
        done({ picked: [...box.querySelectorAll("[data-c]")].filter((x) => x.checked).map((x) => all[Number(x.dataset.c)]) });
      });
      box.querySelector("[data-new]").addEventListener("click", () => done({ fresh: true }));
    },
  });
  if (!res) return;
  if (res.fresh) { if (await newCollection(id)) toast("Collection created"); return; }
  await update(id, { collections: res.picked });
  render();
}

async function collectionMenu(name) {
  const v = await sheet.menu({ title: name, items: [
    { label: "Rename", value: "rename", icon: "✎" },
    { label: "Delete collection", value: "delete", icon: "🗑", danger: true, hint: "The books stay on your shelf" },
  ] });
  const books = (await db.getAll("books")).filter((b) => (b.collections || []).includes(name));
  if (v === "rename") {
    const to = await sheet.ask({ title: "Rename collection", value: name, ok: "Rename" });
    if (!to || to === name) return;
    for (const b of books) await update(b.id, { collections: [...new Set(b.collections.map((c) => (c === name ? to : c)))] });
    await saveCollections((await collections()).map((c) => (c === name ? to : c)));
  } else if (v === "delete") {
    if (!(await sheet.confirm({ title: `Delete “${name}”?`, text: "The books in it stay on your shelf.", ok: "Delete", danger: true }))) return;
    for (const b of books) await update(b.id, { collections: b.collections.filter((c) => c !== name) });
    await saveCollections(((await db.get("kv", "collections")) || []).filter((c) => c !== name));
  }
  render();
}

// ---------------------------------------------------------------- trash

async function deleteForGood(list) {
  const one = list.length === 1;
  const ok = await sheet.confirm({
    title: one ? `Delete “${list[0].title}”?` : `Delete ${list.length} books?`,
    text: "Removed from this device for good, with its bookmarks and quotes. Its progress in the sheet stays.",
    ok: "Delete", danger: true,
  });
  if (!ok) return;
  for (const b of list) {
    await db.deleteBook(b.id);
    const url = coverUrls.get(b.id);
    if (url) { URL.revokeObjectURL(url); coverUrls.delete(b.id); }
  }
  toast(one ? "Deleted" : `${list.length} books deleted`);
  render();
}
async function emptyTrash() {
  const list = (await db.getAll("books")).filter((b) => b.trashedAt);
  if (list.length) await deleteForGood(list);
}

// ---------------------------------------------------------------- sync hints

/** Ask the sheet which books were read further on other devices. */
export async function refreshRemote(verbose) {
  if (!sync.isConfigured()) return;
  try {
    await sync.flush();
    const entries = await sync.fetchAll();
    const byBook = new Map();
    for (const e of entries) {
      if (!byBook.has(e.book_id)) byBook.set(e.book_id, []);
      byBook.get(e.book_id).push(e);
    }
    remoteHints = new Map();
    for (const [id, list] of byBook) {
      const n = sync.newestFromOthers(list);
      if (n) remoteHints.set(id, n);
    }
    render();
  } catch (err) {
    if (verbose) toast(`Reading sync failed: ${err.message}`);
  }
}
