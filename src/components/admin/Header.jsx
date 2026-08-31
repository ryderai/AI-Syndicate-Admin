import { useState } from "react";
import { SourceBadge } from "./shared.jsx";

const SECTION_TITLES = {
  work: { kicker: "Yours", title: "Work · what's on you right now" },
  overview: { kicker: "Command", title: "Overview · your day and the whole agency" },
  finance: { kicker: "Command", title: "Finance · in, out, projected" },
  invoices: { kicker: "Command", title: "Invoices · billed, paid, owed" },
  "ai-cost": { kicker: "Command", title: "AI Cost · what every AI call cost us" },
  "sales-stats": { kicker: "Sales", title: "Stats · how the team is doing" },
  clients: { kicker: "Command", title: "Clients · everyone we work with and everyone who pays" },
  sales: { kicker: "Sales", title: "Sales · the pipeline" },
  /* THE REP'S OWN PAGES — Aug 27 2026. `leads` and `mine` are gone as page ids
   * (AdminDashboard turns both into `floor`), and The Floor and Gmail arrived.
   * Without an entry the fallback capitalises the page id, so the header would
   * read "Floor" and "Gmail" — the first says less than the page does and the
   * second reads like a brand rather than like whose mail it is. */
  /* WAS "The Floor · every lead, claimed or not". That stopped being true on
     30 Aug 2026: a lead somebody else has claimed is not on this page at all.
     A page whose own title states the opposite of its rule is the first thing
     that stops a screen being believed. */
  floor: { kicker: "Sales", title: "The Floor · yours, and everything free to claim" },
  gmail: { kicker: "Comms", title: "Gmail · your own mailbox" },
  operations: { kicker: "Delivery", title: "Operations · the task board" },
  inbox: { kicker: "Comms", title: "Inbox · team Gmail in one place" },
  tickets: { kicker: "Comms", title: "Tickets · customer support desk" },
  notes: { kicker: "Intelligence", title: "Notes · what the system noticed" },
  brain: { kicker: "Intelligence", title: "AI Brain · what the AI knows and how it writes" },
  platform: { kicker: "Intelligence", title: "Our platform · GEO for our own site" },
  vault: { kicker: "Workspace", title: "Vault · passwords, cards & keys" },
  team: { kicker: "Workspace", title: "Team · seats & roles" },
  settings: { kicker: "Workspace", title: "Settings · integrations & keys" },
};

/** Pages that fetch live data listen for this event and refetch. */
export function requestRefresh() {
  window.dispatchEvent(new CustomEvent("adm-refresh"));
}

/* TWO PAGE IDS MEAN DIFFERENT THINGS TO DIFFERENT ROLES — Aug 27 2026.
 *
 * `overview` and `brain` are shared ids on purpose: an owner's Overview is the
 * whole agency and a rep's is their own book, and the address is the same either
 * way (see the note on SPLIT_FOR_ROLE in AdminDashboard.jsx for why the role is
 * deliberately not in the URL). The consequence is that the TITLE cannot be read
 * off the page id alone — a rep landing on "Overview · your day and the whole
 * agency" would be reading a promise their page does not keep.
 *
 * So: an override per role, checked first, and the map above stays the answer for
 * everybody else. A role with no override falls through to it unchanged. */
const ROLE_TITLES = {
  sales: {
    overview: { kicker: "Yours", title: "Overview · your own book, and the AI that reads it" },
    brain: { kicker: "Yours", title: "AI Brain · how the AI writes for you" },
  },
};

export default function Header({ section, role = null, preview }) {
  /* A page that is not in the map above gets its own name, NOT the Overview's.
   * Falling back to Overview showed the Overview title over
   * the Notes page for its first hour of life — a header that lies about which
   * page you are on is worse than a plain one. Caught by a screenshot, Aug 20 2026. */
  const t = (role && ROLE_TITLES[role]?.[section]) || SECTION_TITLES[section] || {
    kicker: "Console",
    title: section ? section.charAt(0).toUpperCase() + section.slice(1) : "Console",
  };
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    setRefreshing(true);
    requestRefresh();
    setTimeout(() => setRefreshing(false), 900);
  };

  return (
    <header className="dash-header">
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span className="live-dot" />
          <span className="label">ADMIN.AISYNDICATE.COM · {t.kicker.toUpperCase()}</span>
          {preview && <SourceBadge mode="sample" hint="Preview mode — Supabase keys not set yet. Everything below is sample data." />}
        </div>
        <h1 style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)" }}>
          {t.title}
        </h1>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <a
          className="btn"
          style={{ padding: "9px 13px", fontSize: 13, textDecoration: "none" }}
          href="https://aisyndicate.com/#/dashboard"
          target="_blank"
          rel="noopener noreferrer"
          title="Open the customer platform in a new tab (use the bare domain — www has no session)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
          Platform
        </a>
        <button onClick={refresh} className="btn" style={{ padding: "9px 13px", fontSize: 13 }} disabled={refreshing} title="Re-pull live data on this page">
          <span style={{ display: "inline-flex", animation: refreshing ? "spin 0.8s linear infinite" : "none" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          </span>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}
