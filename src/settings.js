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
