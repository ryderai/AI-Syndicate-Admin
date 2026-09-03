/* DRIVEN IN A REAL BROWSER, against the BUILT BUNDLE — the send-email button of
 * 2 Sep 2026. Ryder: "add the send email button so you can easily get a draft,
 * click what email to send from and then send it. emails need to be able to be
 * sent from the crm from the email that is connected."
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The bundle, the browser, the panel, every
 * click and the exact bytes the page POSTs are real. Gmail is not: the three
 * endpoints are intercepted, because the alternative is sending mail to a real
 * address from a test. So this proves the console's whole half of the job —
 * that the words on screen are the words that go, from the mailbox that was
 * picked, once, with the flag that stops the touch being written twice. It does
 * NOT prove Gmail accepts them; that is `/api/gmail-send`'s own contract, and
 * tests/lead-email pins it.
 *
 * It fails loudly. Every step asserts, and a screenshot is only proof of the
 * step that passed beside it.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, statSync, readdirSync } from "node:fs";
/* THE RULES THEMSELVES, run here, so the prefill assertion below pins the
 * cadence and not a date somebody typed into a test. */
import { nextCadenceDate } from "../../lib/sales-rules.js";
import { join } from "node:path";

const BASE = process.env.BASE || "http://localhost:4173";
const ROOT = new URL("../../", import.meta.url).pathname;
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const MAILBOXES = [
  { email_address: "ryder@aisyndicate.com", shared: false, display_name: "Ryder Schilling" },
  { email_address: "growth@aisyndicate.com", shared: true, display_name: "AI Syndicate" },
];
const DRAFT = {
  to: "dana@harborpoint.test",
  subject: "The three pages AI cannot read on harborpoint.test",
  body: "Hi Dana,\n\nI ran your site through the same scan the AI engines use.\n\nRyder Schilling",
};

/* EVERY REQUEST THE PAGE MAKES TO ITS OWN API, KEPT. The assertions below read
 * this rather than the screen, because "it looked like it sent" is exactly the
 * thing that cannot be trusted. */
const sends = [];
let accountsCalls = 0;
let failSend = null;
let failTouch = false;
const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/* SIGNED IN, AGAINST A DATABASE THAT DOES NOT EXIST.
 *
 * Preview (sample-data) mode cannot be used here: `apiFetch` refuses without
 * touching the network when the Supabase keys are absent, so the draft never
 * arrives and the send button can never be pressed. run.sh therefore builds
 * with FAKE keys, and everything — gotrue, PostgREST, the three endpoints — is
 * answered here. Nothing real is contacted and no mail can leave. */
const HOST = "fake-test.supabase.co";
const UID = "d917adfc-2abf-4417-b8c3-053b00236f43";
const EMAIL = "ryder@aisyndicate.com";
const LEAD_ID = "11111111-2222-4333-8444-555555555555";
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
const ROSTER = { user_id: UID, email: EMAIL, full_name: "Ryder Schilling", role: "owner", active: true };
/* ONE CONTACT, CLAIMED BY THE PERSON DRIVING, WITH AN EMAIL AND NO TOUCHES YET
 * — which is exactly the state whose next step is "Email #1", the branch the
 * draft button sits in. */
const LEAD = {
  id: LEAD_ID,
  company_id: null,
  full_name: "Dana Whitfield",
  title: "Owner",
  email: "dana@harborpoint.test",
  phone: null,
  business_name: "Harbor Point Dental",
  business_type: "dentist",
  website: "harborpoint.test",
  country: "US", region: "MI", city: "Holton",
  stage: "contacted",
  owner_id: UID,
  claimed_at: new Date(Date.now() - 2 * 864e5).toISOString(),
  first_contact_at: null, first_email_at: null, last_touch_at: null,
  next_follow_up_at: null, first_reply_at: null, bounced_at: null,
  score: 62, tags: [], notes: null, source: "manual",
  created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
  updated_at: new Date(Date.now() - 2 * 864e5).toISOString(),
};

