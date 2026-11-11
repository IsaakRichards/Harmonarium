// Harmonarium boot: wires the Shelf (EPUB library + reader) to the Lists (tracker).
import * as settings from "./settings.js";
import * as library from "./library.js";
import * as reader from "./reader.js";
import * as sync from "./sync.js";
import * as lists from "./lists.js";
import * as dpad from "./dpad.js";
import { toast } from "./util.js";
import * as native from "./native.js";
import * as updater from "./updater.js";
import * as readera from "./readera.js";
import { SOLO, APP_NAME } from "./flavor.js";

const TAB_KEY = "hm-tab";

function setTab(tab) {
  if (SOLO) tab = "shelf"; // Scriptorium has no Lists tab
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  readera.onTab(tab);
}

let scrollY = 0;

// ---- Back (Android's back gesture, the browser's Back) leaves the book, not the app ----
// The webview only goes back through its own history and otherwise closes the app, so an open
// book gets a history entry of its own: Back closes Contents / Text first, then the book.
let readerEntry = false;
/** Resolves after the next history step (e.g. a panel that is closing), or after 400 ms. */
const afterPop = () => new Promise((r) => {
  const t = setTimeout(r, 400);
  window.addEventListener("popstate", () => { clearTimeout(t); r(); }, { once: true });
});
async function pushReaderEntry() {
  if (history.state && history.state.panelOpen) await afterPop(); // "Read now" from a book's panel
  if (!document.body.classList.contains("reading") || readerEntry) return;
  try { history.pushState({ reader: 1 }, ""); readerEntry = true; } catch { /* ignore */ }
}
function dropReaderEntry() {
  if (!readerEntry) return;
  readerEntry = false;
  try { history.back(); } catch { /* ignore */ }
}
window.addEventListener("popstate", () => {
  if (!readerEntry || !document.body.classList.contains("reading")) return;
  readerEntry = false;
  if (reader.api.overlayOpen()) { reader.api.closeOverlays(); pushReaderEntry(); return; }
  reader.api.close();
});
let legendShown = false;

/** Keypad mode: on for Sailfish OS (e.g. the Commodore Callback) and for devices with no
 *  pointer at all, unless the person chooses otherwise in Settings. */
export function applyKeypadMode() {
  const mode = settings.get().keypadMode;
  const noPointer = window.matchMedia && window.matchMedia("(any-pointer: none)").matches;
  dpad.setKeypad(mode === "on" || (mode === "auto" && (native.platform === "sailfish" || noPointer)));
}
function showReader(on) {
  if (on) {
    scrollY = window.scrollY;
    document.body.classList.add("reading");
    document.getElementById("view-reader").hidden = false;
  } else {
    document.body.classList.remove("reading");
    document.getElementById("view-reader").hidden = true;
    window.scrollTo(0, scrollY);
  }
}

async function openBook(id) {
  dpad.rememberFocus();
  dpad.focusPage();
  reader.syncPanelState();
  showReader(true);
  pushReaderEntry();
  const ok = await reader.open(id).catch((err) => {
    console.error(err);
    toast("This book could not be opened");
    return false;
  });
  if (!ok) { showReader(false); dropReaderEntry(); dpad.restoreFocus(); return; }
  if (dpad.isKeypad() && !legendShown) {
    legendShown = true;
    toast("4 · 6 turn pages   5 menus   1 contents   3 text   * # size   0 theme");
  }
}

async function boot() {
  await settings.load();
  if (SOLO) { document.documentElement.setAttribute("data-solo", ""); document.title = APP_NAME; }

  library.init({
    open: openBook,
    onShelf: (books, progress) => lists.setShelf(books, progress),
    listFor: (title) => (SOLO ? null : lists.listFor(title)),
    onSection: () => readera.refresh(),
  });
  reader.init({
    close: async () => { showReader(false); dropReaderEntry(); await library.render(); dpad.restoreFocus(); },
    onFinished: (title, id) => {
      library.markRead(id); // "Have read", as ReadEra files a finished book
      if (SOLO) toast("Finished! Filed under Have read");
      else lists.offerFinish(title);
    },
    onKey: (e) => dpad.handle(e),
  });
  dpad.init(reader.api, { openSettings: () => lists.openSettings(), addBooks: () => library.openAddBooks() });
  dpad.setToast(toast);
  applyKeypadMode();
  window.addEventListener("harmonarium:keypad", applyKeypadMode);
  lists.init({
    openBook,
    onSyncClick: () => library.refreshRemote(true),
    onSettingsSaved: () => library.refreshRemote(false),
  });

  for (const b of document.querySelectorAll(".tabs [data-tab]")) {
    b.addEventListener("click", () => { setTab(b.dataset.tab); if (b.dataset.tab === "shelf") library.render(); });
  }
  readera.init({
    setTab: (t) => { setTab(t); if (t === "shelf") library.render(); },
    getTab: () => document.body.dataset.tab || "shelf",
    openSettings: () => lists.openSettings(),
    addBooks: () => library.openAddBooks(),
    sync: () => document.getElementById("sync").click(),
    setSection: (s) => library.setSection(s),
    getSection: () => library.section(),
    sectionTitle: () => library.sectionTitle(),
    leaveGroup: () => library.leaveGroup(),
    counts: () => library.counts(),
  });
  let tab = "shelf";
  try { tab = localStorage.getItem(TAB_KEY) || "shelf"; } catch { /* ignore */ }
  setTab(tab === "lists" ? "lists" : "shelf");

  await library.render();
  if (SOLO) return; // no sheet, and its releases are its own
  sync.flushNow(); // push reading positions left over from last time
  library.refreshRemote(false);
  updater.autoCheck(toast, () => lists.openSettings()); // Android: once a day, offers new releases
}

boot();
