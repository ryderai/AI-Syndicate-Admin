/* /api/linkedin-stripe-webhook — Stripe tells us a LinkedIn client paid.
 * 3 Nov 2026.
 *
 * CJ's brief, Build 1 trigger: write the copy when the form is submitted
 * AND the first month is paid ("Do not generate on form submission alone").
 * This route only RECORDS the payment (paid_at, Stripe ids, renewal date)
 * and answers Stripe at once; api/linkedin-build-due.js writes the copy.
 * It never writes to Stripe and never sends anything.
 *
 * WEB HANDLER, ON PURPOSE. The signature is over the exact bytes Stripe
 * sent. A classic (req, res) Vercel function hands back an already-parsed
 * JSON body, which can't be verified (3 Nov check — `config.api.bodyParser`
 * is a Next.js setting and does nothing in this Vite project). A Web-style
 * `POST(request)` export gets the untouched body from request.text().
 * PROVE IT after deploy: Stripe Dashboard → the endpoint → "Send test
 * webhook" (invoice.paid) must show 200, not 400.
 *
 * MATCHING A PAYMENT TO A CLIENT — never on email alone:
 *  1. client_reference_id on the checkout = linkedin_clients.id (the payment
 *     link built per client — LinkedIn-Engine-Nov03/PAYMENT-LINK-FIT.md);
 *  2. the Stripe subscription id saved from that checkout (renewals);
 *  3. the payer's email, ONLY when Stripe shows the purchase IS LinkedIn
 *     Outreach: a price in LINKEDIN_STRIPE_PRICE_IDS or the payment link in
 *     LINKEDIN_STRIPE_PAYMENT_LINK_IDS — and exactly one sent form has that
 *     email. AI Syndicate's account also sells AI Pulse and websites; a
 *     LinkedIn client buying one of those must not be marked paid by it.
 * $0 payments never count. No match = logged no_match; an owner can mark a
 * client paid in the console (a manual invoice, as Daniel's on 30 Oct).
 *
 * EACH EVENT ONCE: the event id is claimed by INSERT before anything else
 * (a primary key), so two copies arriving together can't both act. If the
 * work then fails, the claim is removed and Stripe is told 500 to retry.
 *
 * SETUP (Ryder, once): Stripe → Developers → Webhooks → Add endpoint
 * https://ai-syndicate-admin.vercel.app/api/linkedin-stripe-webhook, events
 * checkout.session.completed + invoice.paid + invoice.payment_failed; signing secret → Vercel env
 * STRIPE_LINKEDIN_WEBHOOK_SECRET. Optional: LINKEDIN_STRIPE_PRICE_IDS,
 * LINKEDIN_STRIPE_PAYMENT_LINK_IDS. Needs migration 0051. */

