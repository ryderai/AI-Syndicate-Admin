> **SUPERSEDED — 30 Aug 2026. Read `START-HERE-2026-08-30.md` instead.**
>
> Everything this file asks for is done: the keys, the sign-in, AI cost tracking. What happened
> after it — the sheet importer, the 1,000-row ceiling, the lost GRANT, and the Sales page being
> simplified — is in `START-HERE-2026-08-30.md`, `CONTEXT-FOR-AI.md` §49 and §50, and project
> memory. Kept below as the picture at the end of 29 Aug.

Finish wiring up the AI Syndicate admin console. Work in
`~/Documents/AI-Syndicate/ai-syndicate-admin`.

READ FIRST, BEFORE ANY TOOL CALL:
- project memory: `vercel-secret-vs-config-and-vite-vars_2026-08-29`,
  `signin-outage-and-the-error-that-lied_2026-08-29`, `ai-cost-tracking-built_2026-08-29`
- `WORK-LOG/2026-08-29--internal--ai-cost-tracking-BUILT.md` — the whole of yesterday
Don't re-derive any of it. It cost hours.

WHERE THINGS STAND
The console works. Deployed at ai-syndicate-admin.vercel.app with a real login; I sign in as
owner on real data. Same on localhost:5173. Migration 0024 is run. Everything is committed
and pushed at 883fb63. All tests green.

WHAT IS LEFT, IN THIS ORDER. Do them one at a time and stop after each so I can check.

1. SERVER-SIDE KEYS IN VERCEL.
   On the DEPLOYED Settings page every integration says WAITING ON KEY. On localhost the
   same ones say LIVE. My guess is the Vercel values are from Aug 18 and the Aug 18 Supabase
   values are the dead legacy `eyJ` keys — only the `sb_secret_` one works. THAT IS A GUESS,
   NOT A FINDING. Prove it before changing anything.
   The working values are in `.env.vercel-paste.local`.

2. ANTHROPIC_API_KEY. Empty locally, probably empty in Vercel. Without it there are no
   reports, no drafts, no assistant. If it isn't anywhere, tell me and I'll ask Andrew.

3. ANDREW + CJ ON THE ROSTER. The insert is in the work log. Use their EXISTING auth user
   ids. Do NOT create new accounts and do NOT use the Team page invite — they already have
   working logins.

4. DEPLOYMENT PROTECTION. Currently "Standard", which does not cover the main address. Tell
   me the trade-off in one line and give me your pick.

5. RE-CHECK THE INTERNAL .md FILES on the two client sites. Moved out of the deploy folders
   Aug 27, never pushed. It's the only thing on this list that is somebody else's data, so
   check it early even though it's last in the order.

THE FIVE RULES THAT STOP THIS BREAKING AGAIN

- VERCEL: a variable starting with `VITE_` must be Type **Config**. Everything else is
  **Secret**. A `VITE_` variable saved as Secret is silently withheld from the build and the
  app sees an empty string. A saved Secret cannot be converted — delete and re-create it.
- VERCEL: every save can start a build. Finish ALL variable edits, THEN redeploy once with
  "Use existing Build Cache" unticked. Editing one at a time ships half-configured builds and
  makes a working fix look broken.
- NEVER run `vercel link` or `vercel link --yes`. It defaults to my personal team and creates
  a duplicate empty project. Read the dashboard instead.
- Never touch the git index. Never `git add`, never `git commit` unless I ask. I push from
  Cursor.
- Append to shared files, never rewrite them. One new work-log file per session.

WHAT YOU CANNOT REACH, SO DON'T WASTE TURNS TRYING
Your sandbox on my Mac has no internet. Your cloud machine is blocked from supabase.co and
vercel.app. Both browser-control tools error out. So: anything on Vercel, Supabase or the
live site, you cannot see.
Two read-only scripts already exist for exactly this — they run in MY terminal, where the
network works, and print no secrets:
    bash check.sh     — state of the deployed site, the code, .env.local and the database
    bash verify.sh    — the same with a PASS/FAIL verdict
Give me a command, I paste the output back. If you need something they don't cover, write me
a new one-liner rather than guessing.

