import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.js";
import { isConfigured, signInDisabled } from "../lib/supabase.js";
import Sidebar, { sectionsForRole } from "./admin/Sidebar.jsx";
import Header from "./admin/Header.jsx";
import { Toaster } from "./admin/shared.jsx";
import Overview from "./admin/Overview.jsx";
import Customers from "./admin/Customers.jsx";
import LeadsPage from "./admin/LeadsPage.jsx";
import Operations from "./admin/Operations.jsx";
import Inbox from "./admin/Inbox.jsx";
import Tickets from "./admin/Tickets.jsx";
import Brain from "./admin/Brain.jsx";
import PlatformView from "./admin/PlatformView.jsx";
import WorkPage from "./admin/WorkPage.jsx";
import TeamPage from "./admin/TeamPage.jsx";
import SettingsPage from "./admin/SettingsPage.jsx";

const PREVIEW_MEMBER = {
  user_id: "preview-user",
  email: "preview@aisyndicate.com",
  full_name: "Preview Admin",
  role: "owner",
};

export default function AdminDashboard({ go }) {
  const { user, membership, configured } = useAuth();
  const member = configured
    ? { ...membership, user_id: membership?.user_id || user?.id }
    : PREVIEW_MEMBER;

  const allowedIds = sectionsForRole(member.role).flatMap((g) => g.items.map(([id]) => id));
  // Everyone lands on Work — it is the "what do I do now" page. Change the
  // string here to land somewhere else.
  const [section, setSectionRaw] = useState("work");
  const setSection = (id) => setSectionRaw(allowedIds.includes(id) ? id : allowedIds[0]);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = "var(--bg-2)";
    return () => { document.body.style.background = prev; };
  }, []);

  const renderSection = () => {
    switch (section) {
      case "work": return <WorkPage member={member} />;
      case "overview": return <Overview member={member} setSection={setSection} />;
      case "customers": return <Customers member={member} />;
      case "leads": return <LeadsPage member={member} />;
      case "operations": return <Operations member={member} />;
      case "inbox": return <Inbox member={member} />;
      case "tickets": return <Tickets member={member} />;
      case "brain": return <Brain member={member} />;
      case "platform": return <PlatformView member={member} />;
      case "team": return <TeamPage member={member} />;
      case "settings": return <SettingsPage member={member} setSection={setSection} />;
      default: return <WorkPage member={member} />;
    }
  };

  return (
    <div className="dash">
      <Sidebar section={section} setSection={setSection} member={member} go={go} />
      <main className="dash-main">
        {signInDisabled() && (
          <div
            role="status"
            style={{
              display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              padding: "10px 24px", background: "#fffbeb",
              borderBottom: "1px solid #fde68a", color: "#92400e",
              fontSize: 12.5, lineHeight: 1.5,
            }}
          >
            <strong style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em" }}>
              SIGN-IN IS OFF
            </strong>
            <span>
              Anyone who can open this address can see this console. Everything below is sample
              data — nothing real is saved. Set <code style={{ fontFamily: "var(--mono)" }}>VITE_NO_SIGNIN=false</code> to
              put the login back.
            </span>
          </div>
        )}
        <Header section={section} preview={!isConfigured()} />
        <div className="dash-content">
          {renderSection()}
        </div>
      </main>
      <Toaster />
    </div>
  );
}
