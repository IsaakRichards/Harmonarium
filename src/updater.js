// In-app updater, for every platform Harmonarium ships on.
//
// - Android: GitHub's latest release → Harmonarium.apk, downloaded and handed to the installer by
//   HarmonariumUpdater.kt (window.HarmonariumUpdater, only present in the Android build).
// - Sailfish OS: GitHub's latest release → the RPM for this phone's CPU, downloaded into Downloads
//   by the shell (sailfish/src/localserver.cpp), then opened so Sailfish offers to install it.
// - Windows and the Linux AppImage: Tauri's updater plugin reads latest.json from the latest
//   release, checks the signature, installs and restarts.
// - Linux .deb / .rpm (and desktop releases published without signatures): Harmonarium notices the
//   new release and opens its download page.

import * as native from "./native.js";

const REPO = "IsaakRichards/Harmonarium";
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const LAST_CHECK = "hm-update-checked";
const DAY = 24 * 60 * 60 * 1000;

const bridge = () => (typeof window !== "undefined" ? window.HarmonariumUpdater : undefined);
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** android | sailfish | desktop | null */
function kind() {
  if (bridge()) return "android";
  if (native.canBrowseDevice) return "sailfish";
  if (isTauri) return "desktop";
  return null;
}

/** True where this copy can be updated from inside the app. */
export const available = () => kind() !== null;

/** This copy's version (the installed APK's versionName on Android). */
export function currentVersion() {
  try { return bridge()?.versionName() || __APP_VERSION__; } catch { return __APP_VERSION__; }
}

/** -1, 0 or 1, comparing "1.2.3" style versions (a leading "v" is ignored). */
export function compare(a, b) {
  const p = (v) => String(v || "").replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

// status: idle | checking | latest | available | downloading | ready | permission | installing
//         | saved | error
// release: { version, size, page, url?, how: "apk" | "rpm" | "tauri" | "page" }
let state = { status: "idle", release: null, percent: -1, error: "", file: "" };
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) try { fn(state); } catch (e) { console.error(e); }
}
export const getState = () => state;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ---------- Android events ---------- */

if (typeof window !== "undefined") {
  window.addEventListener("harmonarium:update", (e) => {
    const d = e.detail || {};
    if (d.state === "progress") set({ status: "downloading", percent: d.percent });
    else if (d.state === "downloaded") set({ status: "ready", percent: 100 });
    else if (d.state === "permission") set({ status: "permission" });
    else if (d.state === "installing") set({ status: "installing" });
    else if (d.state === "error") set({ status: "error", error: d.message || "Something went wrong" });
  });

  // Back from Android's "Install unknown apps" screen: carry on with the install if allowed.
  document.addEventListener("visibilitychange", () => {
    const b = bridge();
    if (!b || document.visibilityState !== "visible") return;
    if (state.status === "permission" && b.canInstall()) install();
    else if (state.status === "installing") set({ status: b.hasDownload() ? "ready" : "idle" });
  });
}

/* ---------- desktop (Tauri) ---------- */

let desktopMode = null; // "install" | "page"
let desktopUpdate = null; // the plugin's Update object, between check() and install()

async function getDesktopMode() {
  if (desktopMode) return desktopMode;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    desktopMode = (await invoke("update_mode")) === "install" ? "install" : "page";
  } catch {
    desktopMode = "page";
  }
  return desktopMode;
}

/** Tauri's updater: resolves to a release, false when up to date, or throws when it can't tell
 *  (e.g. the latest release was published without signed update files). */
async function checkWithPlugin() {
  const { check: pluginCheck } = await import("@tauri-apps/plugin-updater");
  const update = await pluginCheck();
  if (!update) return false;
  desktopUpdate = update;
  return { version: String(update.version).replace(/^v/i, ""), size: 0, page: RELEASES, how: "tauri" };
}

/* ---------- GitHub (Android, Sailfish, and desktop installs that can't replace themselves) ---------- */

