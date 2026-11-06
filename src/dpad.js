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
// Keypad mode (on by default on Sailfish OS, e.g. the Commodore Callback 8020, and on devices
// with no pointer) adds T9-style number keys:
//   2 4 6 8 / 5   same as the arrows / OK
//   Home          1 Shelf · 3 Lists · 0 Add books (Shelf) · * Search · # Settings
//   Reader        1 Contents · 3 Text settings · * smaller text · # larger text · 0 next theme
// and the phone's own keys (Back, Select, Menu / soft keys) arrive through window.starbornKey().
//
// The focus ring only shows once a d-pad key is used; touch or the mouse hides it again.

const FOCUSABLE = [
  "button:not([disabled])", "a[href]", "select:not([disabled])", "textarea",
  "input:not([type=hidden]):not([type=file]):not([disabled])",
  "label.add-btn", "[tabindex]:not([tabindex='-1'])",
].join(",");

const TYPING = new Set(["text", "search", "url", "email", "password", "number", "tel", ""]);
let reader = null;
let hooks = { openSettings: () => {}, addBooks: () => {} };
let keypad = false;

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

/** Keypad mode: always show the focus ring, number-key shortcuts, no trips to websites. */
export function setKeypad(on) {
  keypad = !!on;
  document.body.classList.toggle("keypad", keypad);
  if (keypad) { document.body.classList.add("dpad"); later(ensureFocus, 300); }
}
export const isKeypad = () => keypad;

export function init(readerApi, h = {}) {
  reader = readerApi;
  hooks = { ...hooks, ...h };
  document.addEventListener("keydown", (e) => handle(e), true);
  // Hardware keys a webview can't see (Back, Select, Menu, soft keys) are forwarded by
  // the Sailfish shell as window.starbornKey("back" | "ok" | "menu" | …).
  window.starbornKey = (name) => { handle(synthetic(NAMED[name] || name)); return true; };
  // Never leave the app for a website: on keypad phones there's no way back.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || !keypad) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) { e.preventDefault(); e.stopPropagation(); toastFn("Links to websites are turned off here"); }
  }, true);
  const off = () => document.body.classList.remove("dpad");
  document.addEventListener("mousedown", off, true);
  document.addEventListener("touchstart", off, { capture: true, passive: true });
  initGamepads();
}

