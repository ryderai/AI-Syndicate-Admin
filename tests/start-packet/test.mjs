/* Start packets — the pure rules (lib/start-packet.js). 6 Nov 2026.
 * Run: node tests/start-packet/test.mjs — no key, no network. */
import {
  validateDraft, validateReturn, contentFingerprint, fillBlanks, paymentLinkFor, publicView, teamEmail, clientEmailDraft,
  checkSignature, teamList, questionsFor, partsFor, stageLabel, checkStripeCard, CONSENT_TEXT, QUESTIONS,
} from "../../lib/start-packet.js";
import { sendTeamEmail } from "../../lib/start-notify.js";
import { standardFormLink } from "../../lib/start-questions.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); } };

const base = {
  id: "11111111-2222-3333-4444-555555555555", business: "ZZ Test Roofing", contact_name: "Pat Lee", contact_email: "pat@example.com",
  website: "https://zztest.example.com/", form_kind: "geo",
  proposal: { package: "GEO Strategic Partnership", price: "$1,000 / month", term: "3 months, then $99 / month", start_date: "2026-11-16", includes: "Baseline audit\nWeekly GEO work", notes: "", doc_url: "" },
  contract_title: "GEO Strategic Agreement", contract_text: "# Parties\n\nThis is between AI Syndicate and {{business}}.\n\nFee: {{price}}. {{nope}}",
  payment_url: "https://buy.stripe.com/test_abc123", payment_note: "$1,000 today, then monthly", stripe_customer_id: "",
};

// ---- the team's draft
let d = validateDraft({ business: "" });
ok("business is needed even for a draft", !d.ok && d.errors.business);
d = validateDraft({ business: "A", website: "not a url" });
ok("a bad website is caught", !d.ok && d.errors.website);
d = validateDraft({ business: "A", website: "example.com" });
ok("a bare domain becomes https://", d.ok && d.value.website === "https://example.com/");
d = validateDraft({ business: "A" }, { forSend: true });
ok("before signing: contact, email, package, price, agreement and Stripe link are needed",
  ["contact_name", "contact_email", "package", "price", "contract_text", "payment_url"].every((k) => d.errors[k]), JSON.stringify(d.errors));
d = validateDraft({ ...base, contract_text: "", has_pdf: true }, { forSend: true });
ok("a PDF counts as the agreement", d.ok, JSON.stringify(d.errors));
d = validateDraft({ ...base, payment_url: "http://buy.stripe.com/x" });
ok("the Stripe link must be https", !d.ok && d.errors.payment_url);
d = validateDraft({ ...base, stripe_customer_id: "abc" });
ok("Stripe customer ids start with cus_", !d.ok && d.errors.stripe_customer_id);
d = validateDraft({ ...base, lead_id: "drop table" });
ok("a junk lead id is dropped", d.ok && d.value.lead_id === null);
d = validateDraft({ ...base, form_kind: "weird" });
ok("an unknown question set falls back to GEO only", d.value.form_kind === "geo");

// ---- what CJ signs
const fp = contentFingerprint(base);
ok("the fingerprint is a sha256", /^[0-9a-f]{64}$/.test(fp));
ok("same packet, same fingerprint", contentFingerprint({ ...base }) === fp);
ok("a price change changes the fingerprint", contentFingerprint({ ...base, proposal: { ...base.proposal, price: "$900 / month" } }) !== fp);
ok("an agreement change changes the fingerprint", contentFingerprint({ ...base, contract_text: base.contract_text + "!" }) !== fp);
ok("a new PDF changes the fingerprint", contentFingerprint({ ...base, contract_pdf_sha256: "a".repeat(64) }) !== fp);
ok("the Stripe link is part of what's signed", contentFingerprint({ ...base, payment_url: "https://buy.stripe.com/other" }) !== fp);
ok("the website is part of what's signed", contentFingerprint({ ...base, website: "https://other.example.com/" }) !== fp);
ok("the question set is part of what's signed", contentFingerprint({ ...base, form_kind: "website_geo" }) !== fp);
ok("form_kind 'constructor' can't sneak through", validateDraft({ ...base, form_kind: "constructor" }).value.form_kind === "geo");

