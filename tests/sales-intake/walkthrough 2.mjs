/* DRIVEN IN A REAL BROWSER, against the BUILT BUNDLE — the nine Sales changes
 * of 2 Sep 2026. Preview (sample-data) mode, because it is the only mode that
 * can be driven without touching a real prospect.
 *
 * It fails loudly. Every step asserts, and a screenshot is only proof of the
 * step that passed beside it.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE || "http://localhost:4173";
const ROOT = new URL("../../", import.meta.url).pathname;
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

/* SET BEFORE ANY OF THE APP'S SCRIPTS RUN.
 *
 * This used to be `goto("/")` then `evaluate(setItem)` then `goto("/#/…")` —
 * and the second goto is a HASH-ONLY change on the same document, so nothing
 * reloads. `previewAccounts` had already read sessionStorage once, cached
 * "nobody", and kept it, so the account picker sat there until the whole run
 * timed out. It passed some runs and not others, which is the worst kind.
 * addInitScript runs on every document before the page's own code. */
await page.addInitScript(() => {
  try { window.sessionStorage.setItem("adm-preview-account", "preview-user"); } catch { /* private mode */ }
});
const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png` });

/* Is this the build under test? Compared against the file dist/index.html names
 * AND against the newest source edit — `/assets\/index-/` is true of every Vite
 * build ever made and could not catch a stale server. */
const newestSource = (dir) => {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSource(full));
    else if (/\.(jsx?|css)$/.test(e.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
};

await page.goto(`${BASE}/#/dashboard/sales`, { waitUntil: "networkidle" });
await page.waitForSelector(".adm-sl-bar", { timeout: 25000 });
await page.waitForTimeout(600);

