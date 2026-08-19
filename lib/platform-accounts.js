/* Shared rules for platform login cards.
 *
 * Imported by BOTH the browser (src/components/admin/platformAccounts.jsx) and
 * the server (api/platform-sso.js) on purpose. If the two sides matched emails
 * differently, a card could look saved while the sign-in endpoint said "that
 * account is not on the list" — the exact bug the list is meant to prevent.
 *
 * Pure functions only. No imports, no environment, no database.
 */

/** Lower-cased and trimmed. Supabase treats Login@x.com and login@x.com as one
 * account, so every comparison in the console uses this form. */
export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** Cheap shape check: one @, something on each side, a dot after the @, no
 * spaces. It cannot tell you the account exists — only Supabase can, and that
 * answer comes back on the button. */
export function looksLikeEmail(value) {
  const v = normalizeEmail(value);
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v);
}

/** Ours first, then live client accounts, then switched-off ones, then by the
 * hand order, then by name. The order someone reads the page in. */
export function sortAccounts(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ours = (r) => (r.client_id ? 1 : 0);
    const off = (r) => (r.active === false ? 1 : 0);
    return (
      off(a) - off(b) ||
      ours(a) - ours(b) ||
      (a.sort || 0) - (b.sort || 0) ||
      String(a.label || "").localeCompare(String(b.label || ""))
    );
  });
}

/** What to call an account when no label was typed. */
export function accountLabel(row, clientName) {
  const label = String(row?.label || "").trim();
  if (label) return label;
  if (clientName) return clientName;
  return normalizeEmail(row?.email) || "Untitled account";
}
