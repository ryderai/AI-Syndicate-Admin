/* GET /api/health — which integrations are live vs waiting on a key.
 * Auth: any active console member. Powers the Settings page and the
 * LIVE / WAITING badges across the app. Never returns secret values. */

import { requireMember, isServerConfigured } from "../lib/supabase-server.js";
import { isStripeConfigured } from "../lib/stripe-server.js";
import { hasGoogleClientCredentials } from "../lib/google-oauth.js";
import { isAiConfigured } from "../lib/ai.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!isServerConfigured()) {
    // Even the gate can't run — report everything down so the UI can say so.
    return res.status(200).json({
      supabase: false, stripe: false, gmail: false, ai: false, usageIngest: false,
      platformSso: false, platformAccountSet: false,
      leadGenPlatform: false, leadGenApollo: false, leadScrapeCron: false,
      note: "Supabase env vars are missing on the server.",
    });
  }
  const member = await requireMember(req);
  if (!member) return res.status(401).json({ error: "Not authorized." });

  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({
    supabase: true,
    stripe: isStripeConfigured(),
    gmail: hasGoogleClientCredentials(),
    ai: isAiConfigured(),
    usageIngest: Boolean(process.env.USAGE_INGEST_KEY),
    // The sign-in-to-the-platform button needs the service key, which is the
    // same thing isServerConfigured() checks — and requireMember above only
    // passes when that key works. Two things this canNOT see: whether the
    // target email actually has a platform login, and whether the platform
    // origin is on Supabase's redirect allow-list. Both surface as a plain
    // error on the button itself.
    platformSso: isServerConfigured(),
    platformAccountSet: Boolean((process.env.PLATFORM_ACCOUNT_EMAIL || "").trim()),
    // Lead scraping. Two providers, either of which is enough on its own —
    // the source card on the Leads page says which one it is waiting for.
    leadGenPlatform: Boolean(process.env.PLATFORM_LEADGEN_URL),
    leadGenApollo: Boolean(process.env.APOLLO_API_KEY),
    // Without CRON_SECRET the daily run is closed, not open. Worth reporting,
    // because "the schedule exists" and "the schedule can run" are different
    // facts and only one of them is visible in the Vercel dashboard.
    leadScrapeCron: Boolean(process.env.CRON_SECRET),
    role: member.membership.role,
  });
}
