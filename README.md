<p align="center"><img src="app-icon.png" width="128" alt="Starborn icon"></p>

<h1 align="center">Starborn</h1>

<p align="center">A galaxy-themed EPUB reader and reading tracker for <b>Android, Linux and Windows</b>.<br>
Your lists and your place in every book live in a Google Sheet that you own.</p>

> *Starborn* is a working name. It is the merger of KosmicLitSync (the reader) and
> [KosmicLitTrack](https://github.com/IsaakRichards/KosmicLitTrack) (the tracker).

## What it does

### Shelf: read your EPUBs
- **Library** of the EPUBs on this device, with covers, progress bars, search and sort. Add files with **+ Add books**, or drop them on the window on desktop.
- **ReadEra-style reader.** Pages turn by tapping the edges, swiping, or with the arrow keys. Wide screens show two pages side by side, and a tap in the middle hides the bars. It has a table of contents and a progress slider.
- **Text settings:** Day, Parchment, Night and Midnight themes, plus font size, font family and line spacing.
- **Cross-device sync of your place.** Open a book that you read further on another device and Starborn offers *"On Pixel you reached 63%. Jump there?"*. Progress made offline is queued and sent later.

### Lists: track what you've read and what's next
- **Your lists, from your sheet.** Each pair of columns (a list name, then *Series*) becomes a list. Sync goes both ways, and edits made in the sheet show up within 30 seconds.
- **Drag and drop** between lists (press and hold on touch). The ✓ button marks a book read and sends a shooting star across the sky.
- **Covers and details** come from Open Library, with Google Books as a backup. You can pick a different edition's cover.
- **Find books** in Open Library and Google Books, then drag them onto a list.
- **Series systems:** orbit rings show how much of each series you've read.

### Where the two meet
- A book on your lists that you also have as an EPUB shows **📖 42%**, and its panel has **Read now**.
- Shelf cards show which list each book is on.
- Reaching the end of a book offers to **move it to Completed**.

## Set up the sheet

Paste [`sync/Code.gs`](sync/Code.gs) into your sheet's Apps Script, set `TOKEN`, deploy it as a web app, then put the URL and token into **Settings** on each device. Full steps are in **[sync/SETUP.md](sync/SETUP.md)**.

Already using KosmicLitTrack? Use the same sheet. Swap in the new script and keep your token. Your lists stay put, and a `Progress` tab is added at the end.

## Download

Every push to `main` builds Linux (`.AppImage`, `.deb`, `.rpm`), Windows (`-setup.exe`, `.msi`) and Android (`Starborn.apk`) files. You'll find them under the run's **Artifacts** in the Actions tab. Pushing a tag publishes a release:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

### Android signing
An update only installs over an older APK when both are signed with the same key. Without setup, each build uses a throwaway key. To keep one key:

```sh
keytool -genkeypair -keystore sb.jks -alias sb -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 sb.jks   # copy the output
```

Then add these repository secrets: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`sb`) and `ANDROID_KEY_PASSWORD`. Keep `sb.jks` out of the repo.

## Develop

Starborn is built with [Tauri 2](https://tauri.app), Vite, plain JavaScript and [epub.js](https://github.com/futurepress/epub.js). You need Node 20+, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npx tauri dev              # desktop window with hot reload
npx tauri build            # installers for this OS
npm run android:init       # once (needs Android Studio, SDK + NDK, JDK 17)
npm run android:dev
```

`npm run dev` alone serves the interface at http://localhost:1420 for UI work in a browser.

```
index.html          app shell: header + tabs, Shelf, Lists, reader, shared panel
src/main.js         boot, tabs, and the wiring between Shelf and Lists
src/library.js      Shelf: EPUB import (SHA-256 identity), cards, "ahead elsewhere" badges
src/reader.js       epub.js reader, gestures, themes, progress saving, end-of-book hook
src/lists.js        Lists: the tracker (sheet sync, covers, search, drag and drop, starfield) + Settings panel
src/sync.js         reading-position sync with an offline outbox
src/db.js           IndexedDB storage for books, files, positions and settings
sync/Code.gs        the one Apps Script that serves both lists and progress
src-tauri/          native shell (HTTP plugin) and icons
```

## Roadmap
- [ ] Scan a folder for EPUBs instead of importing them one by one
- [ ] Bookmarks, highlights and notes, synced through the sheet
- [ ] Manual linking when a shelf book's title doesn't match its list entry
- [ ] PDF, FB2 and MOBI support
