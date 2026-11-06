import ePub from "epubjs";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as sync from "./sync.js";
import { bookIdFor, escapeHtml, pct, timeAgo, toast } from "./util.js";

let onOpen = () => {};
let remoteHints = new Map(); // bookId -> newest entry from another device
const coverUrls = new Map();

export function init({ open }) {
  onOpen = open;

  document.getElementById("file-input").addEventListener("change", async (e) => {
    await importFiles([...e.target.files]);
    e.target.value = "";
  });

  // Desktop drag-and-drop.
  const lib = document.getElementById("view-library");
  lib.addEventListener("dragover", (e) => { e.preventDefault(); lib.classList.add("dropping"); });
  lib.addEventListener("dragleave", () => lib.classList.remove("dropping"));
  lib.addEventListener("drop", async (e) => {
    e.preventDefault();
    lib.classList.remove("dropping");
    await importFiles([...e.dataTransfer.files]);
  });

  document.getElementById("search").addEventListener("input", render);
  const sort = document.getElementById("sort");
  sort.value = settings.get().sort;
  sort.addEventListener("change", async () => { await settings.update({ sort: sort.value }); render(); });

  document.getElementById("btn-sync-all").addEventListener("click", () => refreshRemote(true));
}

export async function importFiles(files) {
  const epubs = files.filter((f) => /\.epub$/i.test(f.name) || f.type === "application/epub+zip");
  if (!epubs.length) { toast("Only .epub files can be added"); return; }
  let added = 0;
  for (const file of epubs) {
    try {
      const buf = await file.arrayBuffer();
      const id = await bookIdFor(buf);
      if (await db.get("books", id)) { toast(`Already on thy shelf: ${file.name}`); continue; }
      const meta = await readMetadata(buf.slice(0), file.name);
      await db.put("files", buf, id);
      await db.put("books", { id, ...meta, size: buf.byteLength, addedAt: Date.now(), lastOpenedAt: 0 });
      added++;
    } catch (err) {
      console.error(err);
      toast(`Could not read ${file.name}`);
    }
  }
  if (added) toast(added === 1 ? "A new tome joins the shelf" : `${added} new tomes join the shelf`);
  await render();
  refreshRemote(false);
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

export async function render() {
  const [books, progress] = await Promise.all([db.getAll("books"), db.getAll("progress")]);
  const prog = new Map(progress.map((p) => [p.bookId, p]));
  const q = document.getElementById("search").value.trim().toLowerCase();
  const sort = settings.get().sort;

  const list = books
    .filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "author") return (a.author || "").localeCompare(b.author || "");
      if (sort === "added") return b.addedAt - a.addedAt;
      return (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt);
    });

  document.getElementById("empty-shelf").classList.toggle("hidden", books.length > 0);
  const shelf = document.getElementById("shelf");
  shelf.innerHTML = list.map((b) => cardHtml(b, prog.get(b.id))).join("");

  for (const card of shelf.querySelectorAll(".card")) {
    const id = card.dataset.id;
    card.querySelector(".card-open").addEventListener("click", () => onOpen(id));
    card.querySelector(".card-more").addEventListener("click", (e) => { e.stopPropagation(); bookMenu(id); });
  }
}

function cardHtml(b, p) {
  const url = coverUrl(b);
  const percent = p?.percent || 0;
  const hint = remoteHints.get(b.id);
  const ahead = hint && Number(hint.updated_at) > (p?.updatedAt || 0);
  const initials = escapeHtml((b.title || "?").slice(0, 2));
  return `
    <article class="card" data-id="${escapeHtml(b.id)}">
      <button class="card-open">
        <div class="cover">${url ? `<img src="${url}" alt="" loading="lazy" />` : `<div class="cover-blank">${initials}</div>`}
          ${ahead ? `<span class="badge" title="Newer position on ${escapeHtml(hint.device_name)}">⟳ ${pct(hint.percent)}</span>` : ""}
        </div>
        <div class="card-meta">
          <div class="card-title">${escapeHtml(b.title)}</div>
          <div class="card-author">${escapeHtml(b.author)}</div>
          <div class="bar"><span style="width:${(percent * 100).toFixed(1)}%"></span></div>
          <div class="card-sub">${p ? `${pct(percent)} · ${timeAgo(p.updatedAt)}` : "Unread"}</div>
        </div>
      </button>
      <button class="card-more" title="More">⋯</button>
    </article>`;
}

async function bookMenu(id) {
  const book = await db.get("books", id);
  if (!book) return;
  if (confirm(`Remove “${book.title}” from this device?\n(Its progress row in the sheet stays.)`)) {
    await db.deleteBook(id);
    const url = coverUrls.get(id);
    if (url) { URL.revokeObjectURL(url); coverUrls.delete(id); }
    toast("Removed from the shelf");
    render();
  }
}

/** Ask the sheet which books were read further on other devices. */
export async function refreshRemote(verbose) {
  if (!sync.isConfigured()) {
    if (verbose) toast("Set up Google Sheet sync in Settings first");
    return;
  }
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
    if (verbose) toast("Synced with the sheet");
    render();
  } catch (err) {
    if (verbose) toast(`Sync failed: ${err.message}`, 4000);
  }
}
