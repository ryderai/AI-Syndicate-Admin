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

---

## §19. Every number on the Finance page — the exact maths — Aug 20 2026 (append-only section)

Ryder asked for the maths itself to live in context, not just the design. This is that: every figure
the Finance and Invoices pages print, the formula behind it, what feeds it, and what makes it go
blank. **All money is integer cents.** Every function named here is in `lib/finance-math.js` unless
it says otherwise, and every one is covered by `tests/finance/test.mjs`.

Read §18 first for *why* it is built this way. This section is the *what*.

### §19.0 The three inputs everything is built from

| Input | Where it comes from | Shape |
|---|---|---|
| Subscriptions | `api/stripe-finance.js` → Stripe `subscriptions.list({status:"all"})` | `{id, customerName, plan, status, mrrCents, lastMrrCents, created, canceledAt}`. `created`/`canceledAt` are **unix seconds**. |
| Money in, per month | `api/stripe-finance.js` → `charges.list` (gross) minus `refunds.list` bucketed by refund date | `revenueByMonth = { "2026-08": cents }`, UTC months. **This map is the page's calendar.** |
| Money out | `admin_expenses`, typed in by us | `{incurred_on, ended_on, category, vendor, amount_cents, interval, client_id, counts_toward_cac}` |

Plus two smaller ones: `admin_invoices` + `admin_invoice_payments` (everything in §19.6), and
`admin_finance_settings.cash_on_hand_cents` (the bank balance, typed in, used only by runway).

### §19.1 Recurring revenue

| Figure | Formula | Notes |
|---|---|---|
| **MRR** | `Σ mrrCents` over subs whose status is `active` or `past_due` | `mrrFromSubs()`. `PAYING_STATUSES = ["active","past_due"]`. Trials are **excluded**. |
| One subscription's monthly value | `Σ over items: unit_amount × quantity ÷ interval` — a year price ÷ 12, a week price × 52 ÷ 12, a day price × 365 ÷ 12, and any of them ÷ `interval_count` | `subscriptionMrrCents()` in `lib/stripe-server.js`. Older code (`api/stripe-metrics.js`) uses the same function. |
| **Trial MRR** | `Σ mrrCents` over subs with status `trialing` | `trialMrr()`. Printed on its own line under MRR — a promise, not money. |
| **Yearly run rate (ARR)** | `MRR × 12` | `arrFromMrr()`. Not a forecast: what a year at today's rate comes to. |
| **Projected MRR, +3 months** | `MRR × (1 + g)³`, where `g` is the growth rate from §19.4 | Estimate. Blank when there is not enough finished history to work out `g`. |
| **Paying clients** | count of subs with status `active` or `past_due` | Trials are counted separately and named as trials in the rail list. |
| **Average client value (ARPA)** | `MRR ÷ paying clients` | `arpa()`. Blank when there are no paying clients — not zero, not infinity. |

### §19.2 What moved inside MRR this month — `mrrMovement()`

Let `M` be the month being asked about.

```
started        = subs created in M, excluding status incomplete / incomplete_expired
startedPaying  = started ∩ (active | past_due)
cancelled      = subs cancelled in M that were NOT ALSO created in M
inAndOut       = subs created in M AND cancelled in M

newMrr    = Σ mrrCents over startedPaying
churnMrr  = Σ (lastMrrCents or mrrCents) over cancelled
endMrr    = MRR today
startMrr  = max(0, endMrr − newMrr + churnMrr)

newCount        = |started|          ← subscriptions that began
newPayingCount  = |startedPaying|    ← the ones that actually pay
churnCount      = |cancelled|
inAndOutCount   = |inAndOut|
```

Three rules baked into that, each of which was a real bug first:

- **`lastMrrCents` exists because Stripe reports 0 MRR on a cancelled subscription.** Without it,
  churn would always read as $0 — the flattering kind of wrong.
- **A subscription signed and cancelled inside the same month is in neither figure.** Adding it to
  `churnMrr` would add it to a `startMrr` it was never part of, inventing revenue that never
  existed. It is counted as `inAndOutCount` and said out loud under the bar.
- **A checkout that never completed is not a new client.** `incomplete` and `incomplete_expired`
  are dropped before anything is counted.

**Expansion and contraction are `null`, always**, with `expansionMeasured: false`. Stripe hands back
no plan-change history, so a client moving between plans shows as neither gained nor lost. The page
says that in words rather than drawing a zero.

### §19.3 Money out — `expenseToMonths()` and friends

One expense row lands in months like this:

| `interval` | Months it lands in | Amount per month |
|---|---|---|
| `one_time` | the month of `incurred_on` only | the whole `amount_cents` |
| `monthly` | every month from `incurred_on` to `ended_on` (or forever if `ended_on` is null) | `amount_cents` |
| `yearly` | same range as monthly | `round(amount_cents ÷ 12)` |

Everything else is a roll-up of that:

```
moneyOut(M)   = Σ expenseToMonths(e, M) over every expense e
                + measuredCardFee(M)  ONLY IF nobody typed a "Payment fees" cost for M

byCategory(M) = the same, grouped by e.category
byVendor(M)   = the same, grouped by e.vendor, biggest first
fixed(M)      = Σ categories in ["Software","Hosting & domains","Office & admin"]
variable(M)   = everything else + the measured card fee
breakEven(M)  = fixed + variable            ← the money in needed just to cover the month
```

**Card fees are counted once, never twice.** Stripe measures the real fee per charge (via the
expanded balance transaction). It is added only for months with no typed "Payment fees" cost; a
typed figure always wins, and the page prints both so a big gap gets noticed.

**AI spend is cross-checked, not merged.** The usage feed measures what the AI actually cost; the
typed "AI & APIs" cost is what every number uses. When the two differ by more than 25% (or $20,
whichever is larger) the page says so.

### §19.4 Profit, margins and the projection

```
profit(M)      = moneyIn(M) − moneyOut(M)
netMargin(M)   = profit(M) ÷ moneyIn(M) × 100

deliveryCost(M) = Σ categories ["Contractors","AI & APIs","Client costs","Payment fees"]
                  + measured card fee if it was added in §19.3
grossMargin(M)  = (moneyIn(M) − deliveryCost(M)) ÷ moneyIn(M) × 100
costToServe(M)  = deliveryCost(M) ÷ paying clients
```

Gross margin answers "is the work itself profitable"; net margin answers "is the business
profitable". They are different questions, so both are printed.

**The projection — `projectForward(series, 3, { partialLast: true, today })`:**

```
real     = the 12-month series with EMPTY MONTHS TRIMMED OFF THE ENDS ONLY
complete = real minus the month we are standing in          ← it is not finished
window   = the last ≤6 months of `complete`
g        = mean over window of (revenue[i] − revenue[i−1]) ÷ revenue[i−1]
g        = clamp(g, −20%, +20%)                             ← one freak month cannot run away
cost     = mean cost of the last 3 finished months
steps    = months from the base month to the last month drawn on the chart
revenue(n) = round( base.revenue × (1 + g)^(steps + n) )    for n = 1, 2, 3
```

Empty months are trimmed from the **ends only**, never out of the middle — filtering them
everywhere used to delete the current month and then project it again, drawing two bars for one
month. The method sentence printed under the chart is generated from these exact numbers, so the
page can never claim a method it did not use.

**Runway:**

```
runway = cash_on_hand ÷ |profit(last FINISHED month)|      when that profit is negative
       = "no limit / profitable"                          when it is positive
       = blank, with the reason                           when it is exactly 0, when the last
                                                          finished month has no money in it at all,
                                                          or when nobody has typed the bank balance
```

It deliberately does **not** use the current month: this month books a full month of costs on day
one against however much has cleared so far, so on the 2nd it would report a burn that never
happened.

### §19.5 The client numbers

Every one of these is a formula on top of §19.1–§19.4, so every one is badged ESTIMATE on screen
unless it is a plain count.

| Figure | Formula | Blank when |
|---|---|---|
| **Cost to win a client (CAC)** | `(Σ Ads costs in M + Σ costs ticked "won us clients" in M) ÷ new PAYING clients in M` | nobody started paying in M — dividing by zero is no answer, not infinite cost |
| **Clients lost (churn %)** | `churnCount ÷ startOfMonthClients × 100`, where `startOfMonthClients = max(0, payingClients + churnCount − newPayingCount)` | we started the month with nobody |
| **Money lost (revenue churn %)** | `churnMrr ÷ startMrr × 100` | `startMrr` is 0 |
| **How long a client stays** | `100 ÷ churn%` months | churn is 0 — no losses means no honest answer, not an infinite lifetime |
| **What a client is worth (LTV)** | `ARPA × (grossMargin% ÷ 100) × lifetimeMonths` | any input above is blank |
| **Worth ÷ cost to win** | `LTV ÷ CAC` | either side blank. Above 3× is the usual healthy line |
| **Months to earn a client back** | `CAC ÷ (ARPA × grossMargin% ÷ 100)` | any input blank |
| **Revenue kept (NRR)** | `(startMrr + expansion − contraction − churnMrr) ÷ startMrr × 100`, with expansion and contraction **0 and flagged not-measured** | `startMrr` is 0 |
| **Gained vs lost (quick ratio)** | `(newMrr + expansion) ÷ (churnMrr + contraction)` | nothing was lost — the good version of no answer, and it says so |
| **Biggest client's share** | `topClient ÷ Σ all clients × 100` over 12 months of paid charges | no paid charges |
| **Clients making half the money** | how many clients, largest first, it takes for the running total to reach 50% | no paid charges |

### §19.6 Invoices

```
line.amount   = qty × unit_cents
subtotal      = Σ line.amount
discount      = min(typed discount, subtotal)          ← an invoice can never go negative
tax           = round((subtotal − discount) × taxPct ÷ 100)
total         = subtotal − discount + tax
outstanding   = max(0, total − amount_paid)            ← 0 for a draft or a cancelled invoice
```

`amount_paid_cents` is **written by the database**, by a trigger over `admin_invoice_payments`, not
by the browser. `invoiceTotals()` recomputes the totals from the lines on every save — the number in
the form is never trusted.

**Status is worked out, not stored.** Only `draft`, `sent`, `paid`, `void` live in the table;
`effectiveInvoiceStatus()` derives the rest, and the SQL trigger follows the same rules so the two
can never disagree:

```
void                                              → void
draft                                             → draft (even if money arrives against it)
paid ≥ total                                      → paid
0 < paid < total, due date in the future or today → part paid
0 < paid < total, due date in the past            → overdue
paid = 0,        due date in the past             → overdue
otherwise                                         → sent
```

An invoice due **today** is not overdue today. Dates are compared as plain `YYYY-MM-DD` strings.

```
aging bucket    = days between due_date and today → not due / 1–30 / 31–60 / 61–90 / 90+
avgDaysToPay    = mean over fully paid invoices of max(0, paid_at − (sent_at or issue_date)), by DATE
billed          = Σ total over invoices that are not draft and not cancelled
collected       = Σ amount_paid over the same set
collected%      = collected ÷ billed × 100
nextNumber      = prefix + (highest trailing number ever used + 1), padded to 4 digits
```

### §19.7 The dates, one more time, because this is where the bugs live

- `new Date("2026-08-01")` is **midnight UTC** — the evening of July 31 in Chicago. `monthKey()`,
  `dateOnly()`, `daysBetween()` and `addDays()` all read the string instead. Never hand a plain
  `YYYY-MM-DD` to `new Date()` anywhere in this feature.
- `daysBetween()` reduces both sides to a plain date before subtracting, so a full timestamp
  compared against a date-at-midnight cannot produce −1 days.
- Stripe timestamps are **unix seconds in UTC**; `monthKeyUtc()` / `monthOf()` handle those.
- **One calendar.** The server builds the month keys and the month map; the page uses the server's
  month list rather than re-bucketing days. Expense dates are zoneless strings and slot into either.

### §19.8 The badge each figure carries, decided in code

| Badge | Set when |
|---|---|
| MEASURED | the value came straight from Stripe |
| TYPED IN | it came from `admin_expenses`, `admin_invoices` or the settings row |
| MEASURED + TYPED | a Stripe number with typed costs subtracted |
| ESTIMATE | a formula from §19.4 or §19.5 |
| NOT MEASURED | the value is `null`; the card prints the reason instead of a number |
| SAMPLE | preview mode, or the live source has not answered yet |

`Figure` in `financeParts.jsx` forces this: pass a `null` value and it prints "not measured yet"
with the `why` line and flips the badge to NOT MEASURED on its own. It is not possible to print a
zero for something that was never measured without deleting that component's logic.

---

## §20. STATE BOARD — replaces §16 as the current picture (Aug 20 2026, end of session)

§16 is the Aug 18 board and stays as history. This is where things actually stand.

### BUILT AND WORKING (in the repo, still not deployed)

Overview · Work · Leads (with import + scraping) · Operations · Inbox (shared growth@) · Tickets ·
Notes (self-writing) · AI Brain + memory · the assistant · client pages with standing · platform
login cards · Team · Settings · **Finance** · **Invoices**.

### STILL NEEDED — in this order

1. **Run the migrations that are not run yet**, `0006_brain_notes_leads.sql` and
   `0007_finance.sql`, in the Supabase SQL editor. Until each is run, its pages open, say SAMPLE,
   and save nothing.
2. **Deploy.** Nothing in this console has ever run on admin.aisyndicate.com.
3. **`STRIPE_SECRET_KEY` in Vercel** — every MEASURED figure on Finance, Customers and Overview is
   waiting on it and says WAITING ON KEY rather than guessing.
4. **Type the costs in** (Finance → The cost list). Money out does not exist anywhere else.
5. **Type the bank balance in** (Finance → Update) or runway stays blank.
6. `ANTHROPIC_API_KEY` for the AI drafting and the assistant; `USAGE_INGEST_KEY` for the token feed.

### KNOWN GAPS, WRITTEN DOWN RATHER THAN HIDDEN

- Plan upgrades and downgrades are not tracked, so expansion, contraction and the part of NRR that
  depends on them are blank everywhere (§19.2).
- Stripe reads cover the last twelve months and cap at 1,000 rows per resource; the reply carries
  `truncated` and the page prints it.
- No email send from the Invoices page — a "Copy email text" button and a printable copy instead.
- Nothing reconciles a Stripe invoice against one of ours; they sit in two tabs.
- Receipts are links, never files.
- The cost list is the only source of money out, so the profit line is exactly as honest as what
  somebody typed.

---

## §21. Notes, the memory, the always-on assistant, and lead intake — Aug 20 2026 (append-only section)

**Numbering note.** This work was written up as §18/§19 earlier the same day and was lost, then briefly re-filed as §20 which was also already taken: a
concurrent session building the Finance page rewrote this whole file and took those numbers. Same
class of collision as the work log used to have — see the note at the end of §22. The work itself
was never at risk; only these two markdown files were.

Ryder's ask, in his own words: *"a notes page that is AI driven and auto fills notes based on
what is in circulation and what needs follow ups and what needs attention… i want that brain to
remember everything and just have an insane amount of context that feeds every AI response…
a chatbot that runs off that brain that is always on the screen and can see what were looking at
on the screen for added context and then answer based off of everything in the system and
actually carry out tasks for us… the leads page needs the import sheets of leads and then also
scrape leads from the lead generator in the platform… and have the salesperson login that can
manage and do all of it and have it all talk to each other."*

### The one idea the whole thing rests on

**Every AI answer in this console is written against the real rows, and says what it read.**

Before this, an AI call saw the handful of rules on the Brain page plus whatever the calling
screen pasted in. So it could follow the house style perfectly and still not know that a client
had three tasks past their date. It sounded right and knew nothing.

`lib/brain-context.js` reads the actual tables and renders them as plain text. Every `/api` route
that talks to an AI goes through it. Under the assistant's answer, and under the Brain page's test
chat, the console prints what was read: `READ 12 clients · 41 tasks · 88 leads …`. A thin answer
and a thin dataset look identical without that line.

### Files

| Piece | File |
|---|---|
| The context engine — what the AI is allowed to see, and how much | `lib/brain-context.js` |
| The notes engine — counts the notes, no AI involved | `lib/notes-engine.js` |
| What the assistant may DO, and the code that does it | `lib/assistant-tools.js` |
| The Anthropic tool-use loop | `lib/ai-agent.js` |
| Lead cleaning + the duplicate rule | `lib/lead-intake.js` (browser doorway: `src/lib/leadIntakeBrowser.js`) |
| The assistant endpoint | `api/ai-chat.js` |
| Writing the Notes page | `api/notes-generate.js` |
| Running a saved lead search (+ the daily cron) | `api/lead-scrape.js` |
| A .xlsx reader with no library | `src/lib/sheet.js` |
| What page you are on, stated by the page | `src/lib/screenContext.js` |
| The floating assistant | `src/components/admin/Assistant.jsx` |
| The Notes page | `src/components/admin/NotesPage.jsx` |
| What the AI has remembered (on the Brain page) | `src/components/admin/brainMemory.jsx` |
| Import + saved searches | `src/components/admin/leadsIntake.jsx` |
| Tables | `supabase/migrations/0006_brain_notes_leads.sql` |
| Tests | `tests/brain/` — `bash tests/brain/run.sh` |

### Rules that must not be broken here

1. **Role scoping lives in `SCOPE_BY_ROLE` and is enforced TWICE.** A sales rep sees leads, lead
   activity, lead sources, **their own** reminders and the team roster. Nothing else — not
   fetched, not rendered. `loadSystemContext` decides what to READ; `renderContext` decides what
   to PRINT, and re-checks. Both are needed: the fetch gate misses any caller that hands over a
   fuller snapshot. Every `/api` file here runs on the service role, which ignores row-level
   security, so this JavaScript **is** the guard. Trap #8 is this mistake made once already.
2. **Every list is fetched at `cap + 1` and printed at `cap`** (`fetchCap()`). That one extra row
   is what makes "AT LEAST N more were not shown" reachable. Fetch and print at the same number
   and the warning is dead code — the AI is told it saw everything, every time, and answers
   "nobody is chasing X" from 90 of 400 leads with total confidence.
3. **Notes are COUNTED first, reworded second, and the badge says which.** `computeNotes()` does
   the counting with no AI anywhere near it; if the AI key is missing that is still the whole
   page and the page is still right. The rewrite is checked with `rewriteIsFaithful` — which
   compares **numbers only**. Be exact about that: a rewrite that swapped a client's name would
   pass. That is why the badge and the evidence chips exist.
4. **A note with no evidence is never created.** `computeNotes` refuses. The evidence array holds
   the exact rows, and the page prints them.
5. **A person's decision on a note outlives a re-run.** Done and dismissed hold for 14 days
   (`DECISION_HOLDS_DAYS`); a re-raise after that is a NEW row, never an edit of the old one.
   Only OPEN rows are ever marked superseded.
6. **The assistant cannot delete anything, at any role.** There is no delete tool. It also cannot
   blank a lead's notes — an empty string is refused rather than written as null.
7. **Every assistant action is logged before the answer is built** (`admin_assistant_log`), and
   if the log write fails the person is told in the chat. `logToolRun` must READ the `error` from
   the insert — Supabase resolves with `{error}` instead of throwing, so `await` inside a
   try/catch succeeds no matter what went wrong.
8. **The duplicate rule exists three times and they are checked against each other.**
   `lib/lead-intake.js` (browser, so an import can say "12 of these are already here" before it
   saves), `admin_lead_dedupe_key` in 0006 (stamps the key), and the browser doorway that
   re-exports the first. `bash tests/brain/sql-crosscheck.sh` stands up a real Postgres, applies
   every migration, and diffs the two answers over `tests/brain/dedupe-cases.json`.
9. **`dedupe_key` is NOT unique, deliberately.** Two real businesses share a switchboard number.
   A hard constraint would reject the second at 3am with nobody watching; duplicates are caught
   and SHOWN at import time, where a person decides.
10. **Days are counted in the team's calendar, not UTC** (`TEAM_TZ`, America/Chicago). Reminders
    are stored at `T14:00:00Z` = 9am Central.
11. **`Date.parse(x || 0)` is banned.** `"0"` parses as the year 2000, so a null date wins every
    oldest-first sort. Use `parseWhen()`, which gives NaN.
12. **The screen context is STATED by each page, never scraped from the DOM.** `useScreenContext`
    takes a page name, the open record, and up to 25 short labels. Scraping would have been less
    code and would quietly have picked up anything that happened to be rendered.

### Lead scraping — wired for real, waiting on a key

Two providers, either sufficient: `PLATFORM_LEADGEN_URL` (+ optional `PLATFORM_LEADGEN_KEY`) for
our own lead generator, or `APOLLO_API_KEY`. Neither is set on this project. With no key the
endpoint returns 503 naming the exact variable, the source card says so, and nothing pretends to
have run. Three things bound the spend: a per-run cap on the source (`daily_cap`, max 500), one
page of results per run with no automatic paging, and `auto_daily` off by default. The daily run
is `GET /api/lead-scrape` behind `CRON_SECRET`; without that secret the scheduled path is closed
rather than open. `vercel.json` schedules it weekdays at 13:00 UTC (8am Central).

### Reading Excel without a library

`src/lib/sheet.js`. An .xlsx is a zip of XML, and the browser can already unzip
(`DecompressionStream("deflate-raw")`), so a spreadsheet library — ~800 KB on a page that ships
under 400 KB — was not worth it for one button. Known limits, written down rather than hidden:
formulas read as their last saved value; dates come back as Excel's number; only the first tab is
read. **Which tab is "first" comes from `workbook.xml` + `xl/_rels/workbook.xml.rels`, not from
the file names** — `sheet1.xml` is creation order, not tab order, so pairing them told the person
it had read one tab while reading another.

### How it was proven (Aug 20 2026)

- `npm run lint` — 0 problems. `vite build` — clean, 114 modules.
- `bash tests/brain/run.sh` — **78 passed, 0 failed**, including a real .xlsx fixture read end to
  end and a set of tests that read the CREATE TABLE statements out of the migrations and check
  every column the code touches actually exists.
- `bash tests/inbox/run.sh` — 47 passed, unchanged.
- `bash tests/brain/sql-crosscheck.sh` — real Postgres 16, all six migrations applied clean and
  re-applied clean, **24/24 dedupe cases identical** between the JavaScript and the SQL.
- The four writes that were broken (see §22 finding 1) proven to succeed against that same
  Postgres, using the exact row shapes the code builds.
- Playwright walkthrough of the BUILT bundle, screenshot per step: Notes, the note→task modal,
  the assistant with its screen chip, the Brain's memory block, the rep queue, saved searches,
  the import mapper, and the duplicate report.
- A separate agent reviewed the diff adversarially and found **15 real defects**, all fixed —
  see §22.

### Still open

- Nothing here has run against real Gmail, a real Anthropic key, or a real lead provider. The
  code up to each boundary is tested; the boundaries are not.
- The AI rewrite path on the Notes page has never run with a live key. The counted path has.
- Attachments, paging past one provider page, and per-tab .xlsx choice are all not built.
- `admin_brain_memory.use_count` is never incremented (only `last_used_at` moves).

---

## §22. Review pass on §21 — Aug 20 2026 (append-only section)

A separate agent was given the diff and told to assume it was wrong. It found **15 real defects**.
All are fixed. They are written down because most of them are the kind that come back.

### 1. HIGHEST — three files wrote columns the tables do not have

`admin_tasks` has **`name`** and **`latest_report`**. It has no `title` and no `notes`.
`admin_reminders` has **`body`**, not `title`, and `body` is NOT NULL. `admin_weekly_log` has
`what_we_did` / `what_moved` / `whats_next`, not `summary`.

What that actually cost:

- `create_task` and `create_reminder` could **never succeed**, for any role.
- Task search errored every time.
- The AI's whole task list rendered as `- [todo]  — Harbor, Ryder, due LATE by 3d`. **It never
  saw a single task name**, and answered questions about tasks anyway.
- Notes read `The oldest is "undefined" — 6 days past its date`, and those words were written
  into `admin_ai_notes` and shown on the page.
- The weekly log read as blank for every client, so the assistant would report a client's log
  empty while it was full.
- "Make it a task" and "Remind me" on a note failed 100% of the time — the second also set
  `link_type = 'note'`, which the old check constraint rejected outright (0006 now widens it).

**Why the tests did not catch it: the fixtures had invented the same wrong names.** A test that
agrees with the code is not a test. `tests/brain/test.mjs` now reads the CREATE TABLE statements
out of `supabase/migrations/` and checks every column the code touches against them, plus named
checks for these three specific mistakes.

### 2. HIGH — a sales rep's context carried every owner's follow-ups

`admin_reminders` was loaded with no `owner_id` filter and rendered in full. A rep could ask the
assistant to read out the owners' follow-ups. Now filtered at load **and** again at render
(`canSee` answers yes/no; "their own" is a filter, which it cannot express).

### 3. HIGH — the "rows not shown" warning could never fire

Every list was fetched with `.limit(CAP)` and printed with the same `CAP`, so `lines.length >
cap` was impossible. The warning the file's own header calls essential never fired once. Fetch is
now `cap + 1`. Leads were worse: won/lost were filtered **after** the cap, so the section could
silently show 60 of 400. The won/lost filter moved into the query, and a second small read puts
the recently-touched leads back — sorting coldest-first had been dropping exactly the leads a
"what closed this week" question needs.

### 4. HIGH — "every write is logged" was not true

`logToolRun` never read the `error` from its insert and returned `true` regardless, which made
the "could not be logged" warning in `api/ai-chat.js` unreachable. Deploy before running 0006 and
the assistant would change leads, tasks and email statuses with nothing written down and no
warning anywhere.

### 5. HIGH — the SQL and JavaScript duplicate rules disagreed

The SQL stripped `^https?://` **case-sensitively** and never lowercased first, so
`HTTPS://WWW.X.com/about?q=1` keyed as **`d:https:`** where the browser said `d:x.com`. Every
hand-added lead with a scheme-prefixed website collapsed onto one shared key, and the same
business added by hand and then imported would be dialled twice. It also keyed on any non-empty
email, so a sheet with `email = "N/A"` stamped **every one of those leads `e:n/a`**. The function
was rewritten to clean each field first and then pick the strongest survivor — the same shape as
the JavaScript. `tests/brain/sql-crosscheck.sh` now proves it over 24 cases in a real Postgres.

### 6. MEDIUM — an unparseable person silently meant "unassign"

`person()` returned `null` for anything that was not a uuid. "Assign that lead to Andrew" — where
the model passes the string `"Andrew"` — **unassigned the lead** and printed
`✓ DID THIS · owner_id → none`. It now returns a sentinel and every caller refuses.

### 7. MEDIUM — a dismissed note came straight back

The generator read only OPEN notes, so a dismissed one had no match and a fresh open row was
inserted with the same fingerprint (the unique index is partial on open rows, so it allowed it).
Click "Not a thing", press "Write today's notes", and it was back. Decisions now hold for 14 days
and a re-raise afterwards is a new row.

### 8. MEDIUM — the AI rewrite could never run on a real console

The whole note set went in one call, and `lib/ai.js` caps context at 6,000 characters and the
reply at 1,200 tokens. Past about ten notes the prompt was cut mid-note and the page always said
"the rewrite came back in the wrong shape". Now five per call. The body regex was also cut at its
first line by `$` under the `/m` flag, so any two-line rewrite lost half of itself.

### 9. MEDIUM — `update_lead` could erase a lead's notes

`clean("")` returns null, and that null was written — in a file whose header says nothing here
deletes anything. Blanking notes is now refused and stays a human action.

### 10. MEDIUM — days were counted in UTC

A task due today read as "LATE by 1d" from 7pm Central, and the Notes page raised it that
evening, every evening. Reminders were stored at `09:00Z` = 4am Central, already overdue by
breakfast. Both fixed (`TEAM_TZ`, `14:00Z`).

### 11. MEDIUM — `Date.parse(x || 0)` reads a missing date as the year 2000

`"0"` parses as 2000-01-01, so a row with no date won every oldest-first sort — and the note then
read `The oldest arrived unknown.` Replaced with `parseWhen()`, which gives NaN, and the note now
says "None of them has a date on it" instead.

### 12. LOW — the .xlsx reader named the wrong tab

The sheet parsed was `sheet1.xml` (creation order); the name came from the first `<sheet>` in
`workbook.xml` (tab order). Reorder tabs in Excel and it read one tab while telling the person,
in writing, that it read another. It now follows the relationship id through
`xl/_rels/workbook.xml.rels`, and says "the first tab" rather than guessing a name.

### 13. LOW — the rest

- A malformed XML entity threw `RangeError` out of `String.fromCodePoint` and took down the whole
  import. Now left as written.
- The notes engine skipped leads in an unrecognised stage while the Work page treats them as
  stale after 7 days, and it chased leads who had already become customers. Both aligned.
- A sales rep's import silently lost its link back to the source file (0006 restricts creating a
  lead source to admins). The failure is now said out loud.
- `member.role.toUpperCase()` with no guard blanked the whole screen for a signed-in user whose
  `admin_users` row had not loaded. Unknown role now falls back to the narrowest one.
- `search` with `what: "constructor"` found a prototype function and died in destructuring.
  Now `Object.hasOwn`.
- Comments cited `tests/leads/test.mjs` and `tests/notes/test.mjs`, neither of which existed, and
  claimed the rewrite guard checked titles when it only checks numbers. All corrected.

### What the review got right that is worth generalising

Every one of the top five came from **assuming a schema instead of reading it**, or from
**writing a guard whose failure mode is silence**. The first is now a test that reads the
migrations. The second is the reason `fetchCap`, the `logToolRun` return value, and the sentinel
in `person()` all exist: each turns a silent wrong answer into a visible one.

### Not fixed, on purpose

- `admin_brain_memory.use_count` is still never incremented. It is unused; incrementing it on
  every read would be a write on every question for a number nobody looks at.
- The `.or()` search filter and the endpoint auth were both reviewed and found sound.

---

### THIS FILE COLLIDES BETWEEN SESSIONS — read before appending

`CONTEXT-FOR-AI.md` and `SETUP.md` have the exact problem the work log was restructured to escape,
and it bit on Aug 20 2026: two sessions ran that afternoon, one building Finance and one building
Notes. Both appended. The second to finish rewrote the whole file, and **an entire §18 and §19
write-up was silently erased** — no error, no conflict, nothing to notice. It was only found the
next time someone grepped for it. The sections above are the restored copy, and they are numbered
§21/§22 because §18–§20 had been taken in the meantime.

The code was never at risk. `git status` still showed every new file, and the two sessions' edits
to `AdminDashboard.jsx`, `Sidebar.jsx`, `Header.jsx`, `data.js` and `vercel.json` merged cleanly —
because those were small, targeted, single-line insertions. It is the **whole-file markdown append**
that loses work.

So, before appending here:

1. **`grep -n "^## §" CONTEXT-FOR-AI.md` first.** Never assume the next number. Three numbers were
   burned on Aug 20 alone.
2. **Append in ONE shot with a heredoc**, never read-modify-write the whole file.
3. **Read it back and confirm your section AND the ones before it are still there** — the same
   rule project memory already has.
4. **If your section is gone, do not hunt for it in git** — an uncommitted append is not in git.
   Re-append it under a fresh number and say what happened, as this section does.
5. The safest long-term fix is the work log's: one file per session in a folder. If this file gets
   clobbered a second time, split it into `context/NN-topic.md` rather than writing this note again.

---

## §23. The Vault — passwords, cards and keys — Aug 21 2026 (append-only section)

Built at Ryder's ask: *"a passwords section... every customer has passwords that show the name,
description, login, password, etc... I also want to add credit card option too... similar to how
Bitwarden works."*

Two choices he made before the build, both on the record because they shape everything below:

| Question | His answer |
|---|---|
| Where do the secrets live? | **Encrypted in our own database.** Not "a Bitwarden link only". |
| Who can do what? | **Owners and admins, everything the same.** Sales: nothing at all. |

**This changes a standing rule.** The old rule was "passwords never go into notes or Notion — a
Bitwarden link only", and it is still right about notes and Notion. Bitwarden stays the master
copy: every vault item can carry a Bitwarden link, and the page says so. What changed is that the
console now also holds them, scrambled, so the team can see WHAT we hold and WHOSE it is without
opening another app.

### The one idea the whole thing is built on

**The list is open. The secrets are not.**

The readable half — name, client, username, website, card brand, last 4, expiry, notes, tags —
sits in ordinary columns that anybody with console access can read. The secret half — password,
two-factor seed, full card number, security code, PIN, API key, private note — is ONE scrambled
text column, `secret_cipher`, and the key that unscrambles it is not in the database. It is one
Vercel environment variable, `VAULT_KEY`, that only the server can read.

So a stolen copy of the database is a list of names and last-4s. It is not a list of passwords.
That is the entire point, and it is why:

- the browser never selects `secret_cipher` (`VAULT_COLUMNS` in `src/lib/data.js`),
- a database trigger refuses to let anybody but the server write it,
- and `VAULT_KEY` must never be written into a migration, a note, Notion, or this repo.

### Files

| Piece | Where |
|---|---|
| Tables, the guard, the reveal log | `supabase/migrations/0008_vault_reports.sql` |
| Shared rules — kinds, cards, passwords, validation (pure) | `lib/vault.js` |
| The scrambling. SERVER ONLY | `lib/vault-crypto.js` |
| The only door between a secret and a person | `api/vault-secret.js` |
| Card, modals, reveal, the client-page panel | `src/components/admin/vaultParts.jsx` |
| The page | `src/components/admin/VaultPage.jsx` |
| Clipboard, shared with the report | `src/lib/clipboard.js` |
| Reads and writes, plus the preview store | `src/lib/data.js` (search "THE VAULT") |
| Tests | `bash tests/vault/run.sh` |

### The rules that must not be broken

1. **`/api/vault-secret` is the only door.** Reveal, copy, save, clear, delete and generate all go
   through it. It checks the role, writes the log, and only then hands anything back.
2. **The log is written BEFORE the secret is handed over, and a failed log fails the action.**
   Nobody reads a secret off the record. The same holds for deleting an item: the log row goes
   first, and if it cannot be written, nothing is deleted.
3. **Reveal and copy are different events.** "Looked at it on screen" and "put it on the clipboard"
   are the distinction that matters when a password turns up somewhere it should not, so the
   browser always asks the server again for a copy, even when the value is already on screen.
4. **The reveal log has no insert, update or delete policy for a signed-in person.** Only the
   server writes it. Its rows outlive the item — `item_id` goes null, the label stays — so deleting
   an item cannot erase the record of having read it.
5. **A ciphertext is tied to its row.** The item's id is mixed in as additional authenticated data,
   so a blob copied onto another row in the SQL editor fails loudly instead of quietly revealing
   the wrong card under the wrong name.
6. **The card face is derived from the stored number.** The brand and last 4 are worked out on the
   server from the number itself — including writing an empty brand when nothing recognises the
   number, because a wrong brand is worse than none. Both boxes are read-only in the browser while
   a number is stored, and the database refuses the change too.
7. **An item's kind cannot change while it holds a secret.** A card holding `{number, cvv}` turned
   into a login has nowhere to show either, and the number becomes unreachable through every path.
8. **Nothing about the vault ever reaches the AI.** A client report carries a COUNT of vault items
   and nothing else — see §24.

### The trigger, and what it can and cannot promise

`admin_vault_secret_guard()` refuses any insert or update that writes `secret_cipher`,
`secret_fields`, `secret_set_at` or `secret_by` unless the request really is the server. "Really" is
two things, not one: the database role is `service_role` (which PostgREST sets for a service-key
request and which a signed-in person cannot set), **and** the JWT claim says so. Checking the claim
alone was wrong — a reviewer set it by hand in a normal session and walked straight past the guard.

It is deliberately **not** `security definer`: inside a definer function `current_user` is the
function's owner, so the role half of the check would read `postgres` for everybody.

**Said plainly: a database superuser can turn the trigger off.** The Supabase SQL editor runs as
one. No trigger can stop the owner of a database. What this stops is every signed-in console user
and every path the application itself can take.

### VAULT_KEY

`openssl rand -base64 32`, pasted whole into Vercel. `readVaultKey()` accepts that or 64 hex
characters, and refuses anything that looks chosen rather than generated:

- fewer than 12 distinct bytes (an all-zero key: 43 capital A characters decodes to exactly that),
- decoded bytes that are almost all printable (a phrase wearing base64, `echo … | base64` included),
- a base64 string that is not what an encoder would have produced (a typed phrase almost never is),
- one that contains a word like "secret" or "vault".

Measured: 0 refusals in 1.2 million real keys across four encodings; every sample bad key refused.
The refusal now says WHICH test failed, because about one real key in 1.7 million trips the word
test and "run the command you just ran" is not a useful error.

**What it cannot see:** the SHA-256 of a memorable phrase. It has the byte spread of a real key
because it is a hash. Somebody who hashes "aisyndicate2026" gets a key an attacker can brute-force
through SHA-256 at billions of guesses a second, and nothing here can tell. That is why the page
gives the exact command rather than saying "any 32 bytes".

**If the key is lost, everything stored is gone.** Not recoverable, by design. Keep it in Bitwarden.

### Rotating the key

There is no rotation tool yet. A blob carries the first 8 hex characters of the SHA-256 of the key
it was made with, so a mismatched key produces *"This was saved with a DIFFERENT VAULT_KEY"* rather
than a crash — and nothing is lost while the old key still exists. Rotating today means: put the old
key back, reveal each secret, save it again under the new key.

### Who can do what

| Action | Owner | Admin | Sales |
|---|---|---|---|
| See the page, the list, the counts | yes | yes | **no** |
| Reveal, copy, save, clear | yes | yes | no |
| Add, edit, delete an item | yes | yes | no |
| Read the reveal log | yes | yes | no |

Enforced in four places, and all four matter: the sidebar does not list the page, the dashboard will
not route to it, the database refuses the rows, and the endpoint refuses the request. **Hiding a
button is not a permission.**


---

## §24. Generate report — a client page writes itself up — Aug 21 2026 (append-only section)

Built at Ryder's ask: *"a generate report button on a client's page that pulls all of the context
from operations, emails, everything about that client... when clicking create report I want a text
field where we can tell it like hey, make it the 10 second version, or go really in depth."*

One button at the top of a client page, and a Reports tab beside it. Press it, say how deep to go in
your own words, and it reads that client's tasks, weekly log, websites, email threads, follow-ups,
invoices, support tickets and the notes the team wrote, counts them, and writes it up.

### Files

| Piece | Where |
|---|---|
| Counting, the instruction, the checks, the no-AI version (pure) | `lib/client-report.js` |
| The endpoint | `api/client-report.js` |
| The panel, the ask box, the reader | `src/components/admin/clientReports.jsx` |
| The table | `supabase/migrations/0008_vault_reports.sql` |
| Tests | `bash tests/vault/run.sh` (same suite as the vault) |

It is built on `lib/client-standing.js` — the same counting, the same caps — so a report and the
"where this client stands" block on the same page can never disagree about how many tasks are done.

### Every report has two layers, always

A 30-second summary that gets forwarded, and the full version that gets filed. That is not a setting;
it is the shape of the answer. Plus a third tab, **what it could not check**, which is the part most
reports skip — and skipping it turns "we hold no record of their rankings" into a reader's
impression that the rankings are fine.

### The five rules, and where each one lives

1. **Every fact is counted server-side from real rows.** `assembleReportFacts()`.
2. **Those facts, and nothing else, are what the AI is shown.** `buildFactsText()`.
3. **The facts are saved next to the words** in `admin_client_reports.facts`, so any report can be
   checked against the same numbers months later. "Check the numbers" opens them.
4. **With no ANTHROPIC_API_KEY it still works** and returns a counted version, badged COUNTED.
5. **A draft that breaks a rule is thrown away** and the counted version ships instead, with the
   reason saved on the row so a pattern of rejections is visible rather than invisible.

### What throws a draft away — `checkReport()`

- a number, a date, or a spelled-out number that is not in the facts;
- a figure rounded off a real one (`$3,750` when the record says `$3,750.50`);
- a date in a form our records never use (`30/09/2026`), or a day of the month we do not hold;
- promise wording — "guarantee", "on track", "we expect", "should be finished by";
- an amount with no number — "roughly", "a dozen", "half the", "most of the";
- a loose when — "next Friday", "by the end of the month";
- **a line that hands work to a person.**

### "A report never hands work to a person" — how it is actually done

This is the rule with the most history in it, because both easy versions are wrong:

- A **stop list of English nouns** rejects honest reports: "Schema must be added to the remaining
  pages" is a fact about a website. Fixed by ignoring the passive — `must be`, `should come`,
  `must happen` — and by knowing the client's own name.
- **Hard-coded names** only ever catch those names. The roster is read from `admin_users` and passed
  in as `teamNames`, registered whole and in parts, filtered so that a row reading "Support" or
  "Will" cannot break every report. If the roster read fails, the report SAYS the check ran without
  it, in its own gaps list.
- **Quoting.** A report is allowed to show you what a task note says, including a note somebody
  wrote as "Dana needs to send the login". Two versions of this exemption were wrong:
  v1 exempted any phrase found anywhere in the facts — one task note unlocked that sentence for the
  whole report; v2 exempted anything in quote marks — and the model writes the quote marks.
  **Now: a quoted span is exempt only if its words really are in the records.** The counted report
  quotes everything it copies, and the prompt tells the model to do the same.

### The fact sheet, and what it does when it will not fit

`buildFactsText()` builds the header and the whole tail FIRST — counts taken at, totals, money,
tickets, notes, access, earlier reports, and the gaps list — and gives the long lists whatever room
is left. Only the lists are ever trimmed, and the amount trimmed is **measured**, printed in the
sheet the AI reads, and repeated in the report's own gaps list.

Two separate losses, both named:
- the sheet was longer than the budget (rare), and
- the lists were already capped by `assembleFacts` at 25 done / 25 open / 15 blocked / 8 weeks / 15
  emails. On a 300-task client that is the real loss, and `missingFrom()` now says
  *"the newest 25 of 200 open tasks… the COUNTS are complete; the lists are a sample."*

### Money comes from the Finance page's own file

`effectiveInvoiceStatus()` and `invoiceOutstandingCents()` are imported from `lib/finance-math.js`
rather than written again. Re-deriving them produced a report saying a client owed five times what
Finance said. Specifically:

- a **draft** is not billed, not owed, and cannot be overdue — it is counted and named separately;
- **overdue comes from the amounts, not the stored status.** An invoice marked paid that is only
  part paid and past its date is overdue for the remainder — reading the status hid $600 of real
  debt as zero;
- **outstanding is clamped per invoice**, so an overpayment on one cannot cancel a debt on another.
  (Note: `billedVsCollected` on the Finance page clamps globally and so can still differ. The
  report matches `agingBuckets`, which is the more correct of the two.)

### What never travels in a report

Nothing from the vault beyond a count: `api/client-report.js` selects `id, secret_set_at` and
nothing else, and the facts carry four integers. No label, no username, obviously no secret.

**What DOES travel, and the Generate box says so:** the notes your team wrote about this client,
word for word, and the client's own notes field — into the AI prompt, the saved facts, the report,
and the markdown download. If somebody pasted something private into a note, it is in the report.


---

## §25. STATE BOARD — replaces §20 as the current picture (Aug 21 2026, end of session)

### BUILT AND WORKING (in the repo, still not deployed)

Everything in §20, plus:

- **The Vault** (§23) — Workspace → Vault, and a Vault tab on every client page.
- **Generate report** (§24) — a button at the top of a client page, and a Reports tab.
- One repair carried along: `admin_reminders.link_type` accepts `'email'` again. Migration 0006 had
  dropped it while adding `'note'`, which meant the Inbox's "Remind me" button had been failing on
  every press, and the report's follow-up count could never see an email reminder.

### STILL NEEDED — in this order

1. **Run `0008_vault_reports.sql`** in the Supabase SQL editor. Nothing about the vault or reports
   saves until then. Clicks: `SETUP.md` § "Migration 0008".
2. **Set `VAULT_KEY` in Vercel** — `openssl rand -base64 32`, all three environments. Without it the
   list works and Reveal and Save refuse, with a banner across the top saying exactly that.
   **Put the same line in Bitwarden.** Lose it and everything already stored is unreadable.
3. **Deploy.** None of this has run on admin.aisyndicate.com.
4. `ANTHROPIC_API_KEY` → the AI wording on reports. The counted version works without it.

### KNOWN GAPS, WRITTEN DOWN RATHER THAN HIDDEN

- **No real reveal has ever been watched against a real Supabase.** Every claim about what happens
  after the endpoint answers is read from the code and from a mocked Postgres, not observed.
- **No key rotation tool.** See §23.
- `readVaultKey()` cannot tell the SHA-256 of a passphrase from a real key. §23 says so out loud.
- The clipboard wipe is best effort: a browser can refuse the second write, and a copy made outside
  the app cannot be seen. The toast says "about a minute", never "cleared".
- Support tickets are matched to a client by contact email, because `admin_tickets` has no
  `client_id`. A client with no contact email gets a line in the report saying so.
- The report's "still owed" can differ from the Finance page's headline figure, because that figure
  clamps globally. Both are in §24; neither is silently wrong.
- **Three rounds of adversarial review by a separate agent**, 40+ real defects found and fixed,
  including four regressions the fixes themselves introduced. The review notes are the reason most
  of the comments in these files exist.

### Proof on record, Aug 21 2026

lint 0 · `vite build` clean, 128 modules · `node tests/vault/test.mjs` **105/105** ·
`bash tests/vault/sql.sh` **36/36** against a real Postgres 16 with all eight migrations, including
a simulated redeploy over an older 0008 · `tests/brain` 78/78, `tests/inbox` 47/47,
`tests/finance` 53/53 unchanged · a Playwright walkthrough of the built bundle, 24 screenshots,
every step asserted.

## §26. Sales — the page that replaces the outreach spreadsheet — Aug 22 2026 (append-only section)

Built at Ryder's ask: *"make the leads page a sales page and make it operate with the system CJ
and our sales guys use effectively on both the backend and the salesman/rep side."*

Everything below is in the repo and **has never run on admin.aisyndicate.com**. Migration
`0009_sales.sql` has not been applied to Supabase. See "Blocked until" at the end.

---

### 26.1 What was actually replaced

CJ's **"Sales Team Outreach Master List"** in Google Sheets
(`docs.google.com/spreadsheets/d/1f2i2gezVKIkGh5SNELgQSkF4vkTzOCyTibYE-TM-otA`). Read in full on
Aug 21 2026 before a line was written. Its shape:

* Tabs: `Rules of Engagement` + one per business type — Luxury Agents, Law Firm Marketing
  Directors, Medspas, Car Dealership, Jewelry, Dental Practices, and more past the tab arrow.
* Six columns a human fills in — **Sales Owner · Contacted? · Sales Cycle Status · First Contact ·
  Last Touch · Next Steps/Notes** — then the raw Apollo export.
* **The Apollo columns are NOT the same on every tab.** Luxury Agents has `# Employees` where Car
  Dealership has `Departments` and `Industry`. Nothing in the importer may assume a fixed layout.

The Rules of Engagement tab is a complete sales system in writing. Almost none of it can be
enforced by a spreadsheet, so almost none of it happens:

| The rule | What the sheet does with it |
|---|---|
| Claim before you reach out; **one firm, one rep** | Claiming is per ROW. ACME \| SERHANT. has 4 contact rows, Backbeat Homes 4, Agents of LA 3. One claimed row leaves the rest open. |
| First contact within 3 business days or the claim drops | Nothing counts days. Has never fired. |
| 14 days cold and the firm reopens | Same. |
| Score the site first; **90+ = not a prospect** | The Site Score column **does not exist on any tab.** The gate has never once been applied. |
| 5 touches over ~2 weeks | Honour system. |
| One text, only to a warm open | Honour system. |
| Log every touch the same day | "Last Touch" is one cell — overwrite it and the old one is gone. |

Plus the data problems: `Contacted?` and `Sales Cycle Status` say the same thing; "Brandon Roberts"
and "Brandon R" are the same person on the same tab; dates are text (`8/11/26` and `8/11/2026`);
and nothing exists after "meeting held" — no proposal, no amount, no reason for a loss.

### 26.2 The decision everything hangs on (Ryder, Aug 21 2026)

1. **The record is the PERSON.** Every sheet row is one lead — a customer profile from the day it
   arrives — and stays that row for life. `became_customer` flips on the row that already holds the
   whole chase. A second row would orphan all of it.
2. **The company is a link on that person, not a wrapper.** It holds the facts that belong to the
   firm — website, site score, revenue, head count — so scoring ACME once scores it for all four
   ACME contacts, and the sheet's habit of copying a website onto four rows (where three go stale)
   stops.
3. **No locks between reps.** Full read AND edit on everybody's leads. So "one firm, one rep" is a
   **warning a person reads, not a wall**. The timers still run — that part is about leads going
   stale, not about trust.

### 26.3 The files

| Piece | Where |
|---|---|
| The Rules of Engagement, as pure functions | `lib/sales-rules.js` |
| Sheet import: column matching, dates, owner matching, firm folding | `lib/sales-import.js` |
| Companies, lists, proposals, the new lead columns | `supabase/migrations/0009_sales.sql` |
| Reads and writes | the SALES section at the end of `src/lib/data.js` |
| The page — My Day / Lists / Pipeline / Firms | `src/components/admin/SalesPage.jsx` |
| The per-contact drawer | `src/components/admin/salesProfile.jsx` |
| The importer | `src/components/admin/salesImport.jsx` |
| Chips and tiles | `src/components/admin/salesParts.jsx` |
| Run a site score | `api/sales-score.js` |
| The overnight claim sweep | `api/sales-sweep.js` |
| Every tab of an .xlsx at once | `parseXlsxAllTabs` in `src/lib/sheet.js` |
| Tests | `bash tests/sales/run.sh` · `node tests/sales/walkthrough.mjs` |

`LeadsPage.jsx` is gone (moved to `_to_delete/`). `#/dashboard/leads` rewrites itself to
`#/dashboard/sales`, so old links and bookmarks still work and the address bar stops carrying the
dead name.

### 26.4 The rules that must not be broken

1. **`lib/sales-rules.js` decides everything, and it is pure.** The page a rep reads at 9am and the
   sweep that runs at 3am must never disagree about whose claim has run out. `now` is always passed
   in; there is no clock inside the file.
2. **Two first-contact columns, because there are two questions.** `first_contact_at` is the
   relationship's and is **never cleared**. `claim_contacted_at` is the current claim's three-day
   window and is cleared on every claim, reassign and release. Sharing one column meant a
   re-claimed lead had to have its real date erased to stop the 3-day timer firing instantly —
   which deleted the date, dropped the lead out of the speed-to-first-contact sample, and made a
   proposal-stage lead with nine logged touches report as never contacted.
3. **The cold clock runs from the LATER of the last touch and the claim.** That is what makes a new
   claim a new start without erasing anything.
4. **Nothing is taken that was not warned about first.** `api/sales-sweep.js` refuses to release
   any claim it cannot find an existing reminder for. Without that rule the backfill in §26.6 would
   have unassigned the entire sales floor on the first run, overnight, with nobody watching.
5. **A release never touches `stage`.** Whose it is and how far it got are two different facts.
6. **Days are counted in America/Chicago via `Intl`, never a fixed offset.** Chicago is UTC-5 in
   summer and UTC-6 in winter; a hardcoded -5 put every 11pm-to-midnight timestamp on the wrong day
   for half the year, and a test suite with an August clock can never see it.
7. **The one-text rule is enforced by the database**, `admin_lead_claim_text()`, in one statement.
   A browser-side `texts_sent + 1` is a read-modify-write that two open tabs both win.
8. **A score outside 0-100, an empty string, or an unreadable counter all read as UNKNOWN, never as
   a passing value.** `Number("")` is 0, which would have made an unscored firm the widest gap on
   the list and sent a rep in hardest.
9. **The 90+ gate applies only before a conversation exists** (`new`, `researching`). It is a rule
   about who to spend a touch on, not who to abandon — applying it to everybody dropped a
   proposal-stage deal off a rep's day because somebody scored the site late.
10. **The importer's duplicate check must DECIDE, not just count.** It produces a `skip` Set that
    the import reads. The first version printed "412 already in the pipeline" and imported all 412.
11. **Company identity is domain-first, normalised.** `normaliseDomain()` everywhere:
    `https://www.x.com`, `x.com` and `x.com/` are one firm. And ids returned from a batch insert are
    matched on **name + website together** — name alone collapses two same-named firms in different
    states onto one id.

### 26.5 What the page does

**My Day** (a rep lands here) — cards in the order to work them, each saying WHY it is there:
claims that have run out · first contact due · gone cold · going cold · touches owed by the cadence
· free to claim. **Lists** (owners land here) — the sheet's tabs as a grid, grouped by firm, with a
health strip (claimed / actually contacted / score run) and a "2 reps working this firm" flag.
**Pipeline** — a board by stage. **Firms** — one row per company, worst score first.

**The profile** has five tabs: Work (what is owed, and the buttons to do it, plus the 5-touch dots),
Timeline (append-only, nothing ever overwritten), Details (person fields vs firm fields), Proposals
(amount, sent, viewed, won/lost and why — the half the sheet had nowhere to put), Playbook (the 7
moves and the cadence, on the screen where the work happens).

### 26.6 The migration

`0009_sales.sql` adds `admin_companies`, `admin_lead_lists`, `admin_proposals`, the
`admin_lead_claim_text()` function, ~18 columns on `admin_leads`, a wider stage ladder (12 stages)
and a wider activity-type list. Additive, `admin_`-prefixed, re-runnable.

Two triggers matter. `admin_lead_activity_touch` sets `last_touch_at`/`claim_contacted_at` from a
call, email, text or LinkedIn row — and uses `least()` for `first_contact_at`, so a back-dated touch
corrects it rather than recording the insertion order. A status change is deliberately **not** a
touch. **Honest limit:** the table has no direction column, so an inbound email logged by hand
counts exactly like an outbound one.

The backfill stamps `claimed_at` on existing owned leads and fills `first_contact_at` only where
real activity exists. It never invents a first-contact date — see rule 4 for why that is safe.

### 26.7 Proof on record (Aug 22 2026)

`npx eslint .` **0 problems** · `npm run build` clean, **133 modules** · `node tests/sales/test.mjs`
**84/84** · `bash tests/sales/sql.sh` **20/20 against a real Postgres 16**, every migration applied
in order and 0009 re-run to prove it is safe twice · every other suite unchanged: brain 78/78,
inbox 47/47, finance 53/53, vault 105/105 + 36 database checks · `node tests/sales/walkthrough.mjs`
drives the **built bundle** in Chromium through 19 checks and 19 screenshots with no console errors,
including **importing the same list twice and confirming the second run writes nothing**.

**Two separate adversarial review agents were run.** The first found 24 defects; the second, run
only on the fixes, found 6 more including two severe ones the first pass had introduced. All
material findings are fixed and covered by a test. Four defects were found by watching the built
page rather than by reading the code — the 90+ gate dropping a live deal, the legacy URL never
rewriting itself, and two assertions that were themselves wrong.

### 26.8 Blocked until

1. **Run `0009_sales.sql`** in the Supabase SQL editor. Nothing on this page saves until then.
   (0008 and 0009 are independent and can be run in either order.)
2. **Deploy.** None of this has run on admin.aisyndicate.com.
3. **`PLATFORM_SCORE_URL`** (+ optional `PLATFORM_SCORE_KEY`) → the Run-score button. Without it
   the endpoint returns 503 naming the variable and the chip keeps saying NO SCORE. **No score is
   ever invented** — a rep would quote it.
4. **`CRON_SECRET`** → the overnight sweep. Without it the scheduled path is closed, not open. Point
   a daily cron at `GET /api/sales-sweep` with `Authorization: Bearer <CRON_SECRET>`.
5. **Import the real sheet.** Sales → Import a sheet → pick the .xlsx → tick the tabs → check the
   columns → read the plan → import.

### 26.9 Known gaps, written down rather than hidden

* **"They replied and you have not answered" does not exist.** It would be the most important card
  on My Day, and there is nowhere to read it from — `admin_lead_activity` has no direction and
  nothing marks an inbound thread as unanswered on the lead. An earlier draft had the branch,
  ranked top, with a heading and a test, for a code path no user could reach. It was removed rather
  than left looking finished.
* **Marking a lead Won does not create the client record.** `admin_companies.client_id` exists and
  is written by nothing. The toast says so.
* **Email is not sent from this page.** Touches are logged, not sent. The 7-move templates are
  guidance a rep reads, not merge fields.
* **Open tracking is not wired**, so the text gate stays shut until `email_opened_at` is set by
  something. Nothing sets it yet.
* **Caps:** the page reads the newest 2,000 leads and 4,000 activity rows and **says so on screen**
  when it hits either. The sweep handles 500 claims a run and reports the remainder.
* **Import grouping:** where one firm name has two websites AND some rows have no website, the
  blank rows are grouped together by name. There is genuinely nothing in the sheet that separates
  them; the plan screen warns rather than pretending it knew.
* One lint error in the other session's `Overview.jsx` (`fmtNum` and an unused `i`) was fixed in
  passing so the repo lints clean. That file was rebuilt by the concurrent Vault/Reports session
  after this session's snapshot, so the Sales edits were re-applied onto their version rather than
  written over it.

---

## §27. The Overview page, rebuilt as the daily snapshot — Aug 22 2026 (append-only section)
> **Superseded on WHAT EXISTS by §33 (the current spec) and §34 (the state board).** Keep reading this section for the *why* — the reasoning behind several rules lives only here — but trust §33 on how it behaves today.


### What changed and why

Overview started life as the money page. Finance took that job on Aug 20 (§18), so Overview was
showing a second, slightly different set of the same numbers — a big MRR hero, a revenue-versus-AI-spend
chart, and a payments table. Ryder asked for it to become the page you open first: your tasks for the
day, your reminders, and everything you should know, in one screen.

**The Work page stays.** That was a decision, not an oversight. Work is the deep page you grind
through; Overview is the page you look at. Two rules keep them from becoming the same page:

1. Every block on Overview is capped and links to the page that owns it. Nothing on Overview is a
   list you work down.
2. The only actions allowed inline are one-click ones — tick a reminder, mark a task done, dismiss a
   note. Anything needing a form sends you to the owning page.

### The page, top to bottom

| Block | What it reads | Notes |
|---|---|---|
| Today banner | `getMyWork` | Greeting, the team's date, one plain sentence, and a START HERE button pointing at the single most urgent thing |
| Red "some of this page is missing" panel | every read's `.error` | Only appears when something failed. Names each one. |
| Your five numbers | `getMyWork` | Late · Due today · Reminders due · People to contact · Tickets on you. All click through. |
| Do these today | `getMyWork().tasks` | Late + due-today, capped at 6, inline **Done** |
| Reminders due | `getMyWork().reminders` | Capped at 6, inline tick-off, plus a one-line "coming up" |
| What the console noticed | `listAiNotes({statuses:["open"]})` | Top 6 by urgency, inline **Dismiss**, each card labelled COUNTED / AI-WRITTEN / WRITTEN BY A PERSON |
| Where everything stands | `listClients`, `listEmailThreads`, `listTickets`, `listLeads` | Active clients · Emails needing a reply · Open tickets · Pipeline · New leads this month |
| Clients that need attention | `listTasks()` across every client | Late and blocked task counts per active client, top 5 |
| Money, one line | `/api/stripe-metrics`, `listInvoices`, `listUsage` | Recurring revenue · Still owed · AI spend this month. Each with its own source badge. |
| What changed lately | `listActivity(8)` | |
| Jump in | — | Work · Leads · Operations · Inbox |

Removed with it: the MRR hero, the money chart, the recent-payments table, the token-ingest explainer
modal, and the `MoneyBars` / `MetricCard` / `CountUp` imports. All of that still exists on Finance.

### The date bug this page exposed, and the file that now owns it

**`src/lib/teamDay.js` is new. Every judgement about lateness anywhere in the console should go
through it.** Three separate date bugs shipped in the first two drafts of this page, and every one of
them was invisible in a Chicago browser at midday:

1. `Date.parse(ymd + "T00:00:00Z")` was used as "midnight Central". It is midnight in **London**. The
   team's day therefore ended at **18:59 Central**, so a reminder set for 8pm was filed under
   "coming up" while its own label read "today".
2. Fixing the zone but keeping `start + 24h - 1` is still wrong: **two days a year are not 24 hours
   long.** That put the end of 2026-11-01 at 22:59 and the end of 2026-03-08 at 00:59 the *next*
   morning — reproducing bug 1 for the last hour of every fall-back night, and printing tomorrow's
   date on anything due on a spring-forward day. `teamDayEndOf` now walks to the next midnight.
3. `getMyWork()` buckets tasks on **the browser's** clock, while the label on the row beside them was
   computed on the team's clock. A New York browser at 00:30 showed a task in the red "Late" pile with
   a pill next to it reading TODAY; a Los Angeles browser at 22:00 showed one under "Due today" whose
   pill read "1 DAY LATE". Overview now **re-buckets everything itself** through `teamDay.js` and
   ignores the buckets `getMyWork` attached.

`getMyWork`'s own bucketing is still browser-local. That is a live open bug on the Work page — it is
written down under "Still open" below rather than fixed here, because Work was not in scope and the fix
belongs with a test of its own.

### Other real defects found and fixed on this page

Two rounds of adversarial review by separate agents found 22 and then 15 defects. The ones worth
carrying forward as rules:

- **Note urgency runs 3 → 1, with 3 the most urgent.** The first draft read it the other way, which
  put the calm notes on top and hid the urgent ones behind the "6 more" link.
- **There is no `paused` client status.** The values are `active | prospect | holding | closed`
  (`0001_admin_init.sql:120`). Filtering on `paused` counted prospects and closed accounts as active.
- **There is no way to ask when a lead was won.** `admin_leads` has no `won_at`, and
  `last_activity_at` moves whenever anyone logs anything. "Won this month" was unanswerable, so the
  tile now counts **new leads this month** off `created_at`, which is `not null default now()`.
- **`written_by` has three values, not two** — `counted`, `ai_written`, `person`. A note a human typed
  was being labelled AI-WRITTEN.
- **A failed read must never render as a zero.** Six of nine reads failed silently in the first draft.
  Every tile now takes a `broken` prop and shows a dash, the red panel names each failure, and the
  words "nothing is late" are suppressed whenever anything failed. There is a fault-injection browser
  test for exactly this.
- **`SourceBadge` has a new `error` mode → READ FAILED.** A broken query used to borrow `waiting`,
  which reads as WAITING ON KEY and tells you to go and set a key that is already set.
- **`getMyWork`'s error union was missing `listAllLeadActivity`.** That read decides "never contacted"
  and "no contact in N days", so losing it silently mis-counted People to contact with nothing on
  screen to say so. Fixed in `data.js`.
- **`Date.parse(x || 0)` is a trap.** `Date.parse(0)` is the year 2000, so a null sorted as 26 years
  old. Use `parsedOr0`.
- **A single shared `busyId` does not guard concurrent actions** — clicking Done on task A then task B
  re-enabled A's button mid-flight. It is a `Set` now, and loads are sequenced with a `loadSeq` ref so
  a slow earlier load cannot overwrite a fast later one.
- **A ref written before the sequence guard leaks.** The Stripe result was stored in a ref before the
  guard and read after it, so an inline action could publish the initial `unknown` state and render
  "preview mode · WAITING ON KEY" on a live console until someone pressed Refresh. There is now an
  explicit `unread` state that says "not read yet — hit Refresh", and the ref is written after the
  guard.
- **`.adm-charts-row` was never defined in any stylesheet.** The old Overview's two columns never
  collapsed on a narrow window. Use `repeat(auto-fit, minmax(320px, 1fr))`.
- **`useScreenContext(..., [view])` blinks.** `view` is a new object every time the clock ticks, and
  each new identity tears the context down and rebuilds it. Key it on a summary string instead.

### Read caps, said out loud on the page

`listEmailThreads` caps at 400 rows, `listLeads` at 1,000, `listTasks` at 500, `listUsage` at 5,000
**ascending** (so an overflow drops the *newest* rows). A caption under the agency tiles names all
four, because "every mailbox" over a capped read is a claim the code cannot support.

### Proof on record, Aug 22 2026

- `eslint src/` clean · `vite build` clean, 129 modules
- **`tests/overview/run.sh` — 41 assertions × 5 timezones = 205, all passing.** Chicago, New York,
  Los Angeles, UTC and Auckland, because every bug above was invisible in one of them. Includes a
  365-day sweep asserting every day of 2026 ends at 23:59 Central, and two brute-force sweeps
  (~180,000 comparisons) asserting no label can contradict its bucket, across both clock changes.
- Existing suites unchanged: finance 53/53, vault 36/36 against a real Postgres, inbox 47/47,
  brain 78/78. (Brain's SQL cross-check cannot run in the cloud container — `initdb` refuses to run
  as root. Not related to this change.)
- **Playwright against the built bundle**, three passes: the full page in Chicago (≈70 assertions
  covering copy, badges, routing, all three inline actions, double-click safety, and 400px width);
  the tile-versus-pill agreement check in four timezones; and the page with its clock frozen to
  23:30 Central on the 2026 fall-back night.
- **A fourth pass builds a second bundle whose every read returns an error** and asserts the page
  names each failure, dashes all ten tiles, badges READ FAILED, and never prints "nothing is late".
- Screenshots: `/tmp/pw/shots/` in that session.

### Still open after this session

- `getMyWork()` in `data.js` still buckets on the browser's clock, so the **Work page** can disagree
  with Overview by one day for a browser outside Central. Overview is right; Work is not. The fix is
  to route `getMyWork` through `src/lib/teamDay.js` and give it the same five-timezone test.
- `listUsage` orders `ts` ascending with a 5,000-row limit, so above 5,000 events in the window the
  newest are the ones dropped. Should be descending.
- The reminder tick-box is a 20px `<button role="checkbox">`. It is correctly named, but a real
  `<input type="checkbox">` would be better.
- None of this has run against a real Supabase. Every claim above is from the sample store, a
  fault-injected bundle, and the code.

## §28. STATE BOARD — replaces §25 as the current picture (Aug 22 2026, end of session)

> **Superseded by §34.** Kept as the picture at the end of Aug 22.


Written after **two sessions ran in parallel on Aug 22** — one built the Sales page (§26), one
rebuilt Overview (§27). §25 predates both and no longer describes the console. Read this one.

### BUILT AND WORKING (in the repo, still not deployed)

Everything in §25, plus:

- **Sales** (§26) — the Leads page is gone. Four views: My Day, Lists, Pipeline, Firms; a five-tab
  profile per contact; an importer that reads every tab of a workbook at once. The Rules of
  Engagement are enforced in code: claims, the 3-business-day and 14-day timers, the 5-touch
  cadence, the 90+ score gate, the one-text rule.
- **Overview rebuilt** (§27) as the daily snapshot.
- **The "information card" is gone from every page.** The `Explainer` component, its CSS and all
  eight usages were deleted at Ryder's ask, Aug 22: *"those aren't needed in the CRM."*
- `#/dashboard/leads` rewrites itself to `#/dashboard/sales`, so old links and bookmarks work and
  the address bar stops carrying the dead name.

### STILL NEEDED — in this order

1. **Run `0008_vault_reports.sql`** — nothing about the Vault or reports saves until then.
   Clicks: `SETUP.md` § "Migration 0008".
2. **Run `0009_sales.sql`** — nothing on the Sales page saves until then. Clicks: `SETUP.md`
   § "Migration 0009". 0008 and 0009 are independent and can be run in either order.
3. **Deploy.** None of this has ever run on admin.aisyndicate.com. That has now been true across
   seven build sessions; it is the single biggest thing standing between this console and anybody
   using it.
4. **`VAULT_KEY`** in Vercel → Reveal and Save in the Vault. Put the same line in Bitwarden.
5. **`PLATFORM_SCORE_URL`** (+ `PLATFORM_SCORE_KEY` if the endpoint needs one) → the Run-score
   button on Sales. Without it the endpoint returns 503 naming the variable and **no score is ever
   invented**.
6. **`CRON_SECRET`** + a daily `GET /api/sales-sweep` with `Authorization: Bearer <secret>` → the
   claim timers actually hand stale firms back. Without it that path is closed, not open.
7. **`ANTHROPIC_API_KEY`** → AI wording on reports and Notes, and the assistant. Every counted
   version works without it.
8. **Import the real outreach sheet** and get the sales floor off Google Sheets.

### WHAT IS TRUE ABOUT THE WHOLE CONSOLE NOW

| Page | State |
|---|---|
| Overview · Work | rebuilt Aug 22, the daily snapshot (§27) |
| **Sales** | **new Aug 22, replaces Leads (§26)** |
| Operations · Clients · client page | §16-§18 |
| Finance · Invoices | §18-§19, needs Stripe keys |
| Inbox · Tickets | §17, needs the Gmail OAuth pair |
| Notes · AI Brain · the assistant | §21-§22, needs `ANTHROPIC_API_KEY` |
| Vault · client reports | §23-§24, needs `VAULT_KEY` |
| Team · Settings · Our platform | §16 |

Migrations `0001` → `0009`. Two are unrun: **0008 and 0009**.

### KNOWN GAPS, WRITTEN DOWN RATHER THAN HIDDEN

Everything in §25 still stands. Added by this session:

- **Nothing has ever run against a real Supabase.** Every migration is proven against a real
  Postgres 16 in the test container, and every page is proven against the preview store — but the
  join between them has never been watched. Expect a first-deploy afternoon.
- **Sales sends no email.** Touches are logged, not sent. No open tracking, so the text gate stays
  shut until something sets `email_opened_at`.
- **"They replied and you have not answered" does not exist** on My Day, and cannot until a lead
  can know an inbound message is unanswered. Deliberately removed rather than left as a dead code
  path that looked finished.
- **Marking a lead Won does not create the client record.** `admin_companies.client_id` exists and
  nothing writes it. The console says so when you click.
- An inbound email logged by hand counts as a cadence touch and resets the 14-day timer. The
  activity table has no direction column.
- Sales reads the newest 2,000 leads / 4,000 activity rows and **says so on screen** at the cap.
- Cosmetic, left alone because it is in another session's file: `Overview.jsx` still says the word
  "leads" in one error string (`fail("leads", leads)`), on a console where the page is called
  Sales. Not a route id — it cannot break anything.

### Proof on record, Aug 22 2026

lint **0** · `vite build` clean, **133 modules** · `node tests/sales/test.mjs` **84/84** ·
`bash tests/sales/sql.sh` **20/20** against a real Postgres 16, all nine migrations in order and
0009 re-run to prove it is safe twice · `tests/vault` 105/105 + 36 database · `tests/brain` 78/78 ·
`tests/inbox` 47/47 · `tests/finance` 53/53 — all unchanged by this work ·
`node tests/sales/walkthrough.mjs` drives the **built bundle** in Chromium through 19 checks and 19
screenshots with no console errors, including importing the same list twice and proving the second
run writes nothing. Screenshots are in `tests/sales/shots/`.

**Two adversarial review agents.** The first found 24 defects; the second, run only on the fixes,
found 6 more — including two severe ones the first round of fixes had introduced. All material
findings fixed and covered by a test. Four defects were found by *watching the built page*, not by
reading code.

## §29. The Aug 22 collision, and how the repo was put back together — Aug 22 2026 (append-only section)

**This section corrects §26 and §28 on one point: for about ninety minutes the console could not
build, and both parallel sessions caused it.** It is written down rather than quietly fixed,
because the shape of the mistake is more useful than the fix.

### What broke

Two sessions ran on Aug 22 — one rebuilt Overview (§27), one built Sales (§26). Both used the same
pattern: stage a copy of the repo, edit it in a cloud container for an hour, commit the files back
with `force: true`.

- **22:57–22:58** — the Sales session committed nine new Sales files plus `src/lib/data.js`,
  `Header.jsx` and `shared.jsx`.
- **22:58:42** — the Overview session committed `src/lib/data.js` and `shared.jsx` from a snapshot
  it had taken at **22:00**.

The later write won and it was an hour stale. `data.js` reverted to a version that predated the
Sales work, so the entire SALES section at the end of the file vanished and thirteen exports
`SalesPage.jsx` imports stopped existing — `getSalesBoard`, `claimLead`, `releaseLead`,
`claimTextSend`, `upsertCompany`, `insertCompaniesBatch`, `findExistingCompanies`,
`upsertLeadList`, `findLeadListByTab`, `listProposals`, `upsertProposal`, `deleteProposal`,
`LEAD_STAGE_HELP`. `Header.jsx` lost the Sales page's title entry. `shared.jsx` lost a deletion.

**`vite build` failed.** Neither session noticed, because both had reported success from a build run
against their own container copy — not against what was actually on disk afterwards.

### How it was repaired

The Overview session found it and wrote it up honestly, including that it could not prove which
write had caused what. The Sales session read that note, checked the live files, and merged:

1. **Checked state, not timestamps.** `grep` for the exports that should exist. An mtime tells you
   when a file was written, never what is in it.
2. **Diffed in both directions.** The useful question is not "what is missing from mine" but "what
   does the on-disk file have that mine lacks". In `data.js` that was exactly one real hunk — the
   Overview session's fix adding `activity.error` to `getMyWork`'s error chain. Carried across by
   hand and kept.
3. **Took the on-disk file as the base** and re-applied the Sales hunks onto it, not the reverse.
   In `Header.jsx` that meant keeping the new Overview title and renaming `leads:` to `sales:`. In
   `shared.jsx` it meant keeping the new `error` / READ FAILED badge mode and removing the
   `Explainer` card.
4. **Proved it before writing anything.** The merged tree was assembled in `/tmp`, then lint,
   `vite build`, all five unit suites, the SQL suite against a real Postgres and the Playwright
   walkthrough were run against it.
5. **Committed with `expectedMtimeMs` from a stage call seconds old, and no `force`.**

Result: lint 0 · build clean at **134 modules** · brain 78/78 · inbox 47/47 · finance 53/53 ·
vault 105/105 · sales 84/84 · SQL 20/20 · walkthrough 19/19 with no console errors. Nothing from
either session was lost — but only because each still had its own container copy. That is luck, not
a process.

### The rule that comes out of it

**Never `device_stage_files` → edit → `device_commit_files` a source file another session might
touch, and never pass `force: true` on one.** Edit shared source in place with `device_bash`, read
and write seconds apart. If you must stage and commit, pass the `mtimeMs` from the stage call as
`expectedMtimeMs` and let a refusal happen — a refusal is the tool working.

And: **build once more against what is actually on disk, after the last commit.** Both sessions
skipped that single step, and it would have caught this in under a minute.

§11 of this file exempted "live artifacts" like source code from the append-only rule. That
exemption was too broad. A source file two sessions are both editing is exactly as collision-prone
as a log; it just fails louder.

### One more thing this surfaced: two date systems

The Overview session added `src/lib/teamDay.js` as the console's single date authority, after three
date bugs shipped in one day. `lib/sales-rules.js` had independently grown its own Chicago-day
maths.

They cannot be merged into one file: `teamDay.js` imports `TEAM_TZ` from `lib/brain-context.js`,
which imports `isOpenStage` from `lib/sales-rules.js` — so sales-rules importing teamDay is a
cycle. And `sales-rules.js` must stay import-free, because `api/sales-sweep.js` runs it on the
server and the tests run it with no bundler.

So there are two copies on purpose — the same arrangement as `dedupeKey()` and the SQL function it
mirrors. Two copies are only acceptable if something proves they still agree, so
`tests/sales/teamday-crosscheck.mjs` now runs every day of 2026 at seven hours each through both,
in **five timezones** (Chicago, New York, Los Angeles, UTC, Auckland), including both clock-change
days. **2,555 instants, all agreeing, in each zone.** It is wired into `tests/sales/run.sh`.

Still open, and not this section's to fix: `getMyWork()` in `src/lib/data.js` is still
browser-local, so the **Work page** can be a day out for anyone outside Central. Overview is
correct; Work is not. See §27 and the `team-time-dates-in-the-console` memory note.

---

## §30. Overview realigned onto the Sales rules — Aug 23 2026 (append-only section)
> **Superseded on WHAT EXISTS by §33 (the current spec) and §34 (the state board).** Keep reading this section for the *why* — the reasoning behind several rules lives only here — but trust §33 on how it behaves today.


Follows §27, which built the Overview snapshot, and §26, which built Sales. The two landed within
minutes of each other in parallel sessions, so §27 was written against a repo that did not have Sales
in it yet. This is the reconciliation. **Nothing in the Sales build was changed.** The only file
touched is `src/components/admin/Overview.jsx`, plus three new cases in `tests/overview/test.mjs`.

### What was wrong after the two builds met

**1. Overview linked to a page that no longer exists.** Sales renamed `leads` → `sales`.
`AdminDashboard`'s `setSection` silently falls back to the landing page for an unknown id, so three
tiles, the START HERE button and a jump card all bounced the user back to Overview instead of failing
loudly. Fixed.

**2. Overview was running the retired lead rules.** Its "People to contact" tile read
`getMyWork().contactable`, which buckets on `STALE_AFTER_DAYS` — stale-after-N-days-per-stage. That
predates the claim window, the cold clock and the cadence. So Overview and the Sales page gave two
different answers to "who owes a contact", and Overview's was the obsolete one.

**3. A guessed stage list.** An interim fix named the finished stages by hand and got five of seven
wrong (`cold`, `dead`, `unqualified`, `disqualified`, `nurture` do not exist; `skip_90` and
`bad_contact` were missed). `lib/sales-rules.js` already exports `isOpenStage` for this.

### How it works now

Overview imports the Sales rules rather than keeping a copy:

```js
import { salesQueue, isOpenStage } from "../../../lib/sales-rules.js";
import { listAllLeadActivity, touchCountsByLead } from "../../lib/data.js";
```

- **`Leads owed a contact`** is `salesQueue(...)` filtered by
  `c.over !== null && c.over >= 0 && c.reason !== "unclaimed"` — the same expression `SalesPage.jsx`
  uses for its own `owed` count, character for character. The tile's hint carries the near-misses
  (`going_cold`, `first_contact_due`) as "N more going cold or due soon".
- **`touchCounts`** is **their** `touchCountsByLead()` over `listAllLeadActivity(90)` — the same
  function and the same window `getSalesBoard()` reads. An interim version counted the four touch
  types itself from the documented list; that was right on the day and would have drifted the first
  time somebody added a type in one place only.
- **Pipeline** is `stage !== "new" && isOpenStage(stage)`.
- **START HERE** takes `owed[0]`, already ranked by `salesQueue` (expired claims, then cold, then
  cadence), and prints the card's own `headline` and `detail`.

### The one difference, stated on the page

`salesQueue` takes a `scoreOf` to apply the 90-and-above skip gate. Site scores live on
`admin_companies`, and reading them here would mean a second full companies fetch on a page that is
meant to be one glance — so Overview passes `scoreOf: () => null` and the gate does not run. That
gate only applies at `new` and `researching`, so the effect is bounded: Overview can count a
very-high-scoring firm that Sales leaves out of those two stages.

That is printed under the agency tiles in plain words, next to the read caps. **An unexplained
difference between two pages is a bug; an explained one is a limit.** If a companies reader ever
lands on this page, pass it in and delete the sentence.

### Also carried over

- `listLeads()` and `listAllLeadActivity()` now return a `truncated` message. Overview prints it
  verbatim rather than naming a round number of its own.
- `getMyWork().contactable` is no longer read by any page. It is still exported and still used by
  the Work page — that page has not been realigned, so **Work still uses the retired stale-lead
  rules.** Written into the open list below rather than changed here.

### Proof on record, Aug 23 2026

Everything re-run against the **real** post-Sales repo, not a stub:

- `eslint src/` clean · `vite build` clean, 133 modules
- `tests/overview/run.sh` — **44 assertions × 5 timezones = 220**, up from 205. The three new cases
  pin the agreement: the `owed` filter (an expired claim and a cold firm are owed; unclaimed, someone
  else's, `won`, `skip_90` and `bad_contact` are not; the expired claim outranks the cold one), that
  `isOpenStage` splits all twelve declared stages the way `0009` declares them, and that touch
  counting matches what `cadenceState` documents.
- **Their suites untouched: `tests/sales` 84/84 plus its SQL checks**, finance 53/53, inbox 47/47.
- Playwright over the built bundle: the full page in Chicago (~70 assertions), tile-vs-pill agreement
  in four timezones, the clock frozen to 23:30 on the 2026 fall-back night, and a fault-injected
  bundle where every read errors — which still dashes all ten tiles, names each failure, badges READ
  FAILED and never prints "nothing is late".
- Clicking through to the real Sales page from Overview raises no console errors.

### The collision itself, and the rule it produced

The Sales session and the Overview session both edited `src/lib/data.js` and
`src/components/admin/shared.jsx` within a minute of each other on the night of Aug 22. The Overview
session had staged those files an hour earlier, edited its stale copies, and committed them back with
`force: true` — which switches off the bridge's "has this file changed since you staged it?" guard.
The Sales data layer was absent from disk afterwards and had to be re-saved from the Sales session.

Whether the force-write destroyed it or it had never landed could not be established, which is
itself the lesson: **turning off the mtime guard is what made the question unanswerable.** The rule
now, recorded in project memory as `never-force-commit-a-shared-source-file`: edit a shared source
file in place, and if you must stage and commit, pass `expectedMtimeMs` and let a refusal happen. All
three commits after that point used the guard, and the last one was verified to be the only
difference between the container and the disk before it was sent.

### Still open

- **`getMyWork()` has two problems and the Work page has both.** It buckets tasks on the browser's
  clock rather than the team's (see §27), and its `contactable` still uses `STALE_AFTER_DAYS` rather
  than the Sales rules. Overview is right on both counts; Work is not. The fix is to route
  `getMyWork` through `src/lib/teamDay.js` and `lib/sales-rules.js` and give it the five-timezone
  test both already have.
- `listUsage` orders `ts` ascending with a 5,000-row limit, so an overflow drops the newest rows.
- Migrations 0008 and 0009 have not been run, and none of this has been deployed.

---

## §31. The Overview generator — ask for anything, written from the records — Aug 23 2026 (append-only section)
> **Superseded on WHAT EXISTS by §33 (the current spec) and §34 (the state board).** Keep reading this section for the *why* — the reasoning behind several rules lives only here — but trust §33 on how it behaves today.


Ryder: *"can we also add a ai overview generator that when filled with a prompt and clicked it pulls
all data from the entire admin and pltform and makes up whatever the person prompts."*

A box on Overview. You type what you want, press one button, and it reads everything the console
holds and writes it. Built on the machinery that already existed rather than beside it.

### Two things had to be said plainly before building

**1. "Pulls from the platform" is not possible.** The console has three links to the platform and
none of them is a read: SSO out (`api/platform-sso.js` hands a human a browser tab), token-spend
pings in (`api/usage-ingest.js`), and one 0-100 website score per sales firm
(`api/sales-score.js`, needs `PLATFORM_SCORE_URL`). There are **no scan results, no citation
history, no module state and no GEO score for a paying client** anywhere in this database. So the
generator says so, in the fact sheet, in the modal, and in the saved row's cannot-answer list. It is
not promised anywhere.

**2. The console's AI was blind to Sales and to money.** `loadSystemContext()` — which the
assistant, the notes engine and now this all read — had no `admin_companies`, no
`admin_lead_lists`, no `admin_proposals`, no invoices and no expenses. `"money"` had been in the
owner/admin scope list since Aug 20 **with no loader behind it.** An "everything" answer would have
silently omitted the entire pipeline and every invoice, and answered as if that meant there were
none. Fixed at the source, so the existing assistant gained the same sight.

### What was added to `lib/brain-context.js`

| Part | Cap | Roles | Notes |
|---|---|---|---|
| `companies` | 60 | owner, admin, **sales** | ordered by `site_score` desc. A null score prints "no score yet", never 0 |
| `leadLists` | 25 | owner, admin, **sales** | active only |
| `proposals` | 30 | owner, admin, **sales** | newest first, decided ones included so "we lost Summit" is answerable |
| `invoices` | 60 | owner, admin | whole rows; overdue is derived from dates and amounts, never the stored status |
| `expenses` | 40 | owner, admin | recurring monthly total is computed in the render |

Plus a new closing section in `renderContext`, **`## WHAT THESE RECORDS CANNOT ANSWER`**, naming the
platform, Stripe, unlogged work, and email direction. Without it the AI treats an absent subject as
an absent fact — the difference between "no GEO scores" and "we hold no GEO scores".

### The two modes

This was Ryder's call, offered as a choice because a strict gate would refuse a perfectly good sales
pitch and a free-only version could not be forwarded to anybody.

- **`records`** — the client report's **entire check suite** (`checkReport` from
  `lib/client-report.js`) pointed at the console-wide fact sheet. Every number, date and name must
  appear in it. Invented figures, promise wording, vague amounts, loose dates, slash dates, and any
  line that hands a named person a job all fail. **A failing draft is thrown away whole, never
  edited**, and the counted version is saved with the reason on the row.
- **`free`** — writes what was asked: a pitch, a plan, an outreach email, a script. It may propose
  things the records do not prove. It still may not hand a named teammate a job, and it is told to
  leave a blank (`[their current score]`) rather than invent a figure — an invented figure in a draft
  is one somebody forwards. Badged `DRAFT · NUMBERS UNCHECKED` on the row, in the reader, and in the
  downloaded file, which carries its own warning with no app around it.

Sharing the check suite rather than copying it is deliberate. **Two copies of an honesty rule is one
copy that quietly stops matching.**

### Files

| File | What |
|---|---|
| `lib/console-report.js` | **new**, pure. Modes, presets, the instruction for each mode, the gate, the counted fallback, the markdown export |
| `api/console-report.js` | **new**. POST `{instruction, mode, preset}`, owner/admin |
| `src/components/admin/consoleReports.jsx` | **new**. The panel, the box, the reader, "check the numbers" |
| `supabase/migrations/0010_console_reports.sql` | **new**. `admin_console_reports`, append-only, owner/admin RLS |
| `tests/console-report/` | **new**. 35 assertions, run in two timezones |
| `lib/brain-context.js` | the five new sections above |
| `lib/ai-agent.js` | `converse()` takes an optional `maxTokens`, clamped 256–8000, default unchanged |
| `src/lib/data.js` | `listConsoleReports`, `deleteConsoleReport`, `generateConsoleReportPreview` |
| `src/components/admin/Overview.jsx` | the panel, under "what the console noticed" |

### Decisions worth not re-litigating

- **It uses `converse()` from `ai-agent.js`, not `draft()` from `ai.js`.** `draft()` caps input at
  24,000 characters and a full console snapshot runs past 60,000. Truncating it means writing from
  part of the story with no way for a reader to tell which they got. `converse()` has no input cap.
- **It is given NO TOOLS.** The assistant is the thing that acts. A generator that could write rows
  while writing about them would be impossible to audit.
- **`cappedOut` is a hard failure**, exactly like `inputTruncated` on the client report. Half an
  answer reads exactly like a whole one.
- **Owner/admin only, in the endpoint AND in row-level security.** One of these rows can summarise
  every client, lead and invoice at once, so a rep reading one would walk straight around the role
  scoping in `brain-context.js`.
- **The vault is never in it.** `loadSystemContext` does not read it, so no label, username or secret
  can reach a saved report that gets forwarded.
- **Money keys are ABSENT for a role that cannot see money, not zero.** `"owedCents": 0` for a sales
  rep would be a lie with a number on it. The fallback checks `!== undefined` before printing them.
- **A preset only fills the box** — the same rule as the client report — and it also switches the
  mode, because an outreach email cannot pass the strict gate and a Monday update must never skip it.
- **Length asked for in words beats the preset button.** The button seeded the box; if the person
  then wrote "keep it short", 250 words is what they asked for, not the button's 600.
- **The counted fallback passes its own strict check.** Tested. If it could not, a rejection would
  hand back a second unusable answer.

### Proof on record, Aug 23 2026

Run against the repo **as it stands on disk**, unpacked fresh, not against the authoring copy:

- `eslint .` clean · `vite build` clean
- `tests/console-report/run.sh` — **35 assertions × 2 timezones**, including every refusal: an
  invented number, an invented date, promise wording, an amount with no number, a loose date, and a
  named teammate given a job in either mode.
- **Every other suite unchanged: overview 44 × 5 timezones, sales 84 + SQL, vault 105 + 36 SQL,
  brain 78, inbox 47, finance 53.**
- Playwright over the built bundle: a new 44-check pass driving the real panel — the modal, both
  modes, a preset filling the box and switching the mode, the character limit disabling the button,
  a generate, the counts panel, nested-modal Escape, the saved history, reading it back, a free run
  badged differently, and 400px width. Plus the existing full-page, four-timezone and
  every-read-fails passes, still green.

### Before it works

1. **Run `0010_console_reports.sql`** in the Supabase SQL editor. Until then the words come back but
   the row does not save, and the panel says so rather than pretending.
2. **`ANTHROPIC_API_KEY`** in Vercel. Without it the button still answers — with the counted
   version, and the modal says that in advance.
3. Deploy. None of this has run on admin.aisyndicate.com.

### Still open

- No platform read exists. If one is ever built, the single honest place to add it is a loader in
  `lib/brain-context.js` plus a line removed from the cannot-answer list — nowhere else.
- `listUsage` orders `ts` ascending with a 5,000-row limit, so an overflow drops the newest rows.
- `getMyWork()` still buckets on the browser's clock and still uses the retired stale-lead rules, so
  the **Work page** is a day out for anyone outside Central. See §27 and §30.
- Nothing here has been watched against a real Supabase or a real API key. Every claim above comes
  from the sample store, the pure tests, and the built bundle.

### §31 addendum — the generator is collapsed by default (Aug 23 2026)

Ryder, on seeing it: *"put the ai generator as like a small box but when you click open it enlarges
the box with the full thing."*

The first version was a full-height panel with a section header, a paragraph and an empty state. It
pushed the agency numbers below the fold on a laptop, which is the opposite of what a snapshot page
is for.

Now: **one strip, 71px tall**, sitting between the AI notes and the agency numbers. It carries the
name, the source badge, four examples of what to ask for, how many are saved, and `Open ▾`. Clicking
it unfolds the **whole thing in place** — starting points, the box, the mode switch, the never-sees
line, and everything written before — with `Close ▴` to put it back. **Not a modal**: one click from
the strip to a cursor in the textarea, and the page underneath stays where it was.

`GenerateModal` became `GenerateForm`, rendered inline. The `SectionHeader` above it was removed —
a heading plus a subtitle over a one-line box is more chrome than content. The Read/facts modals
stay modals, because a 1,200-word report needs the room.

Open state is deliberately **not** remembered across loads: small is the default every time you land
on Overview.

Proof: the browser pass now asserts the collapsed height is under 110px, that no textarea exists
while closed, that opening renders the form **without** a modal, that the open box is more than three
times the strip's height, and that Close returns it. 51 checks, all green, plus every suite unchanged.

### §31 addendum 2 — the generator strip sits second on the page (Aug 23 2026)

Ryder: *"put this card at the top of the page."*

Order on Overview is now: the greeting banner → the red "some of this page is missing" panel, when
there is one → **the generator strip** → the five personal counters → your day → what the console
noticed → the agency → money → what changed → jump in.

Two things about that placement are deliberate and should not be swapped:

- **Below the banner, not above it.** The banner is what orients you — the date, what you have on,
  and START HERE. The strip is the first thing you can *act* on. Measured at a 1,100px window: the
  banner ends at 474px, the strip sits at 498px and is 68px tall, so both are above the fold with
  room to spare.
- **Below the red failure panel, never between it and the banner.** The banner's own sentence says
  "Some of the page is missing — see below" about that panel. Anything inserted between the two makes
  that sentence point at the wrong thing.

The browser pass now measures this rather than trusting it: it asserts the strip's top is below the
banner's bottom, above the first counter tile, and inside the first 1,100 pixels.

One test bug worth remembering: Playwright's `hasText` matches the **raw DOM text**, not what CSS
renders. The counter labels are uppercased by `.label` in CSS, so `hasText: /^LATE/` never matched —
the DOM says "Late". Use a `:text-is()` selector on the label, or match the real casing.

---

## §32. The generator: one mode, everything read, and a rating that changes the next answer — Aug 23 2026 (append-only section)
> **Superseded on WHAT EXISTS by §33 (the current spec) and §34 (the state board).** Keep reading this section for the *why* — the reasoning behind several rules lives only here — but trust §33 on how it behaves today.


Ryder, on the first version: *"for this i want it to always come from real stats, it should never be
free or make up anything. thats just a way for it to hallucinate. it has to always pull from the admin
platform and pull all clients, thier info, recent reports, operation, finances, EVERYTHING! and also
after the prompt and the message comes out i want a how was this response then like a five star review
system and a small text box for how you could do better."*

Three changes. All three are corrections to §31, not additions.

### 1. The free draft is GONE

There were two modes; there is one. Every answer is checked against the counts: an invented number,
date or name, promise wording, a vague amount, a loose date, or a line handing a named person a job
all cause the **whole draft to be thrown away** and a counted version to be saved with the reason.

**Why he was right.** The free mode carried a purple `DRAFT · NUMBERS UNCHECKED` badge and a warning
inside the downloaded file. That is not a control. **The person who forwards a document is not the
person who read the badge on it.** A generator that is allowed to invent a figure will eventually
have one of its figures quoted to a client, and the badge will not be in the room.

What replaced the useful half of free mode: the instruction now tells it to write a **square-bracket
blank** — `[their current score]` — wherever it wants a figure the records do not hold. An outreach
email still gets written; the gap is visible instead of filled.

Mechanically:
- `MODES` is `["records"]`, kept as a one-item list rather than deleted so old rows still parse and
  so adding a second mode has to be a deliberate act.
- **`modeOf()` ignores its argument entirely.** An old browser tab, a hand-made POST or a typo all
  land on the checked path. There is a test that passes `"free"` and asserts it comes back
  `"records"`, and another that asserts `buildConsoleInstruction` produces byte-identical output when
  handed `mode: "free"`.
- `checkConsoleReport` has one path. The looser branch is deleted, not disabled.
- `assignsWorkIn` — the free-mode-only guard — was **deleted rather than left unused.** Dead code
  that looks like a control is worse than no code.
- Migration `0011` moves any existing `mode = 'free'` row to `'records'` and tightens the check
  constraint, because a column that still allows a value the code can no longer produce is a trap.

### 2. It now reads everything

`loadSystemContext` gained the last three tables that were outside it:

| Part | Cap | Roles | What travels into the prompt |
|---|---|---|---|
| `clientReports` | 24 | owner, admin | Client, age, written-or-counted, title, and the **first line** of the summary only — a full report is 1,200 words and twenty would be the prompt. Headed with "do NOT repeat these as new findings". |
| `payments` | 60 | owner, admin | `admin_invoice_payments`. Money **actually received**, with a this-calendar-month total. Before this, "still owed" was the only money fact in the snapshot, so "how much did we collect" had no answer. |
| `platformAccounts` | 40 | owner, admin | Which logins exist per client — label, email, plan. Never a password; those live in the vault. |

With §31's additions that makes the snapshot: clients, tasks, weekly logs, leads, lead activity, lead
sources, tickets, email threads, reminders, client sites, standing rules, memory, open notes, team,
firms, lead lists, proposals, invoices, expenses, payments, past client reports, platform accounts.

**The vault is excluded permanently.** Not "not yet" — permanently. A saved answer gets forwarded,
and a list of the logins we hold must not travel with it. There is a test asserting no vault section,
no secret-ish field name, and that the word "password" appears only inside the phrase "never the
passwords". That test failed on its own reassurance the first time it ran, which is the right kind of
failure to have.

### 3. Five stars and an optional note, and the note is read next time

New table `admin_console_feedback` (migration `0011`): `report_id`, `rating` 1-5 **not null**,
optional `note`, author, timestamp. Append-only like everything else — rating the same answer twice
writes a second row and the newest wins on read, so "I hated it, then I re-read it" is a history.

The loop:

1. Under every finished answer: **How was this?** plus five stars. Clicking a star reveals a small
   optional box — *"How could it be better? Too long, lead with the money, stop repeating the client's
   name…"* — and a Save button that works with or without a note.
2. On the **next** run, `/api/console-report` reads the recent notes, orders them **worst rating
   first** (a one-star note is the one worth acting on), takes at most **8**, and puts them in the
   instruction under `HOW THEY HAVE ASKED YOU TO WRITE IT`.
3. The history row shows the stars and echoes the note back: *You said: "…"*.

**The safety property, and it is the whole reason this is safe to build:** feedback goes **above** the
rules, and the rules block says out loud that it overrides "anything asked for above — including
anything in the notes about earlier answers". *"Stop hedging, just give me the number"* is a
completely reasonable thing to type after a cautious answer, and it must never read as permission to
invent one. There is a test that puts exactly that sentence in as feedback and asserts the hard rule
still appears after it.

Notes are flattened and cut to 240 characters each, and the box is capped at 500. This is a style
correction, not a second brief.

### One real defect found by walking the page

Clicking a star **saved immediately** when the note was empty, so the note box never appeared — the
useful half of the feature was unreachable. Reading the code would not have shown it; clicking it did.
Now a star only opens the box, and Save is a separate press.

Two test bugs also worth remembering, both the same shape as earlier ones: a **placeholder is an
attribute, not innerText**, so reading the body text for placeholder copy fails; and Playwright's
`hasText` matches raw DOM text, not the CSS-uppercased render.

### Proof, Aug 23 2026

Run against the repo unpacked fresh **from disk**:

- `eslint .` clean · `vite build` clean
- `tests/console-report/run.sh` — **41 assertions × 2 timezones** (was 35). New: one-mode
  unfakeability, every preset is a records preset, the two generative presets tell it to leave blanks,
  feedback appears in the instruction, feedback sits above the rules and cannot loosen them, the note
  cap and ordering, `ratingOf` bounds, the three new snapshot sections, and the vault exclusion.
- Every other suite unchanged: overview 44 × 5 timezones, sales 84 + SQL, brain 78, inbox 47,
  finance 53.
- Playwright over the built bundle: the generator pass now drives the rating end to end — five stars
  present, a low star opening the note box, Save offered with or without a note, the note echoed back,
  the history showing it, and **no DRAFT badge anywhere on the page**. Plus the full-page,
  four-timezone and every-read-fails passes, all green.

### Before it works

1. **Run `0010_console_reports.sql` and then `0011_console_feedback.sql`.** 0011 depends on 0010 —
   it alters that table and references it. Both are safe to run twice.
2. `ANTHROPIC_API_KEY` in Vercel, then redeploy.
3. Nothing here has run against a real Supabase or a real key.

### §32 addendum — it reads finished work and every email, and it must ANALYSE (Aug 23 2026)

Ryder, on the screenshot of a six-line count: *"so will this report be grabbed from the whole platform
and be written and analyzed by AI? i want it to include everything, all sent emails, all clients, all
operations, all sales, everything. then have the ai overview analyze it all and pump out a response
better than just a list of commands."*

**First, the answer to the question:** what he was looking at was the **counted fallback**, not the AI.
He is running `VITE_NO_SIGNIN=true` — no database key, no AI key — and the panel said so in the yellow
line: *"preview mode — nothing was sent to an AI"*. Worth knowing for the next time somebody reports
that the generator "only makes lists": check the provenance line first.

**Three real holes he was right about, now closed:**

| Was | Now |
|---|---|
| `tasks` read `status != done`, so **finished work was invisible** — a Monday update could say what was late but not what shipped | A **second read**, `tasksDone` (cap 80, newest-updated first), rendered as `## WORK FINISHED` with the note "these are DONE — use them to say what moved, never to say something is still open". Two reads, for the same reason the leads use two: one list cannot be both "what is open, soonest first" and "what we finished" |
| `emails` read only `needs_reply, waiting, scheduled`, so **sent and finished threads were absent** | Every status. The section is now `## EMAIL THREADS`, carries `last_direction` as "WE spoke last" / "THEY spoke last", the message count, and the snippet |
| Caps sized for five clients | clients 40→60, tasks 120→200, leads 90→220, leadActivity 60→120, tickets 30→50, emails 45→120 |

A full snapshot is now roughly 40–60k tokens. Sonnet reads that in one pass through `converse()`,
which has no input cap, so **the ceiling here is cost, not capability.**

**What it still cannot do, and now says so:** we do not store email bodies. Only subject, sender,
snippet and status; the message text lives in Gmail and only the Inbox page fetches it. The
cannot-answer block now says *"Never quote an email body; quote the snippet and say it is a snippet."*

### The shape changed, because a count is not an answer

The old `SHAPE` asked for bullets, so it produced bullets — six numbers restated, which the person can
already see in the tiles on the same page. The new one demands the two things a list cannot do:

- **SUMMARY bullets must be judgements.** *"Lakeside has had nothing planned for eleven days while we
  invoiced them on the 1st"* is a summary line. *"3 clients, 10 open tasks"* is the input.
- **The REPORT must connect things** — a client with late work AND an unpaid invoice AND a quiet
  mailbox is one story, not three rows — **rank by consequence rather than by table**, and explain
  every number in the same sentence it appears in.
- **HOUSE gained:** *"ANALYSE, do not tally. If a paragraph could be replaced by the numbers it
  contains, it is not worth writing."*
- **An explicit ban on the opening move:** no section may start with "There are", "We have",
  "Currently there are", or a bare count. A model told to analyse will still open with a total unless
  it is told not to.

The instruction also now states plainly that it is reading the whole console and that *"the answer is
usually in how two sections line up, not in either one alone."*

### The counted fallback names rows now

It was six totals, which is exactly what he pushed back on. `assembleConsoleFacts` gained a
`highlights` block — the actual late tasks with their clients, blocked tasks, active clients with
**nothing planned at all**, overdue invoices with amounts, unanswered email subjects, recently
finished work — and the fallback prints those instead of counts. It also says *why* it reads like a
list: *"with no model there is nothing to reason with, so it names the rows instead of guessing at
their meaning."*

Every name it prints also appears in the fact sheet, so the fallback still passes its own strict
check. There is a test for that, and it is the reason the fallback cannot be made cleverer without
care.

### Proof

`eslint .` clean · build clean · `tests/console-report` **45 × 2 timezones** (was 41) · every other
suite unchanged (overview 44 × 5 tz, sales 84 + SQL, inbox 47, brain 78, finance 53) · the browser
pass asserts the strip's new copy, that the open box says "open and finished work" and "not a list of
totals", that email bodies are named as never stored, and that the counted version **names a real
task** rather than only counting.

One fixture bug worth keeping: a test called "with nothing wrong" gave an active client no tasks — and
"active client with nothing planned" is a finding, so the code was right and the fixture was wrong.
That check exists because an active client with no open work is the quiet failure nothing else on the
page catches.

---

## §33. THE OVERVIEW PAGE AND ITS GENERATOR — the current spec (Aug 23 2026)

**Read this instead of §27, §30, §31, §32 and their addenda.** Those are the history of how it got
here and they are worth keeping — the *why* behind several rules lives only in them — but they read as
five overlapping accounts. This is one description of what exists now. If this section and an earlier
one disagree, **this one is right and the earlier one is what we used to believe.**

---

### PART A — the Overview page

`src/components/admin/Overview.jsx`. Owner and admin only; a `sales` role never sees it and lands on
Work. Order on the page, and every position in it is deliberate:

| # | Block | Notes |
|---|---|---|
| 1 | **The banner** | Greeting, the team's date, one plain sentence of what you have on, and a START HERE button pointing at the single most urgent thing |
| 2 | **"Some of this page is missing"** | Red, only when a read failed, and it must stay directly under the banner because the banner says "see below" about it |
| 3 | **The generator strip** | 68–87px. Part B below |
| 4 | **Your five numbers** | Late · Due today · Reminders due · Leads owed a contact · Tickets on you |
| 5 | **Your day** | Late and due-today tasks with an inline **Done**; reminders due with a tick-box; a one-line "coming up" |
| 6 | **What the console noticed** | The AI notes, most urgent first, with an inline **Dismiss** |
| 7 | **Where everything stands** | Active clients · Emails needing a reply · Open tickets · Pipeline · New leads this month, then the read-caps caption |
| 8 | **Clients that need attention** | Late and blocked task counts per **active** client |
| 9 | **Money, one line** | Recurring revenue · still owed · AI spend this month, each with its own badge |
| 10 | **What changed lately** | The activity log |
| 11 | **Jump in** | Work · Sales · Operations · Inbox |

**The rules that keep it from becoming a second Work page:** every block is capped and links to the
page that owns it; the only inline actions are one-click ones (tick, done, dismiss) — anything needing
a form sends you elsewhere.

**Where its numbers come from, and this is the part people get wrong:**

- **Dates** go through `src/lib/teamDay.js`, never the browser's clock. See §27 for the three bugs that
  taught us this. `getMyWork()`'s own buckets are **ignored** — Overview re-buckets on the team
  calendar itself, because `getMyWork` is still browser-local.
- **"Leads owed a contact"** is `salesQueue()` from `lib/sales-rules.js`, filtered by the *same
  expression* `SalesPage.jsx` uses for its own `owed` count, with **their** `touchCountsByLead()` over
  the same 90 days. The two pages cannot disagree by construction. The one difference — no site score,
  so no 90+ skip gate — is printed on the page.
- **Pipeline** uses their `isOpenStage`, never a hand-written stage list.
- **A failed read shows a dash and names itself.** Never a zero. Ten tiles take a `broken` prop, a red
  panel names each failure, and the words "nothing is late" are suppressed whenever anything failed.

---

### PART B — the generator: "Ask for anything, written from the records"

One strip on Overview. Click it and the whole thing unfolds **in place** — five starting points, the
box, and everything written before. Not a modal: one click from the strip to a cursor in the textarea.

#### What it does

You type what you want. `POST /api/console-report` reads the whole console, Claude writes it, the
answer is checked against the counts, and the row is filed with the counted figures beside it.

Five presets **only fill the box** — the typed text is the only thing that travels, so what you send is
always what you can see: *where everything stands · what is about to go wrong · ready for a client
call · an outreach email · a plan for the week*.

#### ONE mode. There is no unchecked path

Every answer is gated. An invented number, date or name; promise wording; a vague amount; a loose
date; a slash date; a line handing a named person a job — any of those and **the whole draft is thrown
away**, not edited, and a counted version is saved with the reason on the row.

There used to be a "free draft" that skipped this. It is gone, and the reason is the rule:
**a badge is not a control, because the person who forwards a document is not the person who read the
badge on it.**

Made unfakeable rather than merely removed:
- `MODES` is `["records"]`, a one-item list so adding a second is a deliberate act.
- **`modeOf()` ignores its argument.** An old tab, a hand-made POST or a typo all land on the checked
  path. Tested by passing `"free"` and asserting `"records"` comes back.
- `checkConsoleReport` has one branch. The looser one is deleted.
- The free-only guard `assignsWorkIn` was **deleted, not left unused** — dead code that looks like a
  control is worse than no code.
- Where it wants a figure we do not hold it writes a **square-bracket blank**, `[their current
  score]`, for a person to fill in.

The checks themselves are `checkReport` from `lib/client-report.js`, imported not copied. **Two copies
of an honesty rule is one copy that quietly stops matching.**

#### What it reads — 23 tables, via `loadSystemContext()`

| | |
|---|---|
| **Delivery** | clients (60) · open tasks (200) · **finished tasks (80)** · weekly logs (40) · client sites (60) |
| **Sales** | leads (220 + 40 recent) · lead activity (120) · lead sources (20) · firms (60) · lead lists (25) · proposals (30) |
| **Comms** | **every email thread, any status (120)** · tickets (50) |
| **Money** | invoices (60) · payments (60) · expenses (40) |
| **Knowledge** | standing rules (60) · memory (60) · open notes (40) · past client reports (24) |
| **People/access** | team (25) · reminders (40) · platform accounts (40) |

Role-scoped by the same `SCOPE_BY_ROLE` the assistant uses. Money is owner/admin only; firms, lists and
proposals are visible to `sales` too.

A full read is roughly **40–60k tokens**, which is why it goes through `converse()` from
`lib/ai-agent.js` (no input cap) and **never** `draft()` from `lib/ai.js` (hard cap 24,000 chars).
Truncating would mean writing from part of the story with no way for a reader to tell. **The ceiling
here is cost, not capability.**

Given **no tools**. The assistant acts; a generator that could write rows while writing about them
would be unauditable.

#### What it can never see

- **The vault.** Permanently, not "not yet". A saved answer gets forwarded and a list of the logins we
  hold must not travel with it. Tested.
- **Anything on the AI Syndicate platform.** No scan results, no citation history, no module state, no
  GEO score for a paying client. The only platform number anywhere is `admin_companies.site_score`,
  and only where one has been run.
- **Money taken through Stripe.** Only the invoices we issued ourselves.
- **The text of any email.** Subject, sender, snippet and status only — bodies live in Gmail. It is
  told *"never quote an email body; quote the snippet and say it is a snippet."*
- **Anything nobody wrote down.**

All five are printed in the fact sheet itself, under `## WHAT THESE RECORDS CANNOT ANSWER`. Without
that block a model treats an absent subject as an absent fact — the difference between "no GEO scores"
and "we hold no GEO scores".

#### It must ANALYSE, not tally

A count is the input, not the answer — the person can already see the tiles on the same page. So:

- Summary bullets must be **judgements**. *"Lakeside has had nothing planned for eleven days while we
  invoiced them on the 1st"*, not *"3 clients, 10 open tasks"*.
- The report must **connect things** — late work plus an unpaid invoice plus a quiet mailbox on one
  client is one story, not three rows — and **rank by consequence, not by table**.
- House rule: *"ANALYSE, do not tally. If a paragraph could be replaced by the numbers it contains, it
  is not worth writing."*
- **No section may open with a count.** "There are", "We have", "Currently there are" are banned by
  name, because a model told to analyse will still lead with a total unless forbidden.

#### The counted fallback

Runs when there is no AI key, the model refuses, or a draft fails the gate. It **names rows**, not
totals: which late task and for which client, which blocked task, active clients with **nothing
planned at all**, overdue invoices with amounts, unanswered emails by subject, recently finished work.
It also says why it reads like a list — *"with no model there is nothing to reason with"*.

Every name it prints also appears in the fact sheet, so **the fallback passes its own strict check**.
There is a test for that, and it is why the fallback cannot be made cleverer without care.

#### The rating, and why it is safe

Under each answer: five stars and a small optional box. On the **next** run the endpoint reads recent
notes, orders them **worst-rating first**, takes 8, and puts them in the instruction.

**The safety property:** notes go **above** the rules, and the rules say out loud that they override
"anything asked for above — including anything in the notes about earlier answers". *"Stop hedging,
just give me the number"* is a reasonable thing to type after a cautious answer and must never read as
permission to invent one. Tested with exactly that sentence.

**Any feedback loop into a prompt needs this shape: correction above, constraint below, and the
constraint saying it wins.**

Clicking a star only **opens** the box; Save is a separate press. It used to save instantly on an empty
note, which made the note — the useful half — unreachable. Found by clicking, not by reading.

#### Files

| File | What |
|---|---|
| `lib/console-report.js` | pure: the one mode, presets, the instruction, the gate, the feedback rendering, the counted fallback, the markdown export |
| `api/console-report.js` | POST `{instruction, preset}`, owner/admin |
| `src/components/admin/consoleReports.jsx` | the strip, the form, the reader, the stars |
| `supabase/migrations/0010_console_reports.sql` | `admin_console_reports`, append-only |
| `supabase/migrations/0011_console_feedback.sql` | `admin_console_feedback`, append-only; also tightens the mode check |
| `lib/brain-context.js` | the 23-table snapshot and the fact sheet |
| `tests/console-report/` | 45 assertions, two timezones |

#### Gates

- **`0010` then `0011`**, in that order — 0011 alters 0010's table. Both safe to run twice.
- **`ANTHROPIC_API_KEY`** in Vercel. Without it the button still answers, with the counted version,
  and the box says so before you press it.
- Owner/admin in the endpoint **and** in row-level security, on both tables. One saved row can
  summarise every client, lead and invoice at once.

---

## §34. STATE BOARD — replaces §28 as the current picture (Aug 23 2026, end of session)

Nothing in this repo has ever run on admin.aisyndicate.com. Every claim below is from the sample
store, the pure test suites, a real Postgres for the SQL suites, and Playwright over the built bundle.

### THE PAGES

| Page | Roles | State |
|---|---|---|
| **Overview** | owner, admin | Rebuilt Aug 22 as the daily snapshot, realigned onto the Sales rules Aug 23, and now carries the generator strip. §33 |
| **Finance** → Invoices | owner, admin | Aug 20. §18, §19 |
| **Customers** | owner, admin | Stripe customers |
| **Work** | all | Aug 17. **Still uses the browser's clock and the retired stale-lead rules — see the gaps** |
| **Sales** | all | Replaced Leads on Aug 22. Claims, the 3-day first-contact window, the 14-day cold clock, the 5-touch cadence, the 90+ gate. §26 |
| **Operations** | owner, admin | The Notion-format task database. §12 |
| **Inbox** | owner, admin | Shared growth@ mailbox with AI drafting. §14 |
| **Tickets** | owner, admin | Support desk |
| **Notes / AI Brain / Our platform** | owner, admin | AI notes, the memory and standing rules, a static description of the platform. §21 |
| **Vault / Team / Settings** | owner, admin | Encrypted secrets, the roster, config. §23 |

### THE ENDPOINTS — 24

`ai-chat` · `ai-draft` · `client-report` · `client-standing` · **`console-report`** · `gmail-accounts`
· `gmail-auth-start` · `gmail-callback` · `gmail-drafts` · `gmail-modify` · `gmail-send` ·
`gmail-thread` · `gmail-threads` · `health` · `invite` · `lead-scrape` · `notes-generate` ·
`platform-sso` · `sales-score` · `sales-sweep` · `stripe-customers` · `stripe-finance` ·
`stripe-metrics` · `usage-ingest` · `vault-secret`

### MIGRATIONS — 11, and **four have never been run**

| | State |
|---|---|
| 0001–0006 | run |
| **0007** finance | **not run** |
| **0008** vault + client reports | **not run** |
| **0009** sales | **not run** |
| **0010** console reports | **not run** |
| **0011** console feedback | **not run** — and it must go **after 0010** |

*(0007 and 0008's state should be confirmed in Supabase rather than trusted from here — earlier boards
disagree about 0007.)*

### KEYS AND VARS

| Var | For | State |
|---|---|---|
| `VITE_SUPABASE_URL` / `_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | everything | set |
| `ANTHROPIC_API_KEY` | the assistant, client reports, notes, **the generator** | **not set** |
| `VAULT_KEY` | the vault | **not set**, and losing it makes stored secrets unreadable for ever — put it in Bitwarden the same minute |
| `STRIPE_SECRET_KEY` | Finance, Customers | not set |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `GMAIL_REDIRECT_URI` | Inbox | not set |
| `USAGE_INGEST_KEY` | the platform's token-spend feed | not set |
| `PLATFORM_SCORE_URL` (+ `PLATFORM_SCORE_KEY`) | the Run-score button on a firm | not set. **Not reported by `/api/health` and not in `.env.example`** — a real gap |
| `CRON_SECRET` | the overnight claim sweep | not set |
| `PLATFORM_URL` / `PLATFORM_ACCOUNT_EMAIL` | SSO into the platform | partial |
| `PLATFORM_LEADGEN_URL` / `_KEY`, `APOLLO_API_KEY` | lead scraping | not set |

### TESTS — seven suites

| Suite | Count |
|---|---|
| `overview` | 44 × **5 timezones** |
| `console-report` | 45 × 2 timezones |
| `sales` | 84 + 20 SQL against a real Postgres |
| `vault` | 105 + 36 SQL |
| `brain` | 78 (its SQL cross-check cannot run as root in a container) |
| `inbox` | 47 — **run it with `bash tests/inbox/run.sh`**, a bare `node test.mjs` fails on its stubs |
| `finance` | 53 |

Plus four Playwright passes over the **built bundle**: the full Overview page; tile-vs-pill agreement
in four timezones; the clock frozen to 23:30 on the 2026 fall-back night; and a second bundle where
**every read returns an error**, asserting the page names each failure, dashes all ten tiles and never
says "nothing is late".

### DO THIS NEXT, IN ORDER

1. `npm run build` in Cursor. Confirm it passes on the Mac, then push and deploy.
2. Run the migrations: **0007, 0008, 0009, 0010, 0011** — 0011 last.
3. Set `ANTHROPIC_API_KEY` and `VAULT_KEY` (Bitwarden), then **redeploy** — env vars only reach a build.
4. Press the generator against real rows. Rate one badly on purpose and check the next answer changes.
5. Then the rest of the keys as the features are wanted.

### KNOWN GAPS, written down rather than hidden

- **The Work page is a day out for anyone outside Central**, and its "people to contact" still uses the
  retired stale-lead rules. Overview is right on both counts; Work is not. Route `getMyWork()` through
  `src/lib/teamDay.js` and `lib/sales-rules.js` and give it the five-timezone test both already have.
  **This is the top of the list.**
- `listUsage` orders `ts` **ascending** with a 5,000-row limit, so an overflow drops the **newest**
  rows and AI spend reads low. Should be descending.
- `/api/health` does not report `PLATFORM_SCORE_URL`, and it is missing from `.env.example`.
- **No platform read exists.** Three links only: SSO out, token spend in, one site score per firm. If
  one is ever built, the single honest place to add it is a loader in `lib/brain-context.js` plus a
  line removed from the cannot-answer list — nowhere else.
- Support tickets are matched to a client by contact email; `admin_tickets` has no `client_id`.
- Marking a lead Won does not create the client record. `admin_companies.client_id` is written by
  nothing.
- "They replied and you have not answered" cannot be built: `admin_lead_activity` has no direction
  column and `admin_email_threads` carries only `last_direction`.
- No vault key rotation tool. A wrong key says so plainly; rotating means revealing and re-saving each
  secret while the old key is still set.
- **Nothing has been watched against a real Supabase or a real API key.** Every "it works" in this
  document is the sample store, a pure test, or a fault-injected bundle.

---

## §35. Overview trimmed, Operations click-to-filter, and ONE-ANSWER reports — Aug 23 2026, later session (append-only section)

Appended, nothing above rewritten. **This section overrides §31, §32 and §33 wherever they disagree,
and parts of §30's Overview description.** What it makes untrue, named so nobody trusts the old text:

| Now false | Where it says it | The truth |
|---|---|---|
| "Every report has two layers, always" + a third tab | §33 (~line 2105) | ONE answer. No layers, no tabs. |
| The Overview greeting banner, the team date, the one-line "you have N late", START HERE | §30/§31/§33 and the numbered Overview table | All removed. There is no banner. |
| "Clients that need attention" is row 8 of Overview | §33 | Removed. |
| "the banner ends at 474px, the strip sits at 498px", and the Playwright assertion about it | §31 addendum 2 | There is no banner to measure. |
| Overview order: banner → strip → counters | §31/§32 | Now: red "some of this page is missing" panel → the generator strip → **Yours / Your day right now** counters → **The agency / Where everything stands** counters → tasks + reminders → what the console noticed → money → what changed → jump in. |

### 1. Overview — what Ryder cut, and what went with it

Asked for in his words: the greeting card is *"basically useless"*, and "Clients that need attention"
is *"useless because the other sections already state everybody who needs follow up"*. Both are gone.
Dead code removed with them, not left running every 60 seconds: `greeting()`, `longDate()`,
`firstName`, `mode`, `allClear`, `anythingMissing`, the whole `byClient`/`attention` tally, the
`headline` (START HERE) chain, and the now-unused `TEAM_TZ` import. The two counter rows are stacked;
the first gained a header ("Yours / Your day right now") so two five-tile rows read apart.

The generator panel lost its two describe-itself paragraphs and both field hints. **One line was put
back on purpose:** "Every number is checked against the records. It cannot see the vault, Stripe, the
platform's scores, or the text of an email." What the tool cannot see is not decoration — somebody who
does not know it is missing will ask it for a GEO score and believe the answer.

### 2. Operations — click a value to filter, and to group

The cells were already click-to-edit, so a plain click could not mean two things. The two actions sit
at the TOP of the menu the click already opens (`FilterHead`, src/components/admin/opsCells.jsx):
**Show only <value>** and **Group the table by <Column>**. Group headers gained **Only this**.

- Client and Owner filters are routed into the two dropdowns that already exist for them, so a filter
  set by clicking is visible in the control you would have used by hand. Status, Priority, Category
  and Phase go into a new `facets` object in Operations.jsx.
- Clicking the value that is already filtered clears it.
- Active filters render as removable chips under the toolbar, plus **Clear all**. A filter you cannot
  see is a table that looks broken.
- Due date has **Group by** but no "Show only" — one exact date is not a useful filter.
- `facets` is deliberately NOT persisted to localStorage. `writePrefs` still stores only
  `{viewId, byView, columns}`.
- Coercion gotcha, caught by a checker: `filterFor` sends `value || "__none"`, not `?? "__none"`,
  because `visibleHere` compares `String(t[k] || "__none")`. With `??` a field holding `""` set a
  filter that matched nothing.

**Due date is now the LAST column.** The row sort is unchanged — soonest due still first.

### 3. Long reports were unreadable at the bottom

`.adm-modal-body` had `overflow-y: auto` but no `flex: 1 1 auto; min-height: 0`. A flex item defaults
to `min-height: auto`, so it refused to shrink and the tail of a long report was pushed past the
modal instead of scrolling inside it. Fixed in src/admin.css, with `overflow: hidden` on `.adm-modal`
to keep the corners and 28px of bottom padding so the last line is not against the footer.

### 4. ONE ANSWER — the report shape

Ryder: *"i want when someone ever generates like a report or anything where ai is giving an overview
custom to a prompt i want it to be just one response that speaks and formats the data to how the
memory and prompt suggest."*

- The prompt no longer imposes SUMMARY / REPORT / WATCH OUT. It asks for one `TITLE:` line and then
  the answer once, in the shape the request itself asks for. The saved feedback notes (the "memory")
  still steer tone, length and what to lead with, and still cannot loosen the rules.
- `parseAnswer()` in lib/client-report.js replaces `parseReport()` on the live path. It takes the
  title line and keeps everything else as `body`. `summary` is `""` on every new row; `watch` is null.
- **The number gate is unchanged.** `checkReport` still runs every check over
  `[title, summary, body, watch].join("\n")`, and the whole answer is now in `body`, so nothing
  escaped by moving. The only loosening: the old rule demanded a summary AND a body; now an answer is
  refused only if both are empty. An old-shape row (summary, no body) still reads — asserted in
  tests/vault/test.mjs so it is a decision, not a drift.
- Four content-loss bugs a checker caught in `parseAnswer` and fixed the same hour: a `##` heading on
  the first line was eaten as the title; `## Report` / `## Summary` headings the model chose were
  deleted; a title-only answer was thrown away; a missing title saved the row as "Overview", the one
  word the prompt forbids. All five cases are in tests/vault/test.mjs.
- Both readers (client report modal, console generator modal) are one scroll: provenance → the answer
  → **What these records cannot answer** at the bottom, inside the same document. The gaps list stays.
  A gap nobody mentions reads as "checked, all fine".
- `lib/brain-context.js` was reading `r.summary` for the assistant's report headlines and would have
  gone blank on every new row — now `summary || body`, skipping heading lines. Same for the
  EARLIER-REPORTS history in lib/client-report.js, which otherwise quoted "## In short".

### 5. Proof, and what is still unproven

eslint clean over src, lib, api and tests. Suites: console-report 46, overview 44, vault 106,
finance 53, sales 84, brain 78, inbox 47 — all green. Watched in Chrome on localhost:5173: filter and
group from a cell menu and from a group header, the chip bar and its ×, Due date last, a generated
report read to its final line, both modals with no tabs.

**Unproven:** the AI path of the one-answer shape. Preview mode has no `ANTHROPIC_API_KEY`, so every
report watched today was the counted fallback. Nobody has yet seen a model answer under the new SHAPE
pass or fail the gate. That is the first thing to press once the key is in Vercel.

---

## §36. Clickable column headers + a real Description on every task — Aug 23 2026, same session (append-only section)

Appended. **Two corrections to §35 first**, because §35 was written an hour before this and is now
wrong in two places:

1. §35 §2 says *"`writePrefs` still stores only `{viewId, byView, columns}`"*. It stores
   `{viewId, byView, columns, colsSeen}`. `facets` is still deliberately NOT persisted — that part
   holds.
2. §35 §2 describes the cell menus (`FilterHead`) as the only way to filter from the table. The
   column headers now do it too, and they are the better path. Both exist.

### 1. The header is a control

Ryder: *"i want the title at the top of the row to be clickable to filter it."* `ColumnHead` in
src/components/admin/opsTable.jsx. Clicking a header opens: **Group the table by <Column>**,
**Clear this filter** when one is on, then every value the column holds with a count — commonest
first, "none" last.

**The value list is built from ALL tasks, not the rows on screen.** First version counted the
filtered rows, and a checker caught what that does: filter Category = Access and the Phase menu
offered only the phases inside Access, so Month 1 could not be reached from a header at all. Watched
fixed: with Category = Access showing 1 row, the Phase menu still lists Ongoing 5, Onboarding 3,
Month 1 2, Month 2 2.

Text columns (Task, Latest report, Description) stay plain `<th>` text — there is no value list to
offer and a header that opens an empty menu is worse than one that does nothing. Due date gets
group-by only. The client page's task table passes no `onFacet`/`onGroupBy`, so its headers are plain
text and nothing throws.

Two more things the checker caught here: the group header's **Only this** button read the same when
clicking it would REMOVE the filter (now "✓ Only this"), and `facetValue("assignee")` reported
`"__me"` as an active value, lighting the header dot next to a menu where nothing was ticked (now
undefined — the chip bar is where "Owner: just mine" shows).

### 2. Description — the standing brief

Ryder: *"in operations i want to have a description for the project that can go more in depth."*
New column `admin_tasks.description`, **migration `0012_task_description.sql`, and SETUP.md now has
the run-it step** — §35 shipped a migration nobody was told to run.

- `description` = what the work is, why, what done means, links and logins.
  `latest_report` = where it stands right now. Two fields on purpose: the second is rewritten every
  week, and a brief does not belong in a field that gets overwritten.
- Editable in the table cell (multiline) and in the task modal, where it is a tall field under
  Latest report. Included in the page's search box.
- **`white-space: pre-line` on the cell, clamped to 3 lines.** The first version rendered it in a
  flex row with no white-space rule, so a brief typed as three labelled lines read back as one
  run-on paragraph — the exact structure the field exists for.
- `.adm-db-table` min-width raised 1120 → 1500 and `thead th` now clips: two 340px columns were added
  to a table whose min-width was never raised, and `th` (unlike `td`) had no overflow rule, so
  "PRIORITY ▾" painted over the next header in a narrow window.

**LIVE MODE BEFORE THE MIGRATION IS RUN — the worst bug in this change, and it is fixed.** The task
modal sent `description` unconditionally, so Postgres rejected the whole row: a console without 0012
could not save ANY task edit, not even a due date, and the error read `PGRST204`. Now the save
retries without the brief, saves everything else, and says in plain words to run the migration. The
in-cell path rolls back and says the same.

### 3. Prefs: no version ladder

`colsSeen` in Operations.jsx is the list of column keys this browser has already been offered.
Anything in COLUMNS that is not in it is switched on once; a column switched off later stays off.
It replaced a `colsV` number, because a numbered ladder only upgrades people who open the page at
every single version — someone who skipped v2 would get v3's column and never v2's.

### 4. KNOWN GAPS from this change

- **The assistant cannot search a brief.** `lib/assistant-tools.js` still filters tasks on
  `name` and `latest_report` only. Adding `description.ilike` there would make every task search
  fail with a Postgres error until 0012 is run, so it waits for the migration.
- **`description` reaches no AI surface at all** — not the report fact sheets, not
  `loadSystemContext`, not client standing. That is deliberate (it is free text a person types), and
  it also means the brief is invisible on the Work page, where the person doing the work reads.
- **No test suite covers the Operations page.** `ColumnHead`, `applyFacet`, `colsSeen` and the
  description search path have zero automated coverage; everything above was watched in Chrome
  instead. `colsSeen` is pure and should have a test.
- `_to_delete/LeadsPage.jsx.replaced-by-SalesPage` is untracked in the working tree and must not be
  committed.

### 5. Proof

eslint clean over src, lib, api, tests. console-report 46, overview 44, vault 106, finance 53,
sales 84, brain 78, inbox 47 — green. Watched in Chrome on localhost:5173: a header menu filtered and
grouped, the ● dot and the chip appeared together, the Phase menu stayed complete under a Category
filter, a brief typed straight into a cell saved and read back with its line breaks, and the task
modal showed the brief in full. Grouping was set back to **Client** at Ryder's request — a test
earlier in the session had left his saved view on Category.

---

## §37. Titles SORT. The Description pops out. — Aug 23 2026, same session (append-only section)

**Corrections to §35 and §36 first. Both were written earlier today and both are now wrong.**

| Now false | Where | The truth |
|---|---|---|
| "Clicking a header opens: Group the table by \<Column\>…" | §36 §1 | Clicking a header **sorts**. The filter/group menu moved onto a small **▾** button beside the title. |
| "Text columns (Task, Latest report, Description) stay plain `<th>` text" | §36 §1 | Every title is a sort button. Only the ▾ is limited — text columns have no value list, so they get no caret. |
| "The client page's task table … headers are plain text" | §36 §1 | Its headers sort too. It still passes no `onFacet`/`onGroupBy`, so it has no ▾. |
| "Editable in the table cell (multiline)" | §36 §2 | The Description cell **pops out** into a floating editor. Latest report still edits in the cell. |
| "The row sort is unchanged — soonest due still first" | §35 | True only when nothing is sorted. That is now the third state of a three-click cycle. |
| ".adm-db-table min-width 1500" | §36 §2 | 1990px — the sum of the declared column widths. See below. |

### 1. Clicking a title sorts

Ryder: *"i wanted to be able to just click the row and it would sort the tasks in that row, for every
click it gives it a new sorting list."* Three states per column: the useful direction (High first,
soonest first, A→Z), the other way, then off. The arrow ↑/↓ and a filled pill show which column is
sorting; `aria-sort` on the `<th>` says the same thing out loud, because both the arrow and the
filter dot are `aria-hidden`.

Sorting happens INSIDE each group, so grouping by client and sorting by priority does both.
Not persisted — a sort is a thing you do for a minute, unlike grouping and columns.

**The sort logic moved to `src/lib/opsSort.js`, a plain .js module, and `tests/ops/test.mjs` is the
18-test suite it should have had from the start.** It shipped with zero coverage and a checker found
three real bugs in the hour:

1. **"Stop sorting by X" re-sorted the table.** It called the toggle twice, which from the reversed
   state lands back on the first state. It now clears the state directly. The test that documents why
   is called *"two blind toggles can NOT clear a reversed sort"*.
2. **In-band sentinels.** Missing values were encoded as the numbers 9 / 99 / -1 and then tested for.
   `admin_tasks.phase` has NO check constraint (0001_admin_init.sql), so any phase outside the five
   in the UI list — an import, different casing, "Month 4" — came back as `indexOf` -1, counted as
   blank, and sank to the bottom in both directions, **while `groupTasks` used that same -1 as a rank
   and floated it to the top**. Sort and group disagreed about one row. Values are now `{ blank, v }`,
   and present-but-unknown sorts after the known values without being blank. It also means the 10th
   status or phase anyone adds is no longer silently treated as empty.
3. **An unknown column key silently reordered everything.** `sortValue` returned `""` by default, all
   rows compared equal, and the comparator fell through to the due-date tie-breaker — the arrow said
   "sorted by X" while the table was sorted by something else. `sortRowsBy` now refuses any key not
   in `SORTABLE`.

### 2. The Description pops out

Ryder: *"when i click the description box and the text is larger than the box then it pops it out so
you can read the full description."* `PopoutCell` + `Popout` in opsCells.jsx. Esc undoes, Save saves,
Cmd/Ctrl+Enter saves, clicking away saves. The caret starts at the END of the existing text — without
that, autoFocus put it at position 0 and the first thing typed landed in front of the brief.

Five things a checker caught, all fixed:

- **The draft was thrown away if the row disappeared.** A refresh from another session, or a filter
  the row stopped matching, unmounted the editor and 400 words went with it, no toast. Unsaved text
  is now saved on unmount, guarded by a `settled` ref so Save and Escape cannot double-fire.
- **Clicking the cell again saved AND reopened.** The obvious close gesture reopened the editor in the
  same click. The owning cell is now recognised and the click is swallowed.
- **The mirrored draft could be one keystroke stale.** It was written in an effect, but the
  outside-click listener is a native capture listener that runs BEFORE React flushes effects. It is
  written in `onChange` now, so all three save paths read the same value.
- **z-index 1300 put it under the assistant panel** (which sets 9000 inline), so with the assistant
  open the Save button was unclickable and the only way out was Escape, which discards. Now 9600.
- Dragging the window scrollbar counted as "clicking away". It does not any more. Focus returns to
  the cell on close, and the dialog carries `aria-modal`.

### 3. The table stopped shrinking its columns

`.adm-db-table` is `table-layout: fixed` and the declared widths now total ~1990px. At min-width 1500
every column was scaled down, and the header's new arrow and ▾ were the first things `overflow:
hidden` ate — the filter menu became unreachable for Priority, Status and Phase at ordinary laptop
widths. min-width is now the real sum; the table scrolls sideways instead.

### 4. Still open after this

- `MISSING_DESCRIPTION` in Operations.jsx was `/description/i` and matched any error containing the
  word. Tightened, but it is still a string match on a Postgres message — the real fix is running
  migration 0012.
- The pre-migration wording in SETUP.md said a rejected brief "puts the cell back". With the popout
  the editor has already closed by the time the patch fails, so the typed text is gone, not restored.
  Corrected in SETUP.md.
- No test covers `Popout`, `ColumnHead`, `applyFacet` or `colsSeen` — only the sort is tested, because
  only the sort was moved somewhere node can import. The rest was watched in Chrome.
- The assistant still cannot search a Description (§36 §4) and `description` still reaches no AI
  surface.

### 5. Proof

eslint clean over src, lib, api, tests. **ops 18 (new)**, console-report 46, overview 44, vault 106,
finance 53, sales 84, brain 78, inbox 47 — all green. Watched in Chrome: one click on Priority put
High first with the ↑ pill, the second reversed it, the third cleared it; the Description popped out
with the full brief, took typing at the end, saved on click-away, and its title row stayed on one
line.

---

## §38. EVERYTHING BUILT ON AUG 23 2026, AND THE STATE BOARD THAT REPLACES §34

**Read this section and §33. Skip §30–§32 and §34 unless you want the reasoning.** Aug 23 produced
four working sessions and six sections; this one is the single account of what exists at the end of
the day, and the board below **replaces §34**. Where §34 and this disagree, this wins.

Everything in this section is committed: `57e2530 Add task descriptions and a sortable Operations table`.

### PART 1 — WHAT WAS BUILT TODAY, IN ORDER

| # | Built | Detail lives in |
|---|---|---|
| 1 | **Overview realigned onto the Sales rules** — it calls `salesQueue()`, `isOpenStage` and `touchCountsByLead()` from `lib/sales-rules.js`, so it cannot disagree with the Sales page about who is owed a contact | §30 |
| 2 | **The Overview generator** — type what you want, it reads 23 tables and Claude writes it, every number gated against the counts. Collapsed to a strip, first on the page. Five stars and a note that steers the next run | §31, §32, §33 |
| 3 | **`loadSystemContext()` widened from 14 tables to 23** — the assistant and the notes engine got all of it for free | §31 |
| 4 | **Overview trimmed** — the greeting hero and "Clients that need attention" removed, the two counter rows stacked, the generator panel's describe-itself paragraphs cut | §35 |
| 5 | **Reports are ONE answer** — no more 30-second/full/gaps tabs, in the client report AND the console generator. The number gate is unchanged | §35 |
| 6 | **Operations: click a value to filter** — two actions at the top of every cell menu, "Only this" on group headers, removable filter chips | §35 |
| 7 | **Operations: Due date moved to the last column** | §35 |
| 8 | **Long report modals scroll to the end** — `.adm-modal-body` needed `flex: 1 1 auto; min-height: 0` | §35 |
| 9 | **Operations: a ▾ menu on every column header** — group by it, clear its filter, or pick any value it holds with a count, counted from ALL tasks | §36 |
| 10 | **`admin_tasks.description`** — the standing brief on a task, separate from `latest_report`. Migration **0012** | §36 |
| 11 | **Clicking a column TITLE sorts** — three states, inside each group, with `aria-sort` | §37 |
| 12 | **The Description cell pops out** into a floating editor that saves on click-away and on unmount | §37 |
| 13 | **New files**: `lib/console-report.js`, `api/console-report.js`, `src/components/admin/consoleReports.jsx`, `src/lib/teamDay.js`, **`src/lib/opsSort.js`**, migrations `0010` `0011` `0012`, tests `overview/` `console-report/` **`ops/`** | §33, §37 |

### PART 2 — THE FIVE RULES TODAY ADDED, none of them about this feature

1. **One answer, not layers.** Any AI output built from a person's own prompt is ONE response shaped
   by that prompt and by the saved feedback notes. No house template, no summary followed by the same
   thing again. The gaps list stays, at the bottom of the same document. §35
2. **A gate is not a badge.** Every number in a written answer must appear in the counts, or the draft
   is thrown away and the counted version is saved with the reason. There is no looser mode. §32
3. **Never send a column the database may not have.** Postgres rejects the whole row, so one new field
   killed every save on the page. Either run the migration first or retry without the field. §36
4. **Never encode "missing" as an in-band number.** 9 / 99 / -1 as "blank" sentinels made an unknown
   phase sink in the sort while the grouping floated it to the top — the same row, two answers. §37
5. **Move pure logic out of .jsx so it can be tested.** The sort shipped with zero coverage and a
   checker found three real bugs in an hour; `src/lib/opsSort.js` + `tests/ops` exist because of it. §37

### PART 3 — STATE BOARD (replaces §34)

Nothing in this repo has ever run on admin.aisyndicate.com. Every claim is from the sample store, the
pure suites, a real Postgres for the SQL suites, Playwright over the built bundle, or watched in Chrome
against the dev server on localhost:5173.

**THE PAGES** — unchanged from §34 except Operations, which now has: click-to-filter from a cell,
a ▾ filter/group menu and a click-to-sort title on every column header, a Description column and
pop-out editor, and Due date last.

**THE ENDPOINTS — 24.** Unchanged from §34.

**MIGRATIONS — 12, and SIX have never been run**

| | State |
|---|---|
| 0001–0006 | run |
| **0007** finance | **not run** |
| **0008** vault + client reports | **not run** |
| **0009** sales | **not run** |
| **0010** console reports | **not run** |
| **0011** console feedback | **not run** — must go **after 0010** |
| **0012** task description | **not run** — standalone, run it whenever |

*(Confirm 0007 and 0008 in Supabase rather than trusting a board — the earlier ones disagree.)*

**KEYS AND VARS** — unchanged from §34. `ANTHROPIC_API_KEY` and `VAULT_KEY` are still the two that
block the most.

**TESTS — EIGHT suites**

| Suite | Count |
|---|---|
| `overview` | 44 × **5 timezones** |
| `console-report` | **46** × 2 timezones |
| `ops` | **18 — new today** |
| `sales` | 84 + 20 SQL against a real Postgres |
| `vault` | **106** + 36 SQL |
| `brain` | 78 |
| `inbox` | 47 — **run it with `bash tests/inbox/run.sh`** |
| `finance` | 53 |

Plus the four Playwright passes over the built bundle described in §34.

**DO THIS NEXT, IN ORDER**

1. `npm run build` in Cursor, then push and deploy. Nothing here has ever been live.
2. Migrations: **0007, 0008, 0009, 0010, 0011** (0011 after 0010), and **0012** whenever.
3. `ANTHROPIC_API_KEY` and `VAULT_KEY` in Vercel, then **redeploy** — env vars only reach a build.
   VAULT_KEY into Bitwarden the same minute; lose it and stored secrets are unreadable for ever.
4. **Press the generator with a real key.** Every report watched today was the counted fallback, so
   nobody has yet seen a model answer under the one-answer shape pass or fail the gate.
5. Rate an answer badly on purpose and check the next one changes.
6. The rest of the keys as each feature is wanted.

**KNOWN GAPS** — everything in §34's list still stands, plus these from today:

- **The Work page is still the top of the list** — browser clock, retired stale-lead rules.
- The assistant cannot search a task Description: `lib/assistant-tools.js` filters on `name` and
  `latest_report` only, and adding `description.ilike` breaks every task search until 0012 runs.
- `description` reaches **no AI surface** — deliberate (free text a person types), but it also means
  the brief is invisible on the Work page, where the person doing the work reads.
- No test covers the pop-out editor, `ColumnHead`, `applyFacet` or the `colsSeen` column prefs. Only
  the sort is tested. The rest was watched in Chrome.
- `MISSING_DESCRIPTION` in Operations.jsx is still a string match on a Postgres message.
- **The AI path of the one-answer report shape has never been watched**, per item 4 above.

---

## §39. CLIENTS replaces Customers, and every client's own accounts get connected — Aug 24 2026 (append-only section)

Nothing above this line was changed. §38 is still the state board; this section adds to it.

### The two things Ryder asked for, in his words

1. *"the customers page i want to make the clients page and have it show all clients, both clients we
   work with and just people who use the system and then it needs to be clickable and it go to the
   client page like everyone has with all thier info and reports and passwords and everything."*
2. *"i want to add into each client thier GBP and GSC and all thier accounts and everything so that ai
   can easily pull reports on all of that... the reports should be able to go and grab the info from
   these connectors."*

### 1. The Clients page

`src/components/admin/Clients.jsx`, page id **`clients`**. `Customers.jsx` is **deleted**.

Customers showed Stripe and only Stripe, so half the people we deal with were invisible on it: the
clients we actually do the work for live in `admin_clients`, and Stripe knows nothing about them
until they pay through it. The new page merges both lists and labels every row:

| Label | What it means |
|---|---|
| `CLIENT` | A row in `admin_clients`. We do delivery work for them. |
| `CLIENT + PAYING` | The same, and they also pay through Stripe. |
| `SUBSCRIBER` | Pays through Stripe, no client record, no delivery work. |

**Matching is on the email address and nothing else.** `matchKey()` lowercases and trims, and
returns "" for anything without an `@`. Matching on the NAME was written and thrown out: "Harbor
Injury Law" and "Harbor Injury Law, PLLC" are the same firm, "Smith Law" and "Smith Law Group" are
not, and no rule tells those two cases apart. A wrong match here does not look like a bug — it looks
like a client whose money belongs to somebody else. When emails do not match, both rows show
separately and a person decides.

Clicking a row with a client record opens **the same `ClientDetail` component the Operations page
uses**, not a copy. It was exported from `Operations.jsx` for exactly that reason: two copies would
have drifted inside a week, and then two screens would disagree about one client.

Clicking a SUBSCRIBER row offers **Make a client** instead: a short form with their name, website,
email and contact already filled in from Stripe, and one button that writes the `admin_clients` row
and opens its page. That closes half of a gap listed in §38 ("marking a lead Won does not create the
client record") — a paying customer no longer has to be typed in from scratch. The lead half is
still open.

**The address decides which client is open**: `#/dashboard/clients?id=<uuid>`. Reload, Back, a
bookmark and the link the Google sign-in bounces back to all land in the same place.
`RENAMED = { leads: "sales", customers: "clients" }` in `AdminDashboard.jsx` rewrites every old
`customers` link, the same way `leads` was handled on Aug 21 — an unknown page id does not break
loudly, it quietly shows the landing page instead.

### 2. Connections — the client's own accounts

New **Connections** tab on every client page. `src/components/admin/connectionsPanel.jsx`.

| Short | Full name | What it answers |
|---|---|---|
| GSC | Google Search Console | Times shown in Google, clicks, average position, top searches, top pages |
| GBP | Google Business Profile | Calls from the listing, direction taps, website taps, times shown |
| GA4 | Google Analytics 4 | Visitors, sessions, where they came from, actions taken |
| Bing | Bing Webmaster Tools | Typed in by hand for now — no sign-in exists |

**Everything is read-only in practice.** GSC and GA4 ask for `.readonly` scopes. GBP has no
read-only scope — Google only offers `business.manage` — so `SCOPE_IS_READ_ONLY.gbp === false` and
the screen SAYS manage rather than claiming read-only. `lib/connector-fetch.js` has no code that
writes to anything, and a test asserts the honesty flag.

### The files

| File | What it is |
|---|---|
| `supabase/migrations/0013_client_connections.sql` | Two tables + a `payload` column on `admin_oauth_states` |
| `lib/connectors.js` | PURE. The provider list, scopes, windows, metric labels, and the wording every number is printed in. Read by the browser, the server AND the tests. |
| `lib/connector-fetch.js` | SERVER ONLY. The Google calls, normalised into one shape. |
| `api/connect-start.js` | Begins a sign-in for one client + one provider |
| `api/connect-callback.js` | Where Google sends the person back |
| `api/connector.js` | `properties` · `choose` · `sync` · `syncClient` · `disconnect` |
| `src/components/admin/connectionsPanel.jsx` | The tab |
| `src/components/admin/Clients.jsx` | The page |
| `tests/connectors/` | 165 checks × 5 timezones |

### The two rules this whole feature exists to keep

**1. A number is never shown or quoted without the window it covers, the day it was read, and who
read it.** Two pieces of code print a reading and both obey it: `snapshotToLines()` in
`lib/connectors.js` does it for reports and for the assistant, and `SnapshotLine` in
`connectionsPanel.jsx` does it on screen, where the line reads
`2026-07-25 → 2026-08-21 · READ BY THIS CONSOLE on 2026-08-24`. They agree by hand, not by
construction — if you change one, change the other.

**2. Read-by-us and typed-in-by-us are never blended.** `source` is `'api'` or `'manual'`. Only the
server may write `'api'` — the row-level-security policy on `admin_connection_snapshots` forces every
browser insert to `source = 'manual'`, because only the server actually asked the account. The gaps
list on a report names typed-in numbers as typed in.

### Why a report quotes a SNAPSHOT and never a live call

`api/client-report.js` reads `admin_connection_snapshots`. It does **not** call Google. Three reasons,
all learned the hard way elsewhere in this repo:

- Press the button twice and you would get two different reports.
- The report would fail whenever Google did, and Google fails often enough.
- A report written in March would silently re-date itself in September, and nobody could ever check
  what it originally said.

Refreshing the numbers is its own button on the Connections tab. That is a separate action on
purpose.

### What changed in the report engine

`lib/client-report.js`:

- `assembleReportFacts()` takes `snapshots` and `connections`, and produces `facts.measured`
  (newest reading per property) and `facts.connected` (counts).
- `buildFactsText()` puts the measured block **first in the never-trimmed tail**. A client with 400
  tasks must not lose the only real numbers in the report — there is a test for exactly that at
  `maxChars: 500`.
- `missingFrom()` now says **five** different things, because they are five different problems:
  nothing connected · connected but needing to be signed in again · connected but never read ·
  connected and read but one service still missing · numbers that were typed in rather than read.
  A gaps list that says the same sentence after the gap is closed teaches people to stop reading it.
- `deterministicReport()` prints a **What their own accounts show** section, and the 30-second
  summary **opens** with the client's Google clicks — labelled *"That is their number, not ours."*
  A typed-in figure gets different wording there (*"as typed in by one of us from their screen"*);
  the first version used the read-by-us wording for both, and the summary is the half that gets
  pasted into an email.
- Every number the counted report prints is on the fact sheet, so it passes `checkReport()`. Tested.

`lib/brain-context.js` gained a `measured` scope, **owner and admin only** — a sales rep's AI cannot
see a client's connected accounts at all, not even a count. Rendered under its own heading with the
dates attached, never folded into the client line.

### Seven traps that are already handled — do not "fix" them

1. **`taken_at::date` cannot be indexed.** Turning a timestamp into a date depends on the time zone,
   and Postgres refuses to index anything whose answer can change. Hence the separate `taken_on`
   column, written by whoever inserts the row.
2. **`onConflict` can only name plain columns.** An index over `coalesce(property,'')` would be
   something PostgREST cannot point at, so every read would insert instead of replace. Hence
   `property text not null default ''` on the snapshots table. A test cross-checks the API's
   `onConflict` string against the index in the SQL file.
3. **`include_granted_scopes` is never set.** Google would hand back one token carrying every
   permission the account ever granted — a token stored for a client's Search Console would also
   open somebody's mailbox. A test greps for it.
4. **GSC totals come from a query with NO dimensions.** Adding up a dimensioned query undercounts
   every time, because Google drops rows for rare searches, and the totals would silently read low.
5. **Click rate is recomputed from clicks ÷ impressions.** Google's own returned average disagrees
   with the totals printed beside it, and a report quoting both looks wrong.
6. **Every window ends at a lag** (`REPORT_LAG_DAYS`: gsc 3, ga4 1, gbp 5). Asking "up to today"
   returns a number that is too small and then grows — which reads as a drop in the next report.
7. **GBP returning nothing gives nulls, not zeroes.** A row of zeroes saved as if measured reads in
   a report as "nobody called them", which is a claim nobody made. Usually an unverified listing,
   and the card says so.

### What is NOT done

- **Nothing has been run against a real Google account.** No client property has ever been read.
  Every "it works" here is a pure test, a build, or Chrome against the dev server with sample data.
- Migration 0013 is **unrun**, on top of the six already unrun in §38. That is now **seven**.
- The six Google APIs in SETUP.md § 0013 step 2 have not been switched on. Three of them
  (Business Profile) usually need access requested from Google first.
- Bing has no sign-in — it is a typed-in card only.
- Nothing refreshes on a schedule. Numbers are read when somebody presses the button.
- No chart. The panel shows the newest reading and a History list, not a line over time.
- The Clients page reads every connection row once to count them per client. On a console with
  hundreds of clients that read should become a counted view.

---

## §40. What the review of §39 changed, the same day — Aug 24 2026 (append-only section)

Nothing above this line was changed except the specific corrections listed at the end of this
section. §39 still describes the feature; this section is what two checkers found wrong in it and
what was done about each one. Both checkers were told to assume the work was broken and to report
only what was actually wrong.

### The one that mattered most: the stored sign-in was NOT protected

The first version kept each client's scrambled Google sign-in in a `refresh_token_enc` column on
`admin_client_connections`, and tried to hide it with:

```sql
grant select, insert, update on public.admin_client_connections to authenticated;
revoke select (refresh_token_enc) on public.admin_client_connections from authenticated;
```

**That does nothing.** A column-level `REVOKE` does not carve a column back out of a table-level
`GRANT` in PostgreSQL, and Supabase grants `authenticated` everything on a new public table by
default anyway. The checker proved it on a real Postgres: `has_column_privilege` returned true,
`select refresh_token_enc` returned the blob, and an `update` to it succeeded. Three comments in
the codebase said the opposite.

It was only ever gibberish — scrambled with `VAULT_KEY`, which lives on the server — so reading it
would not by itself open a client's account. That is not a reason to hand it out.

**Fixed:** the sign-in moved to its own table, `admin_connection_secrets`, keyed on the connection
id. Nothing is granted on it to `authenticated`, whatever Supabase granted by default is explicitly
revoked, and row level security is on with **no policies at all** — so even if a grant were added
by mistake later, every row would still be invisible. Only the service role reaches it, and the
service role runs on the server only.

**Never do this again:** if a secret needs to be invisible to the browser, it goes in its own table
with no grants. Not a column with a REVOKE on it. `tests/connectors` now fails if any
`revoke select (...)` or `revoke update (...)` appears anywhere in that migration.

### "Connect again" could never repair a connection

The callback looked for the card to attach a sign-in to with
`.eq(client_id).eq(provider).is("property", null)`. Every card that has ever been *used* has a
property, so a broken one never matched, and the code made a **second, empty card** instead. The
original kept its dead token and its `needs_reconnect` status for ever. The new card was a dead end
too: pointing it at the same property hit the "this client already has a connection reading that
one" check and returned 409. Every attempt to fix a connection added another orphan.

**Fixed:** the card's id now rides through the sign-in — `connect-start` checks it belongs to that
client, writes it into the state row in the database, and the callback lands back on that exact
card. The address bar never carries it.

### Numbers that were never measured

| What happened | Why it is bad | Fixed by |
|---|---|---|
| Search Console returning no rows was saved as `0 clicks, 0 shown` with `source: "api"` | A report then prints "0 clicks from Google search" as a measurement — on exactly the newly-verified client where it does most harm | Nulls plus a warning, the way Business Profile already did it |
| A Business Profile series Google omitted became a hard `0` | "0 times the listing was shown" is a number Google never sent. The all-or-nothing check missed it because *something* came back | Every metric starts as `null` and only becomes a number if Google answered for it; the card names which ones were missing |
| One client's readings replaced another's | `newestPerProperty` keyed on provider + property with no client in it. Two clients each with a typed-in card and no property chosen collided, and the loser vanished with no trace | The client id is part of the key |
| The assistant said "There is NO number for it" about accounts read daily | Its snapshot read was capped at 80 rows across every client, so most clients' readings were simply never fetched | Cap raised, and when the read comes back full the wording changes to "you cannot see any from here" — absence is not evidence |
| A client report could say an account "is not connected, or has never been read" about one read every day | Same cap, 60 rows, with no caveat | Cap raised to 400 and a caveat added when it is hit |
| A typed-in figure was asserted in the 30-second summary as a reading | The summary is the half that gets pasted into an email; the body two screens down said otherwise | Different wording for typed-in, tested |
| A person typing `3.2` for a 3.2% click rate got `320.0%` | Nothing said the box wanted a fraction | The box says "in percent (3.2 for 3.2%)" and divides by 100 on the way in |
| Read dates were UTC days | An 8pm Chicago refresh was filed and printed as **tomorrow**, and the database's "one reading per window per day" rule counted two evenings as two days | `teamDate()` — the same America/Chicago day the rest of the console uses |

### Two Google calls were simply wrong

- **GA4 `conversions` is retired.** Google replaced it with `keyEvents`. It rode along with the
  three metrics that matter, so a 400 on it failed the **whole** read: every Analytics connection
  would have returned nothing at all, visitors included. It is now asked for on its own, new name
  first, old name as a fallback, and a warning if neither works.
- **The Business Profile date range was half camelCase, half snake_case**
  (`dailyRange.start_date.year`). A path that is camel at one level and underscored at the next
  matches no field at all — Google either refuses it or ignores the range and answers for a window
  of its own choosing, which is worse: the numbers would be stamped with OUR dates and cover
  somebody else's. Now `dailyRange.startDate.year` throughout, and a test reads the URL back.

### Lists that looked complete and were not

`listGa4Properties` never followed `nextPageToken`; `listGbpLocations` read one page of accounts and
capped locations silently. All three now page properly and return `{ properties, more }`, and the
picker prints a warning when `more` is true — because the picker's empty state says *"That account
can see nothing"* as a conclusion, and a cut list would make that a lie. The Clients page does the
same: where its own read was cut, the column says **"not known"**, never "none connected".

### React

- Pressing **Back** from a client page left the client page rendered over a list address. The
  effect only ever SET the open client and never cleared it.
- The property picker reopened itself after Cancel, every time anything reloaded the rows.
- Every modal held a **copy** of the row it was opened on, so it saved stale values over newer ones
  and stayed open on rows that had been removed. They hold ids now and look the row up on render.
- `stampRoute` uses `replaceState`, which fires no event — so clearing `?connect=ok` from the
  address bar did not clear it from the component, and the picker kept being offered on later
  visits. There is a local flag now.

### Two smaller ones

- Two cards with **no property chosen yet** collided on the unique index — so a client with two shop
  locations could not have two Business Profile cards, and the error told them to change a property
  neither card had. The index is now partial: `where property is not null and property <> ''`.
- The **Refresh** range picker silently changes what every future report quotes. Press it once on
  "Last 7 days" and a client's clicks appear to collapse. The dates were always printed; now the
  panel says it in words when the newest readings cover different lengths of time, and so does the
  fact sheet handed to the AI.

### Corrections made to §39 itself

`133 checks` → **165**. "Six traps" → **seven** (it always listed seven). "the summary leads with"
→ it now actually does — the code disagreed with its own comment. "`missingFrom()` says three
things" → **five**. "`snapshotToLines()` is the only thing that turns a reading into words" → there
are two, and they agree by hand. "a paying customer can become a client in one press" → it is a
short pre-filled form, not one press.

### Also missing from §39's "what is NOT done"

- **No test covers the Clients page or the Connections panel.** All 165 checks are `lib/` and SQL.
  `matchKey` in `Clients.jsx` carries a comment saying it is exported for the tests; it is not
  tested yet.
- **"Refresh everything" reads at most 8 connections per press** (`SYNC_FANOUT_CAP`). It reports
  what it skipped, but somebody with more has to press it twice.
- **Owners can delete a snapshot.** That sits awkwardly beside "a report quotes a snapshot, so it
  has to stay checkable". It is deliberate — a typed-in number entered wrongly has to be removable
  — but nothing warns that an old report may be pointing at it.
- Everything in §39's own list still stands: **migration 0013 is unrun (seven now), and nothing here
  has ever been run against a real Google account.**

---

## §41. Say what shape you want, then send it — Aug 24 2026 (append-only section)

Nothing above this line was changed. §39 and §40 still stand.

### What Ryder asked for

> *"make the clients page icon a person"* · *"when you click a person, is that there actual client
> page like it is every time a client is clicked?"* · *"i want the generate report to be a click and
> open prompt that you type in the type of report you want to be gathered and how you want it
> formated and responded as so you can copy and paste for people, then have a button for like text
> ot email them with this as a draft."*

**The answer to the middle question is yes.** `ClientDetail` is exported from `Operations.jsx` and
rendered by both pages. There is one client page and two doors into it.

### 1. The icon

`clients` in `Sidebar.jsx` was still the dollar sign it inherited from Customers. It is two figures
now. The page stopped being "everyone who pays" on Aug 24; the money symbol was describing the
smaller half of the list.

### 2. Two questions on the Generate box, not one

`instruction` was already there — **what to cover and how deep**. New alongside it: **who it is for
and what shape it comes back in**, with its own five buttons (For us · For CJ to forward · As an
email I can paste · As a short message · Bullet points only), its own box, and its own 600-character
cap (`MAX_SHAPE_CHARS`).

**They travel as two separate fenced blocks in the prompt.** Folding them into one box was
considered and dropped: "write it as an email" buried three lines into a paragraph about scope gets
treated as a passing remark and the answer comes back as a report anyway.

The shape block is told in the prompt that it decides **how the answer reads, never what is true**,
and the honesty rules are restated after it — so the last word in the prompt is still ours. One
extra rule was added for this: an email or message written to a client obeys every rule a report
does. It may be warm; it may not promise, guess, apologise for something we did not do, or state
anything the facts do not carry. A test asserts the rules come after the shape block in the string.

Saved on the row by **migration 0014** (`shape`, `shape_preset`). `api/client-report.js` retries the
insert without those two columns if they are not there, so an unrun 0014 costs you the record of the
shape and nothing else — and the screen says that is what happened.

### 3. Sending it

`lib/report-share.js` — pure, shared, and the subject of `tests/share` (42 checks).

| Button | What it does |
|---|---|
| **Copy to paste** | The whole report, markdown taken off, gaps list KEPT. For us. |
| **Email them →** | A draft email: greeting, first finding, up to six bullets, sign-off |
| **Text them →** | Two or three lines, capped at 320 characters |
| Copy all | Unchanged — the markdown, for a file |

**THE ONE RULE: nothing in a draft is a new sentence.** Every word is lifted from a report that has
already been through `checkReport`. A freshly written sentence would not have been, and this is the
whole reason the drafts are assembled from the report rather than generated. A test walks every
number in a draft and fails if one is not in the report it came from. (Today's date is excluded from
that check — it is passed in from the clock by the caller, not lifted and not invented.)

**Our voice vs theirs.** A report is written ABOUT a client; an email is written TO them. A sentence
carried straight across said *"Their own Google Search Console shows 412 clicks"* to the very person
whose Search Console it is. `CLIENT_VOICE` in `report-share.js` is a **short, explicit list of
phrases this codebase generates** — not a pronoun sweep, which would have broken "the crawlers and
their user agents". Every substitution that fires is named in the warnings on screen. Caught in the
browser, not by a test; there is a test now.

**What a client-facing draft drops, and the internal copy keeps:** the "what these records cannot
answer" list, the provenance line, and any line the report marked as one of our own working notes
(`our note from …`). Sending our own gap list raw to a client reads as a list of things we have not
done. `reportToPlainText` keeps all of it, because that one is for us.

**NOTHING IS EVER SENT.** "Save as a Gmail draft" writes a real draft into a mailbox and stops. A
person opens Gmail, reads it, presses send. **Do not "improve" this into a send button.** An email
to a client going out on one click of a button labelled "email them" is how the wrong thing reaches
the wrong person. The text button opens Messages with the words filled in; the person still presses
send.

The draft is saved from a **shared** mailbox when there is one (growth@ rather than somebody's
personal address), falling back to any connected one. A mailbox needing to be reconnected is named
on screen before anybody presses the button.

### What is NOT done

- **Migration 0014 is unrun. That is EIGHT** (0007–0014).
- **No Gmail draft has ever actually been saved from here.** The endpoint it calls is the same one
  the Inbox page has used since Aug 18, but this particular path has only been run against sample
  data.
- The text button uses an `sms:` link. That opens Messages on a Mac. It has not been tried on
  anything else, and there is no check that the number is real.
- The drafts are assembled by rules, not written — so a report with no bullets and no plain
  sentences produces a nearly empty draft. It says so rather than filling the space.
- `tests/share` (48 checks) covers the shaping. Nothing covers the modal itself.

### One trap worth writing down, not about this feature

Writing these files through a **Python heredoc silently turned every `\b` in a JavaScript regex
into a real backspace character** (0x08). The file looked right in an editor, `node --check` passed,
eslint passed, the build passed — and `/\bTheir own…/` matched nothing, so the whole voice rewrite
was dead. It was only visible in the browser. If a regex with `\b`, `\f` or `\v` in it mysteriously
never matches, run `grep -rlP '[\x08\x07\x0b\x0c]'` over the repo before doubting the pattern.

---

## §42. EVERYTHING BUILT ON AUG 24–25 2026, AND THE STATE BOARD THAT REPLACES §38

**Read this section, then §39 and §41. Skip §40 unless you want the reasoning behind the fixes.**
The board in PART 3 **replaces §38's board**. Where §38 and this disagree, this wins. §33 is still
the current spec for the Overview page and its generator; nothing here touched either.

Four commits, in order:

| Commit | What |
|---|---|
| `2eb373d` | Clients page + connect each client's own Google accounts |
| `53538c6` | Say what shape you want the report in, then send it |
| `eba6da7` | Take the standing text out of the Generate report box |
| `c81ea84` | No count badge on the Reports tab |

### PART 1 — WHAT WAS BUILT, IN ORDER

| # | Built | Detail |
|---|---|---|
| 1 | **Customers is gone. CLIENTS replaces it** — our own records and Stripe merged into one list, labelled CLIENT / CLIENT + PAYING / SUBSCRIBER, matched on the email address and nothing else | §39 |
| 2 | **Any row opens the client page** — the SAME `ClientDetail` Operations uses, exported not copied. One client page, two doors | §39 |
| 3 | **"Make a client"** on a Stripe-only row — a short form pre-filled from Stripe that writes the `admin_clients` row | §39 |
| 4 | **CONNECTIONS tab on every client** — their Google Search Console, Business Profile and Analytics, connected by Google sign-in and read on demand | §39 |
| 5 | **Reports quote a SNAPSHOT, never a live call** — `api/client-report.js` reads saved readings and never calls Google | §39 |
| 6 | **The sign-in itself moved to its own table** after a reviewer proved a column-level REVOKE protects nothing | §40 |
| 7 | **Generate report asks TWO questions** — what to cover, and who it is for / what shape it comes back in. Migration **0014** | §41 |
| 8 | **Copy to paste · Email them → · Text them →** on a finished report. Every word lifted from the report; nothing is ever sent | §41 |
| 9 | **The Clients icon is a person**; the standing text is out of the Generate box; the Reports tab has no count badge | §41, and below |
| 10 | **New files**: `lib/connectors.js`, `lib/connector-fetch.js`, `lib/report-share.js`, `api/connect-start.js`, `api/connect-callback.js`, `api/connector.js`, `src/components/admin/Clients.jsx`, `src/components/admin/connectionsPanel.jsx`, migrations `0013` `0014`, tests `connectors/` `share/` | |

### PART 2 — THE RULES THESE TWO DAYS ADDED

1. **A secret that must be invisible to the browser goes in its OWN TABLE with no grants. Never a
   column with a REVOKE on it.** A column-level `REVOKE` does not carve a column out of a
   table-level `GRANT` in PostgreSQL, and Supabase grants `authenticated` everything on a new public
   table by default. A reviewer proved on a real Postgres that the first version was readable AND
   writable by any signed-in admin's browser, while three comments said it was not. §40
2. **A measurement is a number PLUS the window it covers PLUS the day it was read PLUS who read it.**
   Anything short of all four is not a measurement and must not be printed as one. §39
3. **Read-by-us and typed-in-by-us never blend.** The database itself forces every browser-entered
   reading to say "typed in"; only the server may write "measured". §39
4. **An empty answer is null, never zero.** "0 phone calls" saved as if measured is a claim nobody
   made — and it lands hardest on the newly-onboarded client. §40
5. **Nothing in a client draft is a new sentence.** Every word comes from a report that already
   passed `checkReport`; a fresh sentence would have skipped it. §41
6. **NOTHING IS EVER SENT FROM THE CONSOLE.** The Gmail button saves a draft and stops. Do not
   "improve" this into a send button. §41
7. **Absence of evidence is not evidence.** When a read comes back at its cap, the wording changes
   from "there is none" to "I cannot see any from here". §40
8. **Standing text stops being read.** Three explanation blocks were pushing the two boxes a person
   came to type below the fold. The rules they described are enforced in code either way. §41
9. **A count badge is a claim on somebody's attention.** Tasks, sites, connections, logins and weeks
   count things you may have to act on. Saved reports are a filing cabinet — no badge. (`c81ea84`)

### PART 3 — STATE BOARD (replaces §38's board)

**Nothing in this repo has ever run on admin.aisyndicate.com.** Every claim below is from the sample
store, the pure suites, a real Postgres for the SQL suites, or watched in Chrome against the dev
server on localhost:5173. The Playwright passes described in §34 were **not** re-run on Aug 24–25.

**THE PAGES — 15.** As §38, with one change: **Customers is deleted and Clients replaces it**
(page id `clients`; old `customers` links rewrite themselves). Operations is unchanged apart from a
new **Connections** tab inside the client page, which the Clients page shows too because it is the
same component.

**THE ENDPOINTS — 28** (counted from `api/`). §38 said 24; three are new here
(`connect-start`, `connect-callback`, `connector`) and the old number was already short by one.

**MIGRATIONS — 14, and EIGHT have never been run**

| | State |
|---|---|
| 0001–0006 | run |
| **0007** finance | **not run** |
| **0008** vault + client reports | **not run** |
| **0009** sales | **not run** |
| **0010** console reports | **not run** |
| **0011** console feedback | **not run** — must go **after 0010** |
| **0012** task description | **not run** — standalone |
| **0013** client connections | **not run** — standalone; three tables |
| **0014** report shape | **not run** — standalone; two columns, and the console works without it |

*(Confirm each one in Supabase rather than trusting a board.)*

**KEYS AND VARS.** `ANTHROPIC_API_KEY` and `VAULT_KEY` still block the most. `VAULT_KEY` now blocks
the client connections too — without it `/api/connect-start` refuses **before** anybody signs in, on
purpose, so no client is ever asked for access we then cannot store. `.env.example` gained sections
8, 9 and 10, which include `VAULT_KEY` and `PLATFORM_SCORE_URL` — both were missing from it before.

**TESTS — TEN suites**

| Suite | Count |
|---|---|
| `connectors` | **165 — new** × 5 timezones |
| `share` | **48 — new** |
| `overview` | 44 × 5 timezones |
| `console-report` | 46 × 2 timezones |
| `ops` | 18 |
| `sales` | 84 + 20 SQL against a real Postgres |
| `vault` | 106 + 36 SQL |
| `brain` | 78 |
| `inbox` | 47 — **run it with `bash tests/inbox/run.sh`** |
| `finance` | 53 |

**DO THIS NEXT, IN ORDER**

1. **`rm -f .git/index.lock .git/HEAD.lock`** in Cursor. Committing from the mounted folder left two
   lock files the mount will not delete, and git — Cursor's included — refuses to run while they
   exist. See PART 4.
2. `npm run build`, then push and deploy. Nothing here has ever been live.
3. Migrations, in this order: **0007, 0008, 0009, 0010, 0011** (after 0010), then **0012, 0013,
   0014** whenever.
4. `ANTHROPIC_API_KEY` and `VAULT_KEY` in Vercel, then **redeploy**. VAULT_KEY into Bitwarden the
   same minute.
5. **SETUP.md § "Migration 0013"** — six Google APIs to switch on, three scopes to add to the
   consent screen, one redirect URI. The three Business Profile APIs usually need access requested
   from Google by hand first, and **we have not been through that**, so promise nobody a date.
6. **Connect one real client's Search Console and press Refresh.** Nothing here has ever touched a
   real Google account.
7. **Generate one report with an AI key set**, asking for the email shape. Every report watched over
   these two days was the counted fallback — no model has ever answered with a shape block in the
   prompt.
8. **Save one real Gmail draft.** That path has only run against sample data.

**KNOWN GAPS — everything in §38's list still stands, plus:**

- **Nothing has been read from a real Google account, and no Gmail draft has ever been saved.**
- The OAuth app is **Internal**, so a client's own Google account cannot sign in. The client grants
  our address access first; we sign in as us. Switching to External brings a Google review with it.
- Local dev needs `CONNECT_REDIRECT_URI=http://localhost:5173/api/connect-callback` or Google
  refuses with `redirect_uri_mismatch`.
- Bing is a typed-in card only. Nothing refreshes on a schedule. No chart over time.
- "Refresh everything" reads at most 8 connections per press. It says what it skipped.
- Owners can delete a snapshot, which sits awkwardly beside "a report quotes a snapshot, so it has to
  stay checkable". Deliberate — a wrongly typed number has to be removable — but nothing warns that
  an old report may be pointing at it.
- **No test covers the Clients page, the Connections panel, or the share modal.** All 213 new checks
  are `lib/` and SQL. `matchKey` in `Clients.jsx` says it is exported for the tests; it is not tested.
- The Clients page reads every connection row once to count them per client. Past 400 rows it says
  "not known" rather than "none connected", but on a console with hundreds of clients that read
  should become a counted view.
- Marking a **lead** Won still does not create the client record. The paying-customer half of that
  gap is closed; the lead half is not.

### PART 4 — TWO PROCESS TRAPS FROM THESE TWO DAYS

**Writing JavaScript through a Python heredoc turns `\b` into a real backspace character (0x08).**
The file looks right in an editor. `node --check`, eslint and `npm run build` all pass. The regex
matches nothing. It was only visible in the browser. When a regex with `\b`, `\f` or `\v` never
matches, run `grep -rlP '[\x08\x07\x0b\x0c]' --include='*.js' --include='*.jsx' .` before doubting
the pattern.

**Committing from the mounted folder leaves `.git/index.lock` and `.git/HEAD.lock`, and the mount
refuses `rm`, `mv` AND `tar` on them.** The way through:

1. `tar` the whole `.git` minus `*.lock` into `/tmp/g.git`.
2. `git --git-dir=/tmp/g.git --work-tree=<repo> add -A && commit`.
3. **Copy the new loose objects back FIRST.** They were written into `/tmp/g.git`, not the repo.
   Skipping this leaves the ref pointing at a commit the repo does not have and git answers
   **`fatal: bad object HEAD`** — which looks like a corrupted repo and is not. Copy the objects and
   it comes straight back.
4. `cp -f /tmp/g.git/refs/heads/main <repo>/.git/refs/heads/main` — **`cp` overwrites where `mv` and
   `rm` both fail.**
5. Verify from the repo's own `.git`: `log`, `fsck`, and
   `git show <sha>:<changed file> | grep -c "<the removed text>"`.

The locks themselves survive all of this. **Ryder has to remove them in Cursor.**

## §43. THE SHEET: rows of people, and one record from lead to paying client — Aug 25 2026 (append-only section)

Built at Ryder's ask: *"i dont like how the business has a dropdown with the owner below, thats not
needed, just make it rows of the people. you can take inspo from the google sheet that there using
already … have everything connected and context saved to all people in our system from the time
there created as a lead all the way to a paying client and beyond."*

Built, lint clean, `vite build` clean at 145 modules, tested, driven in a real browser. **NOT
deployed. Migration `0015_sales_lifecycle.sql` has not been run.**

---

### 43.1 What the Sales list looked like before, and why it changed

Every firm was a collapsible header row with its people underneath it. It was built that way in §26
to make "one firm, one rep" visible, and it did — at the cost of a screen you could not read ten
people down, could not sort by anything, and had to open a firm to find out whether anybody was
working it. It also looked nothing like the spreadsheet the sales team actually uses.

It is now one row per person, in CJ's own column order:

**Sales Owner · Contacted? · Sales Cycle Status · Claim · First Contact · Last Touch ·
Next Steps/Notes · First Name · Last Name · Title · Company · Email · Site Score** — plus Phone,
City, State, Website, List, Touches and Full Name switchable on from the Columns menu.

The sheet's tabs are along the top (Everybody · Luxury Agents · Medspas · …). Cells edit where they
sit, exactly like the Operations table. Click a column title to sort (three states: the useful way,
the other way, off). The ▾ beside it filters and groups. **Grouping is a switch now, not the shape**
— "Group by → Company" puts the firms back when you want them, and off again when you do not.

### 43.2 The three columns that are deliberately NOT what the sheet has

| Column | Why |
|---|---|
| **Contacted?** | In the sheet this is a second dropdown saying the same thing as Sales Cycle Status; reps fill one or the other and neither can be trusted. Here it is **counted** off logged touches and cannot be typed into. Three answers, not two: *Yes* · *Yes, older* (a first-contact date is on record but nothing inside the window) · *No*. |
| **First Contact / Last Touch** | Read-only. A database trigger writes both from real logged calls and emails (0009), and they are what the 3-business-day and 14-day timers count. **A timer you can type over is a timer that never fires** — which is exactly what happened in the sheet. |
| **Claim** | Does not exist in the sheet at all. It is the timer state in words: *Claim ran out · Gone cold · First contact due · Going cold · Being worked · On the floor*. |

**The window is said out loud on screen.** `getSalesBoard` reads the last `ACTIVITY_WINDOW_DAYS`
(90) of activity, so Contacted? and Touches are counted from a window and not from a lifetime. The
first version said *"Nothing has ever been logged against this person"* from that 90-day count —
false for anyone worked hard in the spring and quiet since, and contradicting that same person's own
Timeline tab, which reads their whole history with no window at all.

### 43.3 One firm, one rep — the rule the grouping used to carry

Flattening the table would have deleted the loudest rule on the Rules of Engagement tab, so it moved
onto the **Company cell**: a firm two reps are both working carries a ⚠, and clicking it names them
and quotes the rule. It stops nobody — Ryder's call from Aug 21 stands — it just refuses to let it
be a surprise.

Two things about it that were bugs first:

* It is counted across **every lead the page holds**, not the rows on screen. Filter to your own
  leads and a contested firm would otherwise stop looking contested at exactly the moment you need
  telling.
* It filters on **open stages**. Without that, a firm where one rep's contact is Lost and another's
  is live showed "2 reps are working this firm" on every row, while the drawer for the same firm —
  which uses `companyClaimWarning` and does filter — showed no warning at all. Two parts of one page
  giving opposite answers about the same thing is worse than either answer alone.

### 43.4 WON NOW MEANS WON

`admin_leads.became_customer` and `admin_companies.client_id` have existed since Aug 22 and **nothing
ever wrote either of them.** Marking a deal Won put a green pill on a row and stopped; the delivery
side then started a client record from scratch and the whole chase sat on the far side of a gap
nothing crossed.

`0015_sales_lifecycle.sql` adds **one function**, `admin_lead_to_client(lead, actor, stage)`, and
every Won button in the console now goes through **one** browser path, `markLeadWon` in
`src/lib/data.js`. There are four such buttons — the sheet's status cell, the drawer's status
dropdown, the drawer's green "They signed" button, and setting a proposal to Won — and before the
review pass, **one** of them created a client and the other three quietly did not. Worse: because the
working one skipped anything already at stage Won, using any of the other three first made it a
no-op for that lead **forever**.

What the function does, and the rules it holds:

1. **Locks the lead row (`FOR UPDATE`) and returns early if the work is already done.** Pressing Won
   twice is an ordinary thing a person does, not an error.
2. **The early return checks `client_id` AND `became_customer`.** Every contact at a firm is given a
   `client_id` the moment one of them closes — that is the whole point — so a `client_id`-only check
   means a firm can record exactly **one** sale, ever, and the rep who closes the second one watches
   the button do nothing.
3. **A lead with no firm row is deduped by name.** "+ Add a contact" stores the firm as free text and
   sets no `company_id`, so two people typed in under one firm name and both marked Won produced
   **two** clients with the same name, each holding half the history — deterministically, no race
   needed. There is now an advisory lock on the name key and a name+website search before any insert.
4. **A missing website does not block that match; two different websites do.** The sheet's Company
   column carries no website, so one contact at a firm having one and the next not is the ordinary
   case. Demanding both sides agree produced exactly the duplicate in rule 3.
5. **It never invents a name.** No firm name and no person name → it raises, rather than filing a
   client called "Unknown".
6. **It never overwrites what a person typed.** Linking to a client somebody set up by hand fills in
   only the blanks.
7. **Every other contact at the firm is attached to the client**, and each gets a line on their own
   timeline — but `became_customer` is **not** set on them. Whose deal it was and who works there are
   different facts, and flattening them counts one sale four times on the rep scoreboard.
8. **It returns JSONB**, not a bare id: `{client_id, created, already_customer, siblings}`. Returning
   only an id made the page toast *"they are now a client"* every single time, including the times
   when nothing at all was created.

### 43.5 One timeline per person, for life

`lib/person-timeline.js` merges the sales activity, proposals, finished tasks, weekly logs, reports,
invoices, payments and support tickets into **one** append-only list, with a ★ marking the day they
started paying. Five rules, all of which were defects first:

1. **Nothing is invented.** A row whose date cannot be read is dropped and **counted**, never filed
   under today. A row with no date at all (a proposal nobody opened) is a non-event and is skipped
   silently — the two are different and are counted differently.
2. **Every line carries its source** — the table it came out of, in words: *"from the sales
   timeline"*, *"from invoices"*.
3. **Logged / system / theirs never blend.** A proposal THEY opened is marked as theirs, not as
   "someone" on our team.
4. **An unread source is not a zero.** `null` means not read, `[]` means read and empty, and the
   summary names every source in the first group. **The summary prints even when the list is empty**
   — that is the one place "nothing happened" and "we could not look" are hardest to tell apart.
5. **Every cap says so**, with its number: the 400-entry timeline cap, and the reader limits on
   invoices (1000), tickets (500), reports (**25** — about six months of weeklies) and tasks (500).

### 43.6 The client page can see the chase

A new **"How they started"** tab on every client page lists every person we hold at that firm, who
worked them, when they were first contacted, and a ★ on whoever closed a deal. Each row links
straight into that person's whole timeline (`#/dashboard/sales?lead=<id>`).

It says *"N people on record at this firm"*, **not** "came through the sales pipeline": the list
includes contacts added by hand and contacts nobody ever worked, and the pipeline wording counted
three dead rows as three sales conversations.

### 43.7 A shared bug this uncovered, which was NOT ours

`opsCells.jsx`'s `Popover` closed on any scroll. Clicking a cell that is not fully in view makes the
browser scroll the table sideways to show it, and that queued scroll arrived after the popover had
mounted — **closing it in the same instant it opened**. On the Sales sheet, which is wide enough that
half the columns are off screen, the Company and Status menus could not be opened at all: the cell
took focus and nothing happened. **Operations has the same table and the same bug**, quieter only
because its columns are narrower.

The listener is now armed one animation frame plus one tick after mount, so the opening scroll is
skipped and a real scroll still closes it. Both timers are cancelled on cleanup — the first fix
cancelled the frame and not the `setTimeout` inside it, which leaked an armed listener that then shut
the *next* popover, one leak per occurrence. Driven in a browser: 10 open/close cycles on Operations,
0 failed opens, and a real scroll still closes it.

### 43.8 The files

| Piece | Where |
|---|---|
| Columns, sort, filters, grouping, the firm warning, dates | `src/lib/salesSheet.js` (new, pure) |
| The table itself | `src/components/admin/salesSheet.jsx` (new) |
| The lifetime timeline | `lib/person-timeline.js` (new, pure) |
| Won → client, in SQL | `supabase/migrations/0015_sales_lifecycle.sql` (new) |
| `convertLeadToClient` · `listClientContacts` · `markLeadWon` · `wonMessage` · `ACTIVITY_WINDOW_DAYS` | end of `src/lib/data.js` |
| The page: handlers, list tabs, `?lead=` deep link | `src/components/admin/SalesPage.jsx` |
| The drawer's one Won path, the merged Timeline tab | `src/components/admin/salesProfile.jsx` |
| "How they started" | `src/components/admin/clientPage.jsx` + one tab in `Operations.jsx` |
| The Popover fix | `src/components/admin/opsCells.jsx` |
| Tests | `bash tests/sales-sheet/run.sh` · `node tests/sales-sheet/walkthrough.mjs` |

`lib/assistant-tools.js` changed too: its set-stage tool used to write `became_customer = true`
directly, producing a lead flagged as a customer with no client behind it — a state that then made
every Won button refuse to act, saying *"already a client"* about a client that did not exist. It
sets the stage and says out loud that no client record was created.

### 43.9 Proof on record (Aug 25 2026)

`npx eslint .` **0 problems** · `npm run build` clean, **145 modules** · `tests/sales-sheet/test.mjs`
**137/137 in five timezones** · `tests/sales-sheet/sql.sh` **all checks passed against a real
Postgres 16**, every migration applied in order and 0015 re-run three times · every other suite
unchanged: sales 84+20, ops 18, brain 78, inbox 47, finance 53, vault 106+36, overview 44×5tz,
console-report 46×2tz, connectors 165×5tz, share 48 · `tests/sales-sheet/walkthrough.mjs` drives the
**built bundle** through 15 screenshots with no console errors · `tests/sales/walkthrough.mjs`
(§26's) updated and passing · Operations driven separately: 12 rows, cell menus open, real scroll
still closes them, 10 cycles with 0 failures, no leak.

**Two separate adversarial review agents, then a third run only on the fixes.** The first pair found
33 defects; the third found 9 more, **five of them introduced by the fixes**, including the
`became_customer`-only guard, the too-strict domain rule, and the leaked scroll listener. All
material findings are fixed and covered by a test.

**Three assertions were proved by MUTATION**, because a reviewer showed one of them passed with the
code it covered deleted: the null-clock ordering branch, the drawer's Won path, and the
`contestedCompanies` stage filter. Each now fails when its code is broken. A test that keeps passing
while the feature is broken is worse than no test.

### 43.10 Blocked until

1. **Run `0015_sales_lifecycle.sql`** in the Supabase SQL editor. Until then, marking Won moves the
   stage and says in plain words that the client link did not happen. (0015 needs 0009; it is
   independent of 0010–0014 and can go before or after any of them.)
2. **Deploy.** None of this has run on admin.aisyndicate.com.
3. Import the real sheet: Sales → Import a sheet.

### 43.11 Known gaps, written down rather than hidden

* **The 90-day window is a window.** Contacted? and Touches say so on screen, and the profile's
  Timeline reads the whole history — but a rep skimming the table is still reading 90 days.
* **A guessed name split is not undone.** Where a lead arrived with one `name`, First and Last are
  split from it (first word, then the rest) and marked as a guess on hover. Editing either half
  stores both and **leaves `name` alone**, so the original is never destroyed by a bad guess — which
  means the halves and the full name can disagree until somebody fixes one. The **Full Name** column
  (Columns menu) and the drawer's Details tab both edit `name` directly.
* **A same-named firm with no website on either side folds into an existing client.** Deliberate:
  splitting one client into two records with half the history each is commoner and more damaging
  than merging two genuinely different firms that share a normalised name and have no website
  between them. Pinned by a test that says so.
* **`api/sales-sweep.js` is still not scheduled** (it is not in `vercel.json`'s crons), so nothing
  actually hands a stale claim back. The health line now says claims are *due* to go back to the
  floor rather than that they *will*.
* **Direction is still not stored on activity**, so an inbound email logged by hand counts as a touch
  exactly as an outbound one does. Unchanged from §26.

## §44. Importing the sheet without touching it, and starting over — Aug 26 2026 (append-only section)

Ryder: *"i want to integrate our current google sheet but i cant have our current sheet broken or
anything happen to it, and when we migrate over i want to do a fresh list so that nothing is
hindered."* Then, when asked what "fresh" meant: *"i meant when i import it i cant have the real
google sheet messed up at all, then when we actually start using the admin then i want to delete all
that data and import the list fresh again so that everything is up to date."*

Built, tested, driven in a browser. **NOT deployed. Migration `0016` NOT run.**

---

### 44.1 The first half was already true, and is worth saying out loud

**There is no code path from this console to Google Sheets.** The importer reads a file the person
downloaded; nothing here has ever written a cell back, and nothing here knows how. So the sheet
cannot be harmed by an import, a bad mapping, or a clear-out. That sentence is now printed on the
Start-over screen itself, because that is where somebody about to press Delete will read it.

### 44.2 What is actually in CJ's sheet, read Aug 25 2026 (read-only, via Drive)

8 list tabs plus Rules of Engagement. Every tab carries the same six human columns then a different
Apollo block, exactly as `lib/sales-import.js` already expects. **451 rows in what Drive's export
returned; 153 carry a Sales Owner and 89 a Sales Cycle Status.** Owners as typed: `Larry Pike` 56 ·
`Brandon R` 51 · `Brandon Roberts` 31 · `Troy` 7 · `Matt Brown` 6 · `Sawyer` 1 · `Andrew` 1 —
"Brandon R" and "Brandon Roberts" are one person split across 82 rows.

Two honest limits on those numbers: the export showed the last two tabs empty, which may be a
truncated export rather than a real total, so **the count to trust is the one the import screen
reports off the downloaded file**; and the Rules tab now instructs reps to fill a **Date Claimed**
and a **Site Score** column, **neither of which exists on any tab**.

### 44.3 An import is a thing that happened

`admin_import_batches`, one row per press of Import, plus `import_batch_id` on leads, firms and
lists. A list is not the same thing as an import run — a list can be imported into twice and added
to by hand — so "undo that import" needed something of its own to aim at. The batch row is opened
BEFORE the first write, so a run that dies half way still leaves something clearable, and it is
**never deleted**, only marked cleared: "we imported 451 rows on Aug 25 and cleared them on Sep 2"
is worth keeping long after the rows are gone.

**Without 0016 the import still works.** The batch insert fails, `batchId` stays null, and the
`import_batch_id` spread adds nothing — which matters, because that column reaching `.insert()` on a
database that lacks it would fail the whole import. The safety of that rests on the table and the
columns shipping together, and `tests/start-over/sql.sh` pins exactly that.

### 44.4 `admin_clear_import` — the only bulk delete in this console

Scope is exactly ONE of a batch, a list, or everything imported; none or two raises. **What it will
never delete, whatever it is asked:** a contact linked to a client OR flagged `became_customer`; one
carrying a proposal past draft; one added by hand; one with any timeline row the import did not write
itself; a firm that is a client, still has people, or was built by hand; a list that still holds
somebody. Every refusal is **counted and named in plain words** and shown on the screen — "we kept
12" and "nothing happened" look identical otherwise.

`p_expect_leads` is the count the person was shown. The real run refuses if the answer has changed
since the preview.

### 44.5 What the review pass changed, and it was most of it

Three separate adversarial agents ran. The findings that mattered:

1. **A "dry run" could drop a real table in `public`.** `search_path` was `public`, so on the first
   call in a session `drop table if exists _clear_candidates` resolved to `public._clear_candidates`
   and dropped it — as the definer, with the NOTICE suppressed — on a file whose header says it is
   safe to run on the shared project. Five names were exposed. Now schema-qualified to `pg_temp`.
2. **The "somebody has worked them" guard was close to theatre.** It listed call/email/text/
   linkedin/note. Claiming a lead writes `claim`; moving it to Meeting writes `status_change`, and
   the body of that row is where a rep types "booked Thursday 2pm, they want the GEO package".
   Neither was on the list, so that lead was deleted while the dialog said it was keeping nothing.
   The rule is now: **anything the import did not write itself.** The import writes exactly one row,
   of type `import`.
3. **A confirmed, human-typed memory was destroyed silently.** `admin_brain_memory.lead_id` was
   `on delete cascade` — and the comment in this file claimed it was `set null` "by design". The two
   that really were `set null` were the two nobody had checked. 0016 changes the constraint.
4. **The preview and the delete are two transactions**, so the promise that they cannot disagree was
   false; a reviewer showed the button saying "Delete 1" while four went. `p_expect_leads` closes it.
5. **A firm built by hand was deleted** when an import's contacts were cleared out of it — inside the
   stated guarantee, which was the problem: the guarantee was narrower than the work it destroyed.
   Only firms carrying a batch id are removed now; the rest are left standing and **counted**, so the
   screen can say so.
6. **Preview mode had none of the SQL's refusals.** `clearImport({ dryRun: false })` with no
   arguments deleted every imported lead in the store, and a rep could run it. Both fixed, and the
   preview writes its own activity-log line — the property the browser suite demonstrates was
   missing from the path the browser suite exercises.

### 44.6 Six SQL guards and three JS ones were provably untestable

A reviewer deleted each and watched 44/44 stay green. The fixture now carries a firm that is a
client while none of its contacts is flagged; a lead with `became_customer` and no `client_id`; a
firm built by hand; a claimed lead at Meeting stage with the booking on its stage change; and a
typed memory. **All six SQL mutants and the JS ones are now caught.**

The worst of them was not in the code at all: **the fixture itself was failing half way and nobody
noticed.** `admin_brain_memory` has a unique dedupe constraint, so the second `seed()` errored on
the memory insert and — one heredoc, `ON_ERROR_STOP` — everything after it silently never ran.
Section 4 was asserting against a fixture with no proposals, no activity and no client wiring.
`seed()` now fails loudly and counts its own rows before any assertion runs.

### 44.7 The files

| Piece | Where |
|---|---|
| Batches, the clear function, the guards | `supabase/migrations/0016_import_batches_and_start_over.sql` |
| `listImportBatches` · `startImportBatch` · `finishImportBatch` · `clearImport` | end of `src/lib/data.js` |
| The panel and the confirm dialog | `src/components/admin/salesStartOver.jsx` |
| Opening and stamping the batch | `src/components/admin/salesImport.jsx` |
| The Start over button | `src/components/admin/SalesPage.jsx` |
| Tests | `bash tests/start-over/run.sh` · `node tests/start-over/walkthrough.mjs` |

### 44.8 Proof on record (Aug 26 2026)

`npx eslint .` 0 problems · `npm run build` clean · `tests/start-over/sql.sh` **59 checks against a
real Postgres 16**, every migration in order and 0016 re-run · `tests/start-over/walkthrough.mjs`
drives the **built bundle** through import → clear → import again, 8 screenshots, no console errors,
and checks the paying client and the hand-typed contact survived **by counting rows on the page** ·
every other suite unchanged.

### 44.9 Blocked until, and how to use it

1. **Run `0016`.** Clicks in `SETUP.md` → "Migration 0016". Until then the Start-over screen says in
   plain words that nothing can be cleared, and imports still work but are not undoable.
2. **To test the import today with nothing saved anywhere:** open the console in sample mode (the
   orange SAMPLE badge). The importer writes to memory and forgets it on reload.
3. **On go-live day:** Sales → Start over → *Clear everything imported*, then download a fresh copy
   of the sheet and import it again.

### 44.10 Known gaps, written down rather than hidden

* **There is no rep-name mapping screen.** Ryder's call, Aug 26: *"skip building them in there until
  the admin is live."* Until it exists, the 153 claims in the sheet come in **unclaimed** unless
  those reps already have console logins — the typed name is kept on every row either way.
* **Clearing by LIST is not on the screen**, only by batch and everything-imported. The function
  takes a list and it is tested; nothing calls it yet.
* **A firm left standing with nobody at it is counted, not offered.** Removing it is a separate act
  on the Firms view.
* **The preview mirror in `clearImport` is a second copy of the rules.** It matches today and is
  tested to match; two copies of a rule is still two copies.

---

## §45. THE FLOOR — the rep console rebuilt as four pages, and the lock moved onto the row — Aug 27 2026 (append-only section)

**Read this for anything a sales rep sees.** It replaces §26.5 and the whole of the Aug 26 rep
split on WHAT EXISTS; §26.4's eleven rules still stand and §43's sheet is still the sheet.

Status: **built, lint clean, `vite build` clean, tested, driven in a real browser. NOT COMMITTED
and NOT PUSHED, so none of it is on the deployed site.** Migrations `0018`–`0023` are new and
unrun, on top of `0007`–`0017` which were already unrun.

**AND THE CONSOLE IS DEPLOYED — every earlier state board in this file that says otherwise is
wrong.** Measured in Chrome on Aug 27 2026 by another session:
`https://ai-syndicate-admin.vercel.app` is Ready, last deployed Aug 26 from `main` at commit
`c5ea811`. What is on that URL is therefore YESTERDAY'S code, not this section's.

It is also running on sample data: `GET /api/health` on the live URL returns 200 with all
thirteen flags false and `"Supabase env vars are missing on the server"`, so the deployed server
cannot see a usable service-role key even though ten variable names have been on the Vercel page
since Aug 18. **A name on that page is not a working key**, and `/api/health` on the deployed URL
is the one honest answer to "are the keys working" — a 401 from it is good news, because it means
auth started working. Do not conclude anything about deployment from the absence of a `.vercel`
folder locally; that only means nobody ran `vercel link`.

Built from `AI-Syndicate/Admin-Sales-Floor-Aug27/BUILD-PROMPT-the-floor.md` and the clickable
wireframe Ryder approved the same day.

### 45.1 A rep has four pages, not three

| Page id | Name | What it is |
|---|---|---|
| `overview` | Overview | The ask-anything box, then this rep's own numbers. Landing page. |
| `floor` | The Floor | Every lead in the company, with a three-state switch: Mine · Available · All. |
| `gmail` | Gmail | This rep's own mailbox. |
| `brain` | AI Brain | This rep's own tone rules. |

`work`, `leads` and `mine` are **gone as page ids**. `SPLIT_FOR_ROLE` in `AdminDashboard.jsx`
is a map per role now and rewrites all four old addresses; `Header.jsx` gained a `ROLE_TITLES`
override because `overview` and `brain` are shared ids that mean different things to different
roles. The role is deliberately NOT in the URL: an address that has to agree with who is signed
in is an address that eventually does not.

Owner and admin keep their Sales page. It gained the outreach columns and the loss breakdown in
the Rep numbers modal, and lost nothing.

### 45.2 THE ARCHITECTURE CALL — one set of records, three layouts

Ryder: *"each reps account seperate because they are independant and they all work
independately, but on the owners side and admin side they all have to come together and
everything has to flow."*

The only shape where both halves are true:

1. **One read.** `getFloorBoard()` — `getSalesBoard()` plus the tag vocabulary, the current tag
   state and the scans. A page may not fetch its own leads. `tests/floor-scoping` asserts this
   structurally, including against an ALIASED second import, which is how a reviewer broke the
   first version of that assertion.
2. **One row builder.** `sheetRow()`. Three layouts on top of it.
3. **No stored aggregates. Anywhere.** Every number is counted from the rows at read time.
4. **The rep's tile and the owner's cell are the same function** — `outreachFor()` in
   `lib/outreach.js`, called once per person for the owner's table. There is a browser test that
   reads both numbers off two real screens and asserts they are equal, and it is
   mutation-proved: changing the owner's window makes it fail.

### 45.3 THE LOCK IS ON THE ROW, NOT ON THE PAGE

> ⚠️ **SUPERSEDED ON VISIBILITY BY §52 (30 Aug 2026, evening).** A rep no longer sees a lead
> somebody else holds. Everything below about the greyed row and the read-only drawer describes
> a state that can no longer be reached on the Floor. The EDITABILITY half is unchanged.

**Visibility: every lead, every role.** **Editability: mine, or nobody's, or I am owner/admin.**

- `canEditLead(lead, member)` in `src/lib/salesSheet.js` is the ONLY editability check. Nothing
  re-derives it. A missing member and a member with no role both return false.
- Somebody else's row: dimmed (`.adm-sh-row.theirs`), every control replaced by its value, a
  `🔒 Held by <name>` marker, and the drawer opens **read-only** — every field, every note, the
  whole timeline, and not one button. That is the requirement, not a softening of it: a rep has
  to be able to see that another rep is already in the building.
- `openLeadById` was kept and repointed. It refuses an id that is not in the rows that were
  loaded, and read-only is decided once, at the drawer's call site, from `canEditLead`.

**THE HOLE THIS CLOSED, which was already open.** `admin_leads` UPDATE was
`using (admin_is_member())` with **no `with check`** (0001:403-405). In plain words: any rep could
already reassign any lead to themselves by talking to the database directly. Nobody noticed
because no button offered it. `0020_rep_scoping.sql` closes it, and does the same on
`admin_proposals`, `admin_lead_activity`, `admin_lead_tag_events` and `admin_email_threads`.

**A DEFECT IN THE BUILD PLAN, and the reason the shipped rule is wider than it specified.** The
plan asked for `with check ( admin_is_admin() or owner_id = auth.uid() )`. That version breaks
two ordinary things:

* a rep could never hand a lead back to the floor — `releaseLead` writes `owner_id: null` and the
  resulting row fails that check;
* **logging a touch on an unclaimed lead would fail.** `admin_lead_activity_touch` (0009) is a
  plain trigger, not `security definer`, so its UPDATE on `admin_leads` runs as the person who
  logged the activity and IS subject to this policy. On an unclaimed lead the row still has a
  null owner afterwards.

So `owner_id is null` is allowed in the WITH CHECK, and the USING clause is what keeps a rep out
of another rep's row. Written out in full in 0020 section 1 so nobody tightens it back.

**THE SAME RULE IN THREE PLACES**, and 0020's own section 6b says the one way to undo all of it:
re-running an EARLIER migration after a later one that tightened a policy of the same name
reverts the tightening. If you ever re-run `0001` or `0009`, run `0020` and `0023` after them and
then `bash tests/floor-scoping/sql.sh`.

### 45.4 THE SECURITY HOLE THE REVIEWS FOUND — migration 0023

`admin_lead_to_client` (0015, Aug 25) is `security definer`, is granted to `authenticated`, and
its only guard was `admin_is_member()`. It also took the author's id as a **parameter**. So one
line in any rep's browser console:

```js
supabase.rpc('admin_lead_to_client', { p_lead: '<any lead id>', p_actor: '<anybody>' })
```

marked another rep's live deal Won, created a client record, relinked every contact at that firm,
and filed the `'converted'` timeline row under whatever user id the caller typed. Trap #6 in §8
for the fourth time in this repo, and the first time a *forged author* was possible.

`0023_close_the_won_hole.sql` replaces the function with two guards: the row lock (through
`admin_can_work_lead`, one function for a rule four tables need) and "the author is whoever is
asking" — a rep may only pass their own id, an owner may name somebody else. The body was
extracted from 0015 **by a script** rather than retyped.

### 45.5 Tags are an append-only event log

Two tables (0018). `admin_lead_tags` is the vocabulary; `admin_lead_tag_events` is every add and
every remove, with the day, the person and the reason. **There is no `tags` column and no
`current` flag, and no update or delete grant on the events at all — not even for an admin.** A
lead's tags right now are the replay of that log.

Two consequences that fall out for free: the dated history Ryder asked for, and the rule that an
automatic rule never puts back a tag a person removed by hand — the removal *is* the record, so
nothing has to remember it. The mirror rule (a rule never removes a tag a person added) was
missing from the first version and was found by review.

`admin_lead_tags_now` is a **view** — the newest event per lead per tag, computed in one line of
SQL with `security_invoker` on. Not a stored copy: the board cannot read the whole log for two
thousand leads, and the log cannot be windowed (an `added` from three months ago falling outside
a window makes a tag that IS on a lead look like a tag that is off, and a filter built on quietly
wrong tags looks like it worked).

**Deliberately NOT tags:** the firm's line of business, and where it is. Both are real columns
that arrive with the sheet, both are their own filter, and both are OPEN sets — a new vertical
would need a new vocabulary row, which only an admin may write, so an import run by a rep would
silently fail to tag half its rows.

### 45.6 Won and Lost ask why, in front of the ONE function

A counted reason from a fixed list (`LOST_REASONS` / `WON_REASONS` — two separate lists, because
"price" is not a reason somebody said yes) **plus** what actually happened in the person's own
words, at least 15 characters. `checkCloseReason` refuses an empty reason and a note too short to
read back. **The honest limit, on record: the only test on the note is its length.** One
fifteen-character word passes.

The box sits in front of `closeLeadWon()` / `markLeadLost()` in `src/lib/data.js`, NOT in front of
the four buttons that reach them — that is how three get it and one does not, which is exactly
the defect that made one of those four permanently block the only one that worked (§43.4).

Before today the only button that ever wrote a loss reason wrote the same sentence every time, so
the loss breakdown would have been one bar tall for ever. A **fifth** path also existed: the
assistant's `update_lead` tool wrote `stage: 'won'` straight to the row with no reason, no date,
no note and no tag. It refuses both stages now, and `SETTABLE_STAGES` keeps them out of the
tool's schema so the model is not offered a value it will be refused.

### 45.7 OUTREACH, AND WHY THERE IS NO OPEN RATE

**Gmail cannot tell anybody whether an email was opened, and neither can anything else.** There is
no recipient-side open signal in the API. The only way an "open rate" is ever produced is a
tracking pixel, and Apple Mail Privacy Protection loads it for everybody whether they read the
mail or not while Gmail proxies images through Google. The "under 3%" figure in the industry is
measured with that same broken pixel. **Ryder agreed to drop it on Aug 27 2026.** If anyone ever
adds one it is labelled GUESSED and never mixed with the numbers below.

Measured instead, all of it real: **people emailed · replied · reply rate · time to first reply ·
bounced**, plus the touches actually logged.

**The unit is a PERSON, not an email.** A rate needs a numerator and a denominator in the same
unit; emails sent over people who replied is two facts divided by each other. It is also what
makes the owner's table possible at all: threads are keyed on a mailbox, and
`admin_gmail_accounts` is readable only by the person who connected it, so nothing in the browser
can map a mailbox to a rep. Lead columns can.

**A reply is only a reply to something we sent inside the same window**, and a bounce comes out
of the denominator. Both of those were wrong in the first version and produced a **300% reply
rate** on a real fixture, printed on screen as "3 of 1 people who could answer".

`0021` also repointed the one-text rule. `admin_leads.email_opened_at` exists and **nothing has
ever written it** — and it was the hard gate on the one-text rule, in the SQL function AND in
`textGate()` in the browser. So texting has been switched off permanently since Aug 21 and nobody
knew. Both copies now gate on `first_reply_at`. A reply is a stronger signal than an open anyway:
an open can be an image proxy, a reply is a person typing.

### 45.8 A rep's own AI rules — and the mechanical reason they carry no numbers

`admin_user_brain` (0022), one row per rule, RLS `user_id = auth.uid()` plus an admin READ (a rule
nobody can audit rewrites what prospects get told). **Not** a `user_id` column on `admin_brain`,
whose admin-only policy is what keeps the company Brain away from a rep (trap #8).

They reach the model through `lib/ai.js buildSystemPrompt()`, placed AFTER the company rules and
BEFORE the job instruction, in a block that says in words that the company rules win — the same
shape as the feedback loop in §32/§33: correction above, constraint below, and the constraint
saying it wins. `api/ai-draft.js` reads them unconditionally for every role, and only ever the
caller's own. `api/rep-report.js` puts them into `repFactsText` too, **so the model and the
honesty gate read the same string**.

**And that is exactly why a rule may not contain a number.** These rows enter the pool the gate
checks a draft's numbers against. Type "our clients see a 40% lift" into your own rules and the
gate will let the AI write it to a prospect, because as far as the gate can tell we told it that.
`checkPersonalRule` refuses **any digit** — stricter than it sounds, and deliberate: allow a
single digit and "if their score is under 6, name it" walks through, and a bare 6 in the pool is a
number the model may then attach to a firm. Nothing a tone rule needs to say requires a digit.
**The label goes through the same check** — it was not checked at first, and both prompt renderers
print it. Known limits, on record: "forty percent" written in words, and non-ASCII digits.

### 45.9 The scan is built and cannot be switched on

`api/sales-score.js` keeps every rule it had — the request may only name WHICH firm, the website
comes from our own database, an unreadable response saves nothing, no score is ever invented,
clamped or estimated — and now reads three scores plus findings and writes an
`admin_company_reports` row per scan. A re-scan **inserts**; nothing is overwritten, so "was 65 in
September and still 65 in November" stays readable.

`PLATFORM_SCORE_URL` does not exist and the response shape has never been written down. The panel
reads `/api/health` rather than hard-coding it, so the sentence cannot outlive the thing it
describes, and the button is off with the reason on it. **A missing half of a scan is a dash, never
a zero** — a firm shown as 0 for AI Access reads as the worst site anybody has seen, which is the
hardest a rep would ever go in.

### 45.10 THE ONE RULE THIS SECTION NARROWS — the send button

§42 PART 2 rule 6 says **NOTHING IS EVER SENT FROM THE CONSOLE** and "do not improve this into a
send button". Read carefully, that rule is about **CLIENT REPORTS**, and it is enforced in
`clientReports.jsx:546`, where the Gmail button saves a draft and stops. That stays exactly as it
is, for ever.

**A rep sending their own outreach from their own mailbox, after reading the draft, is a different
contract and is allowed.** The Inbox has had three human-clicked Send buttons since Aug 18.
Reason: making a rep switch to Gmail for every email defeats the whole page, and it is their own
mailbox and their own click. Written here because the next session will otherwise "fix" one into
the other.

### 45.11 The rules that must not be broken

1. **One source of rows.** No page fetches its own leads. No stored totals, ever.
2. **`canEditLead()` is the only editability check.** Never re-derived inline.
3. **Every rule exists in RLS AND in the endpoint AND in the UI** — and inside every
   `security definer` function, which is the place it was missed twice.
4. **Records are append-only:** notes, tag events, the timeline, scan reports. A correction is a
   new row.
5. **One action, one function** — and it writes the timeline row in the same call.
6. **Every write asserts the state the screen showed.**
7. **Dates go through `teamDay.js` / `Intl`; rule functions take `now` as an argument** and never
   read a clock. A missing clock REFUSES rather than guessing — and it must leave the clock-based
   tags alone rather than stripping them, which the first attempt at that got backwards.
8. **An empty answer is null, never zero.** When a read hits its cap, the wording changes.
9. **A measurement is a number PLUS its window PLUS the day it was read PLUS who read it.**
   Every tile and every column of the owner's table is stamped.
10. **Read-by-us and typed-in-by-us never blend.**
11. **Personal AI rules carry no facts and no numbers** — body and label alike.
12. **No rankings between people on a rep's own pages.**
13. **Two numbers on one screen must add up**, or one of them says why it cannot.

### 45.12 Proof on record (Aug 27 2026)

`npx eslint .` clean · `npm run build` clean in the cloud container · **17 pure suites, 0
failures**, the new ones being `lead-tags` 220, `floor-scoping` 231, `outreach-stats` 177,
`user-brain` 64 and `company-report` 63, each across five timezones · **7 database suites against
a real Postgres 16**, migrations `0001`–`0023` in order with `0018`–`0023` re-applied · **two
mutation proofs** (reinstall the old wide policy, watch the assertions wrongly pass, put it back)
· **`tests/floor-scoping/walkthrough.mjs` drives the BUILT bundle through 44 assertions and 22
screenshots with 0 problems**, as a rep and then as the owner, and reads the same number off both
screens · **three adversarial review passes, the third on the fixes only: 25 defects, then 20
more, several of the second batch caused by the first batch's fixes.**

### 45.13 Blocked until, and known gaps

Blocked: the scan (no platform address, no documented response) · storage (`0007`–`0023` unrun,
nobody has database access) · **getting this code onto the live site** — the console IS online, but
nothing here is committed or pushed, and the deployed server has no working Supabase key, so the
live URL runs Aug 26's code on sample rows.

Gaps, written down rather than described away:

* **Nothing tags the existing book.** The only caller of the automatic rules is a per-lead button.
  The sweep and the import are where it belongs and neither calls it, so tag filters return
  nothing on a fresh database until somebody presses that button.
* **The three scan scores and the tags are not in the AI's fact sheet.** The outreach numbers now
  are. The other two are named as absences so the AI says "not in my records" rather than having
  a whole answer thrown away.
* **`api/gmail-threads.js` records a reply on a lead without checking its owner** — deliberate: it
  is an observation in a mailbox the caller was already granted, and each column is a one-shot
  stamped only while somebody has the page open. The narrower hole (a rep can link their own
  thread to any lead) belongs to the Inbox's link picker.
* **`leadWeMayWrite()` is two identical copies**, in `gmail-send.js` and `gmail-drafts.js`.
* **`personalRulesRead` comes back from `/api/ai-draft` and no screen reads it.**
* **`getSalesBoard` turns a failed read into `rows: []`**, so `lib/outreach.js`'s null-is-not-zero
  path is unreachable from the board. A `failed: {...}` map was added and only the AI's fact sheet
  uses it; the tiles still lean on the warning banner above them.
* **The tag state read is capped at 12,000 lead-tag pairs** and a lead past it shows fewer chips
  than it carries. The page says so.

### 45.14 The files

| Piece | Where |
|---|---|
| Tags · reasons + scan reports · the row lock · outreach · the personal brain · the Won fix | `supabase/migrations/0018`–`0023` |
| `canEditLead`, the availability switch, stacking filters, the bands, the scan reader | `src/lib/salesSheet.js` |
| The automatic tag rules, the close reasons, `checkPersonalRule`, `textGate` | `lib/sales-rules.js` |
| Reading the tag event log | `lib/lead-tags.js` (new) |
| Outreach counting for both sides | `lib/outreach.js` (new) |
| The rep's outreach block in the AI's fact sheet | `lib/rep-report.js` |
| The Floor, its filter bar, its row buttons, its four modals, the owner's rep numbers | `src/components/admin/SalesPage.jsx`, `salesSheet.jsx` |
| The read-only drawer and every Won/Lost path | `src/components/admin/salesProfile.jsx` |
| The rep's Overview and AI Brain | `src/components/admin/repOverview.jsx`, `repBrain.jsx` (both new) |
| A rep's own Gmail, reply and bounce counting, token encryption | `Inbox.jsx`, `api/gmail-*.js`, `lib/gmail-mailbox.js` |
| One action, one function | end of `src/lib/data.js` |
| Tests | `tests/lead-tags` · `tests/floor-scoping` · `tests/outreach-stats` · `tests/user-brain` · `tests/company-report` |
| The browser proof | `tests/floor-scoping/walkthrough.mjs` and `shots/` |

---

## §46. THE FLOOR VERIFIED, AND TWO TEST FILES THAT WERE PROVING REPLACED RULES — Aug 28 2026 (append-only section)

Follow-on to §45. §45 is still correct about what exists. This section is the final verification pass
run on the finished code, and the two defects it turned up. Nothing in §45 has been edited.

### 46.1 State, unchanged

Still **not committed and not pushed**. Migrations `0007`–`0023` still never run. The live console
(`ai-syndicate-admin.vercel.app`) still runs the Aug 26 build, on sample rows, because that server
has no working Supabase key.

### 46.2 The verification pass, measured Aug 28 2026

The finished source was re-synced off the Mac into a clean container copy and everything run again,
because the last full green run predated the third review round's fixes.

- `npx eslint .` **exits 1**, and only because of `_to_delete/__gatecheck.jsx` — the deliberately
  broken two-line file left on Aug 26 to prove the linter catches things. With
  `--ignore-pattern '_to_delete/**'` it exits 0, no errors, no warnings. Never write "lint clean"
  without that second sentence.
- `npm run build` — clean. 154 modules, one pre-existing chunk-size warning.
- **20 test suites, 0 failures.** §45 said 17. It was undercounting: `client-timeline` and `ops` have
  only `test.mjs` and no `run.sh`, so a `for d in */run.sh` loop skips them silently, and `share` was
  simply missed. Counts: floor-scoping 231 · lead-tags 220 · outreach-stats 177 · connectors 165 ·
  sales-sheet 139 · sales 108 · vault 106 (+36 database) · brain 78 · user-brain 64 ·
  company-report 63 · rep-brief 57 · rep-report 54 · finance 53 · share 48 · inbox 47 ·
  console-report 46 · overview 44 · client-timeline 40 · ops 18 · start-over (database only).
- **8 database suites** against real Postgres 16, all applying `0001`–`0023` in order. Only
  `tests/floor-scoping/sql.sh` re-applies `0018`–`0022` a second time; `0023` is re-applied inside
  its own mutation section.
- **Browser walkthrough: 44 checks, 0 problems, 22 screenshots.** The rep's Overview and the owner's
  table both read `1` for people emailed and `1` for replies.
- The 22 screenshots in `tests/floor-scoping/shots/` are now this run's, proved by hashing all 22 on
  each machine: both give `00ab47330ca71d6b12faafbe3daef480562862cbbfae35445d4846aa0caa5387`.

### 46.3 Two traps in the test harness itself

- **`tests/brain/sql-crosscheck.sh` cannot run as root.** It is an Aug 20 file that calls `initdb`
  directly instead of dropping to the `postgres` user. As root it dies with
  `initdb: error: cannot be run as root` and `tests/brain/run.sh` exits 1, which looks like a failing
  suite and is not. Run it as the `postgres` user and it passes: "JavaScript and SQL agree on all 24
  cases".
- **`tests/floor-scoping/sql.sh` exits 0 when it cannot start a database.** Lines 55-56 print
  `Postgres would not start; SKIPPED.` and `exit 0`, deliberately, so the file runs anywhere. A green
  run is therefore not proof the database half ran. Read for `all database checks passed`.

### 46.4 DEFECT — `tests/sales/sql.sh` re-ran 0009 after 0021, twice, and reverted the rule both times

`0009_sales.sql` contains `create or replace function public.admin_lead_claim_text(...)`. This file
applies every migration in order and then re-runs `0009` — once near the top as a deliberate "is this
safe to run twice" check, and once further down because section 5 tests `0009`'s own backfill. Each
re-run **silently reverted** the function to 0009's version: the gate went back to
`email_opened_at is not null`, and 0020's row-lock line vanished from inside it. Nothing errored.

Consequences: two assertions in section 4b were proving the rule this build **replaced** — one of
them read *"no text is allowed before an email open is recorded"* — and the two lines `0021` actually
changed were covered by nothing in the file. After the second re-run, the file also simply *ended*
with the replaced rule in the database, so the next assertion anybody appended would have been wrong
too.

**The fix, in that file only.** Both re-run points now re-apply `0020` then `0021` straight
afterwards, and three checks read `pg_get_functiondef` out of the live database:

- *"after 0009 was re-run, 0021's one-text gate is back (first_reply_at)"*
- *"...and 0020's row lock is back inside the function too"*
- *"this file ends with 0021's one-text gate in place, not 0009's"*

The stale fixtures now set `first_reply_at` instead of `email_opened_at`, and one label reading
*"a sales rep can move any lead's stage (no locks between reps)"* — true when written, false since
`0020` — now reads *"a lead THEY OWN"*, with the reason next to it.

**Mutation-proved:** delete the re-apply loop and the new checks fail with their own messages
(*"every assertion in 4b would be testing the replaced rule"* and *"the row-lock line is missing from
admin_lead_claim_text after the re-runs"*); put it back and they pass.

**The general rule.** If a test applies migrations in a loop and then re-applies an older one, every
`create or replace` in that older file is a time machine. Re-apply the later migrations afterwards,
and assert the new definition is really in the database before any assertion leans on it. This is the
same hazard `0018` warns about and `0020` §6b writes an order for — it had simply never been checked
for inside a test file.

### 46.5 The report, and what two checkers killed in it

Two-layer report written and filed as `WORK-LOG/2026-08-28--internal--the-floor-report-SHORT.md` (the
one to share) and `...-FULL.md` (filed). Two separate checker agents ran on it, the second on the
corrections only: **24 findings, then 19 more, four of which the corrections themselves introduced.**

The claims that were wrong are worth carrying, because they are recurring shapes:

- A capability claim the code had already retracted in its own comment: that a punctuation-only close
  note is refused. `checkCloseReason` tests **length only** — "n/a n/a n/a n/a" is exactly 15
  characters and passes.
- Two "can never" claims the schema contradicts. Tag events cannot be edited or deleted, **but**
  `on delete cascade` on the lead takes the whole history with it, and `on delete set null` on the
  signer blanks the name. `tests/lead-tags` proves both on purpose.
- "No stored totals anywhere" — false. `admin_leads.texts_sent` is a stored counter that gates a
  button, and the three scan scores are stored in `admin_company_reports`.
- `admin_company_reports` is not "insert-only": there is no UPDATE policy, but DELETE is granted to
  admins, and `0019`'s own comment says that is worth being uneasy about.
- The null-is-never-zero promise is true in `lib/outreach.js` and unreachable on the page, because
  `getFloorBoard` turns a failed read into an empty list.
- Widening a hole while correcting it: `admin_lead_to_client` checked `admin_is_member()`, so it was
  shut to an outsider with a login and open to every member of staff. "Any signed-in person" was
  wrong in the direction of worse.

---

## §47. THE CONSOLE IS RUNNING ON REAL DATA — keys, database, login, Gmail — Fri Aug 28 2026 (append-only section)

Everything here is measured, not assumed. Times are Central.

### 47.1 What is true now that was not true yesterday

- **The database exists.** All **23** migrations ran (0001–0023). Verified by counting
  afterwards: **46 tables, 23 functions, 115 policies** — the policy count matches the 115
  distinct policy names in the migration files exactly. Before this, the Supabase dashboard
  said **"LAST MIGRATION: No migrations"**. Not "some unrun" — none had ever run, and every
  earlier state board that guessed a number was wrong.
- **Real sign-in works.** `VITE_NO_SIGNIN=false`. Ryder is an active `owner` row in
  `admin_users`, user_id `d917adfc-2abf-4417-b8c3-053b00236f43`.
- **Gmail is connected.** `growth@aisyndicate.com`, LIVE, 25 real threads.
- **The deployed site is locked** behind Vercel Authentication (Standard Protection).

### 47.2 The Supabase key: the legacy tab is a dead end

The `service_role` JWT from the **"Legacy anon, service_role API keys"** tab returns
**401** — legacy JWT keys are disabled on this project. The working key is the
**`sb_secret_`** one from the *Publishable and secret API keys* tab, named
`prod_service_role`, which Andrew had already created for exactly this.

Test any Supabase key without exposing it — reads the value out of the file, prints only a
status code:

    cd ~/Documents/AI-Syndicate/ai-syndicate-admin && curl -s -o /dev/null -w "%{http_code}\n" \
      "$(grep '^VITE_SUPABASE_URL=' .env.local | cut -d= -f2-)/rest/v1/" \
      -H "apikey: $(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)"

**200** = works. **401** = get the `sb_secret_` one.

### 47.3 Changing a password when MFA is on

The platform's `/#/reset-password` page answers *"AAL2 session is required to update email
or password when MFA is enabled."* A reset link only gives an AAL1 session and that page has
no field for the second factor. The way through is the **Supabase Admin API**, which is an
admin action and skips the rule:

    PUT {SUPABASE_URL}/auth/v1/admin/users/{user_id}
    apikey + Authorization: Bearer {service key}, Content-Type: application/json
    {"password": "..."}   → 200

Signing in afterwards works normally at AAL1. Only *changing* a password needs AAL2.

### 47.4 ⚠️ THE HTTPS ASSUMPTION — it broke every OAuth flow on localhost

Six files did `req.headers["x-forwarded-proto"] || "https"`. Vercel always sets that header
so production was fine; `npm run dev` sets nothing, so the server believed it was on https
while the browser was on `http://localhost:5173`. Two failures, **neither of which points at
the cause**:

1. The OAuth state cookie was written with `Secure`. A `Secure` cookie sent over http is
   dropped, so the callback found no cookie and redirected with
   `?gmail=error&reason=browser_mismatch` — which reads like a browser problem.
2. The redirect home was built as `https://localhost:5173` → **ERR_SSL_PROTOCOL_ERROR**.

Fixed with **`lib/req-origin.js`** — `originFromRequest(req)` and `secureFlag(req)`. A
forwarded header always wins, so production is unchanged; only a request with no forwarded
proto **and** a localhost host is treated as http. Applied to `gmail-auth-start`,
`gmail-callback`, `connect-start`, `connect-callback`.

**This also fixed the client-connections flow** (Search Console / Business Profile /
Analytics), which carried the identical bug and had never been tried.

### 47.5 ⚠️ A DEAD SESSION RENDERS AS "YOUR KEYS ARE MISSING"

`getHealth()` in `src/lib/adminApi.js` line 41: when the request fails it **fabricates**
`{supabase:true, stripe:false, gmail:false, ai:false, …}` — the same shape as "no keys are
set". So a 401 is indistinguishable from missing keys on every page that reads health.

This cost about an hour of chasing Google keys that were correct. The tell: Settings showed
Google **LIVE** at 1:21 PM and **WAITING ON KEY** at 1:41 PM with nothing changed between.

Diagnose it in thirty seconds, in the app tab's console:

    const v = JSON.parse(localStorage.getItem('sb-xweueatikwvnahegeful-auth-token'));
    await (await fetch('https://xweueatikwvnahegeful.supabase.co/auth/v1/user',
      {headers:{apikey:'<the sb_publishable key>', Authorization:'Bearer '+v.access_token}})).json()

It answered **`"Session from session_id claim in JWT does not exist"`** — signed, unexpired,
session revoked server-side. Almost certainly fallout from changing the password through the
Admin API earlier the same day. **Fix: sign out, sign back in.**

The fabricated object carries `error`. The Inbox now checks `health?.error` first.
**The Settings page still has this blind spot.** If every integration goes orange at once,
suspect the session, not the keys.

### 47.6 Google Cloud: what was built, and the trailing-slash trap

Project **`AI Syndicate Admin`**, in the **aisyndicate.com organization**, owned by
**growth@aisyndicate.com** (Ryder's call — the whole team can reach it). OAuth client
`admin-console`. Seven APIs enabled: Gmail, Search Console, Analytics Data, Analytics Admin,
My Business Account Management, My Business Business Information, Business Profile
Performance.

**Google saved every redirect URI with a trailing slash** (`.../api/gmail-callback/`). The
code sends none. Google matches character for character → **Error 400:
redirect_uri_mismatch**. Remove the trailing slash on every one.

All four must be registered — the localhost pair is **not** optional:

    https://ai-syndicate-admin.vercel.app/api/gmail-callback
    https://ai-syndicate-admin.vercel.app/api/connect-callback
    http://localhost:5173/api/gmail-callback
    http://localhost:5173/api/connect-callback

**SETUP.md § 5 says `admin.aisyndicate.com`. That domain does not exist.** The live address
is `ai-syndicate-admin.vercel.app`.

### 47.7 The Inbox connect screen, and the end of sample mail

At Ryder's request the connect screen is now a heading, one line and one big centred button.
The old bordered card — four-step list plus a three-row permission table — is gone. The
permission detail survives inside a collapsed native `<details>`, because it is a privacy
promise to whoever attaches their own mailbox; it is not deleted, just out of the way.

**Sample mail is demo-only now.** It used to render whenever Gmail was not connected, which
made an unconnected mailbox look like a working one and hid the connect button completely.
Every sample path is now behind `!configured` — no Supabase at all, the role-preview demo.
With a real console, no mailbox means the connect screen, every time.

### 47.8 The `.env.local` naming rule that stops a leak

`.gitignore` covers `.env`, `.env.local` and `.env.*.local`. It does **not** cover
`.env.platform`, `VERCEL-PASTE.env.local`, or `.env.local.bak`. A secrets file whose name
does not end in `.local` **will be committed**. Always end it `.local`, and run
`git check-ignore -v <file>` before writing anything sensitive into it.

### 47.9 ⚠️ Vercel: what is there, and what must not be deleted

The deployed project still runs on the **fourteen** rows added Aug 18 by another account,
plus a `CRON_SECRET` added Aug 27 evening by a third. At least one of `VITE_SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` there is **empty** — proven because `/api/health` returned the
"env vars are missing" branch, which only fires when the value is absent entirely; a wrong
value would have given a 401 instead.

**Do NOT delete `STRIPE_SECRET_KEY`, `ANTHROPIC_API_KEY` or the two `GOOGLE_OAUTH_*` rows.**
They are type "Secret" — write-only, so nobody can tell whether Andrew put real values in
them. Deleting destroys the only copy. Overwrite instead.

Also: a project-level variable **always overrides** a linked Shared Environment Variable with
the same name, so linking a shared key over a dead project-level row changes nothing.

Ready-to-paste block: **`.env.vercel-paste.local`** — 16 values, per-project overrides
already applied (`ADMIN_BASE_URL` set to the live address, `VITE_NO_SIGNIN=false`, both
`*_REDIRECT_URI` deliberately omitted).

## §48. AI USAGE + COST — one price book, one logger, and a page that says what it cannot see — Fri Aug 28 2026 (append-only section)

Ryder's ask: *"for tracking api usage and our costs, can we track that if i have the api key for
each of the ai's?"* then *"lets skip on the admin key for now. can you build all of that with what
you have so that it tracks the finances correctly?"*

**BUILT. lint clean. 324 pure assertions across five timezones. 47 checks against a real Postgres.
Driven in a real browser, 20 checks, zero console errors. NOT DEPLOYED. Migration 0024 NOT RUN.**

Full design: `BLUEPRINT-AI-USAGE-TRACKING-2026-08-28.md`. Setup clicks: `SETUP.md` → "Migration
0024". Work log: `WORK-LOG/2026-08-28--internal--ai-cost-tracking-built.md`.

### The answer to the original question, because it shapes everything below

**A normal API key cannot read spend.** It can spend money; it cannot read the bill. That takes an
**Admin key**, which only an org owner can create — Anthropic and OpenAI both have one, Gemini has
no usage API at all (it is Cloud Billing export), and Perplexity has none that could be found. So
the tracker is two halves and only one of them is built: **we count every call ourselves** (works
for every provider, and the only way to say which *client* the money went to), and one day we check
that against the provider's own bill. The second half is deliberately absent, and the page says so
where the comparison would be rather than showing a green tick it has not earned.

### The five rules the whole thing runs on

1. **A cost we cannot work out honestly is NULL, and null prints as words.** Never 0. Zero is a
   real answer meaning "this was free" and must never be the shape "we don't know" takes.
2. **Prices are dated rows in a table, not numbers in code**, and the cost is worked out once at
   write and frozen with the `price_id` it used. Changing a price tomorrow cannot move last
   month's total.
3. **Money is whole micro-dollars (`bigint`).** A cheap call costs a fraction of a cent; floats
   lose those fractions a little at a time over tens of thousands of calls. `numeric(12,6)` also
   overflows at 999,999.999999.
4. **`status` says what happened to the CALL. `cost_micros IS NULL` says we could not price it.**
   Two questions, two answers. An earlier draft made one column answer both and a failed call to
   an unknown model came out labelled 'unpriced' with the failure lost.
5. **Days and months are the team's calendar**, never the browser's and never UTC.

### What was actually wrong before, with file and line

The console already logged AI spend. It was wrong in eight ways, and every one made the *total*
wrong rather than just the presentation:

1. `const COST = { input: 3.0, output: 15.0 }` hardcoded in **seven** files — Sonnet's price,
   applied to whatever model ran.
2. Cached tokens never counted (`lib/ai.js:165-168` returned two fields).
3. The client stored as a NAME (`client-report.js:297`) — a rename split a history in two.
4. Failed calls recorded no cost at all.
5. All seven swallowed a failed write, by **two** mechanisms: four fire-and-forget, and three that
   `await` and never read `{ error }` — and supabase-js does not throw on a DB error.
6. No dedupe. `usage-ingest.js` said so in its own comment.
7. Dollars-as-decimal in a codebase whose money pages run on whole integers.
8. **A live bug nobody was looking for:** `listUsage()` capped at 5,000 rows and never selected
   `meta`, so Finance's AI figure could already be silently too low.

### The shape now

- **`lib/ai-cost.js`** — pure. Prices, tokens, cost, rollups, part-months, drift. No database, no
  network, no clock of its own.
- **`lib/ai-usage.js`** — `recordAiUsage()`. One function, every call site. Never throws.
- **`supabase/migrations/0024_ai_usage.sql`** — `ai_model_prices`, ~19 additive columns on
  `admin_usage_events`, `ai_provider_bills`, the constraints, and nine seeded Anthropic prices.
- **`src/components/admin/AiCost.jsx`** — Finance → AI Cost. Six grouping tabs, everything
  clickable down to the individual calls.
- **`tests/ai-cost/`** — `test.mjs` (324), `run.sh` (five timezones, `TZ=` in the runner),
  `sql.sh` (47 against a real Postgres).

### THE FIFTEEN DEFECTS A REVIEW FOUND, AND WHAT THEY TEACH

A second agent was pointed at the finished build and told to prove it broken. It found fifteen.
Several were the kind that would have shipped and stayed hidden for months.

**1. The ingest endpoint would have 500'd on every single call, forever.**
`upsert(..., { onConflict: "event_key" })` makes PostgREST emit `ON CONFLICT (event_key) DO
NOTHING`. The index was **partial** (`where event_key is not null`), and Postgres will not infer a
partial index as an ON CONFLICT target unless the statement repeats the predicate — which PostgREST
never does. Every call: *"there is no unique or exclusion constraint matching the ON CONFLICT
specification"*, zero rows, silently, at the documented hand-off point for all platform spend.
**The lesson:** the test hand-inserted duplicates, which exercises the index but never issues the
statement the code actually sends. A guard is only proven by the statement that will meet it.
**The fix:** the index did not need to be partial. A unique index already treats NULLs as distinct.

**2. An unknown cost was recorded as 0 on every failure path.** `costMicros` returned null only
when the *price row* was missing. A call that threw passes `usage: null`, which normalised to four
zeros and returned a confident, priced-looking `0` — then sat in the denominator of the average.
`usage == null` now returns null before anything is normalised.

**3. The assistant — the highest-volume AI route — logged nothing when it failed.** Its
`recordAiUsage` sat inside the `try`. Every other route hoists its state out precisely to avoid
that; the one that mattered most was the one not done.

**4. A mid-conversation failure discarded every round already billed.** `converse()`'s usage
accumulator is local, so a throw on round 5 took rounds 1-4 with it. It now attaches
`partialUsage` to the error and the three routes log it.

**5. `Number(r.cost_usd || 0)` on Overview and Finance read an unpriced call as free** — and
`* 100` on a dollars decimal put a *fraction of a cent* into an accumulator `finance-math.js`
requires to be whole, and `monthKey(new Date(r.ts))` bucketed in the browser's zone while Overview
used `teamDate` for the same figure. Both pages go through `lib/ai-cost.js` now.

**6. `formatMicros(0)` is the string "$0.00", and a Figure only blanks on null.** So a month in
which nothing could be priced printed a confident **$0.00** under a green METERED badge — the exact
failure the file's own header says it exists to prevent. `pricedCost()` returns null instead.

**7. Pagination ordered on a non-unique key drops and duplicates rows.** `ts` is not unique;
Postgres gives no stable order inside a tie group across two range queries. Forty rows sharing a
millisecond across a page boundary get counted twice and others never returned. **The old
`.limit(5000)` was a known undercount; ordering on `ts` alone replaced it with a silent,
non-repeatable one.** Now `.order("ts").order("id")`.

**8. `legacy` rows were presented as measured.** The migration labels old estimate rows so no
screen can call them measured — and then `summarize()` counted them as plain `ok` and summed them
into a METERED total, which made the label do nothing.

**9. `normalizeUsage` deleted 200 tokens on a round trip, and a test asserted the wrong answer.**
`cache_write_tokens` is our own stored column and already holds the 5-minute figure alone; the code
subtracted the 1-hour count from it anyway. The test named this "our own stored column names round
trip" and asserted `500 + 200 → 300`. **A test that agrees with the code is not a test** — this
repo has now learned that twice.

**10. `converse()` never forwarded the 5m/1h cache split**, so the assistant, console-report and
rep-report booked every cache write at the cheaper 5-minute rate — a 60% understatement on the
three most cache-heavy features, invisible on the bill.

**11. Not one `ai-draft` caller sent a client**, so 100% of email, ticket and outreach drafts
landed on Internal from pages that knew exactly whose they were. And `uuidOrNull`'s comment claimed
a bad id was "named in meta"; it was not, so spend moved to Internal with no trace.

**12. No call site sent an `event_key`**, so the dedupe protected only Andrew's feed. The key now
defaults to the provider's own request id.

**13. `recordAiUsage` could throw.** Destructuring with `= {}` only defaults on `undefined`, so
`recordAiUsage(admin, null)` threw before the try block — the guarantee was false in exactly the
case a caller hits by accident.

**14. `role="button"` on a `<tr>`** overrides the row's implicit role and breaks the table's
required parent/child structure, so assistive tech loses the table entirely. The button is in the
first cell now. Also: "showing the 100 most recent, there are more" fired at exactly 100 with no
more; the drill's token column omitted 1-hour cache writes; the cache-saving fallback re-priced old
rows against *today's* book (it uses the row's own frozen `price_id` now); `billable: false` was
written by two writers and read by nothing.

**15. Three tests were tautologies.** `migration.includes("'notes'")` is satisfied by a comment;
`` `\b${col}\b`.test(logger) `` is satisfied by the file's own prose; and `SURFACES.length > 5`
pretended to check a `surface` constraint that did not exist. All three are real now, checked in
both directions against the constraint text with comments stripped — and the surface constraint
was added.

### Two traps worth carrying beyond this project

- **A partial unique index cannot be an `ON CONFLICT` target through PostgREST.** If you want
  upsert-on-a-nullable-key, make the index plain: Postgres already treats NULLs as distinct.
- **Zero is a real number.** Any code path where "we don't know" and "it was free" produce the same
  value is a bug, however carefully the rest of the file is written about it.

### What is still needed

Run `0024_ai_usage.sql`, deploy. Nothing else, and nobody else. The provider true-up is the only
thing blocked, on an Admin key an owner creates, and the page is honest about its absence.


## §49. THE SHEET GOES IN WITH ONE CLICK — and four bugs that were losing 99% of it — Sat Aug 30 2026 (append-only section)

Ryder: *"make it extremely easy to transfer everything and make it as few clicks as possible and
also use the exact same rows. so build the admin to be able to receieve this file without asking
any questions, deleteing any data, and filling in all the rows, clients, and filters correctly …
just fill in everything we have a row for and leave out the rest. dont mess with the google sheet
at all."*

And, when asked what a second drop of the same file should do: *"were going to merge everything
into the admin, so the sheet will be irrelevent once we get it built. but he pulls leads from
appollo then dumps them into that sheet so instead hell just dump them into our admin but they
will be dropped in that way."* — so the SHAPE of the drop is permanent, and Apollo's export
columns change with the search. A reader that depends on a heading row being right is a reader
that breaks again next month.

### The number that started it

The importer was taking **36 people out of a file that holds 3,663**, and reporting no error.
Nothing threw. Every count on screen was plausible. It was found by counting what went in against
what is in the file — which is the only check that catches this class of thing.

### Four bugs, all silent

1. **`src/lib/sheet.js` cut every row at its first empty cell.** The row pattern was
   `/<row\b[\s\S]*?(?:\/>|<\/row>)/` — "up to the first `/>` or `</row>`". An empty cell is
   written `<c r="A2" s="7"/>` and that `/>` is the first one inside the row. A short row is a
   valid row, so nothing complained. The Jewelry tab came back as 3 rows instead of 71.
   Fixed with `<row…ATTRS/>` or `<row…ATTRS>…</row>`, where ATTRS matches quoted attribute values
   (`>` is legal unescaped inside one) and an optional namespace prefix (`<x:row>`).

2. **`insertLeadsBatch` threw on every live import.** `const rows = data || []` sat in the same
   block as `rows.slice(i, i + 200)` two lines above — temporal dead zone, first iteration, every
   time. Preview mode returns before it, so every test and every demo passed. The throw surfaced
   in the import screen's catch as **"Could not read that file"**, blaming the spreadsheet, after
   the firms, the list and the batch record had already been written. ESLint does not flag it:
   `no-shadow` is off. **This means no live import has ever inserted a contact.**

3. **`toInt` turned "1.0156E7" into 1.** Excel stores a big round number in scientific notation.
   Stripping everything but digits and dots gave "1.01567". Also `"N/A"` → `0`, and 0/100 is a
   real site score meaning the site failed everything.

4. **A decimal number matched as a hostname.** `[a-z0-9-]+(\.[a-z0-9-]+)+` matches "42.0", and the
   reader hands back every whole number with a ".0". The headcount column read as a website and
   took the field off the real one, on three tabs.

### What the workbook actually is

**3,663 people, 2,764 firms, 7 lead tabs.** Not 451 — that figure in §44 came from the broken
reader. Luxury Agents 820 · Law Firm 993 · Medspas 603 · Real Estate 546 · Car Dealership 544 ·
Dental 87 · Jewelry 70.

**Three tabs disagree with their own heading row and a fourth has none.**

- **Luxury Agents — no heading row at all.** 821 people the old importer skipped on every single
  import, because it read row 1 as headings, recognised nothing, and reported "0 columns could be
  recognised". An unticked tab is not an error, so nobody ever saw it.
- **Jewelry** — three columns in the data the heading does not have, so everything from column 13
  slides. The heading says "Website" over a LinkedIn address and "Annual Revenue" over
  "Los Angeles".
- **Car Dealership** — slides three from column 23, and a second record block is pasted from
  column 45. 84 columns wide.
- Real Estate, Law Firm, Medspas and Dental line up.

### `lib/sheet-columns.js` — the reader

Every column is scored on **what is in it**. The heading is a hint worth **+0.55**, which is less
than the gap between a strong content signal and a weak one — so right data beats a wrong heading,
and a heading still settles what content genuinely cannot (a given name from a surname). Rules
that must not be broken:

1. **A pair with content behind it beats a header-only pair, always.** An empty column with the
   right heading must never beat a full column of the real thing. Sorting on score alone let a
   0.55 empty column beat 0.56 of real firm names.
2. **City, state and country are decided by which ADDRESS RUN they sit in**, never by their own
   values — "Larry Pike" scores as a city otherwise. A street address opens the firm's block,
   every time, because only a firm has one. A run with neither a street address nor a location
   line beside it is a guess, and says so on screen.
3. **The six hand-filled columns can only sit LEFT of the contact's name.** Without this, Jewelry's
   email-verification column — the word "Verified" on all 70 rows — was read as the Sales Owner,
   and the real Sales Owner column lost and was dropped.
4. **First name and last name only ever arrive as a pair**, side by side. A lone first-name column
   with no heading is a column of something else; on a [name, company, town] list it was the town.
5. **A second street address or location line ends the list. A second EMAIL does not** — a work
   address and a personal one is normal, and cutting there threw away six real columns.
6. **When it cannot tell whether row 1 is a heading, it is a PERSON.** The two mistakes do not cost
   the same: a heading read as a person is one junk row anybody can see and delete; a person read
   as a heading is deleted, silently, on every import for ever.
7. **Trust is relative to the tab**: at least 5 values AND at least 2% of the rows. Three emails in
   900 rows is a typo; three in a three-row paste is the column.
8. **`site_score` is never written from a spreadsheet**, on insert or update. A number we measured
   and a number out of a cell must never share a field.

### One click, and nothing deleted

Four screens became one. Pick the file and it goes. Everything the reader had to decide is printed
on the RESULT screen instead — including, column by column in plain words, every heading that
disagreed with its own data.

`mergeLead` / `mergeCompany` in `lib/sales-import.js` handle anybody already on file. An empty cell
never blanks a value. A stage never moves backwards and a closed deal never reopens. A claimed lead
is never taken off its rep. First contact keeps the earliest date, last touch the latest. A typed
next step is kept and the sheet's version goes on the timeline instead of being thrown away.

**And the match has a KIND.** `dedupeKey` falls back email → phone → website → company+city, and
colleagues share the last three (migration 0006 says so in as many words). On anything weaker than
an email match the fields that say who somebody IS are left alone — otherwise three agents at one
brokerage take turns overwriting each other's name and the timeline says "name updated".

**Start over cannot undo a row that was FILLED IN.** It deletes by import batch and somebody
already on file belongs to no batch. That was true by construction while the importer skipped
existing people; the merge made it false. The result screen now says so.

### Migration 0025 — five columns the sheet had and the console did not

`admin_leads.address`, `admin_leads.country`, `admin_companies.alias`, `.keywords`,
`.total_funding`. Additive only, `add column if not exists`, nothing dropped or renamed. Each was
being read off the sheet and thrown away on every import. **If 0025 has not been run the import
still works** — `probeSheetColumns` asks once, those five fields are left out, and the screen says
which and why. A missing migration costs five columns, not the run.

### Proof (Aug 30 2026)

lint 0 across `lib src api tests` · build clean at 157 modules · `tests/sheet-columns` **52 checks**
pinning all 200 columns of the seven real tabs plus every rule above and all four bugs · every
other suite unchanged (sales 110, sales-sheet 139, floor-scoping 231, ai-cost 324, lead-tags 220,
outreach-stats 177, and the rest).

**The real workbook driven through the built bundle, twice.** First run: 3,663 people, 2,764 firms,
8 seconds, one click. Second run, the same file on top of itself: **5 added, 0 new firms, 3,658
unchanged, 0 deleted.**

**Two adversarial agents found 26 defects in this work**, all fixed — including the result screen
printing "Every column matched its heading" on the three tabs where it did not, because the
reader's notes were computed and then thrown away; and a test that asserted `undefined ===
undefined` and proved nothing while the path it claimed to guard was wide open.

### The five lessons

1. **Count what went in against what is in the source.** Four bugs, no exception, every number on
   screen plausible.
2. **A comment that describes behaviour the code does not have is worse than no comment.** A
   checker found six.
3. **Write the test against the behaviour you want, not the behaviour you have.** One of mine
   asserted the wrong thing and would have forced the wrong fix into the code it was checking.
4. **Delete each rule on purpose and see whether a test notices.** Six rules with named, specific
   justifications had no test at all.
5. **When two mistakes are not equally expensive, pick the cheap one deliberately, and write down
   why.** That is the whole argument for reading row 1 as a person.

### Blocked until

1. Run `0025_sheet_columns.sql` in Supabase.
2. Deploy.


## §50. THE 1,000-ROW CEILING, A LOST GRANT, AND THE SALES PAGE SIMPLIFIED — Sun Aug 30 2026 (append-only section)

Three separate things, same day, all on the Sales side. §49 is the sheet importer; this is
everything after it.

### 1. Supabase answers ONE request with at most 1,000 rows, and says nothing

Ryder, reading the screen: *"this says 999 leads, when i think we have 3000+."* He was right.

The giveaway was in the tab counts: Medspas 299 · Car Dealership 544 · Jewelry 70 · Dental 87 —
**exactly 1,000**, and exactly the four tabs imported last. Sorted newest-first, stopped after one
page, so Luxury Agents, Real Estate and Law Firm all read **0**.

**Five readers had a warning for this and none of them could fire.** Each did:

```js
selectAll("admin_leads", { limit: LEAD_FETCH_CAP + 1 })   // asks for 2001
if (rows.length > LEAD_FETCH_CAP) { …warn we capped… }    // fires above 2000
```

The server capped the answer at 1,000. `1000 > 2000` is never true, so five carefully worded
sentences about missing data were unreachable code.

| reader | claimed cap | actually got | what it cost |
|---|---|---|---|
| `listLeads` | 2,000 | 1,000 | the Sales page showed 1,000 of 3,663 |
| **`listCompanies`** | 2,000 | 1,000 | **the sheet importer's duplicate check** |
| `listAllLeadActivity` | 4,000 | 1,000 | the cadence counts touches from these |
| `listLeadTagState` | 12,000 | 1,000 | tags, and the tag filters' counts |
| `listCompanyReports` | 2,000 | 1,000 | the Firms tab's scan history |

**`listCompanies` was the expensive one.** It is how the importer decides which firms it already
has. With 2,761 firms on file it could see 1,000, so the next drop of the sheet would have made a
second copy of the other 1,761 and reported them as new. Caught the same day, before that import
ran.

**The fix: `lib/paging.js#fetchPaged`.** Pages of 1,000 via `.range()` until a short page comes
back, and REPORTS its ceiling rather than silently applying it. `selectAll` pages automatically for
any `limit > 1000`, so every future caller is covered without having to remember.

**ORDER ON THE COLUMN AND THEN ON `id`.** `created_at` is not unique — one import statement writes
two hundred rows sharing a timestamp — and Postgres gives no stable order inside a tie across two
range queries. Without the tiebreak, page 2 hands back rows page 1 already had while others never
come back. That trades a visible undercount for an invisible, non-repeatable one, which is worse.

Also: `companies` was missing from the Sales board's `truncated` list, so the one cap that mattered
most was the one the page could not have told you about. Added.

**Proved end to end**, not just unit-tested: a live Postgres with 3,663 rows (200 sharing a
timestamp), behind a server enforcing max-rows=1000, driven by the real `@supabase/supabase-js`:

```
ONE REQUEST asking for 50,000 : 1000 rows   <- what the Sales page was doing
PAGED reader                  : 3663 rows
unique ids                    : 3663 (no repeats)
rows missing                  : none
```

`tests/paging` — 11 checks. Mutation-checked: remove the `id` tiebreak and one fails; stop after
one page and seven fail.

**The rule: never write `.limit(n)` where n > 1000.** And a round number on a screen is a bug until
proved otherwise.

### 2. A lost GRANT has now broken two pages in two days

Start over returned `permission denied for function admin_clear_import`. Every function the console
calls has a `grant execute … to authenticated` line in the migration that created it — all eleven
checked, all present. **The files are right and the database is not.**

The wording of the error is the whole diagnosis:

| the error says | it means |
|---|---|
| `permission denied for function X` | the function EXISTS, the grant is missing |
| `Could not find the function … in the schema cache` | the function does not exist, or the argument names/types do not match the call |
| the function's own message ("only an owner or admin") | the grant is fine; the internal check refused |

Aug 29 it was `admin_is_member` and the whole console said "you're not on the team".

**`0026_grants_repair.sql`** re-asserts the grant on all eleven, prints a `can_execute` table, and
is guarded with `to_regprocedure` so a function that does not exist is SKIPPED and NAMED rather
than throwing — which is the most likely way the original grants were lost. It only grants: no
revoke, no drop, no table touched, safe to re-run. Tested on a real Postgres: 11 of 11 flipped from
denied to allowed, a second run a clean no-op.

**A migration file being correct is not evidence that the database matches it.** Ask the database.

### 3. The Sales page, simplified — and Stats got a page

*"everything seems really complex and jumbled, i want to simplify it all."* Seven bands of chrome
above the first row of data became four.

`summary → one row of controls → list tabs → table`

- **Six tiles off the sheet.** They stay on My Day; the team's version of all six is on Stats.
- **One control row**: view tabs · search · stage · owner · `⋯` · Add a contact. `⋯` holds Stats,
  Where leads come from, Import a sheet, Start over.
- **Fourteen filter dropdowns became two**: `Type of business` (pinned — his ask) and `Filters · N`,
  which counts COLUMNS not values and clears them all.
- The SAMPLE/LIVE badge moved beside the numbers it describes.

Four things not to break:

1. **A pressed tile becomes a chip on the toolbar.** A filter that is ON with no control on screen
   is one nobody can find or turn off. The chip calls `pressTile` again — one act, one function.
2. **The Filters panel is ONE popover with two levels.** A popover opened from inside another
   closes itself instantly: the outer closes on any outside click and the inner button is one.
3. **`.adm-sl-search` is `flex: 1 1 0`.** Flex wraps from the BASIS, before grow. At `1 1 220px`
   the row ran over and the actions wrapped.
4. **`PINNED_FILTERS`** in salesSheet.jsx is the list that stays out on the bar.

**`src/components/admin/SalesStats.jsx`** — sidebar `["sales", "Sales", [["sales-stats", "Stats"]]]`,
a child using the Finance → Invoices mechanism. Owner/admin only, and the menu is not the gate:
AdminDashboard refuses to route to an id the role's list does not carry, and `tests/sales` asserts
a rep cannot open it.

**NOT ONE NUMBER ON IT IS NEW.** Same `repStats` / `outreachByRep` / `lossReasons`, same
`getSalesBoard()` read. **`RepNumbersModal` is DELETED** — two screens working the same answer out
twice is how they come to disagree. The team line is counted over every lead rather than by summing
the reps, because 3,650 of 3,663 have no owner and a deal won-then-released has none either.

### Proof for all three

lint 0 across `lib src api tests` · build clean · **2,102 checks across 21 suites, all passing**
(`tests/auth-gate` and `tests/inbox` do not run on the Mac bridge — playwright missing and a bad
relative import; both predate this work) · the sheet, the Filters panel, the `⋯` menu and Stats all
driven in a browser with the order read off the live DOM, and the control row measured at one line.

Measuring a flex row by each child's `top` reports the wrong number of lines —
`align-items: center` gives items of different heights different tops on the same line. Group by
vertical centre, or read the container height.

### Blocked until

1. `0026_grants_repair.sql` run in Supabase (0025 is already run). Clicks in SETUP.md.
2. Deployed. Nothing in §49 or §50 is pushed.

---

## §51. STATS BY REP, AND THE SHEET AS A ONE-CLICK WORKFLOW — Sun Aug 30 2026, evening (append-only section)

Two builds in one evening, both on the Sales side, both **built and NOT deployed**.
Read this before touching `SalesStats.jsx`, `salesSheet.jsx`, `SalesPage.jsx`'s
`PipelineView`, or either of the two new pure modules.

### 51.1 Stats · By rep is a bar chart with filter chips

> *"i want it to be more like bar graphs for each rep with filters at the top to click to
> show different stats to see who performed the best."*

**13 chips in one band above the chart**, grouped Results / Effort / Watch, then one
horizontal bar per rep sorted best-first with a `BEST` chip on the leader. The full
table stays underneath as the chart's plain-text twin.

`lib/rep-metrics.js` (pure) is the metric list and the ranking. `tests/rep-metrics`
is 45 checks.

**Four rules it enforces.**

1. **No per-rep number is new.** Every `read()` pulls a field `repStats` or
   `outreachFor` already produced, from the one `getSalesBoard()` the page already ran.
   The one thing counted on the page is the TEAM line, over every lead — it has to be,
   because 3,650 of 3,663 contacts have no owner and summing the reps would give a
   fraction of the truth.
2. **Three stats are lower-is-better** — Speed to first touch, At risk, Lost — and sort
   ascending. One sort direction for everything puts the slowest rep at the top of a
   leaderboard.
3. **A raw count with no denominator is not a performance.** `crown: false` on **Lost**,
   **At risk** and **Open right now**. A rep who claimed nothing has lost nothing and
   holds nothing at risk, so the smallest-number rule was putting a BEST chip on the
   person who did the least work. Those three draw a bar and a number, name no winner,
   and print the book the number came out of ("of 200 they have claimed"). Close rate is
   the version of that question with a denominator, and it is still winnable.
4. **Null is not zero.** An unreadable number is held out of the ranking, sorted to the
   bottom, never crowned.

**Who may be crowned:** the metric must be crownable, at least two reps measured, and —
on a more-is-better stat — a winning value above zero. On a fewer-is-better stat zero
DOES win. Ties all carry the mark.

**Six defects a separate adversarial checker found, all fixed:**

- **The page could not tell you a read had FAILED.** `getSalesBoard()` does not reject —
  `src/lib/data.js` turns every reader's failure into `{rows: [], error}` and records it
  in `errors` / `failed`. So a broken read rendered "Contacted 0 · Won 0", said *"that is
  an empty list, not a missing one"*, signed off *"every figure here is counted from real
  rows"*, and ranked the reps anyway. **Any page that reads the board needs the
  `errors` + `truncated` banner pair** SalesPage and repOverview have carried since
  Aug 27. This page shipped without them.
- **The null-is-not-zero contract was unreachable here** because the page passed `[]`
  either way. It passes `null` per failed reader now, off `board.failed`.
- Lost / At risk / Open crowning the wrong person — see rule 3.
- **The heading said "all time"** when `PERIOD_ALL` means every row the page managed to
  READ. It says "over everything loaded", and `periodWords` has no silent default.
- **Three of the 34 tests could not fail.** One assertion was `!A || B` with `B`
  unconditionally true; the chips test grepped the file for `<button` and `aria-pressed`
  separately; the mutation test only re-checked an input array's order, which `.map()`
  cannot change.
- Chip group headings unassociated, chip meaning only in a hover `title`, and a row `key`
  that fell back to a display name.

Two more were found by **loading the page**: *"only no reps have this number"* (three
states, two sentences) and calling every unmeasured row *"a number this page could not
read"* when a rate is also null with nothing sent.

Also: `_to_delete` is in `eslint.config.js`'s ignores now — an untracked deliberately
broken file from Aug 26 was making `npm run lint` fail for the whole repo.

### 51.2 The sheet: click a row to open, click a chip to move

> *"a normal row that when you click anything that isnt a tag it opens the client card …
> one click movement through the pipeline … i dont want to be able to add tags … in the
> pipeline i want to be able to drag the client over into new pipes … when you scroll
> down i still need to be able to see the title of the row … make sure the rows on the
> end dont get cut off"*

And, on what "the tags" are: *"any collumn that has pre set lead stage like contacted or
won or lost … we have friggin 3000+ leads, we need to be able to do this at scale."*

**Two kinds of thing on a row, and they must keep looking like two kinds of thing.**

- **Reading cells** — plain `<span>`s, so the click passes up to the `<tr>`, which opens
  the client card. Name, title, email, phone, city, the next step, the dates, the firm.
- **The Sales Cycle Status chip and the List chip** — the only inline controls left.
  One click writes the move; the optional note comes **after**, and walking away from it
  loses nothing. That order is the whole design.
- **The Pipeline board takes drags.** The column lights while a card is over it, the drop
  writes the stage, the same note box follows.

`lib/stage-move.js` (pure) holds the rules all three screens ask. `tests/stage-move` is
29 checks.

**Five rules not to break.**

1. **All three screens ask `lib/stage-move.js`** — chip, drop target, card dropdown.
2. **The board writes through `patchLead`, never its own `upsertLead`.** Otherwise a lead
   dragged onto Won would not create a client record and nobody would notice for a month.
   A test asserts the board calls neither `upsertLead` nor `addLeadActivity`.
3. **Won and Lost skip the note box** and open the reason box from Aug 27 — that box IS
   the note. `patchLead` returns **false** for them now (it used to return undefined), so
   the picker cannot say "moved, add a note?" about a move that has not happened.
4. **No way to invent a status or a tag.** The picker renders a fixed list, has no text
   input anywhere, and says *"This list is fixed"* on itself. The Tags column is
   display-only — most of those come from rules in `lib/sales-rules.js`.
5. **Nothing became uneditable.** Everything that left the row is on the card, which is
   one click from anywhere on the row. A test asserts `TextCell`, `PopoutCell`,
   `PersonCell` and `SelectCell` are all gone from the sheet.

**Three traps, all of which were real bugs:**

- **A React event bubbles through the REACT tree, not the DOM one.** With the row
  clickable, a click on an option inside the popover reached the `<tr>` underneath and
  opened the client card on top of the menu — every single time. Both popovers stop their
  own `onClick` **and** `onMouseDown`.
- **A sticky `<th>` sticks to its nearest SCROLLING ancestor.** `.adm-db-scroll` has
  always had `overflow-x: auto`, which makes it that ancestor in both directions, so a
  header stuck to the page stuck to nothing. It is a bounded scroll box now
  (`max-height: calc(100vh - 330px)`) — which is also what stops 3,663 rows pushing the
  toolbar off the top of the screen.
- **`table-layout: fixed` reads the COLGROUP and ignores the `<th>`.** The Do column was
  `46` in the colgroup and `210` in its header, so Claim / Email / ⋯ / ⤢ were cut off the
  right edge of every row. One constant, `DO_COLUMN_WIDTH`.

Plus: flexbox shrank the chip to fit its own help text — "In conversation" rendered as
"In conversa" until it got `flex: 0 0 auto`.

**The strip above the table.** *"remove this text"* — the `N PEOPLE · Contacted? and
Touches count the last 90 days` line is gone. Both halves duplicated something already on
screen. The **window fact moved onto the two column headings it is about** as their
tooltip; `WINDOWED_COLUMNS` in `salesSheet.jsx` is the list. `.adm-sh-count` and
`.adm-sh-window` were deleted from `admin.css` with the markup.

### 51.3 Spacing

`.dash-content` 28/36/56 → **40/48/80** and `.dash-header` 28/36/24 → **34/48/26**, set in
`admin.css` (not `index.css`, which is the platform's design system copied in verbatim).
Applied console-wide, because a page whose cards start 48px from the edge next to one
whose cards start 36px reads as a broken layout. **Side padding is the risky one** —
every pixel is taken off the Sales sheet and the Operations table, both of which wrap
their controls when they run out. Re-measured after: `.adm-sl-bar` is 67px, still one
line, at 1470px. Stats also got a scoped roomier block (`.adm-st-page`), deliberately not
shared with the sheet: the sheet is a screen somebody works, tight rows are the point
there.

### 51.4 Two ways a browser check lied this session

- **`navigate` to a URL whose hash is already current does not reload a hash-router SPA.**
  React state survives, and a drawer left open by the previous test looked exactly like a
  bug the change had caused. Use `location.reload()`.
- **An unloaded page passes every "is it gone?" assertion.** Wait for a real element
  before asserting absence.

### 51.5 Proof

`npx eslint .` exits 0 · stage-move 29 · rep-metrics 45 · sales 112 · sales-sheet 139 ·
lead-tags 220 · floor-scoping 231 · outreach-stats 177 · rep-brief 57 · rep-report 54 ·
overview 44 · brain 78 — all passing, 0 failing.

Driven in Chrome on the live 3,663-contact pipeline: sticky header measured at the same
`top` after a 1,200px scroll; the Do cell's right edge equal to the scroll box's; a **real
stage move written and read back off the timeline** (Dana Del'marmol, restored afterwards);
a **real drag** (Deborah Howell New → Researching → New); bar widths read out of the DOM on
the Stats chart; and the removed strip text absent from a fully loaded page.

### Blocked until

1. Deployed. Nothing in §49, §50 or §51 is pushed.
2. `0026_grants_repair.sql` still needs running in Supabase (0025 is already run).


## §52. THE FLOOR STOPS SHOWING ANOTHER REP'S LEADS — Sun Aug 30 2026, evening (append-only section)

**Ryder, in his own words:** *"first is the floor needs to be synced with both rep and owner and
admin. they should all have the same lead list and display all the same stuff. same with if any
or claimed that needs to be seen everywhere. but on the reps page if something becomes claimed by
someone else then it gets removed from the floor and the rep doesnt see those leads, only the
claimed rep and the owner/admin see it. that way the reps never comingle."*

**This reverses §45.3.** Read §45 first, then this.

### What is true now

| Who | Sees |
|---|---|
| Sales rep | The leads they hold **plus** every unclaimed lead. Nothing else. |
| Owner / admin | Every lead. Unchanged. |

The narrowing is `visibleToMember()` at the bottom of `src/lib/salesSheet.js`, applied in exactly
ONE place — `scopeLeads` in `SalesPage.jsx`, before any filter runs. A tile, tab, dropdown, search
box or `?lead=<id>` address cannot widen it; the deep-link guard, the `?lead=` pre-check and the
drawer all read that same set.

### The firm collision the old rule was protecting did NOT get dropped

§45.3 showed a rep every row precisely so two reps could not work one firm. That requirement moved
rather than went away: `firmsHeldByOthers()` works out — **from the whole board, before the
narrowing** — which firms somebody else has an OPEN claim at, and the sheet's firm cell puts a ⚠
on those rows. **It names nobody.** A rep is told a firm is taken; who is in it is the thing that
was just hidden.

Open stages only, the same filter `contestedCompanies` and `companyClaimWarning` already use — a
contact somebody marked Lost in March must not mark that firm busy for ever.

### The two pages now show the same things

- The rep's Floor has the same four views as the owner's: My Day · The sheet · Pipeline · Firms.
- The Mine / Available / All switch stays, alongside them. **"All" now means yours plus unclaimed**
  — the whole of what a rep may work — and the page **opens on All**, not Mine. Opening on Mine put
  a rep who holds nothing in front of an empty table with every list tab reading 0, over a page
  whose own subtitle said it held thousands. That is the screen Ryder was looking at.
- Four tiles came back on the Floor (owed · at risk · meetings + proposals · won). The two that
  duplicate the availability switch stay off.

### THE AI WAS A SECOND DOOR, AND IT WAS STANDING OPEN

Found by an adversarial checker on the same day, and this is the finding worth remembering:
**hiding rows on a page is not hiding rows.** A rep could open **AI Brain** and ask "which leads
are going cold" — and `lib/brain-context.js` handed the model every other rep's open leads *with
the holder's name on each line*, while the panel's own caption said "Reads your leads, your firms
and your own follow-ups. Nothing else." `lib/assistant-tools.js`'s `search` tool was a second way
to the same rows.

Both files run on the **service role**, which ignores row-level security, so the code IS the guard.
The same rule is now written in three places, and each one names the other two:

| File | What it guards |
|---|---|
| `src/lib/salesSheet.js` → `visibleToMember()` | the Sales page |
| `lib/brain-context.js` → `repLeadFilter` | the AI's context block (both lead reads, plus the lead activity, pruned to what came back) |
| `lib/assistant-tools.js` → the `search` case | the AI's own lookups |

**Change one and change all three.** `tests/floor-scoping` asserts that they point at each other.

### Enforcement is SCREEN-ONLY, on purpose, and it is written down as a gap

Ryder's call, asked and answered on 30 Aug. The read policy on `admin_leads` is still wide (0001,
untouched by 0020), so a rep's browser can still fetch another rep's row by hand. `0020_rep_scoping.sql`
got a **comment-only** update saying so — no SQL changed, still safe to re-run. If it should become
real: a NEW migration with
`select ... using (public.admin_is_admin() or owner_id = auth.uid() or owner_id is null)`, never an
edit to 0020.

### Twelve defects a separate checker found in the first draft

Worth listing, because most were the change being *incomplete* rather than wrong:

1. **The AI leak above** — the whole feature, walked around.
2. `firmsHeldByOthers` ignored stage, so a Lost contact marked a firm busy for ever — and the
   drawer, which does filter, showed nothing on the same firm on the same click.
3. The sheet's firm headcount still counted the board: *"We hold 4 people at this firm — group the
   table by Company to see them together"*, over a firm with one visible row.
4. The firm popover told a rep *"their contacts are not on your floor"* about a list that included
   the reader.
5. The Floor's hint still promised greyed read-only rows — **and a test asserted it**, so fixing the
   sentence broke the build.
6. The four restored tiles counted through the availability switch; the list under them did not.
7. My Day ignored the switch above it and offered "Free to claim" cards while it said Mine.
8. The Firms view said *"Working it: nobody"* about a firm the sheet marked ⚠.
9. `emptyNote` told a rep with a fully-claimed book that no contacts had been imported — over 3,663 rows.
10. Eleven stale comments still asserting the Aug 27 rule, in five files.
11. Dead code the change orphaned, incl. `heldByLabel` printing **"Held by another rep"** on an
    *unclaimed* row.
12. `ownerFilter` seeded to `undefined` on a locked page (`lock.owner` has not existed since Aug 27),
    which made `canClear` permanently true and made the "Nothing open here right now" empty screen
    unreachable; and `MODES[mode] || MODES.mine` falling back to `undefined` — i.e. **unlocked** —
    because there is no `mine` mode any more.

### The rules this one is worth remembering for

- **Hiding a record on one screen is not hiding the record.** Count the doors: a page, an AI context
  block, a tool the AI can call, an endpoint, a report. The service role opens all of them.
- **A test can pin the wrong behaviour in place.** `tests/sales` asserted the word "read-only" in a
  hint describing rows that can no longer exist. Rewrite it against the behaviour you want.
- **When you reverse a rule, the reason the old rule existed does not go away.** Move it, or say out
  loud that you dropped it. Here it moved onto the firm.
- **A comment that survives a reversal will reverse the reversal.** Eleven of them.

### Proof

Lint clean across `lib src api tests`. **2,136 checks in 22 suites, all passing** — `floor-scoping`
is 291 (was 231) and `sales` 112. `auth-gate` and `inbox` still do not run on the Mac bridge; both
predate this work. Files touched: `src/lib/salesSheet.js`, `src/components/admin/SalesPage.jsx`,
`salesSheet.jsx`, `salesProfile.jsx`, `lib/brain-context.js`, `lib/assistant-tools.js`,
`tests/floor-scoping`, `tests/sales`, `supabase/migrations/0020_rep_scoping.sql` (comments only).

### Blocked until

1. Deployed. Nothing in §49-§52 is pushed.
2. `0026_grants_repair.sql` still needs running in Supabase (0025 is already run).
3. **The rep's own screen has not been driven end to end.** The owner's Sales page was verified live
   in a browser after this change (sheet, tabs, Firms view, 3,657 people at 2,765 firms). The rep
   view needs a `VITE_NO_SIGNIN=true` run and the Sales-rep card on the picker — see
   §52 in the work log for the four steps.


## §53. TWO CLICKS ON THE CONTACTED? CELL LOGS THE TOUCH — Sun 30 Aug 2026, evening (append-only)

**Ryder:** *"when you click contacted i want a popup with the available options that you went
through and the questions required very simply so its a couple clicks and all the data is there.
similar to sales cycle status"*

### The shape

| Click | What |
|---|---|
| 1 | Called · Emailed · LinkedIn · Texted |
| 2 | the outcomes for THAT channel — and this is where the write happens |
| 3 | an optional note, skippable, on a touch that is already saved |

Two levels because a call can go six ways and an email cannot go any of them. One flat list has to
ask every channel the same question, which is how the drawer's Log box ended up defaulting every
email to **"Talked to them"** — every email logged through it carries an outcome describing a phone
call.

`lib/touch-log.js` is the pure half (the menu, and what a pick MEANS). `logTouch()` in
`src/lib/data.js` is the write. `src/components/admin/touchPicker.jsx` draws it.
`tests/touch-log` attacks it — 58 checks.

### THE CELL'S VALUE IS STILL DERIVED

Nothing writes a "contacted" field, because there is none. `contactedState` counts the timeline.
That is the entire reason the column can be trusted — in the outreach sheet it was a dropdown
saying the same thing as Sales Cycle Status, reps filled one or the other, and neither could be
believed. Clicking it logs a real touch; the chip follows.

### AN INBOUND EVENT IS WRITTEN AS A NOTE — read this before adding an outcome

`admin_lead_activity_touch()` (0009) fires on every row of type `call`/`email`/`text`/`linkedin`
and sets `last_touch_at`, `first_contact_at` and `claim_contacted_at`. **It cannot tell direction**
— 0009 says so and calls it an honest limit.

So "they replied" logged as type `email` tells the database WE reached out: cold timer reset,
cadence advanced, `first_contact_at` possibly stamped by a message the prospect sent. Twenty
replies, twenty reset timers.

Every `inbound: true` outcome is therefore written as type **`note`**, the one type that trigger
ignores. The meaning lives in the stamps and the timeline wording. No migration, and nothing in
this console reads activity direction.

### WHAT THIS FIXED THAT NOBODY ASKED ABOUT

**Nothing had ever written `first_reply_at` or `bounced_at`.** Both have existed since 0021 and the
Stats page computes reply rate and time-to-reply from them, so every reply figure the console has
shown could only read zero or null. This control fills them. `stampIfEmpty` writes each one once
and never overwrites — and it is a `== null` check, not a truthiness check, because an empty string
is falsy and would get stamped with today's date over a send from May.

Marking a reply also **unlocks the single text**: `textGate` refuses every text until
`first_reply_at` is set.

### The order of the five writes IS the design

1. **The text counter first** (`claimTextSend`) — a single statement, so two tabs cannot both send.
   Failing here logs nothing, which is recoverable.
2. **The claim**, and only for an outbound touch on an unclaimed lead, with `expectUnclaimed` so
   the query decides. Lost race → stop; a rep who cannot hold the lead cannot write its activity
   (0020) either. **It never re-claims**, so logging a touch can never move a firm between reps.
3. **The timeline row.** 4. **The first-* stamps.** 5. The console feed.

**Nothing moves the Sales Cycle Status.** Ryder's call: the status is a thing the rep decides, not
a thing the system infers from a voicemail.

### A bug caught before it shipped, worth remembering

The note step first re-called the write with `(channel, outcome, note)` — the shape `ChipPicker`
uses, where it is harmless because setting a stage twice is setting it once. **Two touches are two
touches.** `onNote` now takes the text only, so the call site *cannot* re-log.

### A test that pinned a number, and the fix

`tests/sales` asserted the "Somebody got there first" toast appeared **exactly twice**. A third
claim path broke it while being correct. It now counts the toasts against the `if (res.taken)`
branches — a count of one thing against another keeps meaning what it was written to mean; a count
of the code has to be edited every time the code is right.

### Proof

Driven live in a browser on the real 3,663-row pipeline: menu → Called → Left a voicemail → toast
"Logged · claimed for you" → row moved into the owner's group, Contacted? No→Yes, Claim → Being
worked, first contact and last touch stamped, header counts moved, **Sales Cycle Status stayed
New**, drawer cadence read "1 of 5 logged", timeline showed both rows. Written to one junk `Schmo`
test row on purpose; not released afterwards, because undoing it writes a second timeline line.

Lint clean. **2,294 checks in 23 suites.** Nothing committed, nothing deployed.

### Open

- A reply does not pause the cadence. `last_touch_at` still means "when did WE last touch them",
  which is correct, but a lead that has written back still reads as owed a touch. A decision, not a
  bug.
- A FIFTH channel needs a migration — `admin_lead_activity.type` is a check constraint (0018).
  `outcome` is free text, so new outcomes do not.


## §54. THE PIPELINE REBUILT TO THE SPEC — Sun 30 Aug 2026, late (append-only section)

**Ryder:** *"build that into the sales on all sales on both admin owner and the actual rep page."*

Owner and rep are one component, so this lands on both. Read §52 and §53 first.

### The rule the whole thing runs on

**If the system can work it out, the rep is never asked.** A rep answers three questions and no
others: *what did you do*, *how did it go*, *what's next*.

### What is now true

| | |
|---|---|
| Stages a person can pick | **7** (was 12). Follow up · Meeting · Proposal · Won · Lost · the two Not-a-fit reasons |
| Stages the system derives | New · Researching · Contacted · In conversation · Reopened — **settable nowhere** |
| A reply | Stops the cadence, and is the top card in My Day until answered |
| A bounce | Stops the cadence and refuses the email option |
| Every touch | Ends with "and next?" — a date on `next_follow_up_at` |
| The safety net | Three saved filters: `no_next`, `quiet`, `stuck` (owners only) |
| The gate | Follow up + Meeting need a FUTURE date; Proposal needs a proposal with an amount |

`lib/sales-rules.js` holds the rules (`CADENCE_STOPS`, `canEmail`, `answeredAfterReply`,
`LEAD_LISTS`/`onLeadList`/`leadListCounts`). `src/lib/data.js` holds `PICKABLE_STAGES`,
`DERIVED_STAGES`, `STAGE_REQUIRES`, `stageRequirementMet`. `lib/stage-move.js` holds
`WORKING_COLUMN` and `PARKED_COLUMN`. `tests/pipeline-spec` attacks all of it — 96 checks.

### RESTRICTING ONE CONTROL IS NOT RESTRICTING THE ACT

The single most useful thing from this build. I cut the sheet's stage picker to seven. A checker
found **three more doors open within the hour**:

- the drawer's `<select>` still offered all twelve AND wrote through its own `upsertLead`, skipping
  the gate entirely;
- two buttons in that drawer set Meeting and Follow up — the exact two stages that need a date —
  with no date;
- `lib/assistant-tools.js` kept its own hardcoded stage list, so "move Acme to contacted" in AI
  Brain still worked.

Every stage write now goes through `patchLead`. The drawer is handed `onStage`, which is that
function. The assistant's list is a hand-kept copy it cannot import, and `tests/pipeline-spec`
reads both out of source and fails if they drift.

**Same lesson as §52's AI leak, in a different shape: count the writers, not the screens.**

### A TIMESTAMP CAPTURED BEFORE A WRITE IS NOT THE TIMESTAMP OF THAT WRITE

The flagship feature was dead on arrival and every test passed. `logTouch` took `now` at the top;
the trigger (0009) then stamped `last_activity_at` from the activity row's own, later,
`created_at`. `answeredAfterReply` compares the two — so it was true the instant a reply was
logged, and the "They replied" card could never appear from the control built to feed it. The
drawer meanwhile DID show it, so two screens disagreed about one lead.

Stamps now come from `act.row.created_at`, making them equal, and the comparison is a strict `>`.

### KNOWING A STAGE IS NOT WRITING ONE

`not_a_fit` is in `LEAD_STAGES` and `CLOSED_STAGES` **before migration 0027 creates it**, and
deliberately: without that, every lead 0027 merges would come back as an OPEN stage the moment it
ran — back on the cadence, back in My Day, back in every count, with no label. It is kept out of
`PICKABLE_STAGES`, so nothing can write it until the constraint accepts it.

The migration's first draft said "nothing breaks when it runs". It was wrong, and a checker caught
the comment, not the code.

### Migration 0027 — WRITTEN, NOT RUN

Merges `skip_90` + `bad_contact` into `not_a_fit` (recording the old value on each lead's timeline
first), retires 20 derived tags to `active = false`, and adds the four human ones: **Gatekeeper ·
Wrong person · Competitor already in · Call back later**. Deletes nothing. Safe to re-run.

**Known failure mode:** the timeline insert needs a non-null actor and falls back to the first
active owner. On a database with an unclaimed `skip_90` lead and no active owner row it aborts.
Check `select count(*) from admin_users where role='owner' and active` before running it.

### The other seventeen findings

Chip counts came from a different set than the list behind them · My Day was the one view the watch
filter did not reach · the gate accepted a date in the past while the "No next step" list correctly
treated one as no plan · `api/sales-score.js` still parked on the stage list `salesQueue` abandoned
the same day, so a website scan could Skip a live conversation · `canEmail` had one caller, its own
test · the date presets used the browser's timezone while every rule counts in Chicago ·
`WORKING_COLUMN`'s comment claimed to fix three invisible stages and fixed one (hence
`PARKED_COLUMN`) · and six stale comments.

**One finding was wrong**, and checking beat accepting: a rep's own never-contacted expired claim
DOES appear on `no_next`. Verified by running it, not by reading it.

### Proof

Lint clean. **2,394 checks in 24 suites.** Driven live as owner on the real pipeline: the chips and
their counts, the list filtering to exactly the right leads, the gate refusing with the fix named,
a full touch → "and next?" → "Booked — Wednesday, Sep 2" → chip 3 → 2 and the lead leaving the list
live, and the rebuilt board. The chips-invisible-on-Pipeline bug was found by clicking, not by a
test — there is a test for it now.

**The rep Floor is still not driven.** Same blocker as §52: live keys, no sales-role account. Same
component, same paths; `stuck` is hidden from reps by `isAdmin` and the suite asserts it.

### Blocked until

1. Deployed. Nothing from §49-§55 is pushed.
2. ~~0026 and 0027 both need running.~~ **Both were run on 31 Aug 2026 — see §55.** 0025, 0026 and
   0027 are all in.
3. The rep view needs one `VITE_NO_SIGNIN=true` run — four steps at the bottom of the §52 work log.
\n

## §55. THE EMAIL DRAFTER, AND SENDING ONE LOGS IT — Mon 31 Aug 2026 (append-only section)

**Ryder:** *"add a row for email that drafts up an email based on stage, notes, timeline and
everything else thats known about the client."* Then: *"i want to make sure that when i send a draft
that was made for me that it marks them as contacted by email with the date and notes, then the rep
just clicks the follow up date."*

Also: **"i ran both migrations."**

### 0025, 0026 AND 0027 ARE ALL RUN

Confirmed on the live board. The stage picker offers **six** — Follow up · Meeting · Proposal · Won ·
Lost · **Not a fit**. `PICKABLE_STAGES` is those six; the two-reason workaround labels are gone;
`lib/assistant-tools.js`'s hand-kept copy matches.

`skip_90` and `bad_contact` stay in `LEAD_STAGES` and `CLOSED_STAGES` deliberately. 0027 rewrote
every row, but a value that sat in the database for a week can still surface in an old timeline line
or a backup, and reading one must not produce a blank label. **Known, not offered** — the same rule
`not_a_fit` was added under the day before the migration ran.

### The column

`draft_email`, on by default. It asks the server to write the next email to that person from their
stage, notes, timeline, tags, proposals and the newest scan of their site, and opens it in a panel.

| | |
|---|---|
| `lib/lead-email.js` | pure — the job per stage, the fact sheet, the instruction, the gate, the fallback |
| `api/lead-email.js` | reads the facts server-side, shows the model that and nothing else |
| `src/components/admin/emailDraft.jsx` | the panel, with a disclosure showing what it was written from |
| `tests/lead-email` | 93 checks |

**The job comes from the TIMELINE, not the stage.** The four early stages stopped being settable on
30 Aug, so a lead worked for a month still reads `new`. `first_contact_at` — written by a trigger
from a real logged touch — is what tells a first email from a follow-up.

### IT DRAFTS. IT NEVER SENDS.

No send path in the endpoint, no send button in the panel, and **both say so where somebody would
look to add one**. The console has had that rule since Aug 24 about the Gmail button; this is the
same rule about a new door. A model wrote the text and a person has to read it before it reaches a
prospect with our name on it.

A **bounced address is refused** before any work is done — `canEmail`, the same rule the Contacted?
picker reads. The cell shows "bounced" with the date instead of a button.

### THE GATE IS STRICTER THAN THE REPORT GATES, ON PURPOSE

A report that overstates is read by us. An email that overstates is read by the prospect. The two
things a model reaches for first are the two we cannot back: a number about their website nobody
scanned, and a promise.

So a draft is **thrown away, never edited**, if it states a number or date not in the facts,
promises anything, or opens with a line that gets emails deleted. When nobody has scanned, the fact
sheet says **"There is NO score"** in as many words and the gate refuses every way of implying one —
checked as a **phrase list, not a number check**, because the dangerous version has no digits in it:
*"your site is falling behind"*. Quoting is not claiming, through the shared `withoutQuotes` the
other three report gates use.

### SENDING ONE LOGS IT

**The console cannot watch a mail client**, so it cannot observe a send. The nearest honest moment
is the one where the rep takes the words away — the copy. So the primary button says exactly that:

**Copy & mark it sent** — copies, logs an email touch dated now with the full *edited* email as the
note, then switches the panel to the follow-up date row. One more click and the rep is done.
**Copy only** sits beside it. Neither label is a guess dressed up as a fact.

- **Copy first, then log.** A refused clipboard means the rep has not got the email, so nothing
  claims they sent it.
- **Through `logTouch`**, the same path the Contacted? cell uses, so the claim, the trigger's date
  stamps, the cadence step and the timeline line cannot differ by which control was pressed.
  `logTouch` gained an optional `note` that goes **on the touch row**, not a second one — one act,
  one timeline entry.
- **Booking the date is its own callback**, not `onSent` with a flag. One callback doing two things
  depending on an argument is how the second press logs a second email.

### THE 500 THAT WAS NOT A BUG — read this before adding an export to a lib/ file

The route returned 500 on every request, including with an invalid id that should have been refused
before any work. Node imported the file fine. A probe route that imported each dependency and
printed its export list named it in one request:

**`sales-rules canEmail: undefined`.**

`canEmail` was added to `lib/sales-rules.js` the same evening. The dev server had already loaded that
module, and **Node's ESM loader caches a module by URL for the life of the process** — so the named
import threw "does not provide an export named" every time. **The vite dev plugin cache-busts the
`api/` file on its mtime and NOTHING ELSE**, so editing the route does not reload its dependencies.

Nothing was wrong with the code. **Restart `npm run dev`.** Vercel deploys a fresh process, so it
never arises there.

**A route's own try/catch must start at the TOP.** The first version started below the auth and body
reads, the real crash happened above it, and it still fell through to the plugin's "the reason is in
the terminal" — which a Mac-bridge session cannot read. A catch that does not cover the whole route
only reports the failures you already understand.

### apiFetch: `{ ok, data }`, and it stringifies for you

Two mistakes at that boundary in one session, both found by opening the panel and seeing it blank:

1. **The payload is under `.data`.** Spreading the response gave the panel no subject, no body, no job.
2. **`body` takes an OBJECT.** Passing `JSON.stringify()` sent a JSON string of a JSON string. It
   survived locally because the dev plugin parses once and `readJson` parses again — **worse than
   failing**, since Vercel parses once.

### Three older gaps this landed on

- **A saved preference can hide a new column completely.** `draft_email` went into
  `DEFAULT_SHEET_COLUMNS` and did not appear, because a saved localStorage list beats today's
  defaults. Spotted by the header reading "Columns · 14". `withNewColumns` adds any default column
  that did not exist when the preference was saved, in its proper place, and the preference records
  `seen` so the next column needs no hard-coded list. A column somebody actually switched off stays
  off. **Second time** — a saved preference deleted every Claim button in August.
- **`.adm-cp-foot` is defined TWICE in `admin.css`** — one a flex row with `space-between`, one a
  plain caption. In a modal the flex one wins, so a sentence rendered as three chunks pushed to the
  edges. New footnotes get their own class.
- **The sheet header never read `SORTABLE`.** Every column got a sort button, unnoticed because every
  column was sortable until this one. Clicking `draft_email`'s header sorted the table by a value
  that does not exist. A non-sortable column renders a plain label now — not a dead button, which is
  the shape that teaches people the header is broken.

Also: `admin_lead_tag_events` orders by **`at`**, not `created_at` (0018 named it that on purpose).
Wrong name is a 500 from PostgREST, not an empty list.

### Proof

Lint clean across `lib src api tests`. **2,489 checks in 25 suites, all passing.**

Driven end to end on the live board, on a junk `Schmo` test row: Draft email → panel with the
follow-up job named, the counted-skeleton warning, subject and body → **Copy & mark it sent** →
"Logged as emailed, dated today" with the four date presets → **In 3 days** → Book it. The timeline
then reads **Email · sent** with the full email as the note.

It drafted as a **follow-up** rather than a first contact, because that lead has a first-contact date
from an earlier test — the job comes from the timeline, exactly as designed.

**There is no ANTHROPIC_API_KEY on Ryder's machine** — `/api/rep-report` answers with its counted
version and says so. The drafter returns its skeleton until a key is set, and the panel says which
one it is rather than letting the two look alike.

### Blocked until

1. Deployed. Nothing from §49-§55 is pushed.
2. An `ANTHROPIC_API_KEY` for the drafter to write rather than skeleton.
3. The rep view has still never been driven — see §52.

## §56. A DRY RUN THAT LOST A TASK, THREE DATE BUGS, AND THE SCAN WIRED TO OUR OWN PLATFORM — Sun 30 Aug 2026, evening → night (append-only section)

Four asks in one session, in Ryder's words:

1. *"working on the syndicate admin so it can get launched tonight. when i am a lead trying to
   connect my own email so i can send, receive, and manage my emailed leads individually within my
   own salesman email."*
2. *"create a client and some tasks, run it as if we were working on the tasks and managing the
   client through everything, and make sure everything is working how it should so when we get real
   clients in there... nothing goes missing, doesnt work, or is broke."*
3. *"sales reps dont work with operations or anything."*
4. *"build the feature that allows people to scan the website and company online profile from the
   lead sheet and get the audit so they can better pitch"* and *"make the scan site for ones that you
   can more easy to see its available to scan."*

**Local time throughout was Sun 30 Aug, 8–10pm Chicago — already 31 Aug in UTC.** Three of the bugs
below are invisible at midday and obvious at 9pm. That is not a coincidence, it is the reason they
were found at all.

---

### 56.1 THE GMAIL SIGN-IN CAME BACK TO A PAGE A REP CANNOT OPEN

`api/gmail-callback.js` ends every Google sign-in with a redirect to
`#/dashboard/inbox?gmail=connected`. It runs before anything knows who signed in, so it names ONE
page for everybody — and `inbox` is the **shared team inbox**, owner/admin only. The dashboard
correctly refused to route a rep there and dropped them on Overview, which does not read `?gmail=`.

**The mailbox was connected. The screen said nothing at all**, and the rep's own Gmail page was two
clicks away with no reason to think of going there.

**THE LESSON: an endpoint that redirects cannot know who is coming back.** Any server-side bounce
that names a page is naming it for every role at once, and the role gate on the other side will
quietly re-aim it. Same family as §52's "hiding rows on a page is not hiding rows".

**The rule moved out of the component.** It was ~50 lines inside `AdminDashboard.jsx` — renames, the
per-role splits, the fallback, the query — **where no test in this repo could reach it**, which is
exactly why a wrong answer sat there. It is now `src/lib/pageForAddress.js`, comments and all, with
`tests/page-for-address` (34 checks). Behaviour did not change in the move. `tests/sales` was
**repointed, not deleted** — every assertion still guards the same rule against the file that now
holds it, plus a new one that the dashboard has not grown its own second copy of the maps.

The new split entry is `sales: { ..., inbox: "gmail" }`. The general rule the suite now pins:
**every `SPLIT_FOR_ROLE` entry must point at a page that role really has** — a split pointing
somewhere the role's own menu does not carry falls back silently, which is the class of bug this was.

### 56.2 ONLY @aisyndicate.com ACCOUNTS CAN CONNECT A MAILBOX AT ALL

Found the moment 56.1 was fixed. Picking a personal Gmail gives, **on Google's own page, before any
of our code runs**:

> Access blocked: AI Syndicate Admin can only be used within its organization. **Error 403: org_internal**

Our Google Cloud OAuth app's **Audience is Internal**, so Google only lets an @aisyndicate.com
Workspace account grant it anything. **The browser is never redirected back**, so there is no
callback, no `?gmail=error`, and nothing this console can ever catch or report.

Recommendation given (Ryder's decision NOT recorded — check before acting on it): **leave it
Internal.** Going External to admit personal Gmail puts the app in Google's unverified state while
asking for `gmail.modify` and `gmail.send`, which are RESTRICTED scopes — a "Google hasn't verified
this app" warning for every rep, a manually-listed test-user cap, and a verification review that
needs a paid third-party CASA security assessment and takes weeks. **In "Testing" state Google also
expires the refresh token after 7 days**, so the quick version means every rep reconnects weekly.

So: **a rep needs an @aisyndicate.com Google Workspace account before they can use the Gmail page.**
A prerequisite, not a bug to chase.

`src/lib/connectProblem.js` + `tests/connect-problem` (28) came out of this: every reason
`gmail-callback.js` can send is now a sentence with an action in it instead of `browser_mismatch`,
an unknown reason is passed through rather than swallowed, and — because `org_internal` can never
reach us — **the connect screen says which address to use BEFORE the button.**

**THE SECOND LESSON: two different walls can produce the same blank screen.** 56.1 and 56.2 both
ended with a rep looking at "Connect your work email", and fixing the first proved nothing about the
second.

---

### 56.3 THE DRY RUN — one fake client, four tasks, worked start to finish

`ZZ TEST — Dry Run Realty` (`9ac5fdef-850c-4e73-81c4-8b7a85760a55`) and four tasks covering
different shapes: owner-owned and due tomorrow, rep-owned, CJ-owned and overdue, unassigned with no
date. **All five rows are still in the live database.**

**What was watched working, so nobody re-checks it:** client create + the `?id=` deep link; both ways
of adding a task (the modal and the inline row, which inherits the client from its group); the status
chip, the assignee popover and drag-and-drop on the board — **all three survive a full reload**; the
`n shown · n open · n late` counts matching the rows every time they changed; overdue drawing red
with a ⚠ while a task due tomorrow did not; "tomorrow" on the Work page; "where this client stands"
counting 0 done / 4 open / 1 blocked and naming both the blocked and the overdue one; **Generate
report with no `ANTHROPIC_API_KEY`** — it says so and ships the counted version rather than an empty
page; Overview's client count and its "what changed lately" feed.

#### THE ONE THAT LOSES WORK

The roster held **two members called "Ryder Schilling"** — `ryder@aisyndicate.com` (owner) and
`ryderschilling@gmail.com` (the rep test login made that afternoon). Every person picker drew
`full_name || email`, so **both rows read identically with nothing to tell them apart.**

A task assigned to the second one **looks completely normal on Operations and is not on Ryder's Work
page**, and nothing anywhere says so. Proven in a browser, not reasoned about.

`src/lib/people.js` + `tests/people` (63). A name is drawn alone only while it is unique **in the
list being drawn**; the moment it is not, every copy carries the part of the address that tells them
apart. Two details that matter more than they look:

- **The disambiguator must FIT.** The first version appended the whole email and the sheet cell
  truncated it to "Ryder Schilling (ry…" — identical again. **Half a fix is the dangerous kind,
  because it looks disambiguated.** It now uses the local part, falling back to the whole address
  only when two local parts also match, so shortening can never create a new collision. The cell
  also carries a `title`.
- **One labelling pass over the list actually on screen.** Labelled separately, an eligible "Ryder
  Schilling" came out plain (unique among the eligible) while the held one came out with its email —
  two labels worked out against two different lists, which is the exact comparison the reader has to
  make.

#### THE DATE BUGS

**`Clients.jsx` "With us" read a client starting TOMORROW as "1h ago".** `Date.parse("<date>T00:00:00Z")`
is midnight in London — 7pm the previous evening in Chicago. Now `teamDayStartOf()`.

**`timeAgo()` had no future guard at all.** Its first line was `if (s < 60) return "just now"` and
**every negative number is less than 60**, so a client starting next month read "just now". It also
printed the words "Invalid Date" for anything unparseable. Moved to **`src/lib/timeAgo.js`** — it
was in `shared.jsx`, which node cannot import, so **the one function every page uses to say WHEN had
no test at all.** Says "in 2h" / "in 21d" now, "—" for junk. `tests/time-ago` (33). `shared.jsx`
re-exports it so every existing import keeps working.

**`api/client-report.js` headed a CLIENT report with tomorrow's date.** The identical copied line was
fixed in `api/console-report.js` and `api/rep-report.js` on 26 Aug, **each with a comment explaining
the trap**, and this one — the report that gets forwarded to a client — was missed.
**A bug fixed by hand in two files is not fixed.** Also `api/ai-chat.js` (told the assistant "Today
is <tomorrow>" and then asked it to work "Friday" out from that) and two preview copies in
`src/lib/data.js`.

**And the same report disagreed with itself.** After the title was fixed the body still read
"counted … on 2026-08-31", from `facts.takenAt.slice(0, 10)` in `lib/client-report.js`. Two dates for
one moment, in one document, going to a client. Fixed with a `teamDayOf()` helper. **The line that
prints "02:06 UTC" is left alone deliberately: it SAYS UTC, so it is not claiming to be the team's
day. A date with no timezone beside it is.**

#### FOUND AND NOT FIXED

- **A client cannot be deleted from the console.** `deleteClient()` exists in `src/lib/data.js` and
  **nothing calls it.** A client added by mistake is permanent. Tasks CAN be deleted from the modal.
- **Overview takes ~30 seconds to load, Work ~15** — with ONE client and four tasks. Both finish and
  every number is right. Overview is the landing page.
- `TicketModal` never accepted the `team` prop it is handed, so tickets have no assignee control at
  all — that prop and the `listTeam()` read behind it are dead weight on that page.

---

### 56.4 A SALES REP CANNOT BE GIVEN DELIVERY WORK

Not a preference — **the same class as 56.3's same-name bug.** A rep's console is four pages
(§45/§52) and **Operations is not one of them**, so a task handed to a rep is a task nobody can open:
not on their Work page, not on any page they have, sitting on the board with their name on it looking
perfectly assigned.

`canDoDeliveryWork()` in `src/lib/people.js` — active, and owner or admin. Applied to the assignee
picker in the task modal and on the sheet. **Deactivated members are out too**; Operations had been
offering them while the Inbox already filtered them out.

Two things that make it safe rather than just narrower:

- **It never hides an existing assignment.** Filtering the list and dropping a task ALREADY on a rep
  would render the cell "Unassigned" while the database says otherwise — **losing the work a second
  way while fixing the first.** Whoever holds the row stays in the list, marked
  *"Ryder Schilling (ryderschilling) · sales — cannot see this page"*. Driven in a browser.
- **The Owner FILTER at the top keeps the whole roster, deliberately.** Filtering to a rep is how you
  FIND a task wrongly put on one before this rule existed. Narrowing it would hide exactly the rows
  somebody has to go and fix. `tests/people` pins both halves.

---

### 56.5 THE SCAN WAS NEVER BLOCKED ON ANDREW

The modal said *"the address of our own scanner is not set on the server, and nobody has written down
what it sends back"*. Ryder: **"i have access to our platform so whatever you need to get it working
i can grab for you."** So instead of sending him hunting, the platform repo was opened
(`~/aisyndicate/ai-syndicate-live` — **NOT one of the two connected folders; it needs
`device_request_folder_access`**) and the contract was **read**:

```
POST /v1/audit                        ai-syndicate-live/api/v1/audit.js
auth   X-Api-Key: <key with `write`>  (Authorization: Bearer also works)
body   { domain, pages, maxPages }
answer { domain, measured, score, gated, categories, measuredAt,
         measuredNow, stored, pages:{scored,requested}, notes }
```

`score` is the AI Access composite 0-100 — which `readAiAccess()` already accepts under the name
`score`. `categories` is `[{key,label,score,weight}]` **sorted worst-first**, and the platform's own
comment calls it *"doubles as a fix list"*. That is the pitch material.

**Then production was probed, live.** A same-origin `fetch` run in a browser tab against
`https://www.aisyndicate.com/api/v1/audit` answers **`401 Missing API key` — NOT `503 the public API
isn't enabled`. So `ENABLE_PUBLIC_API` is already true in production.** The 401-vs-503 distinction is
the whole diagnosis and it takes ten seconds.

**THE LESSON: "only Andrew knows" was a note, not a measurement.** The repo was on Ryder's Mac the
whole time and the endpoint answered a probe from a browser tab. **Read the code and probe the
endpoint before escalating to a person.** (`.env.local`'s "Andrew is the only one who knows these
URLs" comment has been corrected in place for the two SCORE lines; PROMPT_SIM and LEADGEN are still
genuinely unknown.)

#### What changed on our side

- **`PLATFORM_SCORE_URL=https://www.aisyndicate.com/api/v1/audit` — the www host ON PURPOSE.**
  `aisyndicate.com` redirects to www, and a redirect can turn a POST into a GET and drop the body.
  Measured: www answers directly; the bare host does not answer without following a redirect first.
  **The dashboard sign-in link elsewhere uses the BARE domain deliberately, because www has no
  session. Two opposite rules, both right — check which one you are in.**
- **`pages: false` is now sent.** With pages on, /v1/audit crawls up to 20 pages; this fetch gives up
  at 55 seconds and a rep working 3,663 rows is not waiting a minute a row. The site-level pass —
  robots.txt blocking the AI crawlers, no llms.txt, no schema, no sitemap — is what the pitch is made
  of anyway, and it returns in seconds.
- **`categories` is read as findings**, LAST in the candidate list so a scanner sending real
  `findings` still wins. A category is a scored AREA, not a defect, so it becomes a finding that says
  exactly that — *"Schema · scored 12 out of 100"*. **No threshold is invented to call one a problem
  and no remedy text is put in a rep's mouth.** Anything without a name or without a real 0-100 is
  dropped rather than printed as "undefined out of 100".
- **`scoreReady()` now requires BOTH the URL and the key, and so does `/api/health`.** Filling in the
  URL alone — which is the state that had never existed before tonight — would have flipped the badge
  to "on", drawn a live "Scan now", and 401'd on every press. The modal's own comment says why that
  is worse than an off button: *"a button that looks live and returns an error is how a rep learns to
  distrust the whole page."* The 503 now names whichever half is missing.

`tests/platform-scan` (29 checks) is written against the REAL response shape, including that
**SEO and the buyer-question count come back NULL, never zero** — /v1/audit does not measure them.

#### Two limits before reps are turned loose

- **`AUDIT_RUNS_PER_HOUR = 6`** (`lib/audit-run.js`, platform side), **per workspace** — six scans an
  hour for the whole team sharing one key, against a list of 3,663 firms. A one-line constant.
  **That is the real ask for Andrew, not the URL.**
- Scans of a domain we do not own are **not stored** in our own platform history (`stored: false`).
  Our audit trail stays ours. Correct, not a failure.

#### The half NOT built

/v1/audit reads the **website**. It says nothing about a firm's Google / AI presence, which is the
other half of Ryder's ask ("company online profile"). The platform has `brand-serp`, `brand-monitor`,
`brand-snapshot`, `brand-sentiment`, `reputation` and `agency-prospect-report` — **none were read,
wired or tested, and nothing is claimed about any of them.** One note on the last: it is
purpose-built for cold-scanning a prospect, but it is a GET behind `ENABLE_AGENCY_CONSOLE` + a
dashboard session, and it **deliberately returns only a headline score and red/amber/green bands, no
issue text** — a teaser for the agency's own customers, not pitch material for us.

### 56.6 THE SCAN CHIP

"Scan site" was drawn in `adm-db-empty` — the faint grey this sheet uses for "there is nothing here",
**the same as "no site" one row below it.** An action and a dead end in one colour, on 3,663 rows.
Now `.adm-sh-scanchip`: a tinted chip with an arrow when there is a website, faint grey when there is
not. A chip and not a full button because the DO column already carries the loud ones.

---

### Files

```
NEW   src/lib/pageForAddress.js      the whole routing rule, testable at last
NEW   src/lib/timeAgo.js             past AND future, and never "Invalid Date"
NEW   src/lib/people.js              one name per person, and who may be given work
NEW   src/lib/connectProblem.js      why a mailbox did not connect, in words
NEW   tests/page-for-address (34) · tests/time-ago (33) · tests/people (63)
      tests/connect-problem (28) · tests/platform-scan (29)
MOD   AdminDashboard.jsx · Clients.jsx · shared.jsx · opsCells.jsx · opsTable.jsx
      Operations.jsx · Inbox.jsx · SalesPage.jsx · salesSheet.jsx · admin.css
      api/sales-score.js · api/client-report.js · api/ai-chat.js · api/health.js
      lib/client-report.js · src/lib/data.js · .env.local
MOD   tests/sales (repointed to pageForAddress) · tests/company-report (both-halves rule)
```

Every suite re-run, nothing failed. `npx eslint src lib api tests` clean.

### Blocked until

1. **Deployed. Nothing from §49–§56 is pushed.**
2. **`PLATFORM_SCORE_KEY`** — a write-scope key from the platform's own API console
   (`aisyndicate.com` → Dashboard → **API**, tick "Can verify (write)"). Until then the Scan button
   is correctly off. **NO SCAN HAS EVER BEEN RUN — the first press after the key goes in is the real
   test, and it is the first thing to check.**
3. **A restart of `npm run dev`** before the `lib/client-report.js` date fix can even be seen — a
   running dev server does not pick up a new function in a `lib/` file (Node caches the module; the
   vite plugin only cache-busts `api/`). The api/ half of the same fix WAS picked up, which is why
   the report title changed and the body did not, in the same click.
4. `AUDIT_RUNS_PER_HOUR` raised, before a rep works a list against six scans an hour.
5. An @aisyndicate.com Google Workspace account per rep, before any rep can use the Gmail page.
6. An `ANTHROPIC_API_KEY`, still (§55).
7. The rep view has still never been driven (§52). Tonight's rep-side Gmail attempt was stopped by
   `org_internal`, not by our code.

## §57. NOTION MOVES IN, AND THE SHEET'S REPS GET ACCOUNTS — Mon 31 Aug 2026 (append-only section)

Ryder: *"the new admin is ready to imput our clients and also merge our lead sheet so
everything now runs off of the admin."* Built overnight, no questions asked.

### Done live

Six clients from Notion 🏢 Clients are in the deployed console, through the Clients page's
existing JSON import: Shiner Law Group · Dahler Group (30A) · Justin Dyar · Michelle Creamer ·
Jessica Mackrael · Matt McCall. 6 imported, 0 skipped, verified on screen.

Three stages are placeholders and each says so in its own notes, because Notion holds states
this console has no stage for ("website build", "waiting on IDX", and a Month 2 with no week
number).

### New files

| Piece | File |
|---|---|
| Notion rows → admin_tasks patches, and the plan | `lib/notion-merge.js` |
| The paste screen | `ImportTasksModal` in `src/components/admin/Operations.jsx` |
| Sales Owner names → people → accounts → claims | `lib/sales-owners.js` |
| The endpoint that writes them | `api/sales-owners.js` |
| The screen | `src/components/admin/salesOwners.jsx` |
| Tests | `tests/notion-merge` (73) · `tests/sales-owners` (79) |
| The 107 real rows, ready to paste | `_merge/notion-tasks-2026-08-31.json` |

`src/lib/data.js` gained `listAllTasksForImport()`. `vercel.json` gained a 60s ceiling for
`api/sales-owners.js`.

### Rules that must not be broken

1. **A task is matched on (client, task name).** There is no Notion id on `admin_tasks`, so
   that pair is the only stable key across a re-paste. Deciding it off a capped read is how
   one paste becomes two copies — hence `listAllTasksForImport()`, never `listTasks()`.
2. **A client is never invented, and never picked between.** No match refuses the row by name;
   two clients answering to one name also refuses. A task with `client_id` null is invisible
   everywhere, which is the vanished-task failure from the Aug 30 dry run.
3. **An empty Notion cell never blanks a value**, and `description` is fill-only — the export
   carries a link there, and a re-paste must not replace a brief somebody typed here.
4. **Done never reopens.** Every other field on a done task still updates.
5. **Assignees match on email, never on a display name** (two members are called "Ryder
   Schilling"), and a **sales rep is never given an Operations task** — `canDoDeliveryWork`
   in `src/lib/people.js`, the rule every picker already obeys and which this import was the
   one remaining door on.
6. **Only `exact` and `initial` matchOwner hits may be acted on** — `CONFIDENT` in
   `lib/sales-owners.js`. The `first` rule fires on a shared first name alone, so "Andrew
   Miller" matches Andrew Soncini and forty rows of one person's work move to another. A
   first-name-only hit is shown to a person and acted on in neither direction.
7. **`api/sales-owners.js` never sends an email.** `createUser`, not the invite path.
   Placeholder addresses live on `sheet.aisyndicate.invalid` (RFC 2606, resolves nowhere).
   `/api/invite` is untouched and is still how a real person gets a login.
8. **A claim writes `claimed_at` AND `cadence_started_at`, and neither is "now"** — the date
   comes from `first_contact_at`, exactly as `lib/sales-import.js` derives it. Every claim
   update also carries `.is("owner_id", null)`, and every accepted row gets an
   `admin_lead_activity` line.
9. **The check screen lists what changes, field by field, old → new.** A screen that shows
   only counts is asking somebody to agree to a number.

### Two lessons worth carrying anywhere

**Check what is actually listening before believing a browser.** A guard "did not fire" in a
headless run for an hour. The code was correct throughout; a stale `npx serve` from a build
two hours old still held the port, and with SPA fallback even a missing asset answered 200.

**A count on a screen must be the count the button will do.** The claimable figure was
computed against the roster as it IS rather than as it WILL BE, so the screen read "1"
directly above a button about to move three thousand rows.

### Proof

lint clean · **2,829 checks across 33 suites** (was 2,489 across 25) · build clean at 171
modules · driven in a real browser against the built bundle. An adversarial checker found 15
defects in this work and all 15 are fixed; eight rules had no test at all and two more were
guards that could not fire.

### §57 addendum — the tasks are IN (Mon 31 Aug 2026, ~1:00 PM CT)

Ryder deployed §57 that morning and the import was run against the live database.

**107 created · 0 refused · 0 failures.** Operations went 4 → **111 shown · 78 open · 31 late**.
Per client: Matt McCall 36 · Shiner 21 · Justin Dyar 18 · Jessica Mackrael 11 · Michelle
Creamer 11 · Dahler 10 — every count matches Notion exactly. **Nothing in Notion was changed;
read calls only.**

31 of the rows carry the Notion page's own body text as the standing brief, proved by
searching the console for a phrase that exists only inside one page body. The same 107 pasted
a second time returned **`0 new · 0 updated · 107 already right`** — the idempotency rule holds
against the real database, not only in the test suite.

**A large paste cannot be typed into the box in one tool call from a cloud session.** The
211 KB payload was loaded into a page variable in fourteen pieces through the browser console,
then written into the textarea with React's native value setter followed by an `input` event —
a plain `.value =` never reaches React state and the button stays dead. Worth keeping for any
future bulk paste into this console.

Record: `WORK-LOG/2026-08-31--internal--the-107-notion-tasks-are-in.md`. The payload stays on
disk at `_merge/notion-tasks-2026-08-31.json` so the import can be re-run without Notion.

**Still not run: Sales → ⋯ → Reps on the sheet.**

## §58. A CLIENT CAN BE DELETED · TWO PEOPLE ON A TASK · THE TASK OPENS IN A PANEL — Mon 31 Aug 2026, afternoon (append-only section)

Three asks in one sitting: *"can you delete the test client"* · *"make sure two people can be
assigned to the same task"* · *"when i click a row i want it to open a sidebar with the actual
to do item and all the info and edit the text and all that there."*

Full record: `WORK-LOG/2026-08-31--internal--delete-a-client-two-people-on-a-task-and-the-side-panel.md`

### New files

| Piece | File |
|---|---|
| What a client delete costs, and the typed-name gate | `lib/client-delete.js` |
| Who is on a task, and who is primary | `lib/task-assignees.js` |
| The array column, the backfill, the trigger | `supabase/migrations/0028_task_assignees.sql` |
| The task, open | `src/components/admin/taskDrawer.jsx` |
| Tests | `tests/client-delete` (28) · `tests/task-assignees` (62) |

`opsCells.jsx`, `opsTable.jsx`, `Operations.jsx`, `src/lib/data.js`, `lib/notion-merge.js` and
`src/admin.css` all changed. `tests/people` had one assertion **repinned**, not deleted — see
the rule below.

### Rules that must not be broken

1. **`assigned_to` IS `assignees[0]`, always.** It stays as THE PRIMARY so the ~30 readers of
   it keep working; the array is "who is on it". A trigger in 0028 keeps them in step
   whichever one a writer sets, because five writers already exist and a rule five callers
   must remember is a rule that gets broken.
2. **De-duplicating must not sort.** Order is who the primary is. `array_agg(distinct …)` in
   Postgres and `[...new Set()]` in JS differ here; both sides keep first-seen order.
3. **"Is this person ON it", never "is it theirs".** `getMyWork` and the Operations owner
   filter both use `isAssignedTo`. Comparing the single field hides a second assignee's work
   from them — the Aug 30 vanished-task failure, from a new direction.
4. **A row read before 0028 still works.** `assigneesOf` falls back to the single field, so
   nothing waits on a backfill.
5. **Deploy order does not matter.** Postgres rejects the WHOLE row when sent a column the
   table lacks — 0012 set this trap once already. Both write paths fall back to the single
   field, save the rest, and say why.
6. **The delete screen names every table.** Ten cascade, seven set null. A test derives both
   lists from the migrations and fails if a new table gains a `client_id` and is not named,
   which is the only thing stopping the screen from lying by omission.
7. **The panel owns no data.** Every change goes out through the page's own `patchTask`, and
   the draft is keyed on the task id so a row returning mid-edit cannot wipe what is being
   typed.

### Two lessons worth carrying

**A clickable row whose cells are all buttons is unreachable.** Measured on the built bundle:
all 11 cells were 100% filled by their own control, so the "click anywhere that is not a
control" guard blocked every possible click. The cursor said clickable and nothing happened.
The task NAME is the way in now — the widest column, and where a person aims. Measure the
cells before assuming a row has a lap to click on.

**A guard that fires on prose is as useless as one that cannot fire.** Two new tests failed
against their own explanatory comments — `array_agg(distinct …)` written in a SQL comment
explaining why it is NOT used, and `mine(t.assigned_to)` in a JS comment explaining what the
line used to say. Both now strip comments before matching. The sibling of the loose-regex
rule already in this file.

**And one about tests:** `tests/people` pinned `f.assigned_to … deliveryPeopleOptions` and
broke the moment the field correctly became `f.assignees`. It was **repinned to the rule** —
the picker offers `deliveryPeopleOptions` and never the raw roster — not deleted. A test
pinned to a literal fails every time the literal is correctly extended, which is how tests
get deleted instead of read.

### Proof

lint clean · **2,925 checks across 36 suites** (was 2,829) · build clean at 174 modules ·
driven in a real browser: the panel opens on the clicked task and renames the row behind it;
a second person shows as **"Sample Admin +1"** on the row; **make primary** reorders without
removing; a chip click opens its own popover and not the panel; and the client delete moved
the list 3 → 2 with the button dead until the exact name was typed.

**Not deployed. 0028 is NOT run.** `DO-THIS-NEXT-notion-merge.md` at the repo root is the
click-by-click.

## §59. STATE BOARD — replaces §55–§58 as the current picture (Mon 31 Aug 2026, end of day)

Everything below is measured or read off disk, not remembered. Where something is quoted
from a screen rather than measured here, it says so.

### The one-paragraph version

Notion has moved into the console. Six clients and all 107 Operations tasks are LIVE and
verified. Nothing was deleted from Notion — it is untouched and still the source of truth
until somebody decides otherwise. Three more things were built this afternoon (deleting a
client, more than one person on a task, and a side panel that opens the whole to-do) and
those are NOT deployed; one of them needs `0028_task_assignees.sql` run first. The last
piece of the merge — giving the sheet's eight reps accounts so their claimed leads come
back to them — is built, deployed and has never been pressed.

### What is LIVE right now

| | |
|---|---|
| Clients in the console | **7** — the six from Notion plus `ZZ TEST — Dry Run Realty` |
| Tasks in Operations | **111** — the 107 from Notion plus the test client's 4 |
| Contacts on the sales sheet | 3,663 people at 2,765 firms |
| Migrations run | 0001 – **0027**. **0028 is NOT run.** |
| Deployed | everything up to and including this morning's push |
| Not deployed | this afternoon: client delete, multi-assign, the task panel |

Per client: Matt McCall 36 · Shiner Law Group 21 · Justin Dyar 18 · Jessica Mackrael 11 ·
Michelle Creamer 11 · Dahler Group (30A) 10. Every count matches Notion exactly.

### What was built on 31 Aug, in the order it happened

1. **The Notion merge** (§57). `lib/notion-merge.js` + the Operations import modal; the
   client payload; `lib/sales-owners.js` + `api/sales-owners.js` + the Reps-on-the-sheet
   screen; `listAllTasksForImport()`; a 60s ceiling for the new route in `vercel.json`.
2. **The 107 tasks went in** (§57 addendum). 107 created, 0 refused, 0 failures, proved
   twice and re-pasted to prove it cannot double.
3. **Client delete · multi-assign · the task panel** (§58). `lib/client-delete.js`,
   `lib/task-assignees.js`, `0028_task_assignees.sql`, `src/components/admin/taskDrawer.jsx`.

### Proof, as of tonight

`lint` clean across `lib src api tests` · **2,925 checks across 35 running suites** (was
2,489 on 30 Aug across 25) · `npm run build` clean in the cloud container at **174 modules** ·
every feature driven in a real browser against the built bundle, and the client import and
the task import driven against the **live** database.

`tests/auth-gate` and `tests/inbox` still do not run on the Mac bridge — playwright is
missing and the inbox test has a bad relative import. Both predate 30 Aug. **Do not "fix"
them by rewriting them.**

### The three payload files that are worth keeping

- `_merge/notion-tasks-2026-08-31.json` — 211 KB, the 107 tasks with their briefs. The
  import can be re-run from this without going back to Notion.
- `_merge/notion-clients-2026-08-31.json` — the six clients, already imported.
- `DO-THIS-NEXT-notion-merge.md` — the click-by-click for what is left.

### Open, in the order it should be picked up

1. **Run `supabase/migrations/0028_task_assignees.sql`**, then push and deploy. Deploy order
   does not matter — the app falls back and says so — but nothing multi-person works until
   the migration is in.
2. **Delete `ZZ TEST — Dry Run Realty`** once that deploy is live. Ten tables cascade; the
   screen names them.
3. **Sales → ⋯ → Reps on the sheet.** Seven accounts, ~3,000 lead rows handed back. Built
   and deployed, never pressed. `"Andrew"` is deliberately left for a person to decide.
4. **Real email addresses for those seven reps**, then a proper Team-page invite each.
5. **A GoDaddy customer number and password are sitting in plain text on a Notion page**
   ("Get access to Website and Google Tools", Jessica Mackrael). Not copied into the console
   on purpose. Bitwarden, then delete them off Notion.
6. **Justin Dyar has no start date**, so his week number cannot be worked out. His stage is a
   placeholder that says so in its own notes.
7. Optional: re-paste the task payload after 0028 to put the second person onto the 12 Notion
   tasks that had two.

### The rules this day produced, all of them worth carrying

- **A shared first name is not enough to hand somebody a pipeline.** Only `exact` and
  `initial` matchOwner hits may be acted on. (§57)
- **`assigned_to` IS `assignees[0]`.** Ask `isAssignedTo`, never `assigned_to === id`. (§58)
- **Postgres rejects the WHOLE row over one unknown column**, so every new column needs a
  fallback or the deploy order becomes load-bearing. 0012 set this trap, 0028 disarmed it.
- **A count on a screen must be the count the button will do.**
- **A check screen that shows counts is asking somebody to agree to a number** — list the
  fields.
- **A clickable row whose cells are all buttons is unreachable.** Measure the cells.
- **A guard that fires on its own comment is as useless as one that cannot fire.** Strip
  comments before matching source.
- **Repin a test to the rule; never delete it** because a literal correctly changed.
- **Check what is actually listening before believing a browser.** A stale dev server cost an
  hour on a bug that never existed.
- **`claimed_at` and `cadence_started_at` are stamped together, and neither is "now".**

---

## §60. ANY ROW OPENS THE TASK · FOUR STATUS CHIPS · A TASK KEEPS ITS UPDATES — Tue 2 Sep 2026 (append-only section)

Ryder, with a screenshot of the Work page: *"i need any row like this to be able to click it
and it have a sidebar that goes over everything and allows easy editing of it and tagging it
as to do, in progress, blocked, or done. and also adding reports and all that needs to be
seamless through here… we can't have any gaps or missing info."*

Full write-up:
`WORK-LOG/2026-09-02--internal--any-row-opens-the-task-and-a-task-keeps-its-updates.md`.
Project memory: `task-panel-and-task-updates_2026-09-02`.

### What changed

| | |
|---|---|
| `supabase/migrations/0029_task_updates.sql` | **NEW, NOT RUN.** `admin_task_updates` + two triggers + admin-only RLS |
| `lib/task-updates.js` | the rules half — order, the carried-over label, `lineAgrees`, the missing-table match |
| `src/components/admin/taskUpdates.jsx` | the Updates section inside the panel |
| `src/components/admin/taskDrawer.jsx` | status is four chips, not a dropdown |
| `src/components/admin/WorkPage.jsx` | rows open the SAME panel; one `patchTask`; the same four chips |
| `src/components/admin/Operations.jsx` | `patchTask` now returns `{ ok }`; passes `member` and `onLine` |
| `src/lib/data.js` | `listTaskUpdates` / `addTaskUpdate` / `editTaskUpdate` / `deleteTaskUpdate`, `TASK_STATUS_FLOW`, preview rows |
| `lib/client-delete.js` | the warning screen now names the update history it destroys |
| `src/admin.css` | appended — chips, the updates log, the two "this line is not an update" boxes |
| `tests/task-updates/` | 131 checks · `run.sh` 24 SQL checks on real Postgres · `walkthrough.mjs` 30 browser checks · `shots/` |

### The shape

`admin_tasks.latest_report` is read in ~10 places, so it was **not** replaced. It stays and
now means **the newest update**, kept in step by a trigger — the same shape 0028 used for
`assigned_to` / `assignees`, for the same reason. The migration backfills every existing line
as a `carried_over` update dated to the task's own `updated_at`, so nothing starts empty and
no made-up posting time is shown.

`TASK_STATUSES` still matches the 0001 check constraint word for word. `TASK_STATUS_FLOW` is
derived from it for the button order (To do → In progress → Blocked → Done) and **appends**
anything it does not name, so a fifth status can never be savable and unselectable at once.

### Rules this section adds

- **A NEW TABLE HOLDING A FIELD OF AN EXISTING TABLE MUST COPY THAT TABLE'S GATE.** 0029
  first used `admin_is_member()` where `admin_tasks` uses `admin_is_admin()`, and a sales rep
  could read and write every task's progress text. Proved on Postgres before it shipped.
  Count the doors.
- **A SCREEN MUST NOT ASSERT WHAT IT HAS NOT CHECKED.** Five live writers still set
  `latest_report` directly. The panel now asks `lineAgrees()` and says which it is.
- **TWO COPIES OF A RULE NEED A TEST THAT COMPARES THEM**, not one that finds each. A comment
  saying "these must not drift" did not stop them drifting in the same commit.
- **ASK OF EVERY SOURCE-MATCHING CHECK: WHAT WOULD HAVE TO BE TRUE FOR THIS TO FAIL?** Three
  could not fail, one of them the build-under-test guard.
- **A ROW CARRIES FIELDS THE DATABASE DOES NOT.** Re-read after changing anything they are
  derived from.
- **A ROLLBACK RESTORES THE FIELDS THE CALL TOUCHED, NEVER THE WHOLE PAGE.**
- **A SAVE FUNCTION RETURNS WHETHER IT SAVED.** `undefined` reads as success.
- **`innerText` APPLIES `text-transform`** — a browser check against an uppercase label needs `/i`.
