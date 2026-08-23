import { useEffect, useMemo, useState } from "react";
import { SectionHeader, EmptyState, SourceBadge, useHealth } from "./shared.jsx";
import { toast } from "../../lib/toast.js";
import { isConfigured } from "../../lib/supabase.js";
import { listClients } from "../../lib/data.js";
import { useScreenContext } from "../../lib/screenContext.js";
import {
  useVaultItems, VaultCard, VaultItemModal, VaultSecretModal, VaultLogModal, removeVaultItem,
} from "./vaultParts.jsx";
import {
  VAULT_KINDS, VAULT_KIND_LABELS, searchVaultItems, hasSecret, sortVaultItems,
  cardExpired, cardExpiringSoon,
} from "../../../lib/vault.js";

/* THE VAULT PAGE — every password, card and key in one place, Aug 21 2026.
 *
 * Grouped by whose it is: ours first, then one block per client. That is the
 * question people actually arrive with ("what do we have for Shiner?"), and it
 * is the same order the platform login cards use.
 *
 * Sales cannot open this page. That is enforced three times over, and all three
 * matter: the sidebar does not list it (Sidebar.jsx), the dashboard will not
 * route to it (AdminDashboard.jsx reads pageIdsForRole), the database refuses
 * the rows (migration 0008), and the server refuses the reveal
 * (/api/vault-secret). Hiding a button is not a permission.
 */

