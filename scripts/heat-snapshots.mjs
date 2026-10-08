/* TAKE THE HEAT-MAP PICTURES.  30 Sep 2026.
 *
 * The admin Heat map page draws clicks on a full-length picture of each
 * landing page. aisyndicate.com refuses to be shown inside another site
 * (X-Frame-Options: SAMEORIGIN), so the console cannot show the live page —
 * it shows these pictures instead, and places every click by the SECTION it
 * landed in. So when a page changes, re-take the pictures and every old click
 * moves with its section.
 *
 *   node scripts/heat-snapshots.mjs                      # the live site
 *   node scripts/heat-snapshots.mjs --base http://localhost:8101
 *   node scripts/heat-snapshots.mjs --only lawn-care
 *
 * 30 Sep 2026: the first set was taken from the local build of the landing
 * pages (Home-Services-LP, with the new site.js), because the live site did
 * not have the tracker yet. Re-take from the live site once it is pushed.
 *
 * Needs Playwright (`npm i -D playwright` once, then `npx playwright install
 * chromium`), or set PW_MODULE to a folder that has it.
 *
 * Writes public/heat/<slug>-desktop.jpg, <slug>-mobile.jpg and
 * public/heat/snapshots.json (section boxes, sizes, when taken).
 *
 * Each visit adds ?ais_heat_snapshot=1, which tells the page's tracking to
 * send nothing — a photo is not a visitor.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "heat");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const BASE = String(arg("--base", "https://www.aisyndicate.com")).replace(/\/+$/, "");
const ONLY = arg("--only", null);
/* The address written into snapshots.json. Taking the pictures from a local
 * copy (--base http://localhost:8101) still records the real page address. */
const PUBLIC = String(arg("--public", BASE.startsWith("http://localhost") || BASE.startsWith("http://127.") ? "https://www.aisyndicate.com" : BASE)).replace(/\/+$/, "");

/* Where each page lives. Same slugs as lib/home-services.js PAGE_SLUGS. */
const PAGES = {
  "home-services": "/home-services/",
  "lawn-care": "/home-services/lawn-care/",
  "painting": "/home-services/painting/",
  "pool-cleaning": "/home-services/pool-cleaning/",
  "mobile-detailing": "/home-services/mobile-detailing/",
  "pressure-washing": "/home-services/pressure-washing/",
  "electrical": "/home-services/electrical/",
  "restaurants": "/restaurants/",
  "home-management": "/home-management/",
  "free-ai-score": "/free-ai-score/",
};
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

const req = createRequire(process.env.PW_MODULE ? join(process.env.PW_MODULE, "x.js") : import.meta.url);
const { chromium } = req("playwright");

const exe = process.env.CHROME;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
mkdirSync(OUT, { recursive: true });

const manifestPath = join(OUT, "snapshots.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { pages: {} };
manifest.base = PUBLIC;
manifest.taken_from = BASE;

let made = 0;
for (const [slug, path] of Object.entries(PAGES)) {
  if (ONLY && ONLY !== slug) continue;
  for (const [dev, opts] of Object.entries(DEVICES)) {
    const ctx = await browser.newContext({ ...opts, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const url = `${BASE}${path}?ais_heat_snapshot=1`;
    const r = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch((e) => ({ status: () => `error ${e.message}` }));
    const status = r?.status?.();
    if (status !== 200) { console.log(`  SKIP ${slug} ${dev} — ${url} answered ${status}`); await ctx.close(); continue; }

    /* Walk down the page so anything that appears on scroll has appeared,
     * then back to the top, which is where the picture is measured from. */
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((ok) => setTimeout(ok, 120));
      }
      window.scrollTo(0, 0);
      await new Promise((ok) => setTimeout(ok, 400));
    });

    const layout = await page.evaluate(() => (window.__aisHeat ? window.__aisHeat.layout() : null));
    if (!layout) { console.log(`  SKIP ${slug} ${dev} — the page has no heat tracker (window.__aisHeat). Deploy the new site.js first.`); await ctx.close(); continue; }

    const file = `${slug}-${dev}.jpg`;
    await page.screenshot({ path: join(OUT, file), fullPage: true, type: "jpeg", quality: 62 });
    (manifest.pages[slug] ||= {})[dev] = {
      file, url: `${PUBLIC}${path}`, w: layout.w, h: layout.h, viewport: opts.viewport,
      zones: layout.zones, taken_at: new Date().toISOString(),
    };
    made += 1;
    console.log(`  ok   ${slug} ${dev} — ${layout.w}×${layout.h}, ${Object.keys(layout.zones).length} sections`);
    await ctx.close();
  }
}
await browser.close();
manifest.updated_at = new Date().toISOString();
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n${made} pictures written to public/heat/.`);
