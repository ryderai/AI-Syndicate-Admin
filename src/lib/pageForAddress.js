/* WHICH PAGE DOES THIS ADDRESS MEAN, FOR THIS PERSON?
 *
 * Lifted out of AdminDashboard.jsx on 31 Aug 2026, comments and all, for one
 * reason: it is the rule that decides where the Gmail sign-in drops a sales rep
 * after they connect their own mailbox, and that rule had been wrong with every
 * test in the repo passing — because no test could reach it. It was fifty lines
 * of decisions inside a React component that also needs a browser, a signed-in
 * member and a live Supabase to render.
 *
 * Nothing about the behaviour changed in the move. `tests/page-for-address` is
 * the reason the move happened.
 */

/** A fresh visit with no page in the address (Ryder, Aug 19 2026). Roles that
 * cannot see Overview land on the first page their role does have. */
export const LANDING = "overview";

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
export const RENAMED = { leads: "sales", customers: "clients" };

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
 *   #/dashboard/work    Work is not a rep's page any more -> Overview
 *   #/dashboard/inbox   the Gmail sign-in ALWAYS bounces back here.
 *                       api/gmail-callback.js runs before anything knows who
 *                       is signing in, so it names ONE page for everybody —
 *                       and `inbox` is the shared team inbox, which a rep may
 *                       never open. -> Gmail, the rep's own mailbox.
 *
 *                       Until 31 Aug 2026 this line was missing, so a rep who
 *                       had just connected their mailbox fell through to
 *                       Overview carrying `?gmail=connected` in the address —
 *                       and Overview does not read that parameter. The mailbox
 *                       WAS connected. The screen said nothing at all, and the
 *                       rep's own Gmail page was two clicks away with no reason
 *                       to think of going there.
 *
 * Without an entry, an unknown page id quietly falls back to the landing page,
 * which is the kind of broken link nobody reports because it does not look
 * broken. Read ONLY when the role cannot open the page that was named, so an
 * owner never reaches this and their addresses behave exactly as before. */
export const SPLIT_FOR_ROLE = {
  sales: { sales: "floor", leads: "floor", mine: "floor", work: "overview", inbox: "gmail" },
};

/** Turn a route into the page to render.
 *
 * @param route      the address after the hash, e.g. "/dashboard/inbox?gmail=connected"
 * @param role       the signed-in member's role, or null when there is no member
 * @param allowedIds pageIdsForRole(role) — the ONLY gate. A page not in this
 *                   list behaves exactly like a page that does not exist.
 *
 * Returns { rawPage, section, query, fallback }:
 *   rawPage  the page id the address literally names — compare against
 *            `section` to know whether the address needs rewriting. Comparing
 *            the RENAMED value instead left `leads` in the address bar for ever.
 *   section  the page to render
 *   query    "?..." kept verbatim, or "". The Gmail sign-in bounces back
 *            through it and dropping it swallowed the connected/failed message.
 *   fallback where an address nobody can open lands.
 */
export function pageForAddress({ route, role, allowedIds }) {
  const ids = allowedIds || [];
  const [urlPath, urlQuery = ""] = String(route || "").replace(/^\/dashboard\/?/, "").split("?");
  const rawPage = urlPath.split("/")[0];
  const named = RENAMED[rawPage] || rawPage;
  const fromUrl = ids.includes(named)
    ? named
    : ((role && SPLIT_FOR_ROLE[role]?.[named]) || named);
  // `|| "work"` is the last resort: a role nobody has taught this file about
  // would otherwise leave the page id blank, and a blank page id shows one
  // page under another page's title.
  const fallback = ids.includes(LANDING) ? LANDING : (ids[0] || "work");
  return {
    rawPage,
    section: ids.includes(fromUrl) ? fromUrl : fallback,
    query: urlQuery ? `?${urlQuery}` : "",
    fallback,
  };
}
