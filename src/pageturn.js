// Page-turn animations for the epub.js reader, in the spirit of ReadEra.
//
//   slide  The page glides sideways (~280 ms, ease-out). Rapid presses chain smoothly.
//          On touch the page follows your finger; let go past a third of the page or with a
//          flick and it slides on, otherwise it springs back. Uses epub.js's "continuous"
//          manager so neighbouring chapters sit side by side and slide just as smoothly.
//   fade   The page dips out and back in.
//   none   Instant, like a classic e-reader.
//
// epub.js lays a paginated book out as one wide, horizontally scrolling strip; a page is one
// "delta" (a page, or two in a two-page spread) of scrollLeft. Sliding animates that scroll.

export const MODES = ["slide", "fade", "none"];

/** The epub.js manager to use for a mode. */
export const managerFor = (mode) => (mode === "slide" ? "continuous" : "default");

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const now = () => (window.performance ? performance.now() : Date.now());

/**
 * Attach page turning to a rendition.
 * @param rendition epub.js Rendition (already rendered to its element)
 * @param mode      "slide" | "fade" | "none"
 * @param fadeEl    element faded in "fade" mode (the viewer)
 */
export function attach(rendition, mode, fadeEl) {
  let anim = null;      // running slide: { total, done, base, start, dur, dir }
  let fading = false;
  let drag = null;      // finger drag: { x0, y0, lastX, t0, startLeft, active }
  let destroyed = false;
  let pending = 0;      // a turn that has to wait for the current slide to finish

  const manager = () => rendition.manager;
  const container = () => manager() && manager().container;

  function canSlide() {
    const m = manager();
    return mode === "slide" && m && m.container && m.layout &&
      m.settings.axis !== "vertical" && m.settings.direction !== "rtl" && m.layout.delta > 0;
  }

  const plain = (dir) => (dir > 0 ? rendition.next() : rendition.prev());

  /** Tell epub.js where the page now is. Our own scrolling isn't always noticed: just after
   *  epub.js loads a neighbouring chapter it treats the next scroll as its own adjustment and
   *  stays quiet, which left the page counter (and the saved place) a page or more behind. */
  function report() {
    requestAnimationFrame(() => { if (!destroyed) try { rendition.reportLocation(); } catch { /* not ready */ } });
  }

  // ---------------------------------------------------------------- slide

  /** Scroll by `px` (positive = forward) with an ease-out curve; chains onto a running slide. */
  function slideBy(px, dur = 280) {
    const c = container();
    if (anim) {
      const remaining = anim.total - anim.done;
      anim = { total: remaining + px, done: 0, base: c.scrollLeft, start: now(), dur };
    } else {
      anim = { total: px, done: 0, base: c.scrollLeft, start: now(), dur };
      requestAnimationFrame(step);
    }
  }

  function step() {
    if (destroyed || !anim) return;
    const c = container();
    if (!c) { anim = null; return; }
    const a = anim;
    // epub.js may add or trim chapters before the current one mid-slide, shifting scrollLeft;
    // keep moving relative to wherever the page actually is.
    const expected = Math.round(a.base + a.done);
    if (Math.abs(c.scrollLeft - expected) > 2) a.base += c.scrollLeft - expected;
    const p = Math.min(1, (now() - a.start) / a.dur);
    a.done = a.total * easeOut(p);
    c.scrollLeft = Math.round(a.base + a.done);
    if (p < 1) requestAnimationFrame(step);
    else { anim = null; settle(); }
  }

  /** Line up exactly on a page edge, then run a turn that was waiting on the slide. */
  function settle() {
    const c = container(), m = manager();
    if (!c || !m) return;
    const d = m.layout.delta;
    c.scrollLeft = Math.round(c.scrollLeft / d) * d;
    report();
    if (pending) { const dir = pending; pending = 0; turn(dir); }
  }

  // ---------------------------------------------------------------- fade

  async function fade(dir) {
    if (fading) return plain(dir);
    fading = true;
    const el = fadeEl;
    try {
      el.style.transition = "opacity 110ms ease-in";
      el.style.opacity = "0";
      await wait(110);
      await plain(dir);
      el.style.transition = "opacity 170ms ease-out";
      el.style.opacity = "1";
      await wait(170);
    } finally {
      el.style.transition = "";
      el.style.opacity = "";
      fading = false;
    }
  }

  // ---------------------------------------------------------------- public: turn

  function turn(dir) {
    if (destroyed) return;
    if (mode === "fade") return fade(dir);
    if (!canSlide()) return plain(dir);
    const m = manager(), c = container(), d = m.layout.delta;
    // If we're already against the end of what's loaded and not mid-slide, let epub.js handle it.
    const pos = c.scrollLeft + (anim ? anim.total - anim.done : 0);
    const max = c.scrollWidth - c.offsetWidth;
    if ((dir > 0 && pos >= max - 1) || (dir < 0 && pos <= 1)) {
      if (anim) { pending = dir; return; } // finish this slide, then let epub.js load the next chapter
      return plain(dir);
    }
    slideBy(dir * d);
  }

  // ---------------------------------------------------------------- finger drag (slide mode)

  function touchPoint(e) { const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]); return t; }

  function onStart(e) {
    if (mode !== "slide" || !canSlide()) return;
    const t = touchPoint(e); if (!t) return;
    if (anim) { anim = null; } // grab the page mid-slide
    drag = { x0: t.screenX, y0: t.screenY, lastX: t.screenX, t0: now(), startLeft: container().scrollLeft, active: false, moved: 0 };
  }

  function onMove(e) {
    if (!drag) return;
    const t = touchPoint(e); if (!t) return;
    const dx = t.screenX - drag.x0, dy = t.screenY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      drag.active = true;
    }
    const c = container();
    const max = c.scrollWidth - c.offsetWidth;
    let step = drag.lastX - t.screenX; // finger left → page forward
    // A little resistance past the very start / end of what's loaded.
    if ((c.scrollLeft <= 0 && step < 0) || (c.scrollLeft >= max && step > 0)) step *= 0.3;
    c.scrollLeft += step;
    drag.moved += step;
    drag.lastX = t.screenX;
  }

  function onEnd(e) {
    if (!drag) return;
    const dr = drag; drag = null;
    if (!dr.active) return;
    const c = container(), d = manager().layout.delta;
    const t = touchPoint(e);
    const dist = t ? dr.x0 - t.screenX : dr.moved;   // + forward
    const ms = Math.max(1, now() - dr.t0);
    const velocity = dist / ms;                       // px per ms
    let go = 0;
    if (Math.abs(dist) > d / 3 || (Math.abs(velocity) > 0.35 && Math.abs(dist) > 24)) go = Math.sign(dist);
    // Target the page edge we started from, plus the decided direction.
    const fromPage = Math.round(dr.startLeft / d);
    // Account for any chapter trimmed or added during the drag.
    const shift = c.scrollLeft - (dr.startLeft + dr.moved);
    const target = (fromPage + go) * d + shift;
    const delta = target - c.scrollLeft;
    const dur = Math.max(140, Math.min(300, Math.abs(delta) * 0.9));
    if (Math.abs(delta) < 1) { settle(); return; }
    slideBy(delta, dur);
  }

  rendition.on("touchstart", onStart);
  rendition.on("touchmove", onMove);
  rendition.on("touchend", onEnd);

  return {
    mode,
    turn,
    /** True while a finger drag is in progress (taps/swipes elsewhere should stand aside). */
    dragging: () => !!(drag && drag.active),
    /** Feed touches from overlays that sit above the book (the edge tap zones). */
    touch: { start: onStart, move: onMove, end: onEnd },
    destroy() {
      destroyed = true;
      anim = null; drag = null;
      try {
        rendition.off("touchstart", onStart);
        rendition.off("touchmove", onMove);
        rendition.off("touchend", onEnd);
      } catch { /* rendition already gone */ }
      if (fadeEl) { fadeEl.style.transition = ""; fadeEl.style.opacity = ""; }
    },
  };
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
