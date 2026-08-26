/* A real browser, walking the Sales page from end to end.
 *
 * Not a unit test. This is the "never call it done until you watched it work"
 * pass: it builds nothing itself, serves the BUILT bundle, clicks through it
 * like a rep would, and takes a screenshot at every step.
 *
 * Why the built bundle and not the dev server: the Chrome extension wedges the
 * tab after every hot reload (memory: testing-a-vite-app-via-built-bundle).
 * `npm run build` then serve dist/ is the only reliable way to drive it.
 *
 * Run:  npm run build && node tests/sales/walkthrough.mjs
 * Shots land in tests/sales/shots/.
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "tests", "sales", "shots");
const PORT = 4321;

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
  if (!existsSync(file)) file = join(DIST, "index.html");   // hash router
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(500).end("no");
  }
});
await new Promise((r) => server.listen(PORT, r));

const CHROME_DIRS = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"];
const CHROME = CHROME_DIRS.find((p) => existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });

const problems = [];
const steps = [];
let n = 0;

page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  // No route to the internet in this container, so the Google Fonts link in
  // index.html fails here and only here. Everything else is reported.
  if (/ERR_TUNNEL_CONNECTION_FAILED|fonts\.(googleapis|gstatic)/.test(msg.text())) return;
  problems.push(`console error: ${msg.text().slice(0, 220)}`);
});
page.on("pageerror", (err) => problems.push(`page crashed: ${String(err).slice(0, 220)}`));

async function shot(name) {
  n += 1;
  const file = join(SHOTS, `${String(n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  steps.push(`${String(n).padStart(2, "0")} ${name}`);
}

/** Assert something is on screen, and say plainly what was expected if not. */
async function must(label, fn) {
  try {
    const ok = await fn();
    if (ok) { console.log(`  ok   ${label}`); return true; }
    problems.push(`NOT ON SCREEN: ${label}`);
    console.log(`  FAIL ${label}`);
    return false;
  } catch (err) {
    problems.push(`${label} — ${err.message.slice(0, 160)}`);
    console.log(`  FAIL ${label} (${err.message.slice(0, 90)})`);
    return false;
  }
}

/* Read the page's actual text rather than asking for a locator. A locator
 * match depends on which element wraps the words; what a person can READ does
 * not, and "can a person read this on the page" is the real question. */
const has = async (t) => {
  const body = await page.locator("body").innerText().catch(() => "");
  /* Case-insensitive, because innerText returns what is RENDERED and several
   * labels here are uppercased by CSS. Comparing case-sensitively failed on
   * words that were plainly on the screen — a test that lies about a passing
   * page is as bad as one that lies about a broken one. */
  return body.toLowerCase().includes(t.toLowerCase());
};

console.log("\nSALES — walking the built app\n");

