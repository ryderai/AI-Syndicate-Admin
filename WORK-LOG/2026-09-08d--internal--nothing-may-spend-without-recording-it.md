# Nothing may spend without recording it

**8 September 2026, fourth session.** Internal. Follows
`2026-09-08c--internal--a-vendor-that-is-not-an-llm-still-sends-a-bill.md`,
which is **shipped and verified live**.

**Nothing here is pushed.** One repo this time: `ai-syndicate-admin`.

---

## The 30-second version

Ryder's instruction: *"if anything is running and using tokens then we need to
be tracking it."* So I audited both repos for anything that spends, and whether
it is tracked.

**Token spend was already complete, and that was luck rather than design.** All
eight admin handlers that can reach a model API do record; `converse()` totals
its usage across every billed round; the handlers even record `err.partialUsage`
when it throws part-way. Nothing was missing. But **this repo had no guard at
all** — no `scripts/` directory — so a ninth handler would have shipped
unrecorded with nothing going red.

**Two things were genuinely spending untracked:** Apollo people-search and the
platform lead generator, both billed per search, both called from
`api/lead-scrape.js`, both recorded nowhere. Same shape as searchapi.io and
zernio.com, which spent unseen for two months.

Both are recorded now, and a five-check guard runs on every `npm run lint`.

---

## What changed — 6 files, 1 new directory

- **`scripts/check-ai-usage.mjs`** (new) — the guard. Five checks, wired in as
  `check:aiusage` and run before eslint.
- **`api/lead-scrape.js`** — Apollo and the platform lead generator now write
  one usage row per search, via a new `recordLeadSearch()`.
- **`lib/ai-usage.js`** — new exported `LOCAL_TOKENLESS_PROVIDERS`, and
  `recordAiUsage` now marks those `meta.tokenless` instead of
  `meta.tokensUnknown`.
- **`tests/ai-cost/test.mjs`** — sections 9 and 11, 22 new assertions.
  **389 passed, 0 failed** in five timezones.
- **`package.json`** — the lint wiring.
- **`README.md`, `SETUP.md`** — the `admin.aisyndicate.com` corrections (see the
  separate note at the end).

---

## ⭐ THE SAME DEFECT, FOUND FOR THE THIRD TIME IN ONE DAY

`api/usage-ingest.js` — where the **platform's** spend arrives — already knew
the difference between *"this vendor has no tokens by its nature"* and *"this
call failed to report its tokens"*. It has to: a provider missing from its list
is stamped `meta.tokensUnknown`, which the AI Cost page renders in its
**metering-is-broken banner**, and its per-call price is discarded.

`recordAiUsage` — where **this console's own** spend goes — writes straight to
`admin_usage_events` and never learned the distinction. It stamped
`tokensUnknown` on any row with no usage. So the moment Apollo was recorded, it
would have been reported as a **failed measurement** rather than a real call we
cannot price from tokens.

Fixed on this path too, and the two lists are deliberately separate:
`ADMIN_TOKENLESS_PROVIDERS` mirrors the platform's providers and must match it
exactly; `LOCAL_TOKENLESS_PROVIDERS` is for vendors this console calls itself. A
test asserts no vendor is in both, because they answer different questions.

## ⭐ AND A CLAIM I HAD TO WITHDRAW

Two comments I wrote said a per-call **price row** would make these vendors'
cost appear. **It will not.** `costMicros()` returns null whenever `usage` is
null, *before* it consults a price, so a per-search fee cannot be expressed in
the price book as it stands — it needs the `per_call_micros` column that is
still open in both repos.

That sentence would have sent somebody to add a price row and believe the number
had been fixed. Both comments now say what is true, and a test asserts
`costMicros(price, null) === null` so nobody re-discovers it the hard way.

---

## What the checker found — 15 defects, and the two worst were mine

One adversarial pass over my own work, told to assume it was wrong.

1. ⭐ **The check guarding the searchapi/zernio defect passed silently.** It read
   `api/usage-ingest.js` with a bare `readFileSync` instead of the
   comment-stripped source, so a provider **commented out inside the Set's own
   brackets** satisfied the scrape while the runtime Set no longer contained it.
   Exit 0, and zernio back in the metering-broken banner. The file's own banner
   claimed *"EVERY TEXT TEST BELOW RUNS ON CODE WITH THE COMMENTS REMOVED"* —
   false, 119 lines below where it said it. **One identifier.**
2. ⭐ **`feature: "leads"` and `surface: "console"` are not valid values.**
   `FEATURES` has `lead_scrape`; `SURFACES` has `leads` — and `oneOf()` silently
   rewrites anything else to `other`/`unknown`. So every Apollo row was filed as
   **unattributable while looking correct**. The two values were swapped.
   Nothing caught it because no test passed `feature` or `surface`.
3. ⭐ **The dedupe key got it wrong in both directions.** It used `new Date()` at
   write time, not the run's own `startedAt`: two genuinely different runs of the
   same source inside the same minute collapsed to **one** row, and because the
   unique index on `event_key` is not partial and 23505 is deliberately not
   reported, **a real billed search vanished with no trace**. Meanwhile a Vercel
   retry of a timed-out run landed in a later minute and was not deduped at all.
   Keyed on `startedAt` now — a retry reuses it, two runs never share it.
4. **Recording on the failure path counted searches nobody was charged for** — a
   401, a DNS failure, our own 45s timeout. `fetchApollo` now flags whether the
   vendor actually *answered*; a call that never reached them is not recorded at
   all, and a refusal is written `billable: false` with `meta.billedUnknown`.
5. **The whole point was untested.** Deleting the success-path recording left the
   guard AND all 375 assertions green, because the guard can only see that the
   file contains a `recordAiUsage` call *somewhere*. Section 11 now drives the
   real `runSource` against a stubbed socket.
