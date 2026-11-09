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

/** Read one of those EPUBs as a File, ready for the normal import path. */
export async function readDeviceBook(book) {
  const r = await fetch(`/__file?t=${encodeURIComponent(token)}&path=${encodeURIComponent(book.path)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new File([await r.blob()], book.name, { type: "application/epub+zip" });
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
