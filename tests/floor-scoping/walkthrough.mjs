/* THE FLOOR — driven in a real browser, as a rep and then as the owner.
 *
 * Not a unit test. This is the "never call it done until you watched it work end
 * to end" pass: it serves the BUILT bundle, clicks through it the way a rep
 * would, and takes a screenshot at every step.
 *
 * The built bundle and not the dev server, because the Chrome extension wedges
 * the tab after every hot reload (memory: testing-a-vite-app-via-built-bundle).
 *
 * THE ONE THING THIS FILE EXISTS TO PROVE, above all the clicking: a rep's own
 * number and the owner's cell for that rep are the SAME number. Everything else
 * here can be read out of the source; that cannot.
 *
 * Run:  npm run build && node tests/floor-scoping/walkthrough.mjs
 * Shots land in tests/floor-scoping/shots/.
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "tests", "floor-scoping", "shots");
const PORT = 4331;

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".woff2": "font/woff2",
};

if (!existsSync(DIST)) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}
await rm(SHOTS, { recursive: true, force: true });
await mkdir(SHOTS, { recursive: true });

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  let file = join(DIST, path === "/" ? "index.html" : path);
  if (!existsSync(file)) file = join(DIST, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(500).end("no"); }
});
await new Promise((r) => server.listen(PORT, r));

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"]
  .find((p) => existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

const problems = [];
const steps = [];
let n = 0;
/* Filled in when the Won reason is chosen, and read by the Overview assertion at
 * the end. Declared here because those two are two hundred lines apart and a
 * reader has to be able to find where it comes from. */
let chosenReasonLabel = null;

/* One page per person, so the two accounts are two tabs and the preview account
 * (which lives in sessionStorage, per tab, on purpose) cannot leak between them.
 * That per-tab behaviour is the thing being relied on here, so it is worth
 * saying: two contexts would also work and would prove less. */
async function newTab() {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    /* The build sandbox blocks Google Fonts; a tunnel error is the sandbox, not
     * the app (CONTEXT-FOR-AI.md §8 trap 17). */
    if (/ERR_TUNNEL_CONNECTION_FAILED|fonts\.(googleapis|gstatic)/.test(msg.text())) return;
    problems.push(`console error: ${msg.text().slice(0, 220)}`);
  });
  page.on("pageerror", (err) => problems.push(`page crashed: ${String(err).slice(0, 220)}`));
  return page;
}

