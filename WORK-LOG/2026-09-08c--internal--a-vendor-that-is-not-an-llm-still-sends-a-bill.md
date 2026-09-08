# A vendor that is not an LLM still sends a bill

**8 September 2026, third session.** Internal. Follows
`2026-09-08b--internal--the-cost-page-learns-what-the-money-bought.md`, which
is shipped and live.

**Nothing here is pushed.** Commands at the bottom. Two repos again.

---

## The 30-second version

Two vendors we pay every day were not on the AI meter at all — not
undercounted, **absent**. `searchapi.io` (social market reads, billed per
credit) and `zernio.com` (social publishing, billed on an account plan). They
passed `npm run lint` because the lint check could only look for the twelve
hostnames already in the meter's table.

Both are metered now. More importantly, **the defect that let them hide is
closed**: a new lint guard fails the build when any hostname reached with a
credential is neither metered nor written down with a reason. It found three
more paid vendors nobody had listed.

Along the way, two adversarial checker passes found **17 defects in my own
work**, including one that would have filed every single call from both new
vendors as a *meter failure*.

---

## What changed

### Platform (`ai-syndicate`) — 13 files changed, 4 new, +290/−42

- **`lib/ai-meter.js`**
  - `searchapi.io` and `zernio.com` added to `PROVIDERS`; `ZERNIO_API_BASE`
    added to `ENV_HOSTS`. **Both are needed for zernio, and neither is
    redundant** — with the env var unset (its state in production) only the
    literal row matches; with it set, only the env row does.
  - Every `PROVIDERS` and `ENV_HOSTS` row now carries a third element, its
    **`kind`**: `model`, `search`, `render`, `media`, `publishing`, `internal`.
    New exports `PROVIDER_KINDS`, `AI_PIPELINE_KINDS`, `providerKind()`.
  - New exported `TOKENLESS_PROVIDERS` set. `READERS` is now BUILT from it, so
    a token-less vendor cannot be added without a reader.
  - New exported `hasUsageReader()`, so a test can assert reader COVERAGE.
- **`lib/social-reads.js`, `lib/zernio.js`** — the one-line
  `import "./ai-meter-boot.js"` that actually switches the meter on for them.
- **`scripts/check-paid-hosts.mjs`** (new, 377 lines) — the guard, plus the
  written record of which paid vendors the cost page cannot see and why.
- **`scripts/strip-js-comments.mjs`** (new) + its tests — comment stripping,
  done with the repo's own parser. Two hand-rolled versions ate live code.
- **`lib/ai-meter.vendors.test.js`** (new, 10 tests) — behaviour tests that
  call the real clients.
- Six handlers wrapped and labelled: `api/cron/social-publish.js`,
  `api/reddit-accounts.js`, `api/reply-review.js`, `api/social-callback.js`,
  `api/social-connect.js`, `api/social-connections.js`. Metering zernio made
  all six spending handlers by the guards' own definition, so all six needed
  `withAiMeterFlush` and a meter context. **Attribution went 2/103 → 8/109 and
  the 101-item TODO list did not grow.**
- `lib/social-creative.reader.test.js` — a pre-existing red test, unrelated to
  this work, fixed. Node's own `ExperimentalWarning` goes to `console.error`,
  and that test asserts an exact count of `console.error` calls.

### Admin (`ai-syndicate-admin`) — 2 files, +58/−8

- **`api/usage-ingest.js`** — `TOKENLESS_PROVIDERS` was missing `searchapi` and
  `zernio`. Fixed and exported so it can be compared.
- **`tests/platform-usage/e2e.mjs`** — new test 0 compares the two repos' sets
  directly, plus a searchapi event through the whole seam.

---

## ⭐ THE WORST DEFECT WAS MINE, AND IT MADE THE FIX WORSE THAN THE BUG

A provider in `PROVIDERS` with no entry in `READERS` falls through
`readUsage()`'s `if (!reader) return null`, and `null` makes
`recordProviderCall` increment **`misses.noUsage`** — "the meter could not read
this". That number is the one thing that tells a broken meter from a quiet
month, and `api/ai-meter-status.js` serves it publicly.

So the first version of this work took two vendors that were invisible and made
them appear as **~3,100 metering failures a day**. The file's own header warns
about exactly this: *"A body we will not parse is still a call we paid for."*

