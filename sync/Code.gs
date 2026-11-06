/**
 * Starborn — Google Sheet bridge
 * ------------------------------
 * One script serves both halves of the app:
 *   • Lists  – the reading tracker. Pairs of columns in the lists tab:
 *              a list name in row 1 (Completed, Queue, …) followed by a "Series" column.
 *   • Progress – reading positions, one row per (book, device), on a "Progress" tab
 *              that the script creates for you.
 *
 * Setup: paste into Extensions → Apps Script, change TOKEN below to a long random
 * phrase, then Deploy → New deployment → Web app, "Execute as: Me",
 * "Who has access: Anyone". Paste the Web app URL and TOKEN into Starborn's Settings.
 * Full guide: sync/SETUP.md
 *
 * Coming from KosmicLitTrack? Replace that script with this one and keep your TOKEN.
 */

const TOKEN = 'change-me-to-something-long-and-random';
const LIST_SHEET_NAME = '';        // leave empty to use the first tab that isn't "Progress"
const PROGRESS_SHEET_NAME = 'Progress';

const P_HEADERS = ['book_id', 'title', 'author', 'cfi', 'percent', 'chapter',
                   'device_id', 'device_name', 'updated_at', 'updated'];

/* ---------------- shared ---------------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(t) {
  if (TOKEN.indexOf('change-me') === 0) throw new Error('Set TOKEN in the Apps Script before using the bridge.');
  if (t !== TOKEN) throw new Error('Wrong token.');
}

/* ---------------- lists ---------------- */

function listSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (LIST_SHEET_NAME) return ss.getSheetByName(LIST_SHEET_NAME);
  const tabs = ss.getSheets().filter(function (s) { return s.getName() !== PROGRESS_SHEET_NAME; });
  return tabs.length ? tabs[0] : ss.insertSheet('Lists', 0);
}

function readLists_() {
  const sh = listSheet_();
  const lastRow = Math.max(sh.getLastRow(), 1), lastCol = Math.max(sh.getLastColumn(), 1);
  // Display values keep titles like "1984" as text instead of turning them into numbers.
  const values = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  return { ok: true, title: SpreadsheetApp.getActiveSpreadsheet().getName(), values: values };
}

function writeLists_(values) {
  if (!Array.isArray(values) || !values.length || !Array.isArray(values[0])) throw new Error('No values sent.');
  const width = Math.max.apply(null, values.map(function (r) { return r.length; }));
  const rows = values.map(function (r) {
    const out = r.slice(0, width).map(function (v) { return v == null ? '' : String(v); });
    while (out.length < width) out.push('');
    return out;
  });
  const sh = listSheet_();
  const oldRows = sh.getLastRow(), oldCols = sh.getLastColumn();
  const range = sh.getRange(1, 1, rows.length, width);
  range.setNumberFormat('@');
  range.setValues(rows);
  // Clear anything left over below or to the right of the new data.
  if (oldRows > rows.length) sh.getRange(rows.length + 1, 1, oldRows - rows.length, Math.max(oldCols, width)).clearContent();
  if (oldCols > width) sh.getRange(1, width + 1, Math.max(oldRows, rows.length), oldCols - width).clearContent();
  SpreadsheetApp.flush();
  return readLists_();
}

/* ---------------- reading progress ---------------- */

function progressSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PROGRESS_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(PROGRESS_SHEET_NAME, ss.getSheets().length); // last, so the lists tab stays first
    sh.getRange(1, 1, 1, P_HEADERS.length).setValues([P_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Keep IDs and CFIs as plain text so Sheets never "helpfully" reformats them.
    sh.getRange('A:H').setNumberFormat('@');
  }
  return sh;
}

function readProgress_() {
  const sh = progressSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, P_HEADERS.length).getValues();
  return values.map(function (r, i) {
    const o = { _row: i + 2 };
    P_HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    o.percent = Number(o.percent) || 0;
    o.updated_at = Number(o.updated_at) || 0;
    return o;
  }).filter(function (o) { return o.book_id; });
}

function clean_(o) {
  const c = Object.assign({}, o);
  delete c._row;
  delete c.updated;
  return c;
}

function putProgress_(entries) {
  const sh = progressSheet_();
  const index = new Map(readProgress_().map(function (r) { return [r.book_id + '|' + r.device_id, r]; }));
  let written = 0, skipped = 0;
  (entries || []).forEach(function (en) {
    if (!en.book_id || !en.device_id || !en.cfi) { skipped++; return; }
    const at = Number(en.updated_at) || Date.now();
    const row = P_HEADERS.map(function (h) {
      if (h === 'updated_at') return at;
      if (h === 'updated') return new Date(at);
      if (h === 'percent') return Number(en.percent) || 0;
      return String(en[h] == null ? '' : en[h]);
    });
    const key = en.book_id + '|' + en.device_id;
    const existing = index.get(key);
    if (existing) {
      if (existing.updated_at >= at) { skipped++; return; } // older than what's stored
      sh.getRange(existing._row, 1, 1, P_HEADERS.length).setValues([row]);
      existing.updated_at = at;
    } else {
      sh.appendRow(row);
      index.set(key, { _row: sh.getLastRow(), updated_at: at });
    }
    written++;
  });
  return { ok: true, written: written, skipped: skipped };
}

/* ---------------- endpoints ---------------- */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    checkToken_(p.token || p.key);
    switch (p.action || 'lists') {
      case 'lists': return json_(readLists_());
      case 'ping':  return json_({ ok: true, rows: readProgress_().length });
      case 'get':   return json_({ ok: true, entries: readProgress_().filter(function (r) { return r.book_id === p.book_id; }).map(clean_) });
      case 'list':  return json_({ ok: true, entries: readProgress_().map(clean_) });
      default:      return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkToken_(body.token || body.key);
    lock.waitLock(20000);
    const action = body.action || (body.values ? 'lists' : '');
    if (action === 'lists') return json_(writeLists_(body.values));
    if (action === 'put') return json_(putProgress_(body.entries));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
