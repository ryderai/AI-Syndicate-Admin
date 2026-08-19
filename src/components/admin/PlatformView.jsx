import { useEffect, useState } from "react";
import { Explainer, SectionHeader, SourceBadge, EmptyState, useHealth } from "./shared.jsx";
import { toast } from "../../lib/toast.js";
import { listClients, deletePlatformAccount } from "../../lib/data.js";
import {
  PLATFORM_BASE, PlatformAccountCard, PlatformAccountModal,
  usePlatformAccounts, signInToAccount,
} from "./platformAccounts.jsx";
import { isConfigured } from "../../lib/supabase.js";

/* Our platform — every account we hold on the customer product, one card each.
 *
 * Rewritten Aug 18 2026 (was a single button for our own account). One card per
 * login: ours first, then one per client. Press the button on a card and that
 * account opens in a new tab, already signed in — the console asks the server
 * for a one-time Supabase sign-in link for the saved address. No password is
 * typed and none is stored.
 *
 * The same card component is on each client's own page, so there is one copy of
 * the button, not two. See platformAccounts.jsx.
 *
 * The console still can't remove the platform's plan limits (those live in
 * Andrew's backend), so that part stays honest about the one flag needed.
 */

const MODULES = [
  { group: "Foundation", items: [
    ["AI access", "The core GEO audit — files, crawlers, structured data.", "run audits"],
    ["SEO access", "Same audit, Google's rubric — titles, speed, index health.", "run audits"],
    ["Security", "Passive hygiene scan — leaked keys, headers, cookies.", "run scans"],
    ["Brand intel", "Does the account own its own name across AI engines?", "run scans"],
    ["Reputation", "Reviews + how AI talks about them.", "check tone"],
    ["Local", "Google listing and map presence.", "check listing"],
    ["Authority", "Backlinks, experts, credentials.", "run scan"],
    ["Hallucination watch", "What AI gets wrong about them.", "run checks"],
  ]},
  { group: "Measurement", items: [
    ["Prompt simulator", "Ask any prompt across 10+ engines, see who gets cited.", "test prompts"],
    ["Citation tracker", "Measured citations per tracked prompt over time.", "track prompts"],
    ["Competitors", "Share of voice against named rivals.", "watch rivals"],
    ["Search console", "Real Google Search Console data fused with AI visibility.", "read queries"],
  ]},
  { group: "Shipping", items: [
    ["To-do list", "Every fix from every scan, ranked by impact.", "work the list"],
    ["Content", "Caite writes the missing pages.", "draft content"],
    ["Markup studio", "Schema (hidden code that tells search engines facts) per page.", "ship schema"],
    ["Reports", "White-label exec PDFs.", "export proof"],
  ]},
];

