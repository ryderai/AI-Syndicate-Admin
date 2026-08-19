import LogoMark from "../LogoMark.jsx";
import { signOut } from "../../lib/auth.js";
import { isConfigured } from "../../lib/supabase.js";

const Icon = {
  work: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>,
  overview: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  customers: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  leads: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /><circle cx="9" cy="7" r="4" /></svg>,
  operations: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a4 4 0 0 1-4-4V5a2 2 0 0 1 2-2h11" /></svg>,
  inbox: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>,
  tickets: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /><path d="M9 9h6M9 13h4" /></svg>,
  brain: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" /></svg>,
  platform: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>,
  team: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  logout: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>,
};

// [id, label] grouped — the sales role sees only the SALES group.
const SECTIONS = [
  // Work is first and open to every role — it is the page you land on.
  { group: "Yours", roles: ["owner", "admin", "sales"], items: [
    ["work", "Work"],
  ]},
  { group: "Command", roles: ["owner", "admin"], items: [
    ["overview", "Overview"],
    ["customers", "Customers"],
  ]},
  { group: "Sales", roles: ["owner", "admin", "sales"], items: [
    ["leads", "Leads"],
  ]},
  { group: "Delivery", roles: ["owner", "admin"], items: [
    ["operations", "Operations"],
  ]},
  { group: "Comms", roles: ["owner", "admin"], items: [
    ["inbox", "Inbox"],
    ["tickets", "Tickets"],
  ]},
  { group: "Intelligence", roles: ["owner", "admin"], items: [
    ["brain", "AI Brain"],
    ["platform", "Our platform"],
  ]},
  { group: "Workspace", roles: ["owner", "admin"], items: [
    ["team", "Team"],
    ["settings", "Settings"],
  ]},
];

export function sectionsForRole(role) {
  return SECTIONS.filter((g) => g.roles.includes(role));
}

export default function Sidebar({ section, setSection, member, go }) {
  const groups = sectionsForRole(member.role);
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
              INTERNAL · {member.role.toUpperCase()}
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
            {g.items.map(([id, label]) => (
              <button key={id} onClick={() => setSection(id)} className={section === id ? "active" : ""}>
                <span className="dash-nav-icon">{Icon[id]}</span>
                <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
              </button>
            ))}
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
              if (isConfigured()) await signOut();
              go("/signin");
            }}
            title="Sign out"
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
