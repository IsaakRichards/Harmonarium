// ReadEra look & feel (Settings → Appearance → "Look and feel like ReadEra").
//
// One switch that dresses the whole app as the ReadEra Android reader: a plain Material
// app bar with a ☰ drawer instead of the crest and tabs, books as a list with small covers
// (or a grid), search behind an icon, a round + button for adding books, and a reader that
// opens full-screen with only a quiet status line, toolbars that float over the page on a
// tap, the Contents / Text / Day–Night buttons along the bottom, and a bottom-sheet for text
// settings. Harmonarium's own extras (lists, series rings, sheet sync, d-pad) stay, dressed
// to match.
//
// Saved per device: hm-readera = "1" | "" and hm-readera-tone = "auto" | "light" | "dark".
// index.html applies it before first paint as <html data-readera="light|dark">; the
// styles live in the "ReadEra look" section at the end of src/styles.css.

import { SOLO, APP_NAME, ICON as APP_ICON } from "./flavor.js";

const KEY = "hm-readera";
const TONE_KEY = "hm-readera-tone";
const VIEW_KEY = "hm-re-view";
const BAR = { light: "#ffffff", dark: "#202124" };
const APP_BAR = { space: "#070914", dark: "#111214", light: "#f4f5f8", medieval: "#e8d9b5" };

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function read(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function write(key, v) { try { localStorage.setItem(key, v); } catch { /* ignore */ } }

/** Scriptorium (the standalone build) always wears the ReadEra look. */
export const enabled = () => SOLO || read(KEY, "") === "1";
export const tone = () => read(TONE_KEY, "auto");
/** True while the ReadEra look is showing. */
export const on = () => !!root.getAttribute("data-readera");
export const view = () => (!SOLO && read(VIEW_KEY, "list") === "grid" ? "grid" : "list");

function resolvedTone() {
  const t = tone();
  if (t === "light" || t === "dark") return t;
  return darkQuery && darkQuery.matches ? "dark" : "light";
}

/** Put the saved choice on <html> and the browser's bar colour. */
export function apply() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (enabled()) {
    const t = resolvedTone();
    root.setAttribute("data-readera", t);
    root.setAttribute("data-re-view", view());
    meta?.setAttribute("content", BAR[t]);
  } else {
    root.removeAttribute("data-readera");
    root.removeAttribute("data-re-view");
    meta?.setAttribute("content", APP_BAR[root.getAttribute("data-mode")] || APP_BAR.space);
  }
  syncChrome();
  window.dispatchEvent(new CustomEvent("harmonarium:readera", { detail: on() }));
}

export function setEnabled(v) { write(KEY, v ? "1" : ""); apply(); }
export function setTone(t) { write(TONE_KEY, t); apply(); }

// ------------------------------------------------------------------ app bar, drawer, FAB

let hooks = { setTab: () => {}, getTab: () => "shelf", openSettings: () => {}, addBooks: () => {}, sync: () => {},
  setSection: () => {}, getSection: () => "books", counts: async () => ({}), sectionTitle: () => "Books" };

