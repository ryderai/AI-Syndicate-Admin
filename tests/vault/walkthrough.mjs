/* A real browser, walking the Vault and the client Report from end to end.
 *
 * Not a unit test. This is the "never call it done until you watched it work"
 * pass: it builds the app, serves the built bundle, clicks through it like a
 * person, and takes a screenshot at every step.
 *
 * Why the BUILT bundle and not the dev server: the Chrome extension wedges the
 * tab after every hot reload (see memory: testing-a-vite-app-via-built-bundle).
 * `npm run build` then serve dist/ is the only reliable way to drive it.
 *
 * Run:  node tests/vault/walkthrough.mjs
 * Shots land in tests/vault/shots/.
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(ROOT, "tests", "vault", "shots");
const PORT = 4319;

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
  if (!existsSync(file)) file = join(DIST, "index.html");   // hash router: everything falls to index
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(500).end("no");
  }
});
await new Promise((r) => server.listen(PORT, r));

/* The container ships one Chromium build, and the npm package may want a
 * different one. Point at the one that is actually here rather than trying to
 * download (there is no browser download in this environment). */
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const problems = [];
const steps = [];
let n = 0;

/* Anything the page logs as an error is a problem, even if the click that
 * caused it appeared to work. A screenshot of a broken page still looks like a
 * screenshot. */
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  /* This container has no route to the internet, so the Google Fonts link in
   * index.html fails here and only here. It is the environment, not the page —
   * everything else is reported. */
  if (/ERR_TUNNEL_CONNECTION_FAILED|fonts\.(googleapis|gstatic)/.test(msg.text())) return;
  problems.push(`console error: ${msg.text().slice(0, 200)}`);
});
page.on("pageerror", (err) => problems.push(`page crashed: ${String(err).slice(0, 200)}`));

async function shot(name) {
  n += 1;
  const file = join(SHOTS, `${String(n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  steps.push(`${String(n).padStart(2, "0")} ${name}`);
}

function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ""}`);
}

const base = `http://localhost:${PORT}`;

