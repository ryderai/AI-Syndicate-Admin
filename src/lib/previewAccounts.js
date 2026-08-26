import { useEffect, useState } from "react";

/* WHO YOU ARE IN PREVIEW MODE — the click-to-enter account picker.
 *
 * Built Aug 26 2026, Ryder's ask: "make it so you can log in and out now but
 * just click if you want to enter as which account, no login or password. i
 * need to test the sales side and the admin side."
 *
 * ── Why this is not a way past the login ───────────────────────────────────
 *
 * This file only ever runs when `isConfigured()` is FALSE — that is, when
 * sign-in is switched off (`VITE_NO_SIGNIN=true`) or the Supabase keys are
 * missing. In that state the console was ALREADY wide open: it handed
 * everybody a hard-coded owner account called "Preview Admin" and there was no
 * password to type. Read `PREVIEW_MEMBER` in the old AdminDashboard.jsx if you
 * want to see it.
 *
 * So this picker does not unlock anything. It replaces one silent owner with a
 * visible choice, and choosing anything other than Owner gives you LESS than
 * before. The moment real keys are in place and sign-in is on, `isConfigured()`
 * is true, none of this is reachable, and the real email-and-password screen is
 * the only way in. Nothing here touches Supabase, reads a token, or writes to
 * any table.
 *
 * If you are ever tempted to make this work with real data: don't. The whole
 * point of the sign-in switch is that it drops the app onto the sample store,
 * because every real read is authorised by a signed-in user's token. A picker
 * over live data would be an actual bypass.
 *
 * ── Why sessionStorage and not localStorage ────────────────────────────────
 *
 * A tab is one person. sessionStorage is per-tab, so Ryder can hold the Owner
 * console open in one tab and the sales rep's view in another and compare them
 * side by side — which is the whole reason he asked. localStorage would make
 * the two tabs fight over one identity, and switching in one would silently
 * change the other.
 *
 * The cost is that closing the tab forgets the choice. That is the right trade
 * for a testing tool: a reload keeps you where you were, a new tab asks.
 */

/** The three roles the console actually has. Anything not in this list is not a
 *  role — `admin_users.role` is checked in the database against exactly these
 *  three (migration 0001), and Sidebar.jsx decides what each one may see. */
export const PREVIEW_ACCOUNTS = [
  {
    /* Same `user_id` as the sample owner in data.js, on purpose. The sample
     * tasks, leads, notes and reminders are assigned to `preview-user`, so
     * entering as the owner shows a console with work in it rather than a set
     * of empty pages. */
    user_id: "preview-user",
    email: "you@aisyndicate.com",
    full_name: "Preview Admin",
    role: "owner",
    label: "Owner",
    blurb: "Everything. Money, clients, the vault, the team page.",
    detail: "What CJ and Andrew see.",
  },
  {
    user_id: "preview-admin",
    email: "admin@aisyndicate.com",
    full_name: "Sample Admin",
    role: "admin",
    label: "Admin",
    /* Checked against Sidebar.jsx before writing this, and the first draft of it
     * was wrong: it said an admin cannot see the money pages. An admin sees the
     * same PAGES as an owner — every group in SECTIONS lists owner and admin
     * together. What an owner can do that an admin cannot is enforced in the
     * database, not in the menu (migration 0001: an admin cannot change an
     * owner's row on the Team page). Preview mode has no database, so the two
     * accounts look alike here. Saying so beats a screen that quietly claims a
     * difference it cannot show. */
    blurb: "The same pages as an owner. What differs is what the database lets each one change.",
    detail: "So this looks almost identical to Owner. Work and Notes are empty on purpose — nothing is assigned to them.",
  },
  {
    /* The sample rep already owns leads and tasks in data.js, so the sales
     * console has real rows to click. */
    user_id: "preview-rep",
    email: "rep@aisyndicate.com",
    full_name: "Sample Rep",
    role: "sales",
    label: "Sales rep",
    blurb: "Three pages: Work, Leads and My leads. No clients, no money, no vault, no team.",
    detail: "This is the view to check before CJ hands a rep their login.",
  },
];

const KEY = "adm-preview-account";

/** The account for a stored user_id, or null. A stored id that is no longer in
 *  the list — a role we removed, a typo in devtools — must not sign anybody in
 *  as a half-account, so it reads as "nobody chose yet" and the picker shows. */
function accountFor(userId) {
  return PREVIEW_ACCOUNTS.find((a) => a.user_id === userId) || null;
}

/* One copy of "who is in this tab", shared by every component that asks, with
 * listeners so switching account re-renders the whole console at once. Same
 * shape as the shared session in lib/auth.js, for the same reason: two
 * components holding their own copy is how they end up disagreeing. */
const store = {
  account: undefined,   // undefined = not read from the tab yet
  listeners: new Set(),
};

function read() {
  try {
    return accountFor(window.sessionStorage.getItem(KEY));
  } catch {
    /* Private windows and locked-down browsers throw on access rather than
     * returning null. Treat it as "nobody chose", which shows the picker — the
     * console still works, the choice just does not survive a reload. */
    return null;
  }
}

function emit() {
  for (const l of store.listeners) l();
}

/** Who is in this tab. null means nobody has picked yet. */
export function currentPreviewAccount() {
  if (store.account === undefined) store.account = read();
  return store.account;
}

/** Enter as one of the accounts. Ignores an id that is not on the list. */
export function enterAsPreviewAccount(userId) {
  const acct = accountFor(userId);
  if (!acct) return false;
  try { window.sessionStorage.setItem(KEY, acct.user_id); } catch { /* private mode */ }
  store.account = acct;
  emit();
  return true;
}

/** Sign out of the preview console — back to the picker. */
export function leavePreviewAccount() {
  try { window.sessionStorage.removeItem(KEY); } catch { /* private mode */ }
  store.account = null;
  emit();
}

export function subscribePreviewAccount(fn) {
  store.listeners.add(fn);
  return () => { store.listeners.delete(fn); };
}

/** The member object the dashboard expects, or null if nobody has picked.
 *  Only the four fields the console reads off a membership row — the label,
 *  blurb and detail are for the picker screen and must not leak into anything
 *  that thinks it is holding a database row. */
export function previewMember(acct) {
  if (!acct) return null;
  return {
    user_id: acct.user_id,
    email: acct.email,
    full_name: acct.full_name,
    role: acct.role,
  };
}

/** React hook: who is in this tab, and re-render when that changes. */
export function usePreviewAccount() {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribePreviewAccount(() => forceUpdate((n) => n + 1)), []);
  return currentPreviewAccount();
}