const NAMED = { back: "Escape", ok: "Enter", menu: "ContextMenu", softleft: "ContextMenu", softright: "Escape",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
const DIGIT_ARROWS = { 2: "up", 8: "down", 4: "left", 6: "right", 5: "ok" };

function synthetic(key) {
  let prevented = false;
  return { key, synthetic: true, ctrlKey: false, altKey: false, metaKey: false,
    get defaultPrevented() { return false; }, preventDefault() { prevented = true; }, stopPropagation() {}, get _prevented() { return prevented; } };
}

let toastFn = () => {};
export function setToast(fn) { toastFn = fn; }

function keyOf(e) {
  if (keypad && DIGIT_ARROWS[e.key]) return DIGIT_ARROWS[e.key];
  switch (e.key) {
    case "ArrowUp": case "Up": return "up";
    case "ArrowDown": case "Down": return "down";
    case "ArrowLeft": case "Left": return "left";
    case "ArrowRight": case "Right": return "right";
    case "Enter": case " ": case "Spacebar": case "Select": return "ok";
    case "Escape": case "Esc": case "Backspace": case "BrowserBack": case "GoBack": return "back";
    case "ContextMenu": case "F10": return "menu";
    case "PageDown": case "MediaTrackNext": return "pagenext";
    case "PageUp": case "MediaTrackPrevious": return "pageprev";
    default: return null;
  }
}

/** Main key handler. Also called by the reader for keys pressed inside the book's frame. */
export function handle(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  const a = document.activeElement;
  const tag = a?.tagName;
  const field = tag === "TEXTAREA" || (tag === "INPUT" && TYPING.has(a.type));

  // Keypad phones: a text field is only "typing" after OK/5 is pressed on it, so number keys
  // keep moving around instead of filling the field. Back or Up/Down leave the field.
  if (keypad && field && !a.dataset.typing) {
    const k1 = keyOf(e);
    if (k1 === "ok") {
      e.preventDefault();
      a.dataset.typing = "1";
      a.classList.add("typing");
      if (a.dataset.ph !== undefined) a.placeholder = a.dataset.ph;
      if (a.setSelectionRange && a.value) try { a.setSelectionRange(a.value.length, a.value.length); } catch {}
      return;
    }
    if (!k1 && /^[0-9*#]$/.test(e.key)) { e.preventDefault(); return; } // swallow stray digits
  }
  const typing = field && (!keypad || !!a.dataset.typing);
  if (keypad && typing && (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || e.synthetic && e.key === "Escape")) {
    e.preventDefault(); e.stopPropagation(); stopTyping(a); return;
  }
  const k0 = keyOf(e);
  // In text fields, number keys are for typing.
  const k = k0 && /^[0-9]$/.test(e.key) && typing ? null : k0;
  if (!k) { if (keypad && !typing) shortcut(e); return; }

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
  if (k === "menu") { e.preventDefault(); hooks.openSettings(); later(ensureFocus, 150); return; }
  if (k === "ok") {
    if (!a || a === document.body || !scope().contains(a)) { e.preventDefault(); focusFirst(); return; }
    // Keys that aren't a real Enter (keypad 5, Select, gamepad A) don't press buttons on their own.
    if (e.synthetic || e.key !== "Enter" && e.key !== " ") { e.preventDefault(); if (tag === "SELECT") a.focus(); else a.click(); later(ensureFocus, 120); return; }
    // Buttons, links and checkboxes activate natively; labels and custom controls don't.
    if (tag === "LABEL" || a.matches("[tabindex]:not(button):not(a):not(input)")) { e.preventDefault(); a.click(); }
    later(ensureFocus, 120);
    return;
  }
  if (k === "pagenext" || k === "pageprev") return; // let the page scroll
  e.preventDefault();
  move(k);
}

function stopTyping(el) {
  if (!el?.dataset) return;
  delete el.dataset.typing;
  el.classList.remove("typing");
}
document.addEventListener("focusout", (e) => {
  stopTyping(e.target);
  if (e.target?.dataset?.ph !== undefined) { e.target.placeholder = e.target.dataset.ph; delete e.target.dataset.ph; }
}, true);
// In keypad mode, a focused text field says how to start typing.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!keypad || !el || !(el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TYPING.has(el.type)))) return;
  if (el.dataset.ph === undefined) { el.dataset.ph = el.placeholder || ""; el.placeholder = "Press 5 or OK to type"; }
}, true);

// ---------------------------------------------------------------- keypad shortcuts

function shortcut(e) {
  const key = e.key;
  if (!/^[0-9*#]$/.test(key)) return;
  const reading = document.body.classList.contains("reading");
  if (reading && reader) {
    const act = { 1: reader.toggleContents, 3: reader.toggleText, "*": () => reader.textSize(-1), "#": () => reader.textSize(1), 0: reader.cycleTheme }[key];
    if (!act) return;
    e.preventDefault(); document.body.classList.add("dpad"); act();
    if (key === "1") later(() => focusIn("#toc-drawer"), 60);
    if (key === "3") later(() => focusIn("#aa-panel"), 60);
    return;
  }
  if (shown($("#panel")) || shown($("#device-books"))) return;
  const tab = (name) => { const b = $(`.tabs [data-tab="${name}"]`); if (b) { b.click(); focusEl(b); } };
  const act = {
    1: () => tab("shelf"),
    3: () => tab("lists"),
    0: () => { if (document.body.dataset.tab === "shelf") hooks.addBooks(); },
    "*": () => { const q = document.body.dataset.tab === "lists" ? $("#q") : $("#lib-search"); q && q.focus(); },
    "#": () => hooks.openSettings(),
  }[key];
  if (!act) return;
  e.preventDefault(); document.body.classList.add("dpad"); act();
  later(ensureFocus, 150);
}

// ---------------------------------------------------------------- reader

function readerKey(k, e, a) {
  const bars = reader.barsVisible();
  const overlay = reader.overlayOpen(); // contents, text settings or the jump banner
  const inBars = !!a && bars && ["#reader-bar", "#reader-foot"].some((s) => $(s).contains(a));
  const inOverlay = !!a && overlay && ["#toc-drawer", "#aa-panel", "#sync-banner"].some((s) => $(s).contains(a));
  const inChrome = inBars || inOverlay;

  if (k === "menu") { e.preventDefault(); reader.toggleText(); later(() => focusIn("#aa-panel"), 60); return true; }
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
    if (k === "ok") {
      if (e.synthetic || (e.key !== "Enter" && e.key !== " ")) { e.preventDefault(); a.click(); later(ensureFocus, 120); return true; }
      later(ensureFocus, 120); return false;
    }
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
  if (key === "Enter" && !ev.defaultPrevented && target !== document.body && target.click && target.tagName !== "SELECT") target.click();
}
