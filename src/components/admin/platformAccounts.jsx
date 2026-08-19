import { useCallback, useEffect, useState } from "react";
import { Modal, Field, TextInput, TextArea, Select, EmptyState, SourceBadge, useHealth } from "./shared.jsx";
import { Chip } from "./opsCells.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { listPlatformAccounts, upsertPlatformAccount, deletePlatformAccount } from "../../lib/data.js";
import { looksLikeEmail, normalizeEmail, sortAccounts, accountLabel } from "../../../lib/platform-accounts.js";

/* PLATFORM LOGIN CARDS — built Aug 18 2026.
 *
 * One card per account we hold on the customer platform: ours, and one for each
 * client whose workspace we work inside. Press the button and that account opens
 * in a new tab, already signed in. No password is typed, and none is stored —
 * the console asks the server for a one-time Supabase sign-in link for the
 * saved address.
 *
 * This file is the ONE copy of the card, the sign-in click and the add/edit box.
 * The Our-platform page shows every card; a client page shows only that client's.
 * Two copies would drift, and a login button that behaves differently in two
 * places is how someone ends up signed into the wrong account.
 *
 * Honest about what it is: the link this mints is a real login for that
 * address. Anything done in that tab is done as that account, and it looks like
 * that account did it. Only owners and admins can press it (checked again on
 * the server, not just hidden here).
 */

/* One source for the platform address on the browser side. It must match the
 * server's PLATFORM_URL, or the sign-in tab goes to one place while the plain
 * links go to another — staging vs production, silently. */
const PLATFORM = (import.meta.env.VITE_PLATFORM_URL || "https://aisyndicate.com").replace(/\/+$/, "");
export const PLATFORM_BASE = PLATFORM + "/#/dashboard";

/* A link is only ever rendered if it is a real web address. The modal checks
 * this on the way in, but a row can also be typed straight into the SQL editor,
 * and "javascript:..." in an href is a live script, not a link. */
export function safeHref(url) {
  return /^https?:\/\//i.test(String(url || "")) ? String(url) : null;
}

/* A tab has to be opened inside the click itself or the browser blocks it as a
 * popup. Note: NO "noopener" in the feature string — with it, window.open
 * returns null by spec and we lose the handle we need to redirect the tab.
 * We drop the back-reference by hand instead, which does the same job. */
function openHoldingTab(who) {
  const win = window.open("", "_blank");
  if (!win) return null;
  try { win.opener = null; } catch { /* some browsers make it read-only */ }
  try {
    win.document.write(
      "<title>Signing you in…</title>" +
      "<body style=\"margin:0;display:grid;place-items:center;height:100vh;" +
      "font:600 15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#2d4663;background:#f5f8fb\">" +
      "<div>Signing you into " + escapeHtml(who || "the platform") + "…</div></body>"
    );
    win.document.close();
  } catch { /* the write can fail; the tab still works */ }
  return win;
}

/* The label is typed by a person and gets written into another document, so it
 * is escaped. Small thing, but an unescaped name is an unescaped name. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Do the sign-in. Opens the tab first (inside the click), then asks the server
 * for the link. Returns true when a link was used. */
