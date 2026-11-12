/* Harmonarium — Lists tab (the reading tracker).
 * Lists live in the first tab of the Google Sheet as column pairs (list name, Series).
 * Also owns the side panel (book details and Settings). */
import * as settings from './settings.js';
import { netFetch } from './sync.js';
import { toast } from './util.js';
import * as updater from './updater.js';
import * as appearance from './appearance.js';
import * as readera from './readera.js';
import * as readeraImport from './readeraimport.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = s => { let h = 5381; for (const c of String(s)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h; };
const splitTitle = t => { const m = String(t).match(/\(([^)]*)\)/); return { main: String(t).replace(/\s*\([^)]*\)\s*/g, ' ').trim() || String(t), note: m ? m[1] : '' }; };
const norm = t => splitTitle(t).main.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]/g, '');
const slug = t => splitTitle(t).main.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
const hueOf = s => hash(s) % 360;

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const cfg = () => ({ url: settings.get()?.syncUrl || '', token: settings.get()?.syncKey || '' });
let lists = store.get('hm-lists', []);
let meta = store.get('hm-meta', {});
let view = store.get('hm-view', 'rows');
let sheetTitle = store.get('hm-title', '');
const saveLists = () => store.set('hm-lists', lists);
let metaTimer = null;
const saveMeta = () => { clearTimeout(metaTimer); metaTimer = setTimeout(() => store.set('hm-meta', meta), 400); };

/* ---------- network (Tauri's HTTP plugin when available, else browser fetch) ---------- */
async function getJSON(url, opts) {
  const r = await netFetch(url, opts);
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

/* ---------- state ---------- */
let loaded = false, dirty = false, writing = false, writeTimer = null, lastSync = store.get('hm-lastsync', null), syncErr = null, errKind = null;
let filterSeries = null, query = '', results = [], resultsState = null, searchSeq = 0;
let panel = null; // {kind:'book', title} | {kind:'settings'}
let confirmRemove = false, pickState = null;
const connected = () => !!(cfg().url && cfg().token);

// The "finished" list: an exact name like "Completed" or "Read" wins; otherwise any name about
// finishing, but never one about reading in progress or later ("Reading now", "To read", "Want to read").
const DONE_EXACT = /^\s*(completed?|read|done|finished|already read|have read)\s*$/i;
const isDoneName = n => !/reading|to.?read|want|tbr|queue|next|later/i.test(n) && /complet|finish|done|\bread\b/i.test(n);
const doneIdx = () => {
  let i = lists.findIndex(l => DONE_EXACT.test(l.name));
  if (i < 0) i = lists.findIndex(l => isDoneName(l.name));
  return i < 0 ? 0 : i;
};
const queueIdx = () => { const i = lists.findIndex(l => /queue|tbr|next|want|to read/i.test(l.name)); return i < 0 ? (lists.length > 1 ? 1 : 0) : i; };
const allSeries = () => [...new Set(lists.flatMap(l => l.items.map(i => i.series)).filter(Boolean))];
const findBook = title => { for (let l = 0; l < lists.length; l++) { const i = lists[l].items.findIndex(x => norm(x.title) === norm(title)); if (i >= 0) return { l, i, it: lists[l].items[i] }; } return null; };
const filtering = () => !!(query.trim() || filterSeries);

/* ---------- sheet sync ---------- */
function parse(vals) {
  const head = vals[0] || [], out = [];
  for (let c = 0; c < head.length; c += 2) {
    const name = String(head[c] || '').trim(); if (!name) continue;
    const items = [];
    for (let r = 1; r < vals.length; r++) {
      const t = String((vals[r] || [])[c] ?? '').trim();
      if (t) items.push({ title: t, series: String((vals[r] || [])[c + 1] ?? '').trim() });
    }
    out.push({ name, items });
  }
  return out;
}
function toGrid() {
  const H = 1 + Math.max(0, ...lists.map(l => l.items.length)), W = Math.max(2, lists.length * 2);
  const g = Array.from({ length: H }, () => Array(W).fill(''));
  lists.forEach((L, li) => {
    g[0][li * 2] = L.name; g[0][li * 2 + 1] = 'Series';
    L.items.forEach((it, i) => { g[i + 1][li * 2] = it.title; g[i + 1][li * 2 + 1] = it.series || ''; });
  });
  return g;
}
async function bridge(method, body) {
  let r;
  try {
    const { url, token } = cfg();
    r = method === 'GET'
      ? await netFetch(url + (url.includes('?') ? '&' : '?') + 'action=lists&token=' + encodeURIComponent(token), { method: 'GET' })
      : await netFetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'lists', token, ...body }) });
  } catch (e) { const er = new Error('Can’t reach Google. Check your internet connection.'); er.kind = 'net'; throw er; }
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch (e) {
    const er = new Error(r.status === 404 ? 'That Web app URL wasn’t found. Copy it again from Deploy → Manage deployments.'
      : 'The script sent back a web page instead of data. In Apps Script, set the deployment’s access to “Anyone” and redeploy.');
    er.kind = 'setup'; throw er;
  }
  if (!d.ok) { const er = new Error(d.error || 'The sheet script reported an error.'); er.kind = 'script'; throw er; }
  return d;
}
function adopt(d) {
  const next = parse(d.values || []);
  if (d.title) { sheetTitle = d.title; store.set('hm-title', sheetTitle); }
  lastSync = Date.now(); store.set('hm-lastsync', lastSync);
  syncErr = null; errKind = null; loaded = true;
  if (JSON.stringify(next) !== JSON.stringify(lists)) { lists = next; saveLists(); renderSoon(); } else { renderSync(); renderNotice(); renderHeader(); }
}
async function pull() {
  if (!connected() || writing || dirty || drag.active) return;
  renderSync('busy');
  try { const d = await bridge('GET'); if (writing || dirty || drag.active) return; adopt(d); }
  catch (e) { syncErr = e; errKind = 'read'; renderSync(); renderNotice(); }
}
function changed() {
  saveLists(); render();
  if (!connected()) return;
  dirty = true; renderSync();
  clearTimeout(writeTimer); writeTimer = setTimeout(flush, 800);
}
async function flush() {
  if (!connected() || writing || !dirty) return;
  writing = true; dirty = false; renderSync();
  try {
    const d = await bridge('POST', { values: toGrid() });
    writing = false;
    if (dirty) return flush();
    adopt(d);
  } catch (e) {
    writing = false; dirty = true; syncErr = e; errKind = 'write'; renderSync(); renderNotice();
  }
}

