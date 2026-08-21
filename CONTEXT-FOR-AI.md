# ai-syndicate-admin — Full Context for AI Sessions

Read this before touching anything in this repo. It is the complete brain-dump of the
Aug 15–16, 2026 build session: what this app is, how the company works, how the
customer platform works, every architecture decision and why, every trap already hit,
and how to test. Pairs with `README.md` (overview), `SETUP.md` (go-live clicks), and
the full build report in `~/Documents/AI-Syndicate/Admin-Console-Aug16/`.

---

## 1. The company, the people, the product landscape

**AI Syndicate** is a GEO agency. GEO = Generative Engine Optimization: getting client
businesses found, trusted, and quoted by AI search engines (ChatGPT, Google AI
Overviews, Perplexity, Gemini, Copilot) on top of normal Google search. Two business
lines: (1) client work — website buildouts, audits, GEO fixes; (2) the AI Syndicate
platform — the agency's own SaaS that crawls sites, scores them, and lists what's broken.

**People:**
- **Ryder Schilling** (ryder@aisyndicate.com) — contractor, business/design lead, drives
  this repo. Works fast, wants plain English, hates placeholder buttons. 
- **CJ Britton** — co-owner, client-facing. Gets reports and forwards them to clients.
  Holds Cloudflare for some clients, vendor relationships.
- **Andrew (AI) Soncini** — co-owner, technical co-founder. Built the platform's code
  and backend. His code patterns are the reference design. Lives in iMessage.
- **Caite** — NOT a person. The AI assistant baked into the platform (help chat,
  review-reply drafts). Powered by the Anthropic API.

**The three product layers (memorize this):**

| Layer | URL | Who uses it |
|---|---|---|
| Marketing site | aisyndicate.com | Public. Sign-up + payment happens here |
| Customer platform | aisyndicate.com/#/dashboard | Paying customers manage their own GEO |
| **THIS repo — admin console** | **admin.aisyndicate.com** | **Team only. Not reachable from the platform, on purpose** |

The console exists so the team can run the whole business inside its own software:
see revenue and AI costs, work sales leads, replace Notion for client ops, answer
email and support with AI drafts, and manage who has access.

## 2. The customer platform (what this console lives next to)

Everything below was learned by reading the platform repo directly
(`/Users/ryderschilling/aisyndicate/ai-syndicate`, GitHub `AISyndicateGEO/ai-syndicate`)
on Aug 15, 2026, plus operating the live product.

**Stack:** React 19 + Vite 7, deployed on Vercel. NO react-router — a tiny custom hash
router (`src/lib/router.js`, `useRoute()` hook, URLs like `/#/dashboard`). NO Tailwind
in practice — one big `src/index.css` (~3,600 lines) of CSS custom properties and
classes (Tailwind v4 is in devDeps but the design system is the custom CSS).
Serverless functions in `/api/*.js`, server-only helpers in `/lib/*.js` (root level,
NOT src/lib — that split matters: root `/lib` is server code, `src/lib` is browser code).

**Design tokens (from the platform's index.css `:root`, copied verbatim into this repo):**
`--ink #0a2245` (deep navy) · `--ink-2 #2d4663` · `--ink-dim #5a7290` · `--ink-faint
#9eb1c7` · `--accent #6366f1` (indigo) · `--accent-2 #8b5cf6` (purple) · `--accent-3
#3b82f6` (blue) · `--accent-deep #4338ca` · `--accent-soft #eef0ff` · `--rule #e1e8f0`
· `--bg-1 #fafbfc` · `--bg-2 #f5f8fb` (dashboard body) · `--success #00b833` ·
`--danger #df1b41` · fonts: `--display` Inter Tight, `--body` Inter, `--mono`
JetBrains Mono (loaded from Google Fonts in index.html). Sidebar is dark navy;
content is light. Radii 14/22px. Never invent colors — use the variables.

**Platform component patterns this repo copies:**
- Shell: `.dash` grid → `.dash-sidebar` + `.dash-main` (`.dash-header` + `.dash-content`).
- Sidebar: grouped nav buttons with inline SVG icons, active state, user card at bottom.
- `shared.jsx` building blocks: Toaster (global toast bus in `lib/toast.js` —
  `toast.success/info/warn/error(title, body)`), CountUp, SectionHeader, ChipBadge,
  MetricCard, Explainer (the glass "WHAT THIS IS" card).
- Tab strips use `.aia-tabs` / `.aia-tab` / `.aia-tab-dot` / `.aia-tab-badge` classes
  (they live in index.css ~line 1857) — never invent tab styles.
- Auth: `src/lib/supabase.js` (`isConfigured()` gate — app works WITHOUT Supabase env,
  falling back to demo/local mode; this repo copies that idea as "preview mode"),
  `src/lib/auth.js` (module-level shared singleton so concurrent `useAuth()` mounts
  don't race gotrue's lock — copied, trimmed), implicit OAuth flow (NOT PKCE — PKCE
  breaks email-link verification), `flowType: "implicit"`, noop lock.
- Server: `lib/supabase-server.js` (service-role client + `getUserFromRequest` bearer
  parsing), `lib/stripe-server.js`, `lib/help-chat.js` (Caite = direct fetch to
  Anthropic Messages API, model `claude-sonnet-4-6`, no SDK — this repo's `lib/ai.js`
  mirrors it), and a complete Google OAuth flow (`gsc-auth-start/callback` for Search
  Console) whose state-row pattern this repo's Gmail connect copies.

**Platform database (the SHARED Supabase project — critical):**
Existing tables: `profiles` (extends auth.users), `workspaces` (one per user: domain,
vertical, `plan_id`, stripe_customer_id/subscription fields), `audits` (JSONB audit
history), plus `gsc_tokens`, `gsc_oauth_states`, `subprocessor_subscribers`,
`sms_consent_log`. Trigger `on_auth_user_created` auto-creates profile + workspace for
every new auth user. Function `public.set_updated_at()` is the platform's — **this
repo deliberately created its own `admin_set_updated_at()` and must never
create-or-replace the platform's** (an early draft did; it was caught and fixed).
RLS pattern: explicit grants + policies, anon gets nothing.

**Platform plans:** pulse, radar, radar-pro, territory, territory-pro, command
(command is custom-quoted, no Stripe price). Env vars `STRIPE_PRICE_*` map plans to
Stripe Price IDs. Feature gates via `hasFeature(planId, feature)` in `src/lib/plans.js`.
**This is why the console can't give the team a "no limits" platform view: the gates
run inside the platform's own code.** The ask (written on the console's Our-platform
page): add an `internal` plan_id to workspaces that passes every hasFeature() check
and skips scan quotas.

**Operating the LIVE platform (hard-won rules):**
- Use `aisyndicate.com`, NOT `www.` — the session lives on the bare domain; www is a
  separate origin that dumps you at #/signin.
- Switching YOUR SITE in the workspace switches it for the whole workspace and
  persists. Note what it was on; switch it back.
- Scores cache (sometimes for days). Always re-run and read the MEASURED timestamp
  before quoting a number.
- Live scans (confusion, sentiment, authority, security, hallucination) burn a scan
  credit — run them on purpose only.
- Payments run through **Stripe**; checkout happens on the marketing site
  (`api/checkout.js` creates the session, `api/stripe-webhook.js` mirrors subscription
  state onto the workspace row).

## 3. What this console is (build of Aug 15–16, 2026)

Ryder's spec, in his own words: a backend dashboard/CRM/OS — all revenue, every
metric, all clients and their info; token usage and our cost; an internal view of the
platform with no blockers; a leads page where sales people work the pipeline and
admins see their activity; an operations page that replaces Notion; Gmail in one
place with an AI that drafts; an AI brain we can edit; track everything. New site,
own login at admin.aisyndicate.com, NOT reachable from the platform.

**Decisions made (Ryder chose, Aug 15):**
1. Everything wired for real, env-gated — no key means WAITING ON KEY, never fake-live.
2. **Share the platform's existing Supabase** (his explicit pick over a separate project).
3. Two roles in v1: Admin (owner/admin) + Sales rep (leads only). Invite-only.
4. Operations starts EMPTY — he'll have AI copy Notion over later (JSON import built in).

**The honesty system (non-negotiable, matches agency culture):** every data card
carries a SourceBadge — LIVE (measured from the real integration just now), SAMPLE
(preview data), or WAITING ON KEY (screen wired, key missing). No number without its
source. Same rule as agency reports: never blend measured / quoted / marketing claims.

**Preview mode:** with no Supabase env vars the app runs sign-in-free on an in-memory
sample store (`src/lib/data.js` previewStore — all names deliberately fake, "-sample"
domains). This is how the app was tested and how Ryder first ran it locally. Nothing
persists in preview.

## 4. Repo map (what every file does)

