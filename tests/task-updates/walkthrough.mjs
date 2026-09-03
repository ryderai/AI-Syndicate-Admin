/* DRIVEN IN A REAL BROWSER, against the BUILT BUNDLE — not the source.
 *
 * Preview (sample-data) mode on purpose: it is the only mode that can be driven
 * without touching a real client's task, and 0029's carried-over row is seeded
 * in the preview store precisely so this walkthrough sees it.
 *
 * It fails loudly. Every step asserts, and a screenshot is only proof of the
 * step that passed beside it.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE || "http://localhost:4173";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

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
const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png`, fullPage: false });

await page.goto(`${BASE}/#/dashboard/work`, { waitUntil: "networkidle" });
/* Wait for a row to exist rather than for a number of milliseconds. A fixed
 * sleep passes on a fast run and fails on a slow one, and then the failure is
 * about the machine rather than about the console. */
await page.waitForSelector(".adm-work-openrow", { timeout: 20000 });
await page.waitForTimeout(400);

/* THE BUNDLE UNDER TEST MUST BE THE ONE BUILT FROM THE SOURCE AS IT NOW STANDS.
 * 31 Aug lost an hour to a stale server that answered 200 for everything, and
 * `/assets\/index-/` — which is what this check used to be — is true of every
 * Vite build ever produced, so it could not have caught that. Two real
 * questions instead: is the server handing out the file dist/index.html names,
 * and was that file built after the last source edit? */
const ROOT = new URL("../../", import.meta.url).pathname;
const served = await page.evaluate(() =>
  [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).join(","));
