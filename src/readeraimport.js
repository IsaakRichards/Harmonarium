// Import reading progress from a ReadEra backup.
//
// ReadEra's Backup & restore writes a .bak file: an archive with library.json inside (a plain
// .json or a gzip of it are accepted too). Each entry in its "docs" list carries:
//   data.doc_sha1       SHA-1 of the book file (how a book is matched, whatever its name)
//   data.doc_position   JSON (often as a string) whose "ratio" is how far through the book, 0–1
//   data.doc_last_read_time / doc_have_read_time   when it was read
// Only the place in each book is brought over, and only for books that have no place in
// Harmonarium yet (on this device or in the synced sheet). Books not on the shelf wait in
// "readeraPending" and get their place when they're added.
import JSZip from "jszip";
import * as db from "./db.js";
import * as sync from "./sync.js";

const PENDING = "readeraPending";

// ------------------------------------------------------------------ reading the backup

async function backupText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // a ZIP archive
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const pick = names.find((n) => /(^|\/)library\.json$/i.test(n))
      || names.find((n) => /\.json$/i.test(n))
      || names[0];
    if (!pick) throw new Error("the backup is empty");
    return zip.files[pick].async("string");
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) { // gzip
    if (typeof DecompressionStream === "undefined") throw new Error("this device can't unpack that backup");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "")); } catch { return null; }
}

/** How far through, 0–1, from ReadEra's doc_position. */
function ratioOf(data) {
  const pos = parseJson(data.doc_position) || {};
  let r = Number(pos.ratio ?? pos.progress ?? data.doc_progress);
  if (!Number.isFinite(r)) return null;
  if (r > 1 && r <= 100) r /= 100; // a percentage
  return Math.max(0, Math.min(1, r));
}

/** Read a ReadEra backup: [{ sha1, ratio, at }] for every book with a place in it. */
export async function readBackup(file) {
  const json = parseJson(await backupText(file));
  const docs = Array.isArray(json?.docs) ? json.docs : Array.isArray(json) ? json : null;
  if (!docs) throw new Error("that isn't a ReadEra backup");
  const out = [];
  for (const doc of docs) {
    const data = doc?.data || doc || {};
    const sha1 = String(data.doc_sha1 || "").trim().toLowerCase();
    const ratio = ratioOf(data);
    if (!/^[0-9a-f]{40}$/.test(sha1) || ratio === null || ratio <= 0) continue;
    const times = [data.doc_last_read_time, data.doc_have_read_time].map(Number).filter((t) => t > 0);
    let at = times.length ? Math.max(...times) : Date.now();
    if (at < 1e11) at *= 1000; // seconds, not milliseconds
    out.push({ sha1, ratio, at: Math.min(at, Date.now()) });
  }
  return out;
}

// ------------------------------------------------------------------ SHA-1

export async function sha1Hex(buf) {
  let bytes;
  try { bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", buf)); }
  catch { bytes = sha1(new Uint8Array(buf)); } // webviews that withhold crypto.subtle
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sha1(msg) {
  const len = msg.length, words = ((len + 8) >> 6) + 1;
  const w = new Uint32Array(words * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
  w[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  w[words * 16 - 1] = len * 8;
  w[words * 16 - 2] = Math.floor(len / 0x20000000);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const x = new Uint32Array(80);
  const rol = (n, s) => (n << s) | (n >>> (32 - s));
  for (let b = 0; b < w.length; b += 16) {
    for (let i = 0; i < 16; i++) x[i] = w[b + i];
    for (let i = 16; i < 80; i++) x[i] = rol(x[i - 3] ^ x[i - 8] ^ x[i - 14] ^ x[i - 16], 1);
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rol(a, 5) + f + e + k + x[i]) >>> 0;
      e = d; d = c; c = rol(bb, 30) >>> 0; bb = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => { out[i * 4] = h >>> 24; out[i * 4 + 1] = (h >>> 16) & 255; out[i * 4 + 2] = (h >>> 8) & 255; out[i * 4 + 3] = h & 255; });
  return out;
}

// ------------------------------------------------------------------ applying it

/** Give a book ReadEra's place. EPUBs get it turned into an exact spot the first time they open. */
async function apply(book, { ratio, at }) {
  const entry = { bookId: book.id, cfi: null, percent: ratio, chapter: "", updatedAt: at, fromReadEra: ratio };
  if (book.format === "pdf" && book.pages > 0) {
    const x = ratio * (book.pages - 1);
    entry.cfi = `pdf:${Math.floor(x) + 1}:${(x - Math.floor(x)).toFixed(3)}`;
    delete entry.fromReadEra;
    sync.queue(book, entry);
  }
  await db.put("progress", entry);
}

/** Books whose place Harmonarium already knows: on this device, or in the synced sheet. */
async function placed() {
  const have = new Set((await db.getAll("progress")).map((p) => p.bookId));
  if (sync.isConfigured()) {
    try { for (const e of await sync.fetchAll()) if (e.book_id) have.add(e.book_id); } catch { /* offline: this device only */ }
  }
  return have;
}

/**
 * Import a ReadEra backup. Returns { applied, kept, waiting, total }:
 * applied to books on the shelf, kept (they already had a place), waiting for books not added yet.
 */
export async function importBackup(file) {
  const entries = await readBackup(file);
  const books = (await db.getAll("books")).filter((b) => !b.trashedAt);
  const bySha = new Map();
  for (const b of books) {
    let s = b.sha1;
    if (!s) {
      const buf = await db.get("files", b.id);
      if (!buf) continue;
      s = await sha1Hex(buf);
      await db.put("books", { ...b, sha1: s });
    }
    bySha.set(s, b);
  }
  const have = await placed();
  const pending = (await db.get("kv", PENDING)) || {};
  let applied = 0, kept = 0, waiting = 0;
  for (const e of entries) {
    const b = bySha.get(e.sha1);
    if (!b) { pending[e.sha1] = { ratio: e.ratio, at: e.at }; waiting++; continue; }
    if (have.has(b.id)) { kept++; continue; }
    await apply(b, e);
    applied++;
  }
  await db.put("kv", pending, PENDING);
  return { applied, kept, waiting, total: entries.length };
}

/** A book was just added: if a ReadEra place was waiting for it, and it has none yet, give it. */
export async function applyPending(book, buf) {
  const pending = await db.get("kv", PENDING);
  if (!pending || !Object.keys(pending).length) return false;
  const s = await sha1Hex(buf);
  await db.put("books", { ...book, sha1: s });
  const e = pending[s];
  if (!e) return false;
  delete pending[s];
  await db.put("kv", pending, PENDING);
  if ((await placed()).has(book.id)) return false;
  await apply({ ...book, sha1: s }, e);
  return true;
}
