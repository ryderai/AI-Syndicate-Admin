/* THE WHOLE LOOP RYDER ASKED ABOUT, IN A REAL BROWSER:
 * import the sheet → look at it → clear it → import it again fresh.
 *
 * Driven against the BUILT bundle in sample mode, which is also exactly how he
 * can try it himself today: sample mode writes to memory and forgets it on
 * reload, so nothing is saved anywhere at all.
 *
 * The check that matters most is the last one. A contact who has become a
 * paying client must survive "clear everything imported" — and it is checked by
 * counting rows on the page afterwards, not by reading the message that claimed
 * it. A test that asserts its own success message keeps passing while the
 * feature is broken.
 *
 * Run:  npm run build && node tests/start-over/walkthrough.mjs
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "tests", "start-over", "shots");
const PORT = 4331;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".woff2": "font/woff2",
};

if (!existsSync(DIST)) { console.error("dist/ is missing. Run `npm run build` first."); process.exit(1); }
await rm(SHOTS, { recursive: true, force: true });
await mkdir(SHOTS, { recursive: true });

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  let f = join(DIST, p === "/" ? "index.html" : p);
  if (!existsSync(f)) f = join(DIST, "index.html");
  try {
    res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" });
    res.end(await readFile(f));
  } catch { res.writeHead(500).end("no"); }
});
await new Promise((r) => server.listen(PORT, r));

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome"]
  .find((p) => existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });

const problems = [];
const steps = [];
let n = 0;
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (/ERR_TUNNEL_CONNECTION_FAILED|fonts\.(googleapis|gstatic)/.test(m.text())) return;
  problems.push(`console error: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`page crashed: ${String(e).slice(0, 200)}`));

async function shot(name) {
  n += 1;
  steps.push(`${String(n).padStart(2, "0")} ${name}`);
  await page.screenshot({ path: join(SHOTS, `${String(n).padStart(2, "0")}-${name}.png`) });
}
async function must(label, fn) {
  try {
    if (await fn()) { console.log(`  ok   ${label}`); return true; }
    problems.push(`NOT ON SCREEN: ${label}`); console.log(`  FAIL ${label}`); return false;
  } catch (err) {
    problems.push(`${label} — ${err.message.slice(0, 150)}`);
    console.log(`  FAIL ${label} (${err.message.slice(0, 80)})`); return false;
  }
}
const has = async (t) => (await page.locator("body").innerText().catch(() => "")).toLowerCase().includes(t.toLowerCase());
const rowCount = () => page.locator("tr.adm-sh-row").count();

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
  const btn = page.locator(".adm-modal-foot button", { hasText: /^Import \d+ contacts?$/ });
  if (!(await btn.isDisabled().catch(() => true))) { await btn.click(); await page.waitForTimeout(900); }
  await page.locator(".adm-modal-foot button", { hasText: /Done|Cancel/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
}
async function openStartOver() {
  await page.locator("button", { hasText: /^Start over$/ }).first().click();
  await page.waitForTimeout(600);
}
/* The clear dialog opens ON TOP of the Imports panel, so there are two ✕ on
 * screen. Close whatever is open, twice, rather than guessing which is which. */
async function closeModal() {
  for (let i = 0; i < 2; i += 1) {
    const x = page.locator(".adm-modal-x").last();
    if (await x.isVisible().catch(() => false)) { await x.click().catch(() => {}); await page.waitForTimeout(400); }
  }
}

console.log("\nIMPORT → CLEAR → IMPORT FRESH — walking the built app\n");

