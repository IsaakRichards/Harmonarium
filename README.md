<p align="center"><img src="app-icon.png" width="128" alt="Harmonarium icon"></p>

<h1 align="center">Harmonarium</h1>

<p align="center">A galaxy-themed EPUB and PDF reader and reading tracker for <b>Android, Sailfish OS, Linux and Windows</b>.<br>
Your lists and your place in every book live in a Google Sheet that you own.</p>

*The name joins **harmony** and **armarium**, the cabinet of books in old libraries. The emblem ([`app-icon.svg`](app-icon.svg)) is a pitch wheel written in Elder Futhark runes, with a harmony curve at its heart, set in a Gothic bookcase.*

## What it does

### Shelf: read your EPUBs and PDFs
- **Library** of the EPUBs and PDFs on this device, with covers, progress bars, search and sort. Add files with **+ Add books**, or drop them on the window on desktop.
- **Sections, as in ReadEra:** Books (EPUB), Documents (PDF), Favorites, To read, Have read, Authors, Series (read from Calibre and EPUB 3 metadata), your own Collections, and a Trash you can restore from. Each book's **⋮** menu holds About, Favorites, To read / Have read, Collections and Move to trash. Finishing a book files it under Have read.
- **PDFs** scroll as one column of pages fitted to the width. Tap the edges to move a screen, pinch or use **Zoom**, and the Night and Sepia themes tint the pages too. The document's outline becomes its Contents.
- **ReadEra-style reader.** Pages turn by tapping the edges, swiping, or with the arrow keys. Wide screens show two pages side by side, and a tap in the middle hides the bars. It has a table of contents and a progress slider.
- **Text settings:** Day, Parchment, Night and Midnight themes, font size, font family, line spacing, margins, justified or left-aligned text, hyphenation, a brightness dimmer, **Pages** or **Scroll** mode, and keeping the screen on.
- **Bookmarks, quotes and notes.** The bookmark at the top marks the page (a red ribbon shows it). Select text for **Copy**, **Quote** (highlighted in the book), **Note** (a quote with your words) or **Find**. Contents has tabs for Bookmarks, Quotes and Notes; tap a highlight to copy, edit or delete it.
- **Find in book** searches every chapter (or every PDF page), and **Go to page** takes a page number or a percent. After any jump (contents, search, a bookmark, a footnote) a **Back** chip returns you to where you were.
- **Cross-device sync of your place.** Open a book that you read further on another device and Harmonarium offers *"On Pixel you reached 63%. Jump there?"*. Progress made offline is queued and sent later.

### Lists: track what you've read and what's next
- **Your lists, from your sheet.** Each pair of columns (a list name, then *Series*) becomes a list. Sync goes both ways, and edits made in the sheet show up within 30 seconds.
- **Drag and drop** between lists (press and hold on touch). The ✓ button marks a book read and sends a shooting star across the sky.
- **Covers and details** come from Open Library, with Google Books as a backup. You can pick a different edition's cover.
- **Find books** in Open Library and Google Books, then drag them onto a list.
- **Series systems:** orbit rings show how much of each series you've read.

### Four looks
**Settings → Appearance** switches the whole app between **Medieval** (parchment, ink, gold leaf and Cinzel capitals), **Space** (the drifting starfield), **Light** and **Dark**. Each device remembers its own choice. Books keep their own reading themes (Day, Parchment, Night, Midnight).

### ReadEra look and feel
**Settings → Appearance → Look and feel like ReadEra** dresses the whole app as the ReadEra reader, for anyone whose hands already know it. Pick its colours (follow the system, light or dark); each device remembers its own choice.
- **Library:** a plain app bar with a **☰** drawer (Books, Lists and each of your lists, Add books, Sync now, Settings), search behind the magnifier, sort under the bar, books as a list with small covers, format and size, progress and a **⋮** menu, or as a grid. A round **+** adds books.
- **Reader:** books open full-screen and the words fill the page edge to edge, justified and hyphenated, with only a hairline beneath marking each chapter and where you are. A tap in the middle brings the toolbars up over the page; **Contents**, **Text** and **Day/Night** sit along the bottom, text settings rise as a bottom sheet, and Contents marks the chapter you're in. Edge taps cover a third of the page each side. The reading themes take ReadEra's names: Day, Sepia, Night and Console.
- The reader's top bar carries the bookmark, search and **⋮** (Find, Go to page, bookmark, Favorites, About), and the drawer lists every library section.
- Everything ReadEra doesn't have (lists, series rings, sheet sync, the jump-there card, keypad and d-pad control) stays, dressed to match.

### Scriptorium: the ReadEra-style reader on its own
This repo also builds **Scriptorium**, a second app from the same code: only the ReadEra-style library and reader, with no lists, no sheet and no other looks. Its books, bookmarks and quotes stay on the device. It installs beside Harmonarium (its own app id, `com.isaakrichards.scriptorium`, and its own icon, [`app-icon-solo.svg`](app-icon-solo.svg)).