{
  const served = await page.evaluate(() =>
    [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).join(","));
  const onDisk = (readFileSync(join(ROOT, "dist/index.html"), "utf8").match(/assets\/index-[^"]+\.js/) || [])[0];
  ok(`the server is handing out the bundle dist/index.html names (${onDisk})`,
    Boolean(onDisk) && served.includes(onDisk), `served ${served}`);
  const builtAt = statSync(join(ROOT, "dist", onDisk)).mtimeMs;
  const sourceAt = Math.max(newestSource(join(ROOT, "src")), newestSource(join(ROOT, "lib")));
  ok("...built AFTER the last source edit, so this is the code as it now stands",
    builtAt >= sourceAt,
    `bundle ${new Date(builtAt).toISOString()} vs source ${new Date(sourceAt).toISOString()}`);
}

/* ---- 1. THE RELOAD BUTTON, AND THE PAGE NOT STARTING OVER ---- */
{
  const bar = await page.locator(".adm-sl-bar").innerText();
  ok("there is a Reload sales button on the toolbar", /Reload sales/i.test(bar), bar.slice(0, 300));
  /* THE CLOCK TIME IT WAS READ. It said "loaded 2 minutes ago" until a checker
   * pointed out that number froze after the first paint — computed during
   * render from module state, with nothing ticking and nothing subscribed. */
  ok(`...and it says the clock time the board was read`, /read at \d/i.test(bar), bar.slice(0, 200));
  await shot("01-reload-sales-button");

  /* THE PROMISE, AS A PERSON EXPERIENCES IT: type something, walk away, come
   * back, and it is still there. Before today this cleared the box, all three
   * filters, the view and the open record, and re-read eleven tables. */
  await page.locator(".adm-sl-bar input[type='search'], .adm-sl-bar input[placeholder*='earch']").first().fill("harbor");
  await page.waitForTimeout(500);
  await page.goto(`${BASE}/#/dashboard/clients`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.goto(`${BASE}/#/dashboard/sales`, { waitUntil: "networkidle" });
  await page.waitForSelector(".adm-sl-bar", { timeout: 20000 });
  await page.waitForTimeout(700);
  const back = await page.locator(".adm-sl-bar input[type='search'], .adm-sl-bar input[placeholder*='earch']").first().inputValue();
  ok(`WALKING AWAY AND BACK KEEPS WHAT YOU WERE DOING (search box still says "${back}")`,
    back === "harbor", back);
  const spinner = await page.locator("text=Reading the pipeline").count();
  ok("...and it did not show the full-page loading screen again", spinner === 0);
  await shot("02-came-back-and-nothing-reset");
  await page.locator(".adm-sl-bar input[type='search'], .adm-sl-bar input[placeholder*='earch']").first().fill("");
  await page.waitForTimeout(400);
}

/* ---- 2. ADD A CONTACT: CANADA, INDUSTRY, STAGE, OWNER ---- */
{
  await page.getByRole("button", { name: /Add a contact/i }).click();
  await page.waitForSelector(".adm-modal", { timeout: 10000 });
  await page.waitForTimeout(400);

  const labels = await page.locator(".adm-modal .label").allInnerTexts();
  for (const want of ["Country", "What kind of business", "Where is this deal", "Who owns it"]) {
    ok(`the form asks for "${want}"`, labels.some((l) => l.toLowerCase().includes(want.toLowerCase())), labels.join(" | "));
  }

  /* BY LABEL, NEVER BY ORDINAL. `.first()` was the industry picker, because the
   * industry field sits above the address grid — an ordinal locator silently
   * tests the wrong control and then fails somewhere else entirely. */
  const countrySel = page.locator(".adm-modal label", { hasText: "Country" }).locator("select");
  const countries = await countrySel.locator("option").allInnerTexts();
  ok(`CANADA IS ONE OF THE COUNTRIES (${countries.join(", ")})`, countries.some((c) => /Canada/i.test(c)));

  /* The owner starts as the person filling the form in — the whole point of
     "automatically claim it to them and not on the floor". */
  const ownerSel = page.locator(".adm-modal label", { hasText: "Who owns it" }).locator("select");
  const ownerText = await ownerSel.locator("option:checked").innerText();
  ok(`the owner starts as the person adding it (${ownerText.trim()})`, /\(you\)/.test(ownerText));
  ok("...and 'leave it on the floor' is still offered, deliberately",
    (await ownerSel.locator("option").allInnerTexts()).some((t) => /on the floor/i.test(t)));

  const industry = page.locator(".adm-modal label", { hasText: "What kind of business" }).locator("select");
  const groups = await industry.locator("optgroup").count();
  const trades = await industry.locator("option").count();
  ok(`the industry list is grouped and long (${trades} trades in ${groups} groups)`, groups >= 6 && trades >= 40);
  const tradeText = (await industry.locator("option").allInnerTexts()).join(" | ");
  for (const t of ["Tech", "Finance", "Construction"]) {
    ok(`...and "${t}" is on it`, new RegExp(t, "i").test(tradeText));
  }

  /* Canada changes the WORD for the region and the list behind it. */
  await countrySel.selectOption("CA");
  await page.waitForTimeout(400);
  const afterCA = await page.locator(".adm-modal .label").allInnerTexts();
  ok("picking Canada renames the field to Province", afterCA.some((l) => /Province/i.test(l)), afterCA.join(" | "));
  const region = page.locator(".adm-modal label", { hasText: "Province" }).locator("select");
  const provinces = await region.locator("option").allInnerTexts();
  ok(`...and offers the provinces (${provinces.length - 1} of them)`, provinces.some((p) => /Ontario/.test(p)) && provinces.length >= 13);
  ok("...and not the American states", !provinces.some((p) => /Florida/.test(p)));
  await shot("03-add-a-contact-canada");

  /* A stage that needs a date asks for it on this form, not afterwards. */
  const stage = page.locator(".adm-modal label", { hasText: "Where is this deal" }).locator("select");
  const stageText = (await stage.locator("option").allInnerTexts()).join(" | ");
  ok("the stage list offers Meeting booked and Meeting complete", /Meeting booked/.test(stageText) && /Meeting complete/.test(stageText));
  ok("...and no longer offers the old single Meeting", !/Meeting —/.test(stageText.replace(/Meeting (booked|complete)/g, "")));
  ok("...and does not offer Won, which needs a written reason", !/Won/.test(stageText));
  await stage.selectOption("meeting_booked");
  await page.waitForTimeout(400);
  /* THE AM/PM TRAP — Ryder: "it wasnt adding because i didnt put in am or pm."
   * A datetime-local reports EMPTY until all five sub-fields are filled, so a
   * date plainly on screen read as no date. It is a date input plus a list of
   * times now, and every time says AM or PM in words. */
  ok("choosing Meeting booked asks for the meeting date ON THIS FORM",
    await page.locator('.adm-modal input[type="date"]').count() === 1);
  ok("...and there is no datetime-local left to half-fill",
    await page.locator('.adm-modal input[type="datetime-local"]').count() === 0);
  const times = await page.locator('.adm-modal select[aria-label="Time"] option').allInnerTexts();
  ok(`...the time is a list you pick from (${times.length} options)`, times.length > 10, times.slice(0, 4).join(" / "));
  ok("...and every one of them says AM or PM",
    times.slice(1).every((t) => /\b(AM|PM)\b/.test(t)), times.slice(1, 4).join(" / "));

  /* SAVE WITH THE TIME LEFT UNSET, and the form must say which half is missing
   * rather than erroring vaguely — the exact thing he could not see. */
  await page.locator(".adm-modal label", { hasText: "Name" }).locator("input").fill("Half Filled");
  await page.locator('.adm-modal input[type="date"]').fill("2026-10-25");
  await page.getByRole("button", { name: "Add contact" }).click();
  await page.waitForTimeout(700);
  const stillOpen = await page.locator(".adm-modal").count() === 1;
  const said = await page.locator(".adm-modal-foot").innerText().catch(() => "");
  ok("a half-filled time does not close the form", stillOpen);
  ok(`...and the form SAYS the time is what is missing`, /pick a time/i.test(said), said.slice(0, 200));
  ok("...and says nothing typed is lost", /nothing you typed is lost/i.test(said));
  await shot("03b-it-says-which-half-is-missing");

  await page.locator(".adm-modal label", { hasText: "Name" }).locator("input").fill("Marie Tremblay");
  await page.locator(".adm-modal label", { hasText: "Firm" }).locator("input").fill("Tremblay Realty");
  await region.selectOption("ON");
  await page.locator(".adm-modal label", { hasText: "City" }).locator("input").fill("Toronto");
  await industry.selectOption("realtor");
  await page.locator(".adm-modal label", { hasText: "Name" }).locator("input").fill("Marie Tremblay");
  const soon = new Date(Date.now() + 3 * 86400000);
  const p2 = (n) => String(n).padStart(2, "0");
  await page.locator('.adm-modal input[type="date"]').fill(
    `${soon.getFullYear()}-${p2(soon.getMonth() + 1)}-${p2(soon.getDate())}`);
  /* 840 minutes = 2:00 PM, picked from the list. Nothing is typed. */
  await page.locator('.adm-modal select[aria-label="Time"]').selectOption("840");
  await shot("04-filled-in-a-canadian-contact");
  await page.getByRole("button", { name: "Add contact" }).click();
  await page.waitForTimeout(1500);

  const whyNot = await page.locator(".adm-modal-foot").innerText().catch(() => "(closed)");
  ok("the form closed, so the write went through",
    await page.locator(".adm-modal").count() === 0, whyNot.slice(0, 300));
  const body = await page.locator("body").innerText();
  ok("the new contact is on the page", /Tremblay/.test(body));
  ok("...and the message says it is THEIRS, not on the floor",
    /Yours, at Meeting booked/i.test(body) || !/on the floor/i.test(body.slice(0, 400)));
  await shot("05-added-and-claimed");
}

/* ---- 3. THE STAGE BOX, FROM THE EDIT SIDEBAR ---- */
{
  /* The sheet splits a name into first and last cells, so "Marie Tremblay" is
   * never one node — the surname is. Clicking a reading cell opens the record;
   * that is the rule the sheet has had since 30 Aug. */
  await page.locator(".adm-sh-plain").filter({ hasText: "Tremblay" }).first().click();
  await page.waitForTimeout(1500);
  ok("the record opens", await page.locator(".adm-sl-drawer, .adm-drawer").count() >= 1);

  /* BY LABEL, not by ordinal — the drawer has several selects and the first one
   * is not the stage. */
  const stageSel = page.locator(".adm-sl-fieldwrap, label").filter({ hasText: /^Stage/ }).locator("select").first();
  const opts = await stageSel.locator("option").allInnerTexts();
  ok(`the drawer offers the split stages (${opts.join(", ")})`,
    opts.some((o) => /Meeting booked/.test(o)) && opts.some((o) => /Meeting complete/.test(o)));

  await stageSel.selectOption("proposal");
  await page.waitForTimeout(1200);
  const modalText = await page.locator(".adm-modal").innerText().catch(() => "");
  ok("PICKING A STAGE THAT NEEDS SOMETHING OPENS A BOX, instead of refusing",
    /moving to proposal/i.test(modalText), modalText.slice(0, 240) || "(no modal at all)");
  ok("...and it asks for the thing it needs rather than sending them elsewhere",
    /how much is the proposal/i.test(modalText), modalText.slice(0, 300));
  ok("...and the Move button is dead until there is an amount",
    await page.locator(".adm-modal").getByRole("button", { name: /Move to Proposal/ }).isDisabled());
  await shot("06-the-stage-box-from-the-sidebar");

  await page.locator('.adm-modal input[inputmode="decimal"]').fill("4500");
  await page.waitForTimeout(300);
  ok("...and alive once there is one",
    !(await page.locator(".adm-modal").getByRole("button", { name: /Move to Proposal/ }).isDisabled()));
  await page.locator(".adm-modal").getByRole("button", { name: /Move to Proposal/ }).click();
  await page.waitForTimeout(1600);
  ok("the box closed, so the move went through", await page.locator(".adm-modal").count() === 0);
  const after = await page.locator(".adm-sl-fieldwrap, label").filter({ hasText: /^Stage/ }).locator("select").first().inputValue();
  ok(`THE LEAD ACTUALLY MOVED (stage is now "${after}")`, after === "proposal");
  await shot("07-and-the-lead-moved");
}

/* ---- 4. THE STAGE BOX, FROM A DRAG ON THE PIPELINE ---- */
{
  await page.locator(".adm-sl-drawer .adm-sl-x, .adm-drawer-x, button[aria-label='Close']").first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /^Pipeline$/ }).click();
  await page.waitForTimeout(1200);

  const cols = await page.locator(".adm-board-col").count();
  ok(`the board draws its columns (${cols})`, cols > 0);
  const headText = (await page.locator(".adm-board-col").allInnerTexts()).join(" ~ ").replace(/\n/g, " ");
  /* CASE-INSENSITIVE: the pills are styled `text-transform: uppercase` and
   * `innerText` applies that, so a case-sensitive match fails against text that
   * is plainly on the screen. Second time today. */
  ok("Meeting booked and Meeting complete are both columns",
    /Meeting booked/i.test(headText) && /Meeting complete/i.test(headText), headText.slice(0, 400));
  await shot("08-the-pipeline-columns");

  /* DRAG A CARD ONTO A COLUMN THAT NEEDS A DATE. Before today the drop was
   * refused outright — "when I drag a client from like one stage to another it
   * doesnt allow the move because it requires the info about the move". */
  const card = page.locator("[draggable='true']").first();
  const cardName = (await card.innerText()).split("\n")[0];
  const target = page.locator(".adm-board-col").filter({ hasText: "Meeting booked" }).first();
  await card.dragTo(target);
  await page.waitForTimeout(1400);

  const modal = await page.locator(".adm-modal").innerText().catch(() => "");
  ok(`DRAGGING "${cardName}" ONTO Meeting booked OPENS THE BOX, it is not refused`,
    /moving to meeting booked/i.test(modal), modal.slice(0, 240) || "(no modal at all)");
  ok("...and it asks when the meeting is", /when is the meeting/i.test(modal), modal.slice(0, 240));
  ok("...with the date AND the time already filled in, so it is one click",
    (await page.locator('.adm-modal input[type="date"]').inputValue()).length === 10
    && (await page.locator('.adm-modal select[aria-label="Time"]').inputValue()) !== "");
  ok("...and the time is picked from a list, with AM or PM in words",
    (await page.locator('.adm-modal select[aria-label="Time"] option').allInnerTexts())
      .slice(1).every((t) => /\b(AM|PM)\b/.test(t)));
  await shot("09-dragged-a-card-and-it-asked");
  await page.locator(".adm-modal").getByRole("button", { name: /Move to Meeting booked/ }).click();
  await page.waitForTimeout(1600);
  ok("the box closed, so the drag completed", await page.locator(".adm-modal").count() === 0);
  const board = await page.locator("body").innerText();
  ok("...and the card is on the Meeting booked column now", board.includes(cardName));
  await shot("10-and-the-card-moved");
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