6. **The second paid provider in the same function still recorded nothing** —
   `fetchPlatform`, whose host comes from an env var so no text check could ever
   see it. Recorded now, as `platform-leadgen`.

### The guard's own holes, all closed and each proved

Seven ways to spend money and pass, found by the checker:

| bypass | why it worked |
|---|---|
| `import { draft } from "../lib/ai"` | extensionless — `transportIsConfigOnly` **returned true when it found no matching line**, so it was exempted as config-only |
| `import * as ai from "../lib/ai.js"` | a namespace import matched no named-import list |
| `await import("../lib/ai.js")` | the import regex required whitespace after `import` |
| `api/x.ts` | `EXTS` listed three extensions; **Vercel deploys `api/*.ts`** |
| `process.env.EXA_PASS` | the regex wanted the whole word `PASSWORD` |
| a paid **Gemini** call | ⭐ `OURS` exempted `(^|\.)googleapis\.com$` — **a wildcard over every Google API**, including `generativelanguage` and `aiplatform` |
| an import cycle | ⭐ the memo **cached a null produced only by the cycle guard**, so the first handler to touch a cycle poisoned the answer for every later one |

⭐ **Narrowing the googleapis exemption immediately found a real host nobody had
classified** — `businessprofileperformance.googleapis.com` in
`lib/connector-fetch.js`. Free, but it was invisible, which is the point.

⭐ **A guard's default answer must be the unsafe one.** `transportIsConfigOnly`
returning `true` on no match is the whole bug in one line.

⭐ **`must-record-before-use`.** Gemini is now a *reservation*: listing a paid
host is how we remember it costs money, never permission to spend on it. If any
credentialed file names it, **the build fails**. Otherwise adding a registry line
would be the cheapest way to silence the check — the failure mode, not the fix.

### And one my own test caught

`recordAiUsage` appearing in a **comment** satisfied the check, and then a bare
`import { recordAiUsage } from ...` line satisfied it too — a file could import
it, never call it, and pass. Found by mutation-testing the check itself. It
matches `recordAiUsage\s*\(` now: the paren is what separates a call from a
mention.

---

## Proof

- `npm run lint` → **exit 0**. The guard prints: 8 handlers record, the
  token-less list agrees with the platform's, 2 hosts claimed as recorded really
  are, 1 host reserved.
- `bash tests/ai-cost/run.sh` → **389 passed, 0 failed** in five timezones.
  **Exit 2 — the SQL half SKIPPED, which is not a pass.** No migration changed.
- **Every check proved able to fail**, then restored: 9 guard bypasses each
  fail; a commented-out provider fails; a `recorded` claim that stopped being
  true fails; a reserved host being called fails.
- **Every new assertion proved able to fail**, by reintroducing the defect in
  production code: the recording deleted (2 red), each invalid label (1 red
  each), the write-time key (1 red), a refusal counted as spend (1 red), an
  unreached call recorded (1 red), the token-less list emptied (4 red).

**Not verified:** nothing is deployed. No Apollo row has been written in
production — `runSource` only runs when somebody runs a lead source. The first
thing to look at after deploying is whether an Apollo search appears under
**By job → lead_scrape** as a call with **NOT PRICED**, and that the blind-calls
banner does not grow by it.

Every figure remains **METERED**, never **BILLED**.

---

## To push — Ryder, from Cursor

One repo. **On `main`:**

```
cd ~/Documents/AI-Syndicate/ai-syndicate-admin
git add scripts/check-ai-usage.mjs api/lead-scrape.js lib/ai-usage.js \
        tests/ai-cost/test.mjs package.json README.md SETUP.md \
        WORK-LOG/2026-09-08d--internal--nothing-may-spend-without-recording-it.md
git commit -m "Nothing may spend without recording it"
git push origin main
```

Do **not** `git add .` — that repo is full of scratch files and a `_to_delete/`
folder.

`README.md` and `SETUP.md` are in that list for a different reason: they said
**`admin.aisyndicate.com`** in 13 places, which is where every session kept
picking up the dead hostname. The 8 that tell a reader where to go now say
`ai-syndicate-admin.vercel.app`. The 5 that record what is **configured inside
Vercel, Supabase and Google Cloud** were left exactly as written, because each
one is possible evidence of a broken callback rather than a typo — see
`memory/canonical-urls-platform-and-admin_2026-09-08.md`.

**No database change. Nothing to run in Supabase.**

---

## What is still not fixed, in order

1. **`per_call_micros`** in the price book. Until it exists, Apollo, the lead
   generator, SerpApi, SearchAPI, Perplexity, DeepSeek and zernio can only ever
   show a call count. **Blocked on one fact nobody has written down: which
   SerpApi plan we are on.**
2. **The AI Cost page does not split its total by kind.** Unchanged, and still
   the blocker for metering Twilio, Apollo's page placement, Resend, Instantly
   and X.
3. **`SEARCHAPI_KEY` and `ENABLE_SOCIAL_MARKET` are not set in production**, so
   the market sweep makes zero calls. Decide whether it is meant to run.
4. **101 platform handlers still unattributed.** `accuracy.run` is 25% of the
   bill on its own.
5. **Two gaps the guard admits in its own header**: a hostname built by string
   concatenation, and a credential held in a module the calling file does not
   import. Closing the second needs the real import-graph walk the platform's
   `scripts/check-ai-meter-flush.mjs` already has.
6. **The cross-repo token-less parity is still two hand-kept lists.** This
   guard asserts this repo's against a written-out copy of the platform's, which
   forces a deliberate edit but cannot read the platform. The only real fix is a
   check that sees both repos.
7. **Nothing has ever been checked against a provider's real bill.** Anthropic
   Admin key, org owner only — CJ or Andrew.