async function checkWithGitHub(k) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (r.status === 404) throw new Error("No releases have been published yet");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const rel = await r.json();
  const version = String(rel.tag_name || "").replace(/^v/i, "");
  const assets = rel.assets || [];
  const page = rel.html_url || RELEASES;

  // A release built for other platforms only (say, an Android-only fix) has nothing for this
  // device: that isn't an error, there's simply no update here.
  if (k === "android") {
    const a = assets.find((x) => x.name === "Harmonarium.apk");
    if (!a) return { version, none: true };
    return { version, size: a.size, page, url: a.browser_download_url, how: "apk" };
  }
  if (k === "sailfish") {
    const { arch } = await native.updateStatus();
    const a = assets.find((x) => x.name.startsWith("harbour-harmonarium") && x.name.endsWith(`.${arch}.rpm`));
    if (!a) return { version, none: true };
    return { version, size: a.size, page, url: a.browser_download_url, how: "rpm" };
  }
  if (!assets.some((x) => /\.(AppImage|deb|rpm|exe|msi)$/i.test(x.name) && !x.name.startsWith("harbour-"))) return { version, none: true };
  return { version, size: 0, page, how: "page" };
}

/** Looks for a newer release. Resolves to the new state. */
export async function check() {
  const k = kind();
  if (!k) return state;
  set({ status: "checking", error: "" });
  try {
    let release = null;
    if (k === "desktop" && (await getDesktopMode()) === "install") {
      try {
        const r = await checkWithPlugin();
        if (r === false) { set({ status: "latest", release: null }); return remember(); }
        release = r;
      } catch (err) {
        console.warn("Updater plugin couldn't check; falling back to GitHub", err);
      }
    }
    if (!release) release = await checkWithGitHub(k);
    if (release.none) { set({ status: "latest", release: null }); return remember(); }
    set({ release, status: compare(release.version, currentVersion()) > 0 ? "available" : "latest" });
    return remember();
  } catch (err) {
    set({ status: "error", error: err.message || "Couldn't reach GitHub" });
    return state;
  }
}
function remember() {
  try { localStorage.setItem(LAST_CHECK, String(Date.now())); } catch { /* ignore */ }
  return state;
}

/** Fetches the release found by check() and starts installing it. */
export async function download() {
  const rel = state.release;
  if (!rel) return;
  set({ error: "" });
  try {
    if (rel.how === "apk") {
      if (!bridge().download(rel.url)) throw new Error("The download couldn't start");
      set({ status: "downloading", percent: -1 });
    } else if (rel.how === "rpm") {
      const r = await native.updateStart(rel.url);
      if (!r.ok) throw new Error(r.error || "The download couldn't start");
      set({ status: "downloading", percent: -1 });
      pollSailfish();
    } else if (rel.how === "tauri") {
      await installDesktop();
    } else {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(rel.page);
    }
  } catch (err) {
    set({ status: "error", error: err.message || String(err) });
  }
}

