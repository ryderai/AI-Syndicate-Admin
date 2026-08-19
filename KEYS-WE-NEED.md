# Keys the admin console still needs

Last checked: **Sunday, August 16 2026.**

Right now the console runs with **sign-in switched off and sample data**. Nothing on it is real.
Each key below turns on one part of it. They are independent — get one, that part goes live, the
rest keeps saying SAMPLE.

Where they go: `ai-syndicate-admin/.env.local` on the Mac for local use, and Vercel →
the admin project → Settings → Environment Variables for the deployed one.

---

## Already done — nothing to chase

| Key | What it does | Where it came from |
|---|---|---|
| `VITE_SUPABASE_URL` | Points the console at the shared database | Platform's Vercel |
| `VITE_SUPABASE_ANON_KEY` | The public browser key | Platform's Vercel |
| `RESEND_API_KEY` | Sending email | Platform's Vercel |
| `USAGE_INGEST_KEY` | Password for the platform to post its token costs to us | Generated Aug 16 |
| `PLATFORM_URL`, `PLATFORM_ACCOUNT_EMAIL` | Which platform and which account the sign-in button opens | Set Aug 16 |

---

## 1. `SUPABASE_SERVICE_ROLE_KEY` — the big one

**Unlocks:** logging in at all, roles, every saved record (clients, tasks, leads, tickets, the AI
Brain), inviting the team, and the "Sign in and open the platform" button. Nothing real works
without it. **Get this one first.**

**Blocked by:** the Supabase account can't make one. Trying it on Aug 16 returned
*"Your account does not have the necessary privileges to access this endpoint."* That is an
organisation-level permission on Supabase, not a bug and not something the console can work around.

**Two ways to unblock it, either is fine:**

- **A — get the key handed over.** Whoever owns the Supabase organisation makes a secret key and
  sends it (Bitwarden link, not a text message).
- **B — get the permission instead.** Same person opens Supabase → the organisation →
  **Team** → changes `ryder@aisyndicate.com` from its current role to **Owner** or **Developer**.
  Then the key can be made here. **This is the better one** — the same permission is also needed to
  run the console's database migration, which is the very next step after the key.

**Exact ask, ready to send:**

> Need one thing on Supabase for the admin console. My account can't create a secret API key on the
> `xweueatikwvnahegeful` project — it says my account doesn't have the privileges. Can you either
> (a) create a secret key named `admin_console` and send it over, or (b) bump me to Owner or
> Developer on the Supabase org so I can create it and run the console's SQL migration myself?
> (b) is easier long-term because the migration needs it too.

---

## 2. The database migration — not a key, but the same blocker

**Unlocks:** the tables the console saves into. Even with the key above, the console has nowhere to
write until this runs once.

**What it is:** the file `ai-syndicate-admin/supabase/migrations/0001_admin_init.sql`, pasted into
Supabase → **SQL Editor** → **New query** → **Run**. Every table it makes starts with `admin_`, and
nothing existing on the platform is touched. It has been tested against a local copy of Postgres —
six permission tests passed, including proving a platform customer sees zero rows.

**Blocked by:** the same Supabase permission as #1.

---

## 3. `ANTHROPIC_API_KEY` — the AI drafting

**Unlocks:** the AI Brain page, AI-written email replies, ticket replies and lead outreach, and the
console measuring its own AI spend.

**Why it can't be copied:** the platform's copy is marked **"sensitive"** in Vercel. That is a
write-only setting — once saved, the value can never be read back by anyone, including the person
who saved it. So a **new key on the same Anthropic account** is the only route. Same bill.

**Steps for whoever holds the Anthropic login:**

1. Go to `console.anthropic.com` and sign in.
2. Click **Settings**, then **API keys**.
3. Click **Create key**.
4. Name it `admin-console`.
5. Click **Create**, then **Copy**. It is shown once and never again.
6. Send it over as a Bitwarden link.

---

## 4. `STRIPE_SECRET_KEY` — revenue and customers

**Unlocks:** the money numbers on Overview (monthly recurring revenue, active subscriptions, last
12 months of revenue, recent payments) and the whole Customers page.

**This one should be a NEW key on purpose, not the platform's.** We want a **restricted, read-only**
key so that even if it leaked, nobody could move money, refund anything, or change a subscription.
The platform's key is also "sensitive" in Vercel and unreadable anyway.

**Steps for whoever holds the Stripe login:**

1. Go to `dashboard.stripe.com` and sign in.
2. Click **Developers**, then **API keys**.
3. Click **+ Create restricted key**.
4. If it asks what it is for, choose using it in **your own integration**.
5. Name it `admin-console-readonly`.
6. Set these four to **Read**, leave everything else at **None**:
   **Charges**, **Customers**, **Subscriptions**, **Prices** (may be listed under "Products").
7. Click **Create key**, click the key to reveal it, copy it. It starts `rk_live_`.
8. Send it over as a Bitwarden link.

---

## 5. `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` — the team inbox

**Unlocks:** the Inbox page — every teammate's Gmail in one place, read and reply, with AI drafts.

**Not a copy job either — this is a new app that has to be created once** in Google Cloud, by
someone who is an admin on the `aisyndicate.com` Google Workspace. Because we are a Workspace, the
app is **Internal**, which means no Google review and no waiting.

Full click-by-click steps are in `SETUP.md` § 5. The short version: Google Cloud Console → new
project → OAuth consent screen set to **Internal** → Credentials → **Create OAuth client ID** →
Web application → Authorised redirect URI `https://admin.aisyndicate.com/api/gmail-callback` →
copy the client ID and client secret. Scopes: read Gmail and send Gmail, nothing else.

**Lowest priority of the five.** The console is useful without it.

---

## Not needed — do not chase these

The platform also holds `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GSC_CLIENT_ID`,
`GSC_CLIENT_SECRET`, `HIGGSFIELD_API_KEY`, `CRON_SECRET`, `FLAGS_SECRET`, `CMS_SECRET_KEY` and the
`STRIPE_PRICE_*` list. The admin console does not use any of them. They belong to the customer
platform. Asking for them muddies the ask above.

---

## Where to put a key once it arrives

1. Open `ai-syndicate-admin/.env.local` in Cursor.
2. Find the line with that name, paste the value after the `=`, with no spaces and no quotes.
3. Save.
4. In the terminal running the console: press **Ctrl + C**, then type `npm run dev` and press Enter.
   Vite only reads that file when it starts, so nothing changes until it restarts.
5. Open `localhost:5173` → **Settings**. That page lists every integration and says LIVE or
   WAITING ON KEY for each one. That is the proof it took.

**Never** paste a key into Notion, a text message, or a chat. Bitwarden link only.
`.env.local` is already ignored by git, so it cannot be committed by accident.
