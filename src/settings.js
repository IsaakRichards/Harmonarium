import * as db from "./db.js";
import { uuid, guessDeviceName } from "./util.js";

const DEFAULTS = {
  deviceId: "",
  deviceName: "",
  syncUrl: "",
  syncKey: "",
  autoJump: false,
  theme: "light",
  dayTheme: "light",  // Day/Night button: the last day theme (light | sepia)
  nightTheme: "dark", //   and the last night theme (dark | black)
  fontSize: 100,
  fontFamily: "",
  lineHeight: "",
  sort: "recent",
  keypadMode: "auto", // "auto" | "on" | "off"
  pageTurn: "slide",  // "slide" | "fade" | "none"
  flow: "paginated",  // "paginated" (pages) | "scrolled" (one long scroll)
  margin: "m",        // "s" | "m" | "l" | "xl" side margins
  textAlign: "auto",  // "auto" (justified in the ReadEra look) | "justify" | "left"
  hyphens: true,
  brightness: 1,      // 0.2–1, a dimmer laid over the page
  keepAwake: true,    // keep the screen on while a book is open
  lightStrip: true,   // ReadEra-style reader: brightness strip under the top bar
  section: "books",   // library section: books | docs | favorites | toread | haveread | authors | series | collections | trash
};

let current = null;

export async function load() {
  const saved = (await db.get("kv", "settings")) || {};
  current = { ...DEFAULTS, ...saved };
  let dirty = false;
  if (!current.deviceId) { current.deviceId = uuid(); dirty = true; }
  if (!current.deviceName) { current.deviceName = guessDeviceName(); dirty = true; }
  if (dirty) await db.put("kv", current, "settings");
  return current;
}

export function get() {
  return current;
}

export async function update(patch) {
  current = { ...current, ...patch };
  await db.put("kv", current, "settings");
  return current;
}
