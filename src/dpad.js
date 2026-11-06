// D-pad navigation: arrow keys, OK/Enter and Back move a visible focus around the app,
// so Starborn works with keypads, TV remotes, game controllers and phones with
// hardware keys (Sailfish, Android) as well as with touch and mouse.
//
//   Arrows   move focus to the nearest control in that direction
//   OK       Enter / Space / gamepad A: press the focused control
//   Back     Escape / Backspace / BrowserBack / gamepad B: close the top layer, or leave the book
//   Reader   Left/Right turn pages, Up/Down bring up the bars, OK toggles them,
//            gamepad shoulders (LB/RB) also turn pages
//
// The focus ring only shows once a d-pad key is used; touch or the mouse hides it again.

const FOCUSABLE = [
  "button:not([disabled])", "a[href]", "select:not([disabled])", "textarea",
  "input:not([type=hidden]):not([type=file]):not([disabled])",
  "label.add-btn", "[tabindex]:not([tabindex='-1'])",
].join(",");

const TYPING = new Set(["text", "search", "url", "email", "password", "number", "tel", ""]);
let reader = null;

const $ = (sel) => document.querySelector(sel);
const shown = (el) => !!el && !el.hidden && !el.classList.contains("hidden");

/** Remember a control to return to (e.g. the book card after closing the reader). */
let returnTo = null;
export function rememberFocus() {
  const el = document.activeElement;
  returnTo = { el, id: el?.closest?.("[data-id]")?.dataset.id };
}
export function restoreFocus() {
  const r = returnTo; returnTo = null;
  if (!document.body.classList.contains("dpad")) return;
  later(() => {
    // Lists re-render, so the old element may be gone: find its replacement by data-id.
    let el = r?.el && document.contains(r.el) ? r.el : null;
    if (!el && r?.id) {
      const holder = [...document.querySelectorAll("[data-id]")].find((n) => n.dataset.id === r.id);
      el = holder && candidates(holder)[0];
    }
    if (el && visible(el)) focusEl(el); else ensureFocus();
  }, 80);
}
/** Put focus on the page (used when a book opens). */
export function focusPage() { document.activeElement?.blur?.(); }

export function init(readerApi) {
  reader = readerApi;
  document.addEventListener("keydown", (e) => handle(e), true);
  const off = () => document.body.classList.remove("dpad");
  document.addEventListener("mousedown", off, true);
  document.addEventListener("touchstart", off, { capture: true, passive: true });
  initGamepads();
}

function keyOf(e) {
  switch (e.key) {
    case "ArrowUp": case "Up": return "up";
    case "ArrowDown": case "Down": return "down";
    case "ArrowLeft": case "Left": return "left";
    case "ArrowRight": case "Right": return "right";
    case "Enter": case " ": case "Spacebar": case "Select": return "ok";
    case "Escape": case "Esc": case "Backspace": case "BrowserBack": case "GoBack": return "back";
    case "PageDown": case "MediaTrackNext": return "pagenext";
    case "PageUp": case "MediaTrackPrevious": return "pageprev";
    default: return null;
  }
}