The existing test that should have caught it read:

```js
for (const p of ["serpapi", "firecrawl", "higgsfield"]) { ... }
```

A hand-written list only ever covers the vendors somebody remembered. It is now
an **exact partition** derived from `TOKENLESS_PROVIDERS`, checked both ways.
Proof it bites: converting `firecrawl` to a token reader was green before and
is red now.

## ⭐ AND THE SAME DEFECT EXISTED ONE HOP DOWNSTREAM, IN THE OTHER REPO

The admin's `api/usage-ingest.js` keeps its **own copy** of the token-less
list — the two repos cannot import from each other. It was not updated, and
nothing anywhere went red. The consequences:

1. Every searchapi and zernio row got `meta.tokensUnknown`, which the AI Cost
   page renders in its **"N calls reported no token counts"** banner. The
   metering-is-broken banner. Vendors with no tokens *by their nature* reported
   as failed measurements.
2. `priceableFromTokens` stayed false, so `priced.costMicros` was discarded —
   **adding a per-call price row for either of them would have changed nothing
   on screen.** That is verbatim the ~1,300-SerpApi-calls hole that the comment
   directly beneath it says was already closed once.

**The lesson: a fix that crosses a repo boundary is not finished in one repo.**
Verified in step by executing both modules and comparing the sets — not by
reading them.

---

## ⭐ THE GUARD: A CREDENTIAL IS THE TELL

`scripts/check-ai-meter.mjs` asks "does every file naming a hostname the meter
knows about boot the meter?" — a good question, and the wrong one. It can only
see the twelve hostnames already in the table.

The new guard asks the opposite: **is any hostname reached WITH A CREDENTIAL and
neither metered nor classified?** A vendor that charges money needs a key. Any
non-test file under `lib/`, `api/`, `src/` or `scripts/` that shows a credential
must have every hostname it names classified — metered, or one line in a
registry with a reason **and where that reason came from**.

```
✓ paid-hosts: 66 unmetered hosts classified, 158 credentialed files scanned.
  6 paid and deliberately off the meter, 11 billing model not settled
  — that is 17 vendors whose money the AI Cost page cannot see.
  13 classification(s) are marked unverified: nobody has checked the vendor's own docs.
```

It found three server-side vendors nobody had listed: `api.ads.openai.com`,
`ssl.bing.com`, `yourblog.ghost.io`.

**Every one of these four failure modes was proved by breaking it and
restoring:** an unclassified host fails; a stale line fails; a host that became
metered and was left in the registry fails; a line with no reason fails.

### What the guard cannot do, in its own header

Twenty-two bypasses were tried. **Twenty are closed. Two are open and named in
the file**: a hostname built by string concatenation, and a credential held in a
sibling module while a different file makes the call. Closing the second needs
the real import-graph walk `scripts/check-ai-meter-flush.mjs` already has.

### ⭐ THE CREDENTIAL TEST THAT DOES NOT LOOK AT VARIABLE NAMES

The first regex wanted `KEY|TOKEN|SECRET|PASSWORD|SID|CREDENTIALS`. Ten shapes
walked past it: `NV_AUTH`, `NV_PW`, `NV_CRED`, `NV_ACCESS`, `NV_SIGNATURE`,
`NV_PRIVATE`, lowercase `vendor_key`, `process.env["NV_KEY"]`,
`const { NV_KEY } = process.env`, and `` `Bearer ${process.env.NV_TOK}` ``.

That last one is the point. **An `Authorization: Bearer` header is a stronger
tell than any spelling of a variable name**, and the first version did not look
at it. The check is now a list of tells, and the strongest do not look at names
at all.

One asymmetry worth keeping: the header tells apply only to server roots.
`src/` is the browser bundle — it cannot read a secret, and its components talk
*about* API keys in copy the customer reads. Applying header tells there pulled
in 32 hostnames that were documentation links in a dashboard.

---

## ⭐ A HAND-ROLLED SCANNER FOR A LANGUAGE THE REPO ALREADY PARSES

The guard has to ignore comments (a doc URL in a comment is not spend). Three
versions:

1. **Two regexes.** A comment-opening sequence inside a **string literal** —
   `"/api/*/foo"`, a Windows path — opened a comment that ran to the next
   closing marker anywhere later in the file, deleting the credential and the
   hostnames. The file was then skipped as "no credential" **with no warning at
   all**. A guard whose failure mode is silence.
2. **A character scanner** tracking quotes, templates and regex literals by
   hand. Better, still wrong: it cannot read JSX. In `</h3>` the slash follows
   `<`, which looks like a regex opening, and from there it is desynchronised.
   It ate live code in **five real `.jsx` files** and lost three hostnames —
   and which lines survived depended on slash parity.
3. **espree**, which is already here because eslint is, and is the same parser
   `npm run lint` runs over these files. Verified across **all 1,173 source
   files: 0 unparsed, 0 string literals changed, 0 hostnames lost.**

Fail-safe by design: an unparsable file is returned **unchanged**, comments and
all. Keeping comments can only ask somebody to classify one more host. It can
never produce silence.

---

## ⭐ THE DECISION ABOUT TWILIO, APOLLO, RESEND AND INSTANTLY

Written into `scripts/check-paid-hosts.mjs`, where the build reads it.

**THE RULE:** a vendor goes on the meter now if it is AI-pipeline spend
(`AI_PIPELINE_KINDS`: model, search, render, media, internal). A **non-AI**
vendor goes on now only while it adds **no dollars and negligible volume**, and
otherwise waits for the AI Cost page to split its total by kind.

The second half exists because the page is called **AI Cost**, and its headline
is what an owner reads when they ask what the AI bill is. Folding text messages
and cold email into that number makes the label wrong in the other direction —
the same class of defect as a client report whose summary sentence disagrees
with its own table.

How it lands:

| vendor | metered? | why |
|---|---|---|
| `searchapi.io` | **yes** | `search` — plainly AI-pipeline |
| `zernio.com` | **yes** | `publishing`, the exception: **no price row**, so $0 in the money column and calls only, exactly as SerpApi behaves today; and only zernio-backed connections reach it, which may be none. Metered while that is true, not after it grows |
| twilio, apollo, resend, instantly | no | volume. `review-requests-send` alone drains up to 25 recipients every 15 minutes — that call count would swamp a page labelled "AI Cost" |
| `api.twitter.com`, `api.search.brave.com` | no | **named as the next two rows.** Brave is the same `search` kind as three metered SERP vendors, with no defensible reason it is not one of them |

⭐ **The moment somebody adds a price row for zernio, the page must already
split by kind**, or publishing spend lands inside a total labelled "AI". That is
stated in `lib/ai-meter.js` and asserted by a test that lists, by name, every
metered provider outside `AI_PIPELINE_KINDS`.

**And the honest part:** `AI_PIPELINE_KINDS` has **no consumer**. `kind` is not
on the wire and the admin page does not read it. It is a declared interface with
a named consumer that does not exist yet, and `lib/ai-meter.js` says so in those
words rather than implying the split is done.

---

## ⭐ A TEST DERIVED FROM THE THING IT CHECKS PROVES NOTHING

Third time this exact lesson has been logged in three days, and it caught two
more tests written today.

- The duplicate-kind test built its expectations from the same two arrays it
  was checking. Retagging **anthropic** — the largest spender — from `model` to
  `publishing`, taking it out of the AI total entirely, left **all eight tests
  green**. It now carries an `EXPECTED_KINDS` table written out by hand, checked
  in both directions, so a new vendor fails until somebody states its kind.
- `tokenless >= 6` against 7 actual was a floor slack enough to hide a
  regression. Now an exact partition.

**A test needs an independent statement of the truth.** Derivation is not one.

---

## What the checkers found

Two adversarial passes, both told to assume the work was wrong. **17 defects.**
The second pass was pointed at the first pass's *fixes*, and found 8 — including
the two above and a fix that broke the thing it was fixing (widening the stale
check to all files made a metered-and-still-listed host pass, which is the one
case that check exists for).

Corrected facts, all re-checked against vendor documentation:

- **`api.yelp.com` has no free tier.** $229/mo minimum plus $5.91 per
  additional 1,000 calls. It was filed as "free tier then paid", printed under
  "billing model unchecked", which reads as *possibly free*. Now `paid`.
