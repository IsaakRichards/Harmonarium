// Harmonarium's own backup: everything the app keeps, in one .zip file, and back again.
//
//   harmonarium-backup.json   books (shelf details), reading places, bookmarks / quotes / notes,
//                             collections, settings and the look; see BackupData below
//   covers/<id>               each book's cover picture
//   books/<id>.epub|.pdf      the books themselves (optional)
//
// The file is written as it goes (a small ZIP writer, no compression: EPUBs and PDFs are already
// compressed), so a large library never has to sit in memory all at once; restoring reads it one
// entry at a time the same way.
//
// Restoring merges into what is here and never deletes: books missing here are added, a book on
// both keeps its own details plus anything only the backup had, the newer reading place wins and
// bookmarks are added. Books the backup has no file for wait (kv "backupPending") and get their
// shelf details back when that same file is added again (book ids are the file's SHA-256).

import * as db from "./db.js";
import * as native from "./native.js";
import * as settings from "./settings.js";

const FORMAT = "harmonarium-backup";
const DATA = "harmonarium-backup.json";
const PENDING = "backupPending";
const CHUNK = 4 * 1024 * 1024;
// Settings that belong to this device, not to the reader: never carried to another.
const DEVICE_ONLY = ["deviceId", "deviceName"];
// The look and the lists cached from the sheet live in localStorage; these two don't travel.
const LOCAL_SKIP = new Set(["hm-update-checked", "hm-tab"]);

const enc = new TextEncoder();
const hexOf = (id) => String(id).replace(/^sha256:/, "").replace(/[^0-9a-zA-Z]/g, "_");

/* ---------- CRC-32 and a streaming ZIP writer ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(u8, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class ZipWriter {
  constructor(sink) { this.sink = sink; this.offset = 0; this.entries = []; this.parts = []; this.held = 0; this.stamp = dosTime(); }
  async push(u8) {
    this.parts.push(u8); this.held += u8.length; this.offset += u8.length;
    if (this.held >= CHUNK) await this.flush();
  }
  async flush() {
    if (!this.held) return;
    const all = new Uint8Array(this.held);
    let at = 0;
    for (const p of this.parts) { all.set(p, at); at += p.length; }
    this.parts = []; this.held = 0;
    await this.sink.write(all);
  }
  /** One stored (uncompressed) file. */
  async file(name, data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.offset + u8.length > 0xfffffff0) throw new Error("the backup would be over 4 GB; make one without the books");
    const nameBytes = enc.encode(name), crc = crc32(u8), start = this.offset;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, this.stamp.time, true); h.setUint16(12, this.stamp.date, true);
    h.setUint32(14, crc, true); h.setUint32(18, u8.length, true); h.setUint32(22, u8.length, true);
    h.setUint16(26, nameBytes.length, true); h.setUint16(28, 0, true);
    await this.push(new Uint8Array(h.buffer));
    await this.push(nameBytes);
    for (let i = 0; i < u8.length; i += CHUNK) await this.push(u8.subarray(i, Math.min(u8.length, i + CHUNK)));
    this.entries.push({ nameBytes, crc, size: u8.length, start });
  }
  async end() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, this.stamp.time, true); c.setUint16(14, this.stamp.date, true);
      c.setUint32(16, e.crc, true); c.setUint32(20, e.size, true); c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true); c.setUint32(42, e.start, true);
      await this.push(new Uint8Array(c.buffer));
      await this.push(e.nameBytes);
    }
    const z = new DataView(new ArrayBuffer(22));
    z.setUint32(0, 0x06054b50, true); z.setUint16(8, this.entries.length, true); z.setUint16(10, this.entries.length, true);
    z.setUint32(12, this.offset - cdStart, true); z.setUint32(16, cdStart, true);
    await this.push(new Uint8Array(z.buffer));
    await this.flush();
  }
}

/* ---------- reading a ZIP from a File, one entry at a time ---------- */

async function bytes(blob, from, to) { return new Uint8Array(await blob.slice(from, to).arrayBuffer()); }