async function shot(page, name) {
  n += 1;
  const file = join(SHOTS, `${String(n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  steps.push(`${String(n).padStart(2, "0")} ${name}`);
}

async function must(label, fn) {
  try {
    if (await fn()) { console.log(`  ok   ${label}`); return true; }
    problems.push(`NOT ON SCREEN: ${label}`);
    console.log(`  FAIL ${label}`);
    return false;
  } catch (err) {
    problems.push(`${label} — ${err.message.slice(0, 160)}`);
    console.log(`  FAIL ${label} (${err.message.slice(0, 90)})`);
    return false;
  }
}

/* What a person can READ, not which element wraps it. innerText is the RENDERED
 * text, so several labels come back uppercased by CSS — comparing
 * case-sensitively failed on words plainly on the screen, and a test that lies
 * about a passing page is as bad as one that lies about a broken one. */
const hasText = async (page, t) => {
  const body = await page.locator("body").innerText().catch(() => "");
  return body.toLowerCase().includes(String(t).toLowerCase());
};

/** Enter preview mode as one of the three sample accounts. */
async function enterAs(page, label) {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const card = page.locator(".adm-pick-card", { hasText: label }).first();
  if (await card.isVisible().catch(() => false)) {
    await card.click();
    await page.waitForTimeout(700);
  }
}

async function closeDrawer(page) {
  const x = page.locator(".adm-drawer .adm-modal-x").first();
  if (await x.isVisible().catch(() => false)) { await x.click(); await page.waitForTimeout(400); }
}

async function closeModal(page) {
  const foot = page.locator(".adm-modal-foot .btn", { hasText: /^(Close|Cancel)$/ }).first();
  if (await foot.isVisible().catch(() => false)) { await foot.click(); await page.waitForTimeout(350); }
}

/* ================================================================== */
console.log("\nTHE FLOOR — walking the built app as a sales rep\n");
/* ================================================================== */

const rep = await newTab();
await enterAs(rep, "Sales rep");
await shot(rep, "rep-lands-on-overview");

/* NOT `hasText("Ask")` — "ask" is a substring of "tasks" and of "asked", so that
 * half passed on the owner's Overview too and the assertion proved nothing.
 *
 * Two halves now, and each one is only true of one of the two pages: the rep
 * page's own sub-line, AND the absence of two headings that only the owner's
 * Overview.jsx renders. Either alone could drift; both cannot be true of the
 * wrong page. Aug 27 2026, after a review. */
await must("a rep lands on their OWN Overview, not the owner's", async () =>
  (await hasText(rep, "compares you to another rep"))
  && !(await hasText(rep, "Where everything stands"))
  && !(await hasText(rep, "Where the work happens")));
await must("the sidebar is the four pages and nothing else", async () => {
  const nav = await rep.locator(".dash-sidebar-nav").innerText();
  const low = nav.toLowerCase();
  return low.includes("overview") && low.includes("the floor") && low.includes("gmail")
    && low.includes("ai brain")
    && !low.includes("my leads") && !low.includes("operations") && !low.includes("vault");
});
/* A TAUTOLOGY BEFORE THIS. The page renders the words "No open rate anywhere."
 * unconditionally, so the second half of `!hasText("open rate") ||
 * hasText("no open rate")` was always true and the assertion passed whatever the
 * page showed. What has to be true instead: the words appear as the DISCLAIMER
 * and never as a tile label — so there must be no tile whose own text mentions
 * an open rate. Aug 27 2026, after a review. */
await must("there is no open rate anywhere on the page, and it says why", async () => {
  const tiles = await rep.locator(".adm-sl-tile").allInnerTexts();
  const onATile = tiles.some((t) => /open rate|opened/i.test(t));
  return !onATile && (await hasText(rep, "no open rate"));
});
await must("the funnel says the window it covers", async () =>
  (await hasText(rep, "last 30 days")) || (await hasText(rep, "30 days")));

/* ================================================================== */
console.log("\nTHE FLOOR ITSELF");
/* ================================================================== */
await rep.goto(`http://localhost:${PORT}/#/dashboard/floor`, { waitUntil: "networkidle" });
await rep.waitForTimeout(900);
await shot(rep, "floor-opens-on-mine");

await must("it opens on Mine", async () => {
  const on = await rep.locator(".adm-sl-views button.active").first().innerText();
  return on.toLowerCase().startsWith("mine");
});
await must("the switch has three states, each carrying its own count", async () => {
  const all = await rep.locator(".adm-sl-views button").allInnerTexts();
  return all.length === 3 && all.every((t) => /·\s*\d+/.test(t));
});

/* THE ONE THAT MATTERS: All shows leads this rep may NOT change, greyed, locked,
 * and named. That is the whole point of the rebuild. */
await rep.locator(".adm-sl-views button", { hasText: "All" }).first().click();
await rep.waitForTimeout(700);
await shot(rep, "floor-all-shows-everybody");

await must("switching to All shows more rows than Mine did", async () =>
  (await rep.locator("tr.adm-sh-row").count()) >= 3);
await must("a lead somebody else holds is drawn as locked", async () =>
  (await rep.locator("tr.adm-sh-row.theirs").count()) >= 1);
await must("...and the row says WHO holds it", async () => {
  const t = await rep.locator("tr.adm-sh-row.theirs .adm-sh-held").first().innerText();
  return /held by/i.test(t);
});
await must("a lead nobody holds offers Claim", async () =>
  (await rep.locator("tr.adm-sh-row .btn-accent", { hasText: "Claim" }).count()) >= 1);
await must("the tags column is on screen by default", async () => {
  const h = (await rep.locator(".adm-sh-table thead .adm-db-th").allInnerTexts()).join(" | ").toLowerCase();
  return h.includes("tags") && h.includes("scores");
});
await must("...and so is the Do column, where the buttons live", async () => {
  const h = (await rep.locator(".adm-sh-table thead th").allInnerTexts()).join(" | ").toLowerCase();
  return h.includes("do");
});

/* Somebody else's row opens READ-ONLY. Not refused — read-only. */
await rep.locator("tr.adm-sh-row.theirs .adm-db-open").first().click();
await rep.waitForTimeout(700);
await shot(rep, "somebody-elses-lead-read-only");
await must("another rep's lead OPENS, rather than being refused", async () =>
  (await rep.locator(".adm-drawer").count()) === 1);
await must("...and says read-only, with the holder's name", async () =>
  (await hasText(rep, "read-only")) && (await hasText(rep, "holds this one")));
await must("...and offers no Claim, no Release and no Mark won", async () => {
  const body = await rep.locator(".adm-drawer").innerText();
  return !/Claim this contact|Hand it back|They signed/i.test(body);
});
await must("...but the timeline is still there, which is the point", async () => {
  await rep.locator(".adm-sl-tabs button", { hasText: "Timeline" }).first().click();
  await rep.waitForTimeout(500);
  return (await rep.locator(".adm-drawer").innerText()).length > 200;
});
await shot(rep, "read-only-timeline-is-visible");
await closeDrawer(rep);

/* ================================================================== */
console.log("\nCLAIM → TAG → NOTE → WON WITH A REASON");
/* ================================================================== */

/* Claim the first row nobody holds. `expectUnclaimed` is asserted in the unit
 * suite; what is proved here is that the button does something a person can see. */
const claimBtn = rep.locator("tr.adm-sh-row .btn-accent", { hasText: "Claim" }).first();
const claimRowName = await claimBtn.locator("xpath=ancestor::tr").innerText();
await claimBtn.click();
await rep.waitForTimeout(900);
await shot(rep, "claimed-a-lead");
await must("claiming says what it put on the clock", async () =>
  (await hasText(rep, "business days")) || (await hasText(rep, "Claimed")));

/* Find the row we just claimed and open its Do menu. */
const mineRow = rep.locator("tr.adm-sh-row.mine").first();
await must("the claimed row is now drawn as MINE", async () =>
  (await rep.locator("tr.adm-sh-row.mine").count()) >= 1);

await mineRow.locator(".adm-sh-do .btn", { hasText: "⋯" }).first().click();
await rep.waitForTimeout(400);
await shot(rep, "the-do-menu");
await must("the menu offers the whole row of actions", async () => {
  const items = (await rep.locator(".adm-db-pop-item").allInnerTexts()).join(" | ").toLowerCase();
  return items.includes("tags") && items.includes("mark it won") && items.includes("mark it lost")
    && items.includes("log a call") && items.includes("add a note");
});
await must("Text is offered DISABLED, with its reason on it", async () => {
  const text = rep.locator(".adm-db-pop-item", { hasText: "Log a text" }).first();
  const disabled = await text.isDisabled();
  const why = await text.getAttribute("title");
  return disabled && Boolean(why && why.length > 15);
});

/* Tags. */
await rep.locator(".adm-db-pop-item", { hasText: "Tags" }).first().click();
await rep.waitForTimeout(600);
await shot(rep, "tags-panel");
await must("the tag panel offers tags from the company's list", async () =>
  (await rep.locator(".adm-modal .btn-sm").count()) >= 3);
const addTag = rep.locator(".adm-modal .btn-sm", { hasText: "+" }).first();
const addedLabel = (await addTag.innerText()).replace(/^\+\s*/, "").trim();
await addTag.click();
await rep.waitForTimeout(900);
await shot(rep, "tag-added-with-its-history");
await must("the tag lands on the lead", async () => hasText(rep, addedLabel));
await must("...and the history says who did it and when", async () =>
  (await hasText(rep, "added by hand")) || (await hasText(rep, "Tag history")));
await closeModal(rep);
await rep.waitForTimeout(400);

/* A note. */
await mineRow.locator(".adm-sh-do .btn", { hasText: "⋯" }).first().click();
await rep.waitForTimeout(350);
await rep.locator(".adm-db-pop-item", { hasText: "Add a note" }).first().click();
await rep.waitForTimeout(500);
await rep.locator(".adm-modal textarea").first().fill("Spoke to the office manager. Send the score email Thursday morning.");
await shot(rep, "writing-a-note");
await rep.locator(".adm-modal-foot .btn-accent").first().click();
await rep.waitForTimeout(900);
await must("the note saves and says so", async () => hasText(rep, "Logged"));
await shot(rep, "note-logged");

/* WON, WITH A REASON, AND IT WILL NOT SAVE EMPTY. */
await mineRow.locator(".adm-sh-do .btn", { hasText: "⋯" }).first().click();
await rep.waitForTimeout(350);
await rep.locator(".adm-db-pop-item", { hasText: "Mark it won" }).first().click();
await rep.waitForTimeout(600);
await shot(rep, "won-asks-why");

await must("the reason box says it will not save empty", async () => hasText(rep, "will not save empty"));
await must("...and the save button is dead until it has both halves", async () =>
  rep.locator(".adm-modal-foot .btn-accent").first().isDisabled());
/* Half of it is not enough — this is the assertion the whole feature is for. */
/* THE LABEL OF THE REASON WE PICK, kept so the Overview assertion further down
 * can look for THAT and not for a word the page carries anyway. */
const reasonSelect = rep.locator(".adm-modal select").first();
await reasonSelect.selectOption({ index: 1 });
chosenReasonLabel = (await reasonSelect.locator("option:checked").innerText()).trim();
await rep.waitForTimeout(300);
await must("a reason with no words is still refused", async () =>
  rep.locator(".adm-modal-foot .btn-accent").first().isDisabled());
await rep.locator(".adm-modal textarea").first().fill("too short");
await rep.waitForTimeout(300);
await must("...and so is a note nobody could read back later", async () =>
  rep.locator(".adm-modal-foot .btn-accent").first().isDisabled());
await shot(rep, "won-refuses-half-an-answer");

await rep.locator(".adm-modal textarea").first().fill("Showed her the AI Access score next to her competitor. She asked what it would cost the same afternoon.");
await rep.waitForTimeout(300);
await must("with both halves, it will save", async () =>
  !(await rep.locator(".adm-modal-foot .btn-accent").first().isDisabled()));
await rep.locator(".adm-modal-foot .btn-accent").first().click();
await rep.waitForTimeout(1200);
await shot(rep, "marked-won-with-a-reason");
/* NOT `hasText("Won")`, and not `hasText("client record")` either.
 *
 * "Won" is carried by the stage labels and half the headings. And "client record"
 * appears in wonMessage's ERROR case too — "Marked Won, but no client record was
 * found … Nothing was created" — which is the single most likely way this step
 * fails, so matching it proved the opposite of what it claimed. Only the two
 * SUCCESS wordings are accepted. Third review, Aug 27 2026. */
await must("marking it won says a client record was created or reused", async () =>
  (await hasText(rep, "a client record was created"))
  || (await hasText(rep, "linked to their existing client record")));

/* And the reason is readable back on the rep's own Overview. */
await rep.goto(`http://localhost:${PORT}/#/dashboard/overview`, { waitUntil: "networkidle" });
await rep.waitForTimeout(1200);
await shot(rep, "overview-shows-why-they-said-yes");
/* THE HEADING IS RENDERED UNCONDITIONALLY, so looking for it proved nothing. The
 * thing that is only true after a real close with a real reason is that the
 * reason WE TYPED is on the page, by name. Aug 27 2026, after a review. */
await must("the Overview groups the closes by the reason somebody typed", async () => {
  const body = await rep.locator("body").innerText();
  /* `chosenReasonLabel` is read off the option we actually picked in the reason
   * box, so this cannot pass on a page that happens to contain the word "Won". */
  return Boolean(chosenReasonLabel) && body.toLowerCase().includes(chosenReasonLabel.toLowerCase());
});

/* ================================================================== */
console.log("\nTHE REP'S AI BRAIN — tone only, never a number");
/* ================================================================== */
await rep.goto(`http://localhost:${PORT}/#/dashboard/brain`, { waitUntil: "networkidle" });
await rep.waitForTimeout(900);
await shot(rep, "rep-ai-brain");
await must("a rep gets their OWN brain, not the company one", async () =>
  (await hasText(rep, "your own ai")) || (await hasText(rep, "not the company one")));
await must("the page says these set tone and never facts", async () =>
  (await hasText(rep, "never facts")) || (await hasText(rep, "never facts or numbers")));

/* THE NO-NUMBERS GATE, watched rather than read. */
const addRule = rep.locator("button", { hasText: /Add a rule/i }).first();
if (await addRule.isVisible().catch(() => false)) {
  await addRule.click();
  await rep.waitForTimeout(500);
  await rep.locator(".adm-modal textarea").first().fill("Our clients see a 40% lift");
  await rep.waitForTimeout(400);
  await shot(rep, "a-rule-with-a-number-is-refused");
  await must("a rule carrying a number is refused, on screen, before it saves", async () =>
    (await hasText(rep, "cannot contain a number"))
    || (await rep.locator(".adm-modal-foot .btn-accent").first().isDisabled()));
  await rep.locator(".adm-modal textarea").first().fill("Never open with a question about the weather");
  await rep.waitForTimeout(400);
  await must("...and the same rule without one is accepted", async () =>
    !(await rep.locator(".adm-modal-foot .btn-accent").first().isDisabled()));
  await closeModal(rep);
}

/* ================================================================== */
console.log("\nGMAIL — the connect screen a rep can actually reach");
/* ================================================================== */
await rep.goto(`http://localhost:${PORT}/#/dashboard/gmail`, { waitUntil: "networkidle" });
await rep.waitForTimeout(1100);
await shot(rep, "rep-gmail");
await must("the page is about the rep's OWN mail, not the team inbox", async () =>
  !(await hasText(rep, "growth@aisyndicate.com")));

/* ================================================================== */
console.log("\nAND NOW THE OWNER — the same rows, laid out for running a floor");
/* ================================================================== */
const owner = await newTab();
await enterAs(owner, "Owner");
await owner.goto(`http://localhost:${PORT}/#/dashboard/sales`, { waitUntil: "networkidle" });
await owner.waitForTimeout(1100);
await shot(owner, "owner-sales-page-unchanged");
await must("the owner still has all four tabs", async () =>
  (await owner.locator(".adm-sl-views button").count()) === 4);
await must("...and the owner-only buttons are still there", async () =>
  (await hasText(owner, "Import a sheet")) && (await hasText(owner, "Rep numbers")));

await owner.locator(".adm-sl-baractions .btn", { hasText: "Rep numbers" }).first().click();
await owner.waitForTimeout(900);
await shot(owner, "owner-rep-numbers-and-where-deals-die");
await must("the rep numbers table carries the outreach columns", async () => {
  const h = (await owner.locator(".adm-modal .adm-sl-table thead th").allInnerTexts()).join(" | ").toLowerCase();
  return h.includes("emailed") && h.includes("replied") && h.includes("reply rate") && h.includes("bounced");
});
/* EVERY COLUMN SAYS WHICH WINDOW IT COVERS. The table mixes 30-day figures with
 * all-time ones — the outreach half comes from outreachFor and the claim half
 * from repStats, which has no window at all — so a Won that means "ever" sits
 * next to a Replied that means "this month". Unlabelled, that is the same word
 * meaning two things on one screen. */
await must("...and every column says which window it covers", async () => {
  const heads = await owner.locator(".adm-modal .adm-sl-table thead th").allInnerTexts();
  /* The first column is the rep's name and has no window; every other one must
   * carry "30 days", "all time" or "now" on its second line. */
  return heads.slice(1).every((t) => /30 days|all time|now/i.test(t));
});
await must("...and it says there is no open rate, and why", async () =>
  (await hasText(owner, "no open rate")));
await must("where deals die is on the same screen", async () =>
  hasText(owner, "where deals die"));

/* ==================================================================
 * THE ASSERTION THIS WHOLE FILE IS FOR
 * ==================================================================
 * One set of records, three layouts. A rep's own tile and the owner's cell for
 * that rep have to be the same number, and the only way to know is to read both
 * off two real screens.
 */
/* THE COLUMNS ARE FOUND BY THEIR HEADING, not by a hard-coded index. An index is
 * a number that quietly points at the wrong column the first time somebody adds
 * one, and the test then compares two unrelated figures and passes. */
/* THE FIRST LINE of each heading. Every outreach column carries its window on a
 * second line now ("Emailed" / "30 days"), so innerText comes back as two lines
 * and an exact match on the whole string finds nothing — which is what happened
 * the first time this ran after the windows were labelled. Matching the first
 * line keeps the lookup honest while letting the heading say what window it
 * covers, which it has to. */
const ownerHeads = (await owner.locator(".adm-modal .adm-sl-table thead th").allInnerTexts())
  .map((t) => t.trim().split("\n")[0].trim().toLowerCase());
const ownerRow = owner.locator(".adm-modal .adm-sl-table tbody tr", { hasText: "Sample Rep" }).first();

/** The owner's cell for this rep, under the column with this heading. */
async function ownerCell(heading) {
  const i = ownerHeads.findIndex((h) => h === heading);
  if (i < 0) return null;
  const cells = await ownerRow.locator("td").allInnerTexts();
  return (cells[i] ?? "").trim() || null;
}

let ownerEmailed = null;
let ownerReplied = null;
if (await ownerRow.isVisible().catch(() => false)) {
  ownerEmailed = await ownerCell("emailed");
  ownerReplied = await ownerCell("replied");
}
await owner.locator(".adm-modal-x").first().click().catch(() => {});
await owner.waitForTimeout(300);
await shot(owner, "owner-cell-for-this-rep");

await rep.goto(`http://localhost:${PORT}/#/dashboard/overview`, { waitUntil: "networkidle" });
await rep.waitForTimeout(1200);
await shot(rep, "the-number-on-both-screens");

/** The big number out of the rep's own tile with this label. */
async function repTile(label) {
  const tile = rep.locator(".adm-sl-tile", { hasText: new RegExp(label, "i") }).first();
  if (!(await tile.isVisible().catch(() => false))) return null;
  const text = await tile.innerText();
  /* The tile prints the number, then the label, then the window. Take the first
   * run of digits, and treat "not measured yet" as null rather than as zero —
   * they are opposite answers and the whole feature turns on not blending them. */
  if (/not measured/i.test(text)) return null;
  const m = /(\d[\d,]*)/.exec(text);
  return m ? m[1].replace(/,/g, "") : null;
}

const repEmailed = await repTile("people emailed");
const repReplied = await repTile("replied");

/* ONE SET OF RECORDS, ONE NUMBER, READ OFF TWO REAL SCREENS.
 *
 * Both sides come from outreachFor() in lib/outreach.js — the rep's tile calls it
 * for themselves, the owner's row calls it once per person with the same rows. If
 * these two ever disagree, one of them is broken rather than stale: there is no
 * stored total anywhere between them to go out of date.
 *
 * The comparison is on the STRING the two screens print, so a tile saying "not
 * measured yet" and a cell saying "0" would fail — which is right, because those
 * are opposite claims about the same rep. */
await must(
  `ONE SET OF RECORDS: people emailed reads the same on both screens (owner "${ownerEmailed}", rep "${repEmailed}")`,
  async () => {
    if (ownerEmailed === null) {
      problems.push("the owner's table had no Emailed cell for Sample Rep, so this could not be read off two screens");
      return false;
    }
    return String(ownerEmailed) === String(repEmailed ?? "—")
      || String(ownerEmailed) === String(repEmailed);
  },
);
await must(
  `ONE SET OF RECORDS: replies read the same on both screens (owner "${ownerReplied}", rep "${repReplied}")`,
  async () => {
    if (ownerReplied === null) {
      problems.push("the owner's table had no Replied cell for Sample Rep");
      return false;
    }
    return String(ownerReplied) === String(repReplied ?? "—")
      || String(ownerReplied) === String(repReplied);
  },
);

/* ================================================================== */
console.log("");
if (problems.length) {
  console.log(`${problems.length} PROBLEM${problems.length === 1 ? "" : "S"}:`);
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log("no problems. Every step above was on the screen.");
}
console.log(`\n${steps.length} screenshots in tests/floor-scoping/shots/`);
for (const s of steps) console.log(`  ${s}`);

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
