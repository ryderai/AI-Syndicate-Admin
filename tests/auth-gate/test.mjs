/* THE AUTH GATE — three outcomes, three different sentences.  Aug 29 2026
 *
 * Driven in a real browser against the BUILT bundle, with every Supabase call
 * intercepted, so all three branches can be forced on demand:
 *
 *   1. the roster read ERRORS   -> "We couldn't check your access" + the reason
 *   2. the roster read is EMPTY -> "This console is team-only"
 *   3. the roster read RETURNS  -> the console
 *
 * WHY THIS EXISTS. Until today src/lib/auth.js did this:
 *
 *     setAuthState({ membership: error ? null : data || null });
 *
 * which threw the error away, so 1 and 2 produced the identical screen. On
 * Sat Aug 29 2026 the live database had lost one grant — `admin_is_member()`
 * to `authenticated` — and every roster read raised "permission denied for
 * function admin_is_member". The console told an owner whose row was present,
 * correct and active that he was not on the team roster. An hour went into
 * hunting a missing row that was never missing.
 *
 * A screen that states the WRONG cause is worse than one that admits it does
 * not know. This test is here so those two can never merge back together.
 */
import { chromium } from "playwright";

const HOST = "fake-test.supabase.co";
const UID = "d917adfc-2abf-4417-b8c3-053b00236f43";
const EMAIL = "ryder@aisyndicate.com";

// A session shaped the way supabase-js stores it, valid for an hour.
const jwt = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, email: EMAIL, role: "authenticated", exp, aud: "authenticated" })}.sig`;
})();
const session = {
  access_token: jwt, refresh_token: "r", token_type: "bearer", expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: UID, email: EMAIL, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
};

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

async function run(name, rosterHandler) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([host, s]) => {
    const ref = host.split(".")[0];
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
  }, [HOST, session]);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));

  // Keep gotrue happy; never let a real network call escape.
  await p.route(`https://${HOST}/auth/v1/**`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(/user/.test(r.request().url()) ? session.user : session) }));
  /* ORDER MATTERS: Playwright checks routes in REVERSE registration order, so
   * the catch-all goes on FIRST and the specific one LAST. Registered the other
   * way round, the catch-all swallowed every admin_users call and all three
   * cases silently collapsed into the same screen — which made this test look
   * like a code failure when it was a test failure. */
  await p.route(`https://${HOST}/rest/v1/**`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await p.route(`https://${HOST}/rest/v1/admin_users*`, rosterHandler);

  await p.goto("http://127.0.0.1:8099/#/dashboard/overview", { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  const body = await p.innerText("body");
  await p.screenshot({ path: `/tmp/ais/auth-${name}.png` });
  await ctx.close();
  return { body, errs };
}

const checks = {};

// 1. THE BUG: the read fails with a permission error.
{
  const { body, errs } = await run("checkfailed", (r) => r.fulfill({
    status: 403, contentType: "application/json",
    body: JSON.stringify({ code: "42501", message: "permission denied for function admin_is_member" }),
  }));
  checks["a failed check says it FAILED, not that you're not on the team"] =
    /couldn.t check your access/i.test(body);
  checks["...and it does NOT say 'team-only'"] = !/team-only/i.test(body);
  checks["...and it prints the database's own reason"] =
    /permission denied for function admin_is_member/.test(body);
  checks["...and it says this is not the same as being turned away"] =
    /not the same as being turned away/i.test(body);
  checks["...no page errors"] = errs.length === 0;
}

// 2. Genuinely not on the roster: still the old, correct screen.
{
  const { body } = await run("notauthorized", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  checks["a real 'no row' still says team-only"] = /team-only/i.test(body);
  checks["...and does NOT claim the check failed"] = !/couldn.t check your access/i.test(body);
}

// 3. On the roster: straight in.
{
  const { body } = await run("allowed", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ user_id: UID, email: EMAIL, full_name: "Ryder Schilling", role: "owner", active: true }),
  }));
  checks["a good row still lets you in"] = /Overview/i.test(body) && !/team-only/i.test(body);
  checks["...and shows no failure screen"] = !/couldn.t check your access/i.test(body);
}

let bad = 0;
for (const [k, v] of Object.entries(checks)) { console.log(`  ${v ? "ok  " : "FAIL"} ${k}`); if (!v) bad++; }
console.log(`\n${Object.keys(checks).length - bad} passed, ${bad} failed`);
await b.close();
process.exit(bad ? 1 : 0);