- **X has no free tier either**, and it is not "a paid tier": it is
  pay-per-usage, **$0.015 a post, $0.200 for a post with a URL**. The old
  sentence described a tier that no longer exists.
- **`maps-api.apple.com` and Square's sandbox are free** and were filed as
  unconfirmed. Both settleable from the vendor's docs.
- **`ai.azure.com` is an OAuth scope string**, not a portal URL.
- **`www.reddit.com` is Reddit's OAuth token endpoint**, not "public JSON
  endpoints".
- **"free at our volume"** for `www.googleapis.com` was a claim nothing
  supports — nothing measures our volume. It also named the wrong risk: a
  YouTube quota is a **403 hard stop, not a bill**, and `search.list` costs 100
  units a call against 10,000 a day.

Every registry line now carries a **`source`**: `vendor-docs`, `our-code` or
`unverified`. **Thirteen are `unverified` and the check prints that count**, so
"nobody has checked" can never read as "checked and free".

### Every volume number in the meter's comments was a ceiling written as a rate

`social-market-sweep`: cron frequency × `PROFILES_PER_RUN` × `MAX_CREDITS_PER_PROFILE`
= 720/day. True ceiling, **not a measurement** — a withheld feed costs 1 credit
not 5, and it reads zero when nothing is due. `social-trends` was described as
"~60/day adding to" a 2-hourly job; it runs **once a day**, and 60 is
`MAX_GEOS_PER_RUN`, a cap the ~52 US geos cannot reach. `social-publish`'s 2,400
is a ceiling **on a superset** — only zernio-backed connections reach zernio.

All rewritten as ceilings, with "nothing here is measured" said out loud. Given
this file exists because two vendors spent money unseen for two months, a
ceiling written as a rate is the same class of error it was built to catch.

---

## Proof

- **Platform:** `npm test` → **3,797 tests, 3,792 pass, 0 fail, 5 skipped** (the
  documented Node-24 skips). `npm run lint` → **exit 0**.
- **Admin:** `npm run lint` → **exit 0**. `bash tests/ai-cost/run.sh` →
  **367 passed, 0 failed** in five timezones, **exit 2 — the SQL half SKIPPED,
  which is not a pass.** Nothing here touches SQL or a migration.
- **The metering was watched end to end**, real clients building their own URLs:
  ```
  vendor URL hit: https://www.searchapi.io/api/v1/search?engine=google_trends_trending_now&geo=US
  vendor URL hit: https://zernio.com/api/profiles
  misses: {"noUsage":0,"readFailed":0,"sendFailed":0,...}
  posted: provider=searchapi status=ok input_tokens=null kind=search   inAiTotal=true
          provider=zernio    status=ok input_tokens=null kind=publishing inAiTotal=false
  ```
- **The two repos' token-less sets were compared by executing both modules**,
  not by reading them: identical, 7 names each.
- **Every new guard was proved able to fail** and then restored, with
  `git status` checked after: each of the three new table rows deleted in turn;
  a contradicted `kind`; a missing reader; `firecrawl` given a token reader;
  `publishing` sneaked into the AI total; `anthropic` retagged; the two-regex
  stripper reinstated (5 of 13 red); and the four guard failure modes.
- **22 lint bypasses attempted, 20 closed, 2 open and named in the file.**
- **The stripper was verified against all 1,173 source files**: 0 unparsed,
  0 string literals changed, 0 hostnames lost.

**Not verified, and it cannot be from here:** nothing is deployed. No searchapi
or zernio call has been metered in production, and the AI Cost page has not been
looked at since. The first thing to check after deploying is whether searchapi
and zernio rows appear **as calls with no cost**, and whether the blind-calls
banner stays where it was — if their calls land in that banner, the admin fix
did not deploy. Test 0 in `tests/platform-usage/e2e.mjs` has **never been
executed**; it needs Postgres.

Every figure remains **METERED**, never **BILLED**. Nothing in this system has
ever been checked against a provider's real bill.

---

## To push — Ryder, from Cursor

Two repos. **Admin first**, because if the platform ships alone, searchapi and
zernio rows land in the AI Cost page's metering-is-broken banner.

**1. `ai-syndicate-admin` — on `main`:**

