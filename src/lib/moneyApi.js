/* The two money pages' reads, with a short memory — 24 Sep 2026.
 *
 * "the loading for these pages is way too long." Two things fix that:
 *   1. The server does the heavy lifting (api/finance-summary.js,
 *      api/ai-cost.js) — a few hundred rows come back, not 51,000.
 *   2. The last answer is kept for this browser tab (sessionStorage). Opening
 *      the page again draws the last numbers at once, marked with how old
 *      they are, while the fresh read runs underneath. Nothing is ever shown
 *      as fresh when it is not: every reply carries `readAt`.
 *
 * sessionStorage, not localStorage: money figures should not sit on a shared
 * computer after the tab is closed.
 */

import { apiFetch } from "./adminApi.js";

const PREFIX = "ais-money-v1:";

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(key, data) {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify(data)); } catch { /* full or blocked — fine */ }
}

/* Cleared on sign-out and when the signed-in person changes — see
 * clearMoneyStorage() in auth.js, which uses this same prefix. */

/**
 * Read an endpoint. `onCached(data)` fires straight away if this tab has an
 * earlier answer; the promise resolves with the fresh one.
 */
async function cachedRead(key, path, { refresh = false, onCached } = {}) {
  if (!refresh && onCached) {
    const hit = readCache(key);
    if (hit) onCached(hit);
  }
  const res = await apiFetch(refresh ? `${path}${path.includes("?") ? "&" : "?"}refresh=1` : path);
  if (res.ok) writeCache(key, res.data);
  return res;
}

export function getFinanceSummary(opts = {}) {
  return cachedRead("finance", "/api/finance-summary", opts);
}

export function getAiCost(range, opts = {}) {
  const q = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  return cachedRead(`ai:${range.from}:${range.to}`, `/api/ai-cost?${q}`, opts);
}

/* One account's closer look (api/ai-account.js). Not kept in sessionStorage:
 * it is read on demand, and the server keeps it for a minute. 25 Sep 2026. */
export function getAiAccount(workspaceId, range, { refresh = false } = {}) {
  const q = `workspace=${encodeURIComponent(workspaceId)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${refresh ? "&refresh=1" : ""}`;
  return apiFetch(`/api/ai-account?${q}`);
}