/* ---------- book metadata & covers (Open Library, then Google Books) ---------- */
function coverUrl(m, size) {
  if (!m) return null;
  if (m.src === 'ol' && m.id) return `https://covers.openlibrary.org/b/id/${m.id}-${size === 'l' ? 'L' : 'M'}.jpg?default=false`;
  if (m.src === 'gb' && m.url) return m.url;
  return null;
}
function seriesAuthor(series) {
  if (!series) return '';
  const n = {};
  lists.forEach(L => L.items.forEach(it => { const m = meta[slug(it.title)]; if (it.series === series && m && m.author) n[m.author] = (n[m.author] || 0) + 1; }));
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
function seriesForAuthor(author) {
  if (!author) return '';
  const n = {};
  lists.forEach(L => L.items.forEach(it => { const m = meta[slug(it.title)]; if (it.series && m && m.author === author) n[it.series] = (n[it.series] || 0) + 1; }));
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
async function olSearch(params, limit = 10) {
  const p = new URLSearchParams({ ...params, fields: 'key,title,author_name,first_publish_year,cover_i,number_of_pages_median,edition_count', limit: String(limit) });
  const d = await getJSON('https://openlibrary.org/search.json?' + p);
  return (d.docs || []).map(x => ({
    src: 'ol', id: x.cover_i || null, key: x.key || '', title: x.title || '', author: (x.author_name || [])[0] || '',
    year: x.first_publish_year ? String(x.first_publish_year) : '', pages: x.number_of_pages_median ? String(x.number_of_pages_median) : '', editions: x.edition_count || 0,
  }));
}
async function gbSearch(q, author, n = 8) {
  const s = author ? `intitle:${q} inauthor:${author}` : q;
  const d = await getJSON('https://www.googleapis.com/books/v1/volumes?' + new URLSearchParams({ q: s, maxResults: String(n), printType: 'books' }));
  return (d.items || []).map(it => {
    const v = it.volumeInfo || {}, il = v.imageLinks || {}, img = il.thumbnail || il.smallThumbnail;
    return { src: 'gb', url: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '') : null, title: v.title || '', author: (v.authors || [])[0] || '',
      year: (v.publishedDate || '').slice(0, 4), pages: v.pageCount ? String(v.pageCount) : '', desc: v.description || '' };
  });
}
function best(cands, title) {
  const n = norm(title);
  const score = c => (norm(c.title) === n ? 6 : norm(c.title).startsWith(n) || n.startsWith(norm(c.title)) ? 2 : 0) + (c.id || c.url ? 3 : 0) + Math.min(3, Math.log10(1 + (c.editions || 0)));
  return cands.slice().sort((a, b) => score(b) - score(a))[0];
}
async function lookup(title, series) {
  const q = splitTitle(title).main, author = seriesAuthor(series);
  let ol = [];
  try { ol = await olSearch(author ? { title: q, author } : { title: q }); if (!ol.length && author) ol = await olSearch({ title: q }); } catch (e) { ol = null; }
  let pick = ol && best(ol, q);
  if (pick && norm(pick.title) !== norm(q) && !pick.id) pick = null;
  if (!pick || !pick.id) {
    let gb = [];
    try { gb = await gbSearch(q, author || (pick && pick.author)); } catch (e) { if (ol === null) throw e; }
    const g = best(gb.filter(x => x.url), q);
    if (g && (!pick || norm(g.title) === norm(q))) return { status: 'found', src: 'gb', url: g.url, author: (pick && pick.author) || g.author, year: (pick && pick.year) || g.year, pages: g.pages, key: pick ? pick.key : '', desc: g.desc };
  }
  if (pick) return { status: 'found', src: 'ol', id: pick.id, key: pick.key, author: pick.author, year: pick.year, pages: pick.pages };
  return { status: 'none', at: Date.now() };
}
const queue = [], queued = new Set(), failed = new Set();
let active = 0;
function want(it) {
  const s = slug(it.title), m = meta[s];
  if (queued.has(s) || failed.has(s)) return;
  if (m && (m.status === 'found' || (m.status === 'none' && Date.now() - (m.at || 0) < 7 * 864e5))) return;
  queued.add(s); queue.push(it); pump();
}
function pump() {
  while (active < 2 && queue.length) {
    const it = queue.shift(); active++;
    const s = slug(it.title);
    lookup(it.title, it.series)
      .then(r => { meta[s] = { ...(meta[s] || {}), ...r }; saveMeta(); renderSoon(); })
      .catch(() => { failed.add(s); })
      .finally(() => { active--; queued.delete(s); setTimeout(pump, 150); });
  }
}
function wantAll() { lists.forEach(L => L.items.forEach(want)); }

const descAsked = new Set(), descDone = new Set();
async function loadDesc(title) {
  const s = slug(title), m = meta[s];
  if (!m || m.status !== 'found' || m.desc || descAsked.has(s)) return;
  descAsked.add(s);
  try {
    if (m.key) {
      const w = await getJSON('https://openlibrary.org' + m.key + '.json');
      let d = w.description; if (d && typeof d === 'object') d = d.value;
      if (d) m.desc = String(d).split(/\n-{3,}|\n\*\*\*/)[0].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\r/g, '').trim();
    }
    if (!m.desc) { const g = await gbSearch(splitTitle(title).main, m.author, 3); const hit = g.find(x => x.desc && norm(x.title) === norm(title)) || g.find(x => x.desc); if (hit) m.desc = hit.desc.replace(/<[^>]+>/g, ''); }
  } catch (e) {}
  descDone.add(s); saveMeta(); $('#panel').dataset.for = ''; renderPanel();
}

/* ---------- rendering ---------- */
function genCover(title, series, size) {
  const { main } = splitTitle(title), hs = hash(series || main), ht = hash(main);
  const h1 = hs % 360, h2 = (h1 + 40 + (ht % 80)) % 360;
  const t = size === 's' && view !== 'covers' ? main.replace(/^(the|a|an)\s+/i, '').charAt(0).toUpperCase() : main;
  return `<div class="cv ${size}" style="--h1:${h1};--h2:${h2}" aria-hidden="true"><span class="cv-t">${esc(t)}</span>${series && size !== 's' ? `<span class="cv-s">${esc(series)}</span>` : ''}</div>`;
}
function coverHTML(title, series, size, m) {
  m = m || meta[slug(title)];
  const u = m && m.status === 'found' && !m.broken ? coverUrl(m, size) : null;
  if (!u) return genCover(title, series, size);
  const h1 = hueOf(series || title);
  return `<div class="cv ${size} real" style="--h1:${h1};--h2:${h1}" data-t="${esc(title)}" data-se="${esc(series || '')}" data-sz="${size}"><img src="${esc(u)}" alt="" loading="lazy" decoding="async" draggable="false"></div>`;
}
document.addEventListener('error', e => {
  const img = e.target; if (!img || img.tagName !== 'IMG') return;
  const cv = img.closest('.cv[data-t]'); if (!cv) return;
  const s = slug(cv.dataset.t); if (meta[s] && !img.closest('.res')) { meta[s].broken = true; saveMeta(); }
  cv.outerHTML = genCover(cv.dataset.t, cv.dataset.se, cv.dataset.sz);
}, true);
const chip = s => s ? `<span class="chip" style="--h:${hueOf(s)}">${esc(s)}</span>` : '';

let renderQueued = false;
function renderSoon() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; if (drag.active) { drag.pendingRender = true; return; } render(); }); }
function render() { renderHeader(); renderSystems(); renderBoard(); renderResults(); renderSync(); renderNotice(); renderPanel(); }

function renderHeader() {
  $('#sheet-name').textContent = connected() ? (sheetTitle ? `Synced with “${sheetTitle}”` : 'Google Sheet') : 'Saved on this device';
  $('#board').classList.toggle('covers', view === 'covers');
  $('#view-rows').setAttribute('aria-pressed', view === 'rows');
  $('#view-covers').setAttribute('aria-pressed', view === 'covers');
  $('#hint').textContent = filtering() ? 'Clear the search or series filter to drag books.' : 'Drag books between lists. On touch, press and hold a book to pick it up.';
}

