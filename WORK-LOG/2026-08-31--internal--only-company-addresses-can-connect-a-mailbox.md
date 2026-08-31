# Only @aisyndicate.com addresses can connect a mailbox — and why "let any email connect" is not a switch

Mon 31 Aug 2026 · internal · admin console

This follows `2026-08-31--internal--a-rep-connecting-their-own-gmail.md`. That entry fixed
where the Google sign-in LANDS. This one is about a second wall behind it, found the moment
the first was fixed.

## What happened

Ryder pressed Continue with Google in the rep window, picked `ryderschilling@gmail.com`,
and got, on Google's own page:

> **Access blocked: AI Syndicate Admin can only be used within its organization**
> Error 403: org_internal

No code of ours ran. **The browser is never redirected back**, so there is no callback, no
`?gmail=error`, and nothing this console can catch or report.

Cause: the Google Cloud OAuth app's **Audience is Internal**, so Google only lets an
@aisyndicate.com Workspace account grant it anything.

## The ask, and the honest answer

Ryder: *"can we just make it so that any email can connect?"*

Not tonight, and not by flipping a setting. Flipping Audience to External makes it worse
before it makes it better, for two measured reasons:

1. **We ask for `gmail.modify`, which Google classes as a RESTRICTED scope** (`gmail.send`
   is only *sensitive*; `gmail.modify` — read, compose, send — is restricted, and so are
   `gmail.readonly` and `gmail.compose`). Restricted scopes on an External app need OAuth
   verification **plus a CASA security assessment by a Google-empanelled assessor**, which
   Google's own page says "can potentially take several weeks", must be redone every 12
   months, and needs demo videos of the consent flow.
   There is no scope trick around it: reading a mailbox at all needs a restricted scope.
2. **External + "Testing" issues refresh tokens that expire in 7 days.** So the quick
   version — flip to External, add reps as test users — means every rep reconnects their
   mailbox once a week, for ever, until verification passes.

So the switch that looks like a five-second fix produces either a weekly reconnect chore or
a red "Google hasn't verified this app" warning in front of every rep.

## What the console can already do, today

The domain is the ONLY limit. Everything Ryder asked for is built:

- A rep connects their own mailbox on their Gmail page, sends and replies from it, and no
  other rep can open it.
- An owner/admin has **Connect another** on the Inbox page and a mailbox dropdown, so they
  can hold as many company mailboxes as they like and switch between them.

The prerequisite is a Google Workspace account per rep on aisyndicate.com. A rep without
one cannot use the Gmail page at all — that is a blocker to state, not a bug to chase.

## Built here

The failure a rep sees is now readable, and the one that can never reach us is warned about
before the click.

```
src/lib/connectProblem.js            new — explainConnectFailure() + COMPANY_ADDRESS_NOTE
tests/connect-problem/test.mjs       new — 28 checks
tests/connect-problem/run.sh         new
src/components/admin/Inbox.jsx       the toast reads the plain sentence; the connect
                                     screen names the company address ABOVE the button
```

- Every reason `api/gmail-callback.js` can send now becomes a sentence with an action in
  it. The test **reads the reason strings out of the callback itself**, so a new reason
  added there with no translation here fails the suite.
- An unknown reason is passed through, never swallowed — a friendly sentence that is wrong
  is worse than a raw string.
- `org_internal` cannot be caught, so the connect screen says up front: *"Use your
  @aisyndicate.com address. Google refuses a personal Gmail here before it ever reaches
  us."* If the Audience is ever changed to External that sentence becomes a lie and must
  change in the same commit; the comment above it says so.

## Proved

- `tests/connect-problem` — 28 checks, 0 failed. `npx eslint` clean on both files.
- **NOT driven in a browser.** The console signed itself out of the tab this session was
  driving (it landed on `#/signin`) and this session has no password. The connect-screen
  wording is pinned by the tests reading the real source, not by a screenshot.

## Sources for the two claims above

- Gmail scope classes: https://developers.google.com/gmail/api/auth/scopes
- Restricted-scope verification + CASA: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- 7-day refresh token in Testing: https://developers.google.com/identity/protocols/oauth2