function nowYm() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export default function VaultPage() {
  const vault = useVaultItems(null);
  const [clients, setClients] = useState([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [who, setWho] = useState("all");        // all | ours | <client id>
  const [showRetired, setShowRetired] = useState(false);
  const [modal, setModal] = useState(null);
  const [secretFor, setSecretFor] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const health = useHealth();
  const preview = !isConfigured();

  useEffect(() => {
    let alive = true;
    listClients().then((r) => { if (alive) setClients(r.rows || []); });
    return () => { alive = false; };
  }, []);

  const clientNameById = useMemo(
    () => Object.fromEntries(clients.map((c) => [c.id, c.name])),
    [clients]
  );

  const filtered = useMemo(() => {
    let rows = vault.rows;
    if (!showRetired) rows = rows.filter((r) => r.active !== false);
    if (kind !== "all") rows = rows.filter((r) => r.kind === kind);
    if (who === "ours") rows = rows.filter((r) => !r.client_id);
    else if (who !== "all") rows = rows.filter((r) => r.client_id === who);
    return sortVaultItems(searchVaultItems(rows, q, clientNameById));
  }, [vault.rows, q, kind, who, showRetired, clientNameById]);

  /* Ours first, then each client that actually has something, in name order.
   * A client with nothing in the vault does not get an empty heading — an empty
   * heading reads as "checked, nothing needed" rather than "never filled in". */
  const groups = useMemo(() => {
    const ours = filtered.filter((r) => !r.client_id);
    const byClient = new Map();
    for (const r of filtered) {
      if (!r.client_id) continue;
      if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
      byClient.get(r.client_id).push(r);
    }
    const clientGroups = [...byClient.entries()]
      .map(([id, rows]) => ({ id, name: clientNameById[id] || "A client that is no longer in the list", rows }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...(ours.length ? [{ id: "ours", name: "Ours — AI Syndicate", rows: ours }] : []),
      ...clientGroups,
    ];
  }, [filtered, clientNameById]);

  const ym = nowYm();
  const stats = useMemo(() => {
    const live = vault.rows.filter((r) => r.active !== false);
    return {
      total: live.length,
      withSecret: live.filter(hasSecret).length,
      cards: live.filter((r) => r.kind === "card").length,
      expired: live.filter((r) => r.kind === "card" && cardExpired(r.card_exp_month, r.card_exp_year, ym)).length,
      expiring: live.filter((r) => r.kind === "card" && cardExpiringSoon(r.card_exp_month, r.card_exp_year, ym)).length,
      retired: vault.rows.length - live.length,
    };
  }, [vault.rows, ym]);

  /* What the assistant is allowed to know about this screen: the page, and how
   * many items are in front of the person. No labels, no usernames, no clients
   * — see the note at the top of src/lib/screenContext.js about why a page
   * STATES its context rather than the assistant scraping it. The vault is
   * exactly the page that rule was written for. */
  useScreenContext(
    () => ({
      page: "Vault",
      label: "Passwords, cards and keys",
      visible: [`${filtered.length} items shown`, `${stats.withSecret} hold a stored secret`],
    }),
    [filtered.length, stats.withSecret]
  );

  const remove = async (item) => {
    if (!window.confirm(
      `Remove "${item.label}" from the vault?\n\nWhat is stored against it is deleted for good. The account itself is untouched — this only removes our copy. The record — that it existed, who opened it, and that it was deleted — stays.`
    )) return;
    const res = await removeVaultItem(item);
    if (!res.ok) { toast.error("Could not remove it", res.error); return; }
    toast.success("Removed", item.label);
    vault.reload();
  };

  /* The one thing that stops the page working: no VAULT_KEY on the server. Say
   * it at the top, with the exact command, rather than letting the first press
   * of Reveal fail with something that reads like a bug.
   *
   * `health.error` is a separate case and is NOT silence: when /api/health
   * itself failed, this page cannot know whether the key is set, so it says
   * that instead of showing a clean page over a vault that will refuse the
   * first press. */
  const keyMissing = health && !health.preview && health.vault === false;
  const keyUnknown = health && !health.preview && Boolean(health.error);

  return (
    <div>
      <SectionHeader
        kicker="WORKSPACE"
        title="Vault"
        subtitle="Every login, card and key we hold — ours and each client's — in one list."
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setLogFor({ id: null })}>Who looked</button>
            <button className="btn btn-accent" onClick={() => setModal({})}>Add an item</button>
            <SourceBadge mode={vault.sample ? "sample" : "live"} />
          </div>
        }
      />

      {preview && (
        <div className="adm-db-warn" style={{ marginBottom: 14 }}>
          <strong>Preview mode — nothing here is real and nothing is scrambled.</strong> There are no Supabase keys
          loaded, so these are sample items held in this browser tab. They disappear when you reload. Do not type a
          real password into this.
        </div>
      )}

      {keyMissing && (
        <div className="adm-db-warn" style={{ marginBottom: 14 }}>
          <strong>The vault cannot scramble anything yet.</strong> The server has no VAULT_KEY set, so Reveal and Save
          will both refuse. To fix it: 1. run <code>openssl rand -base64 32</code> in a terminal. 2. Copy the whole
          line. 3. In Vercel, open the project → Settings → Environment Variables → Add New. 4. Name it{" "}
          <code>VAULT_KEY</code>, paste the line as the value, tick all three environments, press Save. 5. Redeploy.
          Keep that line in Bitwarden — if it is lost, everything already stored can never be read again.
        </div>
      )}

      {keyUnknown && (
        <div className="adm-db-warn" style={{ marginBottom: 14 }}>
          <strong>This page could not check whether the vault is armed.</strong> The server did not answer
          ({health.error}). Everything below still lists correctly, but Reveal may refuse until that is working.
        </div>
      )}

      {vault.error && <div className="adm-db-warn">The vault could not be read: {vault.error}</div>}

      {/* ---- the numbers across the top ---- */}
      <div className="adm-vault-stats">
        <StatCell n={stats.total} label="items" />
        <StatCell n={stats.withSecret} label="hold a password or number" />
        <StatCell n={stats.cards} label="cards" />
        {stats.expired > 0 && <StatCell n={stats.expired} label="cards expired" bad />}
        {stats.expiring > 0 && <StatCell n={stats.expiring} label="cards expiring soon" warn />}
        {stats.retired > 0 && <StatCell n={stats.retired} label="retired" />}
      </div>

      {/* ---- search and filters ---- */}
      <div className="card adm-vault-bar">
        <input
          className="adm-vault-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search names, usernames, clients, tags…"
          aria-label="Search the vault"
        />
        <div className="adm-vault-filters">
          <FilterBtn on={kind === "all"} onClick={() => setKind("all")}>All kinds</FilterBtn>
          {VAULT_KINDS.map((k) => (
            <FilterBtn key={k} on={kind === k} onClick={() => setKind(k)}>{VAULT_KIND_LABELS[k]}</FilterBtn>
          ))}
        </div>
        <div className="adm-vault-filters">
          <FilterBtn on={who === "all"} onClick={() => setWho("all")}>Everyone</FilterBtn>
          <FilterBtn on={who === "ours"} onClick={() => setWho("ours")}>Ours</FilterBtn>
          {clients.map((c) => (
            <FilterBtn key={c.id} on={who === c.id} onClick={() => setWho(c.id)}>{c.name}</FilterBtn>
          ))}
        </div>
        <label className="adm-inbox-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired items
        </label>
      </div>

      {/* ---- the list ---- */}
      {vault.loading ? (
        <div style={{ padding: 30, color: "var(--ink-dim)" }}>Loading…</div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon="&#128274;"
          title={q || kind !== "all" || who !== "all" ? "Nothing matches that" : "The vault is empty"}
          body={q || kind !== "all" || who !== "all"
            ? "Clear the search or the filters to see everything."
            : "Start with the logins you look up most: the domain registrar, the hosting, the card the subscriptions are on. The name and username stay readable; the password is scrambled and only shows when somebody presses Reveal."}
          action={<button className="btn btn-accent" onClick={() => setModal({})}>Add the first one</button>}
        />
      ) : (
        groups.map((g) => (
          <div key={g.id} style={{ marginBottom: 22 }}>
            <div className="adm-vault-grouphead">
              <span>{g.name}</span>
              <span className="adm-vault-groupn">{g.rows.length}</span>
            </div>
            <div className="adm-vault-grid">
              {g.rows.map((v) => (
                <VaultCard
                  key={v.id} item={v}
                  clientName={clientNameById[v.client_id]}
                  onEdit={(row) => setModal(row)}
                  onSecret={(row) => setSecretFor(row)}
                  onRemove={remove}
                  onLog={(row) => setLogFor(row)}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {modal && (
        <VaultItemModal
          key={modal.id || "new"} item={modal.id ? modal : null}
          clients={clients} nextSort={vault.rows.length}
          onClose={() => setModal(null)} reload={vault.reload}
        />
      )}
      {secretFor && <VaultSecretModal key={secretFor.id} item={secretFor} onClose={() => setSecretFor(null)} reload={vault.reload} />}
      {logFor && <VaultLogModal item={logFor.id ? logFor : null} onClose={() => setLogFor(null)} />}
    </div>
  );
}

function StatCell({ n, label, bad, warn }) {
  return (
    <div className={`adm-vault-stat${bad ? " bad" : ""}${warn ? " warn" : ""}`}>
      <span className="adm-vault-statn">{n}</span>
      <span className="adm-vault-statl">{label}</span>
    </div>
  );
}

function FilterBtn({ on, onClick, children }) {
  return (
    <button type="button" className={`adm-vault-filter${on ? " on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}
