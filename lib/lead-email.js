/* DRAFT THE NEXT EMAIL TO ONE LEAD — the pure half.
 *
 * Ryder, 31 Aug 2026: "add a row for email that drafts up an email based on
 * stage, notes, timeline and everything else thats known about the client."
 *
 * The pattern is the one this console already uses three times over
 * (console-report, client-report, rep-report): assemble a FACT SHEET, hand the
 * model nothing but that, and check the draft back against it. A sentence the
 * facts do not support does not ship.
 *
 * WHY A COLD EMAIL NEEDS THE GATE MORE THAN A REPORT DOES. A report that
 * overstates is read by us. An email that overstates is read by the prospect,
 * with our name on it — and the two things a model reaches for first are
 * exactly the two we cannot back: a number about their website nobody scanned,
 * and a promise about what we will do for them.
 *
 * THREE THINGS THIS FILE WILL NOT DO, and each one is a rule rather than a
 * preference:
 *   1. It never sends. It writes a draft a person reads, edits and sends.
 *      There is no code path from here to an outbox — see api/lead-email.js.
 *   2. It refuses a bounced address, because canEmail() refuses it. Drafting to
 *      a dead inbox is work nobody can use.
 *   3. It states no number, date or score that is not in the fact sheet. The
 *      gate at the bottom is what enforces that, not the prompt.
 */
import { claimState, scoreGate } from "./sales-rules.js";
/* The number and date checks are SHARED with the client and console reports,
 * not re-implemented. Three copies of an honesty rule is two copies that
 * quietly stop matching — this repo has a note about exactly that. */
import { withoutQuotes, unbackedNumbersStrict, unbackedWordNumbers } from "./client-report.js";

/* Its own copy, because client-report.js keeps this one private. One regex,
 * eight characters, and inventing a second definition of "a date" is not a risk
 * worth a cross-file export. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

/* ------------------------------------------------------------------ */
/* What the email is FOR, which the stage decides                      */
/* ------------------------------------------------------------------ */

/**
 * One job per stage, in the rep's words.
 *
 * The stage is the single most useful thing on the record for this, because it
 * is the one field that says what a person decided. Everything else says what
 * happened.
 *
 * `ask` is the one thing the email is for. An email with two asks has none.
 */
export const EMAIL_JOBS = {
  __new: {
    label: "First contact",
    ask: "Get a reply. Nothing else.",
    shape: "Short. Say why you are writing to THEM specifically, name one thing you noticed about their business or their site, and ask one easy question.",
  },
  __working: {
    label: "Follow-up",
    ask: "Get a reply, with a new angle — never “just bumping this”.",
    shape: "Reference what was already said or sent. Bring ONE new thing: a different angle, a finding, a question they have not been asked.",
  },
  follow_up: {
    label: "Chase",
    ask: "Get the thing you are waiting on.",
    shape: "Say plainly what you are waiting for and make it easy to answer. One question, one line.",
  },
  meeting: {
    label: "Around the meeting",
    ask: "Confirm the meeting, or follow up on what was said in it.",
    shape: "Confirm what was agreed, or set out what happens next. Concrete and short.",
  },
  proposal: {
    label: "Proposal follow-up",
    ask: "Move the proposal to a decision.",
    shape: "Reference the proposal that is out. Offer to answer questions or walk them through it. Do not re-pitch.",
  },
  won: {
    label: "Welcome",
    ask: "Start the work well.",
    shape: "Thank them, say what happens next and when. No selling.",
  },
  lost: {
    label: "Leave the door open",
    ask: "End it well, and leave a way back.",
    shape: "Gracious and short. No pitch, no guilt, no “just checking”. Say they can come back.",
  },
  not_a_fit: {
    label: "Close it politely",
    ask: "End it cleanly.",
    shape: "Two lines. Thank them for their time and say we are not the right fit right now.",
  },
};

/**
 * Which job this lead's email has.
 *
 * The four early stages stopped being settable on 30 Aug, so the stage cannot
 * tell first contact from a follow-up any more — a lead worked for a month
 * still reads `new`. The TIMELINE can: whether we have ever contacted them is
 * `first_contact_at`, written by a database trigger from a real logged touch
 * and impossible to type over. Same test the Contacted? column uses.
 */