import { getAdminSupabase } from "../lib/supabase-server.js";
import { verifyStripeSignature, readStripeEvent, isLinkedInPurchase } from "../lib/stripe-webhook.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(request) {
  const admin = getAdminSupabase();
  if (!admin) return json(503, { error: "Waiting on the Supabase keys." });

  const raw = await request.text().catch(() => "");
  if (!raw) return json(400, { error: "No body to verify." });
  const check = verifyStripeSignature(raw, request.headers.get("stripe-signature"), process.env.STRIPE_LINKEDIN_WEBHOOK_SECRET);
  if (!check.ok) return json(400, { error: `Signature check failed (${check.reason}).` });

  let event;
  try { event = JSON.parse(raw); } catch { return json(400, { error: "Body is not JSON." }); }
  if (!event?.id) return json(400, { error: "No event id." });

  const claimed = await admin.from("linkedin_stripe_events").insert({ id: event.id, type: event.type || "?", result: "processing" });
  if (claimed.error) {
    if (claimed.error.code !== "23505") return json(500, { error: claimed.error.message });
    /* Seen before. Done = a true repeat. Still "processing" for over 2
     * minutes = the earlier attempt died mid-way (time limit, killed
     * instance): take it over, or the payment would be lost for good
     * (3 Nov fourth check). Still "processing" and fresh = another copy is
     * working on it right now; Stripe gets a 409 and retries later. */
    const staleBefore = new Date(Date.now() - 120000).toISOString();
    const { data: retaken } = await admin.from("linkedin_stripe_events")
      .update({ received_at: new Date().toISOString() })
      .eq("id", event.id).eq("result", "processing").lt("received_at", staleBefore)
      .select("id");
    if (!retaken?.length) {
      const { data: row } = await admin.from("linkedin_stripe_events").select("result").eq("id", event.id).maybeSingle();
      return row?.result === "processing" ? json(409, { error: "Being processed." }) : json(200, { received: true, repeat: true });
    }
  }
  const finish = (result, liClientId = null) => admin.from("linkedin_stripe_events").update({ result, li_client_id: liClientId }).eq("id", event.id);

  try {
    const info = readStripeEvent(event);
    if (!info) { await finish("ignored"); return json(200, { received: true, ignored: true }); }

    const cols = "id, status, paid_at, stripe_customer_id, stripe_subscription_id";
    const flowCols = "flow_stage, period_start, payment_failed_at";
    let client = null;
    if (info.liClientId) client = (await admin.from("linkedin_clients").select(cols).eq("id", info.liClientId).maybeSingle()).data;
    if (!client && info.subscriptionId) client = (await admin.from("linkedin_clients").select(cols).eq("stripe_subscription_id", info.subscriptionId).limit(1).maybeSingle()).data;
    if (!client && info.email && isLinkedInPurchase(info, { priceIds: process.env.LINKEDIN_STRIPE_PRICE_IDS, paymentLinkIds: process.env.LINKEDIN_STRIPE_PAYMENT_LINK_IDS })) {
      /* Exact email, case-insensitive, with LIKE's wildcards escaped. Two
       * sent forms with one email = a person decides. */
      const pattern = info.email.replace(/[\\%_]/g, (c) => `\\${c}`);
      const { data: byEmail } = await admin.from("linkedin_clients").select(cols).ilike("contact_email", pattern).eq("status", "submitted").limit(2);
      if ((byEmail || []).length === 1) client = byEmail[0];
    }
    if (!client) { await finish("no_match"); return json(200, { received: true, matched: false }); }

    /* The flow columns (0052) may not exist yet; read them separately so the
     * payment itself is always recorded. */
    const { data: flow } = await admin.from("linkedin_clients").select(flowCols).eq("id", client.id).maybeSingle();
    const patch = {};
    const flowPatch = {};
    if (info.customerId && !client.stripe_customer_id) patch.stripe_customer_id = info.customerId;
    if (info.subscriptionId && !client.stripe_subscription_id) patch.stripe_subscription_id = info.subscriptionId;
    if (event.type === "invoice.paid" && info.amount > 0) { patch.last_invoice_paid_at = info.paidAt; if (flow?.payment_failed_at) flowPatch.payment_failed_at = null; }
    if (info.kind === "payment_failed" && flow && !flow.payment_failed_at) flowPatch.payment_failed_at = info.paidAt;
    if (info.periodEnd) patch.renewal_date = info.periodEnd;
    let result = "linked";
    if (info.kind === "first_payment" && !client.paid_at) {
      patch.paid_at = info.paidAt;
      patch.paid_source = event.type === "invoice.paid" ? "stripe_invoice" : "stripe_checkout";
      result = "paid";
    } else if (info.kind === "renewal") {
      result = "renewal";
      /* Build 5: "→ Renewed when Stripe's invoice.paid arrives" — only for a
       * client who is running (a paused or churned one isn't revived by a
       * stray invoice), and the next month starts so its reports come due. */
      if (flow && ["live", "report_due", "renewed"].includes(flow.flow_stage)) {
        flowPatch.flow_stage = "renewed";
        flowPatch.renewed_at = info.paidAt;
        if (flow.period_start) {
          const [y, m, d] = flow.period_start.split("-").map(Number);
          flowPatch.period_start = new Date(Date.UTC(y, m - 1, d + 30)).toISOString().slice(0, 10);
          flowPatch.midmonth_due = null;   // the trigger recomputes both from the new period
        }
      }
    } else if (info.kind === "payment_failed") result = "payment_failed";
    if (Object.keys(patch).length) {
      const { error } = await admin.from("linkedin_clients").update(patch).eq("id", client.id);
      if (error) throw new Error(error.message);
    }
    if (Object.keys(flowPatch).length) {
      const { error } = await admin.from("linkedin_clients").update(flowPatch).eq("id", client.id);
      if (error && error.code !== "42703") throw new Error(error.message);   // 42703 = 0052 not run yet: the payment is still saved
    }
    await finish(result, client.id);
    return json(200, { received: true, matched: true, result });
  } catch (err) {
    /* Un-claim so Stripe's retry is processed, then ask for that retry. */
    await admin.from("linkedin_stripe_events").delete().eq("id", event.id);
    return json(500, { error: String(err?.message || "failed").slice(0, 200) });
  }
}