It follows ReadEra's free version and leaves out what ReadEra sells as Premium: cloud sync, one page of every quote from every book, extra highlight colours, page thumbnails, your own fonts and extra library views.

`src/flavor.js` decides which app a build is (`VITE_FLAVOR`, set by `.env` and `.env.solo`). `npm run build:solo` builds Scriptorium's interface; `node scripts/flavor.mjs solo` switches the Tauri project to it before `tauri build` or `tauri android init`.

### Touch, mouse, keyboard, d-pad or controller
Everything works without touch: **arrow keys / d-pad** move a gold focus ring, **OK / Enter** presses, **Back / Esc / Backspace** closes the top layer. In a book, ←/→ turn pages, ↑/↓ bring up the toolbars, and OK hides or shows them. Game controllers work too (d-pad or left stick, A = OK, B = Back, LB/RB = page turn). Lists can be reordered with **Move up / Move down** in a book's panel, no dragging needed.

### Where the two meet
- A book on your lists that you also have as an EPUB shows **📖 42%**, and its panel has **Read now**.
- Shelf cards show which list each book is on.
- Reaching the end of a book offers to **move it to Completed**.

## Set up the sheet

Paste [`sync/Code.gs`](sync/Code.gs) into your sheet's Apps Script, set `TOKEN`, deploy it as a web app, then put the URL and token into **Settings** on each device. Full steps are in **[sync/SETUP.md](sync/SETUP.md)**.

## Download

Each platform has its own build pipeline in GitHub Actions:

| Workflow | Builds | Runs on |
| --- | --- | --- |
| **Linux** (`linux.yml`) | `.AppImage` (any distro), `.deb` (Ubuntu/Mint/Debian), `.rpm` (Fedora) | every push to `main`, PRs, by hand |
| **Windows** (`windows.yml`) | `-setup.exe` installer and `.msi` | every push to `main`, PRs, by hand |
| **Android** (`android.yml`) | signed universal `Harmonarium.apk` | every push to `main`, PRs, by hand |
| **Sailfish OS** (`sailfish.yml`) | `harbour-harmonarium` RPMs for `aarch64` and `armv7hl` | every push to `main`, PRs, by hand |
| **Release** (`release.yml`) | runs all three, then publishes one GitHub release with every file | pushing a `v*` tag, or by hand |

The Linux, Windows and Android workflows each build **both** apps, Harmonarium and Scriptorium (`Scriptorium.apk`, `Scriptorium_…AppImage` and so on), as separate artifacts. Only Harmonarium's files are signed for the in-app updater, so Scriptorium never offers itself as a Harmonarium update.

Builds from a push are under that run's **Artifacts** in the Actions tab. You can run any single platform from **Actions → (workflow) → Run workflow**. To publish a release:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

Pushes that only change docs (`*.md`) or the sheet script (`sync/`) skip the builds.

### Android signing
An update only installs over an older APK when both are signed with the same key. Without setup, each build uses a throwaway key. To keep one key:

```sh
keytool -genkeypair -keystore harmonarium.jks -alias harmonarium -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 harmonarium.jks   # copy the output
```

Then add these repository secrets: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`harmonarium`) and `ANDROID_KEY_PASSWORD`. Keep `harmonarium.jks` out of the repo.

### In-app updates
**Settings → Updates** checks this repo's latest GitHub release. Harmonarium also checks quietly once a day at launch and offers any new version in a toast. How it installs depends on the platform:

| Platform | What happens |
| --- | --- |
| **Android** | Downloads `Harmonarium.apk` and opens Android's installer. The first time, Android asks you to allow **Install unknown apps** for Harmonarium. |
| **Windows** | Downloads the signed update, installs it and restarts Harmonarium. |
| **Linux AppImage** | Downloads the signed update, swaps the AppImage in place and restarts. |
| **Linux .deb / .rpm** | Opens the release page, since those belong to your package manager. Install the new file the same way. |
| **Sailfish OS** | Downloads the RPM for your phone (aarch64 or armv7hl) into Downloads and opens it so Sailfish offers to install it. If the installer doesn't open, open the file from the Files app. |

For it to work:
- Publish releases with a `v*` tag (as above). The release workflow stamps that version into every build, so there's no need to bump version numbers by hand. Drafts and pre-releases are ignored.
- **Android:** set the signing secrets above. Android refuses an update signed with a different key.
- **Windows and AppImage:** add the updater signing key as the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the whole contents of the key file; this key has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be left unset). Its public half is already in `src-tauri/tauri.conf.json`. With the secret set, builds also produce `.sig` files and the release gets a `latest.json`. Without it, desktop copies fall back to opening the release page. To use a key of your own instead, run `npx tauri signer generate -w harmonarium-updater.key`, put the new public key in `tauri.conf.json` under `plugins.updater.pubkey`, and store the private key as the secret. Keep the private key out of the repo, and don't lose it: copies already installed only accept updates signed with it.

The native pieces live in [`src-tauri/android/`](src-tauri/android) (Android, added to the generated project by `scripts/android-overlay.mjs`; run it after `npm run android:init` when building locally), `src-tauri/src/lib.rs` (desktop) and `sailfish/src/localserver.cpp` (Sailfish).

