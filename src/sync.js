// Reading-position sync client (the sheet's "Progress" tab).
//
// The sheet is fronted by a small Google Apps Script web app (see sync/Code.gs).
// Each device writes ONE row per book (book_id + device_id). To decide where to
// resume, a device reads every row for that book and looks for a newer one
// written by some other device.
//
// Writes go through an IndexedDB "outbox" so progress made offline (on a plane,
// on the campus network with the sheet blocked, …) is pushed later.

import * as db from "./db.js";
import * as settings from "./settings.js";
import { debounce } from "./util.js";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let httpFetch = null;

/** fetch() that goes through Tauri's HTTP plugin in the app (no CORS limits), else the browser's. */
export async function netFetch(url, opts) {
  if (isTauri) {
    if (!httpFetch) httpFetch = (await import("@tauri-apps/plugin-http")).fetch;
    return httpFetch(url, opts);
  }
  return fetch(url, opts);
}

export function isConfigured(s = settings.get()) {
  return Boolean(s?.syncUrl && s?.syncKey && /^https:\/\/script\.google(usercontent)?\.com\//.test(s.syncUrl));
}

async function call(params, body) {
  const s = settings.get();
  if (!isConfigured(s)) throw new Error("Sync is not set up");
  const url = new URL(s.syncUrl);
  let res;
  if (body) {
    // text/plain keeps this a "simple" request (no CORS preflight in browsers).
    res = await netFetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...body, token: s.syncKey }),
    });
  } else {
    for (const [k, v] of Object.entries({ ...params, token: s.syncKey })) url.searchParams.set(k, v);
    res = await netFetch(url.toString(), { method: "GET" });
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      res.ok
        ? "The script answered with HTML, not JSON — check the deployment's access is 'Anyone'."
        : `HTTP ${res.status}`
    );
  }
  if (!data.ok) throw new Error(data.error || "Sync failed");
  return data;
}

export async function ping() {
  return call({ action: "ping" });
}

/** All rows (one per device) for a single book. */
export async function fetchBook(bookId) {
  const data = await call({ action: "get", book_id: bookId });
  return data.entries || [];
}

/** All rows for all books — used to show "ahead on another device" hints. */
export async function fetchAll() {
  const data = await call({ action: "list" });
  return data.entries || [];
}

/** Newest entry written by a device other than this one, or null. */
export function newestFromOthers(entries) {
  const me = settings.get().deviceId;
  return entries
    .filter((e) => e.device_id !== me && e.cfi)
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))[0] || null;
}

// ---------------------------------------------------------------- outbox

const flushSoon = debounce(() => flush().catch(() => {}), 4000);

/** Queue this device's position for a book and push it shortly. */
export async function queue(book, progress) {
  const s = settings.get();
  await db.put("outbox", {
    book_id: book.id,
    title: book.title || "",
    author: book.author || "",
    cfi: progress.cfi,
    percent: Math.round((progress.percent || 0) * 10000) / 10000,
    chapter: progress.chapter || "",
    device_id: s.deviceId,
    device_name: s.deviceName,
    updated_at: progress.updatedAt,
  });
  if (isConfigured(s)) flushSoon();
}

let flushing = null;

/** Push every queued entry in one request. Safe to call often. */
export async function flush() {
  if (!isConfigured()) return { pushed: 0 };
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const pending = await db.getAll("outbox");
      if (!pending.length) return { pushed: 0 };
      // Device name may have been renamed since queueing.
      const name = settings.get().deviceName;
      await call(null, { action: "put", entries: pending.map((e) => ({ ...e, device_name: name })) });
      // Only clear what we sent — newer entries may have been queued meanwhile.
      for (const e of pending) {
        const now = await db.get("outbox", e.book_id);
        if (now && now.updated_at === e.updated_at) await db.del("outbox", e.book_id);
      }
      return { pushed: pending.length };
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function flushNow() {
  flushSoon.cancel();
  return flush().catch(() => {});
}

// Push whatever is waiting when the app is backgrounded or comes back online.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushNow();
});
window.addEventListener("online", () => flushNow());