const onDisk = (readFileSync(join(ROOT, "dist/index.html"), "utf8").match(/assets\/index-[^"]+\.js/) || [])[0];
ok(`the server is handing out the bundle dist/index.html names (${onDisk})`,
  Boolean(onDisk) && served.includes(onDisk), `served ${served}`);

const newestSource = (dir) => {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSource(full));
    else if (/\.(jsx?|css)$/.test(e.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
};
const builtAt = statSync(join(ROOT, "dist", onDisk)).mtimeMs;
const sourceAt = Math.max(newestSource(join(ROOT, "src")), newestSource(join(ROOT, "lib")));
ok("...and that bundle was built AFTER the last source edit, so this is the code as it now stands",
  builtAt >= sourceAt,
  `bundle ${new Date(builtAt).toISOString()} vs newest source ${new Date(sourceAt).toISOString()} — run \`npx vite build\` first`);

await page.getByRole("tab", { name: /Operations/ }).click().catch(() => {});
await page.waitForTimeout(500);
await shot("01-work-page-with-status-chips");

/* ---- 1a. Work and Operations sit together in the menu ----
 * Two views of one table. Measured in the drawn menu, not read off the source —
 * a source check cannot see a heading rendered between them. */
const menu = await page.evaluate(() => {
  const side = document.querySelector("nav, aside") || document.body;
  const links = [...side.querySelectorAll("a, button")]
    .map((el) => ({ text: (el.textContent || "").trim(), top: el.getBoundingClientRect().top }))
    .filter((x) => x.text && x.top > 0)
    .sort((a, b) => a.top - b.top);
  const w = links.findIndex((x) => x.text === "Work");
  const o = links.findIndex((x) => x.text === "Operations");
  return { w, o, between: links.slice(w + 1, o).map((x) => x.text), gap: o >= 0 && w >= 0 ? Math.round(links[o].top - links[w].top) : null };
});
ok("Work and Operations are both in the menu", menu.w >= 0 && menu.o >= 0, JSON.stringify(menu));
ok(`...Operations is the very next thing after Work (nothing between: ${JSON.stringify(menu.between)})`,
  menu.o === menu.w + 1, JSON.stringify(menu));
ok(`...and they are one row apart on screen, not a section apart (${menu.gap}px)`,
  menu.gap !== null && menu.gap <= 70, JSON.stringify(menu));
await shot("01a-work-and-operations-together");

/* ---- 1. four chips on the row, and the one it is in is filled ---- */
const chips = page.locator(".adm-status-chips").first().locator(".adm-status-chip");
ok("the Work page row has four status chips", await chips.count() === 4, `saw ${await chips.count()}`);
const chipText = (await chips.allInnerTexts()).join(" | ");
ok("...labelled To do, In progress, Blocked, Done",
  /To do/.test(chipText) && /In progress/.test(chipText) && /Blocked/.test(chipText) && /Done/.test(chipText), chipText);
const onCount = await page.locator(".adm-status-chips").first().locator(".adm-status-chip.on").count();
ok("exactly one chip is filled in — where the task stands, without reading the heading", onCount === 1, `${onCount} filled`);

/* ---- 1c. THE TOP BAR IS ON THE PAGE, NOT PINNED OVER IT ----
 * Ryder: "i dont like how the top nav stays where it is because it blocks the
 * screen, can that just be a part of the page … so you only see it when youre
 * at the top?" Both directions are checked, because a `position: static` test
 * on its own would also pass on a header that had simply gone missing. */
const headerAtTop = await page.evaluate(() => {
  const h = document.querySelector(".dash-header");
  return { bottom: Math.round(h.getBoundingClientRect().bottom), position: getComputedStyle(h).position };
});
ok(`the top bar is visible at the top of the page (bottom edge ${headerAtTop.bottom}px)`,
  headerAtTop.bottom > 0, JSON.stringify(headerAtTop));
ok("...and it is part of the page, not pinned to the window", headerAtTop.position === "static", headerAtTop.position);

await page.mouse.wheel(0, 400);
await page.waitForTimeout(400);
const headerScrolled = await page.evaluate(() => {
  const h = document.querySelector(".dash-header");
  return { bottom: Math.round(h.getBoundingClientRect().bottom), scrollY: Math.round(window.scrollY) };
});
ok(`...SO IT SCROLLS AWAY: ${headerScrolled.scrollY}px down, its bottom edge moved from ${headerAtTop.bottom} to ${headerScrolled.bottom}`,
  headerScrolled.scrollY > 50 && headerScrolled.bottom < headerAtTop.bottom - 50,
  JSON.stringify({ headerAtTop, headerScrolled }));
ok("...and the sidebar is still there, because that is navigation",
  await page.locator(".dash-sidebar").isVisible());
await shot("01c-the-top-bar-scrolls-with-the-page");

/* ---- 2. MEASURE THE TARGET, then click the furthest corner of it ----
 * The 31 Aug defect was a row that said clickable and had nowhere to click,
 * found by measuring rather than by looking. So measure: the words block must
 * cover the title, the client line AND the report line, and a click on the LAST
 * of those three — the corner a name-only target would have missed — must open
 * the panel. */
const measured = await page.evaluate(() => {
  const btn = document.querySelector(".adm-work-openrow");
  const row = btn.closest("div[style]");
  const report = [...btn.children].pop();
  const b = btn.getBoundingClientRect(), r = row.getBoundingClientRect(), p = report.getBoundingClientRect();
  return {
    lines: btn.children.length,
    hitPct: Math.round((b.width * b.height) / (r.width * r.height) * 100),
    height: Math.round(b.height),
    reportInside: p.top >= b.top - 1 && p.bottom <= b.bottom + 1 && p.left >= b.left - 1,
    reportPoint: { x: Math.round(p.left + p.width / 2), y: Math.round(p.top + p.height / 2) },
    tag: btn.tagName,
  };
});
ok(`the target holds all three lines of the task, not just the title (${measured.lines} lines)`, measured.lines === 3);
ok(`...and the report line is inside it`, measured.reportInside);
ok(`...and it covers most of the row, not one line of it (${measured.hitPct}% of the row's area, ${measured.height}px tall)`,
  measured.hitPct >= 50 && measured.height >= 40, JSON.stringify(measured));
ok(`...and it is a <button> (${measured.tag})`, measured.tag === "BUTTON");

/* First line only — the target now holds three, and the panel title is the name. */
/* A picture of the target, so the hit area is visible and not just measured. */
await page.locator(".adm-work-openrow").first().hover();
await page.waitForTimeout(300);
await shot("01b-the-whole-words-block-is-the-target");

const firstName = (await page.locator(".adm-work-openrow-name").first().innerText()).trim();
/* Clicked at the report line's own coordinates — the bottom of the block, which
 * a title-only target would not have covered. */
await page.mouse.click(measured.reportPoint.x, measured.reportPoint.y);
await page.waitForTimeout(700);
const panel = page.locator(".adm-tp");
ok("clicking the REPORT LINE — the bottom of the words, which the old target missed — opens a panel", await panel.count() === 1);
ok("...over everything, with the page behind it dimmed", await page.locator(".adm-tp-scrim").count() === 1);
const title = await page.locator(".adm-tp-title").inputValue();
ok(`...showing THAT task ("${title}")`, title.trim() === firstName.trim(), `panel: ${title} / row: ${firstName}`);
await shot("02-panel-open-from-the-work-page");

/* ---- 2b. THE PANEL COVERS THE WINDOW, AND THE TOP BAR IS NOT OVER IT ----
 * Ryder: "make the sidebar popup on top so that the top screen thing doesnt
 * cover it." Measured, because the cause was invisible: .dash-content used to
 * keep a leftover `transform` from its page-fade (animation-fill-mode: both),
 * which made it the containing block for `position: fixed` AND a stacking
 * context. The panel came out at top -214px, height 1114, under a header at
 * z-index 20 while its own was 61. */
const layout = await page.evaluate(() => {
  const d = document.querySelector(".adm-tp");
  const h = document.querySelector(".dash-header");
  const c = document.querySelector(".dash-content");
  const r = d.getBoundingClientRect();
  const at = (x, y) => { const e = document.elementFromPoint(x, y); return e ? !!e.closest(".adm-tp") : null; };
  return {
    parentIsBody: d.parentElement === document.body,
    top: Math.round(r.top),
    height: Math.round(r.height),
    viewport: window.innerHeight,
    headerBottom: Math.round(h.getBoundingClientRect().bottom),
    headerPosition: getComputedStyle(h).position,
    contentTransform: getComputedStyle(c).transform,
    panelTopIsThePanel: at(r.left + 40, r.top + 30),
    panelMidIsThePanel: at(r.left + 40, r.top + Math.round(r.height / 2)),
  };
});
ok("the panel is rendered on document.body, so no page wrapper can trap it",
  layout.parentIsBody, JSON.stringify(layout));
ok(`...it starts at the top of the window (top ${layout.top}px)`, layout.top === 0, JSON.stringify(layout));
ok(`...and is exactly the window's height (${layout.height} vs ${layout.viewport})`,
  layout.height === layout.viewport, JSON.stringify(layout));
ok("...and what is drawn at the top of the panel IS the panel, not the page's top bar",
  layout.panelTopIsThePanel === true && layout.panelMidIsThePanel === true, JSON.stringify(layout));
ok("...and the page wrapper no longer keeps a transform, which is what caused both",
  layout.contentTransform === "none", layout.contentTransform);
/* THE TASK NAME IS THE MOST IMPORTANT THING ON THE PANEL, and it was squashed
 * to a 14px sliver in every screenshot taken today without anyone noticing —
 * the panel is a flex column taller than the window, so its children were
 * shrinking. Checked by measurement because it reads as "the top of the panel
 * is cut off" rather than as a sizing bug. */
const nameBox = await page.evaluate(() => {
  const t = document.querySelector(".adm-tp-title");
  const r = t.getBoundingClientRect();
  return { value: t.value, height: Math.round(r.height), needs: t.scrollHeight, fontSize: getComputedStyle(t).fontSize };
});
ok(`the task name is tall enough to actually be read (${nameBox.height}px for ${nameBox.needs}px of text at ${nameBox.fontSize})`,
  nameBox.height >= nameBox.needs, JSON.stringify(nameBox));
ok("...and it is the name of the task that was opened", nameBox.value.trim() === firstName, JSON.stringify(nameBox));
await shot("02b-the-panel-covers-the-window");

/* ---- 3a. a task nobody has reported on says so, rather than showing blank ---- */
await page.locator(".adm-tp").evaluate((el) => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(300);
/* This task has a line and no updates — the exact state ~100 imported Notion
 * tasks are in. It must be shown for what it is, not silently counted as
 * history somebody wrote. */
ok("a line nobody posted is labelled as exactly that", await page.locator(".adm-upd-orphan").count() === 1);
const orphanText = await page.locator(".adm-upd-orphan").innerText();
ok("...and says why there is no date or author on it",
  /no date or author/.test(orphanText), orphanText.slice(0, 200));
await shot("03a-a-line-nobody-posted");

await page.getByRole("button", { name: "Keep it as the first update" }).click();
await page.waitForTimeout(900);
ok("...and one button turns it into a real update", await page.locator(".adm-upd").count() === 1);
ok("...which now carries a name and a date", /Preview Admin|Sample|Admin/.test(await page.locator(".adm-upd-who").first().innerText()));
ok("...and the unposted-line box is gone", await page.locator(".adm-upd-orphan").count() === 0);
await shot("03b-kept-as-the-first-update");

/* ---- 3b. a task that HAS a history shows it ---- */
await page.locator(".adm-tp-x").click();
await page.waitForTimeout(500);
const WITH_HISTORY = "Schema on all listing pages";
await page.locator(".adm-work-openrow").filter({ hasText: WITH_HISTORY }).first().click();
await page.waitForTimeout(800);
const updCount = await page.locator(".adm-upd").count();
ok(`"${WITH_HISTORY}" shows every update ever written on it`, updCount >= 2, `${updCount} updates`);
const newestTag = await page.locator(".adm-upd.newest .adm-upd-tag").first().innerText().catch(() => "");
ok("the newest one is marked as the line the row shows", /on the row/i.test(newestTag), newestTag);
const histText = await page.locator(".adm-upd-list").innerText();
ok("...and the older one is still there — this is what used to be thrown away",
  /Schema template agreed/.test(histText), histText.slice(0, 300));
await page.locator(".adm-tp").evaluate((el) => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(300);
await shot("03c-the-updates-on-this-task");

/* ---- 4. posting an update changes the row behind the panel ---- */
const stamp = `Driven check ${new Date().toISOString().slice(11, 19)} — schema live on 18 of 26 pages.`;
await page.locator('textarea[aria-label="Write an update"]').fill(stamp);
await page.getByRole("button", { name: "Post update" }).click();
await page.waitForTimeout(900);
const top = await page.locator(".adm-upd").first().innerText();
ok("the new update is at the top of the history", top.includes(stamp), top.slice(0, 120));
ok("...and it is the one marked as the line on the row",
  await page.locator(".adm-upd").first().evaluate((el) => el.classList.contains("newest")));
await shot("04-update-posted");

await page.locator(".adm-tp-x").click();
await page.waitForTimeout(600);
ok("the panel closes", await page.locator(".adm-tp").count() === 0);
const rowText = await page.locator(".card").filter({ hasText: WITH_HISTORY }).first().innerText();
ok("THE ROW BEHIND IT NOW SHOWS THE NEW LINE, with no reload",
  rowText.includes(stamp.slice(0, 40)), rowText.slice(0, 300));
await shot("05-the-row-behind-shows-it");

/* ---- 5. status from the row, including back to To do ---- */
const rowChips = page.locator(".card", { hasText: WITH_HISTORY }).first().locator(".adm-status-chip");
await rowChips.filter({ hasText: "Blocked" }).first().click();
await page.waitForTimeout(900);
await shot("06-moved-to-blocked-from-the-row");
const blockedOn = await page.locator(".adm-status-chip.on.s-blocked").count();
ok("a chip on the row moves the task — this one is now Blocked", blockedOn >= 1, `${blockedOn}`);

const todoChips = page.locator(".adm-status-chip.s-todo");
await todoChips.first().click();
await page.waitForTimeout(900);
ok("...and it can go BACK to To do, which the old Start/Blocked/Done row could not do",
  await page.locator(".adm-status-chip.on.s-todo").count() >= 1);
await shot("07-back-to-to-do");

/* ---- 6. rewriting an update leaves a mark ---- */
await page.locator(".adm-work-openrow").filter({ hasText: WITH_HISTORY }).first().click();
await page.waitForTimeout(800);
ok("nothing is marked edited before anything is edited",
  await page.locator(".adm-upd-tag", { hasText: "edited" }).count() === 0);
await page.locator(".adm-upd").first().getByRole("button", { name: "Edit" }).click();
await page.waitForTimeout(300);
await page.locator('textarea[aria-label="Edit this update"]').fill("Rewritten during the driven check.");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(900);
ok("A REWRITTEN UPDATE SAYS SO — a dated record cannot be changed silently",
  await page.locator(".adm-upd-tag", { hasText: "edited" }).count() === 1);
await shot("08-a-rewritten-update-is-marked");
await page.locator(".adm-tp-x").click();
await page.waitForTimeout(500);

/* ---- 7. the same panel on Operations ---- */
await page.goto(`${BASE}/#/dashboard/operations`, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);
const opsName = page.locator(".adm-db-openname").first();
if (await opsName.count()) {
  await opsName.click();
  await page.waitForTimeout(700);
  ok("the SAME panel opens from the Operations table", await page.locator(".adm-tp").count() === 1);
  ok("...with the same four status chips in it", await page.locator(".adm-tp .adm-status-chip").count() === 4);
  ok("...and the same updates history", await page.locator(".adm-tp .adm-upd-new").count() === 1);
  await shot("09-the-same-panel-on-operations");
} else {
  ok("the Operations table rendered a task name to open", false, "no .adm-db-openname found");
  await shot("08-operations-no-rows");
}

/* ---- 8. a line set OUTSIDE the panel is not passed off as an update ----
 * The Operations table's own report cell writes `latest_report` directly, and
 * so do the Notion importer, the task edit box, the note-to-task line and the
 * assistant. The panel cannot stop them; it can refuse to claim its newest
 * update is what everybody else is reading when it is not. */
/* Step 7 left the panel open over the table. */
await page.locator(".adm-tp-x").click().catch(() => {});
await page.waitForTimeout(600);

const strayCell = page.locator(".adm-db-btn").filter({ hasText: "Rewritten during the driven check." }).first();
if (await strayCell.count()) {
  await strayCell.click();
  await page.waitForTimeout(300);
  await page.locator("textarea.adm-db-edit").first().fill("Typed straight into the table, not posted.");
  await page.locator("h1, h2").first().click({ force: true });   // blur commits
  await page.waitForTimeout(900);
  await page.locator(".adm-db-openname").filter({ hasText: WITH_HISTORY }).first().click();
  await page.waitForTimeout(800);
  const drawerText = await page.locator(".adm-tp").innerText();
  ok("THE PANEL SAYS THE ROW'S LINE CAME FROM SOMEWHERE ELSE, instead of claiming an update",
    /not one of these updates/i.test(drawerText), drawerText.slice(-500));
  ok("...and stops badging its newest update as the one on the row",
    await page.locator(".adm-upd-tag", { hasText: "on the row" }).count() === 0);
  await shot("10-the-line-came-from-somewhere-else");
  await page.getByRole("button", { name: "Keep it as an update" }).click();
  await page.waitForTimeout(900);
  ok("...and one button makes the two agree again",
    await page.locator(".adm-upd-tag", { hasText: "on the row" }).count() === 1);
  await shot("11-and-one-button-makes-them-agree");
} else {
  ok("the Operations report cell holding that sentence was found", false,
    "no .adm-db-btn matched — the report column may have moved");
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
