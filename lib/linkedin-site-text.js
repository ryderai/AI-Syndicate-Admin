/* The client's homepage as plain text, for the messaging engine. 3 Nov 2026.
 *
 * CJ's brief, Build 1 inputs: "If the website is given, fetch the homepage
 * and pass up to ~2,000 characters of its text as extra context."
 *
 * The URL is typed by a stranger on a public form, so this is careful about
 * WHERE it goes: http(s) only, no IP addresses, no localhost / internal
 * names, standard ports only, a short timeout, a size cap, and at most 3
 * redirects, each re-checked. A failure returns "" — the engine runs fine
 * without it; this is context, never a source of facts (the prompt says so,
 * and the checker counts only form digits as facts). */

import { lookup } from "node:dns/promises";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 600000;
const MAX_CHARS = 2000;

/** True when a URL is safe to fetch from our server. Pure. */
export function safeSiteUrl(input) {
  let u;
  try {
    const raw = String(input || "").trim();
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (u.port && !["80", "443"].includes(u.port)) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return null;                                  // "localhost", "intranet"
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null; // any IPv4/IPv6 literal
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) return null;
  if (/(^|\.)(vercel\.app|supabase\.co|aisyndicate\.com)$/.test(host)) return null; // never our own systems
  return u;
}

/** HTML -> readable text (scripts, styles and tags out, entities decoded,
 * spaces collapsed), cut to MAX_CHARS on a word. Pure. */
export function htmlToText(html = "", max = MAX_CHARS) {
  const text = String(html)
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|header|footer|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).trim();
}

/** True for an address our server must never fetch: loopback, private,
 * link-local (cloud metadata), carrier-grade NAT, multicast, unspecified,
 * and the IPv6 equivalents. Pure. */
export function isPrivateIp(ip = "") {
  const a = String(ip).toLowerCase();
  if (a.includes(":")) {
    if (a === "::" || a === "::1") return true;
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a)) return true;
    const v4 = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return v4 ? isPrivateIp(v4[1]) : false;
  }
  const n = a.split(".").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [x, y] = n;
  return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
    || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19));
}

/* The NAME check above can be beaten by a public name that points at a
 * private address (3 Nov check). So every hop is also resolved, and refused
 * if ANY address it resolves to is private. (A name that changes its answer
 * between this lookup and the fetch can still slip past — the fetch only
 * ever reads a page and keeps 2,000 characters of its text.) */
async function resolvesPublic(host, lookupFn) {
  try {
    const all = await lookupFn(host, { all: true });
    return Array.isArray(all) && all.length > 0 && all.every((r) => !isPrivateIp(r.address));
  } catch { return false; }
}

/** Fetch and reduce. Never throws; "" on any failure. */
export async function fetchSiteText(input, { fetchFn = fetch, lookupFn = lookup } = {}) {
  let url = safeSiteUrl(input);
  if (!url) return "";
  try {
    for (let hop = 0; hop < 4; hop += 1) {
      if (!(await resolvesPublic(url.hostname, lookupFn))) return "";
      const res = await fetchFn(url.toString(), {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (compatible; AISyndicateBot/1.0)", accept: "text/html" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        url = next ? safeSiteUrl(new URL(next, url).toString()) : null;
        if (!url) return "";
        continue;
      }
      if (!res.ok || !/text\/html/i.test(res.headers.get("content-type") || "")) return "";
      const reader = res.body?.getReader?.();
      if (!reader) return htmlToText((await res.text()).slice(0, MAX_BYTES));
      let got = 0; const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length; chunks.push(value);
        if (got >= MAX_BYTES) { reader.cancel().catch(() => {}); break; }
      }
      return htmlToText(new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))));
    }
    return "";
  } catch { return ""; }
}
