/* LinkedIn messaging engine v2 (lib/linkedin-messages.js), the website text
 * reader (lib/linkedin-site-text.js) and the Stripe webhook check
 * (lib/stripe-webhook.js). 3 Nov 2026.
 * Run: node tests/linkedin-messages/test.mjs — no key, no network. */
import { createHmac } from "node:crypto";
import {
  LIMITS, DELAYS, VARIANT_NAMES, REPLY_KEYS, PROMPT_VERSION, noteLimit, riskReview, buildSystem, buildUserMessage,
  buildRevisionMessage, parseOutput, checkOutput, datesIn, expiresOn, datedPieces, filledLength, generate, revise, formatForReview,
} from "../../lib/linkedin-messages.js";
import { safeSiteUrl, htmlToText, fetchSiteText, isPrivateIp } from "../../lib/linkedin-site-text.js";
import { verifyStripeSignature, readStripeEvent, isLinkedInPurchase } from "../../lib/stripe-webhook.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const nov3 = new Date(Date.UTC(2026, 10, 3));

const plumber = {
  contact_name: "Dana Ruiz", contact_email: "dana@ruiz.com", contact_phone: "813-555-0100", company: "Ruiz Plumbing", sales_nav: "Yes", tone: "Friendly",
  about_business: "We fix and replace water heaters for homes in Tampa. 24 years in business.",
  client_problem: "No hot water and no one answers the phone.", job_titles: "Property Manager, Facilities Director",
  industries: "Property management, Real estate", headcount: "11-50, 51-200", locations: "Tampa, St. Petersburg, Clearwater", goals: "Booked calls",
};
const raiser = {
  contact_name: "Pat Lee", company: "8th St", sales_nav: "Yes", tone: "Professional",
  about_business: "We are forming an SPV. Investors receive a preferred return and an equity stake. $20B. 10 months.",
  locations: "NYC on Nov 16th.", headcount: "1-10, 11-50, 51-200, 201-500, 501-1,000", contact_phone: "917-833-7195", linkedin_url: "https://x.com/in/a-5294a847",
  job_titles: "CIO, Portfolio Manager", industries: "Hedge funds, Family office",
};

/* A clean output: overrides by piece key, e.g. { "Value-led.step2": "..." }. */
const make = (over = {}, extra = {}) => ({
  variants: VARIANT_NAMES.map((name) => ({
    name,
    connection_note: over[`${name}.note`] ?? `Hi {{first_name}}, I help property teams in {{city}} keep hot water running. Open to connecting${name === "Direct" ? " today" : ""}?`,
    steps: DELAYS.map((d, i) => ({
      step: i + 1, delay_days: over[`${name}.delay${i + 1}`] ?? d,
      body: over[`${name}.step${i + 1}`] ?? (i === 3 ? `Thanks, {{first_name}}. I'll leave it here; my door is open if heaters become a headache at {{company}}.` : i === 2 ? `Worth a quick look, {{first_name}}?` : `${name} ${["first", "second", "third"][i]} note for {{first_name}} at {{company}}: how do you handle no-heat calls${i ? " now" : ""}?`),
    })),
    inmail: { subject: over[`${name}.subject`] ?? "Water heaters", body: over[`${name}.inmail`] ?? "Hi {{first_name}}, we fix water heaters for property teams. Worth a short call?" },
  })),
  target_lists: extra.lists ?? [
    { title: "Tampa property managers", job_titles: ["Property Manager"], industries: ["Property management"], headcount: ["11-50"], geography: ["Tampa"], keywords: "", exclusions: "" },
    { title: "St. Pete facilities", job_titles: ["Facilities Director"], industries: ["Real estate"], headcount: ["51-200"], geography: ["St. Petersburg"], keywords: "", exclusions: "" },
    { title: "Clearwater property managers", job_titles: ["Property Manager"], industries: ["Property management"], headcount: ["11-50"], geography: ["Clearwater"], keywords: "", exclusions: "" },
  ],
  reply_templates: extra.templates ?? { interested: "Great — does Tuesday or Wednesday work for a short call?", question: "Good question. Happy to explain on a quick call — what time suits?", not_now: "Understood. Mind if I check back in a few months?", referral: "Thank you. Could you share their name so I can reach out?" },
  notes_for_reviewer: extra.notes ?? "No proof point in the form.",
});
const json = (o) => JSON.stringify(o);
const issuesOf = (over, answers = plumber, extra) => checkOutput(parseOutput(json(make(over, extra))).content, answers, riskReview(answers));
const has = (list, where, code) => list.some((i) => i.where === where && i.code === code);
const blocksAt = (list, where) => list.filter((i) => i.level === "block" && i.where === where);

