// Bookmarks, quotes and notes inside a book (the free side of ReadEra: one highlight colour,
// a note on any quote, and each book's own lists under Contents).
//
//   Bookmark  the page you're on (EPUB: a CFI; PDF: "pdf:<page>:…"), with the first words on it
//   Quote     a passage you selected, kept with its CFI range and highlighted in the book
//   Note      a quote with your own words attached
//
// The reader hands in a small context (see load()); this module owns the selection bar,
// the highlights, the bookmark button and the Bookmarks / Quotes / Notes tabs of the
// navigation panel.
import ePub from "epubjs";
import * as db from "./db.js";
import * as sheet from "./sheet.js";
import { escapeHtml, pct, toast, uuid } from "./util.js";

const $ = (id) => document.getElementById(id);
const HL = { fill: "#ffd54f", "fill-opacity": "0.42", "mix-blend-mode": "multiply" };
const HL_NIGHT = { fill: "#ffd54f", "fill-opacity": "0.28" };

let ctx = null;   // { bookId, isPdf, rendition(), book, pdf(), current(), jump(cfi), chapterFor(cfi|page), night() }
let marks = [];
let loc = null;   // last relocation: { start, end } CFIs, or { page } for PDFs
let selection = null; // { cfiRange, text, contents }
const cfi = (() => { try { return new ePub.CFI(); } catch { return null; } })();

function cmp(a, b) {
  try { return cfi.compare(a, b); } catch { return 0; }
}

// ------------------------------------------------------------------ setup

export function init() {
  $("btn-bm").addEventListener("click", () => toggleBookmark());
  $("sel-bar").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  $("sel-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sel]");
    if (b) selAction(b.dataset.sel);
  });
  for (const id of ["bm-list", "q-list", "n-list"]) {
    $(id).addEventListener("click", (e) => onListClick(e));
  }
}

export async function load(c) {
  ctx = c;
  marks = await db.marksFor(c.bookId);
  loc = null;
  renderLists();
  applyHighlights();
}

export function unload() {
  hideSelection();
  ctx = null;
  marks = [];
  loc = null;
  $("bm-ribbon").hidden = true;
  $("btn-bm").classList.remove("on");
}

const quotes = () => marks.filter((m) => m.kind === "quote");
const bookmarks = () => marks.filter((m) => m.kind === "bookmark");

/** Draw every saved quote into the book (again after the rendition is rebuilt). */
export function applyHighlights() {
  if (!ctx || ctx.isPdf) return;
  const r = ctx.rendition();
  if (!r) return;
  for (const q of quotes()) highlight(q);
}

function highlight(q) {
  const r = ctx?.rendition();
  if (!r || !q.cfi) return;
  try { r.annotations.remove(q.cfi, "highlight"); } catch { /* not there yet */ }
  try {
    r.annotations.highlight(q.cfi, { id: q.id }, () => openQuote(q.id), q.note ? "hm-hl hm-note" : "hm-hl", ctx.night() ? HL_NIGHT : HL);
  } catch (err) { console.warn("highlight", err); }
}

/** The theme changed between day and night: redraw highlights so they read on either. */
export function retint() { applyHighlights(); }

// ------------------------------------------------------------------ bookmarks

/** The reader moved. `l` is epub.js's location, or { page } for a PDF. */
export function onRelocated(l) {
  loc = l;
  hideSelection();
  const on = !!bookmarkHere();
  $("btn-bm").classList.toggle("on", on);
  $("btn-bm").setAttribute("aria-pressed", String(on));
  $("bm-ribbon").hidden = !on;
}

function bookmarkHere() {
  if (!loc) return null;
  if (ctx?.isPdf) return bookmarks().find((b) => Number(String(b.cfi).split(":")[1]) === loc.page) || null;
  const s = loc.start?.cfi, e = loc.end?.cfi;
  if (!s) return null;
  return bookmarks().find((b) => b.cfi === s || (cmp(b.cfi, s) >= 0 && e && cmp(b.cfi, e) <= 0)) || null;
}

