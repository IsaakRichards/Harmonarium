// What the host app tells the page, via the URL it opens: ?native=sailfish&t=TOKEN
// (see sailfish/src/localserver.cpp). On other platforms both are empty.

const q = new URLSearchParams(location.search);
export const platform = q.get("native") || "";
const token = q.get("t") || "";

/** Sailfish: the shell can list and hand over EPUBs from the phone's folders. */
export const canBrowseDevice = platform === "sailfish" && !!token;

/** EPUBs in Documents, Downloads, ~/Books and memory cards: [{ path, name, folder, size, mtime }]. */
export async function listDeviceBooks() {
  const r = await fetch(`/__books?t=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d.books || [];
}

/** Read one of those books (EPUB or PDF) as a File, ready for the normal import path. */
export async function readDeviceBook(book) {
  const r = await fetch(`/__file?t=${encodeURIComponent(token)}&path=${encodeURIComponent(book.path)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new File([await r.blob()], book.name, { type: /\.pdf$/i.test(book.name) ? "application/pdf" : "application/epub+zip" });
}

/* ---------- adding a whole folder of books ----------
   Desktop (Windows, Linux): the Rust side opens the system's folder chooser and reads the files
   (src-tauri/src/lib.rs). Android: window.HarmonariumFolder (src-tauri/android/HarmonariumFolder.kt)
   uses the system's folder picker, which grants access to that folder only. A plain browser can
   use <input webkitdirectory>. Each gives back { folder, books: [{ ref, name, folder, size }] }. */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const androidFolder = () => (typeof window !== "undefined" && window.HarmonariumFolder) || null;
const isAndroid = /Android/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");

/** Where folders can be chosen: "android", "desktop", "browser", or "" (Sailfish has its own list). */
export function folderPicker() {
  if (platform === "sailfish") return "";
  if (androidFolder()) return "android";
  if (isTauri && !isAndroid) return "desktop";
  if (!isTauri && "webkitdirectory" in document.createElement("input")) return "browser";
  return "";
}

/** Ask for a folder and list the EPUBs and PDFs in it and its subfolders; null if cancelled. */
export async function pickBookFolder() {
  const how = folderPicker();
  if (how === "desktop") {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("pick_book_folder");
  }
  if (how === "android") {
    return new Promise((resolve, reject) => {
      const on = (e) => {
        window.removeEventListener("harmonarium:folder", on);
        const d = e.detail || {};
        if (d.error) reject(new Error(d.error)); else resolve(d.books ? d : null);
      };
      window.addEventListener("harmonarium:folder", on);
      androidFolder().pick();
    });
  }
  if (how === "browser") {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.webkitdirectory = true;
      input.multiple = true;
      input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener("change", () => {
        const files = [...input.files];
        input.remove();
        if (!files.length) return resolve(null);
        const top = (files[0].webkitRelativePath || "").split("/")[0] || "Folder";
        // Hidden folders (".something") are skipped, as on the desktop and Android.
        const shown = (f) => !(f.webkitRelativePath || "").split("/").slice(1, -1).some((d) => d.startsWith("."));
        const books = files.filter((f) => /\.(epub|pdf)$/i.test(f.name) && shown(f)).map((f) => {
          const rel = (f.webkitRelativePath || f.name).split("/").slice(1, -1).join("/");
          return { ref: f, name: f.name, folder: rel, size: f.size };
        });
        resolve({ folder: top, books });
      }, { once: true });
      input.addEventListener("cancel", () => { input.remove(); resolve(null); }, { once: true });
      input.click();
    });
  }
  throw new Error("folders can't be chosen here");
}

/** Read one book found by pickBookFolder as a File. */
export async function readFolderBook(book) {
  const type = /\.pdf$/i.test(book.name) ? "application/pdf" : "application/epub+zip";
  if (book.ref instanceof File) return book.ref;
  const how = folderPicker();
  if (how === "desktop") {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = await invoke("read_book_file", { path: book.ref });
    return new File([bytes], book.name, { type });
  }
  if (how === "android") {
    const b64 = androidFolder().read(book.ref);
    if (!b64) throw new Error("couldn't read it");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], book.name, { type });
  }
  throw new Error("can't read that book here");
}

/* ---------- in-app updater (Sailfish): the shell downloads the RPM and opens it ---------- */

async function updateCall(what, params = "") {
  const r = await fetch(`/__update/${what}?t=${encodeURIComponent(token)}${params}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/** Starts downloading a release RPM into Downloads: { ok, error }. */
export const updateStart = (url) => updateCall("start", `&url=${encodeURIComponent(url)}`);
/** { state: idle|downloading|ready|error, percent, file, error, arch } */
export const updateStatus = () => updateCall("status");
/** Opens the downloaded RPM so Sailfish offers to install it: { ok, file }. */
export const updateOpen = () => updateCall("open");
