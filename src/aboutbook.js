// "About" a book: its cover, details and how far you've got. Opened from a book's menu in the
// library and from the reader's ⋮ menu.
import * as db from "./db.js";
import * as sheet from "./sheet.js";
import { escapeHtml, pct, timeAgo } from "./util.js";

const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
const date = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
export const STATUS = { "": "", toread: "To read", haveread: "Have read" };

export async function show(id) {
  const [b, p, marks] = await Promise.all([db.get("books", id), db.get("progress", id), db.marksFor(id)]);
  if (!b) return;
  const url = b.cover ? URL.createObjectURL(b.cover) : "";
  const q = marks.filter((m) => m.kind === "quote");
  const rows = [
    ["Author", b.author || "Unknown"],
    b.series ? ["Series", b.seriesIndex ? `${b.series} #${b.seriesIndex}` : b.series] : null,
    ["Format", `${(b.format || "epub").toUpperCase()}${b.pages ? ` · ${b.pages} pages` : ""}`],
    ["Size", b.size ? mb(b.size) : "—"],
    ["Progress", p ? `${pct(p.percent)}${p.chapter ? ` · ${p.chapter}` : ""}` : "Not started"],
    ["Last read", p ? timeAgo(p.updatedAt) : "—"],
    ["Added", date(b.addedAt)],
    b.status ? ["Shelf", STATUS[b.status]] : null,
    b.collections?.length ? ["Collections", b.collections.join(", ")] : null,
    ["Bookmarks", String(marks.filter((m) => m.kind === "bookmark").length)],
    ["Quotes", `${q.length}${q.some((x) => x.note) ? ` (${q.filter((x) => x.note).length} with notes)` : ""}`],
  ].filter(Boolean);
  await sheet.card({
    title: "About",
    wide: true,
    html: `<div class="about">
      <div class="about-cv">${url ? `<img src="${url}" alt="">` : `<span>${escapeHtml(b.title)}</span>`}</div>
      <div class="about-main">
        <h4>${escapeHtml(b.title)}</h4>
        <dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
      </div>
    </div>
    <div class="sh-actions"><button class="btn primary" data-ok>Close</button></div>`,
    wire: (box, done) => box.querySelector("[data-ok]").addEventListener("click", () => done(null)),
    onClose: () => { if (url) URL.revokeObjectURL(url); },
  });
}
