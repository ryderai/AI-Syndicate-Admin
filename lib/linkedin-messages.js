/* LINKEDIN OUTREACH — THE MESSAGING ENGINE (Build 1, v2).  3 Nov 2026
 *
 * WHY THIS FILE EXISTS
 *
 * CJ's "LinkedIn Outreach — Build Brief for Ryder" (3 Nov 2026, the Claude
 * Doc linked from his email "LinkedIn Outreach build brief"), Build 1: "One
 * Claude API call turns a completed onboarding form into two approved-ready
 * messaging sequences, three target list specs and four client reply
 * templates, stored as a draft in the console within minutes of payment."
 * Today CJ writes these by hand; the brief moves that work here.
 *
 * v1 of this file (3 Nov) was written before the brief could be read — it
 * made one sequence with an A/B note and no lists or templates. v2 follows
 * the brief's output schema, limits and rules exactly. v1 is kept in
 * AI-Syndicate/LinkedIn-Engine-Nov03/v1-code-backup/.
 *
 * WHAT IT NEVER DOES
 *  - Send anything. The brief: "Claude writes and classifies; Julie sends."
 *  - Decide copy is ready. Every version starts as a draft; a person moves it.
 *  - Write as AI Syndicate. The copy goes out in the CLIENT's voice, so the
 *    route sends our own system prompt below and none of the console's
 *    Brain rows.
 *
 * THE PARTS (all pure except generate()/revise(), which take the model call
 * as an argument so the tests need no key and no network):
 *   riskReview · buildSystem · buildUserMessage · buildRevisionMessage ·
 *   parseOutput · checkOutput · generate · revise · expiresOn · formatForJulie
 */

/* Bump on ANY change to the prompt or the rules it states. Stored on every
 * version, so a copy change can be compared against reply rates later (the
 * brief's "Prompt versions are tracked" guardrail). */
export const PROMPT_VERSION = "li-seq-2026-11-03.2";

/* ------------------------------------------------------------------ */
/* Limits — the brief's numbers, with one guard of ours                */
/* ------------------------------------------------------------------ */

/* The brief: connection note <= 300, Messages 1-3 <= 400, Message 3 <= 20
 * words. ONE CHANGE, flagged for CJ: LinkedIn caps notes at 200 characters
 * on accounts without Premium / Sales Navigator (sources disagree, checked
 * 3 Nov 2026; hublead.io quotes LinkedIn Help as 200). So the note limit is
 * 300 when the form says Sales Navigator Core is active, else 200 — a note
 * that is too long cannot be sent at all. Message 4 (the breakup) and the
 * reply templates use 400 too (the brief gives suggested replies 400 in
 * Build 2). InMail: 200 subject / 1,900 body. */
export const LIMITS = Object.freeze({
  note_sales_nav: 300,
  note_basic: 200,
  message: 400,
  message3_words: 20,
  inmail_subject: 200,
  inmail_body: 1900,
  reply_template: 400,
});

/* The brief's schema: delay_days from the previous step; step 1 from
 * connection acceptance. */
export const DELAYS = Object.freeze([1, 2, 4, 7]);
export const VARIANT_NAMES = Object.freeze(["Value-led", "Direct"]);
export const REPLY_KEYS = Object.freeze(["interested", "question", "not_now", "referral"]);
export const LIST_COUNT = 3;

/* The brief: "Only {{first_name}}, {{company}} and {{city}} as merge tokens."
 * Lengths are checked with each one filled in at its worst case, so a note
 * that fits as written still fits once Julie types a long name. */
export const MERGE_FIELDS = Object.freeze(["{{first_name}}", "{{company}}", "{{city}}"]);
const FILL_WORST = { "{{first_name}}": 15, "{{company}}": 40, "{{city}}": 20 };

export function noteLimit(answers = {}) {
  const v = answers?.sales_nav;
  return v === true || /^\s*(yes|y|true|active)\b/i.test(String(v ?? "")) ? LIMITS.note_sales_nav : LIMITS.note_basic;
}

/* House banned words (lib/ai.js BASE_PROMPT) and phrases that read like a
 * mass message. Warn, not block. */
const BANNED_WORDS = ["leverage", "robust", "holistic", "synergy", "utilize", "ecosystem", "granular", "seamless", "actionable insights", "best-in-class"];
const STALE_PHRASES = ["hope this finds you well", "hope you're doing well", "touch base", "circle back", "pick your brain", "i came across your profile"];

/* ------------------------------------------------------------------ */
/* 1. Risk review                                                      */
/* ------------------------------------------------------------------ */

/* The brief: "If the business is a financial product, investment, insurance
 * or anything regulated: invite the prospect to request information, never
 * state terms, returns or guarantees in the message", and
 * notes_for_reviewer "must flag it". A kind is flagged by ONE strong word or
 * TWO ordinary ones, from what the client wrote about the business (not the
 * industries they target — Daniel targets insurers but sells no insurance).
 * `blocked` is what the checker refuses in the copy for that kind. Tuned in
 * two adversarial passes on 3 Nov 2026 (a bakery that "guarantees freshness"
 * must not flag; "raising $5M from investors for our fund" must). */