// ---- the brief's numbers
ok("note limit 300 with Sales Navigator", noteLimit({ sales_nav: "Yes" }) === 300);
ok("note limit 200 without it", noteLimit({ sales_nav: "No" }) === 200 && noteLimit({}) === 200);
ok("delays are 1, 2, 4, 7", DELAYS.join() === "1,2,4,7");
ok("prompt version is set", /^li-seq-/.test(PROMPT_VERSION));

// ---- risk
ok("plumber is not regulated", !riskReview(plumber).review);
ok("an SPV raise is securities", riskReview(raiser).kinds.some((k) => k.kind === "securities"));
ok("a bakery is not securities", !riskReview({ about_business: "Our investors love us. We guarantee freshness and take easy returns." }).review);
ok("one strong word flags: 506(b)", riskReview({ about_business: "passive investors, a 506(b) offering" }).review);
ok("an insurance agency is insurance", riskReview({ about_business: "We are an independent insurance agency; policies for small business." }).kinds.some((k) => k.kind === "insurance"));
ok("targeting insurers is not selling insurance", !riskReview({ about_business: "We build software.", industries: "insurance companies" }).kinds.some((k) => k.kind === "insurance"));

// ---- prompt
const sys = buildSystem(raiser);
ok("system prompt states the hard rules", /first person as the client/.test(sys) && /ends with a question/.test(sys) && /No links until the prospect replies/.test(sys));
ok("system prompt carries the 300 note limit for Sales Nav", /Connection note: max 300 characters/.test(sys));
ok("system prompt flags a regulated business", /THIS BUSINESS IS REGULATED/.test(sys));
ok("plain business gets no regulated block", !/THIS BUSINESS IS REGULATED/.test(buildSystem(plumber)));
const um = buildUserMessage(plumber, "Ruiz Plumbing — 24/7 water heater service in Tampa.");
ok("user message labels every field, '(not given)' for blanks", /Ideal client's biggest problem:\nNo hot water/.test(um) && /Case studies, scripts, templates:\n\(not given\)/.test(um));
ok("user message never carries the client's email or phone", !um.includes("dana@ruiz.com") && !um.includes("813-555-0100"));
ok("user message carries the homepage text", um.includes("24/7 water heater service"));
ok("homepage text is capped at 2,000 characters", buildUserMessage(plumber, "x".repeat(5000)).split("x".repeat(2001)).length === 1);
const rev = buildRevisionMessage(plumber, "", { a: 1 }, "Make it shorter");
ok("revision carries the current JSON and the feedback", rev.includes('{"a":1}') && rev.includes("Make it shorter") && /FULL revised JSON/.test(rev));

// ---- parse
const p = parseOutput("```json\n" + json(make()) + "\n```");
ok("parses inside code fences", !p.error && p.content.variants.length === 2);
ok("variants come back named Value-led, Direct", p.content.variants.map((v) => v.name).join() === "Value-led,Direct");
ok("each variant has 4 steps", p.content.variants.every((v) => v.steps.length === 4));
ok("not JSON -> error, no throw", parseOutput("sorry").error !== null);
ok("a list given as a string is split", parseOutput(json({ ...make(), target_lists: [{ title: "a", job_titles: "CIO, CFO", geography: "NYC" }] })).content.target_lists[0].job_titles.length === 2);
ok("notes given as an array are joined", parseOutput(json({ ...make(), notes_for_reviewer: ["a", "b"] })).content.notes_for_reviewer === "a\nb");

// ---- checks: the clean set
const clean = issuesOf({});
ok("a clean output has no blocks", clean.filter((i) => i.level === "block").length === 0, JSON.stringify(clean.filter((i) => i.level === "block")));

// ---- checks: the brief's rules
ok("note over 300 (worst case) blocks", has(issuesOf({ "Value-led.note": "Hi {{first_name}}, " + "x".repeat(290) + "?" }), "Value-led · Connection note", "too_long"));
ok("note over 200 blocks when no Sales Nav", has(issuesOf({ "Value-led.note": "x".repeat(210) + "?" }, { ...plumber, sales_nav: "No" }), "Value-led · Connection note", "too_long"));
ok("message over 400 blocks", has(issuesOf({ "Direct.step1": "x".repeat(401) + "?" }), "Direct · Message 1", "too_long"));
ok("worst-case fill counts: 380 + {{company}} > 400", has(issuesOf({ "Direct.step2": "x".repeat(380) + "{{company}}?" }), "Direct · Message 2", "too_long"));
ok("Message 3 over 20 words blocks", has(issuesOf({ "Value-led.step3": "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone?" }), "Value-led · Message 3", "too_many_words"));
ok("'Thoughts, {{first_name}}?' is a valid Message 3", blocksAt(issuesOf({ "Value-led.step3": "Thoughts, {{first_name}}?" }), "Value-led · Message 3").length === 0);
ok("Message 1-3 not ending in a question blocks", has(issuesOf({ "Direct.step2": "Here is a thought for you." }), "Direct · Message 2", "no_question"));
ok("the breakup needs no question", !has(issuesOf({ "Direct.step4": "All the best." }), "Direct · Message 4", "no_question"));
ok("single-brace {first_name} is an unknown token", has(issuesOf({ "Value-led.step1": "Hi {first_name}, ok?" }), "Value-led · Message 1", "merge_field"));
ok("{{city}} is allowed", !has(issuesOf({ "Value-led.step1": "Hi {{first_name}} in {{city}}, ok?" }), "Value-led · Message 1", "merge_field"));
ok("[Name] fill-ins block", has(issuesOf({ "Value-led.step1": "Hi [Name], ok?" }), "Value-led · Message 1", "merge_field"));
ok("a link in an outbound message blocks", issuesOf({ "Value-led.step2": "See ruizplumbing.com?" }).some((i) => i.code === "link" && i.level === "block"));
ok("a link in a reply template only warns (plain business)", issuesOf({}, plumber, { templates: { ...make().reply_templates, interested: "Here is my calendar: cal.com/dana — what works?" } }).some((i) => i.code === "link" && i.level === "warn"));
ok("our name blocks", has(issuesOf({ "Direct.step4": "Thanks — AI Syndicate" }), "Direct · Message 4", "our_name"));
ok("an invented number blocks", has(issuesOf({ "Value-led.step2": "We fixed 450 heaters last year. Worth a call?" }), "Value-led · Message 2", "invented_number"));
ok("a number the client gave passes", !has(issuesOf({ "Value-led.step2": "24 years fixing heaters. Worth a call?" }), "Value-led · Message 2", "invented_number"));
ok("headcount / phone digits are not facts", has(issuesOf({ "Value-led.step2": "200 buildings served. Ok?" }), "Value-led · Message 2", "invented_number"));
ok("a delay that isn't the brief's warns", has(issuesOf({ "Direct.delay2": 5 }), "Direct · Message 2", "delay"));
ok("same note in both variants warns", issuesOf({ "Value-led.note": "Hi {{first_name}}, connect?", "Direct.note": "Hi {{first_name}}, connect?" }).some((i) => i.code === "same_note"));

// ---- securities
const rIss = (value) => issuesOf({ "Value-led.step2": `Hi {{first_name}}, ${value} Ok?` }, raiser).filter((i) => i.level === "block" && i.where === "Value-led · Message 2");
for (const bad of ["low risk, double digit yield.", "a $4B program.", "twelve percent a year.", "a vehicle with monthly income and equity upside for LPs.", "consider investing with us.", "guаrаntеed and ѕafe.", "a⁣llocation and yi͏eld.", "write to dan@8thstreet.vc", "I'm not here to pitch you anything.", "10 years, 100 deals."]) {
  ok(`securities copy blocked: ${bad.slice(0, 38)}`, rIss(bad).length > 0);
}
for (const fine of ["I meet investors in New York.", "I'm in NYC on Nov 16th.", "I'm with 8th St.", "could we secure a time?", "would you like the overview?"]) {
  ok(`securities copy allowed: ${fine}`, rIss(fine).length === 0, JSON.stringify(rIss(fine)));
}

// ---- 4 Nov check fixes
ok("'Yes - Core' counts as Sales Navigator", noteLimit({ sales_nav: "Yes - Core" }) === 300 && noteLimit({ sales_nav: true }) === 300);
ok("a real-estate syndication is regulated", riskReview({ about_business: "Members co-invest in apartment syndications with quarterly distributions." }).review);
ok("a different delay now blocks", issuesOf({ "Direct.delay2": 5 }).some((i) => i.code === "delay" && i.level === "block"));
for (const bad of ["We baked for 8 venues. Ok?", "We save planners 120 hours a season. Ok?", "Baking since 2009. Ok?", "Top 3 bakers in town. Ok?", "10x fewer late cakes. Ok?"]) {
  ok(`ordinary business invented number blocked: ${bad}`, issuesOf({ "Value-led.step1": bad }).some((i) => i.code === "invented_number"));
}
ok("a gym that names AI Syndicate is not a securities offer", !riskReview({ about_business: "Kickboxing gym.", goals: "AI Syndicate to bring us leads; content syndication." }).review);
ok("a bookkeeping firm is not a securities offer", !riskReview({ about_business: "Bookkeeping for small firms: cash flow reports for owners and their investors." }).review);
ok("a nonprofit fundraising firm is not a securities offer", !riskReview({ about_business: "We help nonprofits with fundraising events." }).review);
for (const fine of ["Open to a 15-minute call?", "Free for 20 minutes next week?"]) {
  ok(`ordinary business number allowed: ${fine}`, !issuesOf({ "Value-led.step1": fine }).some((i) => i.code === "invented_number"));
}
for (const bad of ["distributions from the cash flows.", "capital preservation with no risk to principal.", "ROI is tax-advantaged.", "a twelve-month term, fully collateralized.", "zero risk, insured.", "spots are limited, we close at month end."]) {
  ok(`securities copy blocked (2): ${bad.slice(0, 36)}`, rIss(bad).length > 0);
}
ok("'501-1,000 employees' stays one item", parseOutput(json({ ...make(), target_lists: [{ title: "a", headcount: "201-500 employees, 501-1,000 employees", job_titles: "CIO", geography: "NYC" }] })).content.target_lists[0].headcount.length === 2);

// ---- lists and templates
ok("two lists blocks", issuesOf({}, plumber, { lists: make().target_lists.slice(0, 2) }).some((i) => i.code === "list_count"));
const dupLists = make().target_lists.map((l) => ({ ...l, title: `${l.title} again`, geography: ["Tampa"], industries: ["Property management"], job_titles: ["Property Manager"] }));
ok("three rewordings of one search block", issuesOf({}, plumber, { lists: dupLists }).some((i) => i.code === "list_repeat"));
ok("a list with no geography blocks", issuesOf({}, plumber, { lists: [{ ...make().target_lists[0], geography: [] }, ...make().target_lists.slice(1)] }).some((i) => i.code === "list_geo"));
ok("client exclusions missing from a list warns", issuesOf({}, { ...plumber, exclusions: "No competitors" }).some((i) => i.code === "list_exclusions"));
ok("a missing reply template blocks", issuesOf({}, plumber, { templates: { interested: "Yes?", question: "Q?", not_now: "", referral: "R?" } }).some((i) => i.code === "templates"));
ok("a template over 400 blocks", issuesOf({}, plumber, { templates: { ...make().reply_templates, referral: "x".repeat(401) } }).some((i) => i.code === "too_long" && i.where === "Reply template · referral"));

// ---- dates
ok("days listed after the month all count", datesIn("Nov 16th, 19th and 20th", nov3).map((d) => d.toISOString().slice(0, 10)).join() === "2026-11-16,2026-11-19,2026-11-20");
ok("a year is not a day", datesIn("Nov 16, 2026", nov3).length === 1);
ok("'Marcus 30' / 'I may 20 times' are not dates", datesIn("Marcus 30 and I may 20 times", nov3).length === 0);
ok("16-20 Nov and 11/16 are dates", datesIn("16-20 Nov", nov3).length === 2 && datesIn("on 11/16", nov3).length === 1);
ok("expiry = LAST date in the outbound copy", expiresOn(make({ "Value-led.step3": "In NYC Nov 16, 19 or 20?" }), plumber, nov3) === "2026-11-20");
const dp = datedPieces(make({ "Value-led.step3": "In NYC Nov 16, 19 or 20?" }), plumber, nov3);
ok("dated pieces: first date + which messages", dp.first === "2026-11-16" && dp.pieces.join() === "Value-led · Message 3");
ok("dates in reply templates don't set expiry", expiresOn(make({}, { templates: { ...make().reply_templates, interested: "Nov 18?" } }), plumber, nov3) === null);
ok("worst-case fill: {{company}} = 40", filledLength("{{company}}") === 40 && filledLength("{{first_name}}") === 15 && filledLength("{{city}}") === 20);

// ---- generate / revise
const fake = (texts) => { let n = 0; const seen = []; const fn = async (a) => { seen.push(a); const t = texts[Math.min(n, texts.length - 1)]; n += 1; return { text: t, usage: { input_tokens: 10, output_tokens: 5 }, model: "fake" }; }; fn.seen = seen; return fn; };
let f = fake([json(make())]);
let r = await generate({ answers: plumber, draftFn: f });
ok("a clean first answer = one call, clean", r.clean && r.calls.length === 1 && !r.retried);
ok("the call carries our system prompt and temperature 0.7", f.seen[0].system === buildSystem(plumber) && f.seen[0].temperature === 0.7);
f = fake(["not json", json(make())]);
r = await generate({ answers: plumber, draftFn: f });
ok("a parse failure retries once", r.retried === "parse" && r.calls.length === 2 && r.clean);
f = fake(["not json", "still not json"]);
r = await generate({ answers: plumber, draftFn: f });
ok("two parse failures -> not ok, never a third call", !r.ok && r.calls.length === 2 && r.parseError);
f = fake([json(make({ "Value-led.step1": "x".repeat(450) + "?" })), json(make())]);
r = await generate({ answers: plumber, draftFn: f });
ok("blocking problems get one repair with the first answer as history", r.retried === "repair" && r.clean && f.seen[1].history.length === 2 && /PROBLEMS/.test(f.seen[1].context));
f = fake([json(make({ "Value-led.step1": "x".repeat(450) + "?" })), json(make({ "Value-led.step1": "x".repeat(450) + "?", "Direct.step1": "x".repeat(450) + "?" }))]);
r = await generate({ answers: plumber, draftFn: f });
ok("a worse repair is thrown away", r.retried === "repair_discarded" && r.calls.length === 2 && !r.clean);
f = fake([json(make())]);
r = await generate({ answers: raiser, draftFn: f });
ok("a regulated client always gets the engine's lawyer line in the notes", /lawyer should confirm/.test(r.content.notes_for_reviewer));
f = fake([json(make())]);
r = await revise({ answers: plumber, draftFn: f, current: make(), feedback: "Shorter please" });
ok("revise sends the feedback and the current JSON", /Shorter please/.test(f.seen[0].context) && /THE CURRENT VERSION/.test(f.seen[0].context));

// ---- review sheet
const sheet = formatForReview(await generate({ answers: plumber, draftFn: fake([json(make({ "Direct.step2": "No question here." }))]) }), plumber);
ok("sheet shows both variants, lists and templates", /VARIANT: Value-led/.test(sheet) && /VARIANT: Direct/.test(sheet) && /TARGET LISTS/.test(sheet) && /REPLY TEMPLATES/.test(sheet));
ok("sheet shows worst-case lengths", /as written, \d+ worst case \/ 300 max/.test(sheet));

// ---- website text
ok("a normal site is allowed", safeSiteUrl("ruizplumbing.com")?.hostname === "ruizplumbing.com");
for (const bad of ["http://localhost:3000", "http://127.0.0.1", "http://10.0.0.5", "http://[::1]/", "http://169.254.169.254/latest", "file:///etc/passwd", "http://intranet", "https://x.vercel.app", "https://a.supabase.co", "http://site.com:8080", "http://user:pw@site.com"]) {
  ok(`unsafe site refused: ${bad}`, safeSiteUrl(bad) === null);
}
ok("html -> text drops scripts and tags", htmlToText("<html><script>alert(1)</script><h1>Hi</h1><p>A &amp; B</p></html>") === "Hi\nA & B");
ok("html -> text caps length", htmlToText("<p>" + "word ".repeat(1000) + "</p>").length <= 2000);
const fakeFetch = async (url) => url.includes("redirect") ? { status: 302, headers: new Map([["location", "http://127.0.0.1/"]]), ok: false } : { status: 200, ok: true, headers: new Map([["content-type", "text/html"]]), text: async () => "<p>Hello</p>", body: null };
const pub = async () => [{ address: "93.184.216.34" }];
ok("a redirect to an unsafe host gives ''", (await fetchSiteText("https://redirect.example.org", { fetchFn: fakeFetch, lookupFn: pub })) === "");
ok("a safe page gives its text", (await fetchSiteText("https://fine.example.org", { fetchFn: fakeFetch, lookupFn: pub })) === "Hello");
ok("a public name that resolves to a private IP gives ''", (await fetchSiteText("https://sneaky.example.org", { fetchFn: fakeFetch, lookupFn: async () => [{ address: "169.254.169.254" }] })) === "");
ok("private IPs are spotted", ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"].every(isPrivateIp) && !isPrivateIp("93.184.216.34"));

// ---- stripe
const secret = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
const t = 1793750000;
const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
ok("a correct signature passes", verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 10).ok);
ok("a wrong secret fails", !verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", t + 10).ok);
ok("a changed body fails", !verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, secret, t + 10).ok);
ok("an old event fails", verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 400).reason === "too_old");
ok("no secret fails closed", verifyStripeSignature(body, `t=${t},v1=${sig}`, "", t).reason === "no_secret");
ok("a parsed object can't be verified", verifyStripeSignature({ a: 1 }, `t=${t},v1=${sig}`, secret, t).reason === "no_raw_body");
const cs = readStripeEvent({ type: "checkout.session.completed", data: { object: { payment_status: "paid", amount_total: 100000, payment_link: "plink_1", client_reference_id: "0e29a7b7-0c70-4db0-a301-eac588dcbd3e", customer: "cus_1", subscription: "sub_1", customer_details: { email: "Daniel@8thStreet.holdings" }, created: t } } });
ok("checkout: first payment with the client id", cs.kind === "first_payment" && cs.liClientId === "0e29a7b7-0c70-4db0-a301-eac588dcbd3e" && cs.email === "daniel@8thstreet.holdings");
ok("checkout: a junk reference id is dropped", readStripeEvent({ type: "checkout.session.completed", data: { object: { payment_status: "paid", client_reference_id: "'; drop" } } }).liClientId === null);
ok("invoice.paid subscription_create = first payment", readStripeEvent({ type: "invoice.paid", data: { object: { billing_reason: "subscription_create", amount_paid: 100000 } } }).kind === "first_payment");
ok("invoice.paid subscription_cycle = renewal", readStripeEvent({ type: "invoice.paid", data: { object: { billing_reason: "subscription_cycle", amount_paid: 100000 } } }).kind === "renewal");
ok("a $0 checkout is not a payment", readStripeEvent({ type: "checkout.session.completed", data: { object: { payment_status: "paid", amount_total: 0 } } }).kind === "link");
ok("a $0 invoice is not a payment", readStripeEvent({ type: "invoice.paid", data: { object: { billing_reason: "subscription_create", amount_paid: 0 } } }).kind === "link");
const inv = readStripeEvent({ type: "invoice.paid", data: { object: { billing_reason: "manual", amount_paid: 100000, lines: { data: [{ price: { id: "price_LI" }, period: { end: 1796256000 } }, { pricing: { price_details: { price: "price_X" } } }] } } } });
ok("invoice price ids read in both shapes", inv.priceIds.join() === "price_LI,price_X");
ok("invoice period end = renewal date", inv.periodEnd === "2026-12-03");
ok("a LinkedIn price is recognised", isLinkedInPurchase(inv, { priceIds: "price_AIPULSE, price_LI" }));
ok("another product is not", !isLinkedInPurchase(inv, { priceIds: "price_AIPULSE" }));
ok("nothing configured = nothing recognised by email", !isLinkedInPurchase(inv, {}));
ok("the LinkedIn payment link is recognised", isLinkedInPurchase(cs, { paymentLinkIds: "plink_1" }));
ok("other events are ignored", readStripeEvent({ type: "customer.created", data: { object: {} } }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