export default function PlatformView() {
  const health = useHealth();
  const { rows, loading, error, reload } = usePlatformAccounts();
  const [clients, setClients] = useState([]);
  const [modal, setModal] = useState(null); // {} = new, row = edit
  const [envBusy, setEnvBusy] = useState(false);

  useEffect(() => { listClients().then((r) => setClients(r.rows || [])); }, []);

  const preview = !isConfigured();
  const clientName = (id) => clients.find((c) => c.id === id)?.name || null;

  const loadingHealth = !health;
  // health.error means /api/health didn't answer, and getHealth's fallback
  // guesses supabase:true — so treat any error as "can't promise it works".
  const canSso = Boolean(health && !health.preview && !health.error && health.platformSso);
  const mode = loadingHealth ? "waiting" : health.preview ? "sample" : canSso ? "live" : "waiting";
  const badgeHint = loadingHealth
    ? "Checking what's wired up…"
    : mode === "live"
    ? "A click mints a real one-time Supabase sign-in link for that account"
    : mode === "sample"
    ? "Preview mode — the buttons open the platform, but can't sign you in"
    : "Wired and waiting on the Supabase server key";

  const ours = rows.filter((a) => !a.client_id);
  const theirs = rows.filter((a) => a.client_id);
  const offCount = rows.filter((a) => a.active === false).length;
  /* Preview mode has no real roles and nothing is really saved, so the whole
   * page stays usable there. Live, the button only shows for owners, because
   * the database only lets owners delete. */
  const isOwner = Boolean(health?.preview) || health?.role === "owner";

  /* Removing a row is owners-only in the database. Handing an admin a button
   * that quietly deletes nothing is worse than not showing it. */
  const remove = !isOwner ? null : async (account) => {
    if (!window.confirm(`Remove the "${account.label}" login card? The account on the platform is untouched — this only removes the shortcut from this page.`)) return;
    const res = await deletePlatformAccount(account.id);
    if (!res.ok) { toast.error("Could not remove it", res.error); return; }
    toast.success("Removed", account.label);
    reload();
  };

  /* The old way in: one account set in the environment (PLATFORM_ACCOUNT_EMAIL).
   * Kept so nothing that worked yesterday stops working, but the cards are the
   * way to do this now. */
  const signInWithEnvAccount = async () => {
    if (envBusy) return;
    setEnvBusy(true);
    await signInToAccount({ label: "the account set in the environment" }, { preview });
    setEnvBusy(false);
  };

  return (
    <>
      <Explainer
        icon="🛰"
        kicker="EAT OUR OWN COOKING"
        title="Every platform account, one click away"
        body="One card per login we hold on the platform — ours, and one for each client whose workspace we work in. Press the button on a card and that account opens in a new tab, already signed in. No password is typed, and none is kept here."
      />

      <div className="card adm-cp-sitesbar">
        <div style={{ minWidth: 0 }}>
          <div className="label" style={{ marginBottom: 4 }}>Accounts</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
            {loading
              ? "Loading…"
              : `${rows.length} saved · ${ours.length} ${ours.length === 1 ? "is ours" : "are ours"} · ${theirs.length} client ${theirs.length === 1 ? "account" : "accounts"}${offCount ? ` · ${offCount} switched off` : ""}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {health?.platformAccountSet && (
            <button className="btn" onClick={signInWithEnvAccount} disabled={envBusy} title="Signs in with the single account set in the environment (PLATFORM_ACCOUNT_EMAIL). The cards below are the way to do this now.">
              {envBusy ? "Signing you in…" : "Use the environment account"}
            </button>
          )}
          <button className="btn btn-accent" onClick={() => setModal({})}>Add an account</button>
          <SourceBadge mode={mode} hint={badgeHint} />
        </div>
      </div>

      {error && <div className="adm-db-warn">Could not read the saved accounts: {error}</div>}

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon="&#128273;"
          title="No platform accounts saved yet"
          body="Start with ours, then add one per client. Each card holds the login email — never a password — and the button on it opens that workspace already signed in."
          action={<button className="btn btn-accent" onClick={() => setModal({})}>Add the first account</button>}
        />
      ) : (
        <>
          {ours.length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 10 }}>Ours</div>
              <div className="adm-pa-grid" style={{ marginBottom: 20 }}>
                {ours.map((a) => (
                  <PlatformAccountCard
                    key={a.id} account={a} clientName={null}
                    onEdit={setModal} onRemove={remove} reload={reload}
                  />
                ))}
              </div>
            </>
          )}

          {theirs.length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 10 }}>Client accounts</div>
              <div className="adm-pa-grid" style={{ marginBottom: 20 }}>
                {theirs.map((a) => (
                  <PlatformAccountCard
                    key={a.id} account={a} clientName={clientName(a.client_id)}
                    onEdit={setModal} onRemove={remove} reload={reload}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className="adm-pa-notecols">
        <div className="card" style={{ padding: 20 }}>
          <div className="label" style={{ marginBottom: 8 }}>Read this before you press a button</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
            <li>The link is a real login for that account. Anything you do in that tab is done <strong>as them</strong>, and their records will show it that way.</li>
            <li>Signing in here replaces whatever platform account that browser was already using. Two accounts at once needs two browser profiles, or one in a private window.</li>
            <li>Only owners and admins can press it. That is checked on the server, not just hidden on this page.</li>
            <li>The server will only sign in to an address that is already on a card, or to the one address set in the server environment. It never takes an email from this page.</li>
            <li>Adding a card is an owner or admin action and the console writes down who did it. Removing a card is owners only — switching one off is the everyday way to retire it, and anyone here can do that.</li>
            <li>The button makes the sign-in link and sends a tab to it. Whether the platform accepts it happens over there, so a card saying LAST SIGN-IN LINK MADE means a link was made, not that someone got in.</li>
            <li>Passwords are never stored here. The Bitwarden button on a card opens the vault; you type it yourself.</li>
          </ul>
        </div>

        <div className="card" style={{ padding: 20, border: "1px solid #fde68a", background: "#fffbeb" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "#92400e" }}>
            BLOCKED UNTIL THIS EXISTS
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 8 }}>
            "No limits" needs one flag in the platform's backend
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginTop: 8 }}>
            Plan limits (scan counts, locked modules) are enforced inside the platform itself,
            so this console can't switch them off from the outside. The clean fix is an
            <strong> internal plan tier</strong> in the platform: one workspace flag that lifts every
            gate for our own accounts. Until that exists, each account runs on whatever plan
            it is on today.
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.55, marginTop: 8 }}>
            Exact ask, ready to send: "Add an <code style={{ fontFamily: "var(--mono)" }}>internal</code> plan_id
            to the workspaces table that passes every hasFeature() check and skips scan quotas, and set
            our workspace to it."
          </p>
        </div>
      </div>

      <SectionHeader
        kicker="Modules"
        title="What you can do once you're in"
        subtitle="Sign in on a card first. After that the platform remembers you in this browser, and each card below opens it in a new tab — the sidebar there takes you the rest of the way."
      />

      {MODULES.map((g) => (
        <div key={g.group} style={{ marginBottom: 4 }}>
          <div className="label" style={{ marginBottom: 10 }}>{g.group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, marginBottom: 18 }}>
            {g.items.map(([name, blurb, verb]) => (
              <a
                key={name}
                className="card"
                style={{ padding: 16, textDecoration: "none", display: "block" }}
                href={PLATFORM_BASE}
                target="_blank"
                rel="noopener noreferrer"
                title={`Opens the platform — go to "${name}" in its sidebar`}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{name}</span>
                  <span style={{ color: "var(--accent-deep)", fontSize: 13 }}>↗</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5, marginTop: 4 }}>{blurb}</div>
                <div style={{ fontSize: 10, fontFamily: "var(--mono)", fontWeight: 700, letterSpacing: "0.08em", color: "var(--accent-deep)", marginTop: 8 }}>{verb.toUpperCase()}</div>
              </a>
            ))}
          </div>
        </div>
      ))}

      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>Field notes (learned the hard way)</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
          <li>The sign-in link is one-time and short-lived. Press the button again for a fresh one — don't copy the URL anywhere.</li>
          <li>If an account has two-factor turned on, the tab stops at the platform's sign-in screen for the code. The link still worked.</li>
          <li>Use <strong>aisyndicate.com</strong>, not www. The www host is a separate address with no session and dumps you at sign-in.</li>
          <li>Live scans (confusion, sentiment, authority, security, hallucination) burn a scan credit on that account — run them on purpose, not out of curiosity.</li>
          <li>Scores cache. Before quoting a number, re-run the audit and read its MEASURED timestamp.</li>
          <li>Switching YOUR SITE switches it for that whole workspace and it sticks — note what it was on, and switch it back.</li>
        </ul>
      </div>

      {modal && (
        <PlatformAccountModal
          key={modal.id || "new"}
          account={modal.id ? modal : null}
          clients={clients}
          nextSort={rows.length}
          onClose={() => setModal(null)}
          reload={reload}
        />
      )}
    </>
  );
}