export const RISK_KINDS = Object.freeze({
  securities: {
    label: "Investment / securities offer",
    min: 2,
    strong: [/\bspv\b/i, /\bpreferred return\b/i, /\bsblc\b/i, /\baccredited investors?\b/i, /\bprivate placement\b/i, /\bcapital raise\b/i, /\breg(ulation)? d\b/i, /\b506\s?\(?[bc]\)?/i, /\bminimum investment\b/i, /\braising (\$|capital|money|funds) (from|for) (investors|our)/i, /\binvestors? (for|in) (our|the|a|my) (fund|deal|offering|vehicle)/i, /\bco-?invest/i, /\b(real estate|investment|deal) syndicat/i],
    signals: [/\bdistributions?\b/i, /\bsyndicat(e|ion|ing)\b/i, /\binvestors?\b/i, /\bour fund\b/i, /\byield\b/i, /\bequity stake\b/i, /\blimited partners?\b/i, /\breturns? (of|on)\b/i, /\d+\s?% returns?\b/i, /\boffering\b/i, /\bpassive income\b/i, /\bfundrais(e|ing)\b/i],
    blocked: [/guarantee/i, /risk[- ]free/i, /low[- ]risk/i, /downside/i, /\bprotected\b/i, /\bsafe\b/i, /\bsecured\b/i, /\bper ?cent\b/i, /\b\d+(\.\d+)?x\b/i, /\bdeck\b/i, /\b(first|final) close\b/i, /\bminimum (ticket|investment|check|commitment)\b/i, /\bLPs?\b/, /\bupside\b/i, /\b(monthly|passive|current) income\b/i, /\bbn\b/i, /\bvehicle\b/i, /double[- ]digit/i, /\byield/i, /preferred return/i, /\bsblc\b/i, /letter of credit/i, /bank[- ]to[- ]bank/i, /\binvest(ing|ment|ments|ed)?\b/i, /\breturns?\b/i, /\bpercent\b/i, /\ballocation/i, /\b(our|the|my|this) fund\b/i, /\bspv\b/i, /\baccredited\b/i, /\birr\b/i, /\bprincipal (is |at risk|protect|secur|back|guarant)/i, /\bcapital raise\b/i, /\braising (capital|money|funds)\b/i, /\bcloses? (soon|on|this)\b/i, /not (here )?to pitch|not a pitch|no pitch|not selling/i, /\bdistributions?\b/i, /\bcash flows?\b/i, /capital preservation/i, /\b(no|zero|little|minimal) risk\b/i, /\bROI\b/i, /tax[- ](advantaged|free|efficient)/i, /collateral/i, /\binsured\b/i, /\b\w+[- ]month term\b/i, /\bterms\b/i, /\b(spots?|seats?|places?) (are |is )?(limited|left)|limited (spots?|seats?|allocation)/i, /\bmonth[- ]end\b/i, /\bco-?invest/i, /\bsyndicat/i, /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)[- ](percent|million|billion|thousand|month|year)s?\b/i, /\b(hundred|thousand|million|billion|trillion)\b/i, /\$\s?\d/, /\d+(\.\d+)?\s?%/, /\b\d+(\.\d+)?\s?(b|bn|billion|m|mm|million)\b/i],
  },
  insurance: {
    label: "Insurance",
    min: 2,
    strong: [/\binsurance agency\b/i, /\bannuit(y|ies)\b/i, /\bwe (sell|write|place) (insurance|policies|coverage)\b/i],
    signals: [/\bpolic(y|ies)\b/i, /\bpremiums?\b/i, /\bcoverage\b/i, /\bunderwrit/i, /\bcarriers?\b/i, /\bclaims?\b/i],
    blocked: [/guarantee/i, /\bsave \$?\d/i, /\$\s?\d/, /\d+(\.\d+)?\s?%/, /\bcheapest\b/i, /\blowest rate\b/i],
  },
  lending: {
    label: "Lending or credit",
    min: 2,
    strong: [/\bmortgage (broker|lender)\b/i, /\bwe (lend|finance)\b/i],
    signals: [/\bmortgages?\b/i, /\bloans?\b/i, /\blending\b/i, /\bcredit lines?\b/i, /\binterest rates?\b/i, /\bAPR\b/],
    blocked: [/guarantee/i, /\bpre-?approved\b/i, /\d+(\.\d+)?\s?%/, /\bAPR\b/, /\$\s?\d/],
  },
  health: {
    label: "Health or medical",
    min: 2,
    strong: [/\bfda\b/i, /\bclinical trial/i],
    signals: [/\bpatients?\b/i, /\bmedical\b/i, /\bclinic(al)?\b/i, /\btreatments?\b/i, /\bdiagnos/i, /\bsupplements?\b/i, /\btherap(y|ies)\b/i],
    blocked: [/\bcures?\b/i, /\bprevents?\b/i, /\bheals?\b/i, /\bclinically proven\b/i, /guarantee/i],
  },
  legal: {
    label: "Legal services",
    min: 2,
    strong: [/\blaw firm\b/i],
    signals: [/\battorneys?\b/i, /\blawyers?\b/i, /\binjury\b/i, /\bsettlements?\b/i, /\blitigation\b/i],
    blocked: [/guarantee/i, /\bwin\b.*\bcase\b/i, /\$\s?\d/],
  },
});

const BUSINESS_FIELDS = ["about_business", "client_problem", "client_goal", "client_steps", "free_resources", "case_studies", "goals"];

/** Which regulated kinds the client's own answers describe. Pure. */
export function riskReview(answers = {}) {
  /* Our own name is not a signal: a gym that writes "AI Syndicate will
   * bring us leads" is not a syndication (3 Nov fourth check). */
  const text = BUSINESS_FIELDS.map((k) => asText(answers?.[k])).join("\n").replace(/\bai[ -]?syndicate\b/gi, " ");
  const kinds = [];
  for (const [kind, def] of Object.entries(RISK_KINDS)) {
    const found = (list = []) => [...new Set(list.filter((re) => re.test(text)).map((re) => (text.match(re) || [""])[0].toLowerCase()))];
    const strong = found(def.strong);
    const hits = found(def.signals);
    if (strong.length || hits.length >= def.min) kinds.push({ kind, label: def.label, hits: [...strong, ...hits] });
  }
  return { kinds, review: kinds.length > 0 };
}

