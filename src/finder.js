// Find in book, Go to page, and the "back" chip after a jump.
//
// Search is the reading engine's own (foliate-js): it runs chapter by chapter (EPUB) or page by
// page (PDF), outlines every match in the book and fills the results as it goes; a tap on a result jumps there and marks the match. Every jump (contents, search,
// bookmarks, quotes, go to, the slider) leaves a chip at the bottom of the page that takes
// you back to where you were, like ReadEra's return arrow.
import * as sheet from "./sheet.js";
import { escapeHtml, toast } from "./util.js";

const $ = (id) => document.getElementById(id);
let ctx = null;   // { isPdf, view(), display(at), current(), chapterFor(at), pages(), pageNow() … }
let run = null;   // { cancelled }
let found = null; // the CFI of the marked match
let back = [];    // places to return to: { at, page }

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
    if (to) ctx?.display(to.at);
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
export function close() {
  $("find-panel")?.classList.add("hidden");
  stop();
  try { ctx?.view()?.clearSearch(); } catch { /* nothing outlined */ }
}

function stop() { if (run) run.cancelled = true; run = null; }

/** Remember where we are before a jump, and show the back chip. */
export function noteJump() {
  const cur = ctx?.current();
  if (!cur?.cfi) return;
  if (back[back.length - 1]?.at !== cur.cfi) back.push({ at: cur.cfi, page: ctx.pageNow?.() || 0 });
  if (back.length > 20) back.shift();
  chip();
}
function chip() {
  const c = $("jump-back");
  if (!c) return;
  c.hidden = !back.length;
  const n = back.length ? back[back.length - 1].page : 0;
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
  try { Promise.resolve(ctx?.view()?.deleteAnnotation({ value: found })).catch(() => {}); } catch { /* ignore */ }
  found = null;
}
function markFound(at) {
  clearMark();
  try {
    Promise.resolve(ctx.view().addAnnotation({ value: at, kind: "find" })).catch(() => {});
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
    const v = ctx.view();
    for await (const r of v.search({ query: q })) {
      if (me.cancelled) break;
      if (r === "done") break;
      if (r.progress != null) { if (run === me) $("find-status").textContent = `Searching… ${Math.round(r.progress * 100)}%`; continue; }
      if (!r.subitems) continue;
      const where = ctx.isPdf ? `Page ${r.index + 1}` : r.label || ctx.chapterFor(r.subitems[0]?.cfi) || `Part ${r.index + 1}`;
      for (const it of r.subitems) {
        const ex = it.excerpt || {};
        add(it.cfi, where, `${ex.pre || ""}${ex.match || ""}${ex.post || ""}`.replace(/\s+/g, " ").trim());
      }
    }
  } catch (err) {
    console.warn("search", err);
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