async function installDesktop() {
  if (!desktopUpdate) throw new Error("Check for updates first");
  let total = 0, done = 0;
  set({ status: "downloading", percent: -1 });
  await desktopUpdate.downloadAndInstall((ev) => {
    if (ev.event === "Started") total = ev.data.contentLength || 0;
    else if (ev.event === "Progress") {
      done += ev.data.chunkLength || 0;
      set({ percent: total ? Math.min(100, Math.floor((done * 100) / total)) : -1 });
    } else if (ev.event === "Finished") set({ status: "installing", percent: 100 });
  });
  // Windows closes the app itself to run the installer; the AppImage is swapped in place.
  set({ status: "installing" });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

function pollSailfish() {
  const tick = async () => {
    let s;
    try { s = await native.updateStatus(); } catch (err) { set({ status: "error", error: err.message }); return; }
    if (s.state === "downloading") { set({ status: "downloading", percent: s.percent }); setTimeout(tick, 700); }
    else if (s.state === "ready") { set({ status: "ready", percent: 100, file: s.file }); install(); }
    else if (s.state === "error") set({ status: "error", error: s.error || "Download failed" });
  };
  setTimeout(tick, 500);
}

/** Opens the system installer for an update that has been downloaded. */
export async function install() {
  const rel = state.release;
  if (rel && rel.how === "rpm") {
    try {
      const r = await native.updateOpen();
      set({ status: r.ok ? "installing" : "saved", file: r.file || state.file });
    } catch (err) {
      set({ status: "saved" });
    }
    return;
  }
  const b = bridge();
  if (b && b.install()) set({ status: "installing" });
}

/** On launch: quietly check at most once a day and offer the update in a toast. */
export async function autoCheck(toast, openSettings) {
  if (!available()) return;
  let last = 0;
  try { last = +localStorage.getItem(LAST_CHECK) || 0; } catch { /* ignore */ }
  if (Date.now() - last < DAY) return;
  const s = await check();
  if (s.status === "available") toast(`Harmonarium ${s.release.version} is out`, openSettings, "Update");
  else if (s.status === "error") set({ status: "idle", error: "" }); // stay quiet on launch
}

/* ---------- the Updates box in Settings ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mb = (n) => (n > 0 ? ` (${(n / 1048576).toFixed(1)} MB)` : "");
const fileName = (p) => String(p || "").split("/").pop();

function describe(s) {
  const rel = s.release || {};
  const v = esc(rel.version || "");
  switch (s.status) {
    case "checking": return ["Checking GitHub…", "Checking…"];
    case "latest": return [`You have the newest version, ${esc(currentVersion())}.`, "Check again"];
    case "available":
      if (rel.how === "page") return [`Version <b>${v}</b> is out. Download it from the release page and install it the way you installed this copy.`, "Open download page"];
      return [`Version <b>${v}</b> is ready${mb(rel.size)}.`, `Download and install ${v}`];
    case "downloading": return [s.percent >= 0 ? `Downloading… ${s.percent}%` : "Downloading…", "Downloading…"];
    case "ready": return [`Version ${v} is downloaded.`, "Install"];
    case "permission": return ["Allow <b>Install unknown apps</b> for Harmonarium, then come back here.", "Install"];
    case "installing":
      if (rel.how === "rpm") return [`The installer should be open. If it isn't, open <b>${esc(fileName(s.file))}</b> in Downloads with the Files app.`, "Open the installer again"];
      if (rel.how === "tauri") return ["Installing… Harmonarium will restart.", "Installing…"];
      return ["The installer is open. Your books and lists stay as they are.", "Install"];
    case "saved": return [`Saved <b>${esc(fileName(s.file))}</b> to Downloads. Open it with the Files app to install. (Sailfish asks you to allow untrusted software the first time.)`, "Try opening it again"];
    case "error": return [esc(s.error), "Try again"];
    default: return [`This is version ${esc(currentVersion())}. Updates come from Harmonarium's GitHub releases.`, "Check for updates"];
  }
}

/** Fills `el` with the Updates box and keeps it current until it leaves the page. */
export function mount(el) {
  if (!el) return;
  if (!available()) { el.hidden = true; return; }
  el.innerHTML = `<p class="p-kicker">Updates</p>
    <p class="status" data-u-status></p>
    <div class="row start"><button class="btn small" data-u-btn></button></div>`;
  const status = el.querySelector("[data-u-status]");
  const btn = el.querySelector("[data-u-btn]");
  const draw = (s) => {
    const [text, label] = describe(s);
    status.innerHTML = text;
    btn.textContent = label;
    btn.setAttribute("aria-busy", String(s.status === "checking" || s.status === "downloading"));
  };
  // Stays focusable (not disabled) while busy, so the keypad focus ring isn't lost.
  btn.addEventListener("click", () => {
    const s = state.status;
    if (s === "checking" || s === "downloading") return;
    if (s === "installing" && state.release?.how === "tauri") return;
    if (s === "available") download();
    else if (s === "ready" || s === "permission" || s === "installing" || s === "saved") install();
    else check();
  });
  draw(state);
  const off = subscribe((s) => { if (!el.isConnected) { off(); return; } draw(s); });
}