async function openZip(file) {
  const size = file.size;
  if (size < 22) throw new Error("that isn't a Harmonarium backup");
  const tailFrom = Math.max(0, size - 65557);
  const tail = await bytes(file, tailFrom, size);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("that isn't a Harmonarium backup (not a ZIP file)");
  const count = tv.getUint16(eocd + 10, true), cdSize = tv.getUint32(eocd + 12, true), cdOff = tv.getUint32(eocd + 16, true);
  const cd = await bytes(file, cdOff, cdOff + cdSize);
  const v = new DataView(cd.buffer), dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0, p = 0; i < count && p + 46 <= cd.length; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const n = v.getUint16(p + 28, true), x = v.getUint16(p + 30, true), c = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    entries.set(dec.decode(cd.subarray(p + 46, p + 46 + n)), { method, csize, usize, off });
    p += 46 + n + x + c;
  }
  return {
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const h = new DataView((await bytes(file, e.off, e.off + 30)).buffer);
      const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      const raw = file.slice(start, start + e.csize);
      if (e.method === 0) return new Uint8Array(await raw.arrayBuffer());
      if (e.method === 8 && typeof DecompressionStream !== "undefined") {
        return new Uint8Array(await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      }
      throw new Error(`can't unpack ${name} (compression method ${e.method})`);
    },
  };
}

/* ---------- making a backup ---------- */

/** What a backup would hold: { books, bookBytes } for the "include the books" choice. */
export async function summary() {
  const books = await db.getAll("books");
  return { books: books.length, bookBytes: books.reduce((n, b) => n + (b.size || 0), 0) };
}

export const fileName = (d = new Date()) =>
  `Harmonarium-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.zip`;

/** Ask where to save, then write the backup there. Returns null if cancelled, else
 *  { books, files, where } (where: the place it was saved, when the device says). */
export async function exportBackup({ withBooks = true, onProgress = () => {} } = {}) {
  const sink = await native.saveFile(fileName(), "application/zip");
  if (!sink) return null;
  try {
    const books = await db.getAll("books");
    const data = await collect(books, withBooks);
    const zip = new ZipWriter(sink);
    await zip.file(DATA, enc.encode(JSON.stringify(data)));
    let files = 0;
    for (let i = 0; i < books.length; i++) {
      const b = books[i], row = data.books[i];
      onProgress(i, books.length);
      if (row.coverFile && b.cover) await zip.file(row.coverFile, await b.cover.arrayBuffer());
      if (row.bookFile) {
        const buf = await db.get("files", b.id);
        if (buf) { await zip.file(row.bookFile, buf); files++; }
      }
    }
    await zip.end();
    const where = await sink.close();
    return { books: books.length, files, where };
  } catch (err) {
    try { await sink.abort(); } catch { /* nothing more to do */ }
    throw err;
  }
}

async function collect(books, withBooks) {
  const files = new Set(withBooks ? await keysOf("files") : []);
  const rows = books.map((b) => {
    const { cover, ...rest } = b;
    const hex = hexOf(b.id);
    return {
      ...rest,
      coverFile: cover instanceof Blob ? `covers/${hex}` : null,
      coverType: cover instanceof Blob ? cover.type || "image/jpeg" : null,
      bookFile: withBooks && files.has(b.id) ? `books/${hex}.${b.format === "pdf" ? "pdf" : "epub"}` : null,
    };
  });
  const st = { ...((await db.get("kv", "settings")) || {}) };
  for (const k of DEVICE_ONLY) delete st[k];
  const local = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("hm-") && !LOCAL_SKIP.has(k)) local[k] = localStorage.getItem(k);
    }
  } catch { /* storage unavailable */ }
  return {
    format: FORMAT,
    version: 1,
    app: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "",
    createdAt: Date.now(),
    withBooks,
    books: rows,
    progress: await db.getAll("progress"),
    marks: await db.getAll("marks"),
    kv: {
      settings: st,
      collections: (await db.get("kv", "collections")) || [],
      readeraPending: (await db.get("kv", "readeraPending")) || null,
    },
    local,
  };
}