/** Main key handler. Also called by the reader for keys pressed inside the book's frame. */
export function handle(e) {
  const k = keyOf(e);
  if (!k || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  const a = document.activeElement;
  const tag = a?.tagName;
  const typing = tag === "TEXTAREA" || (tag === "INPUT" && TYPING.has(a.type));

  // Leave text fields, dropdowns and sliders their normal keys.
  if (typing && (k === "left" || k === "right" || k === "ok" || (k === "back" && e.key === "Backspace"))) return;
  if (tag === "SELECT" && k === "ok") return;
  if (tag === "INPUT" && a.type === "range" && (k === "left" || k === "right")) return;
  if (e.key === " " && typing) return;

  if (k !== "ok" || !a || a === document.body) document.body.classList.add("dpad");

  if (document.body.classList.contains("reading") && reader && readerKey(k, e, a)) return;

  if (k === "back") {
    // The lists' own Escape handler closes the panel, search results and drags.
    if (e.key !== "Escape") {
      e.preventDefault();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    later(ensureFocus);
    return;
  }
  if (k === "ok") {
    if (!a || a === document.body || !scope().contains(a)) { e.preventDefault(); focusFirst(); return; }
    // Buttons, links and checkboxes activate natively; labels and custom controls don't.
    if (tag === "LABEL" || a.matches("[tabindex]:not(button):not(a):not(input)")) { e.preventDefault(); a.click(); }
    later(ensureFocus, 120);
    return;
  }
  if (k === "pagenext" || k === "pageprev") return; // let the page scroll
  e.preventDefault();
  move(k);
}

// ---------------------------------------------------------------- reader

function readerKey(k, e, a) {
  const bars = reader.barsVisible();
  const overlay = reader.overlayOpen(); // contents, text settings or the jump banner
  const inBars = !!a && bars && ["#reader-bar", "#reader-foot"].some((s) => $(s).contains(a));
  const inOverlay = !!a && overlay && ["#toc-drawer", "#aa-panel", "#sync-banner"].some((s) => $(s).contains(a));
  const inChrome = inBars || inOverlay;

  if (k === "back") {
    e.preventDefault(); e.stopPropagation();
    if (overlay) { reader.closeOverlays(); focusIn("#reader-bar"); }
    else if (bars && inChrome) { a.blur(); reader.hideBars(); }
    else reader.close();
    return true;
  }
  if (overlay || inChrome) {
    // Navigating the bars / panels: normal focus movement, but Up from the top bar
    // or Down from the footer drops back to the page.
    if (k === "ok") { later(ensureFocus, 120); return false; }
    if (k === "pagenext" || k === "pageprev") { e.preventDefault(); k === "pagenext" ? reader.next() : reader.prev(); return true; }
    e.preventDefault(); e.stopPropagation();
    if (!move(k) && !overlay && (k === "up" || k === "down")) { a.blur(); reader.hideBars(); }
    return true;
  }
  // On the page itself.
  e.preventDefault(); e.stopPropagation();
  switch (k) {
    case "left": case "pageprev": reader.prev(); break;
    case "right": case "pagenext": reader.next(); break;
    case "up": reader.showBars(); focusIn("#reader-bar"); break;
    case "down": reader.showBars(); focusIn("#reader-foot"); break;
    case "ok":
      if (e.key === " ") reader.next(); // Space still turns the page on a keyboard
      else bars ? reader.hideBars() : reader.showBars();
      break;
  }
  return true;
}

// ---------------------------------------------------------------- focus movement

/** The layer focus should stay inside: an open panel or drawer, the reader, or home. */
function scope() {
  const panel = $("#panel");
  if (shown(panel)) return panel;
  if (shown($("#device-books"))) return $("#device-books");
  if (document.body.classList.contains("reading")) {
    for (const id of ["#toc-drawer", "#aa-panel", "#sync-banner"]) if (shown($(id))) return $(id);
    return $("#view-reader");
  }
  return $("#home");
}

function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.hidden || n.classList.contains("hidden")) return false;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
  }
  return true;
}

function candidates(root = scope()) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
}

function focusEl(el) {
  if (!el) return false;
  if (el.tagName === "LABEL" && !el.hasAttribute("tabindex")) el.tabIndex = 0;
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight, vw = window.innerWidth;
  if (r.top < 70 || r.bottom > vh - 10 || r.left < 0 || r.right > vw) {
    el.scrollIntoView({ block: r.height > vh / 2 ? "start" : "center", inline: "nearest" });
  }
  return true;
}

function focusFirst() {
  const c = candidates();
  if (!c.length) return false;
  c.sort((x, y) => { const a = x.getBoundingClientRect(), b = y.getBoundingClientRect(); return (a.top - b.top) || (a.left - b.left); });
  // Prefer something already on screen.
  return focusEl(c.find((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }) || c[0]);
}

function focusIn(sel) {
  const root = $(sel);
  const c = root ? candidates(root) : [];
  return c.length ? focusEl(c[0]) : false;
}

