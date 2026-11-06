import * as settings from "./settings.js";
import * as library from "./library.js";
import * as reader from "./reader.js";
import * as sync from "./sync.js";
import { show, toast } from "./util.js";

const $ = (id) => document.getElementById(id);

async function boot() {
  const s = await settings.load();
  document.body.dataset.theme = s.theme;

  library.init({ open: openBook });
  reader.init({ close: () => { show("view-library"); library.render(); } });
  initSettings();

  await library.render();
  show("view-library");
  sync.flushNow();          // push anything left from last session
  library.refreshRemote(false);
}

async function openBook(id) {
  reader.syncPanelState();
  show("view-reader");
  const ok = await reader.open(id).catch((err) => {
    console.error(err);
    toast("This tome could not be opened");
    return false;
  });
  if (!ok) { show("view-library"); }
}

function initSettings() {
  $("btn-settings").addEventListener("click", () => {
    const s = settings.get();
    $("set-device-name").value = s.deviceName;
    $("set-sync-url").value = s.syncUrl;
    $("set-sync-key").value = s.syncKey;
    $("set-auto-jump").checked = s.autoJump;
    $("sync-status").textContent = sync.isConfigured() ? "Sync is configured." : "Sync is not set up yet.";
    show("view-settings");
  });

  $("btn-settings-back").addEventListener("click", () => show("view-library"));

  const read = () => ({
    deviceName: $("set-device-name").value.trim() || settings.get().deviceName,
    syncUrl: $("set-sync-url").value.trim(),
    syncKey: $("set-sync-key").value,
    autoJump: $("set-auto-jump").checked,
  });

  $("btn-save-settings").addEventListener("click", async () => {
    const patch = read();
    if (patch.syncUrl && !sync.isConfigured(patch)) {
      $("sync-status").textContent = "That URL doesn't look like an Apps Script web app (script.google.com/macros/s/…/exec).";
      return;
    }
    await settings.update(patch);
    toast("Settings saved");
    show("view-library");
    library.refreshRemote(false);
  });

  $("btn-test-sync").addEventListener("click", async () => {
    const status = $("sync-status");
    const prev = { ...settings.get() };
    await settings.update(read());
    status.textContent = "Knocking upon the sheet's door…";
    try {
      const r = await sync.ping();
      status.textContent = `✓ Connected. The sheet holds ${r.rows ?? 0} progress row(s).`;
    } catch (err) {
      status.textContent = `✗ ${err.message}`;
      await settings.update({ syncUrl: prev.syncUrl, syncKey: prev.syncKey });
    }
  });
}

boot();
