import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Field, TextInput, TextArea, Select, EmptyState, SourceBadge } from "./shared.jsx";
import { Chip } from "./opsCells.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { copyToClipboard, wipeClipboardLater } from "../../lib/clipboard.js";
import {
  listVaultItems, upsertVaultItem, deleteVaultItem, listVaultReveals,
  previewRevealSecret, previewSaveSecret, previewClearSecret,
} from "../../lib/data.js";
import {
  VAULT_KINDS, VAULT_KIND_LABELS, VAULT_KIND_HELP,
  SECRET_FIELDS, SECRET_FIELD_LABELS, SECRET_FIELD_HELP,
  checkVaultItem, checkSecret, cardBrand, lastFour, maskedCard, groupCardNumber,
  expiryText, cardExpired, cardExpiringSoon, passwordStrength, buildPassword,
  hasSecret, holdsField, sortVaultItems, secretSummary, safeVaultHref, tidyUrl,
  onlyDigits, passesLuhn,
} from "../../../lib/vault.js";

/* THE VAULT — built Aug 21 2026, at Ryder's ask.
 *
 * One row per password, card, key or private note. The readable half — name,
 * client, username, card brand and last 4 — is on the screen all the time. The
 * secret half is scrambled in the database with a key that only the server has,
 * and only appears when somebody presses Reveal, which is written down.
 *
 * THREE THINGS THIS FILE DELIBERATELY DOES NOT DO
 *
 * 1. It never holds a secret in a variable for longer than it is on screen.
 *    Revealed values live in one piece of state that clears itself on a timer,
 *    on close, and when the component unmounts.
 * 2. It never puts a secret in the address bar, in a link, in a toast message,
 *    or in anything that gets logged.
 *    (Grep for `toast.` in this file: no message includes a value.)
 * 3. It never says "copied" or "saved" before the thing actually happened.
 *    The clipboard can refuse — an insecure page, a browser setting — and a
 *    green tick over a failed copy is how somebody pastes last week's password
 *    into a client's site.
 *
 * Bitwarden stays the master copy. Every item can carry a Bitwarden link, and
 * the page says so, because two places holding the truth is a problem you only
 * notice when they disagree.
 */

/* How long a revealed value stays on screen before it hides itself. Long
 * enough to read a card number down a phone; short enough that a screen left
 * open in a coffee shop is not a live password. */
const HIDE_AFTER_SECONDS = 45;

/* How long a copied value sits in the clipboard before it is written over.
 * Best effort — a browser can refuse the second write too, and if it does the
 * page says so rather than pretending. */
