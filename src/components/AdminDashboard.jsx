import { useEffect } from "react";
import { useAuth } from "../lib/auth.js";
import { useRoute, stampRoute } from "../lib/router.js";
import { isConfigured, signInDisabled } from "../lib/supabase.js";
import { usePreviewAccount, previewMember } from "../lib/previewAccounts.js";
import Sidebar, { pageIdsForRole } from "./admin/Sidebar.jsx";
import Header from "./admin/Header.jsx";
import { Toaster } from "./admin/shared.jsx";
import Overview from "./admin/Overview.jsx";
import Finance from "./admin/Finance.jsx";
import Invoices from "./admin/Invoices.jsx";
import ClientsPage from "./admin/Clients.jsx";
import SalesPage from "./admin/SalesPage.jsx";
import Operations from "./admin/Operations.jsx";
import Inbox from "./admin/Inbox.jsx";
import Tickets from "./admin/Tickets.jsx";
import Brain from "./admin/Brain.jsx";
import NotesPage from "./admin/NotesPage.jsx";
import Assistant from "./admin/Assistant.jsx";
import PlatformView from "./admin/PlatformView.jsx";
import WorkPage from "./admin/WorkPage.jsx";
/* THE REP CONSOLE, Aug 27 2026. Three pages became four: Overview, The Floor,
 * Gmail and AI Brain. The Floor is SalesPage with a mode — deliberately not a
 * second copy of it — and Gmail is the Inbox this file already imports. Only
 * these two are new components. */
import RepOverview from "./admin/repOverview.jsx";
import RepBrain from "./admin/repBrain.jsx";
import VaultPage from "./admin/VaultPage.jsx";
import TeamPage from "./admin/TeamPage.jsx";
import SettingsPage from "./admin/SettingsPage.jsx";

/* The old hard-coded PREVIEW_MEMBER is gone. Aug 26 2026: preview mode asks
 * which account you want at the door instead of always making you an owner, so
 * the sales role can be tested for real.
 *
 * There is deliberately NO fallback member. The first version of this used
 * `previewMember(preview) || {}` and called it crash-proofing; a checker showed
 * it was the opposite. A member with no role FAILS OPEN in three places:
 * `sectionsForRole(undefined)` returns no menu but the page still renders,
 * `getMyWork(null)` treats every task in the system as yours, and SalesPage
 * reads `role !== "sales"` and hands out the admin controls. So a missing
 * member renders NOTHING instead. AuthGate never lets that happen anyway — this
 * is the guard for whoever wires up a second caller later. */
