# Streamed answers now report their tokens — and what a hostile review found in the first draft

**Date:** 2026-09-07
**Repos:** `ai-syndicate-live` (platform). Admin unchanged.
**Status:** written and tested; NOT yet pushed at time of writing.

---

## The 30-second version

Every chat message a customer sends Caite or the site chatbot is a model call
we pay for. Until today none of them were measured — they were recorded as
calls with the token count unknown, because a streamed answer keeps its token
counts inside the stream and there is nothing to read when the request
finishes.

They are measured now. The meter reads a copy of the stream in the background
and records the row when the stream ends.

The first version of that had a bug that would have taken the whole site down.
A separate adversarial review found it, and six other things. All seven are
fixed and each has a test that fails if it comes back.

---

## What was built

`lib/ai-meter.js` — the fetch wrapper that meters every AI provider call. New
section "streamed answers":

- `response.clone()` gives a second copy of the body. The caller's stream is
  untouched.
- The copy is read in the background — **not** awaited — and the row is
  recorded when the stream ends. Awaiting it would hold the answer back until
  the model stopped talking, which is the one thing a streaming endpoint must
  never do.
- `flushAiMeter()` waits, briefly and boundedly, for those background reads
  before it posts.
- Input and cache counts come from Anthropic's `message_start` frame, the
  output count from `message_delta`, and the two are merged. Neither frame
  alone is the answer.

No handler was changed. Any streaming call site, now or later, is metered
automatically.

---

## What the adversarial review found in the first draft

A separate agent was told to assume the code was wrong and to report only what
was broken. Four of its six target claims broke. In severity order:

### 1. A hang that would have poisoned the whole container

`response.clone()` is a stream *tee*, and per the spec a branch's `cancel()`
only settles once **both** branches have cancelled. The first draft did
`await reader.cancel()` in a `finally`. The caller's branch is routinely still
open — `lib/chatbot.js` and `lib/caite-chat.js` both `break` out of their read
loop on a stream error without cancelling — so that await never returned.

Chain of consequences: the read task never settles → it never leaves
`state.streams` → `settleStreams()` waits on it forever → `flushAiMeter()`
never returns → the handler never returns → the request dies at the platform
timeout. And because `state.streams` is module-level, the dead promise stays
there for the life of the warm container and hangs **every later request too**.

Reproduced directly before fixing:

```
meter read: false 5
calling cancel on meter branch while caller branch is live and open...
RESULT: CANCEL HUNG (2s)
```

Fixed: the cancel is fired and forgotten, never awaited.

### 2. One request could stall on another request's dropped connection

`state.streams` is shared across a warm container. `settleStreams()` waited on
it with no time limit, so request A's flush could block on request B's stalled
stream for up to the full read deadline. That is the meter breaking a request
that had already produced a correct answer.

Fixed: the flush waits at most **3 seconds** for background reads, then gives
up and **counts** what it abandoned (`misses.streamLate`). Losing a row is bad;
holding a customer's answer hostage to someone else's dropped connection is
worse.

### 3. An hour-long cache write was billed twice

Anthropic sends the 5-minute / 1-hour cache-write split in `message_start`, but
a **flat** cumulative total in `message_delta`. Merged naively, the flat 340
overwrote the 5-minute 300 while the 1-hour 40 survived — so 380 cache-write
tokens were billed for 340 real ones, and the 1-hour write was charged at both
rates. `readAnthropic`'s own comment says these must never be collapsed.

Fixed with a guard scoped to `message_delta`. The first attempt at that guard
was itself wrong (it nulled the very split it was protecting, because
`message_start` keeps its usage under `message.usage`) and the test caught it.

### 4. Gemini streams were never metered at all

The gate was `requestBody.stream === true`. Gemini has no such field — it
selects streaming in the URL (`:streamGenerateContent?alt=sse`). Every real
Gemini stream fell through unmeasured, **while a test invented a `stream: true`
Gemini request to make the branch look covered**.

Fixed: the gate is now the response's `content-type: text/event-stream`, which
is what actually decides whether the body is SSE. The fictional test was
replaced with the real request shape.

### 5. Gemini thinking tokens were dropped

`readGoogle` read only `candidatesTokenCount`. Gemini reports
`thoughtsTokenCount` separately and it is **not** included in that figure — but
it is billed at the output rate. Every Gemini row understated output by its
whole reasoning budget, an error that always flatters the cost page.

Fixed: thinking tokens are added to output. (Pre-existing, not introduced here.)

### 6. The meter could have posted to itself forever

