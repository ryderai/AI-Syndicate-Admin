# SETUP — from zero to admin.aisyndicate.com

Every step is one action. Do them in order. Sections 3–6 are independent —
skip any of them and that feature just shows WAITING ON KEY until you come back.

**Time:** § 1–2 ≈ 25 minutes to a live console. § 3 ≈ 5 min. § 4 ≈ 2 min. § 5 ≈ 15 min. § 6 ≈ 5 min + Andrew.

---

## 1. Database + login (Supabase — shared with the platform)

The console uses the SAME Supabase project as the customer platform. Nothing
existing is touched — every new table starts with `admin_` and customers are
locked out by an allow-list.

**Get the 3 keys.**

Two of them are already pulled into `.env.local` in this repo (done Aug 16 2026
straight from the platform's Vercel): `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`.

The third one, `SUPABASE_SERVICE_ROLE_KEY`, **cannot be copied from Vercel.**
The platform's copy is marked **"sensitive"** there, which is a Vercel setting
that makes a value write-only — once saved, nobody can read it back, not the
dashboard, not the API, not the eye icon. Same for `ANTHROPIC_API_KEY` and
`STRIPE_SECRET_KEY`. Get it from Supabase instead:

1. Go to `supabase.com/dashboard` and sign in (**Continue with GitHub**).
2. Open the platform's project (ref `xweueatikwvnahegeful`).
3. Click **Project Settings** (gear, bottom-left) → **API Keys**.
4. Under **Secret keys**, click the eye / **Reveal** on the existing key and
   copy it. It starts with `sb_secret_`.
   (If the project still uses the older style, open the **Legacy anon,
   service_role API keys** tab and copy `service_role` — a long `eyJ...` string.
   Either one works.)
5. Paste it into `.env.local` in this repo, on the `SUPABASE_SERVICE_ROLE_KEY=` line.
6. That one key unlocks: login, roles, saved data, and the
   **Sign in and open the platform** button on the Our-platform page.

**Create the admin tables:**

7. Go to `supabase.com/dashboard` and open the platform's project.
8. Click **SQL Editor** in the left sidebar.
9. Click **New query**.
10. Open the file `supabase/migrations/0001_admin_init.sql` from this repo,
    copy ALL of it, paste it into the editor.
11. Click **Run**. You should see "Success. No rows returned".
11a. Click **New query** again, open `supabase/migrations/0002_work_page.sql`,
     copy ALL of it, paste, **Run**. That one adds the Work page's notes,
     reminders and lead follow-up dates. Order matters — 0002 builds on 0001.
     Both files are safe to run twice; nothing is lost if you lose your place.

**Put yourself on the roster (first admin only — everyone else gets invited from the Team page):**

12. Still in SQL Editor, click **New query**, paste this, click **Run**:

```sql
insert into public.admin_users (user_id, email, full_name, role)
select id, email, coalesce(raw_user_meta_data->>'full_name', email), 'owner'
from auth.users where email = 'ryder@aisyndicate.com'
on conflict (user_id) do update set active = true, role = excluded.role;
```

It should say "Success. 1 rows affected". If it says 0 rows: that email has
never signed in to the platform — sign in there once, then re-run.

---

## 2. Deploy (GitHub → Vercel → admin.aisyndicate.com)

1. Move this folder into Cursor, push it to GitHub as a new repo
   (suggested name: `ai-syndicate-admin`) — your normal flow.
2. Go to `vercel.com/new`.
3. Click **Import** next to the `ai-syndicate-admin` repo.
4. Framework Preset should auto-detect **Vite**. Leave everything else alone.
5. Before deploying, open the **Environment Variables** section on that same
   screen and add the three Supabase values from § 1, with exactly these names:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
6. Also add `ADMIN_BASE_URL` = `https://admin.aisyndicate.com`
7. Click **Deploy**. Wait for the confetti.

**Point the subdomain at it:**

8. In the new Vercel project, click **Settings** → **Domains**.
9. Type `admin.aisyndicate.com`, click **Add**. Vercel shows a CNAME record —
   leave this tab open.
10. In a new tab go to `godaddy.com`, sign in (you have delegate access).
11. Click **My Products** → next to **aisyndicate.com** click **DNS**.
12. Click **Add New Record**. Set: Type = **CNAME** · Name = **admin** ·
    Value = **cname.vercel-dns.com** · TTL = default. Click **Save**.
13. Back in the Vercel tab, wait for the domain row to show **Valid
    Configuration** (a few minutes, sometimes up to an hour).

**Tell Supabase the new domain is allowed to receive sign-in emails:**

(Skipping this makes invite and password-reset links land on the customer
platform instead of the admin console.)

14a. Go to `supabase.com/dashboard` → the platform's project.
14b. Click **Authentication** (left sidebar) → **URL Configuration**.
14c. Under **Redirect URLs** click **Add URL**, paste
     `https://admin.aisyndicate.com/**`, click **Save**.
14d. Add a second one the same way: `http://localhost:5173/**` (for local dev).
     Do NOT change the Site URL — that stays pointed at the platform.

**Prove it works:**

14. Open `https://admin.aisyndicate.com` in a normal browser tab.
15. Sign in with ryder@aisyndicate.com + your password.
    - **No password because you always used Google?** Click "Forgot password?"
      on the sign-in screen, open the email, set one. That adds a password to
      your existing account — Google sign-in on the platform keeps working.
16. You should land on the Overview. Revenue says WAITING ON KEY — § 3 fixes that.

---

## 2b. The "Open the platform" button (sign in as us, one click)

On the **Our platform** page, one button opens the customer platform in a new
tab, already signed in as our own account. Nobody types a password. It works
because both sites sit on the same Supabase project: the console asks Supabase
for a one-time sign-in link and sends the new tab to it.

It needs `SUPABASE_SERVICE_ROLE_KEY` from § 1, plus these two:

```
PLATFORM_URL=https://aisyndicate.com
PLATFORM_ACCOUNT_EMAIL=ryder@aisyndicate.com
```

Both are already in `.env.local`. For production add them in Vercel too.

Rules that matter:

- `PLATFORM_URL` must be the bare address — no `/#/dashboard` on the end. A
  redirect that already has a `#` in it breaks the sign-in token. (The code
  strips it anyway, but keep the value clean.)
- Use `aisyndicate.com`, never `www.aisyndicate.com`. They are separate
  addresses to the browser and the session only lives on the bare one.
- `https://aisyndicate.com/**` must be listed under Supabase →
  **Authentication** → **URL Configuration** → **Redirect URLs**. It already is,
  because it is the platform's own Site URL.
- Leave `PLATFORM_ACCOUNT_EMAIL` blank and each teammate signs into their own
  platform login instead of the shared one.
- Only owner and admin can use it. A sales rep cannot become the agency account
  on the customer product.
- The link is one-time and expires. Don't copy it anywhere — click the button
  again for a fresh one.

---

## 3. Stripe (revenue + customers) — read-only key

1. Go to `dashboard.stripe.com` and sign in.
2. Click **Developers** (bottom-left or top-right depending on layout).
3. Click **API keys**.
4. Click **+ Create restricted key**.
5. If asked what it's for, choose the option to use it **in your own
   integration** (not "for a third party").
6. Name: `admin-console-readonly`.
7. Set these four permissions to **Read** (leave everything else at None):
   - **Charges**
   - **Customers**
   - **Subscriptions**
   - **Prices** (may be listed under "Products")
8. Click **Create key**, then click the key to reveal it, copy it (starts `rk_live_`).
9. In Vercel → the admin project → **Settings** → **Environment Variables** →
   add `STRIPE_SECRET_KEY` = that value → **Save**.
10. Go to the **Deployments** tab → click **⋯** on the top deployment → **Redeploy**.
11. Open the console → Overview → the revenue hero should now say **LIVE**.

A read-only key means: even if this key ever leaked, nobody could move money,
refund, or change anything with it.

---

## 4. AI drafting (Anthropic)

The platform's key is marked **"sensitive"** in Vercel, so it can't be read
back out and copied. Make a second key on the same Anthropic account instead —
same bill, and this one can be switched off on its own if it ever leaks.

1. Go to `console.anthropic.com` and sign in.
2. Click **Settings** → **API keys**.
3. Click **Create key**.
4. Name it `admin-console`.
5. Click **Create**, then **Copy** (this is the only time it is shown).
6. Paste it into `.env.local` on the `ANTHROPIC_API_KEY=` line. For production:
   Vercel → the **admin** project → **Settings** → **Environment Variables** →
   add `ANTHROPIC_API_KEY` = that value → **Save** → **Redeploy**.
3. Prove it: console → **AI Brain** → type a question in "Test the Brain" → Ask.
   You should get a real answer. Every draft also logs its own token cost to
   the Overview page automatically.

---

## 5. Gmail inbox (one Google setup for the whole team)

One OAuth app (a permission ticket Google issues to "AI Syndicate Admin"),
then each teammate clicks Connect once.

1. Go to `console.cloud.google.com` and sign in as ryder@aisyndicate.com.
2. Click the project dropdown (top bar) → **New Project** → Name:
   `AI Syndicate Admin` → **Create** → wait, then select it in the same dropdown.
3. In the search bar at top, type **Gmail API** → click it → click **Enable**.
4. Search **OAuth consent screen** → click it.
   - If asked for User Type: pick **Internal** (only aisyndicate.com accounts
     can connect — exactly what we want). App name: `AI Syndicate Admin`.
     Support email: ryder@aisyndicate.com. Save through the remaining screens —
     defaults are fine, scopes can be left empty here.
5. Search **Credentials** (still in APIs & Services) → click it.
6. Click **+ Create credentials** → **OAuth client ID**.
7. Application type: **Web application**. Name: `admin-console`.
8. Under **Authorized redirect URIs** click **+ Add URI** and paste EXACTLY:
   `https://admin.aisyndicate.com/api/gmail-callback`
9. Click **Create**. Copy the **Client ID** and **Client secret**.
10. Vercel → admin project → **Settings** → **Environment Variables** → add:
    - `GOOGLE_OAUTH_CLIENT_ID` = the Client ID
    - `GOOGLE_OAUTH_CLIENT_SECRET` = the Client secret
11. **Redeploy** (Deployments tab → ⋯ → Redeploy).
12. Prove it: console → **Inbox** → **Connect your Gmail** → approve on
    Google's screen → your last 25 threads appear. For growth@: sign in to
    growth@ in the browser first (or use its Google profile), then Connect.

The console asks Google for **modify + send** (changed Aug 18 2026, so that a
status set in the console also shows in Gmail: mark read, archive, add a label).
`gmail.modify` is the widest permission that **cannot permanently delete** a
message or empty the bin — we never ask for that. Anyone who connected a mailbox
before Aug 18 2026 is still on the old read-only permission; the Inbox page spots
that and tells them to reconnect once.

---

## 5b. The shared growth@ mailbox (added Aug 18 2026)

A mailbox the whole team works, connected once. Do §5 first, and run the two
migrations below or nothing saves.

**Run the migrations** (once, in the Supabase SQL editor — same place as §1):

1. Open `supabase/migrations/0003_inbox.sql`, copy the whole file, paste it into
   the SQL editor, click **Run**.
2. Do the same with `supabase/migrations/0004_client_page.sql`.
   Both only create things prefixed `admin_`. Neither touches the platform.

**Connect growth@ and share it:**

1. In Chrome, sign in to **growth@aisyndicate.com** (or open a Chrome profile
   that is already signed in as growth@). This matters: Google connects whichever
   account you pick on its screen.
2. Go to `admin.aisyndicate.com` → **Inbox**.
3. Click **Connect a mailbox**.
4. On Google's screen, choose **growth@aisyndicate.com** and click **Allow**.
   You come back to the console and growth@ is in the mailbox dropdown.
5. Tick the **Shared with the team** box next to the dropdown.
   That is the step that makes it visible to CJ and Andrew. Nothing else does.

**What "shared" means, exactly**

- Every **owner** and **admin** in the console can read growth@ and reply from it.
- The **sales** role can never see it. Client billing lives in this mail.
- Nobody sees growth@'s password or its Google token. Only our own server touches
  the token, and the browser cannot read that column at all.
- A reply sent from growth@ goes out **as growth@**, and carries a hidden
  `X-AIS-Sent-By` line naming the person who actually wrote it. So months later
  it is still possible to tell who answered.
- Only the person who connected a mailbox can share it, rename it or disconnect
  it. An admin cannot expose a teammate's personal mail.

**Prove it worked:** open Inbox, pick growth@, and check the mailbox dropdown says
`growth@aisyndicate.com (team)`. Then mark one thread **Done** and look at Gmail:
that thread should have left the inbox and gained the label `AIS/Done`.

---

## 6. Token usage feed (needs one thing from the platform side)

1. Invent a long random secret. Terminal: `openssl rand -hex 32` — or any
   40+ character random string.
2. Vercel → admin project → **Environment Variables** → add
   `USAGE_INGEST_KEY` = that value → **Redeploy**.
3. The platform backend then POSTs its AI usage here (this is the hand-off —
   the console side is done, this next part happens inside the platform's code):

```
POST https://admin.aisyndicate.com/api/usage-ingest
Header: x-ingest-key: <the same secret>
Body: { "events": [ { "ts": "2026-08-16T12:00:00Z", "source": "caite",
        "model": "claude-sonnet-4-6", "input_tokens": 1200,
        "output_tokens": 480, "cost_usd": 0.0125 } ] }
```

Until that feed exists, the Overview usage panel shows only the console's own
AI drafting spend (which reports itself automatically once § 4 is done).

---

## 7. Add the team

1. Console → **Team** → **+ Invite teammate**.
2. Email + name + role:
   - **Owner / Admin** — everything (CJ, Andrew).
   - **Sales rep** — sees ONLY the Leads pages. The database enforces it.
3. They get an email, set a password, and land in the console.
4. To remove someone later: Team → **Deactivate**. Instant, reversible,
   history kept.

---

## Local development

```
npm install
cp .env.example .env.local     # fill in at least the 3 Supabase values
npm run dev                    # http://localhost:5173
```

`npm run dev` now runs the `/api` functions too, not just the pages. Every file
in `api/` is served at `/api/<filename>` with the same request and response
shape Vercel gives it, and `.env.local` is loaded into the server side. So
Stripe, the AI drafts, Gmail and the platform sign-in button can all be tested
locally before anything is deployed. Before this, every API card read WAITING
ON KEY on localhost no matter what the keys said.

Quick check that the server side is alive:
`http://localhost:5173/api/health` in the browser → it needs a login, so paste
this into the browser's console **while signed in to the console tab** instead:

```
(await fetch('/api/platform-sso?diag=1',{headers:{Authorization:'Bearer '+JSON.parse(Object.entries(localStorage).find(([k])=>k.endsWith('-auth-token'))[1]).access_token}})).json()
```

It should print `{"serverConfigured":true, ...}`. It never prints a key.
Typing the address straight into the address bar always returns
`401 Not authorized` — a browser address bar sends no login header, so that is
the endpoint working, not failing. (Corrected Aug 18 2026: this section used to
say to open the address directly, which can only ever show a 401.)

With NO env values set, the app runs in preview mode: no login, sample data,
every page clickable. That's also what the SAMPLE badges mean in production
screenshots — a card with SAMPLE or WAITING ON KEY has no real data behind it
yet, and says so instead of guessing.

---

## Migration 0005 — platform login cards (added Aug 18 2026)

The Our-platform page and each client page now show one card per platform account, with a
one-click sign-in. The cards live in a new table, so this has to be run once:

1. Go to **supabase.com** → your project → **SQL Editor** → **New query**.
2. Open `supabase/migrations/0005_platform_accounts.sql` from this repo, copy the whole file,
   paste it in, and press **Run**.
3. It should say Success. Nothing else needs setting — no new key, no new environment variable.

`PLATFORM_ACCOUNT_EMAIL` is now optional, and it is the ONLY fallback left. If it is set, a
"Use the environment account" button appears next to the cards and an empty request signs into
that one address. If it is not set, an empty request is refused and the cards are the only way
in — which is the point.

It used to fall back to your own address in the team list as well. That was removed on Aug 18
2026: an admin can edit their own row in the team list, so anyone could have typed a client's
address in there and signed in as them. What the team list says about you is not permission.

Who can do what, once this is run:

| Action | Owner | Admin | Sales |
|---|---|---|---|
| See the cards | yes | yes | **no** |
| Add a card | yes | yes | no |
| Edit a card, switch one off | yes | yes | no |
| Press "Sign in and open" | yes | yes | no |
| Remove a card for good | **yes** | no | no |

Removing is owners-only on purpose: the card list is the record of which logins this console can
open, and who added each one. Switching a card off is the everyday way to retire one.

## Migration 0007 — Finance + invoices (added Aug 20 2026)

The Finance page and the Invoices page under it need one migration. Until it is run, the two pages
open and every number reads SAMPLE, nothing saves, and a red line at the top of Invoices says so.

**What it adds** — five new tables, all `admin_` prefixed, nothing the platform owns is touched:
`admin_expenses` (money out, typed in by us), `admin_invoices`, `admin_invoice_items`,
`admin_invoice_payments`, `admin_finance_settings` (one row: our name on an invoice, the numbering,
the default terms, and what is in the bank).

**Clicks:**

1. Open https://supabase.com/dashboard and sign in.
2. Pick the project **xweueatikwvnahegeful** (the same one the platform uses).
3. In the left menu click **SQL Editor**.
4. Click **New query**.
5. Open `supabase/migrations/0007_finance.sql` from this repo, select all of it, copy it.
6. Paste it into the query box.
7. Click **Run** (bottom right).
8. It should say *Success. No rows returned.* Running it twice is safe.

**Check it worked.** In the same SQL editor, run:

```sql
select count(*) from public.admin_expenses;          -- 0, and no error
select * from public.admin_finance_settings;         -- exactly one row
```

**Then, in the console:** open Finance → *The cost list* → **+ Add a cost** and put in the things we
pay every month (hosting, AI, software, contractors). Money in comes from Stripe on its own; money
out does not exist anywhere until it is typed here, so until the list is filled in, the profit line
is wrong on the high side and says so.

**Who can see it.** Owners and admins only. A sales rep cannot see a total, a count, or an invoice —
the Finance and Invoices pages are not even in their sidebar. Deleting a cost, an invoice or a
payment is owners only; anyone with admin can cancel an invoice or switch a cost off, which is the
everyday action.