// ---- blanks
const filled = fillBlanks(base.contract_text, base, new Date("2026-11-06T18:00:00Z"));
ok("{{business}} and {{price}} fill in", filled.includes("AI Syndicate and ZZ Test Roofing") && filled.includes("Fee: $1,000 / month"));
ok("an unknown blank stays visible", filled.includes("{{nope}}"));
ok("{{today}} is a real date", fillBlanks("{{today}}", base, new Date("2026-11-06T18:00:00Z")) === "November 6, 2026");

// ---- Stripe link
const pl = new URL(paymentLinkFor(base));
ok("a Payment Link gets our id as client_reference_id", pl.searchParams.get("client_reference_id") === base.id);
ok("and the client's email pre-filled", pl.searchParams.get("prefilled_email") === "pat@example.com");
const other = paymentLinkFor({ ...base, payment_url: "https://billing.stripe.com/p/session/xyz" });
ok("any other Stripe page is used as it is", other === "https://billing.stripe.com/p/session/xyz");
ok("no link, no payment step", paymentLinkFor({ ...base, payment_url: "" }) === null);

// ---- signatures
ok("typed signature needs a name", !checkSignature({ kind: "typed", data: "" }, "").ok);
ok("typed signature uses the name", checkSignature({ kind: "typed" }, "Pat Lee").value.data === "Pat Lee");
ok("drawn signature must be a PNG data URL", !checkSignature({ kind: "drawn", data: "javascript:alert(1)" }).ok);
ok("a huge drawn signature is refused", !checkSignature({ kind: "drawn", data: "data:image/png;base64," + "A".repeat(260000) }).ok);
ok("a normal drawn signature passes", checkSignature({ kind: "drawn", data: "data:image/png;base64," + "A".repeat(2000) }).ok);

// ---- the client's send-back
const good = {
  signer: { name: "Pat Lee", title: "Owner", email: "pat@example.com" }, signature: { kind: "typed" }, consent: true,
  answers: { c_name: "Pat Lee", c_email: "pat@example.com", b_name: "ZZ Test Roofing", b_offer: "Roofs", w_url: "zztest.example.com", b_area: "Statewide", w_platform: "WordPress", n_goals: ["x"] },
  payment_done: true,
};
let r = validateReturn(good, base);
ok("a good send-back passes", r.ok, JSON.stringify(r.errors));
ok("the website answer is tidied to https", r.value.answers.w_url === "https://zztest.example.com/");
ok("website-only questions are dropped on a GEO-only packet", !("n_goals" in r.value.answers));
r = validateReturn({ ...good, consent: false }, base);
ok("no consent, no signing", !r.ok && r.errors.consent);
r = validateReturn({ ...good, answers: { ...good.answers, b_offer: "" } }, base);
ok("a required answer is required", !r.ok && r.errors.b_offer);
r = validateReturn({ ...good, answers: { ...good.answers, b_area: "Mars" } }, base);
ok("a made-up choice is refused", !r.ok && r.errors.b_area);
r = validateReturn({ ...good, payment_done: false }, base);
ok("payment: tick the box or say how you'll pay", !r.ok && r.errors.payment);
r = validateReturn({ ...good, payment_done: false, payment_note: "Check in the mail" }, base);
ok("paying another way is fine with a note", r.ok);
r = validateReturn({ ...good, payment_done: false }, { ...base, payment_url: "" });
ok("no Stripe link, no payment needed", r.ok);
r = validateReturn({ ...good, hp_fax: "buy now" }, base);
ok("the honeypot stops a bot", r.bot === true);
r = validateReturn({ ...good, answers: { ...good.answers, n_goals: ["Look more established", "hack"] } }, { ...base, form_kind: "website_geo" });
ok("website questions count on a Website + GEO packet, junk choices dropped", r.ok && r.value.answers.n_goals.length === 1);
ok("no question asks for a password", !QUESTIONS.some((q) => /password|passcode/i.test(q.label + (q.hint || ""))));
ok("GEO only has fewer questions than Website + GEO", questionsFor("geo").length < questionsFor("website_geo").length && partsFor("geo").length === 5);

