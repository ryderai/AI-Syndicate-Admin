import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionHeader, EmptyState, SourceBadge, FilterTabs, useHealth } from "./shared.jsx";
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
 * Aug 26 2026 — Ryder asked for a row of tabs above those blocks. He was
 * scrolling past everybody else's block to reach one client. The tabs pick one
 * group; the search and the kind buttons still narrow whatever the tab shows.
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
  /* Did the client list actually come back? A read that failed hands us
   * { rows: [], error }, which looks exactly like "nobody is on the books".
   * Without this flag every client tab claimed its client had been deleted when
   * the truth was that we could not read the roster at all. Aug 26 2026. */
  const [clientsRead, setClientsRead] = useState(false);
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
    listClients()
      .then((r) => {
        if (!alive) return;
        setClients(r.rows || []);
        /* Only a read with no error tells us who is on the books. */
        if (!r.error) setClientsRead(true);
      })
      .catch(() => { /* leave clientsRead false — we still do not know. */ });
    return () => { alive = false; };
  }, []);

  const clientNameById = useMemo(
    () => Object.fromEntries(clients.map((c) => [c.id, c.name])),
    [clients]
  );

  /* What to call a group when its client id is not in the roster. Saying "no
   * longer in the list" is a claim about the roster, so we may only make it
   * once we have read the roster. Before that — the first paint, or a read that
   * failed — "A client" is all we honestly know, and it is true either way.
   * Aug 26 2026. */
  const nameForClient = useCallback(
    (id) => clientNameById[id]
      || (clientsRead ? "A client that is no longer in the list" : "A client"),
    [clientNameById, clientsRead]
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
      .map(([id, rows]) => ({ id, name: nameForClient(id), rows }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...(ours.length ? [{ id: "ours", name: "Ours — AI Syndicate", rows: ours }] : []),
      ...clientGroups,
    ];
  }, [filtered, nameForClient]);

  /* The tabs above the groups. Two rules keep them from misbehaving:
   *
   * 1. The list of tabs and their counts are worked out BEFORE the search and
   *    the kind buttons are applied. So a count never changes when you press
   *    the tab it is on, and the tab you have selected cannot disappear from
   *    under your finger while you type in the search box.
   * 2. A group with nothing in it gets no tab. A tab you can press that leads
   *    to an empty screen is worse than no tab at all.
   * 3. ONE exception to rule 2: the group you have selected keeps its tab even
   *    when its count falls to 0, and shows that 0. Aug 26 2026.
   *    Why: `who` is the filter on the list below, and it is its own piece of
   *    state. Tick "Show retired items", pick a client whose only items are
   *    retired, untick it again — that client's count is now 0. If its tab
   *    left the row, no tab would look pressed while the list below was still
   *    showing only that client. The row and the list would be telling you two
   *    different things. Same story when the last item in a group is deleted.
   *    The other way to fix it is to snap `who` back to Everybody, but that
   *    moves the user's choice for them and they have to notice it happened.
   *    Keeping the tab with a 0 on it explains itself: you can see the group
   *    is empty, and Everybody is one press away.
   *
   * The "Show retired items" tick is the one filter the counts do follow: it
   * changes what the vault holds rather than searching what it holds, so the
   * numbers here should agree with it. */
  const groupTabs = useMemo(() => {
    const base = showRetired ? vault.rows : vault.rows.filter((r) => r.active !== false);
    const oursN = base.filter((r) => !r.client_id).length;
    const byClient = new Map();
    for (const r of base) {
      if (!r.client_id) continue;
      byClient.set(r.client_id, (byClient.get(r.client_id) || 0) + 1);
    }
    // Rule 3: hold the selected group's tab open at a count of 0.
    if (who !== "all" && who !== "ours" && !byClient.has(who)) byClient.set(who, 0);
    const clientTabs = [...byClient.entries()]
      .map(([id, count]) => ({ id, label: nameForClient(id), count }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [
      ...(oursN || who === "ours" ? [{ id: "ours", label: "Ours", count: oursN }] : []),
      ...clientTabs,
    ];
  }, [vault.rows, showRetired, nameForClient, who]);

  /* "Everybody" counts every item behind the tabs, so the row adds up. */
  const tabTotal = groupTabs.reduce((n, t) => n + t.count, 0);

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

  /* What the page says when it comes up blank. A tab and a search can empty the
   * screen between them, so the words have to name the tab that is selected —
   * a blank vault page with no explanation on it reads as "the vault is
   * broken" rather than "nothing matched". Aug 26 2026, Ryder's ask. */
  const narrowed = Boolean(q) || kind !== "all" || who !== "all";
  const selectedTab = who === "all" ? null : groupTabs.find((t) => t.id === who);
  let emptyBody;
  if (!narrowed) {
    emptyBody = "Start with the logins you look up most: the domain registrar, the hosting, the card the subscriptions are on. The name and username stay readable; the password is scrambled and only shows when somebody presses Reveal.";
  } else if (selectedTab && selectedTab.count === 0) {
    /* The tab is still in the row — rule 3 on groupTabs — but there is nothing
     * behind it any more: the last item was deleted, or the retired tick hid
     * it. Nothing to do with the search, so do not blame the search. */
    emptyBody = `${selectedTab.label} has nothing left in it. Press Everybody to see the rest of the vault.`;
  } else if (selectedTab) {
    emptyBody = `${selectedTab.label} is the tab you have selected. It holds ${selectedTab.count} ${selectedTab.count === 1 ? "item" : "items"}, and none of them match the search or the kind you asked for. Clear those, or press Everybody to look across every group.`;
  } else {
    emptyBody = "Clear the search or the filters to see everything.";
  }

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
        <label className="adm-inbox-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired items
        </label>
      </div>

      {/* ---- pick one group ---- */}
      {/* Nothing to pick between when the vault is empty, so the row stays away
        * rather than showing a lone "Everybody 0". */}
      {groupTabs.length > 0 && (
        <FilterTabs
          tabs={groupTabs}
          value={who}
          onChange={setWho}
          ariaLabel="Vault groups"
          allId="all"
          allLabel="Everybody"
          allCount={tabTotal}
        />
      )}

      {/* ---- the list ---- */}
      {vault.loading ? (
        <div style={{ padding: 30, color: "var(--ink-dim)" }}>Loading…</div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon="&#128274;"
          title={narrowed ? "Nothing matches that" : "The vault is empty"}
          body={emptyBody}
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