/* ------------------------------------------------------------------ */
/* 2. The prompt                                                       */
/* ------------------------------------------------------------------ */

/* Every form field, labelled, in form order (the brief: "Every field from
 * the form, passed as labelled plain text"). Two left out on purpose: the
 * client's own email and phone. The copy never needs them, and a prompt is
 * one more place they would otherwise sit. File uploads go in as their file
 * names (the model cannot open them). */
export const FORM_FIELDS = Object.freeze([
  ["contact_name", "Client's name (the sender)"],
  ["company", "Company"],
  ["website", "Website"],
  ["sales_nav", "Sales Navigator Core active"],
  ["linkedin_url", "LinkedIn profile we send from"],
  ["about_business", "About the business"],
  ["client_problem", "Ideal client's biggest problem"],
  ["client_goal", "What the ideal client wants"],
  ["client_steps", "The 4-5 steps clients go through to get results"],
  ["free_resources", "Free resource to offer (if any)"],
  ["job_titles", "Job titles to target"],
  ["industries", "Industries to target"],
  ["headcount", "Company sizes (headcount)"],
  ["locations", "Locations"],
  ["exclusions", "Do not contact (exclusions)"],
  ["tone", "Messaging tone"],
  ["tone_notes", "Tone notes"],
  ["case_studies", "Case studies, scripts, templates"],
  ["goals", "Goals for the service"],
]);

export function firstName(answers = {}) {
  return asText(answers?.contact_name).trim().split(/\s+/)[0] || "";
}

/** The system prompt: the brief's hard rules, word for word where it gives
 * words, plus the limits this file checks. Pure. */
export function buildSystem(answers = {}, risk = riskReview(answers)) {
  const note = noteLimit(answers);
  const rules = [
    "You write LinkedIn outreach copy for one business. A person named Julie copies and pastes every message by hand from the business owner's own LinkedIn account. Nothing is sent automatically.",
    "HARD RULES — not suggestions:",
    "- Write in first person as the client. Never mention AI Syndicate, an agency, AI, or that a third party is sending.",
    "- One idea per message. Every message ends with a question, except the breakup (Message 4).",
    `- Connection note: max ${note} characters, no pitch, no link. Messages 1-3: max ${LIMITS.message} characters each. Message 3: max ${LIMITS.message3_words} words ("Thoughts, {{first_name}}?" is a valid Message 3). Message 4 is a polite breakup that leaves the door open, max ${LIMITS.message} characters.`,
    `- Count characters with merge tokens filled in by long values: {{first_name}} = ${FILL_WORST["{{first_name}}"]} characters, {{company}} = ${FILL_WORST["{{company}}"]}, {{city}} = ${FILL_WORST["{{city}}"]}. Leave room.`,
    "- Message 2 carries one specific proof point taken from the form or the case studies. If the client gave none, ask a question instead. Never invent numbers, clients, results, credentials or dates.",
    "- No links until the prospect replies. A free resource is offered in words, never attached or linked.",
    "- Match the tone field. Default to short, plain, conversational sentences. No hype, no exclamation marks in a Professional tone.",
    "- Only {{first_name}}, {{company}} and {{city}} as merge tokens. No other brackets or braces of any kind.",
    "- If the business is a financial product, investment, insurance or anything regulated: invite the prospect to request information; never state terms, returns, amounts, percentages or guarantees in any message, and never say the message is not a pitch.",
    "- If a needed fact is missing from the form, do not guess: say so in notes_for_reviewer and write around it.",
    "",
    "WHAT TO PRODUCE:",
    `- Two variants. "Value-led" opens on the ideal client's problem (as a question if stating it would mean a claim the form doesn't support) and offers the resource or insight. "Direct" opens on the proof point and asks for the call (with no proof point, it opens on the most specific true fact and asks for the call).`,
    `- Each variant: a connection note, 4 messages with delay_days ${DELAYS.join(", ")} (step 1 counted from connection acceptance, each next one from the step before), and an InMail (subject + body, max ${LIMITS.inmail_subject} / ${LIMITS.inmail_body} characters) for people who never accept.`,
    "- Three target list specs Julie can build in Sales Navigator from the titles, industries, headcount, locations and exclusions given. Split them by geography or segment — never three rewordings of the same search. Use only values the client gave (you may group and narrow them). Keep the client's top-priority locations and segments covered, and use every job title the client gave somewhere across the three lists; if you leave any out, name them in notes_for_reviewer.",
    `- Four client reply templates, written as the client, max ${LIMITS.reply_template} characters each, each ending with a next step: interested, question, not_now, referral.`,
    "- notes_for_reviewer: plain sentences on gaps in the form (no proof point, vague ideal client, compliance concern) so Julie or CJ knows what to check before the client sees it.",
    "",
    "OUTPUT: JSON only. No prose, no code fences. Exactly this shape:",
    OUTPUT_SHAPE,
  ];
  if (risk.review) {
    rules.splice(rules.indexOf("WHAT TO PRODUCE:"), 0,
      `THIS BUSINESS IS REGULATED (${risk.kinds.map((k) => k.label).join("; ")}). On top of the rules above: describe nothing about the offer's structure, size, terms or returns; no numbers at all except dates the client gave; invite the reader to ask for information, and leave every detail to the client in person. notes_for_reviewer must say this business is regulated and that the client's own lawyer should confirm the outreach is allowed.`,
      "");
  }
  return rules.join("\n");
}

