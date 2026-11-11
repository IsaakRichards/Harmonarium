// Appearance modes: Space (the starfield), Medieval (an illuminated manuscript), Light and Dark.
// The mode is saved per device and set as <html data-mode="…">; index.html applies it before
// first paint, and src/styles.css holds each mode's colours and fonts.

export const MODES = [
  { id: "medieval", name: "Medieval" },
  { id: "space", name: "Space" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];
const KEY = "hm-mode";
const BAR = { space: "#070914", dark: "#000000", light: "#f4f5f8", medieval: "#e8d9b5" };

export function get() {
  const m = document.documentElement.getAttribute("data-mode");
  return BAR[m] ? m : "space";
}

export function set(mode) {
  if (!BAR[mode]) return;
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  document.documentElement.setAttribute("data-mode", mode);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[mode]);
  window.dispatchEvent(new CustomEvent("harmonarium:mode", { detail: mode }));
}
