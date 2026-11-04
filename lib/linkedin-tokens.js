/* One-use links for the client (approval page, PIN page). 4 Nov 2026.
 * The token is 32 random bytes in the link; only its sha256 is stored, so a
 * database read never reveals a working link. */
import { randomBytes, createHash } from "node:crypto";

export function newToken() { return randomBytes(32).toString("base64url"); }
export function hashToken(token) { return createHash("sha256").update(String(token || ""), "utf8").digest("hex"); }
export function looksLikeToken(token) { return /^[A-Za-z0-9_-]{40,60}$/.test(String(token || "")); }

/* The console's public address, for the links. */
export function adminBaseUrl() {
  return String(process.env.ADMIN_BASE_URL || "https://ai-syndicate-admin.vercel.app").replace(/\/+$/, "");
}