export default function AdminDashboard({ go }) {
  const { user, membership, configured } = useAuth();
  const preview = usePreviewAccount();
  /* `{ ...null, user_id: x }` IS A TRUTHY OBJECT, so the `if (!member) return
   * null` guard below could never fire on the live path — the exact defence the
   * comment above this component says exists, silently not existing. A member
   * with no membership row now really is null, and the guard really does stop.
   *
   * Not reachable today: AuthGate.jsx returns NotAuthorized when `membership` is
   * falsy, so nothing gets this far. It is defence-in-depth, and defence-in-depth
   * that cannot fire is worse than none — somebody reads the comment and stops
   * looking. Found by tests/floor-scoping, Aug 27 2026. */
  const member = configured
    ? (membership ? { ...membership, user_id: membership.user_id || user?.id } : null)
    : previewMember(preview);

  /* Child pages count too — Finance drops down to Invoices, and a page id that
   * is not in this list behaves exactly like a page that does not exist. */
  /* `member` can only be null on the impossible path described above, and the
   * guard for it is the early return further down — after every hook, because a
   * hook that runs on one render and not the next breaks React. Until then, keep
   * this null-safe: no member means no allowed pages. */
  const allowedIds = member ? pageIdsForRole(member.role) : [];

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
  /* The page used to be called Leads. Old links, old bookmarks and the
   * browser history of anybody who used it before Aug 21 2026 still say
   * `leads`, and an unknown page id silently falls back to the landing page —
   * so the link would not break loudly, it would just quietly take you
   * somewhere else. Rewrite it instead. */
  /* customers → clients, Aug 24 2026. The page stopped being "everyone who
   * pays Stripe" and became "everyone we deal with", clients included. Old
   * links and everyone's browser history still say `customers`, and an
   * unknown page id falls back to the landing page — so the link would not
   * break loudly, it would quietly take you somewhere else. */
  const RENAMED = { leads: "sales", customers: "clients" };
  /* A SPLIT IS NOT A RENAME. Both sides are live pages; which one you get
   * depends on your job. Aug 26 2026 (Ryder): a rep no longer has the one
   * Sales page, they have two locked halves of it — `leads`, the floor, and
   * `mine`. So a link that says `sales` — CJ pasting one, an old bookmark, a
   * URL typed by hand — has to put a rep on the floor. Without this line it
   * falls through to the landing page, which is the quiet kind of broken link
   * the notes above are about.
   *
   * Read ONLY when the role cannot open the page that was named, so an owner
   * never reaches it and their addresses behave exactly as they did before.
   * That is also what untangles the old `leads` name: the rename above still
   * sends everybody's `#/dashboard/leads` to Sales, and for a rep the split
   * then hands it on to the page a rep actually has, which is called `leads`
   * again. One hop each way, and neither role sees the other's. */
  /* A MAP PER ROLE, not one page id — Aug 27 2026, when the rep console became
   * four pages. Every address a rep could already have bookmarked has to land
   * somewhere true:
   *
   *   #/dashboard/sales   an owner pasted a link, or the RENAMED hop above sent
   *                       an old `leads` here     -> The Floor
   *   #/dashboard/leads   a rep's own bookmark of the old floor page
   *                       (RENAMED rewrites it to `sales` first, and the line
   *                       above then sends it on) -> The Floor
   *   #/dashboard/mine    a rep's bookmark of My leads. The Floor opens on
   *                       "Mine", so this is the same screen -> The Floor
   *   #/dashboard/work     Work is not a rep's page any more -> Overview
   *
   * Without an entry, an unknown page id quietly falls back to the landing page,
   * which is the kind of broken link nobody reports because it does not look
   * broken. Read ONLY when the role cannot open the page that was named, so an
   * owner never reaches this and their addresses behave exactly as before. */
  const SPLIT_FOR_ROLE = {
    sales: { sales: "floor", leads: "floor", mine: "floor", work: "overview" },
  };
  const rawPage = urlPath.split("/")[0];
  const named = RENAMED[rawPage] || rawPage;
  const fromUrl = allowedIds.includes(named)
    ? named
    : ((member && SPLIT_FOR_ROLE[member.role]?.[named]) || named);
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
    /* Compared against the RAW page id, not the renamed one. Comparing the
     * renamed value meant an old `#/dashboard/leads` link rendered Sales
     * correctly but left `leads` in the address bar forever — so a reload, a
     * bookmark or a shared link kept passing the dead name around and the
     * rename never actually finished. Caught by the browser walkthrough. */
    if (rawPage !== section) stampRoute(`/dashboard/${section}${query}`);
  }, [section, rawPage, query]);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = "var(--bg-2)";
    return () => { document.body.style.background = prev; };
  }, []);

  /* No member, nothing rendered. See the note at the top of this component for
   * why an empty member is more dangerous than none. */
  if (!member) return null;

  const renderSection = () => {
    switch (section) {
      case "work": return <WorkPage member={member} />;
      /* ONE PAGE ID, TWO LAYOUTS — Aug 27 2026. An owner's Overview is the whole
       * agency; a rep's is their own book with an ask-anything box on top. Same
       * address either way, because a URL that has to agree with who is signed in
       * is a URL that eventually does not. The same trick is used for `brain`
       * below, and it is the routing half of "one set of records, three
       * layouts". */
      case "overview": return member.role === "sales"
        ? <RepOverview member={member} />
        : <Overview member={member} setSection={setSection} />;
      case "finance": return <Finance member={member} setSection={setSection} />;
      case "invoices": return <Invoices member={member} />;
      /* The query comes through: `?id=` is which client is open, and the
       * Google sign-in bounces back through `?connect=`. Dropping it would
       * swallow both. */
      case "clients": return <ClientsPage member={member} query={query} />;
      case "sales": return <SalesPage member={member} />;
      /* THE SAME COMPONENT, ONE MODE — Aug 27 2026. `mode="floor"` is the rep's
       * whole lead page: every lead in the company, with a three-state switch
       * over it (Mine / Available / All) instead of two separate pages. No mode
       * means the page the owner has always had. A second copy of SalesPage is
       * the one thing this must never become — see the note at the top of
       * SalesPage.jsx.
       *
       * `leads` and `mine` are GONE as page ids. They are not cases here any
       * more because they are not in any role's allowed list, so `section` can
       * never hold one — SPLIT_FOR_ROLE above turns both into `floor` before it
       * gets this far, and rewrites the address so the dead name stops being
       * passed around. */
      case "floor": return <SalesPage member={member} mode="floor" />;
      case "operations": return <Operations member={member} />;
      case "inbox": return <Inbox member={member} />;
      /* A REP'S OWN MAILBOX. Same component, `mine` set: their own address, their
       * own threads, no sharing controls. The lock that matters is not this prop
       * — it is resolveMailbox() in lib/gmail-mailbox.js, which refuses a rep a
       * shared mailbox, and the policy added in migration 0020, which scopes the
       * thread rows to addresses that person connected. This prop only changes
       * the words on the screen. */
      case "gmail": return <Inbox member={member} mine />;
      case "tickets": return <Tickets member={member} />;
      case "notes": return <NotesPage member={member} />;
      /* The COMPANY Brain for an owner or admin; a rep's OWN tone and formatting
       * rules for a rep. They are different tables, not two views of one:
       * admin_brain is admin-only at the database (0001) and api/ai-draft.js
       * refuses to load it for a rep on purpose, so a rep must never be routed
       * to Brain.jsx even by accident. */
      case "brain": return member.role === "sales"
        ? <RepBrain member={member} />
        : <Brain member={member} />;
      case "platform": return <PlatformView member={member} />;
      case "vault": return <VaultPage member={member} />;
      case "team": return <TeamPage member={member} />;
      case "settings": return <SettingsPage member={member} setSection={setSection} />;
      default: return <WorkPage member={member} />;
    }
  };

  return (
    <div className="dash">
      <Sidebar section={section} setSection={setSection} member={member} go={go} />
      <main className="dash-main">
        {/* Aug 26 2026: gated on !isConfigured(), not on the switch alone. Preview
            mode also happens when the Supabase keys are simply missing — a fresh
            clone, or a deploy with no env set — and that state used to get the
            account picker and then a console with no warning on it at all. */}
        {!isConfigured() && (
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
              {signInDisabled() ? "SIGN-IN IS OFF" : "NO KEYS — SAMPLE DATA"}
            </strong>
            <span>
              Anyone who can open this address can see this console. Everything below is sample
              data — nothing real is saved. You are in as{" "}
              <strong>{member.full_name || "nobody"}</strong>{" "}
              ({String(member.role || "no role")}) — use the sign-out arrow at the bottom of the
              sidebar to come back and pick a different account.{" "}
              {signInDisabled()
                ? <>Set <code style={{ fontFamily: "var(--mono)" }}>VITE_NO_SIGNIN=false</code> to put the real login back.</>
                : <>The Supabase keys are not set, which is why there is no login — SETUP.md wires them up.</>}
            </span>
          </div>
        )}
        <Header section={section} role={member.role} preview={!isConfigured()} />
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
