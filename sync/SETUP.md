# Connecting Harmonarium to a Google Sheet

Harmonarium keeps two things in one Google Sheet that you own:

| Tab | What's in it |
| --- | --- |
| **First tab** (your lists) | Pairs of columns: a list name in row 1 (*Completed*, *Queue*, …) and a *Series* column beside it |
| **Progress** (added automatically) | One row per book per device: where you are, as a CFI and a percentage |

A small Apps Script attached to the sheet is the go-between, so there's no Google
Cloud project, OAuth login, or password stored on your devices.

## 1. Add the script

1. Open your sheet (or make a new one), then **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with [`Code.gs`](./Code.gs) from this folder.
3. Change `TOKEN` at the top to a long random phrase. Anyone with the URL *and*
   the token can read and edit the sheet, so treat it like a password.
4. Save.

## 2. Deploy

1. **Deploy → New deployment** → gear → **Web app**.
2. *Execute as*: **Me**; *Who has access*: **Anyone** (the token is what protects it).
3. **Deploy** and approve the permissions (it only touches this spreadsheet).
4. Copy the **Web app URL** (it ends in `/exec`).

If you change the script later, use **Deploy → Manage deployments → Edit → New
version** so the URL stays the same.

## 3. Connect each device

In Harmonarium open **Settings** (the gear), paste the URL and token, and press
**Connect**. Give each device a name you'll recognise (*Pixel*, *Dorm laptop*).

## How it behaves

- **Lists** sync both ways: changes in the app are written straight back, and
  edits made in the sheet show up within 30 seconds.
- **Reading positions** save on this device at once and go to the sheet a few
  seconds later (immediately when the app is backgrounded). Offline? They queue
  up and send later.
- Opening a book that was read further on another device shows
  *"On Pixel you reached 63% — Jump there / Stay here"* (or jumps for you, if
  you turn that on in Settings).
- A book on your Lists that you also have as an EPUB shows **📖 42%**, and its
  details panel has **Read now**. Reaching the end of a book offers to move it
  to *Completed*.

## Identical files

EPUBs are matched across devices by the SHA-256 of the file. Copy the **same
file** to every device: a re-downloaded or converted copy with different bytes
counts as a different book. (Matching a shelf book to a list entry is by title.)
