// In-app updater (Android only).
//
// Asks GitHub for the newest Starborn release and, if it is newer than this copy, downloads its
// Starborn.apk and opens the system installer. The download and install are done natively by
// StarbornUpdater.kt, which only exists in the Android build, so everywhere else this stays hidden.

const REPO = "IsaakRichards/Starborn";
const ASSET = "Starborn.apk";
const LAST_CHECK = "sb-update-checked";
const DAY = 24 * 60 * 60 * 1000;

const bridge = () => (typeof window !== "undefined" ? window.StarbornUpdater : undefined);

/** True in the Android app, where APKs can be installed. */
export const available = () => !!bridge();

/** This copy's version (the installed APK's versionName when available). */
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

// status: idle | checking | latest | available | downloading | ready | permission | installing | error
let state = { status: "idle", release: null, percent: -1, error: "" };
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) try { fn(state); } catch (e) { console.error(e); }
}
export const getState = () => state;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

window.addEventListener("starborn:update", (e) => {
  const d = e.detail || {};
  if (d.state === "progress") set({ status: "downloading", percent: d.percent });
  else if (d.state === "downloaded") set({ status: "ready", percent: 100 });
  else if (d.state === "permission") set({ status: "permission" });
  else if (d.state === "installing") set({ status: "installing" });
  else if (d.state === "error") set({ status: "error", error: d.message || "Something went wrong" });
});

// Back from the "Install unknown apps" screen: carry on with the install if it was allowed.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const b = bridge();
  if (!b) return;
  if (state.status === "permission" && b.canInstall()) install();
  else if (state.status === "installing") set({ status: b.hasDownload() ? "ready" : "idle" });
});

/** Asks GitHub for the latest release. Resolves to the new state. */
export async function check() {
  set({ status: "checking", error: "" });
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (r.status === 404) throw new Error("No releases have been published yet");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => a.name === ASSET);
    const version = String(rel.tag_name || "").replace(/^v/i, "");
    if (!asset) throw new Error(`The ${version || "latest"} release has no ${ASSET}`);
    const release = { version, url: asset.browser_download_url, size: asset.size, page: rel.html_url };
    try { localStorage.setItem(LAST_CHECK, String(Date.now())); } catch { /* ignore */ }
    set({ release, status: compare(version, currentVersion()) > 0 ? "available" : "latest" });
  } catch (err) {
    set({ status: "error", error: err.message || "Couldn't reach GitHub" });
  }
  return state;
}

/** Downloads the release found by check(); the installer opens by itself when it finishes. */
export function download() {
  const b = bridge();
  if (!b || !state.release) return;
  if (!b.download(state.release.url)) { set({ status: "error", error: "The download couldn't start" }); return; }
  set({ status: "downloading", percent: -1, error: "" });
}

export function install() {
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
  if (s.status === "available") toast(`Starborn ${s.release.version} is out`, openSettings, "Update");
  else if (s.status === "error") set({ status: "idle", error: "" }); // stay quiet on launch
}

/* ---------- the Updates box in Settings ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mb = (n) => (n > 0 ? ` (${(n / 1048576).toFixed(1)} MB)` : "");

function describe(s) {
  const v = s.release && s.release.version;
  switch (s.status) {
    case "checking": return ["Checking GitHub…", "Checking…"];
    case "latest": return [`You have the newest version, ${esc(currentVersion())}.`, "Check again"];
    case "available": return [`Version <b>${esc(v)}</b> is ready${mb(s.release.size)}.`, `Download and install ${esc(v)}`];
    case "downloading": return [s.percent >= 0 ? `Downloading… ${s.percent}%` : "Downloading…", "Downloading…"];
    case "ready": return [`Version ${esc(v || "")} is downloaded.`, "Install"];
    case "permission": return ["Allow <b>Install unknown apps</b> for Starborn, then come back here.", "Install"];
    case "installing": return ["The installer is open. Your books and lists stay as they are.", "Install"];
    case "error": return [esc(s.error), "Try again"];
    default: return [`This is version ${esc(currentVersion())}. Updates come from Starborn's GitHub releases.`, "Check for updates"];
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
  btn.addEventListener("click", () => {
    const s = state.status;
    if (s === "checking" || s === "downloading") return;
    if (s === "available") download();
    else if (s === "ready" || s === "permission" || s === "installing") install();
    else check();
  });
  // Stays focusable (not disabled) while busy so the keypad focus ring isn't lost.
  if (state.status === "idle" && bridge().hasDownload() && state.release) set({ status: "ready" });
  draw(state);
  const off = subscribe((s) => { if (!el.isConnected || !el.contains(btn)) { off(); return; } draw(s); });
}