export async function toggleBookmark() {
  if (!ctx) return;
  const here = bookmarkHere();
  if (here) {
    await remove(here.id);
    toast("Bookmark removed", async () => { await save(here); onRelocated(loc); });
  } else {
    const cur = ctx.current();
    if (!cur) return;
    const m = {
      id: uuid(), bookId: ctx.bookId, kind: "bookmark",
      cfi: ctx.isPdf ? `pdf:${loc?.page || 1}:0.000` : cur.cfi,
      text: await snippet(), chapter: cur.chapter || "", percent: cur.percent || 0, createdAt: Date.now(),
    };
    await save(m);
    toast("Bookmark added");
  }
  onRelocated(loc);
}

/** The first words on the current page. */
async function snippet() {
  try {
    if (ctx.isPdf) return await ctx.pdfSnippet(loc?.page || 1);
    const r = ctx.rendition().getRange(loc.start.cfi);
    if (!r) return "";
    const doc = r.startContainer.ownerDocument;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = r.startContainer;
    let out = r.startContainer.nodeType === 3 ? r.startContainer.textContent.slice(r.startOffset) : "";
    while (out.replace(/\s+/g, " ").trim().length < 140 && walker.nextNode()) out += " " + walker.currentNode.textContent;
    return out.replace(/\s+/g, " ").trim().slice(0, 140);
  } catch { return ""; }
}

// ------------------------------------------------------------------ selection → quote

/** epub.js "selected": show the bar over the selection. */
export function onSelected(cfiRange, contents) {
  if (!ctx) return;
  const sel = contents.window.getSelection();
  const text = String(sel || "").replace(/\s+/g, " ").trim();
  if (!text) return hideSelection();
  selection = { cfiRange, text, contents };
  const bar = $("sel-bar");
  bar.hidden = false;
  try {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const fr = contents.window.frameElement.getBoundingClientRect();
    const host = $("view-reader").getBoundingClientRect();
    const w = bar.offsetWidth || 260, h = bar.offsetHeight || 48;
    let x = fr.left + rect.left + rect.width / 2 - host.left - w / 2;
    // Below the selection (Android puts its own copy/paste menu above it); above if no room.
    let y = fr.top + rect.bottom - host.top + 14;
    if (y + h > host.height - 8) y = fr.top + rect.top - host.top - h - 14;
    bar.style.left = `${Math.max(8, Math.min(host.width - w - 8, x))}px`;
    bar.style.top = `${Math.max(8, y)}px`;
  } catch {
    bar.style.left = "50%"; bar.style.top = "auto";
  }
}

export function hideSelection() {
  selection = null;
  const bar = $("sel-bar");
  if (bar) bar.hidden = true;
}
export const selectionOpen = () => !$("sel-bar").hidden;

/** A selection was cleared inside the book. */
export function onSelectionChange(doc) {
  if (selection && selection.contents.document === doc && !String(doc.getSelection() || "").trim()) hideSelection();
}

async function selAction(what) {
  const s = selection;
  if (!s) return;
  const clear = () => { try { s.contents.window.getSelection().removeAllRanges(); } catch { /* ignore */ } hideSelection(); };
  if (what === "copy") { await copy(s.text); clear(); return; }
  if (what === "find") { clear(); ctx.find(s.text.slice(0, 80)); return; }
  if (what === "quote" || what === "note") {
    let note = "";
    if (what === "note") {
      clear();
      note = await sheet.ask({ title: "Note", label: `“${s.text.slice(0, 120)}${s.text.length > 120 ? "…" : ""}”`, multiline: true, placeholder: "Your note", ok: "Save" });
      if (note === null) return;
    } else clear();
    const cur = ctx.current();
    const m = {
      id: uuid(), bookId: ctx.bookId, kind: "quote", cfi: s.cfiRange, text: s.text, note,
      chapter: ctx.chapterFor(s.cfiRange) || cur?.chapter || "", percent: percentOf(s.cfiRange, cur), createdAt: Date.now(),
    };
    await save(m);
    highlight(m);
    toast(note ? "Note saved" : "Quote saved");
  }
}

function percentOf(range, cur) {
  try {
    const book = ctx.book;
    if (book?.locations?.length()) {
      const start = range.replace(/^epubcfi\((.*?),(.*?),.*\)$/, "epubcfi($1$2)");
      return book.locations.percentageFromCfi(start);
    }
  } catch { /* fall through */ }
  return cur?.percent || 0;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); return; } catch { /* fall back */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
    toast("Copied");
  } catch { toast("Couldn't copy"); }
}

