/* LinkedIn Outreach v2 (6 Nov 2026): sales-page sign-up, login details,
 * WhatsApp links, sign-up -> form matching, per-person follow-ups, Julie's
 * queue additions, internal alert emails.
 * Run: node tests/linkedin-v2/test.mjs — no key, no network. */
import { validateSignup, checkoutUrl, signupRef, onboardingLink, matchSignup, mergePatch, normalisePhone, waLink, validateLoginDetails, nextStep, parseProspectLines, dueFollowUps, DEFAULT_PAYMENT_LINK } from "../../lib/linkedin-v2.js";
import { julieQueue } from "../../lib/linkedin-flow.js";
import { sendInternalEmail, codeEmail, signupEmail } from "../../lib/linkedin-notify.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); } };

// ---- sign-up
const good = { name: "Dana Lee", company: "Northline Ops", email: "Dana@Northline.com ", phone: "(205) 555-0100", linkedin_url: "https://www.linkedin.com/in/dana", site: "northline.com", goal: "8 calls a month" };
const v = validateSignup(good);
ok("a good sign-up passes and the email is lower-cased", v.ok && v.value.email === "dana@northline.com" && !v.bot);
ok("name, company, email required", (() => { const r = validateSignup({}); return !r.ok && r.errors.name && r.errors.company && r.errors.email; })());
ok("a bad email is refused", !validateSignup({ ...good, email: "dana@" }).ok);
ok("a non-LinkedIn profile link is refused", validateSignup({ ...good, linkedin_url: "https://facebook.com/dana" }).errors?.linkedin_url);
ok("the honeypot flags a bot", validateSignup({ ...good, hp_check: "spam.com" }).bot === true && validateSignup({ ...good }).bot === false);
ok("control characters are stripped", validateSignup({ ...good, name: "Da\u0000na" }).value.name === "Dana");
ok("long fields are clipped", validateSignup({ ...good, goal: "x".repeat(5000) }).value.goal.length === 1500);
const id = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";
const cu = new URL(checkoutUrl(id, "dana@northline.com"));
ok("checkout keeps CJ's payment link", `${cu.origin}${cu.pathname}` === DEFAULT_PAYMENT_LINK);
ok("checkout carries client_reference_id = the row id (the webhook's match)", cu.searchParams.get("client_reference_id") === id);
ok("checkout pre-fills the email", cu.searchParams.get("prefilled_email") === "dana@northline.com");
ok("the form ref is short, stable and lower-case", signupRef(id) === "sp-3f2a9c1e5b7d" && onboardingLink(id).endsWith("?ref=sp-3f2a9c1e5b7d"));

