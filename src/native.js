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

/* ---------- saving a file the app made (a backup) ----------
   saveFile(name, mime) asks where to save (or, on Sailfish and in a browser, uses the usual
   place) and returns a sink — { write(Uint8Array), close() → where it went, abort() } — or null
   if the reader cancelled. The file is written chunk by chunk, so it never has to fit in memory.
   Android: window.HarmonariumSave (src-tauri/android/HarmonariumSave.kt), the system's "save as".
   Desktop: the Rust side's save dialog (save_begin / save_chunk / save_end in lib.rs).
   Sailfish: the shell writes it into Documents (POST /__save, sailfish/src/localserver.cpp). */

const androidSave = () => (typeof window !== "undefined" && window.HarmonariumSave) || null;

function toBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function saveFile(name, mime = "application/octet-stream") {
  if (platform === "sailfish") {
    let at = 0, file = "";
    const post = async (body, extra = "") => {
      const r = await fetch(`/__save?t=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}&at=${at}${extra}`, { method: "POST", body });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    };
    return {
      async write(u8) { const d = await post(u8); file = d.file || file; at += u8.length; },
      async close() { if (!at) { const d = await post(new Uint8Array(0)); file = d.file || file; } return file || "Documents"; },
      async abort() { await post(new Uint8Array(0), "&abort=1"); },
    };
  }
  if (androidSave()) {
    const ready = await new Promise((resolve, reject) => {
      const on = (e) => {
        window.removeEventListener("harmonarium:save", on);
        const d = e.detail || {};
        if (d.error) reject(new Error(d.error)); else resolve(d.ready ? d : null);
      };
      window.addEventListener("harmonarium:save", on);
      androidSave().begin(name, mime);
    });
    if (!ready) return null;
    const bridge = androidSave();
    return {
      async write(u8) {
        // A little at a time across the bridge (it carries text, so Base64).
        for (let i = 0; i < u8.length; i += 1536 * 1024) {
          if (!bridge.write(toBase64(u8.subarray(i, Math.min(u8.length, i + 1536 * 1024))))) throw new Error("couldn't write the file");
          await new Promise((r) => setTimeout(r, 0));
        }
      },
      async close() { if (!bridge.end()) throw new Error("couldn't finish the file"); return ready.name || name; },
      async abort() { bridge.abort(); },
    };
  }
  if (isTauri && !isAndroid) {
    const { invoke } = await import("@tauri-apps/api/core");
    const where = await invoke("save_begin", { name });
    if (!where) return null;
    return {
      async write(u8) { await invoke("save_chunk", u8); },
      async close() { await invoke("save_end", { keep: true }); return where; },
      async abort() { await invoke("save_end", { keep: false }); },
    };
  }
  // A browser: gather the pieces and hand them over as a download.
  const parts = [];
  return {
    async write(u8) { parts.push(u8.slice()); },
    async close() {
      const url = URL.createObjectURL(new Blob(parts, { type: mime }));
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return "Downloads";
    },
    async abort() { parts.length = 0; },
  };
}