export async function signInToAccount(account, { preview }) {
  const name = accountLabel(account);

  if (preview) {
    toast.warn(
      "Preview mode — no real sign-in yet",
      "The Supabase keys aren't loaded, so there is no account to sign into. Opening the platform normally instead."
    );
    window.open(PLATFORM_BASE, "_blank", "noopener,noreferrer");
    return false;
  }

  const win = openHoldingTab(name);

  let res;
  try {
    res = await apiFetch("/api/platform-sso", {
      method: "POST",
      body: { accountId: account?.id || null },
    });
  } catch (err) {
    res = { ok: false, error: err?.message || "The sign-in request failed." };
  }

  const url = res?.ok ? res.data?.url : null;
  if (!url) {
    const why = res?.data?.error || res?.error || "The server didn't return a sign-in link.";
    // Reuse the tab we already have rather than asking for a second one: a
    // window.open after an await gets swallowed as a popup, which is how you
    // end up with a toast that says "opening" and nothing opening.
    if (win) {
      toast.error(`Couldn't sign you into ${name}`, why + " Opening the platform normally in that tab — sign in there as usual.");
      win.location.href = PLATFORM_BASE;
    } else {
      toast.error(`Couldn't sign you into ${name}`, why + " Your browser also blocked the new tab, so nothing opened. Allow pop-ups for this address and press the button again.");
    }
    return false;
  }

  /* Careful with the words here. All that happened is that a sign-in link was
   * made and a tab was sent to it. Whether the platform accepted it — the
   * address might have no login, the origin might be missing from Supabase's
   * redirect list — happens over there, and nothing on this page can see it.
   * "Signed in as X" would be a claim we cannot back. */
  if (win) {
    win.location.href = url;
    toast.success(
      `Sign-in link made for ${name}`,
      `The new tab is opening it as ${res.data.account}. If that tab stops at the platform's sign-in screen, the link was refused — check the account exists. The link is one-time either way.`
    );
  } else {
    toast.info("Your browser blocked the new tab", "Sending this tab to the platform instead.");
    window.location.href = url;
  }
  return true;
}

/** Load the cards. clientId: null = all, "ours" = the agency's own, or an id. */
export function usePlatformAccounts(clientId = null) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, sample: false });

  const load = useCallback(async () => {
    /* A thrown error (not a returned one) used to leave loading stuck at true
     * for good: no rows, no error banner, just "Loading…" forever. Anything
     * that goes wrong ends up in the same place — on screen. */
    try {
      const r = await listPlatformAccounts(clientId);
      setRows(sortAccounts(r.rows));
      setState({ loading: false, error: r.error || null, sample: Boolean(r.sample) });
    } catch (err) {
      setRows([]);
      setState({ loading: false, error: err?.message || "The saved accounts could not be read.", sample: false });
    }
  }, [clientId]);

  useEffect(() => { load(); }, [load]);

  return { rows, ...state, reload: load };
}

