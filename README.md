# AI Syndicate — Command Console

The internal admin OS at **admin.aisyndicate.com**. Separate app, separate
repo, separate URL — you can't reach it from the customer platform. Same
Supabase underneath, same design system, so it looks and feels like the
platform Andrew built.

**Read `SETUP.md` to go live. This file explains what's here and how it's put together.**

## The three layers

| Layer | URL | Who |
|---|---|---|
| Marketing site + platform | aisyndicate.com | Public → paying customers |
| Customer dashboard | aisyndicate.com/#/dashboard | Customers manage their own GEO |
| **This console** | **admin.aisyndicate.com** | **Team only, invite-only** |

## Pages

- **Overview** — MRR + revenue chart (Stripe, live), AI token spend (usage feed),
  pipeline + support counts, team activity feed.
- **Customers** — every Stripe customer: plan, status, MRR, renewal, one-click
  jump to their Stripe record. Read-only key; the console can never move money.
- **Leads** — the sales floor. Table + pipeline board, claim/assign, call
  logging with outcomes, CSV import with column mapping, AI outreach drafts,
  per-rep stats. Sales reps sign in and see ONLY this.
- **Operations** — the Notion replacement. Clients → tasks + week-by-week
  delivery log (What we did / What moved / What's next / Talking points, with
  the Draft → Verified → Client-Ready gate). Bulk JSON import for the
  copy-over from Notion.
- **Inbox** — each teammate connects their own Gmail (read + send only).
  AI-drafted replies and composes; a human always clicks Send.
- **Tickets** — internal support desk with AI-drafted replies.
- **AI Brain** — the editable knowledge base every AI draft is grounded in,
  with a test chat to prove edits instantly.
- **Our platform** — launch pad into the customer product pointed at
  aisyndicate.com, plus the honest note on the one backend flag needed for
  a no-limits internal tier.
- **Team** — invite, roles (owner / admin / sales), deactivate.
- **Settings** — live/waiting status per integration and which env var unlocks it.

## Honesty rule (built in, not a convention)

Every data card carries a badge: **LIVE** (measured from the real source just
now), **SAMPLE** (preview data), or **WAITING ON KEY** (screen is wired, key
isn't set). No number is ever shown without its source. AI drafts are always
reviewed by a human before sending — nothing sends itself.

## Stack (matches the platform)

React 19 + Vite 7 · hash router · CSS custom properties (index.css is the
platform's stylesheet verbatim; admin.css adds console-only classes) ·
Supabase (shared project, all new tables prefixed `admin_`, RLS on
everything) · Vercel serverless functions in `/api` with server helpers in
`/lib` · Stripe (read-only) · Gmail API (read+send per user) · Anthropic for
drafting.

## Security model

- **Allow-list, not open sign-up.** Being a Supabase user is not enough; you
  need an active `admin_users` row. Platform customers who sign in at the
  admin URL get a "team-only" wall.
- **Roles enforced in the database** (RLS policies), not just the menu.
  Sales reps' queries physically cannot read clients, tickets, revenue, or
  the Brain.
- **Secrets live in Vercel env vars only.** Never in code, never in the DB
  readable by the browser, never displayed in the UI.
- **Gmail refresh tokens** are stored server-side per user; RLS lets each
  user see only their own connection, and the send/read endpoints re-check
  ownership on every call.
- **Stripe key is restricted read-only.**
- **Usage ingest** is a separate shared-secret header, so the platform
  backend doesn't need a Supabase key to report usage.

## Repo map

```
api/                serverless endpoints (health, stripe-*, gmail-*, ai-draft,
                    invite, usage-ingest)
lib/                server-only helpers (supabase-server, stripe-server,
                    google-oauth, ai)
src/lib/            browser data layer (supabase, auth+roster, data CRUD +
                    preview store, api fetch)
src/components/     SignIn, ResetPassword, AuthGate, AdminDashboard shell
src/components/admin/  Sidebar, Header, shared building blocks, the 10 pages
supabase/migrations/0001_admin_init.sql   all admin_ tables + RLS (safe on the
                    shared project — creates only, prefixes everything)
SETUP.md            click-by-click go-live guide
```

## Known gaps (deliberate, v1)

- **Platform "no limits" internal tier** — needs one flag in the platform's
  backend; the Our-platform page carries the exact ask.
- **Platform leads auto-pull** — the platform's Leads module needs a source
  connected on its side; until then, lists come in by CSV (already built) or
  by hand. The `source: "platform"` field is ready for the wire-up.
- **Ticket email intake** — tickets are created by hand or by API today;
  auto-opening from the inbox is a v2 (the `source` field and intake endpoint
  shape are ready).
- **Token costs** — real numbers require the § 6 feed from the platform
  backend. The console's own AI spend reports itself already.
