// Shelf tab: the EPUB files stored on this device.
import ePub from "epubjs";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { bookIdFor, escapeHtml, pct, timeAgo, toast } from "./util.js";
import * as native from "./native.js";

let hooks = { open: () => {}, onShelf: () => {}, listFor: () => null };
let remoteHints = new Map(); // bookId -> newest entry from another device
const coverUrls = new Map();
const $ = (id) => document.getElementById(id);

export function init(h) {
  hooks = { ...hooks, ...h };

  $("file-input").addEventListener("change", async (e) => {
    await importFiles([...e.target.files]);
    e.target.value = "";
  });

  // Desktop drag-and-drop of .epub files from the file manager.
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
}

/** Add EPUB files to the shelf. Returns each file's book id (null if it couldn't be read). */
export async function importFiles(files, { quiet = false } = {}) {
  const epubs = files.filter((f) => /\.epub$/i.test(f.name) || f.type === "application/epub+zip");
  if (!epubs.length) { toast("Only .epub files can be added"); return []; }
  let added = 0;
  const ids = [];
  for (const file of epubs) {
    try {
      const buf = await file.arrayBuffer();
      const id = await bookIdFor(buf);
      ids.push(id);
      if (await db.get("books", id)) { if (!quiet) toast(`Already on your shelf: ${file.name}`); continue; }
      const meta = await readMetadata(buf.slice(0), file.name);
      await db.put("files", buf, id);
      await db.put("books", { id, ...meta, size: buf.byteLength, addedAt: Date.now(), lastOpenedAt: 0 });
      added++;
    } catch (err) {
      console.error(err);
      ids.push(null);
      toast(`Could not read ${file.name}`);
    }
  }
  if (added) toast(added === 1 ? "A new book lands on your shelf" : `${added} new books land on your shelf`);
  await render();
  refreshRemote(false);
  return ids;
}

// ---------------------------------------------------------------- Sailfish: books on the device

let deviceBooks = [];

function initDeviceBooks() {
  // "+ Add books" opens the list of EPUBs on the phone instead of a file picker.
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
  $("dev-list").innerHTML = `<p class="p-desc">Looking for EPUB files…</p>`;
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
  const onShelf = new Set((await db.getAll("books")).map((b) => b.id));
  const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  $("dev-list").innerHTML = deviceBooks.length
    ? deviceBooks.map((b, i) => {
        const have = known[b.path] && onShelf.has(known[b.path]);
        return `<button class="dev-book${have ? " have" : ""}" data-dev="${i}">
          <span class="dev-name">${escapeHtml(b.name.replace(/\.epub$/i, ""))}</span>
          <span class="dev-meta">${escapeHtml(b.folder)} · ${mb(b.size)}${have ? " · <b>On your shelf</b>" : ""}</span>
        </button>`;
      }).join("")
    : `<p class="p-desc">No EPUB files found. Copy some into Documents or Downloads (or a folder named Books), then open this again.</p>`;
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
    };
  } finally {
    book.destroy();
  }
}

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

export async function render() {
  const [books, progress] = await Promise.all([db.getAll("books"), db.getAll("progress")]);
  const prog = new Map(progress.map((p) => [p.bookId, p]));
  hooks.onShelf(books, prog);

  const q = $("lib-search").value.trim().toLowerCase();
  const sort = settings.get().sort;
  const list = books
    .filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "author") return (a.author || "").localeCompare(b.author || "");
      if (sort === "added") return b.addedAt - a.addedAt;
      return (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt);
    });

  $("lib-empty").hidden = books.length > 0;
  const grid = $("lib-grid");
  grid.innerHTML = list.map((b) => cardHtml(b, prog.get(b.id))).join("");
  for (const card of grid.querySelectorAll(".lib-card")) {
    const id = card.dataset.id;
    card.querySelector(".lib-open").addEventListener("click", () => hooks.open(id));
    card.querySelector(".lib-more").addEventListener("click", (e) => { e.stopPropagation(); bookMenu(id); });
  }
}

function cardHtml(b, p) {
  const url = coverUrl(b);
  const percent = p?.percent || 0;
  const hint = remoteHints.get(b.id);
  const ahead = hint && Number(hint.updated_at) > (p?.updatedAt || 0);
  const where = hooks.listFor(b.title);
  const h = hue(b.title);
  return `
    <article class="lib-card" data-id="${escapeHtml(b.id)}">
      <button class="lib-open">
        <div class="cv lib-cv${url ? " real" : ""}" style="--h1:${h};--h2:${(h + 60) % 360}">
          ${url ? `<img src="${url}" alt="" loading="lazy" draggable="false" />` : `<span class="cv-t">${escapeHtml(b.title)}</span>`}
          ${ahead ? `<span class="lib-ahead" title="Further along on ${escapeHtml(hint.device_name)}">⟳ ${pct(hint.percent)}</span>` : ""}
        </div>
        <div class="lib-title">${escapeHtml(b.title)}</div>
        <div class="lib-author">${escapeHtml(b.author)}</div>
        <div class="lib-bar"><span style="width:${(percent * 100).toFixed(1)}%"></span></div>
        <div class="lib-sub">${p ? `${pct(percent)} · ${timeAgo(p.updatedAt)}` : "Unread"}${where ? ` · <span class="lib-list${where.done ? " done" : ""}">${escapeHtml(where.name)}</span>` : ""}</div>
      </button>
      <button class="lib-more" title="Remove" aria-label="Remove ${escapeHtml(b.title)}">⋯</button>
    </article>`;
}

async function bookMenu(id) {
  const book = await db.get("books", id);
  if (!book) return;
  if (confirm(`Remove “${book.title}” from this device?\n(Its progress in the sheet stays.)`)) {
    await db.deleteBook(id);
    const url = coverUrls.get(id);
    if (url) { URL.revokeObjectURL(url); coverUrls.delete(id); }
    toast("Removed from your shelf");
    render();
  }
}

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