function renderSync(force) {
  const s = $('#sync');
  const set = (st, txt) => { s.dataset.s = st; s.title = txt; s.innerHTML = `<span class="sync-t">${esc(txt)}</span>`; };
  if (!connected()) return set('local', 'This device');
  if (writing) return set('busy', 'Saving…');
  if (force === 'busy' && !loaded) return set('busy', 'Syncing…');
  if (syncErr) return set('err', errKind === 'write' ? 'Not saved' : 'Offline');
  if (dirty) return set('busy', 'Saving…');
  if (!lastSync) return set('busy', 'Syncing…');
  set('ok', 'Synced ' + new Date(lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
}

function renderNotice() {
  const n = $('#notice');
  if (!syncErr) { n.hidden = true; n.innerHTML = ''; return; }
  const w = errKind === 'write';
  n.className = 'notice';
  n.innerHTML = `<p>${w ? '<b>Your last change is saved here but not in the sheet yet.</b> ' : ''}${esc(syncErr.message)}</p>
    ${syncErr.kind === 'net' ? `<button class="btn small" data-act="${w ? 'save' : 'load'}">Try again</button>` : `<button class="btn small" data-act="settings">Open settings</button>`}`;
  n.hidden = false;
}
$('#notice').addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (a.dataset.act === 'save') { dirty = true; flush(); } else if (a.dataset.act === 'load') pull(); else openPanel({ kind: 'settings' });
});
$('#sync').addEventListener('click', () => { if (!connected()) return openPanel({ kind: 'settings' }); if (dirty) flush(); else pull(); hooks.onSyncClick(); });
$('#open-settings').addEventListener('click', () => openPanel({ kind: 'settings' }));

