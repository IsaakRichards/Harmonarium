<p align="center"><img src="app-icon.png" width="128" alt="Starborn icon"></p>

<h1 align="center">Starborn</h1>

<p align="center">A galaxy-themed EPUB reader and reading tracker for <b>Android, Sailfish OS, Linux and Windows</b>.<br>
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

### Touch, mouse, keyboard, d-pad or controller
Everything works without touch: **arrow keys / d-pad** move a gold focus ring, **OK / Enter** presses, **Back / Esc / Backspace** closes the top layer. In a book, ←/→ turn pages, ↑/↓ bring up the toolbars, and OK hides or shows them. Game controllers work too (d-pad or left stick, A = OK, B = Back, LB/RB = page turn). Lists can be reordered with **Move up / Move down** in a book's panel, no dragging needed.

### Where the two meet
- A book on your lists that you also have as an EPUB shows **📖 42%**, and its panel has **Read now**.
- Shelf cards show which list each book is on.
- Reaching the end of a book offers to **move it to Completed**.

## Set up the sheet

Paste [`sync/Code.gs`](sync/Code.gs) into your sheet's Apps Script, set `TOKEN`, deploy it as a web app, then put the URL and token into **Settings** on each device. Full steps are in **[sync/SETUP.md](sync/SETUP.md)**.

Already using KosmicLitTrack? Use the same sheet. Swap in the new script and keep your token. Your lists stay put, and a `Progress` tab is added at the end.

## Download

Each platform has its own build pipeline in GitHub Actions:

| Workflow | Builds | Runs on |
| --- | --- | --- |
| **Linux** (`linux.yml`) | `.AppImage` (any distro), `.deb` (Ubuntu/Mint/Debian), `.rpm` (Fedora) | every push to `main`, PRs, by hand |
| **Windows** (`windows.yml`) | `-setup.exe` installer and `.msi` | every push to `main`, PRs, by hand |
| **Android** (`android.yml`) | signed universal `Starborn.apk` | every push to `main`, PRs, by hand |
| **Sailfish OS** (`sailfish.yml`) | `harbour-starborn` RPMs for `aarch64` and `armv7hl` | every push to `main`, PRs, by hand |
| **Release** (`release.yml`) | runs all three, then publishes one GitHub release with every file | pushing a `v*` tag, or by hand |

Builds from a push are under that run's **Artifacts** in the Actions tab. You can run any single platform from **Actions → (workflow) → Run workflow**. To publish a release:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

Pushes that only change docs (`*.md`) or the sheet script (`sync/`) skip the builds.

### Android signing
An update only installs over an older APK when both are signed with the same key. Without setup, each build uses a throwaway key. To keep one key:

```sh
keytool -genkeypair -keystore sb.jks -alias sb -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 sb.jks   # copy the output
```

Then add these repository secrets: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`sb`) and `ANDROID_KEY_PASSWORD`. Keep `sb.jks` out of the repo.

### In-app updates
**Settings → Updates** checks this repo's latest GitHub release. Starborn also checks quietly once a day at launch and offers any new version in a toast. How it installs depends on the platform:

| Platform | What happens |
| --- | --- |
| **Android** | Downloads `Starborn.apk` and opens Android's installer. The first time, Android asks you to allow **Install unknown apps** for Starborn. |
| **Windows** | Downloads the signed update, installs it and restarts Starborn. |
| **Linux AppImage** | Downloads the signed update, swaps the AppImage in place and restarts. |
| **Linux .deb / .rpm** | Opens the release page, since those belong to your package manager. Install the new file the same way. |
| **Sailfish OS** | Downloads the RPM for your phone (aarch64 or armv7hl) into Downloads and opens it so Sailfish offers to install it. If the installer doesn't open, open the file from the Files app. |

For it to work:
- Publish releases with a `v*` tag (as above). The release workflow stamps that version into every build, so there's no need to bump version numbers by hand. Drafts and pre-releases are ignored.
- **Android:** set the signing secrets above. Android refuses an update signed with a different key.
- **Windows and AppImage:** add the updater signing key as the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the whole contents of the key file; this key has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be left unset). Its public half is already in `src-tauri/tauri.conf.json`. With the secret set, builds also produce `.sig` files and the release gets a `latest.json`. Without it, desktop copies fall back to opening the release page. To use a key of your own instead, run `npx tauri signer generate -w starborn-updater.key`, put the new public key in `tauri.conf.json` under `plugins.updater.pubkey`, and store the private key as the secret. Keep the private key out of the repo, and don't lose it: copies already installed only accept updates signed with it.

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

> Commodore blocks web browsers on the Callback at the system level. Starborn isn't a browser (it shows only its own pages and books), but whether its built-in web view is allowed is unconfirmed until it runs on a real Callback. If it's blocked, the Android APK (sideloaded from the microSD card or USB) has the same keypad mode.

### Install and build

`sailfish/` is a native Sailfish app: a Silica window around Sailfish's own WebView, running the same interface as every other build. A tiny server built into the app serves it on `127.0.0.1`, so storage and syncing behave exactly as in a browser.

- **Install:** copy the RPM for your phone (`aarch64` on current devices, `armv7hl` on older ones) to the phone, allow untrusted software in Settings, and tap it in the file manager. Or `devel-su pkcon install-local harbour-starborn-*.rpm`.
- **Adding books:** **+ Add books** lists the EPUBs in Documents, Downloads, a `~/Books` folder and memory cards; tap one, or **Add all new**.
- **Build it yourself** with the Sailfish SDK: `npm run build:sailfish`, then open `sailfish/harbour-starborn.pro` in the SDK (or `sfdk build` inside `sailfish/`).
- Not for the Jolla Store (Harbour) as is: it's meant for OpenRepos, Chum, or direct install.

Prefer not to install anything? The Android APK also runs under Sailfish's Android AppSupport.

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
src/dpad.js         d-pad / keyboard / gamepad navigation (focus ring, reader keys)
src/native.js       what a native shell offers the page (Sailfish: books on the device)
src/library.js      Shelf: EPUB import (SHA-256 identity), cards, "ahead elsewhere" badges
src/reader.js       epub.js reader, gestures, themes, progress saving, end-of-book hook
src/lists.js        Lists: the tracker (sheet sync, covers, search, drag and drop, starfield) + Settings panel
src/sync.js         reading-position sync with an offline outbox
src/db.js           IndexedDB storage for books, files, positions and settings
sync/Code.gs        the one Apps Script that serves both lists and progress
src-tauri/          Tauri shell for Linux, Windows and Android (HTTP plugin) and icons
sailfish/           Sailfish OS app: Qt/QML WebView shell + local server, RPM spec
```

## Roadmap
- [ ] Scan a folder for EPUBs instead of importing them one by one
- [ ] Bookmarks, highlights and notes, synced through the sheet
- [ ] Manual linking when a shelf book's title doesn't match its list entry
- [ ] PDF, FB2 and MOBI support