export function emailJobFor(lead) {
  const j = EMAIL_JOBS[lead?.stage];
  if (j) return { id: lead.stage, ...j };
  if (lead?.first_contact_at) return { id: "__working", ...EMAIL_JOBS.__working };
  return { id: "__new", ...EMAIL_JOBS.__new };
}

/* ------------------------------------------------------------------ */
/* The fact sheet                                                      */
/* ------------------------------------------------------------------ */

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const day = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * Everything known about this one lead, as the block the model reads and the
 * checker checks against. Same string, both times — a checker holding a
 * different string from the reader is not a checker, it is a second opinion.
 *
 * WHAT IS DELIBERATELY LEFT OUT:
 *   - money, except a proposal amount already sent TO THIS PERSON. Our margins,
 *     other clients' invoices and anything from Finance have no business in an
 *     email to a prospect.
 *   - other people at the firm by name. One rep, one firm, and a cold email
 *     that names a colleague reads as surveillance.
 *   - anything about other leads at all.
 */
export function assembleEmailFacts(lead, {
  company = null, activity = [], tags = [], proposals = [], report = null,
  teamName = () => null, nowMs = Date.now(), me = null, activityWindowDays = 90,
} = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const claim = claimState(lead, nowIso);
  const gate = scoreGate(company?.site_score);

  /* Newest first, capped. A cold email does not need forty lines of history and
   * a fact sheet that long is one the model skims. */
  const timeline = (activity || [])
    .filter((a) => a.lead_id === lead.id)
    .slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 12)
    .map((a) => ({
      on: day(a.created_at),
      what: clean(a.type),
      outcome: clean(a.outcome) || null,
      said: clean(a.body).slice(0, 240) || null,
    }));

  const mine = (proposals || []).filter((p) => p.lead_id === lead.id);

  return {
    person: {
      name: clean(lead.name) || null,
      first: clean(lead.name).split(" ")[0] || null,
      title: clean(lead.title) || null,
      email: clean(lead.email) || null,
      city: clean(lead.city) || null,
      state: clean(lead.state) || null,
    },
    firm: {
      name: clean(company?.name || lead.company) || null,
      domain: clean(company?.domain || lead.domain) || null,
      vertical: clean(company?.vertical || lead.vertical) || null,
      /* THE SCORE ONLY IF SOMEBODY RAN ONE. scoreGate returns known:false for a
       * missing score, and an unscored firm must never read as a zero — the
       * widest possible gap and the most tempting thing to write about. */
      siteScore: gate.known ? gate.score : null,
      scoredOn: gate.known ? day(company?.site_score_at) : null,
    },
    /* The newest scan of their site, if there is one. This is the only place a
     * cold email can honestly get a specific finding from. */
    findings: report ? {
      on: day(report.created_at || report.measured_at),
      lines: (report.findings || report.gaps || [])
        .slice(0, 5)
        .map((f) => clean(typeof f === "string" ? f : f.title || f.label || "").slice(0, 180))
        .filter(Boolean),
    } : null,
    stage: {
      value: lead.stage || null,
      job: emailJobFor(lead).id,
      claim: claim.state,
      /* Derived from the same two facts the Contacted? column uses, rather than
       * imported: that helper lives in src/lib/salesSheet.js, which is browser
       * code this server file must not pull in. */
      everContacted: Boolean(lead.first_contact_at),
      firstContactOn: day(lead.first_contact_at),
      lastTouchOn: day(lead.last_touch_at),
      repliedOn: day(lead.first_reply_at),
      bouncedOn: day(lead.bounced_at),
      nextStepOn: day(lead.next_follow_up_at),
      touchesLogged: timeline.filter((t) => ["call", "email", "text", "linkedin"].includes(t.what)).length,
      activityWindowDays,
    },
    notes: clean(lead.notes).slice(0, 600) || null,
    nextStepNote: clean(lead.follow_up_note).slice(0, 300) || null,
    tags: (tags || []).map((t) => clean(t.label || t.slug)).filter(Boolean),
    proposals: mine.map((p) => ({
      title: clean(p.title) || null,
      amountCents: Number.isFinite(Number(p.amount_cents)) ? Number(p.amount_cents) : null,
      status: clean(p.status) || null,
      on: day(p.created_at),
    })),
    from: {
      name: clean(me?.full_name) || null,
      email: clean(me?.email) || null,
    },
    owner: lead.owner_id ? clean(teamName(lead.owner_id)) || null : null,
    takenAt: nowIso,
  };
}

