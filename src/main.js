// Starborn boot: wires the Shelf (EPUB library + reader) to the Lists (tracker).
import * as settings from "./settings.js";
import * as library from "./library.js";
import * as reader from "./reader.js";
import * as sync from "./sync.js";
import * as lists from "./lists.js";
import { toast } from "./util.js";

const TAB_KEY = "sb-tab";

function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
}

let scrollY = 0;
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
  reader.syncPanelState();
  showReader(true);
  const ok = await reader.open(id).catch((err) => {
    console.error(err);
    toast("This book could not be opened");
    return false;
  });
  if (!ok) showReader(false);
}

async function boot() {
  await settings.load();

  library.init({
    open: openBook,
    onShelf: (books, progress) => lists.setShelf(books, progress),
    listFor: (title) => lists.listFor(title),
  });
  reader.init({
    close: () => { showReader(false); library.render(); },
    onFinished: (title) => lists.offerFinish(title),
  });
  lists.init({
    openBook,
    onSyncClick: () => library.refreshRemote(true),
    onSettingsSaved: () => library.refreshRemote(false),
  });

  for (const b of document.querySelectorAll(".tabs [data-tab]")) {
    b.addEventListener("click", () => { setTab(b.dataset.tab); if (b.dataset.tab === "shelf") library.render(); });
  }
  let tab = "shelf";
  try { tab = localStorage.getItem(TAB_KEY) || "shelf"; } catch { /* ignore */ }
  setTab(tab === "lists" ? "lists" : "shelf");

  await library.render();
  sync.flushNow(); // push reading positions left over from last time
  library.refreshRemote(false);
}

boot();