```
index.html                 fonts (same Google Fonts stack as platform), noindex
vite.config.js             react plugin + devApiPlugin(): serves EVERY api/<name>.js at
                           /api/<name> in `npm run dev`, with Vercel's req/res shape
                           (req.query, req.body, res.status().json(), res.redirect) and
                           .env.local pushed into process.env via loadEnv(mode,cwd,"").
                           Added Aug 16 2026 — before it, nothing server-side could be
                           tested without deploying. Generic version of the platform's
                           per-route devApiPlugin.
vercel.json                per-function maxDuration
eslint.config.js           platform-style config; react-hooks/set-state-in-effect OFF
                           (fetch-on-mount pattern is deliberate, comment explains)
.env.example               every env var with where-it-comes-from comments
SETUP.md                   click-by-click go-live (Supabase → Vercel → DNS → keys)
README.md                  overview + security model + known gaps

supabase/migrations/0001_admin_init.sql
    THE database. 14 tables, 21 RLS policies, 4 helper functions
    (admin_set_updated_at, admin_is_member, admin_is_admin, admin_is_owner).
    Safe to run ONCE on the shared project. Seeding SQL for the first owner is
    at the bottom (needs the person to have signed in once so auth.users has them).

lib/  (SERVER-ONLY — mirrors platform's root /lib convention)
  supabase-server.js       service-role client, getUserFromRequest,
                           requireMember(req, roles?) — THE auth gate every endpoint calls
  stripe-server.js         lazy Stripe client + subscriptionMrrCents (normalizes
                           any billing interval to monthly cents)
  google-oauth.js          Gmail OAuth: consent URL, code→tokens, refresh→access,
                           gmailFetch helper; scopes = gmail.readonly + gmail.send ONLY
  ai.js                    Anthropic Messages API direct fetch (claude-sonnet-4-6, same
                           as Caite). buildSystemPrompt = house rules + Brain rows +
                           per-kind task prompt (email_reply / email_new / ticket_reply /
                           lead_outreach / chat). Never invents facts — writes
                           [CONFIRM: ...] placeholders instead.

api/  (Vercel serverless — ESM works because package.json has "type":"module")
  health.js                GET; member → which integrations are live (booleans only),
                           incl. platformSso / platformAccountSet
  platform-sso.js          POST; OWNER/ADMIN ONLY → one-time Supabase magic link for our
                           own platform account, so the Our-platform button opens the
                           customer product already signed in. redirectTo is forced to
                           the BARE origin via new URL(...).origin (hash trap #3).
                           Falls back to the member's own email when
                           PLATFORM_ACCOUNT_EMAIL is unset. GET ?diag=1 returns config
                           booleans and never a key. The link is never logged.
  stripe-metrics.js        GET; OWNER/ADMIN ONLY → MRR, sub counts, 12-mo revenue from
                           charges, 10 recent payments. Pagination hard-capped at
                           10×100 per resource; sets truncated:true if hit
  stripe-customers.js      GET; owner/admin → ≤500 customers w/ best-alive subscription;
                           current_period_end read from subscription ITEMS (basil API
                           moved it there)
  usage-ingest.js          POST; auth = x-ingest-key header (timingSafeEqual on sha256),
                           NOT Supabase. ≤500 events/call; skips negatives and
                           cost>100000 rather than failing the batch. THE contract for
                           the platform backend to report token usage
  invite.js                POST; owner/admin. Pages through ALL auth users (20×1000) to
                           find existing accounts; 409 if already on roster (Team page
                           owns role changes); Supabase inviteUserByEmail for new emails;
                           redirectTo is BARE origin (hash trap)
  gmail-auth-start.js      GET; member → state row + HttpOnly SameSite=Lax cookie
                           (browser-binding) → Google consent URL
  gmail-callback.js        GET; unauthenticated redirect target. Verifies state row AND
                           the cookie (10-min expiry), exchanges code, stores refresh
                           token under the INITIATING user, bounces to /#/dashboard?gmail=
  gmail-accounts.js        GET/DELETE; member; own connections only
  gmail-threads.js         GET; member; own account only; Gmail search syntax passthrough
  gmail-thread.js          GET; full thread, text/plain preferred, HTML stripped fallback
  gmail-send.js            POST; member; own account; CRLF-stripped headers; recipient
                           regex ANCHORED single-address; reply threading via
                           In-Reply-To/References + threadId
  ai-draft.js              POST; member. Brain rows are loaded ONLY for owner/admin
                           (sales could otherwise ask the AI to recite the Brain the DB
                           hides from them). Logs its own token usage + cost into
                           admin_usage_events (source:"admin") — the console's AI spend
                           measures itself

src/lib/  (BROWSER)
  supabase.js              copied from platform (isConfigured gate, implicit flow, noop lock)
  auth.js                  platform's shared-singleton pattern + the console's extra:
                           membership check against admin_users. useAuth() →
                           { user, loading, configured, membership } where membership
                           undefined=checking, null=not on roster, object={role,...}.
                           resetPasswordForEmail redirectTo = BARE origin
  router.js                platform's hash router minus legal paths
  toast.js                 platform's, verbatim
  adminApi.js              apiFetch (bearer + 60s timeout + error envelope) and
                           getHealth (session-cached; force param to re-check)
  data.js                  THE data layer. Every page reads/writes through it. LIVE mode
                           = supabase-js with RLS; PREVIEW mode = in-memory sample store.
                           Result envelopes carry {sample:boolean}. Also: RFC-4180-ish
                           CSV parser (quotes, escaped quotes, CRLF, BOM) and
                           guessLeadColumn (header → lead field mapping)

src/components/
  SignIn.jsx               dark splash sign-in; invite-only (no signup form); preview-mode
                           card when unconfigured; forgot-password inline
  ResetPassword.jsx        set/reset password; also the landing for invite links
                           (App.jsx routes type=invite|recovery hashes here)
  AuthGate.jsx             preview → children; loading → brand splash; no user → /signin;
                           user but no roster row → hard "team-only" wall with sign-out
  AdminDashboard.jsx       shell; section state; role-filtered sections; PREVIEW_MEMBER
                           (owner) when unconfigured
  LogoMark.jsx             platform's animated logo, verbatim
  admin/Sidebar.jsx        grouped nav (Command/Sales/Delivery/Comms/Intelligence/
                           Workspace); sectionsForRole() — sales sees ONLY the Sales group
  admin/Header.jsx         section titles, Platform link (bare domain!), Refresh button
                           dispatching window CustomEvent "adm-refresh" (every page with
                           live data listens and refetches)
  admin/shared.jsx         Toaster, CountUp, SectionHeader, ChipBadge, SourceBadge,
                           MetricCard, Explainer, EmptyState, Modal (portal, Esc closes),
                           Field/TextInput/TextArea/Select, Bars + Sparkline charts,
                           fmtMoney/fmtNum/timeAgo, useHealth
  admin/Overview.jsx       revenue hero + tiles + 2 charts + payments + activity + quick
                           jumps + usage-ingest explainer modal. dayCost computed at load
                           time (render purity)
  admin/Customers.jsx      Stripe table w/ search + status filter + per-customer Stripe link
  admin/LeadsPage.jsx      biggest page: tiles, filters, table/board toggle, LeadDrawer
                           (stage/owner selects, AI outreach, log call/email/text/note w/
                           outcome, timeline), AddLeadModal (validated), ImportModal (CSV
                           → column mapping w/ auto-guess → preview 3 rows → batch insert,
                           caps 5MB/2000 rows), RepStatsModal (30-day per-rep counts from
                           logged activity only)
  admin/Operations.jsx     client list → ClientDetail (tasks table w/ one-click status
                           cycling, weekly log cards w/ the 4 Notion boxes + week_status +
                           Draft→Verified→Client-Ready readiness), ClientModal, TaskModal,
                           WeekModal, ImportClientsModal (paste JSON list; the documented
                           Notion copy-over path; shape shown in the modal)
  admin/Inbox.jsx          gmailReady = configured && health.gmail. Connect flow, account
                           picker, ?gmail=connected|error bounce handling, ThreadModal
                           (read + AI reply draft + send w/ proper threading), ComposeModal
                           (one-line instruction → AI drafts subject+body). Sample threads
                           make the whole flow clickable in preview
  admin/Tickets.jsx        queue + filters + TicketModal (messages, AI draft from history
                           + Brain, post reply → auto-moves to pending) + NewTicketModal
  admin/Brain.jsx          entries grouped Voice/Rules/Facts/Snippets, on/off toggle,
                           edit/delete, sticky test chat (kind:"chat" → proves edits
                           instantly)
  admin/WorkPage.jsx       THE LANDING PAGE for every role. One person's work only:
                           tasks assigned to them bucketed late/today/this week/
                           no-date/blocked, leads they own that are owed a contact
                           (each row carries the REASON), their open tickets, their
                           reminders, and a private notepad. Every bucket and count
                           comes from getMyWork() in data.js — never recomputed in
                           the page, or the header and the list drift apart.
                           Actions: start/block/done a task, log a contact (writes
                           lead activity + next_follow_up_at + stage in one go),
                           tick/push/delete a reminder, add/pin/edit/delete a note.
  admin/PlatformView.jsx   "Sign in and open the platform" button → POST /api/platform-sso;
                           opens a holding tab INSIDE the click (async window.open is
                           popup-blocked), then points it at the link; falls back to a
                           plain link + toast on any failure. SourceBadge shows
                           live/sample/waiting. Module grid, the internal-tier blocker
                           card with the exact ask, field notes
  admin/TeamPage.jsx       roster w/ role selects (owner rules enforced server+DB side
                           too), activate/deactivate, InviteModal → /api/invite
  admin/SettingsPage.jsx   integration truth-table from /api/health (force refresh),
                           env-var names on copy buttons, session info

src/admin.css              console-only classes on top of index.css: sign-in card,
                           .adm-input, .adm-table, .adm-modal*, .adm-drawer*,
                           .adm-board*, .adm-kv, .adm-timeline, .adm-msg, .adm-chart-tip,
                           AND the section-spacing rule (see traps #15)
src/index.css              the platform's stylesheet, verbatim. DO NOT fork it — if the
                           platform restyles, re-copy it and the console matches again
```

## 5. Database model (all in the shared Supabase, all admin_-prefixed)

| Table | What it holds | Who can touch it (RLS) |
|---|---|---|
| admin_users | the roster: user_id→role (owner/admin/sales), active | members read; owner-protected updates (see below); inserts via service role only |
| admin_invites | invite audit trail | admins read |
| admin_clients / admin_tasks / admin_weekly_log | the Notion replacement | **admins only — sales cannot even SELECT** |
| admin_leads / admin_lead_activity | pipeline + logged calls | all members read/write; delete admin-only; activity insert must have actor = auth.uid() |
| admin_tickets / admin_ticket_messages | support desk | admins only (v1) |
| admin_brain | AI knowledge base | admins only |
| admin_usage_events | token/cost events | admins read; writes via service role (ingest + ai-draft) |
| admin_gmail_accounts | per-user refresh tokens | own row only, and **refresh_token column is excluded from the browser grant** — column-level `grant select (user_id,email_address,scope,connected_at)` |
| admin_oauth_states | OAuth CSRF states | service role only, no client policies |
| admin_activity_log | the Overview feed | members read; insert own rows |

**Role enforcement details that matter:**
- `admin_is_member()/admin_is_admin()/admin_is_owner()` are SECURITY DEFINER SQL
  functions created AFTER admin_users (Postgres validates SQL bodies at creation).
- The roster update policy: `using/with check (admin_is_owner() OR (admin_is_admin()
  AND role <> 'owner'))` — admins manage admin/sales rows but can neither touch an
  owner's row nor set anyone (incl. themselves) to owner. Client-side guards exist too
  but the DATABASE is the enforcement.
- A platform customer authenticating at the admin URL: AuthGate shows the "team-only"
  wall, and even a hand-crafted API call reads 0 rows (verified by test).

