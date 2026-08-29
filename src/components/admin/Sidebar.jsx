import { useState } from "react";
import LogoMark from "../LogoMark.jsx";
import { signOut } from "../../lib/auth.js";
import { isConfigured } from "../../lib/supabase.js";
import { leavePreviewAccount } from "../../lib/previewAccounts.js";

const Icon = {
  work: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>,
  overview: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  finance: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  invoices: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l3-2 2 2 2-2 2 2 3-2V8z" /><line x1="8" y1="9" x2="14" y2="9" /><line x1="8" y1="13" x2="12" y2="13" /></svg>,
  /* A person, not a dollar sign. The page stopped being "everyone who pays"
   * on Aug 24 2026 and became "everyone we deal with", so the money symbol was
   * describing the smaller half of the list. Two figures, because it is a
   * roster rather than one contact. */
  clients: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  /* A target with a tick — claim it, work it, close it. Deliberately not
   * the old "leads" radar: the page is a sales floor now, not a list. */
  sales: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /><circle cx="9" cy="7" r="4" /></svg>,
  /* The rep's two halves of the same page. Rows and a claim, not a radar:
   * Leads is the floor drawn as rows of people, so the icon is rows. My leads
   * is the same rows with a name on them, so it is a person with a tick.
   * Ryder, Aug 26 2026. */
  leads: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="9" y1="6" x2="21" y2="6" /><line x1="9" y1="12" x2="21" y2="12" /><line x1="9" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1.4" /><circle cx="4" cy="12" r="1.4" /><circle cx="4" cy="18" r="1.4" /></svg>,
  /* THE FLOOR — Aug 27 2026. Rows with a target on them: it is the sheet of
   * every lead in the company, and the thing you do on it is take one. `leads`
   * and `mine` below are kept only because Icon is looked up by page id and an
   * old bookmark can still land on one for the instant before AdminDashboard
   * rewrites the address. */
  floor: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="9" y1="6" x2="21" y2="6" /><line x1="9" y1="12" x2="17" y2="12" /><line x1="9" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1.4" /><circle cx="4" cy="12" r="1.4" /><circle cx="4" cy="18" r="1.4" /><circle cx="20" cy="12" r="2.4" /></svg>,
  /* A rep's own mailbox. A plain envelope, so it reads as "your mail" rather
   * than as the shared team inbox an owner has two groups further down. */
  gmail: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><polyline points="3 7 12 13 21 7" /></svg>,
  mine: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="7.5" cy="7" r="4" /><polyline points="16 12 18.5 14.5 23 10" /></svg>,
  operations: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a4 4 0 0 1-4-4V5a2 2 0 0 1 2-2h11" /></svg>,
  inbox: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>,
  tickets: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /><path d="M9 9h6M9 13h4" /></svg>,
  notes: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="15" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>,
  brain: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" /></svg>,
  platform: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>,
  vault: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /><circle cx="12" cy="16" r="1.4" /></svg>,
  team: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  logout: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>,
};

