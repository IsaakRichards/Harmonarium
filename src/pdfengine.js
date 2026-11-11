// PDF engine (pdf.js). Loaded only when a PDF is added or opened, so EPUB-only use never pays
// for it and older webviews that can't run pdf.js still read EPUBs.
//
// The view is a vertical, continuous stack of pages fitted to the screen's width, the way
// ReadEra shows documents: scroll with a finger, tap the edges (or press ←/→) to move a screen,
// tap the middle for the toolbars, pinch or use Zoom to enlarge. Pages are drawn when they come
// near the screen and dropped again when far away, so long documents stay light.
//
// Positions are written as "pdf:<page>:<fraction of that page>", e.g. "pdf:12:0.400".

let lib = null;
async function pdfjs() {
  if (lib) return lib;
  const [m, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  m.GlobalWorkerOptions.workerSrc = worker.default;
  lib = m;
  return lib;
}

/** Is this file a PDF? (by name, type or its "%PDF" header) */
export function isPdf(name = "", type = "", bytes = null) {
  if (/\.pdf$/i.test(name) || type === "application/pdf") return true;
  if (bytes && bytes.byteLength > 4) {
    const h = new Uint8Array(bytes, 0, 5);
    return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46; // %PDF
  }
  return false;
}

/** Open a PDF from its bytes (the buffer is copied, so the caller's stays usable). */
export async function load(buf) {
  const L = await pdfjs();
  const task = L.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;
  if (!doc.loadingTask) doc.loadingTask = task;
  return doc;
}

/** Free a document (pdf.js moved destroy() from the document to its loading task over versions). */
export function close(doc) {
  try {
    if (typeof doc?.destroy === "function") doc.destroy();
    else doc?.loadingTask?.destroy?.();
  } catch { /* already gone */ }
}

/** Title, author, page count and a cover (page 1 drawn small) for the library. */
export async function metadata(buf, fallbackName) {
  const doc = await load(buf);
  try {
    let info = {};
    try { info = (await doc.getMetadata()).info || {}; } catch { /* none */ }
    let cover = null;
    try {
      const page = await doc.getPage(1);
      const v1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 240 / v1.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      cover = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    } catch { /* no cover */ }
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const title = clean(info.Title);
    return {
      title: title && !/^untitled|^microsoft word/i.test(title) ? title : fallbackName.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim(),
      author: clean(info.Author),
      cover,
      pages: doc.numPages,
    };
  } finally {
    close(doc);
  }
}

/** The document outline as flat contents entries: { label, page, depth }. */
export async function outline(doc) {
  let items = [];
  try { items = (await doc.getOutline()) || []; } catch { return []; }
  const out = [];
  async function pageOf(dest) {
    try {
      const d = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(d) || !d.length) return null;
      const ref = d[0];
      return (typeof ref === "number" ? ref : await doc.getPageIndex(ref)) + 1;
    } catch { return null; }
  }
  async function walk(list, depth) {
    for (const it of list) {
      const page = it.dest ? await pageOf(it.dest) : null;
      if (page) out.push({ label: String(it.title || "").trim(), page, depth });
      if (it.items?.length) await walk(it.items, depth + 1);
    }
  }
  await walk(items, 0);
  return out;
}

/** Parse "pdf:12:0.400" → { page: 12, frac: 0.4 } (null if it isn't a PDF position). */
export function parsePos(s) {
  const m = /^pdf:(\d+)(?::([\d.]+))?$/.exec(String(s || ""));
  return m ? { page: Number(m[1]), frac: Math.min(1, Number(m[2] || 0)) } : null;
}
export const pos = (page, frac = 0) => `pdf:${page}:${Math.max(0, Math.min(1, frac)).toFixed(3)}`;

/**
 * Find text. Calls onHit({ page, excerpt }) as pages are searched; returns all hits.
 * `signal.cancelled = true` stops it.
 */
export async function search(doc, query, { onHit, onProgress, signal = {} } = {}) {
  const q = query.trim().toLowerCase();
  const hits = [];
  if (!q) return hits;
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal.cancelled) break;
    try {
      const page = await doc.getPage(n);
      const text = (await page.getTextContent()).items.map((i) => i.str + (i.hasEOL ? " " : "")).join("").replace(/\s+/g, " ");
      const low = text.toLowerCase();
      let at = low.indexOf(q), found = 0;
      while (at >= 0 && found < 20) {
        const a = Math.max(0, at - 40), b = Math.min(text.length, at + q.length + 60);
        const hit = { page: n, excerpt: (a > 0 ? "…" : "") + text.slice(a, b) + (b < text.length ? "…" : ""), at: at - a + (a > 0 ? 1 : 0), len: q.length };
        hits.push(hit); onHit?.(hit); found++;
        at = low.indexOf(q, at + q.length);
      }
    } catch { /* unreadable page */ }
    onProgress?.(n / doc.numPages);
  }
  return hits;
}