const OUTPUT_SHAPE = JSON.stringify({
  variants: [
    { name: "Value-led", connection_note: "", steps: DELAYS.map((d, i) => ({ step: i + 1, delay_days: d, body: "" })), inmail: { subject: "", body: "" } },
    { name: "Direct", connection_note: "", steps: DELAYS.map((d, i) => ({ step: i + 1, delay_days: d, body: "" })), inmail: { subject: "", body: "" } },
  ],
  target_lists: [{ title: "", job_titles: [], industries: [], headcount: [], geography: [], keywords: "", exclusions: "" }],
  reply_templates: { interested: "", question: "", not_now: "", referral: "" },
  notes_for_reviewer: "",
});

/** The user message: every form field, labelled, plus up to ~2,000
 * characters of the client's homepage when we could fetch it. Pure. */
export function buildUserMessage(answers = {}, siteText = "") {
  const lines = FORM_FIELDS
    .map(([k, label]) => [label, asText(answers?.[k]).trim()])
    .map(([label, v]) => `${label}:\n${v || "(not given)"}`);
  const files = Array.isArray(answers?._files) ? answers._files.map((f) => f?.name).filter(Boolean) : [];
  if (files.length) lines.push(`Files the client uploaded (names only — not readable here):\n${files.join(", ")}`);
  const site = String(siteText || "").trim();
  if (site) lines.push(`Text from the client's homepage (context only — do not quote numbers from it unless the form also gives them):\n${site.slice(0, 2000)}`);
  return `Write the outreach for this client.\n\nTHE ONBOARDING FORM:\n\n${lines.join("\n\n")}`;
}

/** A revision: same inputs, the current JSON, and the client's feedback;
 * a full revised JSON back (the brief's revision loop). Pure. */
