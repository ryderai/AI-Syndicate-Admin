/* The clipboard, in one place, because a secret on the clipboard is the one
 * copy of it nobody can see.
 *
 * TWO THINGS THIS FILE EXISTS TO GET RIGHT, both learned the hard way:
 *
 * 1. A copy either happened or it did not. `navigator.clipboard.writeText` can
 *    refuse — an insecure page, a browser setting, a tab that is not focused —
 *    and a green "Copied" over a refusal is how somebody pastes last week's
 *    password into a client's website.
 *
 * 2. The timed wipe must outlive the component that started it, and must not
 *    eat anything else. The first version put the timer on the card, so the
 *    promised wipe was cancelled the moment you typed in the search box. The
 *    second version moved it to module scope and then wiped whatever you had
 *    copied since — a username, a client's email address on another page —
 *    sixty seconds later, silently.
 *
 *    So: the timer lives here, it survives any component unmounting, and ANY
 *    later copy through this module cancels it. What we put on the clipboard is
 *    ours to clear; what you copied afterwards is not.
 *
 * What it still cannot do: see a copy made outside this app (Ctrl-C on a web
 * page, another tab). Reading the clipboard back needs a permission prompt that
 * would be worse than the problem. So the wipe is best effort and is never
 * reported as done — the toast says "about a minute", not "cleared".
 */

let wipeTimer = null;

/** Cancel a pending wipe. Called on every copy, including copies of things
 * that are not secrets. */
export function cancelClipboardWipe() {
  clearTimeout(wipeTimer);
  wipeTimer = null;
}

/**
 * Put text on the clipboard. Returns { ok } or { ok:false, why } — never
 * throws, and never claims success it did not have.
 *
 * Any copy cancels a pending wipe, so the last thing copied is the thing that
 * stays.
 */
export async function copyToClipboard(value) {
  /* THE CANCEL HAPPENS ONLY AFTER A COPY THAT ACTUALLY WORKED.
   *
   * Cancelling first looks tidier and is wrong: a refused copy puts nothing new
   * on the clipboard, so cancelling the wipe leaves the PREVIOUS secret sitting
   * there for good, with the toast that promised to write it over already gone
   * from the screen. "Document is not focused" is the everyday Chrome refusal —
   * it fires exactly when somebody alt-tabs to paste and comes back. Caught by
   * a reviewer, Aug 21 2026; it was the third form of the same bug. */
  try {
    if (!navigator.clipboard?.writeText) {
      return { ok: false, why: "This browser will not let a page write to the clipboard here." };
    }
    await navigator.clipboard.writeText(String(value));
    cancelClipboardWipe();
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err?.message || "The browser refused the copy." };
  }
}

/**
 * Write over the clipboard after `seconds`, unless something else is copied
 * first. Only used after copying a secret.
 */
export function wipeClipboardLater(seconds) {
  cancelClipboardWipe();
  wipeTimer = setTimeout(() => {
    wipeTimer = null;
    // Best effort, and deliberately not reported: the browser can refuse this
    // write too, and there is no way to find out from here.
    navigator.clipboard?.writeText?.(" ")?.catch?.(() => {});
  }, seconds * 1000);
}