/** Every key in a store without reading the (large) values. */
async function keysOf(store) {
  const req = indexedDB.open("harmonarium");
  const idb = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  try {
    return await new Promise((res, rej) => {
      const r = idb.transaction(store, "readonly").objectStore(store).getAllKeys();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  } finally { idb.close(); }
}

/* ---------- restoring ---------- */

/** Open a backup file and read what it holds (for the restore card): the data, plus the open ZIP. */
export async function readBackup(file) {
  const zip = await openZip(file);
  if (!zip.has(DATA)) throw new Error("that isn't a Harmonarium backup");
  const data = JSON.parse(new TextDecoder().decode(await zip.read(DATA)));
  if (data?.format !== FORMAT || !Array.isArray(data.books)) throw new Error("that isn't a Harmonarium backup");
  if (data.version > 1) throw new Error("that backup comes from a newer Harmonarium; update this one first");
  return { data, zip };
}

/** Shelf details a book here takes from the backup: only what it doesn't have itself. */
function mergeShelf(here, from, cover) {
  const out = { ...here };
  if (from.favorite && !here.favorite) out.favorite = true;
  if (from.status && !here.status) out.status = from.status;
  const coll = [...new Set([...(here.collections || []), ...(from.collections || [])])];
  if (coll.length !== (here.collections || []).length) out.collections = coll;
  for (const k of ["series", "seriesIndex", "author", "pages"]) {
    if ((here[k] == null || here[k] === "") && from[k] != null && from[k] !== "") out[k] = from[k];
  }
  if ((from.lastOpenedAt || 0) > (here.lastOpenedAt || 0)) out.lastOpenedAt = from.lastOpenedAt;
  if (from.addedAt && (!here.addedAt || from.addedAt < here.addedAt)) out.addedAt = from.addedAt;
  if (!here.cover && cover) out.cover = cover;
  return out;
}

const rowToRecord = (row, cover) => {
  const { coverFile, coverType, bookFile, ...rec } = row;
  void coverFile; void coverType; void bookFile;
  return { ...rec, cover: cover || null };
};

/** Put a backup's contents into this device. Returns counts for the summary. */
export async function restore({ data, zip }, { withSettings = true, onProgress = () => {} } = {}) {
  const out = { added: 0, matched: 0, waiting: 0, places: 0, marks: 0, settings: false };
  const pending = (await db.get("kv", PENDING)) || {};
  for (let i = 0; i < data.books.length; i++) {
    const row = data.books[i];
    if (!row?.id) continue;
    onProgress(i, data.books.length);
    let cover = null;
    if (row.coverFile) {
      try { const c = await zip.read(row.coverFile); if (c) cover = new Blob([c], { type: row.coverType || "image/jpeg" }); }
      catch (err) { console.warn("backup cover", err); }
    }
    const here = await db.get("books", row.id);
    if (here) {
      const merged = mergeShelf(here, row, cover);
      await db.put("books", merged);
      // The backup has the file and this device lost it: put it back.
      if (row.bookFile && !(await db.get("files", row.id))) {
        const buf = await zip.read(row.bookFile);
        if (buf) await db.put("files", buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), row.id);
      }
      out.matched++;
      continue;
    }
    const buf = row.bookFile ? await zip.read(row.bookFile) : null;
    if (buf) {
      await db.put("files", buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), row.id);
      await db.put("books", rowToRecord(row, cover));
      delete pending[row.id];
      out.added++;
    } else {
      pending[row.id] = rowToRecord(row, cover);
      out.waiting++;
    }
  }
  await db.put("kv", pending, PENDING);

  // Reading places: the newer one wins.
  for (const p of data.progress || []) {
    if (!p?.bookId) continue;
    const here = await db.get("progress", p.bookId);
    if (!here || (p.updatedAt || 0) > (here.updatedAt || 0)) { await db.put("progress", p); out.places++; }
  }
  // Bookmarks, quotes and notes: add the ones this device doesn't have.
  const have = new Set((await db.getAll("marks")).map((m) => m.id));
  for (const m of data.marks || []) {
    if (m?.id && !have.has(m.id)) { await db.put("marks", m); out.marks++; }
  }
  // Collections (their names) and ReadEra places still waiting for their books.
  const coll = (await db.get("kv", "collections")) || [];
  const allColl = [...new Set([...coll, ...(data.kv?.collections || [])])];
  if (allColl.length !== coll.length) await db.put("kv", allColl, "collections");
  if (data.kv?.readeraPending && typeof data.kv.readeraPending === "object") {
    const rp = (await db.get("kv", "readeraPending")) || {};
    await db.put("kv", { ...data.kv.readeraPending, ...rp }, "readeraPending");
  }

  if (withSettings) {
    const st = { ...(data.kv?.settings || {}) };
    for (const k of DEVICE_ONLY) delete st[k];
    await settings.update(st);
    try {
      for (const [k, v] of Object.entries(data.local || {})) {
        if (k.startsWith("hm-") && !LOCAL_SKIP.has(k) && typeof v === "string") localStorage.setItem(k, v);
      }
    } catch { /* storage unavailable */ }
    out.settings = true;
  }
  return out;
}

/** A book was just added: if a restored backup was waiting for this very file, give it back its
 *  shelf details (title and author as they were, favourite, status, collections, series…). */
export async function applyPending(record) {
  const pending = await db.get("kv", PENDING);
  const saved = pending?.[record.id];
  if (!saved) return false;
  const merged = { ...record, ...saved, id: record.id, size: record.size, format: record.format, cover: saved.cover || record.cover || null };
  await db.put("books", merged);
  delete pending[record.id];
  await db.put("kv", pending, PENDING);
  return true;
}