export function buildRevisionMessage(answers = {}, siteText = "", currentJson = {}, feedback = "") {
  return [
    buildUserMessage(answers, siteText),
    `THE CURRENT VERSION (JSON):\n${JSON.stringify(currentJson)}`,
    `THE CLIENT'S FEEDBACK:\n${String(feedback || "").trim() || "(none given)"}`,
    "Apply the feedback without breaking any hard rule. Return the FULL revised JSON in the same shape — every variant, list and template, changed or not.",
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 3. Parse                                                            */
/* ------------------------------------------------------------------ */

/** Model text -> { content, error }. Strips code fences and any sentence
 * around the JSON; normalises the shape so the checker and the screens can
 * rely on it (missing pieces become empty strings, which the checker then
 * blocks). Never throws. Pure. */
export function parseOutput(raw) {
  const text = String(raw || "").replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { content: null, error: "No JSON object in the answer." };
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { return { content: null, error: `The answer was not valid JSON (${e.message}).` }; }
  if (!obj || typeof obj !== "object") return { content: null, error: "The answer was not a JSON object." };

  const byName = new Map((Array.isArray(obj.variants) ? obj.variants : []).map((v) => [String(v?.name || "").trim().toLowerCase(), v]));
  const variants = VARIANT_NAMES.map((name, vi) => {
    const v = byName.get(name.toLowerCase()) || (Array.isArray(obj.variants) ? obj.variants[vi] : null) || {};
    const steps = DELAYS.map((d, i) => {
      const s = (Array.isArray(v.steps) ? v.steps : []).find((x) => Number(x?.step) === i + 1) || (Array.isArray(v.steps) ? v.steps[i] : null) || {};
      return { step: i + 1, delay_days: Number.isFinite(Number(s.delay_days)) ? Number(s.delay_days) : d, body: asText(s.body).trim() };
    });
    return {
      name,
      connection_note: asText(v.connection_note).trim(),
      steps,
      inmail: { subject: asText(v?.inmail?.subject).trim(), body: asText(v?.inmail?.body).trim() },
    };
  });
  const lists = (Array.isArray(obj.target_lists) ? obj.target_lists : []).map((l) => ({
    title: asText(l?.title).trim(),
    job_titles: asList(l?.job_titles),
    industries: asList(l?.industries),
    headcount: asList(l?.headcount),
    geography: asList(l?.geography),
    keywords: asText(l?.keywords).trim(),
    exclusions: asText(l?.exclusions).trim(),
  }));
  const rt = obj.reply_templates && typeof obj.reply_templates === "object" ? obj.reply_templates : {};
  const reply_templates = Object.fromEntries(REPLY_KEYS.map((k) => [k, asText(rt[k]).trim()]));
  const notes = Array.isArray(obj.notes_for_reviewer) ? obj.notes_for_reviewer.map(asText).join("\n") : asText(obj.notes_for_reviewer).trim();
  return { content: { variants, target_lists: lists, reply_templates, notes_for_reviewer: notes }, error: null };
}

/* ------------------------------------------------------------------ */
/* 4. Check                                                            */
/* ------------------------------------------------------------------ */

/** Every piece of copy as one flat list, each with the rules that apply to
 * it. `where` is how a person reads it ("Value-led · Message 2"). Pure. */
export function pieces(content, answers = {}) {
  const out = [];
  if (!content) return out;
  for (const v of content.variants || []) {
    out.push({ where: `${v.name} · Connection note`, key: `${v.name}.note`, text: v.connection_note, limit: noteLimit(answers), outbound: true, question: "warn", note: true });
    for (const s of v.steps || []) {
      out.push({
        where: `${v.name} · Message ${s.step}`, key: `${v.name}.step${s.step}`, text: s.body, outbound: true,
        limit: LIMITS.message, words: s.step === 3 ? LIMITS.message3_words : null,
        question: s.step === 4 ? null : "block", delay: s.delay_days, expectedDelay: DELAYS[s.step - 1],
      });
    }
    out.push({ where: `${v.name} · InMail subject`, key: `${v.name}.inmail_subject`, text: v.inmail?.subject, limit: LIMITS.inmail_subject, outbound: true, question: null });
    out.push({ where: `${v.name} · InMail`, key: `${v.name}.inmail`, text: v.inmail?.body, limit: LIMITS.inmail_body, outbound: true, question: "warn" });
  }
  for (const k of REPLY_KEYS) {
    out.push({ where: `Reply template · ${k.replace("_", " ")}`, key: `reply.${k}`, text: content.reply_templates?.[k], limit: LIMITS.reply_template, outbound: false, question: null });
  }
  return out;
}

/** Every problem, as [{ where, level: "block"|"warn", code, message }].
 * "block" = must not reach the client or Julie's paste as it stands. Pure. */
export function checkOutput(content, answers = {}, risk = riskReview(answers)) {
  const issues = [];
  const add = (where, level, code, message) => issues.push({ where, level, code, message });
  if (!content) { add("Whole output", "block", "no_output", "Nothing usable came back."); return issues; }

  /* Digits may only come from what the model was shown (the form fields
   * above, never the phone number or URLs, which let invented numbers
   * through in the 3 Nov check). */
  const factText = FORM_FIELDS.filter(([k]) => !["linkedin_url", "website", "headcount", "sales_nav"].includes(k)).map(([k]) => asText(answers?.[k])).join("\n");
  const factDigits = new Set(factText.match(/\d+/g) || []);
  const blocked = risk.kinds.flatMap((k) => RISK_KINDS[k.kind].blocked.map((re) => ({ re, kind: k.kind })));
  const securities = risk.kinds.some((k) => k.kind === "securities");
  const company = asText(answers?.company).trim();

  for (const p of pieces(content, answers)) {
    const raw = String(p.text || "");
    if (!raw.trim()) { add(p.where, "block", "empty", "Missing — the model did not write this."); continue; }
    const value = normalise(raw);

    const len = filledLength(raw);
    if (len > p.limit) add(p.where, "block", "too_long", `${len} characters once names are filled in (worst case) — the limit is ${p.limit}.`);
    if (p.words) {
      const words = value.trim().split(/\s+/).filter(Boolean).length;
      if (words > p.words) add(p.where, "block", "too_many_words", `${words} words — the limit for Message 3 is ${p.words}.`);
    }
    if (p.question) {
      const ends = value.trim().replace(/["')\]]+$/, "").endsWith("?");
      if (!ends) add(p.where, p.question, "no_question", "Doesn't end with a question.");
    }
    if (p.expectedDelay && p.delay !== p.expectedDelay) add(p.where, "block", "delay", `delay_days is ${p.delay}; the brief says ${p.expectedDelay}.`);

    for (const m of value.match(/\{\{[^}]*\}\}|\{[^{}]*\}/g) || []) {
      if (!MERGE_FIELDS.includes(m)) add(p.where, "block", "merge_field", `Unknown merge token ${m} — only ${MERGE_FIELDS.join(", ")}.`);
    }
    if (/\[CONFIRM:/i.test(value)) add(p.where, "block", "needs_fact", "Has a [CONFIRM: ...] gap — a fact is missing from the form.");
    for (const m of value.match(/\[(?!CONFIRM:)[^\]]{1,40}\]|%[A-Z_ ]{2,30}%|<[^<>]{1,30}>/gi) || []) {
      add(p.where, "block", "merge_field", `${m} looks like a fill-in — only ${MERGE_FIELDS.join(", ")} are allowed.`);
    }
    if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|co|net|org|ai|holdings|capital|ly|me|us|xyz|app|link|vc)\b|\b[a-z0-9-]+\.[a-z]{2,}\/|@[a-z0-9-]+\.[a-z]{2,}|\bdot (com|net|org|io|co|ai)\b)/i.test(value)) {
      add(p.where, p.outbound || risk.review ? "block" : "warn", "link", p.outbound ? "Has a link — the brief: no links until the prospect replies." : "Has a link.");
    }
    if (/\b(ai syndicate|geo optimization|generative engine|our agency)\b/i.test(value)) add(p.where, "block", "our_name", "Mentions AI Syndicate / the agency — the client is the sender.");

    /* Only two kinds of number are ordinary words rather than claims: the
     * length of the call being asked for ("a 15-minute call", "20 minutes")
     * and a date. Counts, years and "hours saved" are proof points and must
     * come from the client (3 Nov fourth check: "120 hours", "since 2009",
     * "top 3" all slipped through a looser rule). */
    const ordinary = value
      .replace(/\b\d{1,2}[- ]?(minutes?|mins?)\b/gi, " ")
      .replace(MONTH_FIRST, " ").replace(DAY_FIRST, " ").replace(NUMERIC_DATE, " ");
    for (const d of ordinary.match(/\d+/g) || []) {
      if (!factDigits.has(d)) add(p.where, "block", "invented_number", `"${d}" is not in the client's answers — numbers must come from the client.`);
    }
    /* For an investment offer the client's own digits are mostly money
     * ($20B, 10 months), so "it was in the form" proves nothing. Only digits
     * inside a date, or inside the client's own company name, are allowed. */
    if (securities) {
      const undated = (company ? value.split(company).join(" ") : value).replace(MONTH_FIRST, " ").replace(DAY_FIRST, " ").replace(NUMERIC_DATE, " ");
      for (const d of undated.match(/\d+/g) || []) add(p.where, "block", "securities_number", `"${d}" — no numbers except dates for an investment offer.`);
    }
    for (const { re, kind } of blocked) {
      const hit = value.match(re);
      if (hit) add(p.where, "block", `risk_${kind}`, `"${hit[0]}" is not allowed here (${RISK_KINDS[kind].label.toLowerCase()}).`);
    }
    const low = value.toLowerCase();
    for (const w of BANNED_WORDS) if (low.includes(w)) add(p.where, "warn", "banned_word", `Uses "${w}" (house banned word).`);
    for (const ph of STALE_PHRASES) if (low.includes(ph)) add(p.where, "warn", "stale_phrase", `"${ph}" reads like a mass message.`);
    if (value.includes("!") && /professional/i.test(asText(answers?.tone))) add(p.where, "warn", "tone", "Exclamation mark in a Professional sequence.");
    if (p.note && datesIn(value).length) add(p.where, "warn", "dated", "Connection note names a date — it goes stale.");
  }

  /* A variant that repeats itself reads like nobody is reading the replies. */
  for (const v of content.variants || []) {
    const seen = new Map();
    for (const s of v.steps || []) {
      const head = normalise(s.body).toLowerCase().replace(/\s+/g, " ").slice(0, 40);
      if (!head) continue;
      if (seen.has(head)) add(`${v.name} · Message ${s.step}`, "warn", "repeat", `Opens the same way as Message ${seen.get(head)}.`);
      else seen.set(head, s.step);
    }
  }
  if (content.variants?.length === 2 && normalise(content.variants[0].connection_note) === normalise(content.variants[1].connection_note) && content.variants[0].connection_note) {
    add("Direct · Connection note", "warn", "same_note", "Both variants use the same connection note.");
  }

  /* TARGET LISTS. Three, each buildable (titles + geography at least), and
   * split by geography or segment — "never by rewording the same search". */
  /* Defensive: a hand-made object (the reply classifier's shell, a test)
   * may carry lists without every array. */
  const lists = (content.target_lists || []).map((l) => ({ title: "", keywords: "", exclusions: "", ...l, job_titles: l?.job_titles || [], industries: l?.industries || [], headcount: l?.headcount || [], geography: l?.geography || [] }));
  if (lists.length !== LIST_COUNT) add("Target lists", "block", "list_count", `${lists.length} list(s) — the brief asks for ${LIST_COUNT}.`);
  const sig = (l) => [l.geography, l.industries, l.job_titles].map((a) => [...a].map((x) => x.toLowerCase().trim()).sort().join("|")).join("#");
  lists.forEach((l, i) => {
    const where = `Target list ${i + 1}${l.title ? ` · ${l.title}` : ""}`;
    if (!l.title) add(where, "block", "list_title", "No title.");
    if (!l.job_titles.length) add(where, "block", "list_titles", "No job titles.");
    if (!l.geography.length) add(where, "block", "list_geo", "No geography.");
    if (asText(answers?.exclusions).trim() && !l.exclusions) add(where, "warn", "list_exclusions", "The client gave exclusions; this list has none.");
    for (let j = 0; j < i; j += 1) {
      if (sig(lists[j]) === sig(l)) add(where, "block", "list_repeat", `Same titles, industries and geography as list ${j + 1} — a reworded search, not a new segment.`);
    }
    if (/(https?:\/\/|www\.)/i.test(`${l.keywords} ${l.title}`)) add(where, "warn", "list_link", "A list spec shouldn't carry a link.");
  });

  const missing = REPLY_KEYS.filter((k) => !content.reply_templates?.[k]);
  if (missing.length) add("Reply templates", "block", "templates", `Missing: ${missing.join(", ")}.`);

  if (risk.review && !/(regulat|compliance|lawyer|counsel|legal)/i.test(content.notes_for_reviewer || "")) {
    add("Notes for reviewer", "warn", "risk_note", "The business is regulated but the writer's notes don't say so — the engine adds the line itself.");
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/* Month names, whole words only ("Marcus 30" is not a date). Lower-case
 * "may" is the verb. Day lists ("Nov 16th, 19th and 20th"), day-first ("16-20
 * Nov") and numeric ("11/16") are read. Fixed in the 3 Nov checks. */
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(?:the\\s+)?\\d{1,2}(?!\\d)(?:st|nd|rd|th)?";
const MORE = `(?:\\s*(?:,|and|&|or|-|–|through|thru|to|until)\\s*${DAY})*`;
const NUMERIC_DATE = /\b(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/\d{2,4})?\b/g;
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\s+(${DAY}${MORE})`, "gi");
const DAY_FIRST = new RegExp(`\\b(${DAY}${MORE})\\s+(?:of\\s+)?${MONTH}\\b`, "gi");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every month-day named, as UTC dates. Up to 180 days back stays in the
 * past (stale, not next year's). Pure. */
export function datesIn(text = "", today = new Date()) {
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const out = [];
  const push = (mon, days) => {
    const mi = MONTHS.indexOf(String(mon).slice(0, 3).toLowerCase());
    for (const day of String(days).match(/\d{1,2}/g) || []) {
      const n = Number(day);
      if (mi < 0 || n < 1 || n > 31) continue;
      let d = Date.UTC(today.getUTCFullYear(), mi, n);
      if (d < t0 - 180 * 864e5) d = Date.UTC(today.getUTCFullYear() + 1, mi, n);
      out.push(new Date(d));
    }
  };
  const isMonth = (tok) => !/^may$/.test(tok);
  for (const m of String(text).matchAll(MONTH_FIRST)) if (isMonth(m[1])) push(m[1], m[2]);
  for (const m of String(text).matchAll(DAY_FIRST)) if (isMonth(m[2])) push(m[2], m[1]);
  for (const m of String(text).matchAll(NUMERIC_DATE)) push(MONTHS[Number(m[1]) - 1], m[2]);
  return out;
}

/** The dates the outbound copy names. `first` = from that day the dated
 * messages read wrong to a first-time reader (stop using THEM); `last` =
 * after it the version as a whole is out of date (the gate refuses to send
 * it to the client or approve it). `pieces` says which messages are dated,
 * so a reviewer stops only those — the lists and templates stay usable
 * (3 Nov check: one date used to stall the whole version). Pure. */
export function datedPieces(content, answers = {}, today = new Date()) {
  let first = null; let last = null; const where = [];
  for (const p of pieces(content, answers).filter((x) => x.outbound)) {
    const ds = datesIn(p.text, today);
    if (!ds.length) continue;
    where.push(p.where);
    for (const d of ds) { if (!first || d < first) first = d; if (!last || d > last) last = d; }
  }
  const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
  return { first: iso(first), last: iso(last), pieces: where };
}

/** The version's expiry = the LAST date its copy names. Pure. */
export function expiresOn(content, answers = {}, today = new Date()) {
  return datedPieces(content, answers, today).last;
}

/* ------------------------------------------------------------------ */
/* 5. Generate and revise                                              */
/* ------------------------------------------------------------------ */

/* The brief: "Claude Sonnet via the Messages API, temperature 0.7, one call
 * per engagement, JSON-only output (strip code fences before parsing, retry
 * once on a parse failure)." Ours on top: when the JSON parses but has
 * blocking problems, the second call (if not spent on a parse retry) is a
 * repair with the exact problems — kept only if it has FEWER blocking problems. So: at most
 * TWO calls, every one returned in `calls` for metering. */
export const TEMPERATURE = 0.7;

async function run({ answers, draftFn, userMessage, today }) {
  const risk = riskReview(answers);
  const system = buildSystem(answers, risk);
  const calls = [];
  const ask = async (context, history = []) => {
    const r = await draftFn({ kind: "linkedin_sequence", system, temperature: TEMPERATURE, context, history, maxInputChars: 20000, maxTokens: 4000, timeoutMs: 110000 });
    calls.push({ usage: r.usage, requestId: r.requestId, latencyMs: r.latencyMs, model: r.model, inputTruncated: r.inputTruncated || 0, stopReason: r.stopReason || null });
    return r.text;
  };
  const blocks = (list) => list.filter((i) => i.level === "block");

  let raw = await ask(userMessage);
  let parsed = parseOutput(raw);
  let issues = parsed.error ? [] : checkOutput(parsed.content, answers, risk);
  let retried = null;

  if (parsed.error) {
    retried = "parse";
    const raw2 = await ask(`${userMessage}\n\nYour last answer could not be parsed (${parsed.error}). Return ONLY the JSON object, in exactly the shape given.`);
    const p2 = parseOutput(raw2);
    raw = raw2; parsed = p2;
    issues = p2.error ? [] : checkOutput(p2.content, answers, risk);
  } else if (blocks(issues).length) {
    const problems = blocks(issues).map((i) => `- ${i.where}: ${i.message}`).join("\n");
    const raw2 = await ask(`Your JSON has the problems below. Fix ONLY these, keep everything else, and return the full JSON in the same shape.\n\nPROBLEMS:\n${problems}`,
      [{ role: "user", text: userMessage }, { role: "assistant", text: raw }]);
    const p2 = parseOutput(raw2);
    if (!p2.error) {
      const i2 = checkOutput(p2.content, answers, risk);
      if (blocks(i2).length < blocks(issues).length) { raw = raw2; parsed = p2; issues = i2; retried = "repair"; }
      else retried = "repair_discarded";
    } else retried = "repair_discarded";
  }

  /* The brief: notes_for_reviewer "must flag" a regulated business. If the
   * model didn't, the engine says it — deterministically, every time. */
  if (parsed.content && risk.review) {
    const line = `Regulated business (${risk.kinds.map((k) => k.label).join("; ")}): the copy invites the prospect to request information and states no terms, returns or guarantees. The client's own lawyer should confirm this outreach is allowed before anything is sent.`;
    if (!parsed.content.notes_for_reviewer.includes(line)) parsed.content.notes_for_reviewer = [line, parsed.content.notes_for_reviewer].filter(Boolean).join("\n");
    issues = issues.filter((i) => i.code !== "risk_note");
  }

  const blocking = parsed.error ? 1 : blocks(issues).length;
  return {
    ok: !parsed.error,
    clean: !parsed.error && blocking === 0,
    content: parsed.content,
    parseError: parsed.error,
    issues,
    risk,
    retried,
    expires: parsed.content ? expiresOn(parsed.content, answers, today) : null,
    dated: parsed.content ? datedPieces(parsed.content, answers, today) : { first: null, last: null, pieces: [] },
    promptVersion: PROMPT_VERSION,
    system,
    userMessage,
    raw,
    calls,
  };
}