function ensureFocus() {
  if (!document.body.classList.contains("dpad")) return;
  const a = document.activeElement;
  if (document.body.classList.contains("reading") && reader && !reader.overlayOpen()) {
    // In a book with no panel open, the page itself has focus: arrows turn pages.
    const inBars = a && ["#reader-bar", "#reader-foot"].some((s) => $(s).contains(a));
    if (a && a !== document.body && (!inBars || !reader.barsVisible())) a.blur();
    return;
  }
  if (!a || a === document.body || !scope().contains(a) || !visible(a)) focusFirst();
}

function later(fn, ms = 60) { setTimeout(fn, ms); }

/** Move focus to the best control in a direction. Returns false if there is none. */
function move(dir) {
  const a = document.activeElement;
  const root = scope();
  if (!a || a === document.body || !root.contains(a) || !visible(a)) return focusFirst();
  const f = a.getBoundingClientRect();
  const fcx = (f.left + f.right) / 2, fcy = (f.top + f.bottom) / 2;
  let best = null, bestScore = Infinity;
  for (const el of candidates(root)) {
    if (el === a || el.contains(a) || a.contains(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    let along, across, overlap;
    if (dir === "right" || dir === "left") {
      const fwd = dir === "right" ? cx > fcx + 1 && r.right > f.right - 1 : cx < fcx - 1 && r.left < f.left + 1;
      if (!fwd) continue;
      along = dir === "right" ? Math.max(0, r.left - f.right) : Math.max(0, f.left - r.right);
      overlap = r.top < f.bottom - 2 && r.bottom > f.top + 2;
      across = overlap ? 0 : Math.abs(cy - fcy);
    } else {
      const fwd = dir === "down" ? cy > fcy + 1 && r.bottom > f.bottom - 1 : cy < fcy - 1 && r.top < f.top + 1;
      if (!fwd) continue;
      along = dir === "down" ? Math.max(0, r.top - f.bottom) : Math.max(0, f.top - r.bottom);
      overlap = r.left < f.right - 2 && r.right > f.left + 2;
      across = overlap ? Math.abs(cx - fcx) * 0.1 : Math.abs(cx - fcx);
    }
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best ? focusEl(best) : false;
}

// ---------------------------------------------------------------- gamepads

const PAD_KEYS = { 12: "ArrowUp", 13: "ArrowDown", 14: "ArrowLeft", 15: "ArrowRight", 0: "Enter", 1: "Escape", 4: "PageUp", 5: "PageDown" };
let padTimer = null;
const held = new Map(); // button -> time it should repeat next

function initGamepads() {
  if (!("getGamepads" in navigator)) return;
  window.addEventListener("gamepadconnected", () => { if (!padTimer) padTimer = setInterval(pollPads, 50); });
  window.addEventListener("gamepaddisconnected", () => {
    if (![...navigator.getGamepads()].some(Boolean)) { clearInterval(padTimer); padTimer = null; held.clear(); }
  });
}

function pollPads() {
  if (document.hidden) return;
  const now = Date.now();
  const down = new Set();
  for (const pad of navigator.getGamepads()) {
    if (!pad) continue;
    for (const [btn, key] of Object.entries(PAD_KEYS)) if (pad.buttons[btn]?.pressed) down.add(key);
    // Left stick as a d-pad too.
    const [x = 0, y = 0] = pad.axes;
    if (x < -0.6) down.add("ArrowLeft"); if (x > 0.6) down.add("ArrowRight");
    if (y < -0.6) down.add("ArrowUp"); if (y > 0.6) down.add("ArrowDown");
  }
  for (const key of [...held.keys()]) if (!down.has(key)) held.delete(key);
  for (const key of down) {
    const next = held.get(key);
    if (next !== undefined && now < next) continue;
    held.set(key, now + (next === undefined ? 380 : 120)); // first repeat after a pause, then faster
    if (key.startsWith("Arrow") || next === undefined) fire(key); // only arrows repeat while held
  }
}

function fire(key) {
  const target = document.activeElement || document.body;
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  // Synthetic Enter doesn't press buttons by itself; do it for real.
  if (key === "Enter" && !ev.defaultPrevented && target !== document.body && target.click) target.click();
}