## Sailfish OS

### Built for the Commodore Callback 8020
The Sailfish build is made first for the Callback's keypad and 3.25" 640×480 screen, where touch is off by default:

- **Keypad mode** is on automatically: the focus ring is always visible and everything is reachable with keys.
- **Number keys** work like a d-pad: **2 4 6 8** move, **5** selects.
  - **At home:** **1** Shelf · **3** Lists · **0** Add books · **\*** Search · **#** Settings.
  - **In a book:** **4/6** turn pages · **5** shows or hides the toolbars · **1** Contents · **3** Text settings · **\*/#** text size · **0** next theme.
- **The phone's own keys:** **Back** closes the top layer (panel → toolbar → book), **Select** presses, and **Menu / left soft key** opens Settings (or Text settings in a book).
- **Text fields** need **5/OK** to start typing, so number keys never fill a search box by accident. **Back** stops typing.
- **Links to websites** inside books are disabled. The Callback has no browser and the app has no address bar to get back.
- Keypad mode can be switched **On / Off / Automatic** in Settings, so it also works with the Android APK, keyboards and TV remotes.

> Commodore blocks web browsers on the Callback at the system level. Harmonarium isn't a browser (it shows only its own pages and books), but whether its built-in web view is allowed is unconfirmed until it runs on a real Callback. If it's blocked, the Android APK (sideloaded from the microSD card or USB) has the same keypad mode.

### Install and build

`sailfish/` is a native Sailfish app: a Silica window around Sailfish's own WebView, running the same interface as every other build. A tiny server built into the app serves it on `127.0.0.1`, so storage and syncing behave exactly as in a browser.

- **Install:** copy the RPM for your phone (`aarch64` on current devices, `armv7hl` on older ones) to the phone, allow untrusted software in Settings, and tap it in the file manager. Or `devel-su pkcon install-local harbour-harmonarium-*.rpm`.
- **Adding books:** **+ Add books** lists the EPUBs in Documents, Downloads, a `~/Books` folder and memory cards; tap one, or **Add all new**.
- **Build it yourself** with the Sailfish SDK: `npm run build:sailfish`, then open `sailfish/harbour-harmonarium.pro` in the SDK (or `sfdk build` inside `sailfish/`).
- Not for the Jolla Store (Harbour) as is: it's meant for OpenRepos, Chum, or direct install.

Prefer not to install anything? The Android APK also runs under Sailfish's Android AppSupport.

## Develop

Harmonarium is built with [Tauri 2](https://tauri.app), Vite, plain JavaScript and [epub.js](https://github.com/futurepress/epub.js). You need Node 20+, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npx tauri dev              # desktop window with hot reload
npx tauri build            # installers for this OS
npm run dev:solo           # Scriptorium's interface in a browser
node scripts/flavor.mjs solo && npx tauri build   # Scriptorium installers (don't commit the changed config)
npm run android:init       # once (needs Android Studio, SDK + NDK, JDK 17)
npm run android:dev
```

`npm run dev` alone serves the interface at http://localhost:1420 for UI work in a browser.

```
index.html          app shell: header + tabs, Shelf, Lists, reader, shared panel
src/main.js         boot, tabs, and the wiring between Shelf and Lists
src/dpad.js         d-pad / keyboard / gamepad navigation (focus ring, reader keys)
src/native.js       what a native shell offers the page (Sailfish: books on the device)
src/flavor.js       which app this build is: Harmonarium, or Scriptorium (standalone)
src/library.js      Shelf: EPUB/PDF import (SHA-256 identity), sections, groups, book menu, collections, trash
src/reader.js       the reader for both engines: gestures, themes, text settings, progress saving
src/pdfengine.js    pdf.js: PDF metadata, outline, search, and the scrolling page view
src/marks.js        bookmarks, quotes and notes; the selection bar; Contents tabs
src/finder.js       Find in book, Go to page, and the Back chip after a jump
src/aboutbook.js    a book's About card
src/sheet.js        menus, prompts and cards that rise from the bottom
src/lists.js        Lists: the tracker (sheet sync, covers, search, drag and drop, starfield) + Settings panel
src/sync.js         reading-position sync with an offline outbox
src/db.js           IndexedDB storage for books, files, positions, bookmarks/quotes and settings
sync/Code.gs        the one Apps Script that serves both lists and progress
src-tauri/          Tauri shell for Linux, Windows and Android (HTTP plugin) and icons
sailfish/           Sailfish OS app: Qt/QML WebView shell + local server, RPM spec
```

## Roadmap
- [ ] Scan a folder for EPUBs instead of importing them one by one
- [x] Bookmarks, highlights and notes (on this device)
- [ ] Bookmarks, highlights and notes, synced through the sheet
- [ ] Manual linking when a shelf book's title doesn't match its list entry
- [x] PDF support
- [ ] Quotes and notes in PDFs (needs a text layer)
- [ ] FB2, MOBI, DjVu and DOCX support
