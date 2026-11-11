// Small modal sheets shared by the library and the reader: an action menu, a text prompt,
// a yes/no question and a free-form card. They rise from the bottom on phones and sit in the
// middle on wide screens. Back / Esc closes the top one (and, at home, Android's back gesture
// does too, through a history entry of its own).
import { escapeHtml } from "./util.js";

const $ = (id) => document.getElementById(id);
let current = null; // { resolve, value, entry, onClose }
let ownBacks = 0;   // history.back() calls of ours whose popstate hasn't arrived yet
let pendingBack = null; // a step back waiting a tick, in case another sheet opens straight away

function ensure() {
  if ($("sheet")) return;
  const scrim = document.createElement("div");
  scrim.id = "sheet-scrim";
  scrim.className = "sheet-scrim";
  scrim.hidden = true;
  const box = document.createElement("div");
  box.id = "sheet";
  box.className = "sheet";
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  document.body.append(scrim, box);
  scrim.addEventListener("click", () => close(null));
  document.addEventListener("keydown", (e) => {
    if (!current || e.key !== "Escape") return;
    e.preventDefault(); e.stopImmediatePropagation();
    close(null);
  }, true);
  window.addEventListener("popstate", () => {
    if (ownBacks > 0) { ownBacks--; return; } // our own step back after closing a sheet
    if (current?.entry) { current.entry = false; close(null, true); }
  });
}

/** True while a sheet is showing. */
export const isOpen = () => !!current;

/** Close the showing sheet; it resolves with `value`. */
export function close(value = null, fromHistory = false) {
  if (!current) return;
  const c = current;
  current = null;
  $("sheet").hidden = true;
  $("sheet-scrim").hidden = true;
  document.body.classList.remove("sheet-open");
  // Step back past the sheet's history entry, a tick later: a sheet opened straight after this
  // one (a menu leading to a prompt) takes the entry over instead of pushing another.
  if (c.entry && !fromHistory) {
    pendingBack = setTimeout(() => {
      pendingBack = null;
      try { ownBacks++; history.back(); } catch { ownBacks = Math.max(0, ownBacks - 1); }
    }, 0);
  }
  c.onClose?.();
  c.resolve(value);
}

function show(html, { wide = false, onClose } = {}) {
  ensure();
  if (current) close(null);
  const box = $("sheet");
  box.className = `sheet${wide ? " wide" : ""}`;
  box.innerHTML = html;
  box.hidden = false;
  $("sheet-scrim").hidden = false;
  document.body.classList.add("sheet-open");
  return new Promise((resolve) => {
    // While reading, the reader's own history entry handles Back; at home the sheet takes one.
    let entry = false;
    if (pendingBack) { clearTimeout(pendingBack); pendingBack = null; entry = true; } // reuse the last sheet's entry
    else if (!document.body.classList.contains("reading")) {
      try { history.pushState({ sheet: 1 }, ""); entry = true; } catch { /* ignore */ }
    }
    current = { resolve, entry, onClose };
    setTimeout(() => {
      const f = box.querySelector("[autofocus]") || (document.body.classList.contains("dpad") && box.querySelector("button, input, textarea, select"));
      f?.focus?.();
    }, 40);
  });
}

const head = (title, subtitle) =>
  (title ? `<div class="sh-head"><h3>${escapeHtml(title)}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div>` : "");

/**
 * An action menu. items: [{ label, value, icon?, hint?, danger?, checked? }] or "-" for a divider.
 * Resolves with the chosen item's value, or null.
 */
export function menu({ title = "", subtitle = "", items = [] }) {
  const p = show(`${head(title, subtitle)}<div class="sh-menu" role="menu">${items.map((it, i) => it === "-"
    ? `<hr>`
    : `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}">
        <span class="sh-ico">${it.checked === true ? "✓" : it.icon || ""}</span>
        <span class="sh-t">${escapeHtml(it.label)}${it.hint ? `<small>${escapeHtml(it.hint)}</small>` : ""}</span>
      </button>`).join("")}</div>`);
  $("sheet").querySelector(".sh-menu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (b) close(items[Number(b.dataset.i)].value);
  });
  return p;
}

/** A one-field prompt. Resolves with the text (trimmed), or null when cancelled. */
export function ask({ title = "", label = "", value = "", placeholder = "", multiline = false, ok = "OK", hint = "", inputmode = "" }) {
  const field = multiline
    ? `<textarea id="sh-in" rows="5" placeholder="${escapeHtml(placeholder)}" autofocus>${escapeHtml(value)}</textarea>`
    : `<input id="sh-in" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"${inputmode ? ` inputmode="${inputmode}"` : ""} autofocus>`;
  const p = show(`${head(title)}<form class="sh-form">
      ${label ? `<label for="sh-in">${escapeHtml(label)}</label>` : ""}${field}
      ${hint ? `<p class="sh-hint">${escapeHtml(hint)}</p>` : ""}
      <div class="sh-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${escapeHtml(ok)}</button></div>
    </form>`);
  const form = $("sheet").querySelector("form");
  form.addEventListener("submit", (e) => { e.preventDefault(); close($("sh-in").value.trim()); });
  form.querySelector("[data-cancel]").addEventListener("click", () => close(null));
  return p;
}

/** A yes/no question. Resolves true or false. */
export async function confirm({ title = "", text = "", ok = "OK", danger = false }) {
  const p = show(`${head(title)}${text ? `<p class="sh-text">${escapeHtml(text)}</p>` : ""}
    <div class="sh-actions"><button class="btn" data-no>Cancel</button><button class="btn primary${danger ? " danger" : ""}" data-yes autofocus>${escapeHtml(ok)}</button></div>`);
  $("sheet").querySelector("[data-no]").addEventListener("click", () => close(false));
  $("sheet").querySelector("[data-yes]").addEventListener("click", () => close(true));
  return (await p) === true;
}

/**
 * A card with your own markup. `wire(box, done)` hooks up its buttons; call done(value) to close.
 * Resolves with that value (null if dismissed).
 */
export function card({ title = "", subtitle = "", html = "", wide = false, wire, onClose }) {
  const p = show(`${head(title, subtitle)}<div class="sh-body">${html}</div>`, { wide, onClose });
  wire?.($("sheet"), (v) => close(v));
  return p;
}