// ---- what the client sees
const signed = { ...base, status: "sent", ais_signed_at: "2026-11-06T20:00:00Z", ais_signer_name: "CJ Britton", ais_signature: { kind: "typed", data: "CJ Britton" }, contract_sha256: fp, token_hash: "secret", stripe_customer_id: "cus_TEST123456", created_by_email: "julia@aisyndicate.com" };
const pv = publicView(signed);
ok("the client view has no token hash, Stripe customer or our emails", !JSON.stringify(pv).includes("secret") && !JSON.stringify(pv).includes("cus_TEST") && !JSON.stringify(pv).includes("julia@"));
ok("the agreement shows with blanks filled", pv.contract_text.includes("ZZ Test Roofing"));
ok("CJ's signature shows", pv.ais_signature.name === "CJ Britton");
ok("the consent wording is the server's", pv.consent_text === CONSENT_TEXT);
ok("not sent back yet = no receipt", pv.returned === false && pv.receipt === null);

// ---- the team copy
const back = { ...signed, status: "returned", returned_at: "2026-11-07T15:00:00Z", client_sig: { name: "Pat Lee", title: "Owner", email: "pat@example.com", signed_at: "2026-11-07T15:00:00Z", ip: "203.0.113.9" }, answers: validateReturn(good, base).value.answers, payment_status: { client_says_done: true } };
const mail = teamEmail(back, { consoleUrl: "https://ai-syndicate-admin.vercel.app/#/dashboard/start?id=x" });
ok("team email subject names the client", mail.subject === "Signed + sent back: ZZ Test Roofing start packet");
ok("team email has both signatures, the fingerprint, payment and answers",
  ["Pat Lee, Owner <pat@example.com>", "CJ Britton", fp, "card added in Stripe: yes", "What do you offer?: Roofs", "WHAT A WIN LOOKS LIKE"].every((s) => mail.text.includes(s)), mail.text.slice(0, 400));
ok("team email times are Central", /CT/.test(mail.text));
ok("client email says 'onboarding form' when we send our form, 'questions' when we don't",
  clientEmailDraft({ ...signed, proposal: { ...signed.proposal, onboarding_url: "https://geo-onboarding-woad.vercel.app/" } }, "https://x/start/?t=1").body.includes("fill in our onboarding form")
  && clientEmailDraft({ ...signed, proposal: { ...signed.proposal, onboarding_url: "" } }, "https://x/start/?t=1").body.includes("answer a few questions"));
ok("team email opens with who the client is and who sent it", mail.text.indexOf("CLIENT") < mail.text.indexOf("SIGNED") && mail.text.includes("- Business: ZZ Test Roofing") && /- Contact: .+<.+@.+>/.test(mail.text) && mail.text.includes("- Sent by: CJ Britton"), mail.text.slice(0, 400));
ok("returned packet gives the client a receipt", publicView(back).receipt.signer.name === "Pat Lee");

// ---- team list + the client email draft
ok("team list = the four of us by default", teamList().join() === "cj@aisyndicate.com,andrew@aisyndicate.com,julia@aisyndicate.com,ryder@aisyndicate.com");
ok("the sender is added, no doubles, junk dropped", teamList(["Cameron@aisyndicate.com", "cj@aisyndicate.com", "nope"]).length === 5);
process.env.START_PACKET_TEAM = "a@aisyndicate.com, b@aisyndicate.com";
ok("START_PACKET_TEAM overrides the list", teamList().join() === "a@aisyndicate.com,b@aisyndicate.com");
delete process.env.START_PACKET_TEAM;
const ce = clientEmailDraft(base, "https://x/start/?t=abc", "Julia Craig");
ok("client email has the link, their first name and the sender", ce.body.includes("https://x/start/?t=abc") && ce.body.startsWith("Hi Pat,") && ce.body.trim().endsWith("Julia Craig"));
ok("stage labels read plainly", stageLabel({ status: "draft" }).includes("sign it") && stageLabel({ status: "returned" }) === "Signed + sent back");

// ---- Stripe check never throws and never writes
const calls = [];
const fakeStripe = (cust, pms) => ({ customers: {
  retrieve: async (id) => { calls.push(["retrieve", id]); if (cust instanceof Error) throw cust; return cust; },
  listPaymentMethods: async (id) => { calls.push(["list", id]); return { data: pms }; },
} });
ok("card on file via default payment method", (await checkStripeCard(fakeStripe({ email: "p@x.com", invoice_settings: { default_payment_method: "pm_1" } }, []), "cus_1")).state === "card");
ok("card on file via payment methods list", (await checkStripeCard(fakeStripe({ email: "p@x.com", invoice_settings: {} }, [{ id: "pm_1" }]), "cus_1")).state === "card");
ok("no card yet", (await checkStripeCard(fakeStripe({ email: "p@x.com", invoice_settings: {} }, []), "cus_1")).state === "none");
ok("a Stripe error = unknown, not a crash", (await checkStripeCard(fakeStripe(new Error("boom"), []), "cus_1")).state === "unknown");
ok("only read calls were made", calls.every(([k]) => k === "retrieve" || k === "list"));