function whenText(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* ------------------------------------------------------------------ */
/* ONE CARD                                                            */
/* ------------------------------------------------------------------ */

export function PlatformAccountCard({ account, clientName, onEdit, onRemove, reload, showWho = true }) {
  const [busy, setBusy] = useState(false);
  const preview = !isConfigured();
  const off = account.active === false;
  const last = whenText(account.last_opened_at);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const used = await signInToAccount(account, { preview });
    setBusy(false);
    if (used && reload) reload();
  };

  return (
    <div className={`card adm-pa-card${account.client_id ? "" : " ours"}${off ? " off" : ""}`}>
      <div className="adm-pa-top">
        <div style={{ minWidth: 0 }}>
          <div className="adm-pa-name">{accountLabel(account, clientName)}</div>
          <div className="adm-pa-email" title="The address the sign-in link is made for">
            {normalizeEmail(account.email)}
          </div>
        </div>
        <div className="adm-pa-chips">
          {showWho && (account.client_id
            ? <Chip label="CLIENT" color="blue" title={clientName ? `Belongs to ${clientName}` : "Belongs to a client"} />
            : <Chip label="OURS" color="purple" title="Our own agency account on the platform" />)}
          {off && <Chip label="OFF" color="red" title="Switched off. Turn it back on to sign in with it." />}
        </div>
      </div>

      {(account.site || account.plan) && (
        <div className="adm-pa-meta">
          {account.site && <span title="What YOUR SITE is set to inside that workspace">Site: <strong>{account.site}</strong></span>}
          {account.plan && <span title="What plan that account is on">Plan: <strong>{account.plan}</strong></span>}
        </div>
      )}

      {account.notes && <div className="adm-pa-notes">{account.notes}</div>}

      <div className="adm-pa-actions">
        <button className="btn btn-accent" onClick={go} disabled={busy || off} title={off ? "This account is switched off." : "Opens the platform in a new tab, already signed in as this account."}>
          {busy ? "Signing you in…" : <>Sign in and open <span className="arr">&rarr;</span></>}
        </button>
        {safeHref(account.vault_url) && (
          <a className="btn btn-sm" href={safeHref(account.vault_url)} target="_blank" rel="noopener noreferrer" title="Opens Bitwarden. The password lives there, never here.">
            Password (Bitwarden)
          </a>
        )}
        {onEdit && <button className="btn btn-sm" onClick={() => onEdit(account)}>Edit</button>}
        {onRemove && <button className="btn btn-sm" style={{ color: "var(--danger)" }} onClick={() => onRemove(account)}>Remove</button>}
      </div>

      {/* "Link made", not "opened". A link being minted is the only thing this
          side can actually witness — see the note in signInToAccount. */}
      <div className="adm-pa-foot" title="When someone last pressed this button. It records that a sign-in link was made, not that the platform accepted it.">
        {last ? `LAST SIGN-IN LINK MADE ${last.toUpperCase()}` : "NO SIGN-IN LINK MADE FROM HERE YET"}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ADD / EDIT                                                          */
/* ------------------------------------------------------------------ */

export function PlatformAccountModal({ account, clients = [], lockedClientId = null, nextSort = 0, onClose, reload }) {
  const [f, setF] = useState({
    label: account?.label || "",
    email: account?.email || "",
    client_id: account?.client_id || lockedClientId || "",
    site: account?.site || "",
    plan: account?.plan || "",
    vault_url: account?.vault_url || "",
    notes: account?.notes || "",
    active: account?.active !== false,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const save = async () => {
    const label = f.label.trim();
    const email = normalizeEmail(f.email);
    const vault = f.vault_url.trim();

    if (!label) { toast.warn("Give the card a name", "Whatever you would call it out loud. Example: Shiner Law Group."); return; }
    if (!looksLikeEmail(email)) { toast.warn("Check the login email", "It needs an @ and a dot after it, like name@company.com."); return; }
    if (vault && !/^https?:\/\//i.test(vault)) { toast.warn("The vault link needs to start with https://", "Paste the Bitwarden link, not the password."); return; }

    setBusy(true);
    const res = await upsertPlatformAccount({
      ...(account ? { id: account.id } : { sort: nextSort }),
      label,
      email,
      client_id: f.client_id || null,
      site: f.site.trim() || null,
      plan: f.plan.trim() || null,
      vault_url: vault || null,
      notes: f.notes.trim() || null,
      active: Boolean(f.active),
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not save it", res.error); return; }
    toast.success(account ? "Account updated" : "Account added", label);
    onClose();
    reload();
  };

  const clientOptions = [["", "Ours — the AI Syndicate account"], ...clients.map((c) => [c.id, c.name])];

  return (
    <Modal
      open onClose={onClose}
      kicker="PLATFORM LOGIN"
      title={account ? "Edit this account" : "Add a platform account"}
      width={580}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      <Field label="Name on the card" hint="What you would call it out loud. Example: Shiner Law Group.">
        <TextInput value={f.label} onChange={set("label")} placeholder="Shiner Law Group" />
      </Field>
      <Field
        label="Login email"
        hint="The address that signs into the platform. Pressing the button makes a one-time sign-in link for THIS address, so it has to be the real one."
      >
        <TextInput value={f.email} onChange={set("email")} placeholder="name@company.com" autoComplete="off" />
      </Field>
      {!lockedClientId && (
        <Field label="Whose account is it?" hint="Leave it on Ours for our own workspace.">
          <Select value={f.client_id} onChange={set("client_id")} options={clientOptions} />
        </Field>
      )}
      <Field label="Site it is pointed at (optional)" hint="What YOUR SITE is set to inside that workspace, so nobody has to open it to find out.">
        <TextInput value={f.site} onChange={set("site")} placeholder="example.com" />
      </Field>
      <Field label="Plan (optional)" hint="Whatever plan that account is on, in plain words.">
        <TextInput value={f.plan} onChange={set("plan")} placeholder="Radar" />
      </Field>
      <Field label="Bitwarden link (optional)" hint="A LINK ONLY. Never paste a password here — anyone with console access can read this box.">
        <TextInput value={f.vault_url} onChange={set("vault_url")} placeholder="https://vault.bitwarden.com/..." />
      </Field>
      <label className="adm-inbox-check" style={{ marginBottom: 14 }}>
        <input type="checkbox" checked={f.active} onChange={(e) => setF((cur) => ({ ...cur, active: e.target.checked }))} />
        We still work in this account
      </label>
      <Field label="Notes (optional)" hint="Two-factor, what not to touch, who else uses it.">
        <TextArea value={f.notes} onChange={set("notes")} style={{ minHeight: 70 }} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* THE CLIENT-PAGE PANEL                                               */
/* ------------------------------------------------------------------ */
/* Same card, same button, scoped to one client. Lives on the client page so
 * nobody has to go find the account list to open the account. */

/* The page that shows this panel owns the one copy of the list and hands it
 * down — same rule as the Operations table. Two components fetching the same
 * rows is two answers to one question. */
export function PlatformAccountsPanel({ client, accounts }) {
  const { rows, loading, error, sample, reload } = accounts;
  const [modal, setModal] = useState(null); // {} = new, row = edit
  const offCount = rows.filter((a) => a.active === false).length;
  const health = useHealth();
  /* Owners only, because the database only lets owners delete — see the RLS in
   * migration 0005. Preview mode has no real roles, so the page stays usable
   * there. Switching a card off is the everyday retire, and anyone can do it. */
  const canRemove = Boolean(health?.preview) || health?.role === "owner";

  const removeAccount = async (account) => {
    if (!window.confirm(`Remove the "${account.label}" login card? The account on the platform is untouched — this only removes the shortcut from this page.`)) return;
    const res = await deletePlatformAccount(account.id);
    if (!res.ok) { toast.error("Could not remove it", res.error); return; }
    toast.success("Removed", account.label);
    reload();
  };

  return (
    <>
      <div className="card adm-cp-sitesbar">
        <div style={{ minWidth: 0 }}>
          <div className="label" style={{ marginBottom: 4 }}>Platform login</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
            {loading ? "Loading…" : rows.length
              ? `${rows.length} saved${offCount ? ` · ${offCount} switched off` : ""} · one click opens the platform as ${rows.length - offCount === 1 ? "this account" : "one of these"}`
              : "Nothing saved yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn btn-accent" onClick={() => setModal({})}>Add an account</button>
          <SourceBadge mode={sample ? "sample" : "live"} />
        </div>
      </div>

      {error && <div className="adm-db-warn">Could not read the saved accounts: {error}</div>}

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon="&#128273;"
          title={`No platform account saved for ${client.name}`}
          body="Save the email they sign into the platform with. After that, one button here opens their workspace already signed in — no password typed, and none stored."
          action={<button className="btn btn-accent" onClick={() => setModal({})}>Add the first one</button>}
        />
      ) : (
        <div className="adm-pa-grid">
          {rows.map((a) => (
            <PlatformAccountCard
              key={a.id}
              account={a}
              clientName={client.name}
              showWho={false}
              onEdit={(row) => setModal(row)}
              onRemove={canRemove ? removeAccount : null}
              reload={reload}
            />
          ))}
        </div>
      )}

      {modal && (
        <PlatformAccountModal
          key={modal.id || "new"}
          account={modal.id ? modal : null}
          lockedClientId={client.id}
          nextSort={rows.length}
          onClose={() => setModal(null)}
          reload={reload}
        />
      )}
    </>
  );
}