export function init(h) {
  hooks = { ...hooks, ...h };
  darkQuery?.addEventListener?.("change", () => { if (enabled() && tone() === "auto") apply(); });
  // An appearance-mode change rewrites the bar colour; keep ReadEra's while it's on.
  window.addEventListener("harmonarium:mode", () => { if (on()) apply(); });

  $("re-drawer-name").textContent = APP_NAME;
  $("re-drawer-icon").src = APP_ICON;
  // Inside a group (an author, a series, a collection) the ☰ becomes a back arrow.
  $("re-menu").addEventListener("click", () => (document.body.classList.contains("in-group") ? hooks.leaveGroup?.() : openDrawer()));
  $("re-scrim").addEventListener("click", closeDrawer);
  $("re-search").addEventListener("click", toggleSearch);
  $("re-more").addEventListener("click", () => hooks.openSettings());
  $("re-view").addEventListener("click", () => {
    write(VIEW_KEY, view() === "grid" ? "list" : "grid");
    root.setAttribute("data-re-view", view());
    syncChrome();
  });
  $("re-fab").addEventListener("click", () => hooks.addBooks());

  $("re-drawer").addEventListener("click", async (e) => {
    const go = e.target.closest("[data-re-go]");
    const list = e.target.closest("[data-re-list]");
    const act = e.target.closest("[data-re-act]");
    const sec = e.target.closest("[data-re-sec]");
    if (!go && !list && !act && !sec) return;
    await closeDrawer(); // let its history step finish, so a panel opened next keeps its own
    if (sec) { hooks.setTab("shelf"); hooks.setSection(sec.dataset.reSec); syncChrome("shelf"); }
    else if (go) hooks.setTab(go.dataset.reGo);
    else if (list) {
      hooks.setTab("lists");
      const col = document.querySelectorAll("#board .col:not(.col-new)")[Number(list.dataset.reList)];
      setTimeout(() => col?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    } else if (act.dataset.reAct === "add") { hooks.setTab("shelf"); hooks.addBooks(); }
    else if (act.dataset.reAct === "sync") hooks.sync();
    else if (act.dataset.reAct === "settings") hooks.openSettings();
  });

  // Android's back gesture: the open drawer has a history entry, so Back closes it, not the app.
  window.addEventListener("popstate", () => { if (drawerEntry) { drawerEntry = false; hideDrawer(); } });

  // Back / Esc closes the drawer, then the search row, before anything else.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !on() || document.body.classList.contains("reading")) return;
    if (!$("re-drawer").hidden) { e.stopImmediatePropagation(); e.preventDefault(); closeDrawer(); }
    else if (document.body.classList.contains("re-searching") && searchInput()?.matches(":focus, :placeholder-shown")) {
      e.stopImmediatePropagation(); e.preventDefault(); closeSearch();
    }
  }, true);

  apply();
}

/** Called whenever the Shelf / Lists tab changes. */
export function onTab(tab) {
  closeSearch();
  syncChrome(tab);
}

function syncChrome(tab = hooks.getTab()) {
  const title = $("re-title");
  if (!title) return;
  title.textContent = tab === "lists" ? "Lists" : hooks.sectionTitle();
  const v = $("re-view");
  const grid = view() === "grid";
  v.hidden = tab === "lists";
  v.setAttribute("aria-label", grid ? "Show as list" : "Show as grid");
  v.title = grid ? "List" : "Grid";
  v.innerHTML = grid ? ICON.list : ICON.grid;
  for (const b of document.querySelectorAll("[data-re-go]")) b.setAttribute("aria-current", String(b.dataset.reGo === tab && tab !== "shelf"));
  const sec = hooks.getSection();
  for (const b of document.querySelectorAll("[data-re-sec]")) b.setAttribute("aria-current", String(tab === "shelf" && b.dataset.reSec === sec));
  const grouped = ["authors", "series", "collections"].includes(sec) && !document.body.classList.contains("in-group");
  v.hidden = tab === "lists" || grouped || SOLO; // list/grid views are a paid extra in ReadEra; the standalone app keeps to the list
  const m = $("re-menu");
  const back = document.body.classList.contains("in-group");
  m.innerHTML = back ? ICON.back : ICON.menu;
  m.setAttribute("aria-label", back ? "Back" : "Open menu");
  m.title = back ? "Back" : "Menu";
}
/** Refresh the bar title and buttons (e.g. after entering an author or a collection). */
export const refresh = () => syncChrome();

function searchInput() { return hooks.getTab() === "lists" ? $("q") : $("lib-search"); }

function toggleSearch() {
  if (document.body.classList.contains("re-searching")) closeSearch();
  else { document.body.classList.add("re-searching"); setTimeout(() => searchInput()?.focus(), 30); }
}
function closeSearch() {
  if (!document.body.classList.contains("re-searching")) return;
  document.body.classList.remove("re-searching");
  const s = $("lib-search");
  if (s?.value) { s.value = ""; s.dispatchEvent(new Event("input")); }
}