/** The fact sheet as the text the model reads AND the checker checks. */
export function emailFactsText(f) {
  const L = [];
  const line = (k, v) => { if (v !== null && v !== undefined && v !== "") L.push(`${k}: ${v}`); };

  L.push("WHO YOU ARE WRITING TO");
  line("Name", f.person.name);
  line("Title", f.person.title);
  line("Firm", f.firm.name);
  line("Line of business", f.firm.vertical);
  line("Where", [f.person.city, f.person.state].filter(Boolean).join(", "));
  line("Website", f.firm.domain);

  L.push("\nWHAT WE HAVE MEASURED ABOUT THEIR SITE");
  if (f.firm.siteScore === null) {
    L.push("Nobody has scanned this site. There is NO score. Do not state one, and do not imply one.");
  } else {
    line("AI search score out of 100", f.firm.siteScore);
    line("Scanned on", f.firm.scoredOn);
  }
  if (f.findings && f.findings.lines.length) {
    L.push(`Findings from the scan on ${f.findings.on || "an unrecorded date"}:`);
    for (const x of f.findings.lines) L.push(`  - ${x}`);
  } else {
    L.push("No specific findings on record.");
  }

  L.push("\nWHERE THIS ONE STANDS");
  line("Stage", f.stage.value);
  line("What this email is for", f.stage.job);
  line("First contacted on", f.stage.firstContactOn);
  line("Last touched on", f.stage.lastTouchOn);
  line("They replied on", f.stage.repliedOn);
  line("Their address bounced on", f.stage.bouncedOn);
  line("Next step booked for", f.stage.nextStepOn);
  line(`Touches logged in the last ${f.stage.activityWindowDays} days`, f.stage.touchesLogged);
  if (f.tags.length) line("Tags", f.tags.join(", "));

  if (f.notes) { L.push("\nNOTES ON THE RECORD"); L.push(f.notes); }
  if (f.nextStepNote) { L.push(`Next step note: ${f.nextStepNote}`); }

  if (f.proposals.length) {
    L.push("\nPROPOSALS ALREADY OUT WITH THIS PERSON");
    for (const p of f.proposals) {
      const amt = p.amountCents === null ? "no amount recorded" : `$${Math.round(p.amountCents / 100).toLocaleString("en-US")}`;
      L.push(`  - ${p.title || "untitled"} · ${amt} · ${p.status || "no status"} · ${p.on || "no date"}`);
    }
  }

  L.push("\nTHE TIMELINE, NEWEST FIRST");
  if (!f.stage || !f.timelineText) { /* filled below */ }
  L.push(f.timelineText || "Nothing has been logged.");

  L.push("\nWHO IT IS FROM");
  line("Name", f.from.name);
  line("Email", f.from.email);
  line("Today", f.takenAt.slice(0, 10));
  return L.join("\n");
}

/** The timeline block, kept separate so assembleEmailFacts stays serialisable
 *  and the text builder stays a pure function of the facts object. */
export function withTimelineText(facts, activity = [], leadId = null) {
  const rows = (activity || [])
    .filter((a) => !leadId || a.lead_id === leadId)
    .slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 12);
  const text = rows.length
    ? rows.map((a) => {
      const bits = [day(a.created_at), clean(a.type)];
      if (a.outcome) bits.push(clean(a.outcome));
      const said = clean(a.body).slice(0, 240);
      return `  - ${bits.filter(Boolean).join(" · ")}${said ? ` — "${said}"` : ""}`;
    }).join("\n")
    : "Nothing has been logged.";
  return { ...facts, timelineText: text };
}

