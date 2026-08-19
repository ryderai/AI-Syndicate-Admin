/* Server-side Stripe client for the admin console.
 * Read-only usage: metrics + customer listing. A RESTRICTED key with
 * read-only permissions is enough — see SETUP.md. */

import Stripe from "stripe";

let stripe = null;

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe() {
  if (!isStripeConfigured()) return null;
  if (!stripe) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-04-30.basil",
    });
  }
  return stripe;
}

/** Sum of active subscriptions normalized to monthly recurring revenue, in cents. */
export function subscriptionMrrCents(subscription) {
  let total = 0;
  for (const item of subscription.items?.data || []) {
    const price = item.price;
    if (!price?.unit_amount || !price.recurring) continue;
    const qty = item.quantity || 1;
    let monthly = price.unit_amount * qty;
    const { interval, interval_count: count = 1 } = price.recurring;
    if (interval === "year") monthly = monthly / (12 * count);
    else if (interval === "month") monthly = monthly / count;
    else if (interval === "week") monthly = (monthly * 52) / (12 * count);
    else if (interval === "day") monthly = (monthly * 365) / (12 * count);
    total += monthly;
  }
  return Math.round(total);
}