/* EVERY WRITE THE PAGE MAKES, KEPT — the touch assertions below read this. */
const writes = [];
/* AND THE TOUCHES ARE READ BACK. A second checker showed why this had to exist:
 * with the activity table answering `[]` for ever, `board.touchCounts` was
 * permanently empty, so the page's count and the test's hard-coded number
 * agreed by accident — and the cadence-prefill assertion stayed green with the
 * feature switched off. Rows the page inserts are served on the next read, the
 * way a database would. */
const activity = [];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addInitScript(([host, s]) => {
  localStorage.setItem(`sb-${host.split(".")[0]}-auth-token`, JSON.stringify(s));
}, [HOST, session]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.route(`https://${HOST}/auth/v1/**`, (r) =>
  r.fulfill(json(/user/.test(r.request().url()) ? session.user : session)));

/* PostgREST, answered generically. The catch-all goes on FIRST: Playwright
 * checks routes in REVERSE registration order, and registered the other way
 * round it swallows the specific ones (the note in tests/auth-gate says what
 * that cost the last time). */
await page.route(`https://${HOST}/rest/v1/**`, (r) => {
  const req = r.request();
  const url = req.url();
  if (req.method() !== "GET") {
    const sent = JSON.parse(req.postData() || "{}");
    writes.push({ url, method: req.method(), body: sent });
    if (req.method() === "POST" && /admin_lead_activity/.test(url) && !failTouch) {
      for (const row of [].concat(sent)) {
        activity.push({ id: `act-${activity.length + 1}`, created_at: new Date().toISOString(), ...row });
      }
    }
    /* Set by the last section, to prove the state where the mail went and the
     * bookkeeping did not. */
    if (failTouch && /admin_lead_activity/.test(url)) {
      return r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "new row violates row-level security policy" }) });
    }
    return r.fulfill({ ...json([{ id: "written" }]), status: 201 });
  }
  if (url.includes("admin_users")) return r.fulfill(json(/single|limit=1/.test(url) ? ROSTER : [ROSTER]));
  if (url.includes("admin_lead_activity")) return r.fulfill(json(activity));
  if (url.includes("admin_leads")) return r.fulfill(json([LEAD]));
  return r.fulfill(json([]));
});
const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png` });

await page.route("**/api/**", async (route) => {
  const url = route.request().url();
  if (url.includes("gmail-accounts")) { accountsCalls += 1; return route.fulfill(json({ accounts: MAILBOXES, mailboxes: MAILBOXES, role: "owner" })); }
  if (url.includes("lead-email")) return route.fulfill(json(DRAFT));
  if (url.includes("gmail-send")) {
    sends.push(JSON.parse(route.request().postData() || "{}"));
    /* Set by the last section, to prove the refusal path. */
    if (failSend) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: failSend }) });
    return route.fulfill(json({ ok: true, id: "msg-1", threadId: "thr-1" }));
  }
  return route.continue();
});

const newestSource = (dir) => {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSource(full));
    else if (/\.(jsx?|css)$/.test(e.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
};

await page.goto(`${BASE}/#/dashboard/sales`, { waitUntil: "networkidle" });
await page.waitForSelector(".adm-sl-bar", { timeout: 25000 });
await page.waitForTimeout(700);