/** The first line or so of text on a page (for bookmarks). */
export async function pageSnippet(doc, n) {
  try {
    const page = await doc.getPage(n);
    const t = (await page.getTextContent()).items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
    return t.slice(0, 140);
  } catch { return ""; }
}

/**
 * Show a document in `el`.
 * hooks.onMove({ page, frac, percent, atEnd }) — the position changed (scrolling, jumps)
 * hooks.onTap(zone) — a tap: "prev" | "next" | "middle"
 */
export function view(el, doc, hooks = {}) {
  const pages = doc.numPages;
  let zoom = 1;
  let base = null;          // page 1's size at scale 1, used until a page's own size is known
  const sizes = new Map();  // page number → { w, h } at scale 1
  const drawn = new Map();  // page number → { canvas, scale, task }
  let destroyed = false;

  el.innerHTML = `<div class="pdf-scroll" tabindex="-1"><div class="pdf-pages"></div></div>`;
  const scroller = el.querySelector(".pdf-scroll");
  const stack = el.querySelector(".pdf-pages");
  const boxes = [];
  for (let n = 1; n <= pages; n++) {
    const d = document.createElement("div");
    d.className = "pdf-page";
    d.dataset.n = String(n);
    stack.appendChild(d);
    boxes.push(d);
  }

  const dpr = () => Math.min(2, window.devicePixelRatio || 1);
  const fitWidth = () => Math.max(120, scroller.clientWidth - (scroller.clientWidth > 700 ? 48 : 8));
  const pageWidth = () => Math.round(fitWidth() * zoom);
  const sizeOf = (n) => sizes.get(n) || base || { w: 612, h: 792 };

  function layout() {
    const w = pageWidth();
    for (let n = 1; n <= pages; n++) {
      const s = sizeOf(n);
      const b = boxes[n - 1];
      b.style.width = `${w}px`;
      b.style.height = `${Math.round(w * s.h / s.w)}px`;
    }
    stack.classList.toggle("zoomed", zoom > 1.01);
  }

  async function draw(n) {
    if (destroyed) return;
    const want = pageWidth() * dpr();
    const have = drawn.get(n);
    if (have && Math.abs(have.width - want) < 2) return;
    try {
      const page = await doc.getPage(n);
      if (destroyed) return;
      const v1 = page.getViewport({ scale: 1 });
      if (!sizes.has(n)) {
        sizes.set(n, { w: v1.width, h: v1.height });
        if (Math.abs(v1.height / v1.width - sizeOf(0).h / sizeOf(0).w) > 0.01) {
          const keep = position();
          layout();
          restore(keep);
        }
      }
      const scale = want / v1.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      have?.task?.cancel?.();
      const task = page.render({ canvasContext: ctx, viewport });
      drawn.set(n, { canvas, width: want, task });
      await task.promise;
      if (destroyed || drawn.get(n)?.canvas !== canvas) return;
      const box = boxes[n - 1];
      box.textContent = "";
      box.appendChild(canvas);
      box.classList.add("ready");
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.warn("PDF page", n, err);
    }
  }

  function drop(n) {
    const d = drawn.get(n);
    if (!d) return;
    d.task?.cancel?.();
    drawn.delete(n);
    const box = boxes[n - 1];
    box.textContent = "";
    box.classList.remove("ready");
  }

  /** Which page is at the top of the screen, and how far into it. */
  function position() {
    const top = scroller.scrollTop + 1;
    let lo = 0, hi = pages - 1;
    while (lo < hi) { // last page whose top is above the screen's top
      const mid = (lo + hi + 1) >> 1;
      if (boxes[mid].offsetTop <= top) lo = mid; else hi = mid - 1;
    }
    const b = boxes[lo];
    return { page: lo + 1, frac: Math.max(0, Math.min(1, (top - b.offsetTop) / Math.max(1, b.offsetHeight))) };
  }
  function restore({ page, frac = 0 }) {
    const b = boxes[Math.max(0, Math.min(pages - 1, page - 1))];
    scroller.scrollTop = Math.round(b.offsetTop + frac * b.offsetHeight);
  }

  function visibleRange() {
    const top = scroller.scrollTop, bottom = top + scroller.clientHeight;
    const first = position().page;
    let last = first;
    while (last < pages && boxes[last].offsetTop < bottom) last++;
    return { first, last, top, bottom };
  }

  let ticking = false, lastReport = "";
  function update() {
    ticking = false;
    if (destroyed) return;
    const { first, last } = visibleRange();
    for (let n = Math.max(1, first - 1); n <= Math.min(pages, last + 1); n++) draw(n);
    for (const n of [...drawn.keys()]) if (n < first - 4 || n > last + 4) drop(n);
    const p = position();
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    const percent = atEnd ? 1 : pages > 1 ? Math.min(1, (p.page - 1 + p.frac) / (pages - 1 + 0.0001)) : p.frac;
    const key = pos(p.page, p.frac);
    if (key !== lastReport) { lastReport = key; hooks.onMove?.({ ...p, percent, atEnd, last }); }
  }
  const schedule = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  scroller.addEventListener("scroll", schedule, { passive: true });

  // Taps: left third back, right third forward, middle toggles the bars.
  let down = null;
  scroller.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now(), top: scroller.scrollTop }; });
  scroller.addEventListener("click", (e) => {
    if (!down || Math.abs(e.clientX - down.x) > 10 || Math.abs(e.clientY - down.y) > 10 || Math.abs(scroller.scrollTop - down.top) > 4) return;
    if (pinch.used) { pinch.used = false; return; }
    const r = scroller.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    hooks.onTap?.(x < 0.3 ? "prev" : x > 0.7 ? "next" : "middle");
  });

  // Pinch to zoom (two fingers), Ctrl + wheel on desktop.
  const pinch = { d0: 0, z0: 1, used: false };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroller.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) { pinch.d0 = dist(e.touches); pinch.z0 = zoom; pinch.used = true; }
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 2 || !pinch.d0) return;
    const s = dist(e.touches) / pinch.d0;
    stack.style.transformOrigin = "50% 0";
    stack.style.transform = `scale(${Math.max(0.5 / pinch.z0, Math.min(5 / pinch.z0, s))})`;
  }, { passive: true });
  scroller.addEventListener("touchend", (e) => {
    if (!pinch.d0 || e.touches.length) return;
    const m = /scale\(([\d.]+)\)/.exec(stack.style.transform);
    stack.style.transform = "";
    pinch.d0 = 0;
    if (m) api.setZoom(pinch.z0 * Number(m[1]));
  });
  scroller.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    api.setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  const api = {
    pages,
    get zoom() { return zoom; },
    async start(at) {
      try { const p1 = await doc.getPage(1); const v = p1.getViewport({ scale: 1 }); base = { w: v.width, h: v.height }; sizes.set(1, base); } catch { /* keep default */ }
      layout();
      const p = parsePos(at) || { page: 1, frac: 0 };
      restore(p);
      update();
    },
    /** Move a screen forward (+1) or back (−1). */
    turn(dir) {
      const step = Math.max(80, scroller.clientHeight - 48) * dir;
      scroller.scrollBy({ top: step, behavior: "smooth" });
    },
    goTo(page, frac = 0) { restore({ page, frac }); update(); },
    display(at) { const p = parsePos(at); if (p) api.goTo(p.page, p.frac); },
    goToPercent(f) {
      const x = Math.max(0, Math.min(1, f)) * (pages - 1);
      api.goTo(Math.floor(x) + 1, x - Math.floor(x));
    },
    position,
    setZoom(z) {
      const next = Math.max(0.5, Math.min(5, z));
      if (Math.abs(next - zoom) < 0.001) return zoom;
      const keep = position();
      const cx = scroller.scrollLeft + scroller.clientWidth / 2;
      const ratio = next / zoom;
      zoom = next;
      layout();
      restore(keep);
      scroller.scrollLeft = Math.max(0, cx * ratio - scroller.clientWidth / 2);
      update();
      return zoom;
    },
    resize() { const keep = position(); layout(); restore(keep); update(); },
    focus() { scroller.focus({ preventScroll: true }); },
    destroy() {
      destroyed = true;
      for (const n of [...drawn.keys()]) drop(n);
      el.innerHTML = "";
    },
  };
  return api;
}