function ring(pct, h) {
  const C = 2 * Math.PI * 15;
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" style="--h:${h}"><circle class="ring-bg" cx="20" cy="20" r="15" fill="none" stroke-width="3"/><circle class="ring" cx="20" cy="20" r="15" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}" transform="rotate(-90 20 20)"/><circle class="core" cx="20" cy="20" r="${(3 + pct * 3).toFixed(1)}"/></svg>`;
}
function renderSystems() {
  const el = $('#systems');
  if (!lists.length) { el.innerHTML = ''; return; }
  const di = doneIdx(), qi = queueIdx();
  const stats = allSeries().map(s => {
    const tot = lists.reduce((n, l) => n + l.items.filter(i => i.series === s).length, 0);
    const d = (lists[di]?.items || []).filter(i => i.series === s).length;
    return { s, tot, d };
  }).sort((a, b) => b.tot - a.tot);
  el.innerHTML = `<div class="tally"><div class="read"><b>${lists[di]?.items.length || 0}</b><span>Read</span></div>${lists.length > 1 && qi !== di ? `<div><b>${lists[qi]?.items.length || 0}</b><span>${esc(lists[qi].name)}</span></div>` : ''}</div>` +
    stats.map(x => `<button class="sys" data-series="${esc(x.s)}" aria-pressed="${filterSeries === x.s}" style="--h:${hueOf(x.s)}">${ring(x.tot ? x.d / x.tot : 0, hueOf(x.s))}<span><div class="sys-name">${esc(x.s)}</div><div class="sys-count">${x.d} of ${x.tot} read</div></span></button>`).join('');
}
$('#systems').addEventListener('click', e => {
  const b = e.target.closest('[data-series]'); if (!b) return;
  filterSeries = filterSeries === b.dataset.series ? null : b.dataset.series; render();
});

function renderBoard() {
  const board = $('#board');
  if (!lists.length) {
    board.innerHTML = `<section class="col"><div class="col-h"><h2>Welcome</h2></div>
      <div style="padding:4px 8px 10px;display:flex;flex-direction:column;gap:12px">
        <p class="status">Connect your Google Sheet to load your lists, or start fresh on this device and connect later.</p>
        <div class="row start"><button class="btn primary" data-welcome="connect">Connect Google Sheet</button><button class="btn" data-welcome="local">Start here</button></div>
      </div></section>`;
    return;
  }
  const q = query.trim().toLowerCase(), di = doneIdx();
  board.innerHTML = lists.map((L, li) => {
    const rows = L.items.map((it, i) => {
      const vis = (!filterSeries || it.series === filterSeries) && (!q || (it.title + ' ' + it.series + ' ' + (meta[slug(it.title)]?.author || '')).toLowerCase().includes(q));
      const { main, note } = splitTitle(it.title), m = meta[slug(it.title)];
      const sub = [m && m.author, note].filter(Boolean);
      return `<li class="bk" data-l="${li}" data-i="${i}"${vis ? '' : ' hidden'}><span class="num">${i + 1}</span>${coverHTML(it.title, it.series, 's')}<button class="bk-main" data-open aria-label="Open ${esc(main)}"><span class="bk-title">${esc(main)}</span>${sub.length ? `<span class="bk-sub">${sub.map((x, k) => k === sub.length - 1 && note ? `<span class="note">${esc(x)}</span>` : esc(x)).join(' · ')}</span>` : ''}${chip(it.series)}${shelfBadge(it.title)}</button>${li !== di ? `<button class="act" data-done title="Mark as read" aria-label="Mark ${esc(main)} as read">✓</button>` : ''}</li>`;
    }).join('');
    return `<section class="col${li === di ? ' done' : ''}"><header class="col-h"><h2>${esc(L.name)}</h2><span class="count">${L.items.length}</span></header><ul class="shelf" data-l="${li}">${rows}</ul>${L.items.length ? '' : '<p class="empty">Drop books here</p>'}</section>`;
  }).join('') + `<section class="col col-new"><form id="newlist"><label for="newlist-name">New list</label><input id="newlist-name" placeholder="e.g. Reading now" autocomplete="off"><button class="btn small" type="submit">Add list</button></form></section>`;
  wantAll();
}
$('#board').addEventListener('submit', e => {
  if (e.target.id !== 'newlist') return;
  e.preventDefault();
  const v = $('#newlist-name').value.trim(); if (!v) return;
  if (lists.some(l => l.name.toLowerCase() === v.toLowerCase())) return toast('You already have a list called ' + v);
  lists.push({ name: v, items: [] }); changed(); toast('Added list ' + v);
});
$('#board').addEventListener('click', e => {
  const w = e.target.closest('[data-welcome]');
  if (w) {
    if (w.dataset.welcome === 'connect') openPanel({ kind: 'settings' });
    else { lists = [{ name: 'Completed', items: [] }, { name: 'Queue', items: [] }]; changed(); $('#q').focus(); toast('Search for a book and press Enter to add it'); }
    return;
  }
  const li = e.target.closest('.bk'); if (!li) return;
  const l = +li.dataset.l, i = +li.dataset.i, it = lists[l]?.items[i]; if (!it) return;
  if (e.target.closest('[data-done]')) {
    const di = doneIdx(); lists[l].items.splice(i, 1); lists[di].items.push(it); changed(); meteor();
    toast(`${splitTitle(it.title).main} moved to ${lists[di].name}`, () => { const f = findBook(it.title); if (f) { lists[f.l].items.splice(f.i, 1); lists[l].items.splice(i, 0, it); changed(); } });
  } else if (e.target.closest('[data-open]')) openPanel({ kind: 'book', title: it.title });
});
$('#view-rows').addEventListener('click', () => { view = 'rows'; store.set('hm-view', view); render(); });
$('#view-covers').addEventListener('click', () => { view = 'covers'; store.set('hm-view', view); render(); });

/* ---------- finding new books ---------- */
$('#q').addEventListener('input', e => { query = e.target.value; renderHeader(); renderBoard(); });
$('#searchform').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) findBooks(q); });
async function findBooks(q) {
  const seq = ++searchSeq;
  resultsState = { status: 'loading', q }; results = []; renderResults();
  let out = [], ok = false;
  try { out = (await olSearch({ q }, 12)).filter(r => r.title); ok = true; } catch (e) {}
  if (out.filter(r => r.id).length < 4) {
    try { const g = await gbSearch(q, '', 8); ok = true; g.forEach(x => { if (!out.some(o => norm(o.title) === norm(x.title) && o.id)) out.push(x); }); } catch (e) {}
  }
  if (seq !== searchSeq) return;
  const seen = new Set();
  results = out.filter(r => { const k = norm(r.title) + '|' + (r.author || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => ((b.id || b.url) ? 1 : 0) - ((a.id || a.url) ? 1 : 0)).slice(0, 12)
    .map(r => ({ ...r, series: seriesForAuthor(r.author) }));
  resultsState = { status: ok ? 'done' : 'error', q };
  renderResults();
}
function renderResults() {
  const el = $('#results');
  if (!resultsState) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const s = resultsState, q = esc(s.q);
  let body;
  if (s.status === 'loading') body = `<p class="status">Scanning the catalogues for “${q}”…</p>`;
  else if (s.status === 'error') body = `<p class="status">Couldn’t reach Open Library or Google Books. Check your connection and press Enter to try again.</p>`;
  else if (!results.length) body = `<p class="status">No books found for “${q}”. Try the exact title or the author’s name.</p>`;
  else body = `<ul class="results-grid">${results.map((r, ri) => {
    const have = findBook(r.title);
    const metaLine = [r.author, r.year].filter(Boolean).join(' · ');
    const acts = have ? `<span class="badge">Already in ${esc(lists[have.l].name)}</span>`
      : lists.length ? lists.map((L, li) => `<button class="btn small${li === queueIdx() ? ' primary' : ''}" data-add="${li}">+ ${esc(L.name)}</button>`).join('')
      : `<button class="btn small primary" data-add="new">+ Queue</button>`;
    return `<li class="res" data-r="${ri}">${coverHTML(r.title, r.series, 'm', { status: 'found', ...r })}<div class="res-body"><span class="res-t">${esc(r.title)}</span>${metaLine ? `<span class="res-m">${esc(metaLine)}</span>` : ''}
      ${have ? '' : `<label class="res-series" for="rs-${ri}">Series <input id="rs-${ri}" list="series-options" value="${esc(r.series)}" placeholder="Standalone"></label>`}
      <div class="res-acts">${acts}</div></div></li>`;
  }).join('')}</ul><datalist id="series-options">${allSeries().map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
  el.innerHTML = `<div class="results-h"><h2>${s.status === 'done' && results.length ? 'Drag onto a list, or tap a button' : 'Find books'}</h2><div class="row"><button class="btn small" data-manual>Add “${q}” as typed</button><button class="btn small" data-closeres>Close</button></div></div>${body}`;
}
function resultSeries(ri) { const inp = document.getElementById('rs-' + ri); return inp ? inp.value.trim() : (results[ri]?.series || ''); }
$('#results').addEventListener('click', e => {
  if (e.target.closest('[data-closeres]')) { resultsState = null; results = []; renderResults(); return; }
  if (e.target.closest('[data-manual]')) { ensureLists(); addBook({ title: resultsState.q, series: filterSeries || '' }, queueIdx()); return; }
  const a = e.target.closest('[data-add]'); if (!a) return;
  const ri = +a.closest('.res').dataset.r, r = results[ri]; if (!r) return;
  if (a.dataset.add === 'new') ensureLists();
  addBook({ ...r, series: resultSeries(ri) }, a.dataset.add === 'new' ? queueIdx() : +a.dataset.add);
});
function ensureLists() { if (!lists.length) lists = [{ name: 'Completed', items: [] }, { name: 'Queue', items: [] }]; }
function addBook(r, li, idx) {
  if (!lists[li]) return;
  const have = findBook(r.title);
  if (have) { toast(`${splitTitle(r.title).main} is already in ${lists[have.l].name}`); render(); return; }
  const it = { title: r.title.trim(), series: (r.series || '').trim() };
  lists[li].items.splice(idx == null ? lists[li].items.length : idx, 0, it);
  if (r.id || r.url || r.author) { meta[slug(it.title)] = { status: r.id || r.url ? 'found' : 'none', at: Date.now(), src: r.src, id: r.id, url: r.url, key: r.key, author: r.author, year: r.year, pages: r.pages, desc: r.desc }; saveMeta(); }
  changed();
  toast(`Added to ${lists[li].name}`, () => { const f = findBook(it.title); if (f) { lists[f.l].items.splice(f.i, 1); changed(); } });
}

/* ---------- drag and drop (pointer events: mouse, pen and touch) ---------- */
const drag = { cand: null, active: false, src: null, ghost: null, ph: null, x: 0, y: 0, dx: 0, dy: 0, raf: 0, suppress: false, pendingRender: false };
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || drag.active) return;
  const src = e.target.closest('.bk, .res');
  if (!src || e.target.closest('.act, .res button, input, select, label, a')) return;
  if (src.classList.contains('bk') && filtering()) return;
  drag.cand = { src, x: e.clientX, y: e.clientY, type: e.pointerType, timer: null };
  drag.x = e.clientX; drag.y = e.clientY;
  if (e.pointerType !== 'mouse') drag.cand.timer = setTimeout(() => { if (drag.cand) startDrag(); }, 300);
});
window.addEventListener('pointermove', e => {
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.active) { moveDrag(); return; }
  const c = drag.cand; if (!c) return;
  const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
  if (c.type === 'mouse' ? d > 5 : d > 10) { if (c.type === 'mouse') startDrag(); else cancelCand(); }
});
window.addEventListener('pointerup', () => { if (drag.active) endDrag(true); cancelCand(); });
window.addEventListener('pointercancel', () => { if (drag.active) endDrag(false); cancelCand(); });
window.addEventListener('touchmove', e => { if (drag.active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => { if (e.target.closest('.bk, .res')) e.preventDefault(); });
document.addEventListener('click', e => { if (drag.suppress) { e.stopPropagation(); e.preventDefault(); drag.suppress = false; } }, true);
document.addEventListener('dragstart', e => { if (e.target.closest && e.target.closest('.bk, .res')) e.preventDefault(); });
function cancelCand() { if (drag.cand) { clearTimeout(drag.cand.timer); drag.cand = null; } }
function startDrag() {
  const c = drag.cand; if (!c) return; clearTimeout(c.timer); drag.cand = null;
  const src = c.src, r = src.getBoundingClientRect();
  drag.active = true; drag.src = src; drag.dx = c.x - r.left; drag.dy = c.y - r.top;
  const g = src.cloneNode(true); g.classList.add('ghost'); g.removeAttribute('data-r'); g.removeAttribute('data-l');
  g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
  document.body.appendChild(g); drag.ghost = g;
  const ph = document.createElement('li'); ph.className = 'placeholder';
  if (src.classList.contains('bk')) { ph.style.height = r.height + 'px'; src.parentNode.insertBefore(ph, src); src.hidden = true; }
  else { ph.style.height = view === 'covers' ? '' : '72px'; if (view === 'covers') ph.style.aspectRatio = '2 / 3.4'; }
  drag.ph = ph;
  document.body.classList.add('dragging');
  if (c.type !== 'mouse' && navigator.vibrate) try { navigator.vibrate(12); } catch (e) {}
  moveDrag(); autoScroll();
}
function moveDrag() {
  const { x, y, ghost, ph } = drag;
  ghost.style.left = (x - drag.dx) + 'px'; ghost.style.top = (y - drag.dy) + 'px';
  const shelf = document.elementFromPoint(x, y)?.closest('.shelf');
  document.querySelectorAll('.shelf.over').forEach(s => s !== shelf && s.classList.remove('over'));
  if (!shelf) { if (!drag.src.classList.contains('bk') && ph.parentNode) ph.remove(); return; }
  shelf.classList.add('over');
  const covers = view === 'covers';
  let before = null;
  for (const it of shelf.children) {
    if (!it.classList.contains('bk') || it.hidden) continue;
    const r = it.getBoundingClientRect();
    if (covers ? (y < r.top || (y < r.bottom && x < r.left + r.width / 2)) : y < r.top + r.height / 2) { before = it; break; }
  }
  if (ph.parentNode !== shelf || ph.nextSibling !== before) shelf.insertBefore(ph, before);
}
function autoScroll() {
  cancelAnimationFrame(drag.raf);
  const step = () => {
    if (!drag.active) return;
    const edge = 80, h = window.innerHeight;
    let v = 0;
    if (drag.y < edge) v = -Math.ceil((edge - drag.y) / 5); else if (drag.y > h - edge) v = Math.ceil((drag.y - (h - edge)) / 5);
    if (v) { window.scrollBy(0, v); moveDrag(); }
    drag.raf = requestAnimationFrame(step);
  };
  drag.raf = requestAnimationFrame(step);
}
function endDrag(commit) {
  cancelAnimationFrame(drag.raf);
  const { src, ghost, ph } = drag;
  const shelf = ph.parentNode && ph.parentNode.classList && ph.parentNode.classList.contains('shelf') ? ph.parentNode : null;
  let tl = -1, idx = -1;
  if (shelf) { tl = +shelf.dataset.l; idx = 0; for (const n of shelf.children) { if (n === ph) break; if (n.classList.contains('bk') && n !== src) idx++; } }
  ghost.remove(); ph.remove(); src.hidden = false;
  document.querySelectorAll('.shelf.over').forEach(s => s.classList.remove('over'));
  document.body.classList.remove('dragging');
  drag.active = false; drag.src = drag.ghost = drag.ph = null;
  drag.suppress = true; setTimeout(() => { drag.suppress = false; }, 60);
  if (commit && tl >= 0 && lists[tl]) {
    if (src.classList.contains('bk')) {
      const fl = +src.dataset.l, fi = +src.dataset.i;
      if (!(fl === tl && fi === idx)) {
        const [it] = lists[fl].items.splice(fi, 1); lists[tl].items.splice(idx, 0, it);
        changed(); if (tl === doneIdx() && fl !== tl) meteor();
        drag.pendingRender = false; return;
      }
    } else {
      const ri = +src.dataset.r, r = results[ri];
      if (r) { addBook({ ...r, series: resultSeries(ri) }, tl, idx); drag.pendingRender = false; return; }
    }
  }
  if (drag.pendingRender) { drag.pendingRender = false; render(); }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (drag.active) { endDrag(false); return; }
    if (panel) { closePanel(); return; }
    if (resultsState) { resultsState = null; results = []; renderResults(); }
  }
  if (e.key === '/' && document.body.dataset.tab === 'lists' && !document.body.classList.contains('reading') && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
});

/* ---------- side panel: book details & settings ---------- */
function openPanel(p) {
  const wasOpen = !!panel;
  panel = p; confirmRemove = false; pickState = null;
  $('#panel').hidden = false; $('#scrim').hidden = false; $('#panel').dataset.for = '';
  if (!wasOpen) try { history.pushState({ panelOpen: 1 }, ''); } catch (e) {}
  renderPanel();
  if (p.kind === 'book') loadDesc(p.title);
  $('#panel').scrollTop = 0;
  setTimeout(() => $('#panel .p-close')?.focus(), 0);
}
function closePanel(fromHistory) {
  if (!panel) return;
  panel = null; $('#panel').hidden = true; $('#scrim').hidden = true;
  if (!fromHistory && history.state && history.state.panelOpen) try { history.back(); } catch (e) {}
}
window.addEventListener('popstate', () => closePanel(true));
$('#scrim').addEventListener('click', () => closePanel());

const later = (fn, ms = 60) => setTimeout(fn, ms);

function renderPanel() {
  const p = $('#panel'); if (!panel || p.hidden) return;
  const key = panel.kind + ':' + (panel.title || '');
  const ae = document.activeElement;
  if (ae && p.contains(ae) && ae.tagName === 'INPUT' && p.dataset.for === key) return; // don't clobber typing
  p.dataset.for = key;
  if (panel.kind === 'settings') return renderSettings(p);
  const f = findBook(panel.title); if (!f) { closePanel(); return; }
  const { it, l, i } = f, m = meta[slug(it.title)] || {}, { main, note } = splitTitle(it.title);
  const metaLine = [m.author, m.year, m.pages ? m.pages + ' pages' : ''].filter(Boolean).join(' · ');
  let desc = m.desc || '';
  if (!desc) loadDesc(it.title);
  if (desc.length > 700) desc = desc.slice(0, 680).replace(/\s+\S*$/, '') + '…';
  p.innerHTML = `<button class="btn small p-close" data-close>Close</button>
    ${coverHTML(it.title, it.series, 'l')}
    <div class="row"><button class="btn small" data-pick>${pickState ? 'Hide covers' : 'Choose a different cover'}</button></div>
    ${pickState ? renderPicks() : ''}
    ${onShelf(it.title) ? `<div class="row"><button class="btn primary" data-read>📖 Read now · ${Math.round((onShelf(it.title).percent || 0) * 100)}%</button></div>` : ''}
    <p class="p-kicker" style="text-align:center">${esc(it.series || 'Standalone')} · ${esc(lists[l].name)}</p>
    <h2 class="p-h">${esc(main)}</h2>${metaLine ? `<p class="p-meta">${esc(metaLine)}</p>` : ''}
    ${note ? `<p class="p-meta"><i>${esc(note)}</i></p>` : ''}
    ${desc ? `<p class="p-desc">${esc(desc)}</p><span class="via">From ${m.src === 'gb' && !m.key ? 'Google Books' : 'Open Library'}</span>` : m.status === 'found' && !descDone.has(slug(it.title)) ? '<p class="status">Loading description…</p>' : ''}
    <hr class="sep">
    <div class="field"><label for="p-title">Title (as written in the sheet)</label><input id="p-title" value="${esc(it.title)}"></div>
    <div class="field"><label for="p-series">Series</label><input id="p-series" list="p-serieslist" value="${esc(it.series)}" placeholder="Standalone"><datalist id="p-serieslist">${allSeries().map(s => `<option value="${esc(s)}">`).join('')}</datalist></div>
    <div class="field"><span class="lbl">Move to</span><div class="row start">${lists.map((L, li) => li === l ? '' : `<button class="btn small" data-move="${li}">${esc(L.name)}</button>`).join('')}<button class="btn small" data-top>Top of ${esc(lists[l].name)}</button><button class="btn small" data-up${i === 0 ? ' disabled' : ''}>Move up</button><button class="btn small" data-down${i === lists[l].items.length - 1 ? ' disabled' : ''}>Move down</button></div></div>
    <div class="row"><button class="btn small danger" data-remove>${confirmRemove ? 'Tap again to remove' : 'Remove from list'}</button></div>`;
}
function renderPicks() {
  if (pickState.status === 'loading') return '<p class="status" style="text-align:center">Finding covers…</p>';
  if (pickState.status === 'error') return '<p class="status" style="text-align:center">Couldn’t load covers. Check your connection.</p>';
  if (!pickState.items.length) return '<p class="status" style="text-align:center">No other covers found.</p>';
  const cur = meta[slug(panel.title)] || {};
  return `<div class="pick-grid">${pickState.items.map((c, i) => {
    const on = (c.src === 'ol' && cur.src === 'ol' && c.id === cur.id) || (c.src === 'gb' && cur.src === 'gb' && c.url === cur.url);
    return `<button class="pick" data-pickone="${i}" aria-pressed="${on}" aria-label="Use cover ${i + 1}"><img src="${esc(coverUrl(c, 'm'))}" alt="" loading="lazy" draggable="false"></button>`;
  }).join('')}</div>`;
}
async function loadPicks(title) {
  pickState = { status: 'loading', items: [] }; renderPanel();
  const m = meta[slug(title)] || {}, q = splitTitle(title).main, items = [], seen = new Set();
  const add = c => { const k = c.src + (c.id || c.url); if ((c.id || c.url) && !seen.has(k)) { seen.add(k); items.push(c); } };
  let any = false;
  try {
    if (m.key) { const ed = await getJSON('https://openlibrary.org' + m.key + '/editions.json?limit=50'); any = true; (ed.entries || []).forEach(e => (e.covers || []).filter(x => x > 0).slice(0, 1).forEach(id => add({ src: 'ol', id }))); }
  } catch (e) {}
  try { (await olSearch(m.author ? { title: q, author: m.author } : { title: q }, 8)).forEach(c => add(c)); any = true; } catch (e) {}
  try { (await gbSearch(q, m.author, 8)).forEach(c => add(c)); any = true; } catch (e) {}
  if (!panel || panel.title !== title) return;
  pickState = { status: any ? 'done' : 'error', items: items.slice(0, 24) };
  $('#panel').dataset.for = ''; renderPanel();
}
function renderSettings(p) {
  const n = Object.values(meta).filter(m => m.status === 'found' && !m.broken).length;
  const st = settings.get(), c = cfg();
  p.innerHTML = `<button class="btn small p-close" data-close>Close</button>
    <p class="p-kicker">Settings</p>
    <h2 class="p-h" style="text-align:left">Connect your Google Sheet</h2>
    <p class="p-desc">One sheet holds both your lists (first tab) and your reading positions (a <code>Progress</code> tab Harmonarium adds).</p>
    <ol class="steps">
      <li>Open your sheet, then <b>Extensions → Apps Script</b>.</li>
      <li>Replace the code with <code>sync/Code.gs</code> from the Harmonarium repo, and change <code>TOKEN</code> to a long random phrase.</li>
      <li><b>Deploy → New deployment</b>, type <b>Web app</b>, execute as <b>Me</b>, access <b>Anyone</b>. Approve the permissions.</li>
      <li>Paste the Web app URL and your token here, on every device.</li>
    </ol>
    <div class="field"><label for="s-url">Web app URL</label><input id="s-url" value="${esc(c.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label for="s-token">Token</label><input id="s-token" type="password" value="${esc(c.token)}" autocomplete="off" spellcheck="false"></div>
    <div class="row start"><button class="btn primary" data-connect>${connected() ? 'Save and sync' : 'Connect'}</button>${connected() ? '<button class="btn" data-disconnect>Disconnect</button>' : ''}</div>
    <p class="status" id="s-status">${connected() ? (lastSync ? 'Last synced ' + esc(new Date(lastSync).toLocaleString()) : 'Connected.') : 'Not connected. Everything is saved on this device only.'}</p>
    <hr class="sep">
    <p class="p-kicker">Reading sync</p>
    <div class="field"><label for="s-device">This device's name</label><input id="s-device" value="${esc(st.deviceName)}" placeholder="e.g. Pixel, Dorm laptop" autocomplete="off"></div>
    <label class="check"><input id="s-autojump" type="checkbox"${st.autoJump ? ' checked' : ''}> Jump to a newer position from another device without asking</label>
    <hr class="sep">
    <p class="p-kicker">Appearance</p>
    <label class="check re-switch"><input id="s-readera" type="checkbox" role="switch"${readera.enabled() ? ' checked' : ''}> <span><b>Look and feel like ReadEra</b><br><small>Menu drawer, list of books, full-screen reader with tools along the bottom. Lists and sync stay.</small></span></label>
    <div class="field" id="s-readera-tone-f"${readera.enabled() ? '' : ' hidden'}><label for="s-readera-tone">ReadEra colours</label><select id="s-readera-tone">
      <option value="auto"${readera.tone() === 'auto' ? ' selected' : ''}>Follow the system (light or dark)</option>
      <option value="light"${readera.tone() === 'light' ? ' selected' : ''}>Light</option>
      <option value="dark"${readera.tone() === 'dark' ? ' selected' : ''}>Dark</option></select></div>
    <label class="check re-switch"><input id="s-re-reader" type="checkbox" role="switch"${readera.readerEnabled() ? ' checked' : ''}${readera.enabled() ? ' disabled' : ''}> <span><b>ReadEra-style reader</b><br><small>Inside a book: full-screen pages, toolbars on a tap, Contents / Text / Day–Night along the bottom. Works with every look.</small></span></label>
    <div class="modes${readera.enabled() ? ' muted' : ''}" role="group" aria-label="Appearance">${appearance.MODES.map(m => `<button class="mode-btn" data-mode="${m.id}" aria-pressed="${appearance.get() === m.id}"><span class="mode-sw ${m.id}"></span>${m.name}</button>`).join('')}</div>
    <hr class="sep">
    <p class="p-kicker">Controls</p>
    <div class="field"><label for="s-keypad">Keypad mode</label><select id="s-keypad">
      <option value="auto"${st.keypadMode === 'auto' ? ' selected' : ''}>Automatic (on for Sailfish phones and keypad devices)</option>
      <option value="on"${st.keypadMode === 'on' ? ' selected' : ''}>On</option>
      <option value="off"${st.keypadMode === 'off' ? ' selected' : ''}>Off</option></select></div>
    <p class="p-desc">Keypad mode keeps the focus ring visible and adds number keys: 2 4 6 8 move, 5 selects. At home 1 Shelf, 3 Lists, 0 Add books, * Search, # Settings. In a book 4/6 turn pages, 1 Contents, 3 Text, * and # change the size, 0 changes the theme.</p>
    <p class="p-desc">Books match across devices only when each holds the very same EPUB file.</p>
    <hr class="sep">
    <p class="p-kicker">Import from ReadEra</p>
    <p class="p-desc">Bring over how far you've read each book. In ReadEra, make a backup (Settings → Backup &amp; restore), then choose that file here. Books that already have a place in Harmonarium keep it; books you haven't added yet get theirs when you add them.</p>
    <div class="row start"><label class="btn small">Choose ReadEra backup…<input id="s-readera-import" type="file" hidden></label></div>
    <p class="status" id="s-readera-import-status"></p>
    <hr class="sep">
    <p class="p-kicker">Covers</p>
    <p class="p-desc">List covers come from Open Library, with Google Books as a backup. ${n} of ${lists.reduce((a, L) => a + L.items.length, 0)} books have one.</p>
    <div class="row start"><button class="btn small" data-recovers>Look for missing covers again</button></div>
    <hr class="sep">
    <div id="s-update"></div>${updater.available() ? '<hr class="sep">' : ''}
    <p class="via">Harmonarium ${esc(updater.currentVersion())}</p>`;
  updater.mount(p.querySelector('#s-update'));
}
$('#panel').addEventListener('click', async e => {
  if (e.target.closest('[data-close]')) return closePanel();
  if (!panel) return;
  if (panel.kind === 'settings') {
    // Only the mode buttons: <html> carries data-mode too, so a bare [data-mode] matched every click.
    const mb = e.target.closest('.mode-btn[data-mode]');
    if (mb) {
      appearance.set(mb.dataset.mode);
      for (const b of $('#panel').querySelectorAll('.mode-btn[data-mode]')) b.setAttribute('aria-pressed', String(b === mb));
      return;
    }
    if (e.target.closest('[data-connect]')) {
      const url = $('#s-url').value.trim(), token = $('#s-token').value.trim(), st = $('#s-status');
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { st.textContent = 'That doesn’t look like an Apps Script Web app URL. It starts with https://script.google.com/macros/s/'; return; }
      if (!token) { st.textContent = 'Enter the token you set in the script.'; return; }
      const prev = cfg(); await settings.update({ syncUrl: url, syncKey: token }); st.textContent = 'Connecting…';
      try {
        const d = await bridge('GET');
        const sheetLists = parse(d.values || []);
        if (!sheetLists.length && lists.some(L => L.items.length)) { if (d.title) { sheetTitle = d.title; store.set('hm-title', sheetTitle); } dirty = true; await flush(); }
        else adopt(d);
        $('#panel').dataset.for = ''; render(); toast('Connected to ' + (sheetTitle || 'your sheet'));
        hooks.onSettingsSaved();
      } catch (err) { await settings.update({ syncUrl: prev.url, syncKey: prev.token }); st.textContent = err.message; }
    } else if (e.target.closest('[data-disconnect]')) {
      await settings.update({ syncUrl: '', syncKey: '' }); syncErr = null; dirty = false; lastSync = null; store.set('hm-lastsync', null);
      $('#panel').dataset.for = ''; render(); toast('Disconnected. Everything stays on this device.');
    } else if (e.target.closest('[data-recovers]')) {
      Object.keys(meta).forEach(k => { if (meta[k].status === 'none' || meta[k].broken) delete meta[k]; });
      failed.clear(); saveMeta(); wantAll(); toast('Looking for covers…');
    }
    return;
  }
  const f = findBook(panel.title); if (!f) return;
  if (e.target.closest('[data-read]')) { const b = onShelf(f.it.title); if (b) { closePanel(); hooks.openBook(b.id); } return; }
  if (e.target.closest('[data-pick]')) { if (pickState) { pickState = null; $('#panel').dataset.for = ''; renderPanel(); } else loadPicks(f.it.title); return; }
  const pk = e.target.closest('[data-pickone]');
  if (pk) {
    const c = pickState.items[+pk.dataset.pickone], s = slug(f.it.title), m = meta[s] || {};
    meta[s] = { ...m, status: 'found', broken: false, src: c.src, id: c.id || null, url: c.url || null, author: m.author || c.author, year: m.year || c.year, key: m.key || c.key };
    saveMeta(); $('#panel').dataset.for = ''; render(); return;
  }
  const mv = e.target.closest('[data-move]');
  if (mv) { const to = +mv.dataset.move; lists[f.l].items.splice(f.i, 1); lists[to].items.push(f.it); changed(); if (to === doneIdx()) meteor(); toast(`Moved to ${lists[to].name}`); return; }
  if (e.target.closest('[data-top]')) { lists[f.l].items.splice(f.i, 1); lists[f.l].items.unshift(f.it); changed(); return; }
  const step = e.target.closest('[data-up]') ? -1 : e.target.closest('[data-down]') ? 1 : 0;
  if (step) {
    const items = lists[f.l].items, j = f.i + step;
    if (j < 0 || j >= items.length) return;
    [items[f.i], items[j]] = [items[j], items[f.i]];
    $('#panel').dataset.for = ''; changed();
    later(() => $(step < 0 ? '#panel [data-up]' : '#panel [data-down]')?.focus(), 150);
    return;
  }
  if (e.target.closest('[data-remove]')) {
    if (!confirmRemove) { confirmRemove = true; $('#panel').dataset.for = ''; renderPanel(); return; }
    const { l, i, it } = f; lists[l].items.splice(i, 1); closePanel(); changed();
    toast(`Removed ${splitTitle(it.title).main}`, () => { lists[l].items.splice(i, 0, it); changed(); });
  }
});
$('#panel').addEventListener('change', async e => {
  if (panel && panel.kind === 'settings') {
    if (e.target.id === 's-device' && e.target.value.trim()) { await settings.update({ deviceName: e.target.value.trim() }); toast('Device name saved'); }
    else if (e.target.id === 's-autojump') await settings.update({ autoJump: e.target.checked });
    else if (e.target.id === 's-readera') {
      readera.setEnabled(e.target.checked);
      $('#s-readera-tone-f').hidden = !e.target.checked;
      const rr = $('#s-re-reader'); if (rr) { rr.disabled = e.target.checked; rr.checked = readera.readerEnabled(); }
      $('#panel .modes')?.classList.toggle('muted', e.target.checked);
      toast(e.target.checked ? 'ReadEra look on' : 'ReadEra look off');
    }
    else if (e.target.id === 's-readera-tone') readera.setTone(e.target.value);
    else if (e.target.id === 's-readera-import' && e.target.files?.[0]) {
      const out = $('#s-readera-import-status'), file = e.target.files[0];
      e.target.value = '';
      out.textContent = 'Reading the backup…';
      try {
        const r = await readeraImport.importBackup(file);
        const parts = [];
        if (r.applied) parts.push(`${r.applied} ${r.applied === 1 ? 'book has its' : 'books have their'} place from ReadEra`);
        if (r.kept) parts.push(`${r.kept} already had a place here and kept it`);
        if (r.waiting) parts.push(`${r.waiting} ${r.waiting === 1 ? "isn't" : "aren't"} on your shelf yet and will get ${r.waiting === 1 ? 'its' : 'their'} place when added`);
        out.textContent = r.total ? parts.join('; ') + '.' : 'No books with progress were found in that backup.';
        toast(r.applied ? `Imported your place in ${r.applied} ${r.applied === 1 ? 'book' : 'books'}` : 'ReadEra backup read');
        window.dispatchEvent(new Event('harmonarium:shelf'));
      } catch (err) {
        out.textContent = `Couldn't import: ${err.message}`;
      }
    }
    else if (e.target.id === 's-re-reader') readera.setReader(e.target.checked);
    else if (e.target.id === 's-keypad') { await settings.update({ keypadMode: e.target.value }); window.dispatchEvent(new Event('harmonarium:keypad')); }
    return;
  }
  if (!panel || panel.kind !== 'book') return;
  const f = findBook(panel.title); if (!f) return;
  if (e.target.id === 'p-title') {
    const v = e.target.value.trim(); if (!v || v === f.it.title) return;
    const other = findBook(v); if (other && other.it !== f.it) { toast('That title is already on a list'); e.target.value = f.it.title; return; }
    const old = meta[slug(f.it.title)]; f.it.title = v; panel.title = v;
    if (old && !meta[slug(v)]) { meta[slug(v)] = old; saveMeta(); }
    changed();
  } else if (e.target.id === 'p-series') { f.it.series = e.target.value.trim(); changed(); }
});

/* ---------- starfield ---------- */
const sky = (() => {
  const c = $('#sky'), ctx = c.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, stars = [], meteors = [], last = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(500, Math.round(w * h / 3800));
    stars = Array.from({ length: n }, () => {
      const big = Math.random() < 0.07;
      return { x: Math.random() * w, y: Math.random() * h, r: big ? 1 + Math.random() * 1.1 : 0.3 + Math.random() * 0.8, a: Math.random() * 6.28, s: 0.4 + Math.random() * 1.4,
        v: 0.015 + Math.random() * 0.05, c: Math.random() < 0.12 ? (Math.random() < 0.5 ? '#ffd9a0' : '#a8e8ff') : '#ffffff' };
    });
    if (reduce) draw(0);
  }
  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const tw = reduce ? 0.75 : 0.5 + 0.5 * Math.sin(s.a + t * 0.0012 * s.s);
      ctx.globalAlpha = 0.25 + tw * 0.75; ctx.fillStyle = s.c;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
      if (s.r > 1) { ctx.globalAlpha = tw * 0.18; ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 3.5, 0, 6.283); ctx.fill(); }
      if (!reduce) { s.y += s.v; if (s.y > h + 3) { s.y = -3; s.x = Math.random() * w; } }
    }
    meteors = meteors.filter(m => m.life > 0);
    for (const m of meteors) {
      m.x += m.vx; m.y += m.vy; m.life -= 1;
      const a = Math.min(1, m.life / 25), tail = 140;
      const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx / m.sp * tail, m.y - m.vy / m.sp * tail);
      g.addColorStop(0, `rgba(255,230,170,${a})`); g.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx / m.sp * tail, m.y - m.vy / m.sp * tail); ctx.stroke();
      ctx.fillStyle = `rgba(255,248,225,${a})`; ctx.beginPath(); ctx.arc(m.x, m.y, 2, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  // Only the Space mode shows the sky; elsewhere the loop stops until Space comes back.
  const space = () => document.documentElement.getAttribute('data-mode') === 'space' && !document.documentElement.hasAttribute('data-readera');
  let running = false;
  function loop(t) {
    if (!space()) { running = false; return; }
    if (!document.hidden && t - last > 33) { last = t; draw(t); }
    requestAnimationFrame(loop);
  }
  function start() { if (!reduce && !running && space()) { running = true; requestAnimationFrame(loop); } }
  window.addEventListener('resize', resize);
  window.addEventListener('harmonarium:mode', start);
  window.addEventListener('harmonarium:readera', start);
  resize();
  start();
  return {
    meteor() {
      if (reduce || !space()) return;
      const sp = 14, ang = (200 + Math.random() * 25) * Math.PI / 180;
      meteors.push({ x: w * (0.55 + Math.random() * 0.45), y: h * Math.random() * 0.3, vx: Math.cos(ang) * sp, vy: -Math.sin(ang) * sp, sp, life: 60 });
    },
  };
})();
function meteor() { sky.meteor(); }