`flushAiMeter()` posts through the same wrapped `fetch`. `ENV_HOSTS` maps
`PLATFORM_SCORE_URL` to a provider — point that at the admin console, which a
combined deployment does, and every ingest POST is itself metered, pushing an
event, keeping the drain loop alive, posting again. Forever.

Fixed: the wrapper never meters a request to the ingest endpoint. Deliberately
*not* fixed by capturing the original fetch at install time — that would also
step over any instrumentation added later, which is not ours to skip.

### 7. An unmeasured row with no reason

A clean read that found no usage frames produced an all-null row with nothing
saying why, indistinguishable from a read that was cut off. Every unmeasured
row now carries a reason.

### Also corrected: an overstated comment

The first draft claimed the caller's stream "arrives at exactly the same
speed". That is false. A tee enqueues into both branches on any pull, so
reading our branch flat out weakens backpressure toward the provider and the
caller's branch buffers what it has not read. The comment now says so plainly
and the byte cap is what bounds it.

### One more, found by the tests rather than the review

A stalled stream held its 60-second deadline timer and kept the event loop
alive behind it — a test run that took a minute to exit, and an invocation that
would not finish. Background timers are now `unref`'d. The flush's own settle
timer deliberately is **not**, because it is on the critical path of something
a handler is awaiting. Both mistakes were made in turn before the difference
was understood.

---

## Proof

- **24 new tests** in `lib/ai-meter.stream.test.js`.
- **15 mutants, 15 killed.** Seven of them re-introduce the exact findings
  above, so each of those bugs now fails a test if it ever comes back.
- Four tests written in the first draft were **tautological or fictional** and
  were rewritten: one asserted only that a `Response` was truthy; two asserted
  a miss counter without ever checking a row existed; one invented a request
  shape Gemini cannot send.
- Full platform suite: **3,677 pass, 0 fail, 5 skipped.**
- `npm run lint`: clean.
- `npm run build` could not be run here — this Linux VM has `node_modules`
  installed for macOS, so rolldown's native binding is missing. It fails before
  reading any source. The one `.jsx` file touched was parsed independently
  (Babel, 314 top-level statements, 0 syntax errors) and passes eslint.

---

## Separate fix, same push: main's red lint

`src/components/dash/AiAccess.jsx:12430-12431` had two `useMemo` calls **after**
an early return, which is a genuine React bug — on a first render with nothing
scored yet, React sees fewer hooks than on the render after. It came in with
PR #2042 and has been failing `CI / Lint` on main since. Both hooks were moved
above the early return; they depend only on `gsc`, so nothing they compute was
being skipped. Lint is now clean.

---

## What is still not measured, and why

`npm test` on the Mac shows one unrelated failure in
`lib/social-creative.reader.test.js`. It is environmental: the test mocks
`console.error` to capture its own log line, and Node 24 writes an
`ExperimentalWarning` about module mocking into the same capture, so it counts
two entries instead of one. Proved by running the same file with
`--no-warnings`: 9 pass, 0 fail. Not touched — hiding warnings to make a test
green is how real problems get hidden.

---

## The next real blocker, found while verifying

Measuring tokens exactly does not produce a cost figure unless the model has a
price. **The price book contains Anthropic models only.** Read live from the AI
Cost page on 2026-09-07, last 30 days:

| model | calls | in | out | priced? |
|---|---|---|---|---|
| anthropic/claude-sonnet-5 | 67 | 389k | 56k | yes — $1.34 |
| mistral/mistral-medium-3.5 | 32 (32 failed) | 0 | 0 | no |
| serpapi/unknown | 17 | — | — | no (per-call, no tokens) |
| openai/gpt-5.6 | 7 (6 failed) | 0 | 0 | no |
| google/gemini-2.5-flash | 6 | 354 | 2.3k | no |
| groq/openai/gpt-oss-120b | 3 (3 failed) | 0 | 0 | no |
| perplexity/sonar | 3 | 39 | 1.4k | no |
| deepseek/deepseek-v4-flash | 3 | 288 | 4.2k | no |
| xai/grok-4.6 | 3 | 1.9k | 697 | no |
| openai/gpt-5.6-sol | 3 | 1.8k | 2.3k | no |

So `$1.34` is the Anthropic spend only. Every other provider's calls are
counted, their tokens are counted, and their cost is blank — which the page
says out loud rather than showing as zero. This is blocked until priced rows
exist for those models, each with a source, in the dated `ai_model_prices`
table. Prices must be looked up and cited, not estimated: a wrong price is
worse than a blank one, because a blank one admits what it does not know.

Also worth noting from the same page: 51 of 144 calls failed before the model
reported anything, and 32 of those are the mistral model failing every single
time. That is a separate thing worth looking at — a model that fails 32 out of
32 is not a pricing problem.