## 6. Integrations — exact contracts

**Stripe (read-only):** restricted key, Read on Charges + Customers + Subscriptions +
Prices. That is sufficient for both endpoints (verified against the calls made). The
console never writes to Stripe. MRR = active+trialing subscriptions normalized to
monthly. Test-mode keys get a TEST-MODE badge on the hero.

**Anthropic:** same `ANTHROPIC_API_KEY` the platform's Caite uses (it's in the
platform's Vercel env). Model claude-sonnet-4-6. Cost table in api/ai-draft.js
($3/M input, $15/M output) — keep in sync with Anthropic pricing.

**Google/Gmail:** one OAuth app for the org (Internal consent type — aisyndicate.com
is Google Workspace, so no verification review needed). Scopes: gmail.readonly +
gmail.send + openid email. Redirect URI: `https://admin.aisyndicate.com/api/gmail-callback`.
Each teammate connects their own mailbox; for growth@ someone signs into growth@ in
the browser first, then clicks Connect. Refresh tokens live server-side only.

**Usage feed (the Andrew hand-off, phrased as blocked-until):**
```
POST https://admin.aisyndicate.com/api/usage-ingest
Header: x-ingest-key: <USAGE_INGEST_KEY>
Body: { "events": [ { "ts": ISO8601, "source": "caite|audits|platform|...",
        "model": "...", "input_tokens": n, "output_tokens": n, "cost_usd": n,
        "meta": {} } ] }   // ≤500 events per call
```

**Supabase Auth on the SHARED project — one config change was required:**
`https://admin.aisyndicate.com/**` (and `http://localhost:5173/**`) must be in
Authentication → URL Configuration → Redirect URLs, or invite/reset emails land on
the customer platform. Site URL stays pointed at the platform. SETUP §2 step 14a–d.

## 7. Environment variables (complete list)

| Var | Side | Source |
|---|---|---|
| VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY | browser+server | platform's Vercel env / Supabase → Settings → API |
| SUPABASE_SERVICE_ROLE_KEY | server | same place. NEVER VITE_-prefixed |
| ADMIN_BASE_URL | server | https://admin.aisyndicate.com (used in invite redirect) |
| STRIPE_SECRET_KEY | server | restricted read-only key (see §6) |
| ANTHROPIC_API_KEY | server | copy from platform's Vercel |
| GOOGLE_OAUTH_CLIENT_ID / _SECRET | server | Google Cloud console app (SETUP §5) |
| GMAIL_REDIRECT_URI | server | optional override; defaults to https://<host>/api/gmail-callback |
| USAGE_INGEST_KEY | server | invented 40+ char secret |
| VITE_NO_SIGNIN | browser | `true` = no login, sample data, amber banner. See §13 |
| PLATFORM_URL | server | https://aisyndicate.com — BARE origin, no /#/route |
| PLATFORM_ACCOUNT_EMAIL | server | the platform login the SSO button signs in as; blank = each member's own |
| RESEND_API_KEY | server | optional; same Resend account the client lead forms use |

## 8. Traps already hit — do not re-hit these

1. **SQL functions must be created after the tables they reference** — the original
   migration failed entirely on this (function-before-table).
2. **Never `create or replace` the platform's `set_updated_at()`** or any existing
   object on the shared project. Console uses `admin_set_updated_at()`.
3. **Supabase implicit-flow hash trap:** any `redirectTo` containing `/#/route` breaks
   token parsing (token gets appended after the existing hash). ALWAYS redirect to the
   bare origin; App.jsx routes `type=invite|recovery` to the set-password screen.
4. **Supabase Redirect-URL allow-list** (see §6) — without it, auth emails go to the
   customer platform.
5. **`auth.admin.listUsers` is paginated** — the shared project holds every platform
   customer; a first-page-only lookup misses accounts. Page through all of them.
6. **UI-only permission guards are not guards.** Admin self-promotion to owner was
   possible via direct DB call until the RLS policy was fixed. Enforce in the database.
7. **Column-level grants for secrets:** `grant select (cols...)` keeps
   admin_gmail_accounts.refresh_token unreadable from the browser even with RLS passing.
8. **A sales-blocked table can still leak through an AI endpoint** that loads it with
   the service role into a prompt. ai-draft loads Brain rows only for owner/admin.
9. **Stripe apiVersion 2025-04-30.basil** moved `current_period_end` from the
   subscription onto its items.
10. **Gmail send header injection:** strip CR/LF from all header values; anchor the
    recipient regex (`,`-joined lists fan out silently otherwise).
11. **OAuth account-binding CSRF:** the callback stores tokens under the state row's
    user — bind the flow to the browser with an HttpOnly cookie checked at callback,
    or a forwarded consent link attaches the victim's mailbox to the attacker.
12. **`numeric(12,6)` overflows** on absurd cost values; one bad row must not reject a
    500-row insert — filter, don't fail.
13. **eslint react-hooks v7** flags fetch-on-mount (`set-state-in-effect`) and
    `Date.now()` in render (`purity`). The first is deliberately disabled in config;
    for the second, compute time-derived values at load time and store in state.
14. **JSX single-quoted attributes** can't contain apostrophes ("Thursday's" broke the
    parse) — use a braced string.
15. **index.css's `.dash-content > * + *` rule only ANIMATES — it adds no margin.**
    Sections sit flush without admin.css's `margin-top: 24px` rule (Ryder caught this
    on first run, Aug 15). The chart tooltip (.adm-chart-tip) is also kept INSIDE the
    card (top:0) — at -8px/-100% it floated over the row above.
16. **Zip exclusion patterns:** `-x ".env*"` also excludes `.env.example`. Been bitten.
17. **The build sandbox blocks fonts.googleapis.com** — a ERR_TUNNEL console line in
    tests is the sandbox, not the app.
18. **Vercel "sensitive" env vars can never be read back.** The platform's
    `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`,
    `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` and both `GSC_` values are typed
    `sensitive` — the API returns them with no value and the dashboard has no
    reveal. Non-sensitive ones are typed `encrypted` and DO decrypt, but only
    one at a time: the list endpoint returns ciphertext, and
    `/api/v9/projects/<project>/env/<envId>?decrypt=true` returns the plaintext.
    So "copy the keys from the platform's Vercel" works for some vars and is
    impossible for others — the sensitive ones must be re-issued at their source.
19. **`Select` in shared.jsx takes `[value, label]` PAIRS**, not `{value,label}`
    objects. Passing objects renders a list of blank options with no error.
20. **A file on the Mac mount can stop being writable mid-session.** `src/lib/
    supabase.js` returned EACCES on write while its neighbours were fine, and
    `touch` still updated the mtime. The fix that works: `mv` the file to a
    `.bak` name, write a fresh copy in its place, then move the `.bak` out to
    `_to_delete/`. Never assume a failed write means the content was preserved —
    re-read it.
21. **`npm run build` fails inside the mounted Mac folder** — node_modules there
    holds the macOS rollup binary and the bridge VM is Linux
    (`MODULE_NOT_FOUND: @rollup/rollup-linux-x64-gnu`). Lint runs fine. To
    actually build/test, copy the source into the cloud container and
    `npm install` there.
22. **Ryder's account may be Google-SSO-only** — "Forgot password?" on the admin
    sign-in adds a password to the same account; platform Google sign-in keeps working.

## 9. How to test (the recipes that were actually used)

```bash
npm install
npx eslint .                  # must be 0 errors
npm run build                 # must be 0 errors
npm run dev                   # http://localhost:5173 — preview mode with no env
```
- **Browser walkthrough:** a Playwright script clicking every page, modal, drawer,
  import flow, and validation path at 1440px + 390px, failing on any console/page
  error. (Ran 31 steps, 0 app errors, Aug 16.)
- **Migration + RLS test harness:** local Postgres 16, scaffold `anon`/`authenticated`
  roles + `auth.users` + `auth.uid()` reading `request.jwt.claim.sub` + a fake
  platform `set_updated_at()`; run the migration; then `set role authenticated` +
  `set_config('request.jwt.claim.sub', '<uuid>', false)` per persona and assert:
  admin can't self-promote / can't touch owner; sales sees 0 brain/clients/tickets
  but full leads + roster + can insert own activity; customer sees 0 everything;
  `select refresh_token` → permission denied; owner can change roles. All 6 passed
  Aug 16 after fixes.