/* ---- 0. IS THIS THE CODE AS IT NOW STANDS ---- */
{
  const served = await page.evaluate(() =>
    [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).join(","));
  const onDisk = (readFileSync(join(ROOT, "dist/index.html"), "utf8").match(/assets\/index-[^"]+\.js/) || [])[0];
  ok(`the server is handing out the bundle dist/index.html names (${onDisk})`,
    Boolean(onDisk) && served.includes(onDisk), `served ${served}`);
  const builtAt = statSync(join(ROOT, "dist", onDisk)).mtimeMs;
  const sourceAt = Math.max(newestSource(join(ROOT, "src")), newestSource(join(ROOT, "lib")));
  ok("...built AFTER the last source edit", builtAt >= sourceAt,
    `bundle ${new Date(builtAt).toISOString()} vs source ${new Date(sourceAt).toISOString()}`);
  ok("the mailbox list is read once, on load, not per record", accountsCalls === 1, `${accountsCalls} calls`);
}

/* ---- 1. THE BUTTON IS IN THE RECORD ---- */
await page.locator(".adm-sl-row, tbody tr").first().click();
await page.waitForTimeout(1000);
const draftBtn = page.locator("button", { hasText: /^Draft an email$/ }).first();
{
  ok("opening a contact shows a Draft an email button in What to do next",
    await draftBtn.count() > 0);
  await shot("01-draft-an-email-button");
}

/* ---- 2. IT DRAFTS, AND THE DRAFT IS ON SCREEN TO BE READ ---- */
await draftBtn.click();
await page.waitForSelector(".adm-modal", { timeout: 20000 });
await page.waitForTimeout(700);
/* `.adm-modal` ONLY. The first run of this said `.adm-modal, [role='dialog']`
 * and the record drawer is also role=dialog and later in the DOM, so `.last()`
 * read the drawer's own text and three checks failed against the tag filters. */
const modal = page.locator(".adm-modal").last();
{
  const t = await modal.innerText();
  /* READ OUT OF THE BOXES, not off the page. Both are editable fields, so their
   * text is a value and never appears in innerText — the first run of this
   * failed on that and the panel was fine. */
  const subjectBox = modal.locator("input.adm-input").first();
  const bodyBox = modal.locator("textarea").first();
  ok("the panel opens with the drafted subject in it",
    (await subjectBox.inputValue()) === DRAFT.subject, await subjectBox.inputValue());
  ok("...and the body, so it can be read before it goes",
    (await bodyBox.inputValue()).includes("same scan the AI engines use"));
  ok("...and it names the address it is going to", t.includes(DRAFT.to));
  ok("the record panel names the contact for a screen reader, not \"undefined\"",
    !/Lead: undefined/.test(await page.locator(".adm-sl-drawer").first().getAttribute("aria-label") || ""),
    await page.locator(".adm-sl-drawer").first().getAttribute("aria-label"));
  await shot("02-the-draft-on-screen");
}

/* ---- 3. WHICH MAILBOX IT GOES FROM — the pick Ryder asked for ---- */
{
  const t = await modal.innerText();
  ok("the panel asks which mailbox it goes from", /Send it from/i.test(t), t.slice(0, 400));
  const sel = modal.locator("select").first();
  ok("...as a picker, because there is more than one connected", await sel.count() > 0);
  const opts = await sel.locator("option").allInnerTexts();
  ok("...listing both connected mailboxes", opts.join("|").includes("ryder@aisyndicate.com") && opts.join("|").includes("growth@aisyndicate.com"), opts.join("|"));
  ok("...and marking which one is the team's shared one", /shared/i.test(opts.join("|")), opts.join("|"));
  /* PICK THE SECOND ONE ON PURPOSE. Sending from the default would pass even if
   * the picker were decoration. */
  await sel.selectOption("growth@aisyndicate.com");
  await page.waitForTimeout(200);
  await shot("03-picked-the-shared-mailbox");
}

/* ---- 4. THE EDIT IS WHAT GOES, NOT THE MODEL'S DRAFT ---- */
const EDIT = "\n\nP.S. Edited by hand before sending.";
{
  const body = modal.locator("textarea").first();
  await body.fill(DRAFT.body + EDIT);
  await page.waitForTimeout(200);
}

/* ---- 5. THE SEND BUTTON, WITH THE ADDRESS ON IT ---- */
const sendBtn = modal.locator("button", { hasText: /^Send to / }).first();
{
  ok(`the send button carries the recipient (${DRAFT.to})`, await sendBtn.count() > 0,
    (await modal.innerText()).slice(-400));
  ok("...and it is live, because a mailbox is connected", await sendBtn.isEnabled());
  await shot("04-send-button-with-the-address");
}

await sendBtn.click();
await page.waitForTimeout(1800);

/* ---- 6. WHAT ACTUALLY LEFT ---- */
{
  ok("pressing it sent exactly one email", sends.length === 1, JSON.stringify(sends).slice(0, 400));
  const s = sends[0] || {};
  ok("...from the mailbox that was PICKED, not the default", s.account === "growth@aisyndicate.com", String(s.account));
  ok("...to the address on the record", s.to === DRAFT.to, String(s.to));
  ok("...with the edited words, not the draft's", typeof s.body === "string" && s.body.includes("Edited by hand"), String(s.body).slice(0, 200));
  ok("...carrying the contact id, so the reply can be filed against them later", Boolean(s.leadId));
  /* THE ONE THAT MATTERS MOST AND IS INVISIBLE ON SCREEN. The endpoint writes a
   * touch of its own for the Inbox; without this flag one email would be logged
   * twice, count twice on the Overview and jump the 5-step cadence two steps. */
  ok("...and telling the endpoint the touch is logged here, so it is logged ONCE",
    s.touchLoggedByCaller === true, JSON.stringify(s).slice(0, 300));
}

/* ---- 7. AND THEN IT ASKS THE ONE THING LEFT ---- */
{
  await page.waitForTimeout(600);
  const t = await page.locator(".adm-modal").last().innerText();
  ok("once it is sent, the panel asks for the follow-up date and nothing else",
    /follow|next/i.test(t) && !t.includes(DRAFT.subject), t.slice(0, 400));
  /* THE DATE BOX'S VALUE, and the same day the rules compute — not a regex over
   * the panel's text. The first version of this matched the static preset label
   * "In 3 days", so it passed with the prefill removed entirely: a checker
   * proved it by disabling the feature and watching 30/30 stay green.
   *
   * `nextCadenceDate` is imported and run here, so this pins the prefill to the
   * cadence rather than to any particular date. One touch has just been logged,
   * hence `1`. */
  const dateBox = page.locator(".adm-modal .adm-cp-when-d").first();
  const chosen = await dateBox.inputValue();
  const wanted = nextCadenceDate({ ...LEAD, last_touch_at: new Date().toISOString() }, 1, Date.now());
  ok(`...with the cadence's own day already in the date box (${wanted})`,
    Boolean(wanted) && chosen === wanted, `box says "${chosen}", the rules say "${wanted}"`);
  /* AND IT IS THE DAY THAT GETS SAVED. The value in a box proves nothing until
   * something writes it: press Book it and read the PATCH. */
  const beforeBook = writes.length;
  await page.locator(".adm-modal button", { hasText: /^Book it$/ }).first().click();
  await page.waitForTimeout(1200);
  const booked = writes.slice(beforeBook).filter((w) => /admin_leads/.test(w.url));
  const bookedBody = Array.isArray(booked[0]?.body) ? booked[0].body[0] : booked[0]?.body;
  ok("...and pressing Book it writes exactly that day as the next follow-up",
    String(bookedBody?.next_follow_up_at || "").startsWith(wanted),
    JSON.stringify(booked.map((w) => w.body)).slice(0, 300));
  await shot("05-then-the-follow-up-date");
}

/* ---- 8. ONE TOUCH, AND NO CRASH ---- */
{
  /* The other half of the double-log rule, checked from the browser's side: the
   * page must write the touch itself EXACTLY once. The flag above stops the
   * endpoint writing a second; this stops the page writing two. */
  const touches = writes.filter((w) => /admin_lead_activity/.test(w.url));
  ok("the page wrote exactly one touch for the one email", touches.length === 1,
    JSON.stringify(touches.map((t) => t.url)).slice(0, 300));
  const t = touches[0]?.body || {};
  const row = Array.isArray(t) ? t[0] : t;
  ok("...on this contact, as an email, by the person who pressed it",
    row?.lead_id === LEAD_ID && row?.type === "email" && row?.actor === UID,
    JSON.stringify(row).slice(0, 300));
  ok("nothing threw while doing any of it", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
}

/* ---- 9. WHEN THE SEND FAILS, NOTHING IS LOGGED AND YOUR WORDS ARE STILL THERE
 *
 * The reason the order is send-first-log-second. A touch written for an email
 * that never left is a wrong number on a screen this console is built on
 * trusting, and nothing later can tell it was wrong. */
{
  failSend = "Gmail: that address was rejected.";
  const before = writes.length;
  /* The panel closed itself when Book it was pressed above. Its backdrop
   * swallows every click while it is up, which is how this section failed on
   * its first run — 44 retries against a scrim. */
  await page.waitForTimeout(400);
  await page.goto(`${BASE}/#/dashboard/sales`, { waitUntil: "networkidle" });
  await page.waitForSelector(".adm-sl-bar", { timeout: 25000 });
  await page.waitForTimeout(900);
  /* NO ROW CLICK HERE. Coming back to Sales REOPENS the record you had open —
   * that is the "walking away and coming back keeps what you were doing" rule
   * from tests/sales-intake — so the drawer is already up and its own body
   * swallows a click aimed at the table underneath. The second run of this
   * section failed exactly that way, and the failure was the feature working.
   * Also proof, in passing, that the reopened drawer still carries the button. */
  ok("coming back to Sales reopens the record, with the draft button still on it",
    await page.locator("button", { hasText: /^Draft an email$/ }).count() > 0);
  await page.locator("button", { hasText: /^Draft an email$/ }).first().click();
  await page.waitForSelector(".adm-modal", { timeout: 20000 });
  await page.waitForTimeout(600);
  const m = page.locator(".adm-modal").last();
  await m.locator("button", { hasText: /^Send to / }).first().click();
  await page.waitForTimeout(1500);

  const t = await m.innerText();
  ok("a refused send says WHY, on the panel, not only in a toast",
    t.includes("that address was rejected"), t.slice(-500));
  ok("...and says the words are still there", /still here/i.test(t), t.slice(-300));
  ok("...and the email is still on screen to be fixed",
    (await m.locator("textarea").first().inputValue()).includes("same scan"));
  ok("...and NOTHING was logged against the contact",
    writes.slice(before).filter((w) => /admin_lead_activity/.test(w.url)).length === 0,
    JSON.stringify(writes.slice(before).map((w) => w.url)).slice(0, 300));
  await shot("06-a-refused-send-keeps-your-words");
}

/* ---- 10. THE MAIL WENT AND THE LOG DID NOT — the one state that must never
 * invite a second press.
 *
 * Until an adversarial checker read this path on 2 Sep 2026, this case printed
 * "your words are still here — fix it and press it again" under a LIVE Send
 * button. The prospect already had the email; the obvious next click sent them
 * a second one. */
{
  failSend = null;
  failTouch = true;
  const sendsBefore = sends.length;
  const beforeTouchFail = writes.length;
  await page.locator(".adm-modal button", { hasText: /^Close$/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: /^Draft an email$/ }).first().click();
  await page.waitForSelector(".adm-modal", { timeout: 20000 });
  await page.waitForTimeout(600);
  const m = page.locator(".adm-modal").last();
  await m.locator("button", { hasText: /^Send to / }).first().click();
  await page.waitForTimeout(2500);

  const t = await m.innerText();
  ok("the email is sent exactly once even though the log failed",
    sends.length === sendsBefore + 1, `${sends.length - sendsBefore} sends`);
  /* ONE LOG ATTEMPT, NOT TWO. A retry lived here for an hour and had to go:
   * logTouch claims before it writes, so a second run with the same stale lead
   * says "somebody got there first" about your own lead — and if the first write
   * landed and only its answer was lost, the retry double-counts the email. */
  ok("...and the page tried to log it exactly once, never twice",
    writes.slice(beforeTouchFail).filter((w) => /admin_lead_activity/.test(w.url)).length === 1,
    JSON.stringify(writes.slice(beforeTouchFail).map((w) => w.url)).slice(0, 300));
  ok("...the panel says to treat it as sent", /Treat it as sent/.test(t), t.slice(-500));
  ok("...and says not to send it again", /do not press send again/i.test(t), t.slice(-400));
  ok("...and names the button that puts it on the timeline",
    /Copy & mark it sent/.test(t), t.slice(-400));
  ok("...and the Send button is GONE, not merely greyed out",
    await m.locator("button", { hasText: /^Send to / }).count() === 0);
  ok("...and it never claims the words are still there to fix",
    !/still here/i.test(t), t.slice(-400));
  await shot("07-sent-but-not-logged");
  failTouch = false;
}

/* ---- 11. ONCE THEY HAVE WRITTEN BACK, BOTH DOORS REFUSE ----
 *
 * The pre-written email is the next step of an outreach sequence. The rules stop
 * that sequence the moment somebody replies, and the drawer has said so in words
 * for weeks — but the button that sends it did not check, and the sheet's own
 * button still did not after the first fix. Two doors, one rule. */
{
  LEAD.first_reply_at = new Date(Date.now() - 3600e3).toISOString();
  await page.locator(".adm-modal button", { hasText: /^Close$/ }).first().click();
  await page.waitForTimeout(300);
  await page.goto(`${BASE}/#/dashboard/sales`, { waitUntil: "networkidle" });
  await page.waitForSelector(".adm-sl-bar", { timeout: 25000 });
  /* PRESS RELOAD. Coming back to Sales deliberately does NOT re-read the board —
   * that is the whole point of the cache — so a lead changed underneath has to
   * be fetched on purpose. Proof in passing that the button does what it says. */
  /* SHUT THE RECORD FIRST — it is reopened by coming back, and it covers the
   * toolbar the Reload button lives on. */
  await page.locator(".adm-sl-drawer .adm-modal-x").first().click();
  await page.waitForTimeout(400);
  await page.locator(".adm-sl-bar button", { hasText: /Reload sales/i }).first().click();
  await page.waitForTimeout(2500);
  /* Then open the record again, on the reloaded board. */
  await page.locator(".adm-sl-row, tbody tr").first().click();
  await page.waitForTimeout(1200);

  ok("the record offers no Draft an email button once they have replied",
    await page.locator("button", { hasText: /^Draft an email$/ }).count() === 0);
  const said = await page.locator(".adm-sl-drawer").innerText();
  /* The record does not merely drop the button: with a reply on file the whole
   * "what to do next" box becomes the reply branch, which says so and offers
   * the two things that ARE next. The button-level guard in DraftEmailButton is
   * the belt to this braces — it covers the expired-claim branch, which is
   * ranked ABOVE this one and is where a replied lead used to be offered the
   * outreach email. */
  ok("...and says why, rather than the button simply vanishing",
    /replied/i.test(said), said.slice(0, 400));
  ok("...and offers what to do instead", /Log your reply|Book a meeting/i.test(said), said.slice(0, 500));

  /* AND THE SHEET, which is the door the first fix left open. */
  await page.locator(".adm-sl-drawer .adm-modal-x").first().click();
  await page.waitForTimeout(500);
  await page.locator(".adm-sl-bar button", { hasText: /^The sheet$/ }).first().click();
  await page.waitForTimeout(1200);
  ok("the sheet offers no Draft email button either",
    await page.locator("button", { hasText: /^Draft email$/ }).count() === 0);
  ok("...and its cell says they replied",
    (await page.innerText("body")).includes("they replied"));
  await shot("08-they-replied-so-neither-door-offers-it");
  LEAD.first_reply_at = null;
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
