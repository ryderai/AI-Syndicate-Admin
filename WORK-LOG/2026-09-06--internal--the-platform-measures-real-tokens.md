# The platform measures real tokens — 6 Sep 2026

One session. Two repos. Nothing pushed, nothing deployed, no migration run.
The clicks are in `DO-THIS-NEXT-token-metering-2026-09-06.md`.

## What Ryder asked for

Three things: get the tokens reading and count usage accurately; a delete
client button; and a plan for tracking usage across the whole business so it
can be made more profitable.

## What was already there

**The delete client button has been live since 31 Aug.** Operations/Clients →
open a client → Edit → "Delete this client…", owner only. It counts the tasks
live, names the ten tables that go and the seven that survive, and makes you
type the client's name. Proved end to end in production: a throwaway client
"ZZ TEST delete proof" was created, a WRONG name left the button dead, the
right name deleted it, the list went 7 → 6, and it was still gone after a full
reload. Nothing was built for this.

**The AI Cost page has been live since 29 Aug and has recorded 0 calls, ever.**
`ANTHROPIC_API_KEY` is not set in the admin console, so the console's own eight
AI routes have never billed anything.

## The finding

**The platform had never measured a single real token.** 40 source files call a
paid model API across eight providers, and every one of them reads the answer
and throws `body.usage` in the bin. Every cost figure in this business — the
`PLAN_TOKEN_COSTS` table, `estCogsMicros`, the whole Action price list — is a
number somebody typed. The database column built to hold the real figure,
`plan_token_ledger.actual_cogs_micros`, is NULL on every row in production
because the only thing that writes it has never been called.

That is why "$1,000 of credits in three days" on 2 Sep was a surprise rather
than a number somebody was already watching.

## The build

A wrapper around `globalThis.fetch` that matches provider hostnames, reads the
usage off the response and posts it to the console's `/api/usage-ingest`, which
was built on 28 Aug and had never received an event.

Editing 38 call sites was considered and rejected: there is no single AI client
to patch (34 raw fetches, 10 through `model-json.js`, four near-identical
private `postJson` helpers, seven providers that never touch `model-json.js`),
38 edits is unreviewable, and the 39th call site would be invisible. The
wrapper catches everything; two new lint checks make the 39th impossible to
forget. Both are in `npm run lint` and both were broken on purpose and watched
to go red.

On the console side: migration 0032, a `workspace_id → client` mapping the
console refuses to guess (it lists the unmapped ones instead), and
`lib/client-economics.js` — AI cost beside invoice revenue, per client, worst
deal first.

## Six defects in code that already existed

1. `admin_usage_events.input_tokens` was `not null default 0` since 0001, so a
   paid call with no tokens could not be stored at all.
2. **`cost_usd` was `not null default 0` while `api/usage-ingest.js` has written
   NULL for an unpriced call since 28 Aug.** The first batch containing one
   non-Anthropic model would have been refused whole, as a 500 — and it would
   have looked like the new meter was broken on day one.
3. The endpoint dropped every event whose tokens were not numbers. ~1,300
   SerpApi calls per AI Local edition, silently.
4. `api/lead-email.js:247` files every lead outreach email under "other".
5. `lib/ai.js:164` bins a `usage` object it already has.
6. `Finance.jsx` and `Overview.jsx` read `listUsage()` and ignore
   `truncated`/`partial`.

4, 5 and 6 are follow-ups, not done.

## And seven of my own

Two separate checker agents, told to assume the work was false, found 29 and
then 13. The ones that changed the design:

- **A module-level variable for attribution is wrong under concurrency.**
  `brand-alerts` scans 5 workspaces at once; the last to charge won for every
  call in flight. That does not lose attribution, it puts one client's bill on
  another. `AsyncLocalStorage` now.
- **A margin over three different time windows is not a margin.** 30 days of
  cost against all-time revenue.
- **A Postgres view ignores RLS unless marked `security_invoker`.** Both new
  views handed a sales rep the whole agency's spend, under a comment claiming
  the opposite.
- **The end-to-end test could never run**: a static `import pg` above its own
  skip guard, and `pg` is not a dependency.
- **A `const` used before its declaration** threw at run time, invisible to the
  build, the lint and every unit test. Only the end-to-end test caught it.

## Proof

Platform 3,369 pass / 0 fail / 5 skipped, lint clean. Admin 3,332 + 28 pass /
0 fail, eslint clean, build clean in the cloud container (183 modules). All 32
migrations on a real Postgres 16, 39 SQL checks. End to end 3/3 through the
real endpoint into a real database. 20 mutants killed across the two new pure
modules; two of my own tests were found unfalsifiable that way and rewritten.

Not run, and it matters: `tests/auth-gate` (no playwright) and
`tests/inbox/test.mjs` standalone. A skip is not a pass.