const CLIPBOARD_CLEAR_SECONDS = 60;

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** clientId: null = every item, "ours" = the agency's own, or a client id. */
export function useVaultItems(clientId = null) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, sample: false });

  const load = useCallback(async () => {
    /* A THROWN error, not a returned one, used to leave a panel stuck on
     * "Loading…" for good — no rows, no message. Everything that goes wrong
     * ends up in the same place: on screen. */
    try {
      const r = await listVaultItems(clientId);
      setRows(sortVaultItems(r.rows));
      setState({ loading: false, error: r.error || null, sample: Boolean(r.sample) });
    } catch (err) {
      setRows([]);
      setState({ loading: false, error: err?.message || "The vault could not be read.", sample: false });
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

/** Today as {year, month}, for the expiry checks in lib/vault.js. Those take
 * the date rather than reading a clock, so the same card reads the same way
 * everywhere and the tests do not break at midnight. */
function nowYm() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/* ------------------------------------------------------------------ */
/* Talking to the server                                               */
/* ------------------------------------------------------------------ */

async function callVault(body, { preview }) {
  if (preview) {
    // Preview mode has no server. Each action has an in-memory stand-in, and
    // every one of them reports { sample: true } so the page can say so.
    if (body.action === "reveal" || body.action === "copy") return previewRevealSecret(body.itemId, body.fields);
    if (body.action === "save") return previewSaveSecret(body.itemId, body.secrets);
    if (body.action === "clear") return previewClearSecret(body.itemId);
    if (body.action === "generate") {
      return {
        ok: true,
        password: buildPassword({
          length: body.length, symbols: body.symbols, digits: body.digits,
          randomInts: browserRandomInts,
        }),
        sample: true,
      };
    }
    return { ok: false, error: "Unknown action." };
  }
  const res = await apiFetch("/api/vault-secret", { method: "POST", body });
  if (!res.ok) return { ok: false, error: res.data?.error || res.error };
  return { ok: true, ...res.data };
}

/** Real randomness from the browser. Math.random is not used anywhere near a
 * password — it is predictable, and a predictable password is not one. */
function browserRandomInts(n) {
  const out = new Uint32Array(n);
  crypto.getRandomValues(out);
  return Array.from(out);
}

/**
 * Remove an item — through the server when it is live, so the deletion is
 * written into the log BEFORE the ciphertext is destroyed. Going straight to
 * Supabase from here (which is what it used to do) left no record at all that
 * a secret had been deleted.
 */
export async function removeVaultItem(item) {
  if (!isConfigured()) return deleteVaultItem(item.id);
  const res = await apiFetch("/api/vault-secret", { method: "POST", body: { action: "delete", itemId: item.id } });
  if (!res.ok) return { ok: false, error: res.data?.error || res.error };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* One item                                                            */
/* ------------------------------------------------------------------ */

export function VaultCard({ item, clientName, showWho = true, onEdit, onSecret, onRemove, onLog }) {
  /* Every revealed value this card is currently showing: { field: value }.
   * ONE piece of state, cleared in three places — the timer, the Hide button,
   * and the unmount below. A second copy of a secret is a second thing to
   * forget to clear. */
  const [shown, setShown] = useState({});
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(null);
  const timers = useRef({ tick: null, hide: null });
  const preview = !isConfigured();
  const off = item.active === false;
  const fields = SECRET_FIELDS[item.kind] || [];
  const ym = nowYm();
  const expired = item.kind === "card" && cardExpired(item.card_exp_month, item.card_exp_year, ym);
  const soon = item.kind === "card" && cardExpiringSoon(item.card_exp_month, item.card_exp_year, ym);

  const clearShown = useCallback(() => {
    setShown({});
    setLeft(0);
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.hide);
  }, []);

  /* Leaving the page, filtering the list, or closing a client hides everything
   * that was open. Without this, a revealed password survives in React state as
   * long as the component happens to stay mounted. */
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearInterval(t.tick);
      clearTimeout(t.hide);
    };
  }, []);

  /* When the row underneath changes — the secret was re-saved, cleared, or the
   * item was edited — anything on screen belongs to the old row. The card is
   * keyed by id and never remounts on a reload, so without this it would keep
   * showing the OLD password against a row that now holds a different one. */
  const storedFingerprint = `${item.kind}|${item.secret_set_at || ""}|${(item.secret_fields || []).join(",")}`;
  /* Kept in a ref as well, so an answer that lands after an await can compare
   * against what is on screen NOW rather than against the value it closed over. */
  const storedFingerprintRef = useRef(storedFingerprint);
  useEffect(() => {
    storedFingerprintRef.current = storedFingerprint;
    clearShown();
  }, [storedFingerprint, clearShown]);

  const startCountdown = () => {
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.hide);
    setLeft(HIDE_AFTER_SECONDS);
    timers.current.tick = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    timers.current.hide = setTimeout(clearShown, HIDE_AFTER_SECONDS * 1000);
  };

  const reveal = async (field) => {
    if (busy) return;
    setBusy(field);
    /* What the row looked like when the request went out. If it has changed by
     * the time the answer lands — somebody saved a new secret, or cleared it —
     * the value in that answer belongs to a row that no longer exists, and
     * putting it on screen would beat the clearing effect below. */
    const askedFor = storedFingerprint;
    const res = await callVault({ action: "reveal", itemId: item.id, fields: [field] }, { preview });
    setBusy(null);
    if (askedFor !== storedFingerprintRef.current) {
      toast.warn("That item changed while it was opening", "Nothing was shown, because what came back is not what is stored now. Press Reveal again.");
      return;
    }
    if (!res.ok) { toast.error("Nothing was opened", res.error); return; }
    if (res.missing?.length) {
      toast.warn("That part is not saved", `This item holds ${secretSummary(item).toLowerCase()}, and no ${(SECRET_FIELD_LABELS[field] || field).toLowerCase()}.`);
      return;
    }
    setShown((cur) => ({ ...cur, ...res.values }));
    startCountdown();
    if (res.sample) {
      toast.warn(
        res.typed ? "Preview only — nothing here is protected" : "Sample only",
        res.typed
          ? "You typed this into preview mode, so it was never scrambled and was never saved anywhere. It is held in this browser tab and disappears when you reload."
          : "There are no Supabase keys loaded, so this is a made-up value from the sample data — not anything real."
      );
    }
  };

  const copy = async (field) => {
    if (busy) return;
    setBusy(field);
    /* Always ask the server, even when the value is already on screen. Two
     * reasons, and the second is the real one:
     *   · the value on screen may belong to a row that has since changed;
     *   · a copy has to be its OWN line in the log. Reusing the revealed value
     *     produced one line saying "opened" for a press that put a password on
     *     the clipboard, and that is the distinction the log exists for. */
    const askedFor = storedFingerprint;
    const res = await callVault({ action: "copy", itemId: item.id, fields: [field] }, { preview });
    if (!res.ok) { setBusy(null); toast.error("Nothing was copied", res.error); return; }
    if (askedFor !== storedFingerprintRef.current) {
      setBusy(null);
      toast.warn("That item changed while it was copying", "Nothing went on the clipboard, because what came back is not what is stored now. Press Copy again.");
      return;
    }
    if (res.missing?.length) { setBusy(null); toast.warn("That part is not saved", "There is nothing here to copy."); return; }
    const value = res.values[field];
    const done = await copyToClipboard(String(value));
    setBusy(null);
    if (!done.ok) {
      toast.error("The copy did not happen", done.why + " Press Reveal and select it by hand instead.");
      return;
    }
    /* The name of the field, never the value. */
    toast.success(
      `${SECRET_FIELD_LABELS[field] || field} copied`,
      `Paste it now — it gets written over in about ${CLIPBOARD_CLEAR_SECONDS} seconds, unless you copy something else first.`
    );
    wipeClipboardLater(CLIPBOARD_CLEAR_SECONDS);
  };

  const copyPlain = async (label, value) => {
    /* Through the same module, so copying a username CANCELS the pending wipe
     * of the password copied a moment ago rather than losing it sixty seconds
     * later with no message. That was the second version's bug. */
    const done = await copyToClipboard(String(value));
    if (done.ok) toast.success(`${label} copied`, "");
    else toast.error("The copy did not happen", done.why);
  };

  const anyShown = Object.keys(shown).length > 0;

  return (
    <div className={`card adm-vault-card${item.favorite ? " fav" : ""}${off ? " off" : ""}`}>
      <div className="adm-vault-top">
        <div style={{ minWidth: 0 }}>
          <div className="adm-vault-name">
            {item.favorite && <span className="adm-vault-star" title="Pinned to the top of the list">★</span>}
            {item.label}
          </div>
          {item.description && <div className="adm-vault-desc">{item.description}</div>}
        </div>
        <div className="adm-vault-chips">
          <Chip label={(VAULT_KIND_LABELS[item.kind] || item.kind).toUpperCase()} color={KIND_COLOR[item.kind] || "default"} title={VAULT_KIND_HELP[item.kind]} />
          {showWho && (item.client_id
            ? <Chip label="CLIENT" color="blue" title={clientName ? `Belongs to ${clientName}` : "Belongs to a client"} />
            : <Chip label="OURS" color="purple" title="Our own account, not a client's" />)}
          {off && <Chip label="RETIRED" color="red" title="Kept for the record. We do not use this any more." />}
          {expired && <Chip label="EXPIRED" color="red" title="The expiry date on this card has passed." />}
          {!expired && soon && <Chip label="EXPIRES SOON" color="yellow" title="This card expires within two months." />}
        </div>
      </div>

      {/* -------- the readable half -------- */}
      <div className="adm-vault-meta">
        {item.username && (
          <div className="adm-vault-metarow">
            <span className="adm-vault-metak">Username</span>
            <span className="adm-vault-metav">{item.username}</span>
            <button className="adm-vault-mini" onClick={() => copyPlain("Username", item.username)} title="Copy the username">Copy</button>
          </div>
        )}
        {item.kind === "card" && (
          <>
            <div className="adm-vault-metarow">
              <span className="adm-vault-metak">Card</span>
              <span className="adm-vault-metav mono">
                {shown.number ? groupCardNumber(shown.number) : maskedCard(item.card_last4, item.card_brand)}
                {item.card_brand ? <span className="adm-vault-brand"> {item.card_brand}</span> : null}
              </span>
            </div>
            {expiryText(item.card_exp_month, item.card_exp_year) && (
              <div className="adm-vault-metarow">
                <span className="adm-vault-metak">Expires</span>
                <span className={`adm-vault-metav mono${expired ? " bad" : ""}`}>{expiryText(item.card_exp_month, item.card_exp_year)}</span>
              </div>
            )}
            {item.card_holder && (
              <div className="adm-vault-metarow">
                <span className="adm-vault-metak">Name on card</span>
                <span className="adm-vault-metav">{item.card_holder}</span>
              </div>
            )}
            {item.card_zip && (
              <div className="adm-vault-metarow">
                <span className="adm-vault-metak">Billing postcode</span>
                <span className="adm-vault-metav mono">{item.card_zip}</span>
              </div>
            )}
          </>
        )}
        {safeVaultHref(item.url) && (
          <div className="adm-vault-metarow">
            <span className="adm-vault-metak">Sign in at</span>
            <a className="adm-vault-metav link" href={safeVaultHref(item.url)} target="_blank" rel="noopener noreferrer">
              {String(item.url).replace(/^https?:\/\//i, "").replace(/\/+$/, "")} ↗
            </a>
          </div>
        )}
      </div>

      {/* -------- the secret half -------- */}
      <div className="adm-vault-secrets">
        {!hasSecret(item) ? (
          <div className="adm-vault-nothing">
            Nothing is saved against this item yet.
            {onSecret && <button className="adm-vault-mini" onClick={() => onSecret(item)}>Add it</button>}
          </div>
        ) : (
          fields.filter((f) => holdsField(item, f)).map((f) => (
            <div key={f} className="adm-vault-secret">
              <span className="adm-vault-secretk" title={SECRET_FIELD_HELP[f]}>{SECRET_FIELD_LABELS[f] || f}</span>
              <span className={`adm-vault-secretv${shown[f] ? " open" : ""}`}>
                {shown[f]
                  ? (f === "number" ? groupCardNumber(shown[f]) : shown[f])
                  : "••••••••••••"}
              </span>
              <button className="adm-vault-mini" disabled={busy === f} onClick={() => (shown[f] ? clearShown() : reveal(f))}>
                {busy === f ? "…" : shown[f] ? "Hide" : "Reveal"}
              </button>
              <button className="adm-vault-mini" disabled={busy === f} onClick={() => copy(f)} title="Copy it without showing it">
                Copy
              </button>
            </div>
          ))
        )}
        {anyShown && (
          <div className="adm-vault-countdown" role="status">
            Hiding in {left}s. Every one of these was written down — who looked, and when.
          </div>
        )}
      </div>

      {item.notes && <div className="adm-vault-notes">{item.notes}</div>}

      {(item.tags || []).length > 0 && (
        <div className="adm-vault-tags">
          {item.tags.map((t) => <span key={t} className="adm-vault-tag">{t}</span>)}
        </div>
      )}

      <div className="adm-vault-actions">
        {onSecret && <button className="btn btn-sm" onClick={() => onSecret(item)}>{hasSecret(item) ? "Change the secret" : "Add the secret"}</button>}
        {safeVaultHref(item.vault_url) && (
          <a className="btn btn-sm" href={safeVaultHref(item.vault_url)} target="_blank" rel="noopener noreferrer" title="Opens this item in Bitwarden, which is still the master copy.">
            Bitwarden ↗
          </a>
        )}
        {onEdit && <button className="btn btn-sm" onClick={() => onEdit(item)}>Edit</button>}
        {onLog && <button className="btn btn-sm" onClick={() => onLog(item)} title="Who has opened this, and when">Who looked</button>}
        {onRemove && <button className="btn btn-sm" style={{ color: "var(--danger)" }} onClick={() => onRemove(item)}>Remove</button>}
      </div>

      <div className="adm-vault-foot">
        {hasSecret(item)
          ? `${secretSummary(item).toUpperCase()} · LAST CHANGED ${String(whenText(item.secret_set_at)).toUpperCase()}`
          : "NO SECRET STORED"}
      </div>
    </div>
  );
}

const KIND_COLOR = { login: "blue", card: "green", api_key: "purple", note: "yellow" };

/* ------------------------------------------------------------------ */
/* Add / edit the readable half                                        */
/* ------------------------------------------------------------------ */

export function VaultItemModal({ item, clients = [], lockedClientId = null, nextSort = 0, onClose, reload }) {
  const [f, setF] = useState({
    kind: item?.kind || "login",
    label: item?.label || "",
    description: item?.description || "",
    client_id: item?.client_id || lockedClientId || "",
    username: item?.username || "",
    url: item?.url || "",
    card_brand: item?.card_brand || "",
    card_last4: item?.card_last4 || "",
    card_exp_month: item?.card_exp_month ? String(item.card_exp_month) : "",
    card_exp_year: item?.card_exp_year ? String(item.card_exp_year) : "",
    card_holder: item?.card_holder || "",
    card_zip: item?.card_zip || "",
    vault_url: item?.vault_url || "",
    notes: item?.notes || "",
    tags: (item?.tags || []).join(", "),
    favorite: Boolean(item?.favorite),
    active: item?.active !== false,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const holdsNumber = holdsField(item, "number");

  const save = async () => {
    /* The database refuses this too (migration 0008), but a red toast about a
     * trigger is not an explanation. Changing a card into a login leaves the
     * stored number with no button that can ever show it again. */
    if (item && hasSecret(item) && f.kind !== item.kind) {
      toast.warn(
        "Clear the stored secret first",
        `This item holds ${secretSummary(item).toLowerCase()}. A ${VAULT_KIND_LABELS[f.kind].toLowerCase()} has nowhere to keep that, so it would be stuck in there with no way to read it. Press "Change the secret", remove what is stored, then change the kind.`
      );
      return;
    }

    const payload = {
      kind: f.kind,
      label: f.label.trim(),
      description: f.description.trim() || null,
      client_id: f.client_id || null,
      username: f.kind === "card" ? null : (f.username.trim() || null),
      url: f.url.trim() ? tidyUrl(f.url) : null,
      /* When the full number is stored, these two are DERIVED from it on the
       * server and are not editable here. Sending them anyway would let a
       * fat-fingered last-4 point the whole list at the wrong card, with the
       * real number sitting behind it unchanged. */
      card_brand: f.kind === "card" ? (holdsNumber ? item.card_brand : (f.card_brand.trim() || null)) : null,
      card_last4: f.kind === "card" ? (holdsNumber ? item.card_last4 : (onlyDigits(f.card_last4).slice(-4) || null)) : null,
      card_exp_month: f.kind === "card" && f.card_exp_month ? Number(f.card_exp_month) : null,
      card_exp_year: f.kind === "card" && f.card_exp_year ? Number(f.card_exp_year) : null,
      card_holder: f.kind === "card" ? (f.card_holder.trim() || null) : null,
      card_zip: f.kind === "card" ? (f.card_zip.trim() || null) : null,
      vault_url: f.vault_url.trim() ? tidyUrl(f.vault_url) : null,
      notes: f.notes.trim() || null,
      tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
      favorite: Boolean(f.favorite),
      active: Boolean(f.active),
    };

    /* The same check the server runs, from the same file. Two copies of "what
     * counts as a valid card" is two answers to one question. */
    const verdict = checkVaultItem(payload);
    if (!verdict.ok) { toast.warn("Check that box", verdict.why); return; }

    setBusy(true);
    const res = await upsertVaultItem({ ...(item ? { id: item.id } : { sort: nextSort }), ...payload });
    setBusy(false);
    if (!res.ok) { toast.error("Could not save it", res.error); return; }
    toast.success(item ? "Item updated" : "Item added", payload.label);
    onClose();
    reload();
    if (!item) {
      toast.info("Now add the secret", "The password or card number is saved separately — press \"Add the secret\" on the new card.");
    }
  };

  const clientOptions = [["", "Ours — AI Syndicate's own"], ...clients.map((c) => [c.id, c.name])];
  const isCard = f.kind === "card";

  return (
    <Modal
      open onClose={onClose}
      kicker="VAULT"
      title={item ? "Edit this item" : "Add to the vault"}
      width={600}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      <div className="adm-vault-kindpick">
        {VAULT_KINDS.map((k) => (
          <button
            key={k} type="button"
            className={`adm-vault-kindbtn${f.kind === k ? " on" : ""}`}
            onClick={() => setF((cur) => ({ ...cur, kind: k }))}
            disabled={Boolean(item && hasSecret(item) && k !== item.kind)}
            title={item && hasSecret(item) && k !== item.kind
              ? "This item holds a stored secret. Remove what is stored before changing what kind of item it is."
              : VAULT_KIND_HELP[k]}
          >
            {VAULT_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="adm-vault-kindhelp">
        {item && hasSecret(item)
          ? `Locked, because this item holds ${secretSummary(item).toLowerCase()}. Remove what is stored to change the kind.`
          : VAULT_KIND_HELP[f.kind]}
      </div>

      <Field label="Name" hint="What you would call it out loud. Example: GoDaddy, or Business card — Chase.">
        <TextInput value={f.label} onChange={set("label")} placeholder="GoDaddy" />
      </Field>
      <Field label="What is it for? (optional)" hint="One line, so nobody has to guess a year from now.">
        <TextInput value={f.description} onChange={set("description")} placeholder="Where our own domains are registered." />
      </Field>
      {!lockedClientId && (
        <Field label="Whose is it?" hint="Leave it on Ours for our own accounts.">
          <Select value={f.client_id} onChange={set("client_id")} options={clientOptions} />
        </Field>
      )}

      {!isCard && (
        <Field label="Username or email (optional)" hint="The name typed into the sign-in box. Not the password.">
          <TextInput value={f.username} onChange={set("username")} placeholder="billing@aisyndicate.com" autoComplete="off" />
        </Field>
      )}
      {!isCard && (
        <Field label="Where do you sign in? (optional)" hint="Paste the address. If you leave off https:// it gets added for you.">
          <TextInput value={f.url} onChange={set("url")} placeholder="sso.godaddy.com" />
        </Field>
      )}

      {isCard && (
        <>
          <div className="adm-vault-row2">
            <Field
              label="Card company"
              hint={holdsNumber ? "Read from the stored number. Change the number to change this." : "Filled in for you when you save the full number."}
            >
              <TextInput value={f.card_brand} onChange={set("card_brand")} placeholder="Visa" disabled={holdsNumber} />
            </Field>
            <Field
              label="Last 4 digits"
              hint={holdsNumber ? "Read from the stored number, so the list can never point at the wrong card." : "So you can tell it apart in the list. The full number is saved separately."}
            >
              <TextInput value={f.card_last4} onChange={set("card_last4")} placeholder="4242" inputMode="numeric" maxLength={4} disabled={holdsNumber} />
            </Field>
          </div>
          <div className="adm-vault-row2">
            <Field label="Expiry month" hint="1 to 12.">
              <TextInput value={f.card_exp_month} onChange={set("card_exp_month")} placeholder="11" inputMode="numeric" maxLength={2} />
            </Field>
            <Field label="Expiry year" hint="In full, like 2028.">
              <TextInput value={f.card_exp_year} onChange={set("card_exp_year")} placeholder="2028" inputMode="numeric" maxLength={4} />
            </Field>
          </div>
          <div className="adm-vault-row2">
            <Field label="Name on the card" hint="Exactly as it is printed.">
              <TextInput value={f.card_holder} onChange={set("card_holder")} placeholder="AI SYNDICATE LLC" />
            </Field>
            <Field label="Billing postcode" hint="The one checkout pages ask for.">
              <TextInput value={f.card_zip} onChange={set("card_zip")} placeholder="32541" />
            </Field>
          </div>
        </>
      )}

      <Field label="Bitwarden link (optional)" hint="A LINK ONLY. Bitwarden stays the master copy — this console is the list everyone can see.">
        <TextInput value={f.vault_url} onChange={set("vault_url")} placeholder="https://vault.bitwarden.com/..." />
      </Field>
      <Field label="Tags (optional)" hint="Comma separated. Example: domains, money, client site.">
        <TextInput value={f.tags} onChange={set("tags")} placeholder="domains, money" />
      </Field>
      <Field label="Notes (optional)" hint="Two-factor, what not to touch, who else uses it. Never the password itself — that goes in the box behind Reveal.">
        <TextArea value={f.notes} onChange={set("notes")} style={{ minHeight: 70 }} />
      </Field>

      <label className="adm-inbox-check">
        <input type="checkbox" checked={f.favorite} onChange={(e) => setF((cur) => ({ ...cur, favorite: e.target.checked }))} />
        Pin it to the top of the list
      </label>
      <label className="adm-inbox-check" style={{ marginBottom: 14 }}>
        <input type="checkbox" checked={f.active} onChange={(e) => setF((cur) => ({ ...cur, active: e.target.checked }))} />
        We still use this
      </label>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Set / change the secret                                             */
/* ------------------------------------------------------------------ */

export function VaultSecretModal({ item, onClose, reload }) {
  const fields = SECRET_FIELDS[item.kind] || [];
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f, ""])));
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState({});
  const [genLen, setGenLen] = useState(20);
  const preview = !isConfigured();

  const set = (k) => (e) => setValues((cur) => ({ ...cur, [k]: e.target.value }));

  const generate = async () => {
    const res = await callVault({ action: "generate", length: genLen, symbols: true, digits: true }, { preview });
    if (!res.ok || !res.password) { toast.error("Could not make one", res.error || "No password came back."); return; }
    setValues((cur) => ({ ...cur, password: res.password }));
    setShow((cur) => ({ ...cur, password: true }));
    toast.success("Password made", "It is in the box. Nothing is saved until you press Save.");
  };

  const save = async () => {
    // Only the boxes that were typed in travel. An untouched box means "leave
    // whatever is already saved alone", NOT "wipe it".
    const touched = Object.fromEntries(Object.entries(values).filter(([, v]) => String(v).trim() !== ""));
    if (!Object.keys(touched).length) {
      toast.warn("Nothing to save", "Type into at least one box, or use Remove below to clear what is stored.");
      return;
    }
    for (const [field, value] of Object.entries(touched)) {
      const verdict = checkSecret(item.kind, field, value);
      if (!verdict.ok) { toast.warn(`Check the ${(SECRET_FIELD_LABELS[field] || field).toLowerCase()}`, verdict.why); return; }
    }
    if (touched.number && !passesLuhn(touched.number)) {
      // A warning, never a block. Odd store cards exist, and refusing to store
      // the real number is worse than storing an unusual one.
      toast.warn("That card number looks wrong", "The digits do not add up the way card numbers do. Saving it anyway — check it against the card.");
    }

    setBusy(true);
    const res = await callVault({ action: "save", itemId: item.id, secrets: touched }, { preview });
    setBusy(false);
    if (!res.ok) { toast.error("Nothing was saved", res.error); return; }
    if (res.logWarning) toast.warn("Saved, but not logged", res.logWarning);
    toast.success("Saved", res.sample
      ? "Preview mode — this is held in memory only and disappears when you reload."
      : "Scrambled with the server's key. Nobody can read it out of the database.");
    setValues(Object.fromEntries(fields.map((f) => [f, ""])));
    onClose();
    reload();
  };

  const clear = async () => {
    if (!window.confirm(`Remove everything saved against "${item.label}"? The item stays in the list; the password or number is gone for good.`)) return;
    setBusy(true);
    const res = await callVault({ action: "clear", itemId: item.id }, { preview });
    setBusy(false);
    if (!res.ok) { toast.error("Nothing was cleared", res.error); return; }
    toast.success("Cleared", `"${item.label}" no longer holds a secret.`);
    onClose();
    reload();
  };

  return (
    <Modal
      open onClose={onClose}
      kicker={item.label.toUpperCase()}
      title={hasSecret(item) ? "Change what is stored" : "Store the secret"}
      width={600}
      footer={<>
        {hasSecret(item) && <button className="btn" style={{ color: "var(--danger)", marginRight: "auto" }} onClick={clear} disabled={busy}>Remove what is stored</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}
    >
      <div className="adm-vault-explain">
        {preview ? (
          <>
            <strong>Preview mode.</strong> There are no keys loaded, so nothing here is scrambled and nothing is
            saved — what you type stays in this browser tab until you reload it.
          </>
        ) : (
          <>
            What you type is scrambled on our server with a key that is not in the database. Leave a box empty to
            keep whatever is already stored in it. Bitwarden stays the master copy.
          </>
        )}
      </div>

      {hasSecret(item) && (
        <div className="adm-vault-alreadyhas">
          Already stored: {secretSummary(item).toLowerCase()}.
        </div>
      )}

      {fields.map((f) => (
        <Field key={f} label={SECRET_FIELD_LABELS[f] || f} hint={SECRET_FIELD_HELP[f]}>
          <div className="adm-vault-secretbox">
            {f === "recovery" || f === "body" ? (
              <TextArea value={values[f]} onChange={set(f)} style={{ minHeight: 90 }} placeholder={holdsField(item, f) ? "Leave empty to keep what is stored" : ""} />
            ) : (
              <TextInput
                type={show[f] ? "text" : "password"}
                value={values[f]}
                onChange={set(f)}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={holdsField(item, f) ? "Leave empty to keep what is stored" : ""}
              />
            )}
            {f !== "recovery" && f !== "body" && (
              <button type="button" className="adm-vault-mini" onClick={() => setShow((c) => ({ ...c, [f]: !c[f] }))}>
                {show[f] ? "Hide" : "Show"}
              </button>
            )}
          </div>
          {f === "password" && values.password && (
            <div className={`adm-vault-strength ${passwordStrength(values.password).band}`}>
              {passwordStrength(values.password).label}
            </div>
          )}
          {f === "number" && values.number && (
            <div className="adm-vault-hintline">
              Reads as {cardBrand(values.number) || "an unknown card"}, ending {lastFour(values.number) || "????"}.
              {!passesLuhn(values.number) && " The digits do not add up the way card numbers usually do — worth a second look."}
            </div>
          )}
        </Field>
      ))}

      {fields.includes("password") && (
        <div className="adm-vault-gen">
          <span>Make a strong one:</span>
          <input
            type="range" min="12" max="40" value={genLen}
            onChange={(e) => setGenLen(Number(e.target.value))}
            aria-label="How many characters"
          />
          <span className="mono">{genLen}</span>
          <button type="button" className="btn btn-sm" onClick={generate}>Generate</button>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Who looked                                                          */
/* ------------------------------------------------------------------ */

export function VaultLogModal({ item, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    listVaultReveals(item?.id || null, 100)
      .then((r) => { if (alive) { setRows(r.rows); setError(r.error || null); } })
      .catch((err) => { if (alive) { setRows([]); setError(err?.message || "The log could not be read."); } });
    return () => { alive = false; };
  }, [item?.id]);

  const WORD = { reveal: "opened", copy: "copied", save: "saved", clear: "cleared" };

  return (
    <Modal open onClose={onClose} kicker="THE RECORD" title={item ? `Who opened "${item.label}"` : "Who opened what"} width={680}>
      <p className="adm-vault-explain">
        One line every time somebody opened, saved or cleared a secret. It says WHICH part was opened, never what it
        was. These lines survive the item being deleted, so removing something cannot erase the record of reading it.
      </p>
      {error && <div className="adm-db-warn">{error}</div>}
      {rows === null ? (
        <div style={{ padding: 20, color: "var(--ink-dim)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, color: "var(--ink-dim)" }}>Nobody has opened this yet.</div>
      ) : (
        <div className="adm-vault-log">
          {rows.map((r) => (
            <div key={r.id} className="adm-vault-logrow">
              <span className="adm-vault-logwhen">{whenText(r.created_at)}</span>
              <span className="adm-vault-logwho">{r.actor_email || "someone"}</span>
              <span className="adm-vault-logwhat">
                {WORD[r.action] || r.action}
                {r.fields?.length ? ` — ${r.fields.map((f) => (SECRET_FIELD_LABELS[f] || f).toLowerCase()).join(", ")}` : ""}
              </span>
              {!item && <span className="adm-vault-logitem">{r.item_label}</span>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* THE CLIENT-PAGE PANEL                                               */
/* ------------------------------------------------------------------ */
/* Same card, same buttons, scoped to one client. The page that shows it owns
 * the one copy of the list and hands it down — two components fetching the same
 * rows is two answers to one question. */

export function VaultPanel({ client, vault }) {
  const { rows, loading, error, sample, reload } = vault;
  const [modal, setModal] = useState(null);
  const [secretFor, setSecretFor] = useState(null);
  const [logFor, setLogFor] = useState(null);

  const remove = async (item) => {
    if (!window.confirm(
      `Remove "${item.label}" from the vault?\n\nWhat is stored against it is deleted for good. The account itself is untouched — this only removes our copy. The record — that it existed, who opened it, and that it was deleted — stays.`
    )) return;
    const res = await removeVaultItem(item);
    if (!res.ok) { toast.error("Could not remove it", res.error); return; }
    toast.success("Removed", item.label);
    reload();
  };

  const withSecret = rows.filter(hasSecret).length;

  return (
    <>
      <div className="card adm-cp-sitesbar">
        <div style={{ minWidth: 0 }}>
          <div className="label" style={{ marginBottom: 4 }}>Vault</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
            {loading ? "Loading…" : rows.length
              ? `${rows.length} saved · ${withSecret} hold a password or number`
              : "Nothing saved yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" onClick={() => setLogFor({ id: null, label: null })}>Who looked</button>
          <button className="btn btn-accent" onClick={() => setModal({})}>Add an item</button>
          <SourceBadge mode={sample ? "sample" : "live"} />
        </div>
      </div>

      {error && <div className="adm-db-warn">The vault could not be read: {error}</div>}

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon="&#128274;"
          title={`Nothing saved for ${client.name}`}
          body="Their website login, their hosting, the card they pay with. The name and username stay on screen; the password is scrambled and only shows when somebody presses Reveal — which is written down."
          action={<button className="btn btn-accent" onClick={() => setModal({})}>Add the first one</button>}
        />
      ) : (
        <div className="adm-vault-grid">
          {rows.map((v) => (
            <VaultCard
              key={v.id} item={v} clientName={client.name} showWho={false}
              onEdit={(row) => setModal(row)}
              onSecret={(row) => setSecretFor(row)}
              onRemove={remove}
              onLog={(row) => setLogFor(row)}
            />
          ))}
        </div>
      )}

      {modal && (
        <VaultItemModal
          key={modal.id || "new"} item={modal.id ? modal : null}
          lockedClientId={client.id} nextSort={rows.length}
          onClose={() => setModal(null)} reload={reload}
        />
      )}
      {secretFor && <VaultSecretModal key={secretFor.id} item={secretFor} onClose={() => setSecretFor(null)} reload={reload} />}
      {logFor && <VaultLogModal item={logFor.id ? logFor : null} onClose={() => setLogFor(null)} />}
    </>
  );
}
