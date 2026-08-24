/* Turning a saved report into something you can send. PURE — no imports, no
 * database, no fetch, so the browser and the server can both use it and the
 * tests can check every rule.
 *
 * WHY THIS FILE EXISTS (Ryder, Aug 24 2026)
 *   "have a button for like text or email them with this as a draft"
 *
 * A report is written for us. An email to a client is a different thing: it
 * has a greeting, it drops our internal shorthand, and it does not open with
 * a heading. A text message is a third thing again — nobody reads five hundred
 * words in iMessage.
 *
 * SO THIS FILE DOES NOT WRITE ANYTHING NEW. It re-shapes words that are
 * already in the saved report. Nothing here invents a sentence, a number or a
 * claim: if it is not in the report, it is not in the email. That matters
 * because the report has already been through the honesty check and an email
 * built from anything else would not have been.
 *
 * WHAT IT DELIBERATELY LEAVES OUT OF A CLIENT-FACING DRAFT
 *   · The "what these records cannot answer" list. It is written for us, in
 *     our words, about our own gaps. Sending it raw to a client reads as a
 *     list of things we have not done.
 *   · The provenance line ("counted from the console's own records at …").
 *   · Anything the report marked as one of our internal notes.
 * Every one of those stays in the report itself, and in Copy all.
 */

/* Lines a client-facing draft never carries, matched on how the report writes
 * them. Kept as one list so there is one place to add to. */
