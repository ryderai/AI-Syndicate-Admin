# START HERE (2) — the night session, Sun 30 Aug ~8–10pm Chicago

**Read this AFTER `START-HERE-2026-08-31.md`, not instead of it.** That file is still right about
migrations (0025, 0026, 0027 are all run) and about nothing being pushed. This one adds what changed
after it was written.

**The full record is `CONTEXT-FOR-AI.md` §56.** Four work-log entries carry the detail. This page is
just the shortest thing that gets you moving.

> A note on dates. Local time during this session was **Sunday 30 August, evening** — already
> 31 August in UTC. Two work-log files from earlier in the day are dated 08-31 for that reason. Three
> of tonight's bugs only appear after 7pm Chicago; that is why they were found now and not before.

---

## Do these five things first

1. **Restart `npm run dev`.** One date fix lives in `lib/client-report.js`, and **a running dev
   server never sees a new function in a `lib/` file** (Node caches the module; the vite plugin only
   cache-busts `api/`). Until you restart, a client report's title says 2026-08-30 and its body still
   says 2026-08-31 — in the same document.
2. **Make the platform API key.** `aisyndicate.com` → Dashboard → **API** → tick **"Can verify
   (write)"** → create → paste into `PLATFORM_SCORE_KEY` in `.env.local` (the steps are written there
   too). Copy to Bitwarden. Then restart dev again.
3. **Press Scan on one firm.** **No scan has ever been run.** That first press is the real test of
   §56.5 and nothing about it should be assumed.
4. **Delete the test data if you want it gone.** `ZZ TEST — Dry Run Realty` and four tasks are real
   rows in the live database. The tasks can be deleted from the task modal. **The client cannot be
   deleted from the console at all** — see the gap list below.
5. **Sign the rep window back in** if you still want the rep-side Gmail check. Tonight's attempt was
   stopped by Google, not by us (see below).

---

## What changed tonight

| | |
|---|---|
| **A rep's Gmail sign-in** | Landed on the shared team inbox — a page reps cannot open — so a connected mailbox showed nothing at all. Fixed. The whole routing rule is now `src/lib/pageForAddress.js` with its own tests, because inside the component nothing could reach it. |
| **Connecting a mailbox** | Only **@aisyndicate.com** accounts can. Google blocks personal Gmail with `Error 403: org_internal` **before our code runs**, so nothing can catch it — the connect screen now says which address to use up front. |
| **Two people named "Ryder Schilling"** | Every picker drew them identically. A task on the wrong one was **proven missing from the Work page**. One rule in `src/lib/people.js`, applied in four files. |
| **A sales rep + Operations** | A rep can no longer be given an Operations task. They have no Operations page, so it was work into a black hole. A task already on one still shows, marked. |
| **Dates** | "With us" read a client starting *tomorrow* as "1h ago"; `timeAgo` treated every future time as the past; a **client report was headed with tomorrow's date** after 7pm. All fixed. |
| **The scan** | **Never blocked on Andrew.** Contract read out of the platform repo, production probed: it answers 401 (no key), not 503 (API off). URL wired, fast scan requested, the platform's category list read as pitch findings. **Only the key is missing.** |
| **"Scan site"** | Was the same faint grey as "no site". Now a tinted chip with an arrow. |

Five new test suites: `page-for-address` (34), `time-ago` (33), `people` (63), `connect-problem` (28),
`platform-scan` (29). Every existing suite re-run, nothing failed, `npx eslint src lib api tests`
clean.

---

## Gaps found and deliberately NOT closed

- **A client cannot be deleted.** `deleteClient()` exists in `src/lib/data.js` and nothing calls it.
  A client added by mistake is permanent.
- **Overview takes ~30 seconds to load** (Work ~15) with one client and four tasks on the books.
  Overview is the landing page.
- **`AUDIT_RUNS_PER_HOUR = 6`** on the platform, per workspace — six scans an hour for the whole
  team, against 3,663 firms. One line, platform side. **This is the real thing to raise with Andrew,
  not a URL.**
- **The "company online profile" half of the scan is not built.** /v1/audit reads the website only.
  The platform has `brand-serp`, `brand-monitor`, `brand-snapshot`, `reputation` and
  `agency-prospect-report`; none were read or tested and nothing is claimed about them.
- **`.env.local` still has a bare secret on a line of its own** with no `NAME=` in front of it,
  under the `openssl rand -base64 32` comment. It is read as nothing.
- **`GMAIL_REDIRECT_URI` points at localhost.** Right for this Mac. If that value is also in Vercel,
  every mailbox connect on the deployed console sends people to localhost and cannot finish.
- **The rep view has still never been driven** (§52 said this; it is still true).

---

## Two rules worth carrying out of tonight

**An endpoint that redirects cannot know who is coming back.** Any server-side bounce that names a
page names it for every role at once, and the role gate on the other side quietly re-aims it.

**"Only Andrew knows" was a note, not a measurement.** The platform repo was on this Mac the whole
time and the endpoint answered a probe from a browser tab in ten seconds. Read the code and probe the
endpoint before escalating to a person.

And a smaller one that cost a round trip: **half a fix is the dangerous kind.** The first version of
the two-Ryders label appended the whole email address, and the table cell truncated it back to
identical — while looking disambiguated.