// ---- matching a sent form to a paid sign-up
const S = (o) => ({ id, status: "signup", paid_at: "2026-11-06T15:00:00Z", contact_email: "dana@northline.com", merged_into: null, ...o });
ok("ref match wins", matchSignup({ ref: "sp-3f2a9c1e5b7d", contact_email: "other@x.com" }, [S()])?.id === id);
ok("email match, case-insensitive", matchSignup({ contact_email: "DANA@northline.com" }, [S()])?.id === id);
ok("two paid sign-ups with one email -> nobody (a person decides)", matchSignup({ contact_email: "dana@northline.com" }, [S(), S({ id: "b" })]) === null);
ok("an unpaid sign-up never matches", matchSignup({ contact_email: "dana@northline.com" }, [S({ paid_at: null })]) === null);
ok("a merged sign-up never matches again", matchSignup({ contact_email: "dana@northline.com" }, [S({ status: "merged" })]) === null);
ok("no email, no ref -> null", matchSignup({}, [S()]) === null);
const mp = mergePatch(S({ stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", renewal_date: "2026-12-06" }));
ok("merge moves the payment and the Stripe ids", mp.form.paid_at && mp.form.stripe_subscription_id === "sub_1" && mp.form.renewal_date === "2026-12-06");
ok("merge clears the Stripe ids on the sign-up (a renewal can't match both)", mp.signup.stripe_subscription_id === null && mp.signup.stripe_customer_id === null && mp.signup.status === "merged");

// ---- phone + WhatsApp
ok("US 10 digits get +1", normalisePhone("(205) 555-0100") === "+12055550100");
ok("international kept", normalisePhone("+63 917 123 4567") === "+639171234567");
ok("too short -> empty", normalisePhone("12345") === "");
ok("wa.me link without the plus, message encoded", waLink("+63 917 123 4567", "Hi Julie") === "https://wa.me/639171234567?text=Hi%20Julie");
ok("no number -> no link", waLink("", "x") === "");

// ---- login details
const L = { login_email: "Dana@Northline.com", login_location: "Birmingham, AL", whatsapp: "", login_times: "Tue 10am CT", code_method: "page" };
ok("good details pass", validateLoginDetails(L).ok);
ok("WhatsApp method needs a number", validateLoginDetails({ ...L, code_method: "whatsapp" }).errors?.whatsapp);
ok("a bad WhatsApp number is refused even on another method", validateLoginDetails({ ...L, whatsapp: "123" }).errors?.whatsapp);
ok("unknown code method refused", validateLoginDetails({ ...L, code_method: "pigeon" }).errors?.code_method);
const pw = validateLoginDetails({ ...L, password: "hunter2" });
ok("a password field is never kept and is flagged", pw.ok && pw.passwordOffered && !JSON.stringify(pw.value).includes("hunter2"));

// ---- follow-ups per person
const steps = [{ step: 1, delay_days: 1 }, { step: 2, delay_days: 2 }, { step: 3, delay_days: 4 }, { step: 4, delay_days: 7 }];
ok("message 1 is due 1 day after acceptance", JSON.stringify(nextStep({ status: "active", last_step: 0, accepted_on: "2026-11-02" }, steps)) === JSON.stringify({ step: 1, due: "2026-11-03" }));
ok("message 3 counts from when message 2 was sent", nextStep({ status: "active", last_step: 2, accepted_on: "2026-11-02", last_sent_on: "2026-11-05" }, steps).due === "2026-11-09");
ok("after message 4 nothing is due", nextStep({ status: "active", last_step: 4, accepted_on: "2026-11-02" }, steps) === null);
ok("a replied prospect is out of the run", nextStep({ status: "replied", last_step: 1, accepted_on: "2026-11-02" }, steps) === null);
ok("no approved steps -> nothing due", nextStep({ status: "active", last_step: 0, accepted_on: "2026-11-02" }, []) === null);
const lines = parseProspectLines("Jane Smith, https://www.linkedin.com/in/janesmith/\n\n  Tom Lee \nhttps://linkedin.com/in/x,\n- Ann O'Neil;");
ok("paste: name + link", lines[0].name === "Jane Smith" && lines[0].profile_url === "https://www.linkedin.com/in/janesmith/");
ok("paste: name only, trimmed", lines[1].name === "Tom Lee" && lines[1].profile_url === null);
ok("paste: a bare link with no name is skipped", lines.length === 3 && lines[2].name === "Ann O'Neil");
const due = dueFollowUps([
  { id: "1", li_client_id: "a", name: "Jane", status: "active", last_step: 0, accepted_on: "2026-11-02" },
  { id: "2", li_client_id: "a", name: "Tom", status: "active", last_step: 0, accepted_on: "2026-11-06" },
  { id: "3", li_client_id: "b", name: "Ann", status: "active", last_step: 1, accepted_on: "2026-11-01", last_sent_on: "2026-11-03" },
], { a: steps, b: steps }, "2026-11-06");
ok("due today or earlier only, oldest first", due.map((x) => x.name).join() === "Jane,Ann");

// ---- Julie's queue additions
const q = julieQueue([
  { id: "a", company: "A", flow_stage: "approved" },
  { id: "b", company: "B", flow_stage: "access_scheduled", login_details_at: "2026-11-06T10:00:00Z" },
  { id: "c", company: "C", flow_stage: "live", launch_date: "2026-11-02", login_details_at: "x", password_received_at: "x" },
], [], { c: ["2026-11-10"] }, { now: new Date("2026-11-10T18:00:00Z"), followUps: [{ li_client_id: "c", step: 2 }, { li_client_id: "c", step: 1 }] });
ok("queue: waiting on login details", q.some((x) => x.id === "a" && /login details/.test(x.what)));
ok("queue: details in, password not yet", q.some((x) => x.id === "b" && /password/.test(x.what)));
ok("queue: follow-ups due, one line per account", q.filter((x) => x.kind === "followup").length === 1 && /2 follow-ups due \(message 1, message 2\)/.test(q.find((x) => x.kind === "followup").what));
ok("queue: access items come right after logins", q.findIndex((x) => x.kind === "access") < q.findIndex((x) => x.kind === "followup"));

// ---- internal emails (fake fetch; nothing leaves the machine)
const calls = [];
const fake = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => "" }; };
process.env.RESEND_API_KEY = "test";
const r1 = await sendInternalEmail({ to: ["julie@x.com", "client@evil.com"], allowed: ["julie@x.com"], subject: "s", text: "t" }, { fetchImpl: fake });
ok("only allowed team addresses get the email", r1.sent && calls[0].body.to.join() === "julie@x.com");
const r2 = await sendInternalEmail({ to: ["client@evil.com"], allowed: ["julie@x.com"], subject: "s", text: "t" }, { fetchImpl: fake });
ok("a client address alone sends nothing", !r2.sent && r2.reason === "no_team_recipient" && calls.length === 1);
delete process.env.RESEND_API_KEY;
const r3 = await sendInternalEmail({ to: ["julie@x.com"], allowed: ["julie@x.com"], subject: "s", text: "t" }, { fetchImpl: fake });
ok("no Resend key -> nothing sent, no throw", !r3.sent && r3.reason === "no_resend_key");
const r4 = await sendInternalEmail({ to: ["julie@x.com"], allowed: ["julie@x.com"], subject: "s", text: "t" }, { fetchImpl: async () => { throw new Error("down"); } });
ok("a network failure never throws", r4.sent === false);
const ce = codeEmail({ company: "8th St", code: "123456", loginEmail: "d@x.com" });
ok("code email: code in the subject (reads on a lock screen)", /123456/.test(ce.subject) && /d@x\.com/.test(ce.text));
const se = signupEmail({ name: "Dana", company: "Northline", email: "d@n.com", goal: "8 calls", consoleUrl: "https://c" });
ok("sign-up email names the company and the next step", /Northline/.test(se.subject) && /onboarding form/.test(se.text));


// ---- linkSignups / mergeSignupInto against a tiny in-memory stand-in for Supabase
const { linkSignups, mergeSignupInto } = await import("../../lib/linkedin-flow-server.js");
function fakeDb(rows) {
  const tables = { linkedin_clients: rows, linkedin_outbox: [] };
  return {
    tables,
    from(t) {
      const filters = []; let op = "select", patch = null, lim = Infinity, want = false;
      const q = {
        select() { want = true; return q; }, update(p) { op = "update"; patch = p; return q; },
        insert(r) { tables[t].push({ id: `o${tables[t].length}`, ...r }); return { select: () => ({ maybeSingle: async () => ({ data: { id: "o" } }) }) }; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; }, is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
        not(k, o, v) { filters.push((r) => (r[k] ?? null) !== v); return q; }, limit(n) { lim = n; return q; },
        then(res) {
          const hit = tables[t].filter((r) => filters.every((f) => f(r))).slice(0, lim);
          if (op === "update") hit.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: want || op === "select" ? hit.map((r) => ({ ...r })) : null, error: null }).then(res);
        },
      };
      return q;
    },
  };
}
{
  const db = fakeDb([
    { id: "s1", status: "signup", paid_at: "2026-11-06", contact_email: "a@x.com", stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", company: "A" },
    { id: "f1", status: "submitted", paid_at: null, contact_email: "a@x.com", ref: null, company: "A" },
  ]);
  const r = await linkSignups(db);
  const f1 = db.tables.linkedin_clients.find((x) => x.id === "f1"), s1 = db.tables.linkedin_clients.find((x) => x.id === "s1");
  ok("linkSignups: payment + subscription move onto the form row", r.merged === 1 && f1.paid_at && f1.stripe_subscription_id === "sub_1");
  ok("linkSignups: sign-up marked merged, ids cleared, no welcome draft", s1.status === "merged" && s1.merged_into === "f1" && !s1.stripe_subscription_id && db.tables.linkedin_outbox.length === 0);
  const again = await linkSignups(db);
  ok("linkSignups: a second run does nothing", again.merged === 0 && again.drafted === 0);
}
{
  const db = fakeDb([
    { id: "s1", status: "signup", paid_at: "2026-11-06", contact_email: "a@x.com", company: "A" },
    { id: "f1", status: "submitted", paid_at: null, contact_email: "a@x.com" },
    { id: "f2", status: "submitted", paid_at: null, contact_email: "a@x.com" },
  ]);
  const r = await linkSignups(db);
  ok("two unpaid forms with one email -> no merge (a person decides), welcome drafted once", r.merged === 0 && r.drafted === 1 && db.tables.linkedin_outbox.length === 1);
  await linkSignups(db);
  ok("the welcome is never drafted twice", db.tables.linkedin_outbox.length === 1);
}
{
  const db = fakeDb([
    { id: "s1", status: "signup", paid_at: "2026-11-06", contact_email: "a@x.com", stripe_subscription_id: "sub_9", company: "A" },
    { id: "f1", status: "submitted", paid_at: "2026-11-06", contact_email: "a@x.com", stripe_subscription_id: "sub_9" },
  ]);
  const r = await linkSignups(db);
  ok("webhook already paid the form with the same subscription -> sign-up folded in, nothing moved, no welcome", r.already === 1 && db.tables.linkedin_clients[0].status === "merged" && db.tables.linkedin_outbox.length === 0);
}
{
  const db = fakeDb([
    { id: "s1", status: "signup", paid_at: "2026-11-06", contact_email: "a@x.com", stripe_subscription_id: "sub_7", company: "A" },
    { id: "f1", status: "submitted", paid_at: null, contact_email: "a@x.com", stripe_subscription_id: "sub_7" },
  ]);
  const r = await linkSignups(db);
  ok("an UNPAID form holding the subscription still gets the payment moved onto it", r.already === 0 && r.merged === 1 && db.tables.linkedin_clients[1].paid_at === "2026-11-06");
}
{
  const db = fakeDb([
    { id: "s1", status: "signup", paid_at: "2026-11-06", stripe_subscription_id: "sub_2", stripe_customer_id: "cus_2" },
    { id: "f1", status: "submitted", paid_at: "2026-11-01" },
  ]);
  const r = await mergeSignupInto(db, { ...db.tables.linkedin_clients[0] }, "f1");
  const s1 = db.tables.linkedin_clients[0];
  ok("merge onto an already-paid form is refused and fully undone", !r.ok && s1.status === "signup" && s1.merged_into === null && s1.stripe_subscription_id === "sub_2" && db.tables.linkedin_clients[1].paid_at === "2026-11-01");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