const INTERNAL_MARKERS = [
  /^our note from/i,
  /^what these records cannot answer/i,
  /^counted from the ai syndicate console/i,
  /^\[not everything fitted/i,
];

function isInternalLine(line) {
  const l = String(line || "").trim().replace(/^[-*•]\s*/, "");
  return INTERNAL_MARKERS.some((re) => re.test(l));
}

/** Headings and bullets out, plain sentences in. */
function flatten(body, { keepHeadings = false } = {}) {
  const out = [];
  for (const raw of String(body || "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { out.push(""); continue; }
    if (isInternalLine(line)) continue;
    if (/^\s*#{1,6}\s+/.test(line)) {
      const text = line.replace(/^\s*#+\s+/, "");
      out.push(keepHeadings ? `${text}` : `${text}:`);
      continue;
    }
    out.push(line.replace(/^\s*[-*•]\s+/, "- "));
  }
  // Collapse runs of blank lines — headings turning into labels leaves gaps.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The first real sentence of the report — not a heading, not a bullet. */
export function firstSentence(report) {
  const lines = String(report?.summary || report?.body || "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (isInternalLine(line)) continue;
    const text = line.replace(/^[-*•]\s*/, "").trim();
    if (!text) continue;
    const stop = text.search(/[.!?](\s|$)/);
    return (stop > 0 ? text.slice(0, stop + 1) : text).trim();
  }
  return "";
}

/** The bullets a client would care about, in the report's own words.
 *
 * `skip` is the line already used as the opening. Without it a report whose
 * summary is nothing BUT bullets printed its first bullet twice — once as the
 * opening sentence and again at the top of the list. */
export function keyLines(report, max = 6, skip = "") {
  const out = [];
  const seen = String(skip || "").trim().replace(/[.!?]+$/, "").toLowerCase();
  for (const raw of String(report?.summary || "").split("\n").concat(String(report?.body || "").split("\n"))) {
    const line = raw.trim();
    if (!/^[-*•]\s+/.test(line)) continue;
    if (isInternalLine(line)) continue;
    const text = line.replace(/^[-*•]\s+/, "").trim();
    if (!text || out.includes(text)) continue;
    if (seen && text.replace(/[.!?]+$/, "").toLowerCase().startsWith(seen)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* OUR VOICE vs THEIR VOICE                                            */
/* ------------------------------------------------------------------ */

/* A report is written ABOUT a client, to us. An email is written TO them. So
 * a sentence lifted straight across says "Their own Google Search Console
 * shows 412 clicks" to the very person whose Search Console it is — which
 * reads as though it were written about somebody else, and is exactly the
 * kind of thing a person then has to go and fix by hand.
 *
 * THIS IS A SHORT, EXPLICIT LIST, NOT A PRONOUN SWEEP. Replacing every
 * "their" would break a line like "the crawlers and their user agents". Each
 * entry below is a phrase THIS CODEBASE generates, so what it matches is
 * known rather than guessed. Anything not on the list is left exactly as the
 * report wrote it.
 *
 * Every substitution that fires is NAMED in the warnings, so the person can
 * see that words were changed rather than discovering it in a sent email. */
const CLIENT_VOICE = [
  [/Their own Google Search Console/g, "Your own Google Search Console"],
  [/their own Google Search Console/g, "your own Google Search Console"],
  [/Their own Google Business Profile/g, "Your own Google Business Profile"],
  [/their own Google Business Profile/g, "your own Google Business Profile"],
  [/That is their number, not ours/g, "That is your own number, not ours"],
  [/Their own accounts/g, "Your own accounts"],
  [/waiting on a reply from us/g, "waiting on a reply from us"],
];

/** Returns { text, changed } — changed is true if any phrase was rewritten. */
function inClientVoice(text) {
  let out = String(text || "");
  let changed = false;
  for (const [re, to] of CLIENT_VOICE) {
    const before = out;
    out = out.replace(re, to);
    if (out !== before) changed = true;
  }
  return { text: out, changed };
}

function firstName(contactName) {
  const v = String(contactName || "").trim();
  if (!v) return "";
  return v.split(/\s+/)[0].replace(/[^A-Za-z'-]/g, "");
}

/* ------------------------------------------------------------------ */
/* EMAIL                                                               */
/* ------------------------------------------------------------------ */

/**
 * A draft email built from the report.
 *
 * `senderName` is whoever is signing it — the person at the console. It is
 * never guessed from the report.
 *
 * Returns { subject, body, to, warnings }. `warnings` is what a person needs
 * to know BEFORE they press send, and it is shown on screen — an empty
 * warnings array is a promise, so nothing goes in it lightly.
 */
export function reportToEmail(report, { clientName, contactName, contactEmail, senderName, todayLabel } = {}) {
  const hi = firstName(contactName);
  const warnings = [];
  if (!contactEmail) warnings.push("This client has no contact email on file, so the draft has nobody in the To box.");

  const rawOpening = firstSentence(report);
  const rawBullets = keyLines(report, 6, rawOpening);

  /* Put it in the second person before it goes into the email. */
  const op = inClientVoice(rawOpening);
  const opening = op.text;
  let voiceChanged = op.changed;
  const bullets = rawBullets.map((b) => {
    const r = inClientVoice(b);
    if (r.changed) voiceChanged = true;
    return r.text;
  });

  const lines = [];
  lines.push(hi ? `Hi ${hi},` : "Hi,");
  lines.push("");
  lines.push(todayLabel
    ? `Here is where things stand on your project as of ${todayLabel}.`
    : "Here is where things stand on your project.");
  if (opening) { lines.push(""); lines.push(opening); }
  if (bullets.length) {
    lines.push("");
    for (const b of bullets) lines.push(`• ${b}`);
  }
  lines.push("");
  lines.push("Happy to walk through any of it — just reply and we will set up a time.");
  lines.push("");
  lines.push("Thanks,");
  lines.push(senderName || "AI Syndicate");

  /* NAMED, not hidden. A draft is a starting point, and the two things most
   * likely to be wrong in it are the two things below. */
  warnings.push("This is a DRAFT built from the report's own words. Read every line before you send it — nothing is sent until you press send in Gmail.");
  if (voiceChanged) {
    warnings.push("A few phrases were switched from “their” to “your”, because the report is written about this client and the email is written to them. Nothing else was reworded.");
  }
  if (!bullets.length && !opening) {
    warnings.push("The report had no plain sentences or bullets to lift, so this draft is nearly empty. Write it yourself, or generate a report asking for bullet points.");
  }

  return {
    to: contactEmail || "",
    subject: `${clientName || "Your project"} — where things stand${todayLabel ? `, ${todayLabel}` : ""}`,
    body: lines.join("\n"),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* TEXT MESSAGE                                                        */
/* ------------------------------------------------------------------ */

/* Long enough to say something, short enough that a phone shows it without
 * splitting into a wall. Two or three lines, never the whole report. */
export const TEXT_MAX_CHARS = 320;

/**
 * A short text built from the report. Same rule as the email: every word is
 * already in the report.
 *
 * It is deliberately NOT a summary of the report. It is the first finding plus
 * at most two bullets, and it says the full version exists — because a text
 * that tries to be the report is the one that gets sent instead of the report.
 */
export function reportToText(report, { clientName, contactName } = {}) {
  const hi = firstName(contactName);
  const rawOpening = firstSentence(report);
  const opening = inClientVoice(rawOpening).text;
  const bullets = keyLines(report, 2, rawOpening).map((b) => inClientVoice(b).text);

  const parts = [];
  parts.push(hi ? `Hi ${hi} — quick update on ${clientName || "your project"}.` : `Quick update on ${clientName || "your project"}.`);
  if (opening) parts.push(opening);
  for (const b of bullets) parts.push(`• ${b}`);
  parts.push("Full write-up on the way if you want it.");

  let text = parts.join(" ");
  if (text.length > TEXT_MAX_CHARS) {
    /* Cut at a sentence end rather than mid-word, and never leave a dangling
     * half-claim. A truncated number is worse than a missing one. */
    const cut = text.slice(0, TEXT_MAX_CHARS);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    text = (stop > 60 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(" "))).trim();
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* PASTE-READY, IN FULL                                                */
/* ------------------------------------------------------------------ */

/**
 * The whole report as plain text with the markdown taken off — for pasting
 * into an email, a Google Doc or a message where "## " would show up as two
 * hash marks.
 *
 * This one KEEPS the gaps list, because it is the internal version. Only the
 * email and text drafts drop it.
 */
export function reportToPlainText(report, { clientName, includeGaps = true } = {}) {
  const parts = [];
  if (report?.title) parts.push(report.title);
  else if (clientName) parts.push(`${clientName} — report`);
  parts.push("");
  const summary = String(report?.summary || "").trim();
  if (summary) { parts.push(flatten(summary)); parts.push(""); }
  parts.push(flatten(report?.body));
  if (includeGaps && String(report?.cannot_check || "").trim()) {
    parts.push("");
    parts.push("What these records cannot answer:");
    parts.push(String(report.cannot_check).split("\n").map((l) => l.replace(/^\s*[-*•]\s+/, "- ")).join("\n").trim());
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