HOW TO WORK WITH ME
- I'm 19, good with AI and websites, not a backend engineer. Short sentences, normal words.
  Define any technical term in plain words the first time you use it.
- Any step I do myself: numbered, one action per step, exact page, exact button, exact text
  to paste.
- Never give me a choice without your pick and a one-line reason.
- Don't tell me something works until you've seen it work. "Should work" isn't done.
- Before a real build: two lines — what you're building, what you're assuming — then go.
- Passwords never go in notes or Notion. Bitwarden links only. I type passwords myself.
- If a diagnosis and the screen disagree, go read the actual shipped file. Yesterday three
  confident wrong answers came from a stale note, a truncated download and a hung script.
  Only reading the real artefact told the truth.

END OF SESSION: write a new file in WORK-LOG/ and update project memory. Never overwrite an
old record.

---

# ⬆️ THE FIVE ITEMS ABOVE ARE OUT OF DATE — appended Sat Aug 29 2026, ~8:10 PM CT

Full record: `WORK-LOG/2026-08-29--internal--admin-console-server-keys-fixed-and-roster.md`.
Memory note: `admin-vercel-vars-were-empty-not-dead_2026-08-29`.

**Item 1 — DONE.** The guess was wrong. The Vercel variables were not dead keys; the whole Aug 18
batch was created **empty** — names with no value. Fixed by deleting and re-creating each one with
its real value, plus adding `SUPABASE_URL`, `VAULT_KEY` and `VITE_PLATFORM_URL` (Config). One
redeploy. Measured on the deployed Settings page at 7:56 PM: **Supabase, Google (Gmail),
The client's own accounts and Token usage feed are all LIVE.**

**Item 2 — ANSWERED.** `ANTHROPIC_API_KEY` exists in Vercel as an empty name and exists nowhere else.
Ask Andrew.

**Item 3 — DONE.** Andrew and CJ inserted by their existing auth ids, verified: three roster rows,
all `owner`, all `active`. Ryder confirmed only those three should have console logins.

**Item 4 — DECIDED: stays "Standard".** All Deployments would lock out anyone not on the Vercel team
(likely CJ) while only stopping people who already cannot get in. The app's own login is the real
protection and was proven twice.

**Item 5 — re-measured, NOT closed.** Three of the four internal `.md` URLs now 404. One does not:
`jessicamackrael.com/README-START-HERE.md` still returns real content at the plain address, while the
same URL with `?cb=` returns 404 and the file is in neither repo. Looks like an edge cache.
**Unproven — needs `curl -sI` response headers.**

## WHAT IS ACTUALLY LEFT

1. `ANTHROPIC_API_KEY` — from Andrew. Blocks reports, drafts and the assistant.
2. `STRIPE_SECRET_KEY` — a read-only restricted key, `SETUP.md` § 3.
3. Google Cloud console: add `https://ai-syndicate-admin.vercel.app/api/gmail-callback` to the OAuth
   app's authorised redirect URIs, and add `CONNECT_REDIRECT_URI` to Vercel. Gmail reads LIVE but
   connecting an inbox still fails until this is done.
4. Rotate the admin console keys — `.env.vercel-paste.local` was readable in a shared screenshot.
5. Put data in the console — no clients, no leads; the 451-row sales sheet import has never run.
6. The Jessica cached-file question above.

## Appended 8:35 PM — the Google redirect addresses are FINE

Item 3 in the list above is narrower than it looked. The OAuth client in Google Cloud (created Aug 28)
**already holds both live addresses** — `https://ai-syndicate-admin.vercel.app/api/gmail-callback` and
`.../api/connect-callback`, plus the two localhost ones. Verified by reading the Credentials screen.
`SETUP.md`'s `admin.aisyndicate.com` addresses are out of date. Nothing was changed there.

Also: **do NOT add `CONNECT_REDIRECT_URI` to Vercel.** It is a local-dev override only; the deployed
site works the address out from the request. An earlier note in this session said otherwise and was
wrong.

**Not proven:** nobody actually clicked Inbox → Connect your Gmail. Do that first next time —
threads appearing is the only proof. What remains for client connections is `SETUP.md` § Client
connections step 2 (six APIs to enable) and step 2b (three scopes under Google Auth Platform →
Data Access).
