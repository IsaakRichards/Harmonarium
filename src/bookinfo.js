// Title, author, series, cover and page count of an EPUB or PDF, for the shelf. Read with the
// same engine that shows the books (foliate-js, see src/foliate/README.md).
import { makeBook } from "./foliate/view.js";

/** Is this file a PDF? (by name, type or its "%PDF" header) */
export function isPdf(name = "", type = "", bytes = null) {
  if (/\.pdf$/i.test(name) || type === "application/pdf") return true;
  if (bytes && bytes.byteLength > 4) {
    const h = new Uint8Array(bytes, 0, 5);
    return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46; // %PDF
  }
  return false;
}

/** foliate gives names as a string, an object of languages, or a list of either. */
function text(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (typeof v === "object") {
    if ("name" in v) return text(v.name);
    const vals = Object.values(v);
    return vals.length ? text(vals[0]) : "";
  }
  return String(v);
}
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** A cover blob, shrunk to shelf size so the library stays light. */
async function shrink(blob, max = 480) {
  try {
    if (!blob || typeof createImageBitmap !== "function") return blob || null;
    const img = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1 && blob.size < 400 * 1024) return blob;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return (await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85))) || blob;
  } catch { return blob || null; }
}

/** A PDF's first page comes back as an image URL from the engine. */
async function coverBlob(cover) {
  if (!cover) return null;
  if (cover instanceof Blob) return cover;
  const url = typeof cover === "string" ? cover : cover.src || cover.url;
  if (!url) return null;
  try { return await (await fetch(url)).blob(); } catch { return null; }
}

/** Read a book's details. `buf` is left untouched. */
export async function metadata(buf, fallbackName = "") {
  const pdf = isPdf("", "", buf);
  const file = new File([buf.slice(0)], pdf ? "book.pdf" : "book.epub", { type: pdf ? "application/pdf" : "application/epub+zip" });
  const book = await makeBook(file);
  try {
    const md = book.metadata || {};
    let cover = null;
    try { cover = await shrink(await coverBlob(await book.getCover?.())); } catch { /* no cover */ }
    const s = md.belongsTo?.series;
    const series = Array.isArray(s) ? s[0] : s;
    const name = clean(text(series?.name));
    const n = parseFloat(series?.position);
    const base = fallbackName.replace(/\.(epub|pdf)$/i, "").replace(/[_]+/g, " ").trim();
    const title = clean(text(md.title));
    return {
      title: title && !(pdf && /^untitled|^microsoft word|^about:blank$/i.test(title)) ? title : base,
      author: clean(text(md.author)),
      cover,
      ...(pdf ? { pages: book.sections?.length || 0 } : {}),
      ...(name ? { series: name, seriesIndex: Number.isFinite(n) ? n : null } : {}),
    };
  } finally {
    try { book.destroy?.(); } catch { /* already gone */ }
  }
}

/** Just the series, for books added before series were read. */
export async function seriesOf(buf) {
  const { series, seriesIndex } = await metadata(buf);
  return series ? { series, seriesIndex } : {};
}
