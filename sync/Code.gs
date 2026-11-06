/**
 * KosmicLitSync — Google Sheet sync endpoint
 * ------------------------------------------
 * Paste this into Extensions → Apps Script of the Google Sheet you want to use
 * for syncing, set a SYNC_KEY script property, and deploy as a Web App.
 * Full steps: sync/SETUP.md
 *
 * The "Progress" tab holds one row per (book, device):
 *   book_id | title | author | cfi | percent | chapter | device_id | device_name | updated_at | updated
 *
 * book_id is "sha256:<hash of the EPUB file>", so devices only match a book
 * when they hold the very same file.
 */

const SHEET_NAME = 'Progress';
const HEADERS = ['book_id', 'title', 'author', 'cfi', 'percent', 'chapter',
                 'device_id', 'device_name', 'updated_at', 'updated'];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i]));

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Keep IDs and CFIs as plain text so Sheets never "helpfully" reformats them.
    sh.getRange('A:H').setNumberFormat('@');
  }
  return sh;
}

function checkKey_(key) {
  const want = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!want) throw new Error('SYNC_KEY script property is not set');
  if (String(key || '') !== want) throw new Error('Wrong sync key');
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function readAll_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return values.map((r, i) => {
    const o = { _row: i + 2 };
    HEADERS.forEach((h, j) => { o[h] = r[j]; });
    o.percent = Number(o.percent) || 0;
    o.updated_at = Number(o.updated_at) || 0;
    return o;
  }).filter(o => o.book_id);
}

function clean_(o) {
  const c = Object.assign({}, o);
  delete c._row;
  delete c.updated;
  return c;
}

function doGet(e) {
  try {
    const p = e.parameter || {};
    checkKey_(p.key);
    switch (p.action) {
      case 'ping':
        return out_({ ok: true, rows: readAll_().length });
      case 'get':
        return out_({ ok: true, entries: readAll_().filter(r => r.book_id === p.book_id).map(clean_) });
      case 'list':
        return out_({ ok: true, entries: readAll_().map(clean_) });
      default:
        return out_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    if (body.action !== 'put') return out_({ ok: false, error: 'Unknown action' });

    lock.waitLock(20000);
    const sh = sheet_();
    const rows = readAll_();
    const index = new Map(rows.map(r => [r.book_id + '|' + r.device_id, r]));
    let written = 0, skipped = 0;

    for (const en of (body.entries || [])) {
      if (!en.book_id || !en.device_id || !en.cfi) { skipped++; continue; }
      const at = Number(en.updated_at) || Date.now();
      const row = HEADERS.map(h => {
        if (h === 'updated_at') return at;
        if (h === 'updated') return new Date(at);
        if (h === 'percent') return Number(en.percent) || 0;
        return String(en[h] == null ? '' : en[h]);
      });
      const existing = index.get(en.book_id + '|' + en.device_id);
      if (existing) {
        if (existing.updated_at >= at) { skipped++; continue; } // older than what we have
        sh.getRange(existing._row, 1, 1, HEADERS.length).setValues([row]);
        existing.updated_at = at;
      } else {
        sh.appendRow(row);
        index.set(en.book_id + '|' + en.device_id, { _row: sh.getLastRow(), updated_at: at });
      }
      written++;
    }
    return out_({ ok: true, written: written, skipped: skipped });
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
