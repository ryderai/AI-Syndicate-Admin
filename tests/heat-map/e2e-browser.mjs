/* Drives the real landing page in Chromium: scrolls, clicks, waits for a timed
 * send, then closes the tab so the closing beacon fires. Every request for the
 * admin console's /api/* is re-routed to the local harness. */
import { createRequire } from "node:module";
const req = createRequire(process.env.PW_MODULE + "/x.js");
const { chromium } = req("playwright");
const [lpBase, harness] = [process.argv[2], process.argv[3]];

const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function visit(dev, clicks, utm) {
  const ctx = await b.newContext(dev === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const seen = [];
  /* Point the page's API base at the harness itself, so the closing beacon
   * (navigator.sendBeacon, which request routing cannot see) reaches it too. */
  await page.route(/\/page\.js$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text()).replace(/window\.AIS_API_BASE = [^;]*;/, `window.AIS_API_BASE = ${JSON.stringify(harness)};`);
    await route.fulfill({ response: r, body });
  });
  await page.route(/\/api\/hs-(heat|event|lead)/, async (route) => {
    const u = new URL(route.request().url());
    seen.push(u.pathname + " " + route.request().resourceType());
    const rq = route.request();
    const h = await rq.allHeaders();
    const r = await fetch(harness + u.pathname, { method: rq.method(), headers: { origin: h.origin || "", "content-type": h["content-type"] || "text/plain" }, body: ["GET", "HEAD"].includes(rq.method()) ? undefined : rq.postDataBuffer() });
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
  });
  await page.goto(`${lpBase}/home-services/lawn-care/?${utm}`, { waitUntil: "networkidle" });
  await page.mouse.move(200, 200);
  for (let y = 0; y < 5000; y += 400) { await page.mouse.wheel(0, 400); await page.waitForTimeout(350); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  let prev = null;
  for (const sel of clicks) {
    if (sel.startsWith("rage:")) {
      /* Three clicks on one spot inside 0.2 s — what an annoyed person does.
       * Sent as real click events in one go, because this test browser is too
       * slow to fire three mouse clicks inside 0.7 s on its own. */
      await page.evaluate((q) => {
        const el = document.querySelector(q); el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect(), x = r.left + 20, y = r.top + r.height / 2;
        for (let i = 0; i < 3; i += 1) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      }, sel.slice(5));
      continue;
    }
    /* A real mouse click at the element's centre, the way a person clicks.
     * (locator.click waits for the element to stop moving, and the chat
     * picture never stops.) */
    if (sel !== prev) await page.evaluate((q) => document.querySelector(q)?.scrollIntoView({ block: "center", behavior: "instant" }), sel);
    if (sel !== prev) await page.waitForTimeout(900);
    prev = sel;
    const box = await page.evaluate((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel);
    if (!box) { console.log("no element", sel); continue; }
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(sel.includes("h1") ? 120 : 400);
  }
  await page.waitForTimeout(16500);        // one timed send
  await page.close({ runBeforeUnload: true });
  await ctx.close();
  return seen;
}
const a = await visit("desktop", ["#h1", "#h1", "#h1", "#site", "#proof h2", "rage:#proofH", ".hdr-link"], "utm_source=facebook&utm_content=e2e-ad");
const bq = await visit("mobile", ["#chat", "#offer .pay-btn"], "utm_source=google");
console.log("desktop requests:", JSON.stringify(a));
console.log("mobile requests:", JSON.stringify(bq));
await b.close();