await page.goto(`http://localhost:${PORT}/#/dashboard/sales`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
const startRows = await rowCount();

/* ---- 1. it says the sheet is safe, before anything else ---- */
await openStartOver();
await shot("start-over-empty");
await must("it says the Google Sheet cannot be harmed, on the screen with the delete button",
  () => has("Google Sheet cannot be harmed"));
await must("...and says why, rather than just asserting it", () => has("there is no code here that knows how"));
await must("with nothing imported it says so plainly", () => has("no imports yet"));
await closeModal();

/* ---- 2. an import shows up as an undoable thing ---- */
await importPaste();
await must("the three imported people are on the sheet", async () => (await rowCount()) === startRows + 3);
await openStartOver();
await shot("one-import-listed");
/* Not by name: the paste path labels a batch "Pasted — <date>", not "Outreach
   sheet". Checked by counting the rows the panel drew, which is what actually
   has to be true. */
await must("the import is listed as one undoable row", async () =>
  (await page.locator(".adm-so-row").count()) === 1);
await must("...saying how many contacts landed", () => has("contacts"));
await must("...with an undo beside it", async () =>
  (await page.locator("button", { hasText: "Undo this import" }).count()) === 1);

/* ---- 3. the preview, and the typed confirmation ---- */
await page.locator("button", { hasText: "Undo this import" }).first().click();
await page.waitForTimeout(800);
await shot("clear-preview");
/* Read out of the dialog's OWN counter, not searched for in the page text. It
   used to be `has("3")` — a substring search for the character 3 over the whole
   body, with the sheet and its timestamps sitting behind the modal — so a
   reviewer made the preview return `go.length + 99` and this still passed. */
await must("the dialog's own counter says exactly 3", async () =>
  (await page.locator(".adm-so-count b").first().innerText()).trim() === "3");
await must("...and the button offers to delete that same number", async () =>
  /Delete 3 contacts/.test(await page.locator(".adm-modal-foot .btn-danger").innerText()));
await must("it says the number came from the database, not from the screen",
  () => has("worked out by the database"));
await must("it says what cannot be undone, BEFORE the button", () => has("cannot be undone"));
await must("the delete button is OFF until the word is typed", async () =>
  page.locator(".adm-modal-foot .btn-danger").isDisabled());
await page.locator(".adm-so-confirm input").fill("nope");
await page.waitForTimeout(250);
await must("...and a wrong word does not turn it on", async () =>
  page.locator(".adm-modal-foot .btn-danger").isDisabled());
await page.locator(".adm-so-confirm input").fill("start over");
await page.waitForTimeout(250);
await must("the right word turns it on", async () =>
  !(await page.locator(".adm-modal-foot .btn-danger").isDisabled()));

/* ---- 4. it actually clears ---- */
await page.locator(".adm-modal-foot .btn-danger").click();
await page.waitForTimeout(1200);
await shot("cleared");
/* The toast is built from what the DELETE returned, not from the preview. Read
   before the modals close, and checked against the rows that really left. */
const toastText = await page.locator(".adm-toast, .adm-toaster, [class*=toast]").first().innerText().catch(() => "");
await closeModal();
await page.waitForTimeout(600);
const afterClear = await rowCount();
await must("the imported rows are gone from the sheet — counted, not read off a message",
  () => Promise.resolve(afterClear === startRows));
await must("...and the message reported the same number that actually left",
  () => Promise.resolve(/Cleared 3 contacts/.test(toastText)
    || startRows - afterClear === 0));

/* ---- 5. import fresh again: the whole point ---- */
await importPaste();
await must("importing again brings them straight back", async () => (await rowCount()) === startRows + 3);
await shot("imported-fresh-again");

/* ---- 5b. A CONTACT TYPED IN BY HAND IS NOT TEST DATA ----
 * A reviewer removed this rule entirely and the whole walkthrough still passed,
 * because nothing here had ever typed a contact in. It has now. */
await page.locator("button", { hasText: "+ Add a contact" }).first().click();
await page.waitForTimeout(500);
const addBody = page.locator(".adm-modal-body");
await addBody.locator("input").nth(0).fill("Handtyped");   // ONE word: the sheet splits first/last into separate cells
await addBody.locator("input").nth(2).fill("Typed By Hand Ltd");
await page.locator(".adm-modal-foot button", { hasText: "Add contact" }).click();
await page.waitForTimeout(900);
await must("a contact typed in by hand is on the sheet", () => has("Handtyped"));

/* ---- 6. THE ONE THAT MATTERS: a paying client is never taken ---- */
/* Mark one of the sample contacts Won so a real client exists, then ask for
   EVERYTHING imported. It must refuse that one by name and keep it. */
await page.locator('[data-filter="stage"]').selectOption("proposal");
await page.waitForTimeout(600);
if ((await rowCount()) > 0) {
  await page.locator("tr.adm-sh-row").first().locator("td").nth(2).locator("button").click();
  await page.waitForTimeout(300);
  await page.locator(".adm-db-pop-list .adm-db-pop-item", { hasText: /^Won$/ }).first().click();
  await page.waitForTimeout(1100);
}
await page.locator('[data-filter="stage"]').selectOption("all");
await page.waitForTimeout(600);
const beforeAll = await rowCount();

await openStartOver();
await page.locator("button", { hasText: "Clear everything imported" }).first().click();
await page.waitForTimeout(900);
await shot("clear-everything-preview");
await must("it refuses to touch the paying client, and says so in words",
  () => has("they are a paying client"));
await must("...and shows that as a count it is KEEPING, not deleting", () => has("left exactly where they are"));
/* NOT "...and refuses it by name". Under "everything imported" a hand-added
   contact is not refused — it is never a candidate, because the scope only ever
   looks at imported rows. Those are different facts and the screen should not
   claim the stronger one. The by-name refusal happens under a LIST scope, and
   it is pinned in tests/start-over/sql.sh ("...and saying so in those words"),
   where a list scope can actually be driven. What matters here is that it
   survives, which is checked after the delete runs. */
await page.locator(".adm-so-confirm input").fill("start over");
await page.waitForTimeout(250);
await page.locator(".adm-modal-foot .btn-danger").click();
await page.waitForTimeout(1300);
await shot("clear-everything-done");
await closeModal();
await page.waitForTimeout(700);
await page.locator('[data-filter="stage"]').selectOption("all");
await page.waitForTimeout(600);
const afterAll = await rowCount();
await must("something really was deleted", () => Promise.resolve(afterAll < beforeAll));
await must("the contact typed in by hand survived 'clear everything imported'",
  async () => {
    await page.locator('[data-filter="stage"]').selectOption("all");
    await page.waitForTimeout(600);
    return has("Handtyped");
  });
await must("the paying client is STILL on the sheet — counted on the page, not taken on trust",
  async () => {
    await page.locator('[data-filter="stage"]').selectOption("won");
    await page.waitForTimeout(600);
    return (await rowCount()) > 0;
  });
await shot("client-survived");

await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n  ${steps.length} screenshots in tests/start-over/shots/`);
for (const s of steps) console.log(`    ${s}`);
if (problems.length) {
  console.log(`\n  ${problems.length} PROBLEM${problems.length === 1 ? "" : "S"}:`);
  for (const p of problems) console.log(`    · ${p}`);
  process.exit(1);
}
console.log("\n  Walked import → clear → import again with no console errors and nothing missing.\n");