- **Adversarial review:** a separate agent instructed to assume the build is broken
  found 14 real defects on Aug 16 (all fixed — they're §8 items 1–12). Repeat this
  before any major release; it works.

## 10. Deploy + go-live state (as of Aug 16, 2026)

- **NOT deployed.** No GitHub repo, no Vercel project, no keys set. The repo sits at
  `~/Documents/AI-Syndicate/ai-syndicate-admin/` on Ryder's Mac.
- Flow: Cursor → GitHub (`ai-syndicate-admin`) → Vercel (Vite preset) →
  admin.aisyndicate.com via GoDaddy CNAME `admin` → `cname.vercel-dns.com` (Ryder has
  GoDaddy delegate access). Every click is in SETUP.md, in order.
- First admin seeding is manual SQL (SETUP §1 step 12) because /api/invite requires
  an existing admin. Everyone after Ryder gets invited from the Team page.
- git note: pushes happen from Ryder's Cursor terminal, never from AI sandboxes
  (no GitHub auth there). He has two GitHub identities — the AI Syndicate one is
  `ryderai`; this repo belongs on the AISyndicateGEO org side like the platform.

## 11. Standing blockers (phrase as "blocked until X exists", never as someone's task)

1. Internal/no-limits platform view — blocked until an `internal` plan tier exists in
   the platform's backend. Exact ask on the console's Our-platform page.
2. Real platform token costs — blocked until the platform backend posts to
   /api/usage-ingest (contract in §6). Console's own AI spend already self-reports.
3. Platform lead auto-pull — blocked until the platform exposes its scraped-lead data
   (API or shared table). `source:'platform'` field is ready; CSV import covers today.
4. Ticket auto-intake from email/platform — v2; `source` enum and message model
   already support it.

## 12. Working rules for this repo (inherited from how the team works)

- Plain-English UI copy. No SEO/dev jargon in anything a teammate reads.
  The banned-words list applies: leverage, robust, holistic, synergy, utilize,
  ecosystem, granular, seamless, actionable insights, best-in-class.
- The Aston Martin rule: nothing is "done" until it's been loaded in a real browser
  and every button does something real. No toast-only placeholder buttons. Empty
  states explain what would be there. Every input validates with a plain-English toast.
- Every number needs its source (the SourceBadge system exists for this).
- Passwords/secrets: never in code, never in the DB readable by the browser, never in
  Notion, never in this file. Vercel env vars + Bitwarden links only.
- Match Andrew's patterns before inventing new ones. When in doubt, open the platform
  repo and copy how he did it.

*Written Aug 16, 2026, at the end of the build session that created this repo.*


## 13. Added after the first release (Aug 16 2026)

**`VITE_NO_SIGNIN`.** `true` in `.env.local` opens the console with no login.
Implemented inside `isConfigured()` in `src/lib/supabase.js`, which means it also
forces the preview data store — deliberately. Every read in data.js and every
`/api` call is authorised by the signed-in user's token, so a "live" console with
nobody signed in would be a wall of permission errors, not a useful page. An
amber `SIGN-IN IS OFF` banner renders above the header for as long as it is on.
Vite reads env at boot, so `npm run dev` must be restarted after changing it.

**`supabase/migrations/0002_work_page.sql`.** Run AFTER 0001. Adds:

| Object | Notes |
|---|---|
| `admin_notes` | Private to `author_id`. RLS blocks reads, writes, edits and deletes by anyone else **including owners** — a shared scratchpad stops people writing honestly in it. Proven by test. |
| `admin_reminders` | Owner-scoped, but owner/admin can READ the team's so nothing rots. Write stays own-only: an owner can see a follow-up is three weeks late, but cannot silently tick it off. `created_by` cannot be forged. |
| `admin_leads.next_follow_up_at`, `.follow_up_note` | Makes "people to contact" a real date instead of a guess. |

Both migrations were applied to a local Postgres 16 with a scaffolded `auth`
schema, re-applied to prove idempotency, and checked to confirm the platform's
own `set_updated_at()` was untouched. 15 RLS tests passed, including: a sales rep
cannot read or forge another member's note, cannot tick off another member's
reminder, a platform customer reads 0 rows from both tables and cannot insert,
and a member whose roster row is deactivated loses access immediately.

**The Work page is the landing section for every role** (`useState("work")` in
AdminDashboard.jsx). Sales sees it too — it is the only page besides Leads that a
sales role can reach. Change that one string to land somewhere else.

**The Work page has NO `<Explainer>` card — Ryder removed it Aug 17 2026.** Do
not add one back. Every other page opens with one; this page is the one you look
at twenty times a day, and a paragraph telling you what the page is costs a
third of the screen every time. Killing it moved the tab strip from 445px to
288px on a laptop and from 693px to 481px on a phone. The SAMPLE badge and the
"n blocked" line stayed — those are facts, not an introduction.

**The Work page is TABBED** (Ryder's call, same day). One section renders at a
time — Operations / People to contact / Reminders / Notes / Tickets — using the
house `.aia-tabs` / `.aia-tab` strip from `index.html`'s CSS, same markup as
Operations.jsx. Three things to know:

- The `TABS` array at the top of the file owns the labels and the badge counts.
  A badge is *what is waiting behind that tab*, read from the same `work` object
  the panel renders, so it cannot disagree with the rows.
- The four counter tiles are tab switches, not scroll links, and the active one
  gets an accent border. Clicking "People to contact" should show you the
  people, not scroll you past three other sections.
- **The Tickets tab only exists while you have tickets.** Solve your last one
  while standing on it and the tab disappears — an effect falls the active tab
  back to Operations, or you would be staring at a blank page.
- Tile grid is `minmax(150px, 1fr)`, not 180px: at 180px a phone got one tile
  per row and the tab strip was pushed a full screen down. 150px gives 2×2 on a
  390px phone and still 4 across on a laptop. Verified at 390 / 768 / 1440.

**Stale-lead rules** live in `STALE_AFTER_DAYS` in data.js: new 1 day,
contacted 3, follow_up 5, meeting 5, proposal 4, anything else 7. Won and lost
leads are never chased. An explicit `next_follow_up_at` always beats the
staleness rule, and a missed one sorts to the very top.


## 14. The money chart (Aug 17 2026)

Overview's two chart cards (Gross revenue · AI cost per day) were replaced by
**one card: "Money in vs AI spend"** — `MoneyBars` in `shared.jsx`, driven by
`buildMoneySeries()` in `Overview.jsx`.

One bar per period. **Bar height = revenue. The red block at the bottom is AI
spend; the green above it is what was left.** No green means AI ate everything
that came in. When AI cost MORE than came in, the bar goes fully red and a
dashed outline continues above it to the true cost — that branch is real and was
screenshot-proven with a temporary sample override, not left to hope.

**Filter: Weekly (12 weeks) · Monthly (12 months) · Quarterly (4 quarters).**
Four quarters, not six, because `/api/stripe-metrics` only pulls twelve months of
charges — a fifth quarter would always draw an empty bar and read as a terrible
quarter rather than as missing data.

**`/api/stripe-metrics` now also returns `dailyRevenue`** (`[{d, cents}]`, same
twelve-month window, ~370 numbers) from the charges it was already paginating.
Both series are held as day → cents maps and summed into the chosen period in one
place, so revenue and AI spend can never end up on different calendars. Overview
loads `listUsage(400)` for the same reason.

### Things not to "fix" back

1. **The colours are computed, not chosen.** Plain red vs green
   (`#0ca30c` / `#d03b3b`) fails colourblind separation — ΔE 4.1 deutan against a
   needed 8. A red-green colourblind reader, about one man in twelve, sees one
   colour on a chart whose entire message is which colour is showing. The red is
   darkened to **`#941f1f`**, which measures **17.8** and still clears 3:1 on a
   white card. Verified with the dataviz skill's validator. Spend is also ALWAYS
   the bottom block and the legend names both in words, so colour is never doing
   the job alone.
2. **The red has a 4px minimum height** (`MIN_COST_PX`). A real AI bill is well
   under 1% of revenue, which on a 200px bar is one pixel — invisible reads as
   "no cost at all". The tooltip carries the exact figure and its share of
   revenue, so the floor never becomes the number anyone reads.
3. **Axis labels thin out by measuring the chart, not by media queries.** Two
   queries ("hide every 2nd under 760px", "hide every 3rd under 520px") intersect
   into "hide every 6th" and leave 2 labels on a phone. A `ResizeObserver` picks
   the step from width-per-bar instead. Labels are counted from the RIGHT so the
   newest period always keeps its label, and they are `overflow: visible` — a
   shown label bleeds into its hidden neighbours' space, which is free by
   definition; clipping it truncated "Aug 17" to "Aug 1".
4. **The card says green is "not full profit".** It is revenue minus the AI bill
   only — no wages, software or ad spend. That sentence stays. This chart will get
   screenshotted for CJ and Andrew, and "profit" would be a false claim.

---

## §11. Operations page rebuilt in the Notion format — Aug 17 2026 (append-only section)

Ryder asked for the Operations page to be "basically the same format as the notion operations …
so that it still operates the same." It is now a database with views, not a client browser.

### Shape

| Piece | File | What it holds |
|---|---|---|
| Cells | `src/components/admin/opsCells.jsx` | `NOTION_COLORS`, `Chip`, `Avatar`, `Popover`, `SelectCell`, `PersonCell`, `TextCell`, `DateCell`, `clientColor`, `todayISO` |
| Table + board | `src/components/admin/opsTable.jsx` | `COLUMNS`, `GROUP_OPTIONS`, `groupTasks`, `sortRows`, `dueBucket`, `isOverdue`, `plusDaysISO`, default export `TaskDatabase`, named `TaskBoard` |
| Page | `src/components/admin/Operations.jsx` | the four views, the toolbar, `TaskModal`, `ClientsView`, `ClientDetail`, `ClientModal`, `WeekModal`, `ImportClientsModal` |
| Styles | `src/admin.css` | one appended `.adm-db-*` / `.adm-ops-*` block |

Views: **All tasks** (group by Client) · **This week** (due ≤ 7 days, grouped Late / Due today /
Next 7 days) · **Board** (column per status, HTML5 drag) · **Clients & weekly log** (client list +
that client's tasks grouped by Status + the 8-week log).

### Rules that must not be broken here

1. **Option lists are Notion's, word for word.** `TASK_CATEGORIES`, `TASK_PHASES`,
   `TASK_PRIORITIES` in `src/lib/data.js` mirror data source
   `f9655de0-c309-4335-bd74-75b71bdb5089`. A task means the same thing in both systems, so a
   copy-over needs no translation table. Do not "tidy" these names.
2. **The page owns the one copy of the task list.** Cells are dumb: they render what they are handed
   and report a change up. `patchTask` writes optimistically and puts the old row back on failure.
   Never let a cell keep its own saved value — two copies is how a table starts lying.
3. **Grouping and sorting live in `opsTable.jsx` only.** Group headers get their counts from the
   same array they render, so a header can never disagree with the rows under it.
4. **Popovers are portaled to `<body>` with fixed coordinates** from the trigger's own rect, and
   they close on outside click / Escape / resize / scroll. The table scrolls sideways; an absolutely
   positioned menu inside a scroll container gets clipped. Do not "simplify" this to absolute.
5. **No migration was needed and none should be added for this.** `admin_tasks` already had
   `assigned_to`, `phase` and `category`.

### The assignee gap is closed
`admin_tasks.assigned_to` now has UI in two places (the table's Assigned-to cell and the task
modal). Before this, the Work page read a column nothing could write, so it would have been empty
for everyone in live use.

### Verification done Aug 17 2026
`npm run lint` 0 problems · `npm run build` clean (101 modules, vite 7.3.6) · driven in Chrome on
`localhost:5173`: status change, assign an unassigned task, inline `+ New task` (inherits its
group's client), due date via Today, latest-report commit with ⌘Enter, board drag To do → In
progress with column counts moving, task modal, clients tab, weekly log · console 0 errors.

### Trap worth remembering
`npm run build` **cannot run through the Mac-folder bridge**: `node_modules` there is darwin-arm64
and the bridge VM is linux-aarch64, so rollup's native binary fails to load (`MODULE_NOT_FOUND`,
`rollup/dist/native.js`). The bridge has no network, so the linux binary cannot be installed either.
`npm run lint` runs fine. To prove a build, copy `package.json` + `index.html` + `vite.config.js` +
`src/` into the cloud container, `npm install`, `npm run build` there.

### Not done yet
- No task-level JSON import. Clients import in bulk; tasks still have to be typed or created one at
  a time. That is the missing piece for moving the real Notion rows over.
- Column choices and the current view are remembered in `localStorage` under `adm-ops-prefs`
  (per browser, not per account).
- Nothing sends when a due date passes; "late" is only shown, never notified.

---

## §12. Operations page — review pass, Aug 17 2026 (append-only section)

A separate reviewing agent was pointed at §11's code and told to assume it was wrong. Eleven defects
were found and fixed the same session. The ones that change how the code must be written:

1. **`<input type="date">` reports `""` on every keystroke** until a whole date is entered. Saving
   that empty value deletes the date the user is typing. `DateCell` now commits only when the value
   matches `/^\d{4}-\d{2}-\d{2}$/`, and the input is **uncontrolled** (`defaultValue`) so a
   half-typed date survives a re-render. Do not "fix" this back to a controlled input.
2. **A group's `preset` must include whatever the current view filters on.** Date groups now hand a
   new task a real due date (`dueBucket().preset`), or a task typed into the This-week view would be
   created and immediately hidden. `createTask` also warns when a new row falls outside the active
   filter, instead of a success message for something invisible.
3. **View settings are per view** (`prefs.byView[viewId]`), and `pickView` returns early when the
   same tab is clicked. One shared `groupBy`/`showDone` pair meant a trip to Board reset the
   grouping you chose on All tasks.
4. **Group keys are namespaced by grouping mode** (`${groupBy}:${g.key}`) for collapse state and the
   draft row — "No client" and "Unassigned" both use the key `__none`.
5. **An owner who is no longer active still owns the task.** `personOptionsFor(t)` appends the
   current owner marked `· inactive` when they are not in the pickable list; rendering "Unassigned"
   would be the table lying.
6. **Rollback is per field.** On a failed save, undo only the keys that call touched; on success,
   merge the row the database returned. Restoring a whole snapshot row also reverts anything else
   that changed while the request was in flight.
7. **Anything read out of `localStorage` is untrusted.** `isGroupBy()` validates group-by, columns
   must be a non-empty array, `viewId` must exist. An unknown group-by used to render a table with a
   header and zero rows.
8. **A read error is shown, never swallowed** — `.adm-db-warn` says what failed. An empty table that
   means "the query failed" is worse than no table.
9. No `position: sticky` on the table header: the page scrolls, not the table, so it could never
   stick.

Also fixed in `getMyWork()` (Work page, pre-existing): "late" was `end-of-today − 86400000ms`, which
buckets yesterday's task as due today on the day after a clock change. Due dates are now compared as
`YYYY-MM-DD` text. The same pattern remains on lead follow-ups, which compare timestamps, not dates.

### Chrome-testing trap
A `javascript_tool` block containing `await`/timers wedged the tab twice while testing this page:
screenshots then fail with "script injection timed out" and only closing the tab recovers it. Use
fire-and-poll — one call schedules the steps and writes results onto `window`, wait, a second call
reads them.

---

## §13. The shared team inbox — Aug 18 2026 (append-only section)

Built at Ryder's ask: *"on the inbox page i want it connected to growth gmail account so we can
read filter and edit and compose all emails in the platform. but also keep track of statuss of all
emails and link the emails to clients and then help with remonders and organization."*

Two decisions he made when asked (clickable options, his pick first):
1. **Shared to owner + admin only.** Sales never sees a shared mailbox.
2. **Widen the Google permission** so a status here also changes Gmail.

### The one idea the whole page rests on

**Gmail owns the mail. We own the bookkeeping.** They are two separate reads:

| | what it is | where it comes from |
|---|---|---|
| `gmailThreads` | what is in the mailbox right now | `/api/gmail-threads`, or `sampleMailThreads()` in preview |
| `rows` | our records: status, client, lead, owner, priority, notes | `admin_email_threads` |

`Inbox.jsx` merges them into ONE array (`merged`) and **every tab count, every filter and every row
comes out of that array**. Same rule as `getMyWork()` and the Operations group counts: a count worked
out from a different list than the rows is how you get a tab saying "3 need a reply" above four rows.

**Load order matters.** `/api/gmail-threads` is called FIRST, then our rows are read. That endpoint
does the one piece of bookkeeping a browser must not be trusted with — flipping a thread back to
*Needs reply* when a new inbound message lands — and writes it to the database. Reading our rows
afterwards therefore picks the flip up. The other order shows a stale status until the next refresh.

**A finished thread is archived in Gmail**, so it is not in the inbox listing any more. Those rows
come from `admin_email_threads` alone, rendered from the cached `subject`/`from`/`snippet` saved when
we still had them, and marked "archived" in the list. That cache is why the Done and Waiting views
work at all. Opening a thread always re-reads Gmail, so nobody ever replies to a cached copy.

### Access — the part to never loosen

`lib/gmail-mailbox.js` → `resolveMailbox(member, address)` is the single answer to "may this person
use this mailbox": **yes if they connected it, or if it is marked shared AND their role is owner or
admin.** Every Gmail endpoint asks it. Before this, each endpoint did `.eq("user_id", me)` itself,
which is why only the connector could see growth@.

- `refresh_token` is read only there, server-side, with the service role. The browser's column grant
  (0001, re-stated in 0003 for the new columns) does not include it. **A new column does not inherit
  a table's column-level grant** — every readable column has to be named again, which 0003 does.
- Sharing/renaming/disconnecting is **the connector's call only** (`user_id = auth.uid()` in the
  PATCH/DELETE), so an admin cannot expose a teammate's personal mail.
- Statuses live in `admin_email_threads`, which is admin-only in RLS — the same shape as tickets.

### Gmail write-backs (new: `POST /api/gmail-modify`)

`{ done, markRead, markUnread, archive, unarchive, star, unstar, addLabels, removeLabels, clientLabel }`

- `done:true` → remove `INBOX` + add `AIS/Done`. `done:false` → the reverse. The label name lives on
  the server so the browser cannot invent a second spelling of the same idea.
- `clientLabel` is **exclusive**: it strips every other `AIS/Client/...` label, so a thread can never
  claim two clients.
- A label is never in both add and remove lists in one call (checked, and tested).
- Two people marking Done in the same second both try to create `AIS/Done`; the loser gets a 409 and
  `ensureLabels()` re-reads and takes the winner's id.
- Scope guard: an old read-only connection gets **409 + `needsReconnect: true`** rather than a
  confusing Gmail 403, and the page shows a banner saying to reconnect once.

### Drafts are real Gmail drafts

`/api/gmail-drafts` (save / update / send / list / delete). Not a copy in our database — that is the
point: a half-written reply shows up in Gmail on a phone, and one finished on a phone shows up here.

### Sending

`/api/gmail-send` accepts `to` and `cc` as a string or an array, and **validates every address on its
own** so a comma-joined blob can never fan an email out. From a shared mailbox the message goes out as
the mailbox and carries `X-AIS-Sent-By: <the person>`. After a successful send the endpoint does its
own bookkeeping (status → *waiting*, cached fields, activity-log line) and **never throws while doing
it** — the email has already gone, and reporting a failure would make someone send it twice.

### Statuses (plain words, and the help text is in the picker)

`new` nobody picked it up · `needs_reply` ours to answer · `waiting` ball is with them ·
`scheduled` answered for now, with a date to chase · `done` finished, archived + labelled ·
`ignored` receipts and newsletters — **a new message does not reopen an ignored thread, on purpose.**
The reopen rule (in `gmail-threads.js`) fires only from waiting / scheduled / done.

### Follow-ups

A dated reminder in the existing `admin_reminders` table with `link_type = 'email'` (0003 extends both
the notes and reminders CHECK constraints to allow it), so an email follow-up already shows on the
Work page with no extra code. Picking a date also moves the thread to *Scheduled* — the picker says
so out loud. Overdue is shown as **due** (today, time passed) or **late** (an earlier day); "late" for
something set this morning was wrong and got fixed.

### Client / lead linking

`suggestLinkForEmail()` (in `src/lib/data.js`) matches the sender by exact address, then by website
domain, and **never by a free mailbox provider** — half our clients are on gmail.com, and matching on
that would link every one of them to the first client in the list. A guess is only ever OFFERED as a
chip; nothing links without a click. It offers **leads as well as clients**: the first version showed
"Link Chen Dental Studio?" on the row but only had clients in the menu, so the offer could not be
accepted. Found by clicking it in the browser, not by reading the code.

### Files

| Piece | File |
|---|---|
| Who may use a mailbox, labels, MIME building | `lib/gmail-mailbox.js` |
| Scopes + `accountNeedsReconnect()` | `lib/google-oauth.js` |
| List/share/disconnect mailboxes | `api/gmail-accounts.js` (GET/PATCH/DELETE) |
| Thread list + merge + reopen flip | `api/gmail-threads.js` |
| One thread, with mark-read | `api/gmail-thread.js` |
| Send | `api/gmail-send.js` |
| Gmail write-backs | `api/gmail-modify.js` |
| Drafts | `api/gmail-drafts.js` |
| Schema | `supabase/migrations/0003_inbox.sql` |
| Page | `src/components/admin/Inbox.jsx` |
| Cells, thread view, compose | `src/components/admin/inboxParts.jsx` |
| Statuses, sample mailbox, DB helpers | `src/lib/data.js` (TEAM INBOX sections) |
| Tests | `tests/inbox/` — `bash tests/inbox/run.sh` |

### How it was proven (Aug 18 2026)

- `npm run lint` — 0 problems. `vite build` — clean, 102 modules.
- **`bash tests/inbox/run.sh` — 37 checks, 37 pass.** Real `lib/` and `api/` code, with Gmail and
  Supabase stubbed (the stubs record every call). Covers: sales refused a shared mailbox, an admin
  allowed, a private mailbox staying private from an admin, 404 vs 403, the reconnect flag, Done →
  archive + label, exclusive client labels, the 409 label race, header injection in a recipient,
  from-line and `X-AIS-Sent-By` on a shared send, and who may share a mailbox.
- Clicked in Chrome in preview mode: tab counts (3/1/1/1/2 = 8 everywhere), a reply sent (Needs reply
  3→2, Waiting 1→2, thread gained our message), a follow-up set (status auto-moved to Scheduled,
  Follow-ups due 1→2), and the Done view listing the archived thread from our own cache.
- **NOT proven against real Gmail** — blocked until `GOOGLE_OAUTH_CLIENT_ID` and
  `GOOGLE_OAUTH_CLIENT_SECRET` exist. Everything above the Google boundary is proven; the Google
  boundary itself is not.

---

## §14. The client page — websites + "where this client stands" — Aug 18 2026 (append-only section)

Built at Ryder's ask: *"i also want to add in the client page for each client a websties list that
shows all the links of thier main website and ranking websites. and also a updated section that in a
shor description states everything that has been done to that client and what is still needed. i want
that to be formulated based on all operations, emails, tasks, statuss, reports, everything."*

Both live on **Operations → Clients & weekly log → a client** (`ClientDetail` in `Operations.jsx`).
The summary sits directly under the client header, above the tabs, because it is the thing you read
first. Websites are a third tab next to Tasks and Weekly log.

### Websites — `admin_client_sites`

One row per link, not one text field, so it can be sorted, counted and checked. Kinds, in the order
they are listed: `main` (their own site) · `authority` (a ranking site we built) · `landing` · `gbp`
(Google Business Profile) · `directory` · `review` · `social` · `other`. Each row has a name, the URL,
a live/not-live flag, and notes. Not-live is shown as a red **NOT LIVE** chip — built but not
published is a state we are in constantly and it used to live only in someone's head.

Quality-of-life: if the client has a `domain` and no `main` site yet, the panel offers a one-click
"Add their main site (example.com)". A pasted bare domain gets `https://` added (`normalizeUrl`).

### "Where this client stands" — the honesty design

This is a written summary, which means it is the one thing on the console that could lie. Four rules
make that hard, and all four are load-bearing:

1. **Facts are counted, never described.** `assembleFacts()` in `lib/client-standing.js` counts from
   real rows: tasks by status (done / open / in progress / blocked / late), the weekly log, email
   threads by status, open follow-ups, websites, last contact. Server-side, service role, in
   `api/client-standing.js`.
2. **The AI is shown the facts and nothing else.** `factsToText(facts)` is the entire input. It never
   touches the database, so it cannot quote anything it was not given.
3. **The facts are saved next to the text** (`admin_clients.standing_facts`) and shown in a
   *Check the numbers* window under the summary. A summary you cannot check against its own inputs is
   a rumour.
4. **The shape is parsed, not trusted.** `parseStanding()` pulls out `HEADLINE`, `DONE` and
   `STILL NEEDED` only. Anything outside those sections is dropped — an unlabelled paragraph is
   exactly where a made-up claim would hide. If nothing parses, the counted version is used instead.

**No AI key, still works.** `deterministicStanding(facts)` builds the same three sections from the
same facts with plain code, and the card is badged **COUNTED** instead of **AI-WRITTEN**. That badge
is the honesty label, not decoration.

**Staleness is visible.** The card compares the counts it was written from against what the page is
showing now, and says e.g. *"The records have changed since this was written (websites: 3 then, 4
now). Press Refresh."* Only the things that actually changed are named — "5 tasks then, 5 now" is
noise, and noise in a warning is how warnings get ignored. A stale summary that looks current is the
real danger of writing one at all.

**It never assigns work to a person.** `STANDING_INSTRUCTION` says so explicitly: "blocked until X
exists", never "CJ needs to do X". Same rule as the weekly reports.

### Why `lib/client-standing.js` is pure

No imports, no node built-ins, no fetch, no database. It is used by **both** the server endpoint and
the browser (`src/lib/data.js` imports it as `../../lib/client-standing.js` for preview mode). Two
copies of the counting rules would eventually disagree, and then the summary and the page would each
be sure the other was wrong. It also takes `nowMs` as an argument rather than reading the clock, so
the same rows always produce the same facts — that is what makes it testable and what keeps the saved
facts honest about the moment they were taken.

### Files

| Piece | File |
|---|---|
| Counting + the counted write-up + the AI instruction | `lib/client-standing.js` |
| Endpoint (counts, calls the AI, saves) | `api/client-standing.js` |
| Schema | `supabase/migrations/0004_client_page.sql` |
| The two sections | `src/components/admin/clientPage.jsx` |
| Wired in | `src/components/admin/Operations.jsx` (`ClientDetail`) |
| Site CRUD + preview counting | `src/lib/data.js` (CLIENT WEBSITES / WHERE THIS CLIENT STANDS) |
| Styles | `src/admin.css` — `.adm-cp-*` |

### How it was proven (Aug 18 2026)

`npm run lint` 0 problems · `vite build` clean. Then a **Playwright walkthrough of the BUILT app**
(not the dev server) in the cloud container, screenshotted at every step: empty state → Write it →
headline + Done/Still-needed columns → *Check the numbers* window showing all 15 counts and the raw
facts → Websites tab → add a website → the stale warning appearing (*websites: 3 then, 4 now*) →
Refresh → the summary now naming the new site and the warning gone. Zero app console errors.

**Not yet proven:** the AI-written path (needs `ANTHROPIC_API_KEY`; the counted path is what ran), and
nothing has been run against the real database — `0004_client_page.sql` has not been executed yet.

### Chrome-testing trap (worse than §12 said)

The extension wedges the tab — screenshots fail with "script injection timed out" — reliably a few
seconds after Vite hot-reloads the page, and sometimes on the first click after a reload. Closing and
reopening the tab is the only recovery. The fix that actually worked: **stop testing against the dev
server.** Stage the source into the cloud container, `vite build`, serve `dist/` with
`python3 -m http.server`, and drive it with Playwright + the preinstalled Chromium
(`/opt/pw-browsers/chromium`). No HMR, no wedge, real screenshots, and it tests the built bundle —
which is what actually ships.

---

## §15. Review pass on §13 and §14 — Aug 18 2026 (append-only section)

A separate agent was told to assume the build was broken and to report only problems. It found **three
real defects**. All three are fixed, and each now has a test so it cannot come back.

### 1. HIGH — "Archive in Gmail" moved the mail and left our status behind

The thread view had a standalone **Archive in Gmail** button wired straight to `/api/gmail-modify`,
which only ever talks to Gmail. So the thread left the Gmail inbox while `admin_email_threads.status`
stayed exactly as it was: a finished thread sat in **Needs reply** and kept being counted there.

**Fix.** The button is gone. What a status does to Gmail now lives in ONE function —
`gmailEffectOfStatus(from, to)` in `Inbox.jsx`:

- moving INTO `done` or `ignored` → archive (+ `AIS/Done` and mark-read for `done`)
- moving OUT of either → put it back in the inbox
- anything else → no Gmail call at all

The thread view says so in words: *"To get it out of the Gmail inbox, set the status to Done or No
reply needed — archiving is what those two do."* The rule to keep: **never add a Gmail action to the UI
without deciding what it means for our status.** A second path that does half the job is how drift gets
in.

### 2. HIGH — the thread list was ALL MAIL, not the inbox

`gmailFetch(token, "/threads?maxResults=25")` with no query returns everything in the mailbox,
archived included. Combined with defect 1 that made the staleness permanent: an archived thread came
back in the list on every load, still carrying its old status.

**Fix.** `api/gmail-threads.js` now sends `q=in:inbox` whenever the person has not typed a search. A
typed search replaces it on purpose — searching *should* reach archived mail. Two tests cover both.

### 3. MEDIUM — the standing summary could go stale invisibly

Staleness compared only row **totals** (tasks, websites, emails). Flip one task from To do to Done and
no total changes, so the card kept showing "1 done, 4 open" with no warning — the exact failure the
feature's own comment warns about.

**Fix.** `liveCounts` now carries the status breakdowns too — `tasksDone`, `tasksOpen`,
`tasksBlocked`, `sitesLive`, `weeksLogged`, `emailsNeedingReply`, `emailsWaitingOnThem` — and the card
compares every key it is handed, naming the first four that differ. The email breakdown comes free from
the read that was already fetching the count.

### 4. Also fixed, from the same review: the summary guard was format-only

The reviewer pointed out that rule 4 ("the shape is parsed") does not stop a **well-shaped** bullet
containing an invented number or a promise. True. Natural language cannot be fully checked, but the two
dangerous classes can be, and now are — `checkStanding()` in `lib/client-standing.js`:

- **`unbackedNumbers()`** — every number in the write-up must appear in the facts text it was given.
  Years (2000–2100) and 0/1 are ignored so ordinary phrasing survives. "12 pages", "score 74" out of
  nowhere → rejected.
- **`promiseWordsIn()`** — "guarantee", "on track for", "will rank", "great progress" and friends →
  rejected.
- Both sections empty → rejected.

A rejected draft is **thrown away**, a line goes into `admin_activity_log`
(`kind: "client_standing_rejected"`, with the reason), and the **counted** version ships instead. So the
page is never empty and never shows an unbacked claim. `rejected` also comes back in the API response.

### What the review got wrong, and why

It reported *"the test suite does not run at all — tests/inbox/ contains only test.mjs"* as its most
severe finding. That was true of what it could see: the reviewer reads staged read-only copies in the
container, and only `test.mjs` had been staged — `stubs/` and `run.sh` were never copied over. On the
real repo `bash tests/inbox/run.sh` passes. **Lesson for next time: stage the whole folder a reviewer is
asked to judge, or its absence reads as a defect.** Re-run after these fixes: **47 checks, 47 pass**
(was 37; the ten new ones cover defects 2 and 4).

### The other four categories

Access control, SQL-on-a-shared-database, React state, and the remaining comment claims: the reviewer
found nothing real, and specifically confirmed that `refresh_token` is in no `grant select` list, that
`admin_email_threads` and `admin_client_sites` are admin-only in RLS, that both migrations are
idempotent, and that the count-and-rows pipeline is single-sourced.


---

## §16. STATE BOARD — what exists, what is still needed (Aug 18 2026, end of session)

The one section to read if you only read one. Everything below §13 is detail; this is the state.

### BUILT AND WORKING (in the repo, not on the internet)

**The shared team inbox** (Inbox page)
- growth@ (or any Gmail) connected once and marked shared → every owner/admin works the same mail.
  Sales cannot see a shared mailbox and cannot see the Inbox page at all.
- Per email: status · client or lead · owner · priority · shared notes · dated follow-up.
- Six views with live counts, filters by client / owner / unread, Gmail search syntax in the box.
- Done archives in Gmail + labels `AIS/Done`. Client link labels `AIS/Client/<name>`, exclusively.
- Reply, reply-all, AI draft, save as a real Gmail draft, send. Shared sends carry `X-AIS-Sent-By`.
- A new inbound message on a waiting thread flips it back to Needs reply, server-side.
- Follow-ups are `admin_reminders` rows, so they already appear on the Work page.

**The client page** (Operations → Clients & weekly log → a client)
- **Websites tab**: main site, ranking sites, GBP, listings, landing pages. Live / NOT LIVE + notes.
- **Where this client stands**: headline + Done + Still needed, counted from that client's tasks,
  weekly logs, emails, follow-ups and websites. "Check the numbers" shows the counts it used. Warns
  when the records have changed since it was written. Badged AI-WRITTEN or COUNTED.

**Proof on record:** lint 0 · `vite build` clean (106 modules, alongside another session's
platform-login work) · `bash tests/inbox/run.sh` **47/47** · Playwright walkthrough of the built app,
screenshot per step · a separate agent's adversarial review, 3 real defects found and fixed (§15).

### STILL NEEDED — in this order

1. **Run `supabase/migrations/0003_inbox.sql`, then `0004_client_page.sql`** in the Supabase SQL editor.
   Until then: no statuses, no client links, no follow-ups, no websites list, no saved summary. Both
   files only create `admin_`-prefixed objects. Click-by-click: `SETUP.md` § 5b.
2. **Deploy.** Cursor → GitHub → Vercel. Nothing in §13–§15 has ever run on admin.aisyndicate.com.
3. **Blocked until `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` exist in Vercel** (SETUP.md
   § 5, ~15 minutes, one time): every Gmail path. Nothing has touched real Gmail — the code up to the
   Google boundary is tested, the boundary itself is not.
4. **Connect growth@ and tick "Shared with the team"** (SETUP.md § 5b). Sign in to growth@ in Chrome
   first; Google connects whichever account is picked on its screen. The tick is the only thing that
   makes the mailbox visible to the other owners/admins.
5. **Blocked until `ANTHROPIC_API_KEY` exists**: the AI-written summary and every AI draft. Both fall
   back gracefully today (COUNTED badge, preview text), so this is a quality step, not a blocker.

### KNOWN GAPS, WRITTEN DOWN RATHER THAN HIDDEN

- **Any mailbox connected before Aug 18 2026 is on the old read-only permission.** The page detects it
  and asks for one reconnect; it cannot fix it silently.
- **No attachment download.** Attachment names are shown, the files are not fetched.
- **Threads only, no per-message actions** — no forwarding, no per-message labels.
- **One reminder per email thread** in the UI. A second one on the same thread is stored but the row
  only shows one.
- **Email status changes are not in the staleness check for a client summary** beyond the three counts
  it watches (total, needing reply, waiting on them). A note edited on an email will not flag it.
- **`admin_email_threads` rows are created lazily** — a thread nobody has touched has no row, which is
  deliberate (connecting a busy mailbox must not write thousands of rows) but means "New" is the
  absence of a record, not a stored value.
- **The AI-written path has never actually run.** Every check exercised the counted path.

### WHERE THE REST LIVES

§13 the inbox · §14 the client page · §15 the review pass and the three fixes ·
`SETUP.md` § 5 and § 5b for the clicks · `tests/inbox/run.sh` for the access proof ·
work log `2026-08-18--internal--admin-shared-inbox-and-client-page.md` and
`2026-08-18--internal--admin-inbox-review-fixes.md`.

---

## §17. Platform login cards — one account per card — Aug 18 2026 (append-only section)

Ryder's ask: *"make the our platform page just have like a card for each account that is the
login for each client we have, so like one for ai syndicate, then one for shiner for example,
one for dahler, etc. that way we can go into every clients accoutn and do work. and also save
that info and login button to the clients page as well."*

Before this, the Our-platform page had ONE sign-in button, pointed at whatever single address
`PLATFORM_ACCOUNT_EMAIL` held. Now it is a list.

### Files

| Piece | File |
|---|---|
| The table | `supabase/migrations/0005_platform_accounts.sql` → `admin_platform_accounts` |
| Shared pure rules (browser + server) | `lib/platform-accounts.js` |
| The card, the click, the add/edit box, the client-page panel | `src/components/admin/platformAccounts.jsx` |
| Read/write | `src/lib/data.js` — `listPlatformAccounts` / `upsertPlatformAccount` / `deletePlatformAccount` (appended at the end of the file) |
| The page | `src/components/admin/PlatformView.jsx` (rewritten) |
| The client-page tab | `src/components/admin/Operations.jsx` — `ClientDetail`, tab `platform` |
| Styles | `src/admin.css` — appended `.adm-pa-*` block |
| Sign-in endpoint | `api/platform-sso.js` (now takes `{ accountId }`) |

### The rule that matters

**`/api/platform-sso` never takes an email from the browser.** It takes an `accountId`, reads
that row from `admin_platform_accounts` with the service key, and mints the link for the email
ON THE ROW. A magic link is a real credential for whoever owns that address — accept an email
from the request body and the endpoint becomes "log me in as anyone who has a platform login,"
including a customer who never handed us their account. Do not "simplify" this by passing the
email.

The complete list of addresses this endpoint can reach: rows in `admin_platform_accounts`, plus
`PLATFORM_ACCOUNT_EMAIL` from the server environment. Nothing else.

**Removed on the same day it was written:** the old fallback to the signed-in member's own
`admin_users.email`. An admin can edit their own `admin_users` row (0001's policy allows it), so
that fallback read "type any address into your own profile, POST an empty body, become them."
A roster field is not a permission. Found by the checker agent, not by the person who wrote it.

Owner/admin only, checked on the server, **including the `?diag=1` branch** — that branch used
to accept any member, which let a sales rep count how many accounts the console can become.
Sales cannot read the table either (RLS).

### Behaviour worth knowing

- No `accountId` in the body → old behaviour: `PLATFORM_ACCOUNT_EMAIL`, else the member's own
  address. The "Use the environment account" button on the page only appears when
  `health.platformAccountSet` is true. Nothing that worked before stopped working.
- A successful mint stamps `last_opened_at` / `last_opened_by`, best-effort — a failed stamp
  must never cost a working sign-in. **Watch the wording:** all anyone here knows is that a link
  was MADE. Whether the platform accepted it happens on the other site. So the toast says
  "Sign-in link made for X", the card says LAST SIGN-IN LINK MADE, and neither says "signed in".
  If Supabase's redirect allow-list is missing the platform origin, the tab lands on an error
  page and nothing on this side can tell.
- `added_by` is stamped by a database trigger from `auth.uid()` on insert and frozen on update.
  The browser cannot claim someone else added a card. Tested: an admin inserting with
  `added_by` set to the owner's id still lands as the admin.
- **Delete is owners only** (RLS), because the table is the record of which logins this console
  can become. If an admin could add a card, use it and delete the row, the record would erase
  itself. Switching a card off is the everyday retire and any admin can do it. The Remove button
  is hidden for non-owners rather than left to fail quietly, and `deletePlatformAccount` counts
  the returned rows so a no-op delete reports a plain no instead of "Removed".
- Unique index on `lower(email)`: one card per login. The duplicate error is rewritten in plain
  words ("That login is already saved on another card"), both live and in preview.
- `client_id` null = ours. The card renders dark (`.adm-pa-card.ours`) so our own account keeps
  the visual weight the single hero card used to have.
- Inactive card (`active = false`): the button is disabled in the UI **and** the endpoint
  refuses it with a 409. UI state is not a guard.
- `vault_url` is a Bitwarden LINK. Passwords never enter this table; the field help says so. The
  modal checks for `https://` on the way in AND `safeHref()` checks again at render, because a
  row typed straight into the SQL editor could carry `javascript:` in an href.
- The email shape is checked in three places and they now agree: `looksLikeEmail()` in the
  shared lib, the modal, and a database CHECK constraint. The constraint used to be
  `position('@' in email) > 1`, which accepted `ops@` — a row that renders a normal card whose
  button can only ever fail.
- The client page owns the one copy of the account list (`usePlatformAccounts` in `ClientDetail`)
  and hands it to `PlatformAccountsPanel`. Same rule as the Operations table — two components
  fetching the same rows is two answers to one question.

### Tested Aug 18 2026

- `npm run lint` — 0 problems, on the Mac bridge.
- `npm run build` — clean in a Linux container, 106 modules, vite 7.3.6. (It cannot run on the
  bridge; §11's note explains why and how to stage it out.)
- **Migrations 0001 → 0005 on a real Postgres 16.13** with a mocked `auth` schema — all five ran
  clean, notices only.
- **RLS attack harness on `admin_platform_accounts`, 9 checks, all correct:** an admin lying
  about `added_by` is overwritten with their own id · an admin rewriting `added_by` later is
  ignored · an admin DELETE affects 0 rows · an owner DELETE affects 1 · sales SELECT returns 0
  rows · sales INSERT is refused by RLS · `ops@`, `a@b` and `has space@b.com` are refused by the
  CHECK · `OK@B.CO` is refused as a duplicate of `ok@b.co` · deleting a client cascades its card.
- Walked in Chromium at `localhost:5173` in preview mode: cards render (ours dark, 3 client
  cards), add saves and the count moves 3 → 4, a bad email is refused with a plain-words toast,
  a duplicate email is refused naming the card that already holds it, the client-page tab shows
  only that client's card with the client picker hidden, and the sign-in button in preview mode
  warns and opens the platform normally. 0 console errors.

Not tested, and nobody should say otherwise until it is: **a real sign-in link.** That needs the
Supabase keys and a real platform account, so every claim about what happens after the tab opens
is reasoning from the endpoint's code, not something watched.

### Open / worth one check when it goes live

- `https://aisyndicate.com` redirected to `https://www.aisyndicate.com` when the preview
  fallback opened it. The SSO path sends the token to the bare origin the server computes,
  and the browser carries a URL hash through a redirect, so it should still land signed in —
  but nobody has watched a real link do it since the www redirect appeared. Watch the first
  live click.
- The browser's platform address now reads `VITE_PLATFORM_URL` (falling back to
  `https://aisyndicate.com`). If `PLATFORM_URL` on the server is ever pointed at staging, set
  the VITE one to match or the plain links and the SSO tab go to different places.
- Nothing bulk-imports accounts; they are added one at a time.
- `sort` exists on the row but there is no drag order in the UI yet.

---

## §18. Finance + Invoices — Aug 20 2026 (append-only section)

Ryder asked for a money page: the summary at the top (his wireframe), then "extremely in depth"
underneath, and a drop-down arrow on Finance in the sidebar opening a second page for invoices.
That is what this is. Nothing above this line was changed except where §18.6 says so.

### §18.1 The one idea the whole thing is built on

**Money in is measured. Money out is typed in. Everything else is worked out from those two, and
says which it is.** Every figure on the page carries a badge:

| Badge | Means |
|---|---|
| MEASURED | From Stripe. Real money that moved. |
| TYPED IN | Somebody entered it here — a cost, an invoice, the bank balance. |
| MEASURED + TYPED | Stripe money minus costs we typed. |
| ESTIMATE | A formula on top of those. True today, wrong when the inputs move. |
| NOT MEASURED | We cannot work it out, and the card says why instead of printing a zero. |

A figure that cannot be honestly worked out prints **"not measured yet"** with the reason. Never 0,
never a guess. That rule is the reason the page can be shown to CJ without a caveat email.

### §18.2 Files

| File | What it is |
|---|---|
| `lib/finance-math.js` | Every calculation, pure. No database, no clock of its own — anything needing "today" is handed it. This is why `tests/finance/test.mjs` can check the lot with no keys. |
| `supabase/migrations/0007_finance.sql` | `admin_expenses`, `admin_invoices`, `admin_invoice_items`, `admin_invoice_payments`, `admin_finance_settings`, RLS, and two triggers. |
| `src/lib/finance.js` | Data layer. Preview store when Supabase is not configured, real tables when it is — same shape both ways. |
| `api/stripe-finance.js` | Owner/admin only. Subscriptions with start and cancel dates, gross charges by month, refunds by refund date, measured card fees, revenue by client, Stripe's own invoices (read only). |
| `src/components/admin/Finance.jsx` | The page. Hero, four tiles, three charts, right rail, then the long version. |
| `src/components/admin/financeParts.jsx` | `Figure`, `Block`, `BasisBadge`, `InOutBars`, `ProfitBars`, `MovementBar`, `RankedBars`, `ListCard`. |
| `src/components/admin/expensesPanel.jsx` | The cost list — add, edit, remove, filter by month. |
| `src/components/admin/Invoices.jsx` | The invoices page. |
| `src/components/admin/invoiceParts.jsx` | Status chip, editor, drawer, and the printable HTML copy. |
| `tests/finance/test.mjs` + `run.sh` | 53 checks, pure logic, run in four timezones. |

Touched: `Sidebar.jsx` (items can now carry children — see §18.3), `AdminDashboard.jsx` (two new
pages, `pageIdsForRole` instead of the old flat list), `Header.jsx` (two titles), `admin.css`
(appended section), `Overview.jsx` (one sentence — see §18.6), `SETUP.md` (migration 0007).

### §18.3 The sidebar drop-down

A `SECTIONS` item can now be `[id, label, children]`. Finance is the first one to use it, with
`[["invoices", "Invoices"]]`. The children are **real pages with their own address**
(`#/dashboard/invoices`), not tabs inside Finance, because invoicing is a job you sit down and do.

Two things to know if another page grows children:

- `pageIdsForRole()` flattens parents **and** children. A child missing from that list behaves
  exactly like a page that does not exist — the dashboard silently falls back to the landing page.
- The caret is a `<span role="button">`, not a `<button>`. A button inside a button is invalid HTML
  and React will not render it reliably. Anything not toggled by hand follows the page you are on,
  so landing on Invoices always shows Invoices.

### §18.4 Decisions that are not obvious

- **Repeating costs.** One row covers every month it runs. `monthly` repeats from its start until an
  end date; `yearly` is divided by twelve across the months it covers, so one January payment does
  not make January look like a disaster. `expenseToMonths()` is the only place this is decided.
- **Card fees are counted once.** Stripe measures the real fee. It is added to the month's costs
  **only** when nobody typed a "Payment fees" cost for that month. A typed figure always wins, and
  the page prints both so a big gap gets noticed.
- **Expansion and contraction are blank, everywhere.** Stripe does not hand back a plan-change
  history, so a client moving up a plan shows as neither gained nor lost. Written on the page, not
  hidden in a zero.
- **Trials are not MRR.** `mrrFromSubs` counts `active` and `past_due`. `trialMrr` is a separate
  line. A promise is not money.
- **Overdue and part-paid are never stored.** Four statuses live in the database — draft, sent,
  paid, void. The other two are worked out from the due date and the payments, so nobody has to
  remember to change anything and two people cannot disagree.
- **The paid total is written by the database**, from a trigger over `admin_invoice_payments`. A
  browser that dies mid-save cannot leave an invoice claiming to be paid. A draft stays a draft even
  if money arrives against it — "sent" is a claim about something *we* did.
- **Invoices copy the client's name and email**, they do not link to them. An invoice is a record of
  what was sent; renaming a client next year must not rewrite a document already in their hands.
- **Print instead of a PDF library.** The printable copy is a whole HTML page opened from a blob URL;
  the browser's "Save as PDF" makes the PDF. No 400 KB dependency shipped to every visitor.
- **This console never writes to Stripe.** Stripe's own invoices are a read-only second tab.
- **Nothing can see a bank account,** so the runway figure is typed in with the date it was true,
  and that date is printed next to it.

### §18.5 The part-month trap, and the one-calendar rule

Two bugs that will come back if anyone edits the bucketing, so they are written down:

1. **The month you are standing in is not finished.** On the 20th it holds two thirds of a month's
   income but a full month of costs. Growing a projection from it predicted a falling business every
   time. `projectForward(..., { partialLast: true, today })` leaves it out of the growth sum and
   compounds an extra step over it, and the runway figure uses the last **finished** month.
   Everything comparing "this month" to a finished one prints "20 of 31 days in" beside it.
2. **One calendar for the page.** Stripe buckets in UTC, a browser in Chicago buckets locally, and
   for a few hours around the 1st they disagree about which month it is. The server now returns a
   month map it built itself and the page uses the server's month list as its calendar. Expense
   dates are plain `YYYY-MM-DD` strings with no zone, so they slot into either the same way.
   Related and just as sharp: `new Date("2026-08-01")` is **midnight UTC**, which in Chicago is the
   evening of July 31. `monthKey`, `dateOnly`, `daysBetween` and `addDays` all read the string
   instead, and due dates are compared as strings. The first of the month is the most common billing
   day there is.

### §18.6 One change outside this feature

`Overview.jsx` gained a single sentence under its MRR figure: trials are counted there, and the
Finance page keeps them separate, so the two read differently while a trial is running. Two pages
showing two numbers under one label was the confusing part — saying which is which fixes it without
touching `api/stripe-metrics.js`, which older code depends on.

### §18.7 How it was proven, Aug 20 2026

- `npx eslint .` clean. `npx vite build` clean, 121 modules.
- `bash tests/finance/run.sh` **53/53**, run under `America/Chicago`, `Asia/Tokyo`, `UTC` and
  `Pacific/Auckland` — the timezone bugs above are exactly the kind that pass in one zone.
- `tests/brain` 52/52 and `tests/inbox` 47/47 still pass, so nothing older broke.
- Playwright walked the **built** bundle (see §12 — the Chrome extension wedges the dev server):
  Finance renders, the caret collapses and reopens Invoices, an invoice opens, a part payment flips
  it to PAID and every total on the page moves with it, a new invoice is numbered AIS-0006 and saves,
  the live total tracks the lines as they are typed, a cost is added and the profit numbers change,
  the printable copy opens with the right totals, and the page holds up at 430px wide. 0 console
  errors.
- **Two adversarial review passes by a separate agent, not the one that wrote it.** The first found
  13 real defects — all fixed, listed here so they are not reintroduced: UTC date parsing (§18.5);
  gross margin ignoring the measured card fee; a subscription signed and cancelled in the same month
  inflating the starting MRR; failed checkouts counted as new clients; the invoice editor's footer
  total not matching what got saved when a line had no description; the projection dropping an empty
  current month and then drawing it twice; days-to-pay reading −1 for a same-day payment; line items
  deleted before the replacements were inserted; refunds rewriting the month of the original charge;
  the runway figure built on the part month; a failed settings read printing sample company details
  on a real invoice; `created_by` being forgeable by an admin; and revenue bucketed on two calendars.
  The second pass checked the fixes and found 14 follow-ons — the calendar mismatch above, three more
  `new Date("YYYY-MM-DD")` sites, the new-client count still including trials, fixed-plus-variable no
  longer adding up to the total beside it, the Overview mismatch, the editor blaming the wrong field,
  and preview mode drifting from the database on a removed payment. All fixed.

### §18.8 What is still needed

1. **Run `0007_finance.sql`** in the Supabase SQL editor (SETUP.md § Migration 0007). Nothing saves
   until then.
2. **Type in the costs.** Money out does not exist until somebody enters it. Start with the monthly
   ones.
3. **Type in the bank balance** (Finance → Update, top right) or the runway figure stays blank.
4. Blocked until `STRIPE_SECRET_KEY` exists in Vercel: every MEASURED figure. The pages are wired and
   say WAITING ON KEY rather than guessing.
5. Deploy — none of this has ever run on admin.aisyndicate.com.

### §18.9 Known gaps, written down rather than hidden

- Plan upgrades and downgrades are not tracked (see §18.4), so expansion, contraction, and the part
  of NRR that depends on them are blank.
- Stripe figures cover the last twelve months and are capped at 1,000 rows per resource; the reply
  carries `truncated` and the page prints it.
- Client totals net a refund against the client it came from, while the month totals net it against
  the month it was issued. If a refund crossed a month boundary the two differ; the page says so.
- No email send from the Invoices page yet. There is a "Copy email text" button and the printable
  copy; wiring it to the Gmail send endpoint is a small job and was left out on purpose rather than
  half-built.
- Nothing reconciles a Stripe invoice against one of ours. They live in two tabs and do not know
  about each other.
- The cost list has no receipt upload — a link only, same rule as everywhere else in this console.