let drawerEntry = false;

function openDrawer() {
  renderDrawerLists();
  if (!drawerEntry) try { history.pushState({ reDrawer: 1 }, ""); drawerEntry = true; } catch { /* ignore */ }
  $("re-drawer").hidden = false;
  $("re-scrim").hidden = false;
  requestAnimationFrame(() => document.body.classList.add("re-drawer-open"));
  if (document.body.classList.contains("dpad")) setTimeout(() => $("re-drawer").querySelector("button")?.focus(), 60);
}
/** Close the drawer (and step back past its history entry). Resolves once that step is done. */
export function closeDrawer() {
  if ($("re-drawer").hidden) return Promise.resolve();
  hideDrawer();
  if (!drawerEntry) return Promise.resolve();
  drawerEntry = false;
  return new Promise((r) => {
    const t = setTimeout(r, 400);
    window.addEventListener("popstate", () => { clearTimeout(t); r(); }, { once: true });
    try { history.back(); } catch { clearTimeout(t); r(); }
  });
}
function hideDrawer() {
  if ($("re-drawer").hidden) return;
  document.body.classList.remove("re-drawer-open");
  $("re-drawer").hidden = true;
  $("re-scrim").hidden = true;
  if (document.body.classList.contains("dpad")) setTimeout(() => $("re-menu").focus(), 30);
}
export const drawerOpen = () => !$("re-drawer").hidden;

/** The user's lists, read from the board, become drawer entries (like ReadEra's To read / Have read). */
function renderDrawerLists() {
  hooks.counts().then((n) => {
    for (const el of document.querySelectorAll("#re-drawer [data-n]")) el.textContent = n[el.dataset.n] ? String(n[el.dataset.n]) : "";
  }).catch(() => {});
  if (SOLO) { $("re-drawer-sync").textContent = ""; return; }
  const cols = [...document.querySelectorAll("#board .col:not(.col-new)")];
  const sheet = document.getElementById("sheet-name")?.textContent || "";
  const state = document.querySelector("#sync .sync-t")?.textContent || "";
  $("re-drawer-sync").textContent = [sheet, state].filter(Boolean).join(" · ");
  const nav = $("re-nav-lists");
  nav.textContent = "";
  cols.forEach((c, i) => {
    const count = c.querySelector(".count");
    if (!count) return; // the "Welcome" card before any list exists
    const b = document.createElement("button");
    b.dataset.reList = String(i);
    b.innerHTML = `${c.classList.contains("done") ? ICON.done : ICON.shelf}<span class="re-nav-t"></span><span class="re-n"></span>`;
    // list names go in as text, so nothing in a name is read as markup
    b.querySelector(".re-nav-t").textContent = c.querySelector(".col-h h2")?.textContent || "";
    b.querySelector(".re-n").textContent = count.textContent;
    nav.appendChild(b);
  });
}

// ------------------------------------------------------------------ reader progress hairline

/** ReadEra's line under the page: chapter dots along it, filled up to where you are. */
export function track(percent, marks) {
  const fill = $("re-track-fill"), at = $("re-track-at"), box = $("re-track-marks");
  if (!fill || !at || !box) return;
  const p = `${Math.max(0, Math.min(1, percent || 0)) * 100}%`;
  fill.style.width = p;
  at.style.left = p;
  if (marks) {
    const key = marks.map((m) => m.toFixed(4)).join(",");
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = marks.map((m) => `<s style="left:${(m * 100).toFixed(3)}%"></s>`).join("");
    }
  }
}

export const ICON = {
  menu: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 5h4v4H3V5Zm6 1h12v2H9V6ZM3 10h4v4H3v-4Zm6 1h12v2H9v-2Zm-6 4h4v4H3v-4Zm6 1h12v2H9v-2Z"/></svg>',
  shelf: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6 2h12a2 2 0 0 1 2 2v18l-8-4-8 4V4a2 2 0 0 1 2-2Zm0 2v14.8l6-3 6 3V4H6Z"/></svg>',
  done: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>',
};
