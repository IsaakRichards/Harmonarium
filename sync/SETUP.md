# Setting up Google Sheet sync

KosmicLitSync keeps reading positions in a Google Sheet you own. A tiny Apps
Script attached to that sheet acts as the go-between, so the app never needs
your Google password or an OAuth login on each device.

## 1. Make the sheet

1. Create a new Google Sheet (e.g. **KosmicLitSync Progress**).
2. Open **Extensions → Apps Script**.
3. Delete whatever is in `Code.gs` and paste the contents of [`Code.gs`](./Code.gs).
4. Save (💾).

## 2. Set the secret key

Anyone who has the web-app URL *and* the key can read and write your progress,
so pick something long and random.

1. In the Apps Script editor, click **⚙ Project Settings**.
2. Under **Script Properties**, add:
   - Property: `SYNC_KEY`
   - Value: your secret (e.g. 30+ random characters)

## 3. Deploy as a web app

1. **Deploy → New deployment** → gear icon → **Web app**.
2. *Execute as*: **Me**
3. *Who has access*: **Anyone**  ← required, the key is what protects it
4. **Deploy**, approve the permission prompt (it only touches this spreadsheet).
5. Copy the **Web app URL** — it ends in `/exec`.

> If you later edit `Code.gs`, use **Deploy → Manage deployments → ✏ Edit →
> Version: New version** so the same URL picks up the change.

## 4. Connect each device

In the app: **⚙ Settings → Google Sheet sync**

- **Web App URL** – the `/exec` URL
- **Sync key** – the same `SYNC_KEY`
- **Device name** – something you'll recognise ("Pixel", "Dorm laptop")

Tap **Test connection**, then **Save**. A `Progress` tab appears in the sheet
on the first sync.

## How syncing behaves

- Every device writes one row per book. Rows are never deleted by the app.
- Turning a page saves locally at once and pushes to the sheet a few seconds
  later (and immediately when the app goes to the background). If you're
  offline, pushes wait in a queue and go out later.
- When you open a book, the app checks the sheet. If another device has a
  **newer** position, you get a banner: *Jump there* or *Stay here*.
  (Or turn on *Jump automatically* in Settings.)
- The library's ⟳ button refreshes badges showing books read further elsewhere.

## Important: identical files

Books are matched by the SHA-256 hash of the EPUB file. Copy the **same file**
to each device; a re-downloaded or re-converted EPUB with different bytes is
treated as a different book.
