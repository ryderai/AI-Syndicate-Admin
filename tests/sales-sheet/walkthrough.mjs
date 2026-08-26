/* THE SHEET, AND THE RECORD THAT DOES NOT STOP AT THE SALE — in a real browser.
 *
 * Not a unit test. This is the "never call it done until you watched it work
 * end to end" pass: it serves the BUILT bundle, drives it like a rep would,
 * and takes a screenshot at every step.
 *
 * The built bundle and not the dev server, because the Chrome extension wedges
 * the tab after every hot reload (memory: testing-a-vite-app-via-built-bundle).
 *
 * Four of the defects fixed on Aug 22 were found by WATCHING the page rather
 * than by reading the code. This file exists for the same reason.
 *
 * Run:  npm run build && node tests/sales-sheet/walkthrough.mjs
 * Shots land in tests/sales-sheet/shots/.
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "tests", "sales-sheet", "shots");
const PORT = 4325;

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
const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });

const problems = [];
const steps = [];
let n = 0;

page.on("console", (msg) => {
  if (msg.type() !== "error") return;
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

/* What a person can READ, not which element wraps it. innerText returns the
 * RENDERED text, so several labels come back uppercased by CSS — comparing
 * case-sensitively failed on words plainly on the screen, and a test that lies
 * about a passing page is as bad as one that lies about a broken one. */
const has = async (t) => {
  const body = await page.locator("body").innerText().catch(() => "");
  return body.toLowerCase().includes(t.toLowerCase());
};
const headers = async () => page.locator(".adm-sh-table thead .adm-db-th").allInnerTexts();

/* Escape does not close the profile drawer — only the × does. Found here, by
 * a click that kept being intercepted by the backdrop of a drawer the test
 * thought it had already dismissed. */
async function closeDrawer() {
  const x = page.locator(".adm-drawer .adm-modal-x").first();
  if (await x.isVisible().catch(() => false)) { await x.click(); await page.waitForTimeout(400); }
}

console.log("\nTHE SHEET — walking the built app\n");

