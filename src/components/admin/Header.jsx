import { useState } from "react";
import { SourceBadge } from "./shared.jsx";

const SECTION_TITLES = {
  work: { kicker: "Yours", title: "Work · what's on you right now" },
  overview: { kicker: "Command", title: "Overview · revenue, usage, activity" },
  finance: { kicker: "Command", title: "Finance · in, out, projected" },
  invoices: { kicker: "Command", title: "Invoices · billed, paid, owed" },
  customers: { kicker: "Command", title: "Customers · every paying account" },
  leads: { kicker: "Sales", title: "Leads · the pipeline" },
  operations: { kicker: "Delivery", title: "Operations · clients, tasks & weekly logs" },
  inbox: { kicker: "Comms", title: "Inbox · team Gmail in one place" },
  tickets: { kicker: "Comms", title: "Tickets · customer support desk" },
  notes: { kicker: "Intelligence", title: "Notes · what the system noticed" },
  brain: { kicker: "Intelligence", title: "AI Brain · what the AI knows and how it writes" },
  platform: { kicker: "Intelligence", title: "Our platform · GEO for our own site" },
  team: { kicker: "Workspace", title: "Team · seats & roles" },
  settings: { kicker: "Workspace", title: "Settings · integrations & keys" },
};

/** Pages that fetch live data listen for this event and refetch. */
export function requestRefresh() {
  window.dispatchEvent(new CustomEvent("adm-refresh"));
}

export default function Header({ section, preview }) {
  /* A page that is not in the map above gets its own name, NOT the Overview's.
   * Falling back to Overview showed "Overview · revenue, usage, activity" over
   * the Notes page for its first hour of life — a header that lies about which
   * page you are on is worse than a plain one. Caught by a screenshot, Aug 20 2026. */
  const t = SECTION_TITLES[section] || {
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