/* ---- 1. the page loads under its new name ---- */
await page.goto(`http://localhost:${PORT}/#/dashboard/sales`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await shot("sales-lists");
await must("the sidebar says Sales, not Leads", async () =>
  (await page.locator("nav button", { hasText: "Sales" }).count()) > 0
  && (await page.locator("nav button", { hasText: /^Leads$/ }).count()) === 0);
await must("the header names the page", () => has("Sales · the pipeline"));
await must("the tiles are drawn", () => has("On the floor"));
/* Rebuilt Aug 25 2026: the firm was a collapsible header row, and is now a
   column on a flat row per person. Both checks below changed with it — the
   "2 reps working this firm" banner moved into the Company cell's menu and is
   covered in tests/sales-sheet/walkthrough.mjs. */
await must("the sheet lists PEOPLE in rows, not firms with dropdowns", async () =>
  (await page.locator("tr.adm-sh-row").count()) > 0
  && (await page.locator(".adm-sl-firmtoggle").count()) === 0);
await must("the firm is a column on the row", () => has("Harborline Realty Group"));

/* ---- 2. the old address still works ---- */
await page.goto(`http://localhost:${PORT}/#/dashboard/leads`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await must("an old #/dashboard/leads link lands on Sales", async () => {
  const url = page.url();
  return url.includes("/dashboard/sales") && await has("Sales · the pipeline");
});
await shot("legacy-link");

/* ---- 3. My Day ---- */
await page.locator(".adm-sl-views button", { hasText: "My Day" }).click();
await page.waitForTimeout(500);
await shot("my-day");
await must("My Day groups the work by why it is there", async () =>
  (await page.locator(".adm-sl-grouphead").count()) > 0);
await must("every card says the reason out loud", async () =>
  (await page.locator(".adm-sl-card-why").count()) > 0);
await must("a claim that has run out is shown as late", async () =>
  (await page.locator(".adm-sl-late").count()) > 0);

/* ---- 4. the firms view, and the 90+ gate ---- */
await page.locator(".adm-sl-views button", { hasText: "Firms" }).click();
await page.waitForTimeout(500);
await shot("firms");
await must("firms are listed with their score", () => has("Bright Coast Medspa"));
await must("a 90+ firm is labelled SKIP, not just a high number", () => has("SKIP"));
await must("an unscored firm offers to run one", () => has("NO SCORE"));

/* ---- 5. the pipeline board ---- */
await page.locator(".adm-sl-views button", { hasText: "Pipeline" }).click();
await page.waitForTimeout(500);
await shot("pipeline");
await must("the board draws a column per stage", async () =>
  (await page.locator(".adm-board-col").count()) >= 8);

/* ---- 6. the profile — the thing the sheet cannot be ---- */
await page.locator(".adm-sl-views button", { hasText: "The sheet" }).click();
await page.waitForTimeout(400);
await page.locator("tr.adm-sh-row").first().click();
await page.waitForTimeout(600);
await shot("profile-work");
await must("the profile opens on Work", () => has("WHAT TO DO NEXT"));
await must("the 5-touch cadence is drawn", () => has("The 5-touch cadence"));
await must("the log-a-touch buttons are there", () => has("Log what you did"));

await page.locator(".adm-sl-tabs button", { hasText: "Timeline" }).click();
await page.waitForTimeout(400);
await shot("profile-timeline");

await page.locator(".adm-sl-tabs button", { hasText: "Details" }).click();
await page.waitForTimeout(400);
await shot("profile-details");
await must("the firm's fields are separate from the person's", () => has("The firm"));

await page.locator(".adm-sl-tabs button", { hasText: "Proposals" }).click();
await page.waitForTimeout(400);
await shot("profile-proposals");
await must("proposals exist as a real thing", async () =>
  (await has("New proposal")) || (await has("No proposal yet")));

await page.locator(".adm-sl-tabs button", { hasText: "Playbook" }).click();
await page.waitForTimeout(400);
await shot("profile-playbook");
await must("the 7 moves are on the page where the work happens", () => has("Pattern interrupt"));
await must("the cadence days are spelled out", () => has("Breakup email"));

/* ---- 7. claiming ---- */
await page.keyboard.press("Escape");
await page.locator(".adm-modal-x").first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator("[data-filter=\"owner\"]").selectOption("floor").catch(() => {});
await page.waitForTimeout(500);
await page.locator("tr.adm-sh-row").first().click();
await page.waitForTimeout(600);
await shot("profile-unclaimed");
const claimBtn = page.locator("button", { hasText: /^Claim this contact$/ }).first();
if (await claimBtn.isVisible().catch(() => false)) {
  await claimBtn.click();
  await page.waitForTimeout(800);
  await shot("after-claim");
  await must("claiming says what happens next", () => has("business days"));
} else {
  problems.push("could not find the Claim button on an unclaimed contact");
}

/* ---- 8. the importer ---- */
await page.keyboard.press("Escape");
await page.locator(".adm-modal-x").first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator("button", { hasText: "Import a sheet" }).first().click();
await page.waitForTimeout(600);
await shot("import-choose");
await must("the importer explains itself before asking for a file", () => has("every tab comes in at once"));

/* ---- 8b. IMPORT THE SAME LIST TWICE ----
 *
 * The one behaviour most worth watching rather than trusting. The first
 * version of this page counted the duplicates, printed "412 already in the
 * pipeline", and then imported all 412 anyway — the check decided nothing.
 * This pastes three people in, imports them, then pastes the same three in
 * again and checks the second run writes nothing. */
const PASTE = [
  "Name\tCompany\tEmail\tWebsite\tTitle",
  "Nora Vance\tVance & Co Realty\tnora@vanceco-sample.com\tvanceco-sample.com\tBroker",
  "Owen Pike\tVance & Co Realty\towen@vanceco-sample.com\tvanceco-sample.com\tAgent",
  "Rhea Sol\tSol Dental\trhea@soldental-sample.com\tsoldental-sample.com\tOwner",
].join("\n");

async function importPaste() {
  await page.locator("button", { hasText: "Import a sheet" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".adm-modal-body textarea").fill(PASTE);
  await page.locator("button", { hasText: "Read the pasted rows" }).click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "Check the columns" }).click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "See what will happen" }).click();
  await page.waitForTimeout(700);
  const planText = await page.locator(".adm-modal-body").innerText();
  const btn = page.locator(".adm-modal-foot button", { hasText: /^Import \d+ contacts$/ });
  const label = await btn.innerText().catch(() => "");
  const disabled = await btn.isDisabled().catch(() => true);
  if (!disabled) { await btn.click(); await page.waitForTimeout(900); }
  const doneText = await page.locator(".adm-modal-body").innerText().catch(() => "");
  await page.locator(".adm-modal-foot button", { hasText: /Done|Cancel/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  return { planText, label, disabled, doneText };
}

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const first = await importPaste();
await shot("import-first-run");
await must("the first import offers to write all 3 people", () => Promise.resolve(/Import 3 contacts/.test(first.label)));
await must("it reports the firms it folded them into", () =>
  Promise.resolve(/2\s*firms/i.test(first.planText)));
await must("the first import actually wrote them", () =>
  Promise.resolve(/3\s*contacts imported/i.test(first.doneText)));

const second = await importPaste();
await shot("import-second-run");
await must("the SECOND import of the same list writes nothing", () =>
  Promise.resolve(second.disabled || /Import 0 contacts/.test(second.label)));
await must("and it says out loud that they are already here", () =>
  Promise.resolve(/skipped — already here/i.test(second.planText)));

/* Did the import leave a first line on the timeline, as the screen promised? */
await page.locator(".adm-sl-views button", { hasText: "The sheet" }).click();
await page.waitForTimeout(400);
await page.locator(".adm-sl-search").fill("Nora Vance");
await page.waitForTimeout(500);
await page.locator("tr.adm-sh-row").first().click();
await page.waitForTimeout(500);
await page.locator(".adm-sl-tabs button", { hasText: "Timeline" }).click();
await page.waitForTimeout(400);
await shot("import-timeline-note");
await must("an imported contact has a dated import note on its timeline", () => has("Imported from"));
await page.locator(".adm-modal-x").first().click().catch(() => {});
await page.locator(".adm-sl-search").fill("");
await page.waitForTimeout(400);

/* ---- 8c. the saved-search controls survived the rename ---- */
await page.locator("button", { hasText: "Where leads come from" }).first().click();
await page.waitForTimeout(500);
await shot("sources");
await must("imported lists and saved searches are still reachable", async () =>
  (await has("saved search")) || (await has("Import")) || (await has("source")));
await page.locator(".adm-modal-x").first().click().catch(() => {});
await page.waitForTimeout(300);

/* ---- 9. the rep numbers ---- */
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.locator("button", { hasText: "Rep numbers" }).first().click();
await page.waitForTimeout(600);
await shot("rep-numbers");
await must("rep numbers are shown", async () =>
  (await has("Speed to 1st")) || (await has("Nothing to count yet")));
await must("nothing measured says so rather than printing a zero", async () =>
  (await has("not measured")) || (await has("nothing decided")) || (await has("Nothing to count yet")));

/* ---- 10. the info cards are gone everywhere ---- */
await page.keyboard.press("Escape");
for (const p of ["work", "operations", "inbox", "notes", "brain", "platform", "vault", "team", "settings"]) {
  await page.goto(`http://localhost:${PORT}/#/dashboard/${p}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(350);
  const left = await page.locator(".dash-explainer").count();
  if (left > 0) problems.push(`${p} still has ${left} info card(s)`);
}
await shot("no-info-cards");
await must("no page still draws an info card", async () =>
  (await page.locator(".dash-explainer").count()) === 0);

/* ---- done ---- */
await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n  ${n} screenshots in tests/sales/shots/`);
console.log(steps.map((s) => `    ${s}`).join("\n"));
if (problems.length) {
  console.log(`\n  ${problems.length} PROBLEM(S):`);
  console.log(problems.map((p) => `    - ${p}`).join("\n"));
  process.exit(1);
}
console.log("\n  Walked the whole page with no console errors and nothing missing.\n");