/* ---------- links to the Shelf ---------- */
let hooks = { openBook: () => {}, onSyncClick: () => {}, onSettingsSaved: () => {} };
let shelf = new Map(); // norm(title) -> { id, percent }
const shelfKeys = t => { const a = norm(t), b = norm(String(t).split(':')[0]); return a === b ? [a] : [a, b]; };
function onShelf(title) { for (const k of shelfKeys(title)) if (shelf.has(k)) return shelf.get(k); return null; }
function shelfBadge(title) { const b = onShelf(title); return b ? `<span class="onshelf" title="On your shelf">📖 ${Math.round((b.percent || 0) * 100)}%</span>` : ''; }

/** Called by the Shelf whenever it re-renders: which EPUBs exist here and how far along they are. */
export function setShelf(books, progress) {
  const next = new Map();
  for (const b of books) {
    const v = { id: b.id, percent: progress.get(b.id)?.percent || 0 };
    for (const k of shelfKeys(b.title)) if (k) next.set(k, v);
  }
  shelf = next;
  if (lists.length) renderSoon();
}

/** Where (if anywhere) a book title sits in the lists. */
export function listFor(title) {
  const keys = shelfKeys(title);
  for (let l = 0; l < lists.length; l++) for (const it of lists[l].items) if (keys.includes(norm(it.title))) return { l, name: lists[l].name, done: l === doneIdx(), title: it.title };
  return null;
}

/** The reader reached the end of a book: offer to move it to the Completed list. */
export function offerFinish(title) {
  const where = listFor(title);
  if (where && where.done) return;
  const main = splitTitle(title).main;
  toast(`Finished “${main}”?`, () => {
    ensureLists();
    const di = doneIdx();
    const w = listFor(title);
    if (w) { const i = lists[w.l].items.findIndex(x => x.title === w.title); const [it] = lists[w.l].items.splice(i, 1); lists[di].items.push(it); }
    else lists[di].items.push({ title: main, series: '' });
    changed(); meteor(); toast(`Moved to ${lists[di].name}`);
  }, `Mark as read`);
}

export function openSettings() { openPanel({ kind: 'settings' }); }
export function refresh() { if (connected()) { if (dirty) flush(); else pull(); } }

/* ---------- boot ---------- */
export function init(h) {
  hooks = { ...hooks, ...h };
  render();
  if (connected()) pull(); else loaded = true;
  setInterval(() => { if (!document.hidden && connected()) pull(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && connected()) pull(); });
  window.addEventListener('online', () => { failed.clear(); if (connected()) { if (dirty) flush(); else pull(); } wantAll(); });
}
