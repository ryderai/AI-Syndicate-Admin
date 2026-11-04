/* Stripe webhook signature check, without the Stripe SDK. 3 Nov 2026.
 *
 * Why not stripe.webhooks.constructEvent: the console's Stripe client needs
 * a secret API key to be built, and this route needs none — only the
 * endpoint's signing secret (STRIPE_LINKEDIN_WEBHOOK_SECRET). Stripe's
 * documented scheme: the Stripe-Signature header carries t=<unix time> and
 * one or more v1=<hex>; v1 = HMAC-SHA256(secret, `${t}.${raw body}`).
 * Compared in constant time; events older than 5 minutes are refused, so a
 * captured request can't be replayed later. Pure apart from the clock. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) return { ok: false, reason: "no_raw_body" };
  const parts = String(header || "").split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v).filter(Boolean);
  if (!Number.isFinite(t) || !sigs.length) return { ok: false, reason: "bad_header" };
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return { ok: false, reason: "too_old" };
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex"), "utf8");
  const match = sigs.some((s) => {
    const given = Buffer.from(s, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** What a Stripe event means for a LinkedIn engagement. Pure.
 * Returns null for events we ignore, else
 * { kind: "first_payment"|"renewal"|"link", liClientId, customerId,
 *   subscriptionId, email, paidAt, amount, priceIds[], paymentLinkId,
 *   periodEnd }.
 *
 *  - checkout.session.completed (the payment link): client_reference_id =
 *    linkedin_clients.id when the link was built with it; payment_link =
 *    which payment link was used. Paid when payment_status = "paid" AND
 *    amount_total > 0 (a $0 trial or 100% coupon is not a payment).
 *  - invoice.paid: billing_reason "subscription_cycle" = a renewal; anything
 *    else (subscription_create, manual) = a first payment. Price ids are read
 *    from the invoice lines (both the older `price` and the newer
 *    `pricing.price_details.price` shapes), so the route can tell a LinkedIn
 *    invoice from any other. periodEnd = when this paid period ends (Build
 *    3/5's renewal date). */
export function readStripeEvent(event) {
  const o = event?.data?.object || {};
  const at = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : new Date().toISOString());
  const idOf = (x) => (typeof x === "string" ? x : x?.id || null);
  if (event?.type === "checkout.session.completed") {
    const amount = Number(o.amount_total) || 0;
    return {
      kind: o.payment_status === "paid" && amount > 0 ? "first_payment" : "link",
      liClientId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(o.client_reference_id || "")) ? o.client_reference_id : null,
      customerId: idOf(o.customer),
      subscriptionId: idOf(o.subscription),
      email: String(o.customer_details?.email || o.customer_email || "").toLowerCase() || null,
      paidAt: at(o.created),
      amount,
      priceIds: [],
      paymentLinkId: idOf(o.payment_link),
      periodEnd: null,
    };
  }
  if (event?.type === "invoice.paid") {
    const lines = Array.isArray(o.lines?.data) ? o.lines.data : [];
    const priceIds = [...new Set(lines.map((l) => idOf(l?.price) || l?.pricing?.price_details?.price || null).filter(Boolean))];
    const ends = lines.map((l) => Number(l?.period?.end)).filter(Number.isFinite);
    const amount = Number(o.amount_paid) || 0;
    const reason = String(o.billing_reason || "");
    return {
      kind: amount <= 0 ? "link" : reason === "subscription_cycle" ? "renewal" : "first_payment",
      liClientId: null,
      customerId: idOf(o.customer),
      subscriptionId: idOf(o.subscription) || o.parent?.subscription_details?.subscription || null,
      email: String(o.customer_email || "").toLowerCase() || null,
      paidAt: at(o.status_transitions?.paid_at || o.created),
      amount,
      priceIds,
      paymentLinkId: null,
      periodEnd: ends.length ? new Date(Math.max(...ends) * 1000).toISOString().slice(0, 10) : null,
    };
  }
  if (event?.type === "invoice.payment_failed") {
    return {
      kind: "payment_failed", liClientId: null, customerId: idOf(o.customer),
      subscriptionId: idOf(o.subscription) || o.parent?.subscription_details?.subscription || null,
      email: String(o.customer_email || "").toLowerCase() || null, paidAt: at(o.created), amount: 0, priceIds: [], paymentLinkId: null, periodEnd: null,
    };
  }
  return null;
}

/** Is this a LinkedIn Outreach payment, by what Stripe says was bought?
 * `ids` = comma lists from the env: LINKEDIN_STRIPE_PRICE_IDS (price_...)
 * and LINKEDIN_STRIPE_PAYMENT_LINK_IDS (plink_...). With neither set,
 * nothing is recognised this way — only client_reference_id and a saved
 * subscription id match a client. Pure. */
export function isLinkedInPurchase(info, { priceIds = "", paymentLinkIds = "" } = {}) {
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const prices = list(priceIds); const links = list(paymentLinkIds);
  if (info?.paymentLinkId && links.includes(info.paymentLinkId)) return true;
  return (info?.priceIds || []).some((p) => prices.includes(p));
}
