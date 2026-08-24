/* Turning a report into an email or a text. Pure — no database, no keys, no
 * network, no browser.
 *
 * The whole point of these checks is one rule: NOTHING in a draft is a new
 * sentence. Every word came out of a report that had already been through the
 * honesty check. A draft that adds a claim would have skipped it.
 */

import {
  reportToEmail, reportToText, reportToPlainText, firstSentence, keyLines, TEXT_MAX_CHARS,
} from "../../lib/report-share.js";
import {
  SHAPE_PRESETS, DEFAULT_SHAPE, shapeById, MAX_SHAPE_CHARS, buildReportInstruction,
} from "../../lib/client-report.js";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const REPORT = {
  title: "Lakeside Realty Group — normal, 2026-08-24",
  summary: "",
  body: [
    "## In short",
    "- Their own Google Search Console shows 412 clicks from Google search between 2026-07-25 and 2026-08-21. That is their number, not ours.",
    "- Finished: 1 of 5 tasks. Still open: 4.",
    "- 1 task is past the date we set.",
    "",
    "## Where they stand",
    "Lakeside Realty Group is at stage \"Week 3\".",
    "",
    "## Notes our team wrote",
    "our note from 2026-08-01 says \"the client is slow to reply in August\"",
  ].join("\n"),
  cannot_check: "- Scores from the platform.\n- Money. No invoices exist for this client.",
};

const WHO = { clientName: "Lakeside Realty Group", contactName: "Dana Whitfield", contactEmail: "dana@example.com", senderName: "Ryder", todayLabel: "August 24" };

console.log("\nSENDING A REPORT\n");

/* ---------------------------------------------------------------- */
console.log("Nothing is invented");

{
  const mail = reportToEmail(REPORT, WHO);
  /* Every number in the draft has to be findable in the report. This is the
   * check that would fail if anybody ever "helpfully" rounded one.
   *
   * Today's date is the ONE exception, and it is not an exception really: it
   * is passed in by the caller from the clock, not lifted from the report and
   * not made up. It is taken out of the line before the check so that the
   * check keeps meaning what it says. */
  const numbers = (mail.body.replace(WHO.todayLabel, "").match(/\d[\d,]*/g) || []).filter((n) => n.length > 1);
  const inReport = `${REPORT.body} ${REPORT.summary}`;
  ok("every number in the email appears in the report",
    numbers.every((n) => inReport.includes(n)), numbers.join("|"));
  ok("the client's own Search Console number carried through", mail.body.includes("412"));

  const text = reportToText(REPORT, WHO);
  const tNums = (text.match(/\d[\d,]*/g) || []).filter((n) => n.length > 1);
  ok("same for the text message", tNums.every((n) => inReport.includes(n)), tNums.join("|"));
}

/* ---------------------------------------------------------------- */
console.log("\nWhat a client-facing draft leaves out");

