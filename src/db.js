// Tiny IndexedDB wrapper. IndexedDB lives inside the webview, so it works the
// same on Android, Linux and Windows without any native file plumbing.
//
// Stores:
//   books     – metadata: { id, title, author, cover (Blob|null), size, addedAt, lastOpenedAt }
//   files     – raw EPUB bytes keyed by book id
//   progress  – local reading position: { bookId, cfi, percent, chapter, updatedAt }
//   locations – (no longer used: page counts came from epub.js; the reading engine now works them out itself)
//   outbox    – progress entries waiting to be pushed to the sheet, keyed by book id
//   kv        – settings and misc values
//   marks     – bookmarks and quotes (a quote with a note is a note):
//               { id, bookId, kind: "bookmark"|"quote", cfi, text, note, chapter, percent, createdAt }
//
// Book records also carry (all optional): format ("epub"|"pdf"), favorite, status
// (""|"toread"|"haveread"), collections [names], series, seriesIndex, trashedAt, pages.

const DB_NAME = "harmonarium";
const DB_VERSION = 2;
const STORES = {
  books: "id",
  files: null,
  progress: "bookId",
  locations: null,
  outbox: "book_id",
  kv: null,
  marks: "id",
};

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, keyPath ? { keyPath } : undefined);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
export const getAll = (store) => tx(store, "readonly", (s) => s.getAll());
export const put = (store, value, key) =>
  tx(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));

export async function deleteBook(id) {
  await Promise.all(["books", "files", "progress", "locations", "outbox"].map((s) => del(s, id)));
  for (const m of await getAll("marks")) if (m.bookId === id) await del("marks", m.id);
}

/** Bookmarks and quotes of one book, in reading order where we know it. */
export async function marksFor(bookId) {
  return (await getAll("marks")).filter((m) => m.bookId === bookId)
    .sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0) || a.createdAt - b.createdAt);
}