```
cd ~/Documents/AI-Syndicate/ai-syndicate-admin
git add api/usage-ingest.js tests/platform-usage/e2e.mjs \
        WORK-LOG/2026-09-08c--internal--a-vendor-that-is-not-an-llm-still-sends-a-bill.md
git commit -m "A token-less provider is not a failed measurement"
git push origin main
```

Do **not** `git add .` — that repo is full of scratch files.

**2. `ai-syndicate` — a branch off `origin/main`, never local `main`:**

```
cd ~/aisyndicate/ai-syndicate-live
git fetch origin
git checkout -b fix/meter-the-invisible-vendors origin/main
git add lib/ai-meter.js lib/ai-meter.test.js lib/ai-meter.vendors.test.js \
        lib/social-reads.js lib/zernio.js lib/social-creative.reader.test.js \
        api/cron/social-publish.js api/reddit-accounts.js api/reply-review.js \
        api/social-callback.js api/social-connect.js api/social-connections.js \
        scripts/check-paid-hosts.mjs scripts/strip-js-comments.mjs \
        scripts/strip-js-comments.test.mjs scripts/check-ai-meter.mjs package.json
git commit -m "A vendor that is not an LLM still sends a bill"
git push -u origin fix/meter-the-invisible-vendors
```

Open the PR, wait for `CI / Lint` to go green, merge.

⚠️ **One thing to watch on the branch.** The local `origin/main` ref in that
folder is stale at `90fdc63` (PR #2052) — the mount has no network, so it has
not seen #2053. `git fetch origin` above fixes that. If `git checkout -b ... origin/main`
lands somewhere without `fillAiMeterContext` in `lib/ai-meter.js`, the fetch did
not take; stop and say so rather than committing on top.

**3. No database change.** Nothing to run in Supabase.

**4. To check it worked:** open the AI Cost page, **Cmd+Shift+R** (that page has
served a stale copy before), and look at **By provider**. `searchapi` and
`zernio` should appear with a call count and **no cost** — and the
"calls reported no token counts" banner should **not** have grown by their
volume. If it did, the admin push did not land.

---

## What is still not fixed, in order

1. **The AI Cost page does not split its total by kind.** `lib/ai-meter.js`
   carries `kind` and `AI_PIPELINE_KINDS`; nothing reads them. This is the
   blocker for metering Twilio, Apollo, Resend, Instantly and X, and it is the
   blocker for ever pricing zernio.
2. **`api.search.brave.com` and `api.twitter.com`** — the next two rows. Brave
   is straightforwardly `search` and should already be metered.
3. **101 handlers still unattributed.** The TODO list in
   `scripts/check-ai-meter-context.mjs` is the ordered queue. Start with the
   three that spend before they know the tenant — `accuracy-watch.js` is 18% of
   the whole bill on its own.
4. **`per_call_micros`** for SerpApi, Perplexity, DeepSeek — and now SearchAPI.
   **Blocked on one fact nobody has written down: which SerpApi plan we are
   on.** With the admin fix above, a price row for a token-less provider will
   finally take effect.
5. **Three workspaces spending money attached to no client** ($1.92); **$9.16
   across 1,313 calls with no workspace at all.**
6. **Port the platform's lint guards to the admin repo.** That repo has no
   `scripts/` directory, `recordAiUsage` is remember-to-call at ~11 sites in 8
   files, and there is a confirmed miss at `api/lead-scrape.js:73`. It is also
   the only way to guard the two copies of `TOKENLESS_PROVIDERS`.
7. **Two lint bypasses remain open**, named in `scripts/check-paid-hosts.mjs`:
   a concatenated hostname, and a credential in a sibling module.
8. **Nothing has ever been checked against a provider's real bill.** Needs an
   Anthropic Admin key, which only an org owner can create — CJ or Andrew.
9. **11 vendors' billing models are unsettled and 13 classifications are
   unverified.** The check prints both counts every run.
10. **The business question is still open and still nobody has answered it:**
    do we tell clients we cover Mistral and Meta AI? Yes → one batched ask to
    Andrew. No → switch both engines off. Rate limits went 384 → 1,494 in a
    day, all unbilled, so it is not urgent.

**Note:** this device runs Node **22.23.2** while `package.json` `engines` asks
for **>=24**. Everything above was measured on 22. Pre-existing, worth knowing.