// ---- the team email can't reach a client
let sentTo = null;
const fakeFetch = async (_u, o) => { sentTo = JSON.parse(o.body).to; return { ok: true, text: async () => "" }; };
process.env.RESEND_API_KEY = "test";
let s = await sendTeamEmail({ to: ["pat@example.com", "ryder@aisyndicate.com"], allowed: teamList(), subject: "x", text: "y" }, { fetchImpl: fakeFetch });
ok("a client address is stripped from a team email", s.sent && sentTo.join() === "ryder@aisyndicate.com");
s = await sendTeamEmail({ to: ["pat@example.com"], allowed: teamList(), subject: "x", text: "y" }, { fetchImpl: fakeFetch });
ok("only-client = nothing sent", !s.sent && s.reason === "no_team_recipient");
delete process.env.RESEND_API_KEY;
s = await sendTeamEmail({ to: ["ryder@aisyndicate.com"], allowed: teamList(), subject: "x", text: "y" }, { fetchImpl: fakeFetch });
ok("no Resend key = says so, doesn't throw", !s.sent && s.reason === "no_resend_key");

// ---- onboarding by our form link + proposal PDF (9 Nov 2026)
const viaForm = { ...base, proposal: { ...base.proposal, onboarding_url: "https://geo-onboarding-woad.vercel.app/?for=ZZ", pdf_path: "x/proposal-1.pdf", pdf_name: "Proposal.pdf", pdf_sha256: "b".repeat(64) } };
ok("the standard form link is made out to the client", standardFormLink("ZZ Test Roofing", "https://www.zztest.example.com/") === "https://geo-onboarding-woad.vercel.app/?for=ZZ+Test+Roofing&site=zztest.example.com");
ok("an http onboarding link is refused", !validateDraft({ ...base, proposal: { ...base.proposal, onboarding_url: "http://x.example.com" } }).ok);
ok("the onboarding link is part of what's signed", contentFingerprint(viaForm) !== contentFingerprint({ ...viaForm, proposal: { ...viaForm.proposal, onboarding_url: "https://other.example.com/" } }));
ok("the proposal PDF is part of what's signed", contentFingerprint(viaForm) !== contentFingerprint({ ...viaForm, proposal: { ...viaForm.proposal, pdf_sha256: "c".repeat(64) } }));
let rf = validateReturn({ ...good, answers: {}, onboarding_done: false }, viaForm);
ok("via the form: no packet questions needed, but they must say it's sent", !rf.ok && rf.errors.onboarding && !rf.errors.b_offer, JSON.stringify(rf.errors));
rf = validateReturn({ ...good, answers: {}, onboarding_done: true }, viaForm);
ok("via the form: ticked = fine", rf.ok && rf.value.onboarding.client_says_sent === true, JSON.stringify(rf.errors));
const pvf = publicView({ ...viaForm, status: "sent" }, { proposalPdfUrl: "https://signed/x" });
ok("client view: the form link, the proposal PDF link, no questions, no storage path", pvf.onboarding.url.includes("geo-onboarding") && pvf.proposal_pdf.url === "https://signed/x" && pvf.questions.length === 0 && !JSON.stringify(pvf).includes("x/proposal-1.pdf"));
const mf = teamEmail({ ...viaForm, status: "returned", client_sig: { name: "Pat", email: "pat@example.com", signed_at: "2026-11-09T17:00:00Z", onboarding: { via: "form", client_says_sent: true } }, answers: {}, payment_status: {} });
ok("team email names the onboarding form and the proposal PDF", mf.text.includes("ONBOARDING") && mf.text.includes("Client says they sent it: yes") && mf.text.includes("Proposal PDF: Proposal.pdf") && !mf.text.includes("ANSWERS ("), mf.text.slice(0, 500));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