/** A first version from the form. `draftFn` = lib/ai.js draft (or a fake). */
export function generate({ answers, draftFn, siteText = "", today = new Date() }) {
  return run({ answers, draftFn, userMessage: buildUserMessage(answers, siteText), today });
}

/** A revised version from the current JSON + the client's feedback. */
export function revise({ answers, draftFn, current, feedback, siteText = "", today = new Date() }) {
  return run({ answers, draftFn, userMessage: buildRevisionMessage(answers, siteText, current, feedback), today });
}

/* ------------------------------------------------------------------ */
/* 6. The review sheet                                                 */
/* ------------------------------------------------------------------ */

/** Plain text for whoever reviews it (Julie, CJ): both variants side by
 * side in order, lengths with long names filled in, every problem under the
 * piece it belongs to, then the lists, the templates and the notes. Pure. */
export function formatForReview(result, answers = {}) {
  const c = result.content;
  const line = "-".repeat(64);
  const issuesFor = (where) => (result.issues || []).filter((i) => i.where === where).map((i) => `   ${i.level === "block" ? "PROBLEM" : "check"}: ${i.message}`);
  const out = [];
  const blocking = (result.issues || []).filter((i) => i.level === "block").length;
  out.push(`LINKEDIN OUTREACH — ${asText(answers.company) || "client"} — prompt ${result.promptVersion}`);
  out.push(`Status: ${!c ? "No usable output" : blocking ? `${blocking} problem(s) — not ready` : "Draft, ready for Julie's review (not approved — do not send)"}`);
  if (result.risk?.review) out.push(`Regulated: ${result.risk.kinds.map((k) => k.label).join("; ")}`);
  const dated = result.dated || (c ? datedPieces(c, answers) : null);
  if (dated?.first) out.push(`Dated messages (${dated.pieces.join("; ")}): stop sending them from ${dated.first}. The whole version is out of date after ${dated.last}.`);
  out.push(`Merge tokens Julie fills in: ${MERGE_FIELDS.join(", ")}`);
  if (!c) return out.concat(["", result.parseError || ""]).join("\n");
  for (const v of c.variants) {
    out.push("", "=".repeat(64), `VARIANT: ${v.name}`, "=".repeat(64));
    const block = (title, text, limit, where) => {
      out.push("", line, `${title}  (${[...String(text || "")].length} as written, ${filledLength(text || "")} worst case / ${limit} max)`, "", text || "(missing)");
      out.push(...issuesFor(where));
    };
    block("Connection note — with the request", v.connection_note, noteLimit(answers), `${v.name} · Connection note`);
    for (const s of v.steps) block(`Message ${s.step} — ${s.delay_days} day(s) after ${s.step === 1 ? "they accept" : `Message ${s.step - 1}`}${s.step === 4 ? " (breakup)" : ""}`, s.body, LIMITS.message, `${v.name} · Message ${s.step}`);
    out.push("", line, `InMail — only if they never accept`, `Subject: ${v.inmail.subject}`, ...issuesFor(`${v.name} · InMail subject`), "", v.inmail.body || "(missing)", ...issuesFor(`${v.name} · InMail`));
  }
  out.push("", "=".repeat(64), "TARGET LISTS (for Sales Navigator)", "=".repeat(64));
  c.target_lists.forEach((l, i) => {
    out.push("", `${i + 1}. ${l.title}`, `   Job titles: ${l.job_titles.join(", ")}`, `   Industries: ${l.industries.join(", ")}`, `   Headcount: ${l.headcount.join(", ")}`, `   Geography: ${l.geography.join(", ")}`, `   Keywords: ${l.keywords || "-"}`, `   Exclusions: ${l.exclusions || "-"}`);
    out.push(...(result.issues || []).filter((x) => x.where.startsWith(`Target list ${i + 1}`)).map((x) => `   ${x.level === "block" ? "PROBLEM" : "check"}: ${x.message}`));
  });
  out.push(...issuesFor("Target lists"));
  out.push("", "=".repeat(64), "REPLY TEMPLATES (for when a prospect answers)", "=".repeat(64));
  for (const k of REPLY_KEYS) out.push("", `${k.replace("_", " ")}:`, c.reply_templates[k] || "(missing)", ...issuesFor(`Reply template · ${k.replace("_", " ")}`));
  out.push(...issuesFor("Reply templates"));
  out.push("", "=".repeat(64), "NOTES FOR THE REVIEWER", "=".repeat(64), c.notes_for_reviewer || "(none)");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Length with every merge token filled in at its worst case. Code points
 * (an emoji = 1 or 2); which unit LinkedIn counts is not verified, so the
 * worst-case fill leaves room. Pure. */
export function filledLength(text = "") {
  let s = String(text);
  for (const [tok, n] of Object.entries(FILL_WORST)) s = s.split(tok).join("x".repeat(n));
  return [...s].length;
}

/* Full-width letters folded, every invisible format / stray combining
 * character removed, and common Cyrillic/Greek look-alikes mapped to Latin
 * before any word check runs (3 Nov second check). */
const CONFUSABLE = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ј": "j", "ԁ": "d", "ɡ": "g", "ӏ": "l", "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "В": "B", "М": "M", "Н": "H", "К": "K", "ο": "o", "α": "a", "ε": "e", "ν": "v" };
function normalise(text = "") {
  return String(text)
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Mn}]/gu, "")
    .replace(/[Ͱ-ϿЀ-ӿԀ-ԯɡ]/g, (c) => CONFUSABLE[c] ?? c);
}

function asText(v) {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  /* Split on new lines, semicolons and commas — but not the comma inside a
   * number ("501-1,000 employees"). */
  return String(v ?? "").split(/\n|;|,(?!\d{3}\b)(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
}