// [id, label] grouped. Each group lists the roles that may see it, so the
// sales role sees Yours + Sales and nothing else.
const SECTIONS = [
  // Overview is first — it is the page an owner or admin lands on (Aug 19 2026).
  /* An item can carry CHILDREN — a third element. Finance is the first one:
   * clicking the arrow next to it drops down Invoices. The children are real
   * pages with their own address, not tabs inside Finance, because invoicing is
   * a job you sit down and do rather than something you glance at. */
  { group: "Command", roles: ["owner", "admin"], items: [
    ["overview", "Overview"],
    ["finance", "Finance", [["invoices", "Invoices"], ["ai-cost", "AI Cost"]]],
    ["clients", "Clients"],
  ]},
  // Work is the owner's and the admin's landing page. It is NOT a rep's any
  // more — see the note below.
  { group: "Yours", roles: ["owner", "admin"], items: [
    ["work", "Work"],
  ]},
  /* A REP'S WHOLE CONSOLE IS FOUR PAGES — Ryder, Aug 27 2026.
   *
   * It was three: Work, Leads (the floor, unclaimed only) and My leads. It is
   * now Overview, The Floor, Gmail and AI Brain, and the two that went away were
   * absorbed rather than deleted:
   *
   *   Work      -> Overview. The ask-anything box moves to the top of its own
   *                page and the rep's own numbers sit under it.
   *   Leads     -> The Floor with the switch on "Available".
   *   My leads  -> The Floor with the switch on "Mine", which is where it opens.
   *
   * That is a SMALLER menu, which is the point: one list of leads with a switch
   * over it beats two pages a rep has to remember the difference between.
   *
   * `overview` and `brain` are the SAME page ids the owner's menu uses, and that
   * is deliberate. AdminDashboard renders a different component for a rep — one
   * set of records, three layouts — so an address like #/dashboard/overview
   * means "your overview" whoever opens it. Giving a rep second ids
   * (`rep-overview`) would have put the role in the URL, and a URL that has to
   * agree with who is signed in is a URL that eventually does not. */
  { group: "Yours", roles: ["sales"], items: [
    ["overview", "Overview"],
    ["floor", "The Floor"],
    ["gmail", "Gmail"],
    ["brain", "AI Brain"],
  ]},
  /* SALES IS TWO DIFFERENT MENUS — Ryder, Aug 26 2026.
   *
   * Owner and admin keep the one Sales page with its four tabs. Nothing here
   * changed for them, and nothing should: this list is the only place their
   * sidebar comes from, so an edit to their entry is an edit to their console.
   *
   * A rep gets the same page ONCE now, as The Floor in their own group above —
   * two ids became one on Aug 27 2026. It is still the same component (SalesPage
   * with a mode); the console spent Aug 25 deleting a second client list that
   * had drifted from the first, so a copied SalesPage has never been on the
   * table.
   *
   * Two entries with the same group name rather than one entry with a
   * role-aware item list: sectionsForRole filters BEFORE anything is drawn, so
   * exactly one of these ever reaches the menu and the group name can never
   * appear twice. */
  { group: "Sales", roles: ["owner", "admin"], items: [
    ["sales", "Sales"],
  ]},
  { group: "Delivery", roles: ["owner", "admin"], items: [
    ["operations", "Operations"],
  ]},
  { group: "Comms", roles: ["owner", "admin"], items: [
    ["inbox", "Inbox"],
    ["tickets", "Tickets"],
  ]},
  { group: "Intelligence", roles: ["owner", "admin"], items: [
    // Notes is first in this group on purpose: it is the page you read, and
    // the Brain is the page you tune. Reading comes before tuning.
    ["notes", "Notes"],
    ["brain", "AI Brain"],
    ["platform", "Our platform"],
  ]},
  { group: "Workspace", roles: ["owner", "admin"], items: [
    /* The Vault is owner/admin only, and it is only in this list for those two
     * roles. That is the FIRST of four gates, not the only one: the dashboard
     * refuses to route to a page a role cannot see, the database refuses the
     * rows (migration 0008), and /api/vault-secret refuses the reveal. A hidden
     * button is not a permission. */
    ["vault", "Vault"],
    ["team", "Team"],
    ["settings", "Settings"],
  ]},
];

export function sectionsForRole(role) {
  return SECTIONS.filter((g) => g.roles.includes(role));
}

/** Every page id a role may open, parents and children alike. A child page that
 * is missing from this list looks exactly like a page that does not exist —
 * the dashboard falls back to the landing page and the click does nothing. */
export function pageIdsForRole(role) {
  return sectionsForRole(role).flatMap((g) =>
    g.items.flatMap(([id, , kids]) => [id, ...(kids || []).map(([kid]) => kid)])
  );
}

