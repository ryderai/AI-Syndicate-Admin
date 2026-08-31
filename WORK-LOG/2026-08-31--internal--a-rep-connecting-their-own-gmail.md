# A rep connecting their own Gmail — the sign-in came back to a page they cannot open

Mon 31 Aug 2026 · internal · admin console

## The one-line version

A sales rep who connected their own mailbox was sent, by our own callback, to the SHARED
team inbox — a page a rep may never open. They fell through to Overview, the "Mailbox
connected" message was never drawn, and their own Gmail page was two clicks away with
nothing on screen telling them to go there. The mailbox WAS connected. It looked like
nothing had happened.

## What was actually wrong

`api/gmail-callback.js` finishes every Google sign-in by redirecting to
`#/dashboard/inbox?gmail=connected&account=...`. That endpoint runs before anything knows
who signed in, so it names ONE page for everybody, and `inbox` is owner/admin only
(`SECTIONS` in `Sidebar.jsx`). `AdminDashboard.jsx` correctly refuses to route a rep to a
page their role does not carry and drops them on their landing page — Overview — which
does not read `?gmail=`. Every part behaved as designed. The feature was still unreachable.

The fix is one entry in the per-role split map: for `sales`, `inbox` means `gmail`.

## Why the rule moved out of the component

It was ~50 lines of routing decisions living inside a React component that needs a
browser, a signed-in member and a live Supabase to render, so **no test in this repo could
reach it** — which is why a wrong answer sat there. It is now `src/lib/pageForAddress.js`,
comments and all, with `tests/page-for-address` (34 checks) pinning it. Behaviour did not
change in the move; `AdminDashboard.jsx` calls one function and destructures the same four
values it used to compute inline.

The test asserts the thing that broke AND the general shape of it: **every entry in
`SPLIT_FOR_ROLE` must point at a page that role actually has.** A split pointing at a page
the role's own menu does not carry falls back silently, which is the exact class of bug
this was.

## Proved, and how

- `tests/page-for-address` — 34 checks, 0 failed.
- `npx eslint` on the three touched files — clean.
- Driven in a real browser at `localhost:5173`, signed in as owner:
  - `#/dashboard/clients?id=smoke-test` still renders Clients and keeps the id — the
    refactor did not eat a deep link.
  - `#/dashboard/inbox?gmail=connected&account=demo@x.com` renders the Inbox and draws
    the green **Mailbox connected** toast — the bounce-back path still works for an owner.
  - growth@aisyndicate.com loaded **25 real threads**. The Gmail OAuth, the stored refresh
    token and the thread read are live on this machine.

## NOT proved

The rep half was not driven end to end: the browser this session can drive is signed in as
the owner, and a rep's Google consent screen is not ours to click. The rep path is pinned
by the tests above and by the same code every other role runs.

## Two things found on the way, neither fixed here

1. **`.env.local` has a bare secret on a line of its own**, directly under the
   `openssl rand -base64 32` comment, with no `KEY=` in front of it. It is not being read
   as anything. Whatever it was meant to be is unset.
2. **`GMAIL_REDIRECT_URI` is hardcoded to `http://localhost:5173/api/gmail-callback`.**
   Right for this machine. If that value is also in Vercel, every connect on the deployed
   console sends people to localhost and the sign-in cannot complete. The deployed value
   has to be the production address, and that exact URL has to be listed in the Google
   Cloud OAuth client's Authorized redirect URIs.

## Files

```
src/lib/pageForAddress.js          new — the whole routing rule
tests/page-for-address/test.mjs    new — 34 checks
tests/page-for-address/run.sh      new
src/components/AdminDashboard.jsx  modified — calls it, ~50 lines lighter
```
