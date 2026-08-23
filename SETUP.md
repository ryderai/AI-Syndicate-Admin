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

---

## Migration 0006 — Notes, AI memory, the assistant, lead intake (added Aug 20 2026)

Do these in order. Steps 1 and 2 are required before any of it saves anything.

*(0006 and 0007 are independent and can be run in either order — 0006 is this page, 0007 is
Finance. Neither touches the other's tables.)*

### 1. Run the database file — 2 minutes

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click the project the platform uses (the shared one).
3. In the left menu click **SQL Editor**.
4. Click **+ New query**.
5. Open `supabase/migrations/0006_brain_notes_leads.sql` from this repo, select all of it,
   copy it, and paste it into the box.
6. Click **Run** (bottom right).
7. You should see **Success. No rows returned**. Green notices saying
   `... does not exist, skipping` are normal — that is the file being safe to re-run.

Run `0001` through `0005` first if you have not. Everything this file creates is prefixed
`admin_`; it touches nothing the customer platform owns. It is safe to run twice.

### 2. What works with no extra keys

- The **Notes** page. Press **Write today's notes** and it reads every client, task, lead, email,
  ticket and follow-up and writes down what it found. Every note is badged **COUNTED**, and no AI
  is involved in that path at all.
- **Import a list** on the Leads page: Excel or CSV or paste, with duplicates caught before
  anything saves.
- The **rep call queue** on the Leads page.

### 3. Turn the assistant on — needs one key

The assistant (the ✦ button, bottom right, or Ctrl+K) and the AI wording on Notes both need
`ANTHROPIC_API_KEY`. It is the same key the platform's Caite already uses. If you already did
this for § 4 above, it is done — skip to step 4.

1. Go to **https://vercel.com** and sign in.
2. Click the **ai-syndicate-admin** project.
3. Click **Settings** (top), then **Environment Variables** (left).
4. In **Key** type `ANTHROPIC_API_KEY`.
5. In **Value** paste the key.
6. Tick **Production**, **Preview** and **Development**.
7. Click **Save**.
8. Click **Deployments** (top), then the **⋯** on the newest one, then **Redeploy**.

Without it: the assistant says it is waiting on the key, and Notes still writes every note —
just in its own counted words. Nothing fakes it.

### 4. Lead scraping — needs a key we do not have yet

Saved searches are built and wired. They stay switched off until one of these exists:

| Variable | What it turns on |
|---|---|
| `PLATFORM_LEADGEN_URL` (+ optional `PLATFORM_LEADGEN_KEY`) | Pull leads from our own platform's lead generator |
| `APOLLO_API_KEY` | Pull contact details from Apollo |

Add either the same way as step 3. Until then, pressing **Run it now** on a saved search says
exactly which variable it is waiting for, and nothing pretends to have run.

**For the daily run**, also add `CRON_SECRET` — any long random string. Without it the scheduled
run is closed, not open. The schedule itself is already in `vercel.json`: weekdays at 13:00 UTC,
which is 8am Central.

**What a search costs.** Each run is a paid call to the provider. Three things keep it bounded,
and none should be loosened without a reason: **Most leads per run** on the search (25 by default,
500 maximum), one page of results per run, and **Run it every day on its own** being off unless
somebody ticks it.

### 5. Who can see what

| | Owner | Admin | Sales |
|---|---|---|---|
| Notes page | yes | yes | **no** |
| AI Brain + what it has remembered | yes | yes | **no** |
| The assistant | yes | yes | yes — **leads only** |
| Leads, the rep queue | yes | yes | yes |
| Import a list | yes | yes | no |
| Create or edit a saved search | yes | yes | no (can see the list) |
| Run a saved search | yes | yes | no |

A sales rep's assistant can read leads, lead activity, lead sources, **their own** follow-ups and
the team roster. It cannot read clients, tasks, email, tickets, money, the Brain, the memory or
the notes — not by asking, not by searching, not indirectly. That is enforced in
`lib/brain-context.js` and `lib/assistant-tools.js`, twice each, because these endpoints run on
the service key which ignores the database's own row-level security.

### 6. What the assistant can change, and what it cannot

It can: move a lead's stage, claim or assign a lead, log a call, set a follow-up, add or update a
task, move an email's status in the shared inbox, remember a fact, and write a note.

It cannot **delete anything at all**, at any role, and it will not blank a lead's notes. Every
change it makes is printed as its own green or red line in the chat, and written to
`admin_assistant_log` with who asked for it. The **Actions on / Actions off** switch in the chat
header makes it read-only for that conversation; it is told when it is off, so it explains what
it would have done instead of failing quietly.

The full write-up of all of this is `CONTEXT-FOR-AI.md` **§21** (the build) and **§22** (the
review pass that found 15 defects). Tests: `bash tests/brain/run.sh`.

---

## Migration 0008 — the Vault and client reports (added Aug 21 2026)

Two things go live together: the **Vault** (every password, card and key, ours and each client's)
and **Generate report** on a client page. Both need step 1. Only the Vault needs step 2.

### 1. Run the database file — 2 minutes

1. Open **supabase.com** and sign in.
2. Click the project the console uses (the same one as the platform).
3. In the left sidebar, click **SQL Editor**.
4. Click **New query**.
5. Open `supabase/migrations/0008_vault_reports.sql` from this repo, select all of it, copy it.
6. Paste it into the box.
7. Press **Run** (bottom right).
8. It should say **Success. No rows returned.** If it says anything else, stop and send the message
   to Ryder — do not press Run again.

It only creates things starting with `admin_`. It touches nothing the customer platform owns. It is
safe to run twice.

### 2. Make the key that scrambles the passwords — 5 minutes

Without this, the Vault page still lists everything, and **Reveal** and **Save** both refuse with a
banner across the top of the page telling you this step is missing.

1. On your Mac, open **Terminal**.
2. Type this exactly and press Enter:

   ```
   openssl rand -base64 32
   ```

3. It prints one line of about 44 random characters, ending in `=`. Select the whole line and copy
   it. **Do not make one up, and do not type a phrase.** The console will refuse a phrase, and even
   the ones it cannot spot can be guessed by somebody who steals the database.
4. Open **vercel.com** and sign in.
5. Click the **ai-syndicate-admin** project.
6. Click **Settings** at the top, then **Environment Variables** in the left sidebar.
7. Click **Add New**.
8. In **Key**, type: `VAULT_KEY`
9. In **Value**, paste the line you copied.
10. Tick all three boxes: **Production**, **Preview**, **Development**.
11. Click **Save**.
12. Click **Deployments** at the top, then the **⋯** next to the newest one, then **Redeploy**.

### 3. Put the key in Bitwarden. This is not optional.

1. Open Bitwarden.
2. Click **New item** → **Secure note**.
3. Name it: `AI Syndicate — admin console VAULT_KEY`
4. Paste the same line into the note.
5. Save it.

**If that line is lost, every password and card number already stored is gone for good.** Not
"hard to get back" — gone. Nobody can unscramble them without it, including us.

The line is not a password anybody types. It never goes in Notion, never in a message, never in
this repo.

### 4. What works with no extra keys

- The whole Vault page: adding items, editing them, searching, the client tabs, "Who looked".
- Reveal, copy, save and clear — as soon as `VAULT_KEY` exists.
- Generate report, in its **counted** form: real numbers, plain wording, no AI involved.

### 5. What needs one more key

`ANTHROPIC_API_KEY` (already set up in § 4 of this file) makes reports read like somebody wrote
them instead of like a list of counts. Everything is still counted first either way; the AI only
does the wording, and a draft that states anything not in the counts is thrown away.

### 6. Who can see the Vault

| | Owner | Admin | Sales |
|---|---|---|---|
| The Vault page and everything on it | yes | yes | **no** |
| Reveal or copy a password or card number | yes | yes | no |
| Add, edit or delete an item | yes | yes | no |
| See who has opened what | yes | yes | no |

A sales account cannot see the Vault in the sidebar, cannot open it by typing the address, and gets
nothing back from the database or the server if it tries.

### 7. Two things worth knowing before you use it

- **Every reveal is written down** — who, which item, which part, when. Those lines cannot be
  edited or deleted by anybody through the console, and they stay even if the item is deleted.
- **Bitwarden is still the master copy.** Each item can hold a Bitwarden link, and the page shows a
  button for it. The console is the list everybody can see; Bitwarden is where the truth lives.

## Migration 0009 — the Sales page (added Aug 22 2026)

This is the one that replaces CJ's outreach spreadsheet. **Nothing on the Sales page saves until
step 1 is done.** Steps 3 and 4 each switch on one thing that is otherwise closed, not broken.

*(0008 and 0009 are independent and can be run in either order. 0009 touches only `admin_`
tables, and only adds — it drops nothing.)*

### 1. Run the database file — 2 minutes

1. Go to **supabase.com** and sign in.
2. Click the project the console uses.
3. In the left sidebar click **SQL Editor**.
4. Click **New query**.
5. Open `supabase/migrations/0009_sales.sql` from the repo, select all of it, copy it.
6. Paste it into the box.
7. Click **Run** (bottom right).
8. It should say **Success. No rows returned.** That is what finished looks like.

Safe to run twice. If you are not sure whether it ran, run it again — every statement is guarded.

**What it adds:** three new tables (`admin_companies`, `admin_lead_lists`, `admin_proposals`),
about eighteen columns on `admin_leads`, a wider stage list (12 stages instead of 7), and one
function that enforces the one-text rule. It also stamps a claim date on every lead that already
had an owner, so the page can show something true on day one.

### 2. What works straight after step 1

Everything except the score button and the overnight job:

- Claiming a firm, and claiming everybody else at that firm in one click.
- The 3-business-day and 14-day timers, on screen. (They **warn** on screen from day one; they only
  start actually handing firms back once step 4 is done.)
- The 5-touch cadence, and My Day telling a rep what is owed today.
- Importing the outreach sheet — every tab at once.
- The whole profile: timeline, proposals, details, playbook.

### 3. The score button — needs one key

The Rules of Engagement say run a site score first and skip anyone at 90 or above. That is the
**Run score** button on a firm. It calls our own platform.

1. Go to **vercel.com** → the admin console project → **Settings** → **Environment Variables**.
2. Click **Add New**.
3. Key: `PLATFORM_SCORE_URL`
4. Value: the platform's scan endpoint (ask Andrew — it is the URL that takes a domain and returns
   a score).
5. Tick **Production**, **Preview** and **Development**.
6. Click **Save**.
7. If that endpoint needs a key too, repeat for `PLATFORM_SCORE_KEY`.
8. Go to **Deployments**, click the newest one, click **⋯** → **Redeploy**. Environment variables
   only take effect on a new deploy.

Until then the button returns an error that names the missing variable, and the chip on screen
keeps saying NO SCORE. **It never invents a number** — a rep would quote it to a prospect.

### 4. The overnight claim sweep — needs one key and one schedule

This is what makes "3 days or you lose the claim" and "14 days cold reopens" real instead of a
sentence in a rules tab.

1. Make a long random password (Bitwarden → Generator → 40 characters).
2. Vercel → **Settings** → **Environment Variables** → **Add New**.
3. Key: `CRON_SECRET`, value: that random string. All three environments. **Save.**
4. Put the same string in Bitwarden so it is not only in Vercel.
5. Set up a daily call to:
   `GET https://admin.aisyndicate.com/api/sales-sweep`
   with the header `Authorization: Bearer <that random string>`
   Vercel Cron, or any scheduler. Around 3am Central is sensible.
6. Redeploy.

**Without `CRON_SECRET` the scheduled path is CLOSED, not open.** A cron endpoint that runs for
anybody who finds the URL could empty the sales floor.

**What it does each night, in this order.** It warns first: anything about to run out gets a dated
reminder on that rep's Work page. It only hands a firm back to the floor if a warning for that
lead is already on file — so the very first run after the migration warns and takes nothing. And a
firm that goes back to the floor keeps everything: every call, every note, the real first-contact
date, and where the deal had got to. A rep who was mid-conversation re-claims it in one click.

### 5. Import the real sheet

1. In the console, click **Sales** in the sidebar.
2. Click **Import a sheet**.
3. Pick the workbook. In Google Sheets: **File → Download → Microsoft Excel (.xlsx)** first.
4. Tick the tabs you want. The Rules of Engagement tab is unticked already — it is instructions,
   not a list.
5. Click **Check the columns**. Each tab is matched on its own, because the columns really are
   different between them. Change anything it got wrong.
6. Click **See what will happen**. Read this screen. It tells you how many people, how many firms,
   how many claims came across, how many are already in the pipeline and will be skipped, and
   every row it could not read.
7. Click **Import**.

Import the same file twice by accident and the second run writes nothing — it tells you they are
already here.

### 6. Who can see what

| | Owner | Admin | Sales |
|---|---|---|---|
| The Sales page and every lead on it | yes | yes | yes |
| Edit anybody's lead, claim or hand back | yes | yes | **yes** |
| Import a sheet · rep numbers | yes | yes | no |
| Run a site score | yes | yes | yes |
| Delete a firm, list or proposal | yes | yes | no |
| Finance, Invoices, the Vault, the shared inbox, the Brain | yes | yes | no |

**There are no locks between reps** — Ryder's call, Aug 21 2026. "One firm, one rep" is a warning a
rep reads before they send, not a wall. Everything that was closed to sales before this migration
is still closed.

### 7. Three things worth knowing before the team uses it

- **The record is the person.** Every row of the sheet is one contact, and it stays that same
  record for life — a lead does not become a client by being copied somewhere else. The firm is a
  link on it, which is why scoring one firm scores it for all four people there.
- **The timeline is never overwritten.** Unlike "Last Touch" in the sheet, nothing is edited or
  deleted. Every call, email, note, stage change, claim and score run is a dated line.
- **Marking a lead Won does not yet create the client record.** Sales history stays on the record
  under Won; onboarding still has to be started by hand on the Clients page. The console says so
  when you click it.

---

## Migration 0010 — the Overview generator (added Aug 23 2026)

The box on the Overview page: you type what you want, it reads the whole console and writes it. This
migration only adds the table the results are saved into.

*(0008, 0009 and 0010 are independent and can be run in any order. 0010 touches only `admin_`
objects and is safe to run twice.)*

**Until you run this, the button still works** — you get the words back and a warning that the row
did not file. Nothing is silently lost.

1. Go to **supabase.com** and sign in.
2. Click the **ai-syndicate** project.
3. In the left sidebar click **SQL Editor**.
4. Click **New query**.
5. Open `supabase/migrations/0010_console_reports.sql` from this repo, select all of it, copy it.
6. Paste it into the box.
7. Click **Run** (bottom right).
8. You should see **Success. No rows returned.**

### The one key it wants

The generator writes with Claude, so it needs `ANTHROPIC_API_KEY` in Vercel — the same key the
assistant and the client reports use. If it is not set, the button still answers with the **counted**
version (the real numbers, nobody's writing) and the box tells you that before you press it.

To set it: **vercel.com** → the project → **Settings** → **Environment Variables** → Add
`ANTHROPIC_API_KEY`, tick all three environments, **Save**, then **Deployments** → the newest one →
the **⋯** menu → **Redeploy**. Env vars only reach a build, so nothing changes until you redeploy.

### Who can use it

Owner and admin only, enforced both in the endpoint and in the database's row-level security. One
saved result can summarise every client, every lead and every invoice in one place, so a sales rep
must not be able to read one.

### What it can and cannot see

**Reads:** every client and their tasks, weekly logs, websites, leads and the firms behind them,
lead lists, proposals, email threads, tickets, follow-ups, open notes, the standing rules, the team,
and the invoices we issued.

**Never sees:** the vault (no login, no card, no key). Anything on the AI Syndicate platform — there
are **no scan results and no GEO scores in this console**, only a website score on a sales firm where
one has been run. Money taken through Stripe. And anything nobody wrote down.

---

## Migration 0011 — rating the Overview generator (added Aug 23 2026)

Two things, both about the box on the Overview page.

**Run this AFTER `0010`.** It changes the table 0010 creates and points at it, so on its own it will
fail. Both are safe to run twice.

1. Go to **supabase.com** → the **ai-syndicate** project → **SQL Editor** → **New query**.
2. Open `supabase/migrations/0011_console_feedback.sql` from this repo, select all, copy.
3. Paste it in and click **Run**. You should see **Success. No rows returned.**

### What it changes

**The "free draft" mode is gone.** Every answer the generator writes is now checked against real
rows. If it invents a number, a date or a name, the whole draft is thrown away and you get the counted
version with the reason. There is no longer any way to ask it for an unchecked one. Where it wants a
figure we do not hold, it leaves a blank in square brackets for you to fill in.

**A star rating, and a box for why.** Under every finished answer: *How was this?* and five stars.
Click a star and a small optional box appears — "too long", "lead with the money", "stop repeating the
client's name". The next time you press **Write it**, those notes are put into the instructions, worst
rating first, so it actually changes. They can only change tone, length and what it leads with — they
can never let it invent a number, and the rules that stop it come after the notes on purpose.

Rating the same answer twice is fine: it saves a second row and the newest one wins.
