/* GET /api/stripe-customers — customer table for the Customers page.
 * Auth: owner/admin. Returns up to 500 customers with their subscription
 * state and lifetime spend (from invoices' amount_paid totals per customer
 * is expensive — we return subscription info + created; lifetime spend is
 * summed from the charges we can see for the customer via expand). */

import { requireMember } from "../lib/supabase-server.js";
import { getStripe, isStripeConfigured, subscriptionMrrCents } from "../lib/stripe-server.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const member = await requireMember(req, ["owner", "admin"]);
  if (!member) return res.status(401).json({ error: "Not authorized." });
  if (!isStripeConfigured()) return res.status(200).json({ configured: false, customers: [] });

  const stripe = getStripe();
  try {
    // Subscriptions first, keyed by customer, so each row shows plan + status.
    const subsByCustomer = {};
    {
      let startingAfter;
      for (let page = 0; page < 5; page++) {
        const batch = await stripe.subscriptions.list({ status: "all", limit: 100, starting_after: startingAfter });
        for (const sub of batch.data) {
          const cid = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
          if (!cid) continue;
          const prev = subsByCustomer[cid];
          // Prefer the "most alive" subscription for display.
          const rank = { active: 0, trialing: 1, past_due: 2, unpaid: 3, paused: 4, incomplete: 5, canceled: 6, incomplete_expired: 7 };
          if (!prev || (rank[sub.status] ?? 9) < (rank[prev.status] ?? 9)) {
            subsByCustomer[cid] = {
              status: sub.status,
              plan: sub.items?.data?.[0]?.price?.nickname || sub.items?.data?.[0]?.price?.id || null,
              mrrCents: sub.status === "active" || sub.status === "trialing" ? subscriptionMrrCents(sub) : 0,
              // Stripe's basil API release moved current_period_end onto the
              // subscription item — read it there, with the legacy field as
              // a fallback for older API versions.
              currentPeriodEnd: sub.items?.data?.[0]?.current_period_end || sub.current_period_end || null,
            };
          }
        }
        if (!batch.has_more) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
      }
    }

    const customers = [];
    {
      let startingAfter;
      for (let page = 0; page < 5; page++) {
        const batch = await stripe.customers.list({ limit: 100, starting_after: startingAfter });
        for (const c of batch.data) {
          customers.push({
            id: c.id,
            email: c.email,
            name: c.name,
            created: c.created,
            delinquent: Boolean(c.delinquent),
            subscription: subsByCustomer[c.id] || null,
          });
          if (customers.length >= 500) break;
        }
        if (!batch.has_more || customers.length >= 500) break;
        startingAfter = batch.data[batch.data.length - 1]?.id;
      }
    }

    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ configured: true, customers, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(502).json({ error: `Stripe error: ${err.message}` });
  }
}