/* ------------------------------------------------------------------ */
/* The instruction                                                     */
/* ------------------------------------------------------------------ */

export const MAX_EMAIL_WORDS = 130;
export const MAX_ANGLE_CHARS = 300;

export function cleanAngle(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ANGLE_CHARS);
}

export function buildEmailInstruction({ job, angle = "", words = MAX_EMAIL_WORDS } = {}) {
  return [
    `Write ONE email. Its job: ${job.ask}`,
    `Shape: ${job.shape}`,
    "",
    "THE RULES, and a draft that breaks any of them is thrown away:",
    `1. Under ${words} words in the body. Shorter is better. Nobody reads a long cold email.`,
    "2. State NO number, date, score or statistic that is not in the facts above. If there is no score, do not gesture at one — no \"your site is underperforming\", no \"we noticed some gaps\".",
    "3. Promise NOTHING. No results, no rankings, no timelines, no \"we can get you to the top\".",
    "4. No flattery openers. Not \"I hope this finds you well\", not \"I came across your website and was impressed\".",
    "5. One ask, at the end, and make it easy to answer.",
    "6. Plain words. No jargon, no \"leverage\", no \"solutions\", no \"reach out\", no \"circle back\".",
    "7. Write as the person named in WHO IT IS FROM. First person, their name at the end.",
    angle ? `\nThe rep asked for this angle specifically: ${angle}` : "",
    "",
    "Answer as JSON, and nothing else:",
    '{"subject": "...", "body": "..."}',
    "The subject is under 60 characters, lower-case-ish, and says something real. Not \"Quick question\".",
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ */
/* Reading it back                                                     */
/* ------------------------------------------------------------------ */

export function parseEmailDraft(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1));
    const subject = clean(o.subject);
    const body = String(o.body ?? "").replace(/\r/g, "").trim();
    if (!subject || !body) return null;
    return { subject, body };
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/* Promises a cold email reaches for, and none of them are ours to make. Checked
 * as substrings on the SPOKEN text — an email quoting the prospect's own words
 * back to them is showing a record, not making a claim.
 *
 * This list is the sales one from rep-report plus the things only an outbound
 * email says. It is a list and therefore catches the wording it was written
 * for — the same limit written down in the rep-report note — so the numbers
 * check below is what does the heavy lifting. */
const EMAIL_PROMISES = [
  "guarantee", "guaranteed", "we will get you", "we'll get you",
  "top of google", "number one", "#1 on", "first page",
  "double your", "triple your", "10x", "x your revenue",
  "risk free", "risk-free", "no brainer", "no-brainer",
  "instantly", "overnight", "within days", "in a week",
  "proven results", "guaranteed results", "we promise",
];

/* Openers that make an email read as a template. Not a correctness issue — a
 * reply-rate one — but they are the reason cold email gets deleted, and the
 * house rules ban them in reports already. */
const DEAD_OPENERS = [
  "i hope this email finds you well", "i hope this finds you well",
  "i hope you are doing well", "i hope you're doing well",
  "i came across your website", "i stumbled upon",
  "just checking in", "just following up", "just circling back",
  "quick question for you", "reaching out to see",
];

export function emailPromisesIn(text) {
  const low = String(text || "").toLowerCase();
  return EMAIL_PROMISES.filter((p) => low.includes(p));
}

export function deadOpenersIn(text) {
  const low = String(text || "").toLowerCase();
  return DEAD_OPENERS.filter((p) => low.includes(p));
}

/**
 * Is this draft safe to put in front of a rep?
 *
 * `factsText` must be the SAME string the model was shown. A gate checking a
 * different string is not a gate — that mistake is written down twice in this
 * repo already, once where it silently killed honest answers and once where it
 * let an invented number through.
 */
export function checkEmailDraft(draft, factsText, { words = MAX_EMAIL_WORDS } = {}) {
  if (!draft) return { ok: false, why: "the answer did not come back in the shape we asked for" };
  const subject = String(draft.subject || "").trim();
  const body = String(draft.body || "").trim();
  if (!subject) return { ok: false, why: "it came back with no subject" };
  if (!body) return { ok: false, why: "it came back with no body" };

  const all = `${subject}\n${body}`;
  const spoken = withoutQuotes(all, factsText);
  const facts = String(factsText || "");

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount > words) {
    return { ok: false, why: `it is ${wordCount} words and the limit is ${words}` };
  }

  const dates = all.match(ISO_DATE) || [];
  const badDates = [...new Set(dates.filter((d) => !facts.includes(d)))];
  if (badDates.length) return { ok: false, why: `dates not in the facts: ${badDates.join(", ")}` };

  /* The clock is stripped for the same reason client-report strips it: the time
   * of day in the "Today" stamp was backing every one of its own digits. */
  const factsForNumbers = facts.replace(/T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?/g, " ");
  const numbers = unbackedNumbersStrict(all.replace(ISO_DATE, " "), factsForNumbers);
  if (numbers.length) return { ok: false, why: `numbers not in the facts: ${numbers.join(", ")}` };

  const asWords = unbackedWordNumbers(spoken, factsForNumbers);
  if (asWords.length) return { ok: false, why: `numbers written as words that are not in the facts: ${asWords.join(", ")}` };

  const promises = emailPromisesIn(spoken);
  if (promises.length) {
    return { ok: false, why: `it promises something we cannot promise: ${[...new Set(promises)].join(", ")}` };
  }

  const openers = deadOpenersIn(spoken);
  if (openers.length) {
    return { ok: false, why: `it opens with a line that gets emails deleted: ${[...new Set(openers)].join(", ")}` };
  }

  /* THE SCORE IS THE ONE A COLD EMAIL REACHES FOR. If nobody scanned the site,
   * the facts say so in as many words, and any talk of how their site is doing
   * is invented. Checked as a phrase list rather than a number, because the
   * dangerous version has no digits in it: "your site is falling behind". */
  if (facts.includes("There is NO score")) {
    const low = spoken.toLowerCase();
    const invented = [
      "your score", "your site scores", "scored", "out of 100",
      "underperform", "falling behind", "we noticed some gaps", "we found gaps",
      "your website is not", "your site is not", "we scanned", "our scan",
      "our audit", "we ran an audit", "we analysed", "we analyzed",
    ].filter((p) => low.includes(p));
    if (invented.length) {
      return { ok: false, why: `nobody has scanned this site, so it cannot say: ${[...new Set(invented)].join(", ")}` };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The fallback                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a rep gets when there is no key, the model errors, or the draft fails
 * the gate. NOT an apology, and not an empty box: a short, honest skeleton with
 * the real facts filled in and the judgement left blank for a person.
 *
 * Every line here is a value read off the record, so it cannot fail its own
 * check — the same rule the other three fallbacks in this console follow.
 */
export function deterministicEmailDraft(f, { why = null } = {}) {
  const who = f.person.first || "there";
  const firm = f.firm.name;
  const from = f.from.name || "";
  const lines = [];

  lines.push(`Hi ${who},`);
  lines.push("");
  if (f.stage.job === "__new") {
    lines.push(firm
      ? `I work with ${f.firm.vertical || "businesses"} on how they show up in AI search — ChatGPT, Google's AI answers, Perplexity. I had a look at ${firm}.`
      : "I work on how businesses show up in AI search — ChatGPT, Google's AI answers, Perplexity.");
    lines.push("");
    lines.push("Worth a short conversation?");
  } else if (f.stage.repliedOn) {
    lines.push("Picking this back up — [say what you are answering].");
    lines.push("");
    lines.push("[One question.]");
  } else {
    lines.push(`Following up on ${f.stage.lastTouchOn ? `my last message on ${f.stage.lastTouchOn}` : "my last message"}.`);
    lines.push("");
    lines.push("[One NEW angle here — not a bump.]");
    lines.push("");
    lines.push("[One question.]");
  }
  lines.push("");
  if (from) lines.push(from);

  return {
    subject: firm ? `${firm} and AI search` : "AI search",
    body: lines.join("\n"),
    counted: true,
    why,
  };
}