/** A tap on a highlight: the quote with its note, and what you can do with it. */
async function openQuote(id) {
  const q = marks.find((m) => m.id === id);
  if (!q) return;
  const choice = await sheet.menu({
    title: q.note ? "Note" : "Quote",
    subtitle: `“${q.text.slice(0, 200)}${q.text.length > 200 ? "…" : ""}”${q.note ? `\n\n${q.note}` : ""}`,
    items: [
      { label: "Copy", value: "copy", icon: "⧉" },
      { label: q.note ? "Edit note" : "Add a note", value: "note", icon: "✎" },
      { label: "Delete", value: "delete", icon: "🗑", danger: true },
    ],
  });
  if (choice === "copy") copy(q.note ? `${q.text}\n\n${q.note}` : q.text);
  else if (choice === "note") {
    const note = await sheet.ask({ title: "Note", value: q.note || "", multiline: true, placeholder: "Your note", ok: "Save" });
    if (note === null) return;
    await save({ ...q, note });
    highlight(marks.find((m) => m.id === id));
  } else if (choice === "delete") {
    await remove(id);
    try { ctx.rendition()?.annotations.remove(q.cfi, "highlight"); } catch { /* ignore */ }
    toast(q.note ? "Note deleted" : "Quote deleted", async () => { await save(q); highlight(q); });
  }
}

// ------------------------------------------------------------------ storage

async function save(m) {
  await db.put("marks", m);
  const i = marks.findIndex((x) => x.id === m.id);
  if (i >= 0) marks[i] = m; else marks.push(m);
  marks.sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0) || a.createdAt - b.createdAt);
  renderLists();
}
async function remove(id) {
  await db.del("marks", id);
  marks = marks.filter((m) => m.id !== id);
  renderLists();
}

// ------------------------------------------------------------------ navigation panel tabs

function renderLists() {
  const bms = bookmarks(), qs = quotes(), ns = qs.filter((q) => q.note);
  $("bm-list").innerHTML = bms.length ? bms.map(row).join("") : empty("No bookmarks yet", "Tap the bookmark at the top of a page to add one.");
  $("q-list").innerHTML = qs.length ? qs.map(row).join("") : empty("No quotes yet", "Select some text and choose Quote.");
  $("n-list").innerHTML = ns.length ? ns.map(row).join("") : empty("No notes yet", "Select some text and choose Note.");
  for (const [tab, n] of [["bookmarks", bms.length], ["quotes", qs.length], ["notes", ns.length]]) {
    const c = document.querySelector(`[data-nav="${tab}"] .nav-n`);
    if (c) c.textContent = n ? String(n) : "";
  }
}
const empty = (h, p) => `<div class="nav-empty"><b>${h}</b><span>${p}</span></div>`;
function row(m) {
  const where = ctx?.isPdf && m.kind === "bookmark" ? `Page ${String(m.cfi).split(":")[1]}` : [m.chapter, pct(m.percent)].filter(Boolean).join(" · ");
  return `<div class="mark-row" data-id="${escapeHtml(m.id)}">
    <button class="mark-go" data-go>
      <span class="mark-where">${escapeHtml(where)}</span>
      <span class="mark-text${m.kind === "quote" ? " q" : ""}">${escapeHtml(m.text || "—")}</span>
      ${m.note ? `<span class="mark-note">${escapeHtml(m.note)}</span>` : ""}
    </button>
    <button class="mark-x" data-x title="Delete" aria-label="Delete">✕</button>
  </div>`;
}

async function onListClick(e) {
  const r = e.target.closest(".mark-row");
  if (!r) return;
  const m = marks.find((x) => x.id === r.dataset.id);
  if (!m) return;
  if (e.target.closest("[data-x]")) {
    await remove(m.id);
    if (m.kind === "quote") try { ctx.rendition()?.annotations.remove(m.cfi, "highlight"); } catch { /* ignore */ }
    onRelocated(loc);
    toast("Deleted", async () => { await save(m); if (m.kind === "quote") highlight(m); onRelocated(loc); });
    return;
  }
  if (e.target.closest("[data-go]")) ctx.jump(m.cfi);
}

/** All marks of a book (for "About" counts). */
export const counts = () => ({ bookmarks: bookmarks().length, quotes: quotes().length, notes: quotes().filter((q) => q.note).length });