/** The parent of a child page, so opening Invoices leaves Finance open too. */
export function parentOf(id) {
  for (const g of SECTIONS) {
    for (const [pid, , kids] of g.items) {
      if ((kids || []).some(([kid]) => kid === id)) return pid;
    }
  }
  return null;
}

export default function Sidebar({ section, setSection, member, go }) {
  const groups = sectionsForRole(member.role);
  /* Which drop-downs the person has opened or closed by hand. Anything not in
   * here follows the page you are on, so landing on Invoices always shows
   * Invoices — you never have to hunt for the page you are already looking at. */
  const [expanded, setExpanded] = useState({});
  const toggle = (id, open) => setExpanded((e) => ({ ...e, [id]: open }));
  const initials = (member.full_name || member.email || "?")
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join("");
  return (
    <aside className="dash-sidebar">
      <div className="dash-sidebar-logo">
        <LogoMark size={28} />
        <span className="logo-wordmark" style={{ fontSize: 16 }}>
          <span className="logo-ai" style={{ color: "#a78bfa" }}>AI</span>
          <span className="logo-syn" style={{ color: "white" }}>&nbsp;SYNDICATE</span>
        </span>
      </div>

      <div className="dash-sidebar-domain">
        <div className="label" style={{ color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>Console</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: "linear-gradient(135deg, #8b5cf6, #3b82f6)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
            ⌘
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Command</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "var(--mono)", letterSpacing: "0.06em" }}>
              INTERNAL · {String(member.role || "no role").toUpperCase()}
            </div>
          </div>
        </div>
      </div>

      <nav className="dash-sidebar-nav">
        {groups.map((g) => (
          <div key={g.group} style={{ marginBottom: 12 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(255,255,255,0.32)", padding: "6px 12px 4px" }}>
              {g.group.toUpperCase()}
            </div>
            {g.items.map(([id, label, kids]) => {
              const childIds = (kids || []).map(([kid]) => kid);
              const open = expanded[id] ?? (section === id || childIds.includes(section));
              return (
                <div key={id}>
                  <button onClick={() => setSection(id)} className={section === id ? "active" : ""}>
                    <span className="dash-nav-icon">{Icon[id]}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
                    {kids && kids.length > 0 && (
                      /* A span, not a nested button: a button inside a button is
                       * invalid HTML and React will not render it reliably. */
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={open ? `Hide the pages under ${label}` : `Show the pages under ${label}`}
                        aria-expanded={open}
                        className={`dash-nav-caret${open ? " open" : ""}`}
                        onClick={(e) => { e.stopPropagation(); toggle(id, !open); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(id, !open); }
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                      </span>
                    )}
                  </button>
                  {kids && open && kids.map(([kid, klabel]) => (
                    <button key={kid} onClick={() => setSection(kid)} className={`dash-nav-child${section === kid ? " active" : ""}`}>
                      <span className="dash-nav-icon">{Icon[kid]}</span>
                      <span style={{ flex: 1, textAlign: "left" }}>{klabel}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="dash-sidebar-user">
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 99, background: "linear-gradient(135deg, var(--accent-2), var(--accent-3))", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
            {initials || "?"}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{member.full_name || "Team member"}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{member.email}</div>
          </div>
          <button
            onClick={async () => {
              if (isConfigured()) {
                await signOut();
                go("/signin");
                return;
              }
              /* PREVIEW MODE. There is no session to end and no /signin screen
               * on this path — sign-in is switched off. Dropping the picked
               * account sends you back to the account picker, which is what
               * "sign out" means here. Aug 26 2026: before this, the button
               * routed to a sign-in page that immediately bounced you back in
               * as the same hard-coded owner, so it looked broken. */
              leavePreviewAccount();
            }}
            title={isConfigured() ? "Sign out" : "Sign out and pick a different account"}
            style={{ background: "none", border: 0, color: "rgba(255,255,255,0.4)", cursor: "pointer", padding: 4, display: "flex" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "white")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.4)")}
          >
            {Icon.logout}
          </button>
        </div>
      </div>
    </aside>
  );
}