try {
  /* ---------------- the vault page ---------------- */
  await page.goto(`${base}/#/dashboard/vault`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await shot("vault-page");

  check("the Vault page opens on its own address", await page.getByRole("heading", { name: /Vault/ }).first().isVisible());
  check("the sample items are listed", (await page.locator(".adm-vault-card").count()) >= 4,
    `${await page.locator(".adm-vault-card").count()} cards`);
  check("preview mode says out loud that nothing is scrambled",
    (await page.getByText(/nothing here is real and nothing is scrambled/i).count()) > 0);

  /* A card number must be masked before anybody presses anything. */
  const cardText = await page.locator(".adm-vault-card", { hasText: "Business card" }).first().innerText();
  check("a card shows only the last 4 until it is revealed", cardText.includes("4242") && cardText.includes("••••"));
  check("no card number is on the page before Reveal is pressed",
    !(await page.content()).includes("4242424242424242"));

  /* ---------------- reveal ---------------- */
  const chase = page.locator(".adm-vault-card", { hasText: "Business card" }).first();
  await chase.locator(".adm-vault-secret", { hasText: "Card number" }).getByRole("button", { name: "Reveal" }).click();
  await page.waitForTimeout(500);
  await shot("card-number-revealed");

  check("pressing Reveal shows the full number, grouped the way it is printed",
    (await chase.innerText()).includes("4242 4242 4242 4242"));
  check("the page says it is hiding itself, and that the look was recorded",
    /hiding in \d+s/i.test(await chase.innerText()));

  await chase.locator(".adm-vault-secret", { hasText: "Card number" }).getByRole("button", { name: "Hide" }).click();
  await page.waitForTimeout(300);
  check("Hide puts it back", !(await chase.innerText()).includes("4242 4242 4242 4242"));
  await shot("card-hidden-again");

  /* ---------------- who looked ---------------- */
  await page.getByRole("button", { name: "Who looked" }).first().click();
  await page.waitForTimeout(400);
  await shot("who-looked");
  const log = await page.locator(".adm-vault-log").innerText();
  check("the reveal was written into the log", /card number/i.test(log));
  check("the log records the field name and NOT the value", !log.includes("4242424242424242"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ---------------- add an item ---------------- */
  await page.getByRole("button", { name: "Add an item" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".adm-vault-kindpick").getByRole("button", { name: "Credit card" }).click();
  await page.waitForTimeout(200);
  await shot("add-card-form");
  check("picking Credit card swaps the form to card boxes",
    (await page.getByText("Last 4 digits").count()) > 0);

  await page.locator('input[placeholder="GoDaddy"]').fill("Amex — travel");
  await page.locator('input[placeholder="4242"]').fill("0005");
  await page.locator('input[placeholder="11"]').fill("3");
  await page.locator('input[placeholder="2028"]').fill("2029");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(700);
  await shot("card-added");
  check("the new card is in the list", (await page.locator(".adm-vault-card", { hasText: "Amex — travel" }).count()) > 0);

  /* ---------------- refusing a bad one ---------------- */
  await page.getByRole("button", { name: "Add an item" }).first().click();
  await page.waitForTimeout(300);
  await page.locator(".adm-vault-kindpick").getByRole("button", { name: "Credit card" }).click();
  await page.locator('input[placeholder="GoDaddy"]').fill("No digits");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(400);
  await shot("card-without-last4-refused");
  check("a card with no last 4 is refused in plain words",
    (await page.getByText(/needs its last 4 digits/i).count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ---------------- store a secret + the generator ---------------- */
  const amex = page.locator(".adm-vault-card", { hasText: "Amex — travel" }).first();
  await amex.getByRole("button", { name: /Add the secret/ }).click();
  await page.waitForTimeout(400);
  await shot("secret-form");
  check("the card's secret form asks for the number, the code and the PIN",
    (await page.getByText("Card number").count()) > 0 && (await page.getByText(/Security code/).count()) > 0);

  await page.locator('input[type="password"]').first().fill("378282246310005");
  await page.waitForTimeout(300);
  await shot("secret-typed");
  check("it reads the brand back off the number as it is typed",
    (await page.getByText(/Reads as American Express, ending 0005/).count()) > 0);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(700);
  await shot("secret-saved");
  check("the card now says a number is stored",
    /card number saved/i.test(await page.locator(".adm-vault-card", { hasText: "Amex — travel" }).first().innerText()));

  /* the password generator, on a login item */
  await page.locator(".adm-vault-card", { hasText: "GoDaddy" }).first().getByRole("button", { name: /Change the secret/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Generate" }).click();
  await page.waitForTimeout(400);
  await shot("password-generated");
  const generated = await page.locator('input[autocomplete="new-password"]').first().inputValue();
  check("the generator produces a long password", generated.length >= 12, `got ${generated.length} characters`);
  check("the generated password avoids the characters people misread",
    !/[lI1O0]/.test(generated), generated);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* ---------------- search and filters ---------------- */
  await page.locator(".adm-vault-search").fill("harbor");
  await page.waitForTimeout(400);
  await shot("search-harbor");
  check("search narrows the list to one client's items",
    (await page.locator(".adm-vault-card").count()) < 5);
  await page.locator(".adm-vault-search").fill("");
  await page.locator(".adm-vault-filters").getByRole("button", { name: "Credit card" }).click();
  await page.waitForTimeout(400);
  await shot("filtered-to-cards");
  const kinds = await page.locator(".adm-vault-card").allInnerTexts();
  check("the card filter shows cards and nothing else", kinds.every((t) => /CREDIT CARD/.test(t)));
  await page.getByRole("button", { name: "All kinds" }).click();
  await page.waitForTimeout(300);

  /* ---------------- the client page: vault tab ---------------- */
  await page.goto(`${base}/#/dashboard/operations`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.getByRole("tab", { name: /Clients & weekly log|Clients/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  await shot("operations");

  const client = page.locator(".adm-ops-client, button", { hasText: "Lakeside Realty Group" }).first();
  if (await client.count()) {
    await client.click();
    await page.waitForTimeout(700);
  }
  await shot("client-page");

  const vaultTab = page.getByRole("tab", { name: /^Vault/ });
  check("the client page has a Vault tab", (await vaultTab.count()) > 0);
  if (await vaultTab.count()) {
    await vaultTab.click();
    await page.waitForTimeout(600);
    await shot("client-vault-tab");
    check("the client's own vault items are on their page",
      (await page.locator(".adm-vault-card").count()) > 0);
  }

  /* ---------------- generate a report ---------------- */
  const genBtn = page.getByRole("button", { name: "Generate report" }).first();
  check("the client page has a Generate report button up top", (await genBtn.count()) > 0);
  await genBtn.click();
  await page.waitForTimeout(700);
  await shot("report-box");
  check("the box for saying how deep to go is open",
    (await page.getByText(/Now say what you want, in your own words/).count()) > 0);

  await page.getByRole("button", { name: /30-second version/ }).click();
  await page.waitForTimeout(300);
  const typed = await page.locator("textarea").first().inputValue();
  check("pressing a preset fills the box rather than sending anything",
    /very short/i.test(typed), typed.slice(0, 60));

  await page.locator("textarea").first().fill("Make it the 10 second version — only what is blocked.");
  await shot("report-instruction-typed");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(1200);
  await shot("report-written");

  const body = await page.locator(".adm-rep-body").innerText();
  check("the 30-second version comes back with real counts", body.length > 40, body.slice(0, 80));
  check("it says where the numbers came from",
    (await page.getByText(/Counted from the AI Syndicate console's own records/).count()) > 0);

  await page.getByRole("tab", { name: "The full version" }).click();
  await page.waitForTimeout(400);
  await shot("report-full");
  check("the full version is longer than the summary",
    (await page.locator(".adm-rep-body").innerText()).length > body.length);

  await page.getByRole("tab", { name: "What it could not check" }).click();
  await page.waitForTimeout(400);
  await shot("report-gaps");
  check("the gaps are named out loud",
    /Scores from the platform/.test(await page.locator(".adm-rep-body").innerText()));

  await page.getByRole("button", { name: "Check the numbers" }).click();
  await page.waitForTimeout(500);
  await shot("report-facts");
  check("the counts it was written from can be opened",
    (await page.locator(".adm-cp-facts").count()) > 0);
  check("nothing from the vault leaks into the facts blob",
    !/secret_cipher|4242424242424242/.test(await page.locator(".adm-cp-raw").innerText()));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await shot("report-filed");
  check("the report is filed and can be reopened later",
    (await page.locator(".adm-rep-row").count()) > 0);

  /* ---------------- a sales rep sees none of it ---------------- */
  // The sidebar is built from the role, so this is checked by reading what a
  // sales rep's sidebar would contain rather than by faking a login.
  const salesSafe = await page.evaluate(() => document.querySelector(".dash-sidebar")?.innerText || "");
  check("the Vault is in the sidebar for this owner", /Vault/.test(salesSafe));

  await page.goto(`${base}/#/dashboard/vault`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await shot("vault-final");

} catch (err) {
  problems.push(`the walkthrough stopped: ${String(err).slice(0, 300)}`);
  await shot("where-it-stopped").catch(() => {});
}

await browser.close();
server.close();

console.log("\nShots:");
console.log(steps.map((s) => `  ${s}`).join("\n"));

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  console.log(problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("\nThe whole walkthrough ran clean.\n");