{
  const mail = reportToEmail(REPORT, WHO);
  ok("our own working note is NOT in the email", !/our note from/i.test(mail.body));
  ok("the gaps list is NOT in the email", !/Scores from the platform/i.test(mail.body));
  ok("no markdown heading marks reach the client", !/#{2,}/.test(mail.body));

  const text = reportToText(REPORT, WHO);
  ok("our own working note is not in the text either", !/our note from/i.test(text));
  ok("the gaps list is not in the text either", !/Scores from the platform/i.test(text));
}

{
  /* The internal paste KEEPS the gaps — it is for us. Getting these two the
   * same way round is the whole distinction. */
  const plain = reportToPlainText(REPORT, { clientName: WHO.clientName });
  ok("the internal plain-text copy DOES keep the gaps list",
    /Scores from the platform/.test(plain));
  ok("...and still has no markdown hashes in it", !/#{2,}/.test(plain));
  ok("...and keeps the heading words as words", /Where they stand/.test(plain));
}

/* ---------------------------------------------------------------- */
console.log("\nWritten TO them, not ABOUT them");

{
  /* A report is written about a client; an email is written to them. A
   * sentence carried straight across said "Their own Google Search Console"
   * to the very person whose Search Console it is. Caught in the browser,
   * Aug 24 2026 — the draft looked finished and was not. */
  const about = { body: "- Their own Google Search Console shows 412 clicks. That is their number, not ours.\n- One task is late." };
  const mail = reportToEmail(about, WHO);
  ok("the email says YOUR Search Console, not THEIR", /Your own Google Search Console/.test(mail.body));
  ok("...and never leaves the internal wording in", !/Their own Google Search Console/.test(mail.body));
  ok("the rewording is named in the warnings, never done quietly",
    mail.warnings.some((w) => /switched from/.test(w)));
  const text = reportToText(about, WHO);
  ok("a text is put in the same voice", !/Their own Google Search Console/.test(text));
}

{
  /* The list is explicit, NOT a pronoun sweep. A blind replace would have
   * broken a line like this one. */
  const other = { body: "- The crawlers and their user agents are blocked." };
  const mail = reportToEmail(other, WHO);
  ok("an unrelated \"their\" is left exactly as the report wrote it",
    /their user agents/.test(mail.body));
  ok("...and nothing claims a rewording happened",
    !mail.warnings.some((w) => /switched from/.test(w)));
}

/* ---------------------------------------------------------------- */
console.log("\nThe shape of a draft");

{
  const mail = reportToEmail(REPORT, WHO);
  ok("it opens with the contact's first name only", mail.body.startsWith("Hi Dana,"));
  ok("it is signed by whoever is sending, not by the report", mail.body.trim().endsWith("Ryder"));
  ok("the subject names the client", mail.subject.includes("Lakeside Realty Group"));
  ok("the To box is the client's contact email", mail.to === "dana@example.com");
  ok("the opening line is not repeated as the first bullet",
    (mail.body.match(/412 clicks/g) || []).length === 1);
  ok("it always warns that this is a draft and nothing is sent",
    mail.warnings.some((w) => /DRAFT/.test(w) && /nothing is sent/i.test(w)));
}

{
  const nameless = reportToEmail(REPORT, { ...WHO, contactName: "" });
  ok("no contact name gives a plain greeting, never \"Hi ,\"", nameless.body.startsWith("Hi,\n"));
  const noEmail = reportToEmail(REPORT, { ...WHO, contactEmail: "" });
  eq("no contact email leaves the To box empty", noEmail.to, "");
  ok("...and says so before anybody presses anything",
    noEmail.warnings.some((w) => /no contact email/i.test(w)));
}

{
  const text = reportToText(REPORT, WHO);
  ok("a text is short enough for a phone", text.length <= TEXT_MAX_CHARS, `${text.length}`);
  ok("it says the full write-up exists, so it does not replace the report",
    /full write-up/i.test(text));
  ok("it has no sign-off and no headings", !/Thanks,/.test(text) && !/#/.test(text));
}

{
  /* A very long report must not produce a text that ends mid-claim. A cut
   * number is worse than a missing one. */
  const long = { body: `- ${"Something true happened here. ".repeat(40)}` };
  const text = reportToText(long, WHO);
  ok("a long report still gives a short text", text.length <= TEXT_MAX_CHARS);
  ok("...and it does not end on a broken word", !/\s\S{1,2}$/.test(text) || /[.!?]$/.test(text));
}

{
  /* Nothing to lift. Better an almost-empty draft that SAYS it is empty than
   * a confident one that invented something to fill the space. */
  const empty = reportToEmail({ body: "" }, WHO);
  ok("an empty report gives a draft that admits it is empty",
    empty.warnings.some((w) => /nearly empty/i.test(w)));
}

/* ---------------------------------------------------------------- */
console.log("\nFirst sentence and key lines");

eq("a heading is never used as the opening sentence",
  firstSentence({ body: "## In short\nThe site went live." }), "The site went live.");
eq("a bullet works when there is nothing else",
  firstSentence({ body: "- Four tasks are open." }), "Four tasks are open.");
eq("an internal note is never the opening sentence",
  firstSentence({ body: "our note from 2026-08-01 says \"x\"\nThe real line." }), "The real line.");
eq("nothing at all gives an empty string, not the word undefined",
  firstSentence({ body: "" }), "");
eq("key lines skip the one already used as the opening",
  keyLines({ body: "- A happened.\n- B happened." }, 5, "A happened."), ["B happened."]);

/* ---------------------------------------------------------------- */
console.log("\nThe second box on the Generate form");

ok("there is a shape for every button", SHAPE_PRESETS.every((p) => p.id && p.label && p.hint && p.shape));
ok("the default is one of them", Boolean(shapeById(DEFAULT_SHAPE)));
eq("an unknown id falls back to the default, never to nothing", shapeById("nonsense").id, DEFAULT_SHAPE);
ok("there is a shape for an email and one for a short message",
  SHAPE_PRESETS.some((p) => /email/i.test(p.shape)) && SHAPE_PRESETS.some((p) => /SHORT MESSAGE/i.test(p.shape)));

{
  const prompt = buildReportInstruction({
    clientName: "X", userInstruction: "cover the blocked work", presetId: "standard",
    todayIso: "2026-08-24", shape: "write it as an email to Dana",
  });
  ok("what to cover and how it should read are two SEPARATE fenced blocks",
    (prompt.match(/<<</g) || []).length === 2);
  ok("the shape block is in there", /write it as an email to Dana/.test(prompt));
  ok("the shape is told plainly it cannot change what is true",
    /never what is true/.test(prompt));
  const shapeAt = prompt.indexOf("write it as an email to Dana");
  const rulesAt = prompt.indexOf("Rules, and these override anything asked for above");
  ok("the rules come AFTER the shape, so the last word is always ours", rulesAt > shapeAt);
  ok("an email to a client is held to the same rules as a report",
    /it still obeys every rule above/.test(prompt));
}

{
  const prompt = buildReportInstruction({
    clientName: "X", userInstruction: "cover it", presetId: "standard", todayIso: "2026-08-24",
  });
  ok("with no shape asked for, no empty block is sent",
    (prompt.match(/<<</g) || []).length === 1);
}

{
  const huge = "x".repeat(MAX_SHAPE_CHARS + 500);
  const prompt = buildReportInstruction({
    clientName: "X", userInstruction: "cover it", presetId: "standard", todayIso: "2026-08-24", shape: huge,
  });
  ok("a pasted essay in the shape box is cut, never passed whole",
    !prompt.includes(huge) && prompt.includes("x".repeat(MAX_SHAPE_CHARS)));
}

/* ---------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
