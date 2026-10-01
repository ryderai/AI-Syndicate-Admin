/* SAMPLE heat-map rows for the console's preview mode.  30 Sep 2026.
 *
 * When this build has no database keys, the Heat map page still has to show
 * what it WILL look like — so this makes believable, clearly-labelled sample
 * visits. Every screen that uses it prints the SAMPLE badge. Nothing here is
 * a measurement and nothing here is ever sent anywhere.
 *
 * Seeded, so the preview is the same picture every time you open it. */

import { PAGE_SLUGS } from "../../lib/home-services.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* The page, top to bottom: the share of visits that reach each block. */
const LADDER = [
  ["header", 1], ["hero", 1], ["chat", 0.93], ["scan-form", 0.81],
  ["calculator", 0.66], ["offer", 0.55], ["guarantee", 0.36], ["trades", 0.34],
  ["proof", 0.31], ["dashboard", 0.24], ["faq", 0.19], ["footer", 0.15],
];

/* Where people click inside each block: [x‰, y‰, spread‰, weight, label, kind, dead] */
const SPOTS = {
  header: [[930, 500, 30, 2, "What you get", "link", 0], [975, 500, 25, 1, "Results", "link", 0]],
  hero: [[500, 260, 160, 0.8, null, "text", 1]],
  chat: [[500, 450, 250, 1.6, null, "image", 1]],
  "scan-form": [[500, 880, 60, 9, "box-scan", "button", 0], [230, 520, 60, 4, "field:biz", "field", 0], [500, 520, 60, 4, "field:site", "field", 0], [770, 520, 60, 3, "field:email", "field", 0]],
  calculator: [[500, 700, 70, 5, "calc-open", "button", 0]],
  offer: [[500, 930, 60, 6, "price-buy", "link", 0], [500, 420, 280, 0.7, null, "text", 1]],
  guarantee: [[500, 920, 60, 3, "guarantee-buy", "link", 0]],
  trades: [[300, 500, 150, 3, "trade-card", "link", 0], [700, 500, 150, 3, "trade-card", "link", 0]],
  proof: [[250, 300, 90, 1.2, null, "text", 1], [750, 780, 90, 1, "jacob-site", "link", 0]],
  dashboard: [[500, 500, 260, 0.9, null, "image", 1]],
  faq: [[500, 200, 250, 3, "What is AI Pulse?", "button", 0], [500, 420, 250, 2, "Do I have to do the work myself?", "button", 0], [500, 640, 250, 1, "How soon will AI start naming my business?", "button", 0]],
  footer: [[600, 500, 60, 1, "Privacy", "link", 0]],
};

const SOURCES = [["facebook", 0.55], ["google", 0.25], ["", 0.2]];
const CONTENTS = [["ask-chatgpt-photo", 0.5], ["9pm-scene", 0.3], ["money-calc", 0.2]];
const pick = (r, list) => { let x = r(); for (const [v, w] of list) { if ((x -= w) < 0) return v; } return list[list.length - 1][0]; };

let cache = null;

/** { views, clicks, leadSessions } for every page, over the last 45 days. */
export function heatPreviewRows(nowMs = Date.now()) {
  if (cache) return cache;
  const views = [], clicks = [], leadSessions = [];
  PAGE_SLUGS.forEach((slug, pi) => {
    const r = rng(9001 + pi * 131);
    const n = slug === "home-services" ? 520 : slug === "lawn-care" ? 460 : 180 + Math.floor(r() * 160);
    for (let i = 0; i < n; i += 1) {
      const device = r() < 0.62 ? "mobile" : r() < 0.9 ? "desktop" : "tablet";
      const src = pick(r, SOURCES);
      const content = src === "facebook" ? pick(r, CONTENTS) : "";
      const session = `s-${slug}-${i}`;
      const view = `v-${slug}-${i}`;
      const t = nowMs - Math.floor(r() * 45 * 86400000);
      const grit = r();                                // lower = reads further down
      const zones = {};
      let deepest = 0;
      LADDER.forEach(([k, p], idx) => {
        if (k === "trades" && slug !== "home-services") return;
        const got = idx < 2 || grit < p;
        zones[k] = { r: got ? 1 : 0, ms: got ? Math.round((k === "guarantee" || k === "dashboard" ? 900 : 2500) + r() * (k === "offer" ? 14000 : k === "scan-form" ? 9000 : 6000)) : 0 };
        if (got) deepest = idx;
      });
      const lead = zones["scan-form"]?.r && r() < 0.075;
      if (lead) leadSessions.push({ slug, session_id: session });
      const active = Object.values(zones).reduce((s, z) => s + z.ms, 0);
      views.push({
        view_id: view, session_id: session, page_slug: slug, device,
        max_scroll_pct: Math.min(100, Math.round((deepest + 1) / LADDER.length * 100 * (0.9 + r() * 0.1))),
        active_ms: active, zones, utm_source: src || null, utm_content: content || null,
        first_seen_at: new Date(t).toISOString(),
      });
      for (const [k, z] of Object.entries(zones)) {
        if (!z.r) continue;
        for (const [x, y, s, w, label, kind, dead] of SPOTS[k] || []) {
          const tries = lead && label === "box-scan" ? 2 : 1;
          for (let j = 0; j < tries; j += 1) {
            if (r() > w * 0.07) continue;
            const g = () => (r() + r() + r() - 1.5) / 1.5;
            const rage = dead && r() < 0.08;
            clicks.push({
              view_id: view, session_id: session, page_slug: slug, zone: k,
              x_pm: Math.max(0, Math.min(1000, Math.round(x + g() * s))),
              y_pm: Math.max(0, Math.min(1000, Math.round(y + g() * s))),
              target: label, kind, dead: !!dead, rage,
            });
          }
        }
      }
    }
  });
  cache = { views, clicks, leadSessions };
  return cache;
}
