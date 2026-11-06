# ✦ KosmicLitSync

A calm, ReadEra-style EPUB reader for **Android, Linux and Windows** whose one
special power is this: **your reading position follows you between devices
through a Google Sheet you own.** No accounts, no servers, no tracking.

> Status: **v0.1, early.** Library, reader and sheet sync are in place; it
> hasn't been run on real devices yet, so expect rough edges.

## Features

- 📚 **Library shelf** — covers, titles, authors, progress bars; search and sort
  (recently read / added / title / author). Add books with ＋ or drag-and-drop.
- 📖 **Reader** — paginated (two-page spread on wide screens), tap edges or
  swipe to turn, arrow keys/PageUp/PageDown/Space on desktop, tap the middle
  for an immersive view, table of contents, progress slider.
- 🎨 **Text settings** — Day / Parchment / Night / Midnight themes, font size,
  font family, line spacing.
- ⟳ **Google Sheet sync** — each device writes its position per book; when you
  open a book that was read further elsewhere, you're offered *Jump there*.
  Works offline: positions queue up and push when you're back online.

## How sync works

```
 Phone ──┐                         ┌── "Progress" tab
 Laptop ─┼─▶ Apps Script web app ─▶│  book_id | cfi | percent | device | updated_at
 Desktop ┘   (your Google account) └── one row per book per device
```

- A book's identity is the **SHA-256 of the EPUB file**, so every device must
  have the *exact same file*.
- Positions are stored as **EPUB CFIs** — precise to the paragraph, and
  independent of font size or screen.
- The newest row from any *other* device wins the "jump there?" offer.

👉 **Set-up steps: [sync/SETUP.md](sync/SETUP.md)** (about five minutes).

## Building

Built with [Tauri 2](https://tauri.app) (Rust shell) + Vite + vanilla JS +
[epub.js](https://github.com/futurepress/epub.js).

**Prerequisites:** Node 20+, Rust (stable), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install

# desktop (Linux / Windows)
npx tauri dev          # run with hot reload
npx tauri build        # installers in src-tauri/target/release/bundle/

# Android (needs Android Studio SDK + NDK, JDK 17, NDK_HOME set)
npx tauri android init
npx tauri android dev
npx tauri android build --apk
```

You can also run just the front end in a browser with `npm run dev`
(http://localhost:1420) — handy for UI work.

**No local toolchain?** Every push to `main` builds Linux (.deb / .rpm /
.AppImage), Windows (.msi / .exe) and an Android debug APK in GitHub Actions —
grab them from the run's *Artifacts*.

## Project layout

```
index.html            app shell (library, reader, settings views)
src/
  main.js             boot + settings screen
  library.js          shelf, importing, remote "ahead elsewhere" badges
  reader.js           epub.js rendering, gestures, themes, progress saving
  sync.js             Apps Script client + offline outbox
  db.js               IndexedDB storage (books, files, progress, outbox)
  settings.js, util.js, styles.css
src-tauri/            Tauri 2 native shell (HTTP plugin for sync)
sync/Code.gs          Google Apps Script to paste into your sheet
sync/SETUP.md         sync set-up guide
```

## Roadmap

- [ ] Scan a folder for EPUBs (ReadEra-style auto library) instead of importing
- [ ] Bookmarks, highlights & notes — synced through the same sheet
- [ ] PDF / FB2 / MOBI support
- [ ] Collections / shelves, "finished" state
- [ ] Optional sync of the whole library list (which books exist where)
- [ ] Signed release builds
