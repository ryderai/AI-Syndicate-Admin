/* Tests for lib/lead-alert-make.js — the #leads Slack alert (18 Oct 2026).
 * No network, no keys. Run: node tests/lead-alert/test.mjs
 *
 * What must never break:
 *   1. "OK to call" appears ONLY with recorded consent AND a phone.
 *   2. A stranger's text cannot ping the channel or break the layout.
 *   3. The URL guard only lets a hook.*.make.com address through.
 *   4. A failed or slow post never throws into the visitor's request.
 */
import {
  buildLeadAlert, postLeadAlert, makeLeadsWebhookUrl, formatPhone, sourceLabel, escapeSlack, teamTime,
} from "../../lib/lead-alert-make.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const NOW = new Date("2026-10-18T18:05:00Z"); // 1:05 PM CT

/* 1. consent */
{
  const a = buildLeadAlert({ where: "Landing page /free-ai-score/", name: "Mike", phone: "5125550100", callConsent: true, now: NOW });
  ok("consent + phone says OK to call", a.slack_text.includes("*OK to call or text*") && a.ok_to_call === "yes");
  const b = buildLeadAlert({ where: "x", name: "Mike", phone: "5125550100", callConsent: false, now: NOW });
  ok("phone without consent never says OK to call", !b.slack_text.includes("OK to call or text") && b.ok_to_call === "no_consent_on_record");
  ok("phone without consent says email first", b.slack_text.includes("Email first"));
  const c = buildLeadAlert({ where: "x", name: "Mike", email: "m@x.com", callConsent: true, now: NOW });
  ok("consent without a phone is email only", c.slack_text.includes("EMAIL ONLY") && c.ok_to_call === "no_phone");
  const d = buildLeadAlert({ where: "x", name: "Mike", phone: "5125550100", callConsent: "yes", now: NOW });
  ok("a truthy non-boolean consent still counts only via Boolean()", d.ok_to_call === "yes");
  const e = buildLeadAlert({ where: "x", name: "Mike", phone: "5125550100", now: NOW });
  ok("consent defaults to no", e.ok_to_call === "no_consent_on_record");
}

/* 2. escaping */
{
  const a = buildLeadAlert({ where: "x", name: "<!channel> Bob", company: "A&B <Co>", email: "a@b.com", now: NOW });
  ok("names cannot ping the channel", !a.slack_text.includes("<!channel>") && a.slack_text.includes("&lt;!channel&gt;"));
  ok("company is escaped", a.slack_text.includes("A&amp;B &lt;Co&gt;"));
  ok("escapeSlack handles null", escapeSlack(null) === "");
  const b = buildLeadAlert({ where: "x", now: NOW });
  ok("a missing name is said, not blank", b.slack_text.includes("(no name given)"));
}

/* layout */
{
  const a = buildLeadAlert({ event: "phone_added", where: "Landing page /free-ai-score/", name: "Mike", phone: "15125550100", callConsent: true, score: 69, utm: { utm_source: "facebook", utm_campaign: "hs-leadform-oct26" }, now: NOW });
  ok("phone_added has its own headline", a.slack_text.startsWith(":large_yellow_circle: *SAME LEAD, NOW HAS A PHONE*"));
  ok("source is named", a.slack_text.includes("Meta ad (hs-leadform-oct26)"));
  ok("score line", a.slack_text.includes("Free AI score: 69/100") && a.score === 69);
  ok("claim line is last", a.slack_text.trim().split("\n").pop().startsWith(":point_right:"));
  ok("time is in CT", a.time_ct === "Sun, Oct 18, 1:05 PM CT" || a.time_ct === "Sun Oct 18, 1:05 PM CT", a.time_ct);
  const b = buildLeadAlert({ where: "x", score: 69.5, now: NOW });
  ok("a non-integer score is dropped", b.score === null && !b.slack_text.includes("score"));
}

/* phones + sources */
ok("formatPhone 10", formatPhone("5125550100") === "(512) 555-0100");
ok("formatPhone 11 with 1", formatPhone("15125550100") === "(512) 555-0100");
ok("formatPhone +1", formatPhone("+1 (512) 555-0100") === "(512) 555-0100");
ok("formatPhone other", formatPhone("447700900123") === "+447700900123");
ok("formatPhone empty", formatPhone(null) === "");
ok("sourceLabel fb", sourceLabel({ source: "fb" }) === "Meta ad");
ok("sourceLabel google", sourceLabel({ utm_source: "google", utm_campaign: "brand" }) === "Google (brand)");
ok("sourceLabel none", sourceLabel({}) === "");
ok("teamTime is a string", typeof teamTime(NOW) === "string");

/* 3. URL guard */
ok("make hook allowed", makeLeadsWebhookUrl({ MAKE_LEADS_WEBHOOK_URL: "https://hook.us2.make.com/abc" }) === "https://hook.us2.make.com/abc");
ok("eu hook allowed", Boolean(makeLeadsWebhookUrl({ MAKE_LEADS_WEBHOOK_URL: "https://hook.eu1.make.com/abc" })));
ok("http refused", makeLeadsWebhookUrl({ MAKE_LEADS_WEBHOOK_URL: "http://hook.us2.make.com/abc" }) === "");
ok("look-alike refused", makeLeadsWebhookUrl({ MAKE_LEADS_WEBHOOK_URL: "https://hook.us2.make.com.evil.io/abc" }) === "");
ok("other host refused", makeLeadsWebhookUrl({ MAKE_LEADS_WEBHOOK_URL: "https://example.com/abc" }) === "");
ok("unset is empty", makeLeadsWebhookUrl({}) === "");
ok("garbage is empty", makeLeadsWebhookUrl({ MAKE_LEADS_WEBHOOK_URL: "not a url" }) === "");

/* 4. posting */
const env = { MAKE_LEADS_WEBHOOK_URL: "https://hook.us2.make.com/abc" };
{
  let called = false;
  const r = await postLeadAlert({ a: 1 }, { env: {}, fetchImpl: async () => { called = true; } });
  ok("unset env skips without calling", r.skipped === true && !called);
}
{
  let seen = null;
  const r = await postLeadAlert({ slack_text: "hi" }, { env, fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true }; } });
  ok("posts JSON to the hook", r.ok && seen.url === "https://hook.us2.make.com/abc" && JSON.parse(seen.init.body).slack_text === "hi" && seen.init.method === "POST");
}
{
  const r = await postLeadAlert({}, { env, fetchImpl: async () => ({ ok: false, status: 410, text: async () => "There is no scenario listening" }) });
  ok("a refused post returns, not throws", r.ok === false && r.error === "HTTP 410");
}
{
  const r = await postLeadAlert({}, { env, fetchImpl: async () => { throw new Error("boom"); } });
  ok("a thrown post returns, not throws", r.ok === false && r.error === "boom");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