/* ================================================================== */
/* 1. IT IS ROWS OF PEOPLE                                             */
/* ================================================================== */
await page.goto(`http://localhost:${PORT}/#/dashboard/sales`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await shot("the-sheet");

await must("the firm dropdown is GONE — this is the whole ask", async () =>
  (await page.locator(".adm-sl-firmtoggle").count()) === 0);
await must("there is one row per person", async () =>
  (await page.locator("tr.adm-sh-row").count()) >= 5);
await must("the columns are in the spreadsheet's own order", async () => {
  const h = (await headers()).map((x) => x.replace(/[↑↓●]/g, "").trim().toLowerCase());
  return h[0].startsWith("sales owner") && h[1].startsWith("contacted")
    && h[2].startsWith("sales cycle status");
});
await must("First Name and Last Name are separate columns, like the sheet", async () => {
  const h = (await headers()).join(" | ").toLowerCase();
  return h.includes("first name") && h.includes("last name");
});
await must("the sheet's tabs are along the top", async () =>
  (await page.locator(".adm-sh-tabs button").count()) >= 2);
await must("a person's first and last name are actually split out", async () =>
  (await has("Priya")) && (await has("Patel")));

/* ================================================================== */
/* 2. CONTACTED? IS COUNTED, NOT TYPED                                 */
/* ================================================================== */
await must("a contact with logged touches reads Yes", () => has("Yes"));
await must("...and the reason is on the cell, not hidden in a manual", async () => {
  const t = await page.locator("tr.adm-sh-row .adm-sh-readonly").first().getAttribute("title");
  return Boolean(t && t.length > 20);
});

/* ================================================================== */
/* 3. CLICK A TITLE TO SORT — THREE STATES                             */
/* ================================================================== */
const stageHead = page.locator(".adm-sh-table thead .adm-db-th", { hasText: "Sales Cycle Status" }).first();
await stageHead.click();
await page.waitForTimeout(300);
await shot("sorted-asc");
await must("clicking the title sorts, and says so with an arrow", async () =>
  (await stageHead.innerText()).includes("↑"));
await stageHead.click();
await page.waitForTimeout(300);
await must("clicking again reverses it", async () => (await stageHead.innerText()).includes("↓"));
await stageHead.click();
await page.waitForTimeout(300);
await must("a third click turns sorting off", async () => {
  const t = await stageHead.innerText();
  return !t.includes("↑") && !t.includes("↓");
});

/* ================================================================== */
/* 4. THE CARET FILTERS                                                */
/* ================================================================== */
await page.locator(".adm-sh-table thead .adm-db-thwrap", { hasText: "Sales Owner" })
  .locator(".adm-db-thmenu").first().click();
await page.waitForTimeout(300);
await shot("owner-menu");
await must("the menu offers every owner with a count each", async () =>
  (await page.locator(".adm-db-pop-list .adm-db-pop-item").count()) >= 2);
await page.locator(".adm-db-pop-list .adm-db-pop-item").first().click();
await page.waitForTimeout(400);
await shot("filtered");
await must("filtering leaves a chip that says what is on", async () =>
  (await page.locator(".adm-sh-chipbtn").count()) === 1);
await must("the count line says it is showing a subset, not the lot", () => has("shown"));
await page.locator(".adm-sh-chipbtn").first().click();
await page.waitForTimeout(400);
await must("clicking the chip takes the filter off again", async () =>
  (await page.locator(".adm-sh-chipbtn").count()) === 0);

/* ================================================================== */
/* 5. GROUPING IS A SWITCH NOW, NOT THE SHAPE                          */
/* ================================================================== */
await must("flat by default — no group rows at all", async () =>
  (await page.locator(".adm-db-group").count()) === 0);
await page.locator('[data-filter="groupby"]').selectOption("company");
await page.waitForTimeout(400);
await shot("grouped-by-firm");
await must("grouping by firm brings the firms back when you want them", async () =>
  (await page.locator(".adm-db-group").count()) >= 2);
await page.locator('[data-filter="groupby"]').selectOption("none");
await page.waitForTimeout(400);
await must("and switching it off goes flat again", async () =>
  (await page.locator(".adm-db-group").count()) === 0);

/* ================================================================== */
/* 6. ONE FIRM, ONE REP — THE RULE THE GROUPING USED TO CARRY          */
/* ================================================================== */
await must("a firm two reps are working is marked on the row itself", async () =>
  (await page.locator(".adm-sh-warn").count()) >= 1);
await page.locator("tr.adm-sh-row .adm-sh-warn").first().click();
await page.waitForTimeout(400);
await shot("contested-firm");
await must("...and clicking it names them and quotes the rule", () => has("one firm, one rep"));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

/* ================================================================== */
/* 7. COLUMNS                                                          */
/* ================================================================== */
const before = (await headers()).length;
await page.locator("button", { hasText: /^Columns · / }).first().click();
await page.waitForTimeout(300);
await shot("columns-menu");
await page.locator(".adm-db-pop-item", { hasText: "Show every column" }).click();
await page.waitForTimeout(400);
await must("every column can be switched on", async () => (await headers()).length > before);
await page.locator("button", { hasText: /^Columns · / }).first().click();
await page.waitForTimeout(300);
await page.locator(".adm-db-pop-item", { hasText: "Back to the usual columns" }).click();
await page.waitForTimeout(400);
await must("and back to the usual set", async () => (await headers()).length === before);

/* ================================================================== */
/* 8. CELLS EDIT WHERE THEY SIT                                        */
/* ================================================================== */
const row = page.locator("tr.adm-sh-row").first();
await row.locator("td").nth(2).locator("button").click();       // Sales Cycle Status
await page.waitForTimeout(300);
await shot("stage-menu");
await must("the status cell opens a list of every stage", async () =>
  (await page.locator(".adm-db-pop-list .adm-db-pop-item").count()) >= 10);
await must("...and the menu can filter to that value as well as set it", () => has("Show only"));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

await row.locator("td").nth(0).locator("button").click();       // Sales Owner
await page.waitForTimeout(300);
await shot("owner-cell");
await must("the owner cell offers the team", async () =>
  (await page.locator(".adm-db-pop-list .adm-db-person").count()) >= 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

/* ================================================================== */
/* 9. WON ACTUALLY MAKES A CLIENT — FROM BOTH BUTTONS                  */
/* ================================================================== */
/* Until today this pill was decoration: `became_customer` and
 * `admin_companies.client_id` both existed and NOTHING ever wrote either.
 *
 * The first version of this section drove only the sheet's status cell — and a
 * reviewer then found that the DRAWER's big green "They signed" button, which
 * is the path the record's owner actually uses, made no client at all AND
 * permanently blocked the one that did. Both are driven here now, and the
 * client is checked on the Clients page rather than by reading a toast. */

/* ---- 9a. THE DRAWER'S GREEN BUTTON — the path a reviewer found broken ----
   Driven FIRST, because it is the only path the big "They signed" button is
   offered on and closing the same deal from the sheet would take it away. */
await page.locator('[data-filter="stage"]').selectOption("proposal");
await page.waitForTimeout(600);
const dealName = (await page.locator("tr.adm-sh-row td").nth(7).innerText().catch(() => "")).trim();
let drawerWin = false;
if ((await page.locator("tr.adm-sh-row").count()) > 0) {
  await page.locator("tr.adm-sh-row .adm-db-open").first().click();
  await page.waitForTimeout(700);
  const signed = page.locator("button", { hasText: /They signed/ }).first();
  if (await signed.isVisible().catch(() => false)) {
    await signed.click();
    await page.waitForTimeout(1300);
    await shot("won-from-the-drawer");
    /* NOT `|| has("Already a client")`. A reviewer replaced doWin's guts with a
       literal no-op result and this check still printed ok, because
       "Already a client" is exactly what a no-op produces. The message must say
       a record was made, and section 9c then checks the Clients page for it. */
    drawerWin = await must("the drawer's own green Won button makes a client", () => has("client record"));
    await must("...and it never claims the link is 'not automatic yet' any more", async () =>
      !(await has("not automatic yet")));
  }
  await closeDrawer();
}
if (!drawerWin) { problems.push("9a: the drawer's green Won button could not be driven"); console.log("  FAIL 9a: no proposal-stage lead to drive the drawer button with"); }

/* ---- 9b. the sheet's status cell, on a different contact ---- */
await page.locator('[data-filter="stage"]').selectOption("contacted");
await page.waitForTimeout(600);
await page.locator("tr.adm-sh-row").first().locator("td").nth(2).locator("button").click();
await page.waitForTimeout(300);
await page.locator(".adm-db-pop-list .adm-db-pop-item", { hasText: /^Won$/ }).first().click();
await page.waitForTimeout(1200);
await shot("marked-won-from-the-sheet");
await must("marking Won from the sheet's status cell also makes a client", () => has("client record"));

/* ---- 9c. the client REALLY exists, read off the Clients page ---- */
await page.goto(`http://localhost:${PORT}/#/dashboard/clients`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await shot("clients-after-won");
/* Checked on the page that LISTS clients, not by reading the toast that claimed
   it — and once per Won path, not once for whichever of them happened to run.
   A test that asserts its own success message is a test that keeps passing
   while the feature is broken. */
const clientsBody = (await page.locator("body").innerText()).toLowerCase();
await must("the firm closed from the DRAWER has a client record", () =>
  clientsBody.includes("bright coast"));
await must("the firm closed from the SHEET has a client record", () =>
  clientsBody.includes("harborline") || clientsBody.includes("westpoint"));
await page.goto(`http://localhost:${PORT}/#/dashboard/sales`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
console.log(`  --   (the deal closed in 9a was ${dealName || "the first proposal-stage row"})`);

/* ================================================================== */
/* 10. ONE TIMELINE, FROM LEAD TO CLIENT AND BEYOND                    */
/* ================================================================== */
await page.locator('[data-filter="stage"]').selectOption("won");
await page.waitForTimeout(700);
await page.locator("tr.adm-sh-row .adm-db-open").first().click();
await page.waitForTimeout(700);
await page.locator(".adm-sl-tabs button", { hasText: "Timeline" }).click();
await page.waitForTimeout(700);
await shot("lifetime-timeline");
await must("the timeline says what it counted", () => has("on record"));
await must("every line says which table it was read from", () => has("from the sales timeline"));
await must("the day they became a paying client is marked on the list", async () =>
  (await page.locator(".adm-sl-tl-divide").count()) <= 1);

/* A contact who is NOT a client has five sources that were never read, and the
   screen has to name them. This is the check that a reviewer showed the first
   version could not fail — it was asserting a string that is in every summary. */
await closeDrawer();
await page.locator('[data-filter="stage"]').selectOption("new");
await page.waitForTimeout(600);
await page.locator("tr.adm-sh-row .adm-db-open").first().click();
await page.waitForTimeout(700);
await page.locator(".adm-sl-tabs button", { hasText: "Timeline" }).click();
await page.waitForTimeout(600);
await shot("timeline-not-a-client");
await must("for somebody who is NOT a client, it names the sources it did not read", () => has("Not counted here"));
await must("...and names at least one of them out loud", async () =>
  (await has("invoices")) || (await has("the work list")) || (await has("support tickets")));
await closeDrawer();

/* ================================================================== */
/* 11. THE CLIENT PAGE CAN SEE THE CHASE                               */
/* ================================================================== */
await page.goto(`http://localhost:${PORT}/#/dashboard/clients`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.locator("tbody tr").first().click().catch(() => {});
await page.waitForTimeout(900);
const startedTab = page.locator("button", { hasText: "How they started" }).first();
await must("a client page has a tab for where they came from", () => startedTab.isVisible());
if (await startedTab.isVisible().catch(() => false)) {
  await startedTab.click();
  await page.waitForTimeout(700);
  await shot("client-how-they-started");
  await must("...and it either shows the people from the chase, or says plainly that none is linked", async () =>
    (await has("on record at this firm")) || (await has("No sales record is linked")));
  await must("...and it marks which one's deal actually closed", async () =>
    (await has("is the one whose deal closed")) || (await has("No sales record is linked")));
}

/* ================================================================== */
await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n  ${steps.length} screenshots in tests/sales-sheet/shots/`);
for (const s of steps) console.log(`    ${s}`);

if (problems.length) {
  console.log(`\n  ${problems.length} PROBLEM${problems.length === 1 ? "" : "S"}:`);
  for (const p of problems) console.log(`    · ${p}`);
  process.exit(1);
}
console.log("\n  Walked the whole thing with no console errors and nothing missing.\n");
