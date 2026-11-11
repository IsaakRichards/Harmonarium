// Find in book, Go to page, and the "back" chip after a jump.
//
// Search runs chapter by chapter (EPUB) or page by page (PDF) and fills the results as it
// goes; a tap on a result jumps there and marks the match. Every jump (contents, search,
// bookmarks, quotes, go to, the slider) leaves a chip at the bottom of the page that takes
// you back to where you were, like ReadEra's return arrow.
import * as pdfengine from "./pdfengine.js";
import * as sheet from "./sheet.js";
import { escapeHtml, toast } from "./util.js";

const $ = (id) => document.getElementById(id);
let ctx = null;   // { isPdf, book, pdfDoc, display(cfi), current(), chapterFor(href), rendition(), pages() }
let run = null;   // { cancelled }
let found = null; // the CFI of the marked match
let back = [];    // positions to return to

export function init() {
  $("find-form").addEventListener("submit", (e) => { e.preventDefault(); search($("find-q").value); });
  $("find-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-at]");
    if (!b) return;
    go(b.dataset.at, true);
    if (window.innerWidth < 700) close();
  });
  $("jump-back").addEventListener("click", (e) => {
    if (e.target.closest("[data-dismiss-back]")) { back = []; chip(); return; }
    const to = back.pop();
    chip();
    if (to) ctx?.display(to);
  });
}

export function load(c) { ctx = c; back = []; chip(); reset(); }
export function unload() { stop(); clearMark(); ctx = null; back = []; chip(); close(); reset(); }

function reset() {
  $("find-q").value = "";
  $("find-results").innerHTML = "";
  $("find-status").textContent = "";
}

export const isOpen = () => !$("find-panel").classList.contains("hidden");
export function open(q) {
  $("find-panel").classList.remove("hidden");
  document.body.classList.remove("immersive");
  if (q) { $("find-q").value = q; search(q); }
  setTimeout(() => $("find-q").focus(), 30);
}
export function close() { $("find-panel")?.classList.add("hidden"); stop(); }

function stop() { if (run) run.cancelled = true; run = null; }

/** Remember where we are before a jump, and show the back chip. */
export function noteJump() {
  const cur = ctx?.current();
  if (!cur?.cfi) return;
  if (back[back.length - 1] !== cur.cfi) back.push(cur.cfi);
  if (back.length > 20) back.shift();
  chip();
}
function chip() {
  const c = $("jump-back");
  if (!c) return;
  c.hidden = !back.length;
  const n = back.length ? ctx?.pageOf?.(back[back.length - 1]) : 0;
  $("jump-label").textContent = n ? `to page ${n}` : "Back";
}

/** Jump somewhere, leaving a way back. */
export function go(at, mark = false) {
  if (!ctx) return;
  noteJump();
  ctx.display(at);
  if (mark && !ctx.isPdf) markFound(at);
}

function clearMark() {
  if (!found) return;
  try { ctx?.rendition()?.annotations.remove(found, "highlight"); } catch { /* ignore */ }
  found = null;
}
function markFound(at) {
  clearMark();
  try {
    ctx.rendition().annotations.highlight(at, {}, () => clearMark(), "hm-find", { fill: "#4fa3f7", "fill-opacity": "0.45" });
    found = at;
  } catch { /* ignore */ }
}

async function search(query) {
  const q = String(query || "").trim();
  stop();
  clearMark();
  const out = $("find-results");
  out.innerHTML = "";
  if (q.length < 2) { $("find-status").textContent = q ? "Type at least two letters" : ""; return; }
  const me = (run = { cancelled: false });
  let n = 0;
  const add = (at, where, excerpt) => {
    if (n >= 500) return;
    n++;
    const i = excerpt.toLowerCase().indexOf(q.toLowerCase());
    const html = i >= 0
      ? `${escapeHtml(excerpt.slice(0, i))}<mark>${escapeHtml(excerpt.slice(i, i + q.length))}</mark>${escapeHtml(excerpt.slice(i + q.length))}`
      : escapeHtml(excerpt);
    out.insertAdjacentHTML("beforeend", `<button class="find-hit" data-at="${escapeHtml(at)}"><small>${escapeHtml(where)}</small><span>${html}</span></button>`);
  };
  $("find-status").textContent = "Searching…";
  try {
    if (ctx.isPdf) {
      await pdfengine.search(ctx.pdfDoc, q, {
        signal: me,
        onHit: (h) => add(pdfengine.pos(h.page), `Page ${h.page}`, h.excerpt.trim()),
        onProgress: (f) => { if (run === me) $("find-status").textContent = `Searching… ${Math.round(f * 100)}%`; },
      });
    } else {
      const book = ctx.book;
      const items = book.spine.spineItems || [];
      for (let i = 0; i < items.length; i++) {
        if (me.cancelled) break;
        const section = items[i];
        try {
          await section.load(book.load.bind(book));
          for (const r of section.find(q)) add(r.cfi, ctx.chapterFor(section.href) || `Part ${i + 1}`, (r.excerpt || "").trim());
        } catch { /* skip unreadable part */ }
        try { section.unload(); } catch { /* ignore */ }
        if (run === me) $("find-status").textContent = `Searching… ${Math.round(((i + 1) / items.length) * 100)}%`;
      }
    }
  } finally {
    if (run === me) {
      run = null;
      $("find-status").textContent = n ? `${n >= 500 ? "500+" : n} found` : "Nothing found";
    }
  }
}

/** Go to a page number or a percentage. */
export async function goTo() {
  if (!ctx) return;
  const pages = ctx.pages();
  const cur = ctx.current();
  const label = pages ? `Page (1–${pages}) or percent, e.g. 40%` : "Percent, e.g. 40%";
  const v = await sheet.ask({ title: "Go to", label, value: "", placeholder: pages ? String(ctx.pageNow() || 1) : `${Math.round((cur?.percent || 0) * 100)}%`, ok: "Go", inputmode: "decimal" });
  if (v === null || v === "") return;
  const m = /^(\d+(?:\.\d+)?)\s*(%?)$/.exec(v.replace(",", "."));
  if (!m) { toast("Type a page number or a percent"); return; }
  const n = Number(m[1]);
  noteJump();
  if (m[2] === "%" || !pages) ctx.goToPercent(Math.min(100, n) / 100);
  else ctx.goToPage(Math.max(1, Math.min(pages, Math.round(n))));
}
