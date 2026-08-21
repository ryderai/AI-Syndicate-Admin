import { useEffect } from "react";
import { useAuth } from "../lib/auth.js";
import { useRoute, stampRoute } from "../lib/router.js";
import { isConfigured, signInDisabled } from "../lib/supabase.js";
import Sidebar, { pageIdsForRole } from "./admin/Sidebar.jsx";
import Header from "./admin/Header.jsx";
import { Toaster } from "./admin/shared.jsx";
import Overview from "./admin/Overview.jsx";
import Finance from "./admin/Finance.jsx";
import Invoices from "./admin/Invoices.jsx";
import Customers from "./admin/Customers.jsx";
import LeadsPage from "./admin/LeadsPage.jsx";
import Operations from "./admin/Operations.jsx";
import Inbox from "./admin/Inbox.jsx";
import Tickets from "./admin/Tickets.jsx";
import Brain from "./admin/Brain.jsx";
import NotesPage from "./admin/NotesPage.jsx";
import Assistant from "./admin/Assistant.jsx";
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

  /* Child pages count too — Finance drops down to Invoices, and a page id that
   * is not in this list behaves exactly like a page that does not exist. */
  const allowedIds = pageIdsForRole(member.role);

  /* ---------------------------------------------------------------- */
  /* Which page you are on lives in the ADDRESS, not in memory.        */
  /*                                                                   */
  /* Before Aug 19 2026 the page was plain React state, so every        */
  /* reload threw you back to the landing page — you lost your place    */
  /* any time the tab refreshed or Vercel shipped a new build. Now the  */
  /* address says `#/dashboard/leads`, so a reload restarts the page    */
  /* you were already on. Two consequences worth knowing:               */
  /*   · the address bar is now shareable — send someone a page.        */
  /*   · Back and Forward walk your pages, which is what people expect. */
  /*                                                                   */
  /* A fresh visit with no page in the address lands on Overview        */
  /* (Ryder, Aug 19 2026). Roles that cannot see Overview — sales —     */
  /* land on the first page their role does have, which is Work.        */
  /* ---------------------------------------------------------------- */
  const LANDING = "overview";
  const [route, goRoute] = useRoute();
  // "#/dashboard/inbox?gmail=connected" → page "inbox", query kept as-is.
  // The query matters: the Gmail sign-in bounces back through it, and
  // dropping it swallowed the "mailbox connected / connecting failed"
  // message. Anything after the page id is left alone too, so a future deep
  // link (a client, a task, a thread) survives.
  const [urlPath, urlQuery = ""] = route.replace(/^\/dashboard\/?/, "").split("?");
  const fromUrl = urlPath.split("/")[0];
  const query = urlQuery ? `?${urlQuery}` : "";
  // `|| "work"` is the last resort: a role nobody has taught this file about
  // would otherwise leave the page id blank, and a blank page id shows one
  // page under another page's title.
  const fallback = allowedIds.includes(LANDING) ? LANDING : (allowedIds[0] || "work");
  const section = allowedIds.includes(fromUrl) ? fromUrl : fallback;
  const setSection = (id) => goRoute(`/dashboard/${allowedIds.includes(id) ? id : fallback}`);

  // Keep the address honest: if it does not already name this page (fresh
  // visit, or an old "#/dashboard" link), write it in place. replaceState, so
  // no junk history entry and no scroll jump. If the address already names the
  // right page, do NOT touch it — that is what protects the query and
  // anything deeper in the path.
  useEffect(() => {
    if (fromUrl !== section) stampRoute(`/dashboard/${section}${query}`);
  }, [section, fromUrl, query]);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = "var(--bg-2)";
    return () => { document.body.style.background = prev; };
  }, []);

  const renderSection = () => {
    switch (section) {
      case "work": return <WorkPage member={member} />;
      case "overview": return <Overview member={member} setSection={setSection} />;
      case "finance": return <Finance member={member} setSection={setSection} />;
      case "invoices": return <Invoices member={member} />;
      case "customers": return <Customers member={member} />;
      case "leads": return <LeadsPage member={member} />;
      case "operations": return <Operations member={member} />;
      case "inbox": return <Inbox member={member} />;
      case "tickets": return <Tickets member={member} />;
      case "notes": return <NotesPage member={member} />;
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
      {/* Mounted here rather than inside a page, so one conversation follows
          you across every page instead of restarting each time you click. */}
      <Assistant member={member} />
      <Toaster />
    </div>
  );
}
