/* What the person is looking at, so the assistant can answer "this one".
 *
 * THE PROBLEM THIS SOLVES
 * A chat box floating over a page is useless if it cannot see the page. Ask it
 * "when did we last call this guy" while a lead is open and, without this, it
 * has no idea which guy.
 *
 * HOW IT WORKS, AND WHAT IT IS NOT
 * It is NOT a screenshot and it does not read the DOM. Each page calls
 * useScreenContext() and states, in its own words, what is on screen: the page
 * name, the record that is open, and a short list of what is visible. So a
 * page decides what it shares, which means a page can share nothing.
 *
 * That distinction is the whole design. Scraping the DOM would have been less
 * code and would have quietly picked up anything that happened to be rendered
 * — a customer's email address in a table the person had scrolled past, a
 * card number in a support ticket. Stating it explicitly costs one hook call
 * per page and means nothing travels that a page did not name.
 *
 * Two hard limits below: `visible` is capped at 25 short entries, and there is
 * no free-text dump of the page. The assistant gets a pointer to the record,
 * then reads that record's real row from the database itself.
 */

import { useEffect } from "react";

let current = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(current); } catch { /* a broken listener must not break the page */ }
  }
}

/** Called by pages. Everything is trimmed here rather than at each call site,
 * so one careless page cannot post a whole table into a prompt. */
export function setScreenContext(next) {
  if (!next) {
    current = null;
  } else {
    current = {
      page: String(next.page || "").slice(0, 60),
      label: next.label ? String(next.label).slice(0, 160) : null,
      record: next.record
        ? {
          type: String(next.record.type || "").slice(0, 40),
          id: next.record.id ? String(next.record.id).slice(0, 64) : null,
          label: next.record.label ? String(next.record.label).slice(0, 160) : null,
        }
        : null,
      visible: Array.isArray(next.visible)
        ? next.visible.slice(0, 25).map((v) => String(v).slice(0, 80))
        : [],
    };
  }
  notify();
}

export function getScreenContext() {
  return current;
}

export function onScreenContext(fn) {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/**
 * Publish what this page is showing. Re-runs when `deps` change.
 *
 * `build` is a function rather than an object so a page can hand over what it
 * has at that moment without rebuilding an object on every render. The cleanup
 * clears the context on unmount, so leaving a page never leaves the assistant
 * answering about a screen nobody is looking at any more.
 */
export function useScreenContext(build, deps = []) {
  useEffect(() => {
    setScreenContext(typeof build === "function" ? build() : build);
    return () => setScreenContext(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
