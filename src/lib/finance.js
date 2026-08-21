/* Finance data layer — expenses, invoices, payments, finance settings.
 * Aug 20 2026.
 *
 * Same two modes as data.js, and for the same reason:
 *   LIVE    — Supabase keys are set → real admin_ tables, RLS applies.
 *   PREVIEW — no keys → an in-memory sample set so the whole page can be
 *             clicked through before a single key exists. Every result carries
 *             { sample: true } and the page shows a SAMPLE badge.
 *
 * The maths does NOT live here — it is in lib/finance-math.js at the repo
 * root, so the tests and (one day) a server endpoint use the very same rules.
 */

import { getSupabase, isConfigured } from "./supabase.js";
import { invoiceTotals, todayIso, addDays } from "../../lib/finance-math.js";

const live = () => isConfigured();

let seq = 0;
function pid(p) {
  seq += 1;
  return `${p}${seq}-preview`;
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function monthsAgoFirst(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/* ------------------------------------------------------------------ */
/* PREVIEW DATA — believable, and deliberately fake.                   */
/* The vendors are real products we actually use, because a fake cost   */
/* list teaches nobody anything about where money goes.                 */
/* ------------------------------------------------------------------ */

const previewExpenses = [
  { id: "e1", incurred_on: monthsAgoFirst(11), ended_on: null, category: "Software", vendor: "Vercel", description: "Hosting for every client site", amount_cents: 4000, interval: "monthly", client_id: null, counts_toward_cac: false, notes: null, receipt_url: null, created_at: monthsAgoFirst(11) },
  { id: "e2", incurred_on: monthsAgoFirst(11), ended_on: null, category: "Software", vendor: "Supabase", description: "Database for the platform and this console", amount_cents: 2500, interval: "monthly", client_id: null, counts_toward_cac: false, notes: null, receipt_url: null, created_at: monthsAgoFirst(11) },
  { id: "e3", incurred_on: monthsAgoFirst(9), ended_on: null, category: "AI & APIs", vendor: "Anthropic", description: "Claude API — scans, drafts, reports", amount_cents: 24100, interval: "monthly", client_id: null, counts_toward_cac: false, notes: "Moves with how many scans we run.", receipt_url: null, created_at: monthsAgoFirst(9) },
  { id: "e4", incurred_on: daysAgo(6), ended_on: null, category: "Contractors", vendor: "J.M.", description: "Build work — August", amount_cents: 60000, interval: "one_time", client_id: null, counts_toward_cac: false, notes: null, receipt_url: null, created_at: daysAgo(6) },
  { id: "e5", incurred_on: monthsAgoFirst(5), ended_on: null, category: "Ads", vendor: "Google Ads", description: "Search ads — GEO audit offer", amount_cents: 35000, interval: "monthly", client_id: null, counts_toward_cac: true, notes: "This is the spend the cost-per-new-client number divides.", receipt_url: null, created_at: monthsAgoFirst(5) },
  { id: "e6", incurred_on: monthsAgoFirst(11), ended_on: null, category: "Hosting & domains", vendor: "Cloudflare", description: "Domains and DNS", amount_cents: 1800, interval: "monthly", client_id: null, counts_toward_cac: false, notes: null, receipt_url: null, created_at: monthsAgoFirst(11) },
  { id: "e7", incurred_on: monthsAgoFirst(2), ended_on: null, category: "Payment fees", vendor: "Stripe", description: "Card fees, roughly 2.9% + 30¢", amount_cents: 14200, interval: "monthly", client_id: null, counts_toward_cac: false, notes: "Replace with the measured figure once the Stripe key is in.", receipt_url: null, created_at: monthsAgoFirst(2) },
  { id: "e8", incurred_on: daysAgo(21), ended_on: null, category: "Client costs", vendor: "Bright Data", description: "Listing data pull for Lakeside Realty", amount_cents: 8900, interval: "one_time", client_id: "c1", counts_toward_cac: false, notes: null, receipt_url: null, created_at: daysAgo(21) },
  { id: "e9", incurred_on: monthsAgoFirst(7), ended_on: null, category: "Office & admin", vendor: "Google Workspace", description: "Email for the team", amount_cents: 3600, interval: "monthly", client_id: null, counts_toward_cac: false, notes: null, receipt_url: null, created_at: monthsAgoFirst(7) },
  { id: "e10", incurred_on: monthsAgoFirst(4), ended_on: null, category: "Software", vendor: "Cursor", description: "Editor seats", amount_cents: 4000, interval: "monthly", client_id: null, counts_toward_cac: false, notes: null, receipt_url: null, created_at: monthsAgoFirst(4) },
];

const previewInvoices = [
  { id: "i1", number: "AIS-0001", client_id: "c2", bill_to_name: "Harbor Injury Law", bill_to_email: "j@sample.com", bill_to_address: null, status: "paid", issue_date: daysAgo(64), due_date: daysAgo(50), currency: "usd", subtotal_cents: 520000, discount_cents: 0, tax_pct: 0, tax_cents: 0, total_cents: 520000, amount_paid_cents: 520000, notes: null, terms: "Payment due within 14 days of the invoice date.", internal_note: null, sent_at: new Date(Date.now() - 64 * 86400000).toISOString(), paid_at: new Date(Date.now() - 52 * 86400000).toISOString(), stripe_invoice_id: null, hosted_url: null, created_at: daysAgo(64) },
  { id: "i2", number: "AIS-0002", client_id: "c1", bill_to_name: "Lakeside Realty Group", bill_to_email: "dana@sample.com", bill_to_address: null, status: "sent", issue_date: daysAgo(38), due_date: daysAgo(24), currency: "usd", subtotal_cents: 45000, discount_cents: 0, tax_pct: 0, tax_cents: 0, total_cents: 45000, amount_paid_cents: 0, notes: null, terms: "Payment due within 14 days of the invoice date.", internal_note: "Chased once by email.", sent_at: new Date(Date.now() - 38 * 86400000).toISOString(), paid_at: null, stripe_invoice_id: null, hosted_url: null, created_at: daysAgo(38) },
  { id: "i3", number: "AIS-0003", client_id: "c2", bill_to_name: "Harbor Injury Law", bill_to_email: "j@sample.com", bill_to_address: null, status: "sent", issue_date: daysAgo(20), due_date: daysAgo(6), currency: "usd", subtotal_cents: 52000, discount_cents: 0, tax_pct: 0, tax_cents: 0, total_cents: 52000, amount_paid_cents: 20000, notes: null, terms: "Payment due within 14 days of the invoice date.", internal_note: null, sent_at: new Date(Date.now() - 20 * 86400000).toISOString(), paid_at: null, stripe_invoice_id: null, hosted_url: null, created_at: daysAgo(20) },
  { id: "i4", number: "AIS-0004", client_id: "c1", bill_to_name: "Lakeside Realty Group", bill_to_email: "dana@sample.com", bill_to_address: null, status: "sent", issue_date: daysAgo(5), due_date: addDays(new Date(), 9), currency: "usd", subtotal_cents: 45000, discount_cents: 0, tax_pct: 0, tax_cents: 0, total_cents: 45000, amount_paid_cents: 0, notes: null, terms: "Payment due within 14 days of the invoice date.", internal_note: null, sent_at: new Date(Date.now() - 5 * 86400000).toISOString(), paid_at: null, stripe_invoice_id: null, hosted_url: null, created_at: daysAgo(5) },
  { id: "i5", number: "AIS-0005", client_id: "c3", bill_to_name: "Summit Roofing Co", bill_to_email: "mike@sample.com", bill_to_address: null, status: "draft", issue_date: todayIso(), due_date: addDays(new Date(), 14), currency: "usd", subtotal_cents: 150000, discount_cents: 0, tax_pct: 0, tax_cents: 0, total_cents: 150000, amount_paid_cents: 0, notes: "Covers the buildout and the first month.", terms: "Payment due within 14 days of the invoice date.", internal_note: "Do not send until CJ confirms the scope.", sent_at: null, paid_at: null, stripe_invoice_id: null, hosted_url: null, created_at: todayIso() },
];

const previewItems = {
  i1: [{ id: "ii1", invoice_id: "i1", description: "GEO retainer — monthly", qty: 1, unit_cents: 520000, amount_cents: 520000, sort: 0 }],
  i2: [{ id: "ii2", invoice_id: "i2", description: "GEO retainer — monthly", qty: 1, unit_cents: 45000, amount_cents: 45000, sort: 0 }],
  i3: [{ id: "ii3", invoice_id: "i3", description: "GEO retainer — monthly", qty: 1, unit_cents: 52000, amount_cents: 52000, sort: 0 }],
  i4: [{ id: "ii4", invoice_id: "i4", description: "GEO retainer — monthly", qty: 1, unit_cents: 45000, amount_cents: 45000, sort: 0 }],
  i5: [
    { id: "ii5", invoice_id: "i5", description: "Website buildout — 12 pages", qty: 1, unit_cents: 120000, amount_cents: 120000, sort: 0 },
    { id: "ii6", invoice_id: "i5", description: "First month of GEO work", qty: 1, unit_cents: 30000, amount_cents: 30000, sort: 1 },
  ],
};

const previewPayments = {
  i1: [{ id: "ip1", invoice_id: "i1", paid_on: daysAgo(52), amount_cents: 520000, method: "Stripe", reference: "ch_sample1", note: null }],
  i3: [{ id: "ip2", invoice_id: "i3", paid_on: daysAgo(9), amount_cents: 20000, method: "Bank transfer", reference: null, note: "Part payment — the rest on the 1st." }],
};

const previewSettings = {
  id: true,
  company_name: "AI Syndicate",
  company_email: "billing@aisyndicate.com",
  company_address: null,
  invoice_prefix: "AIS-",
  default_terms_days: 14,
  default_tax_pct: 0,
  default_terms_text: "Payment due within 14 days of the invoice date.",
  payment_instructions: "Card link on request, or bank transfer — details on the invoice email.",
  cash_on_hand_cents: 0,
  cash_updated_on: null,
  updated_at: new Date().toISOString(),
};

const store = {
  expenses: [...previewExpenses],
  invoices: [...previewInvoices],
  items: { ...previewItems },
  payments: { ...previewPayments },
  settings: { ...previewSettings },
};

/* ------------------------------------------------------------------ */
/* EXPENSES                                                            */
/* ------------------------------------------------------------------ */

export async function listExpenses({ sinceMonths = 18 } = {}) {
  if (!live()) {
    return { rows: [...store.expenses].sort((a, b) => String(b.incurred_on).localeCompare(String(a.incurred_on))), sample: true };
  }
  const since = new Date();
  since.setMonth(since.getMonth() - sinceMonths, 1);
  const { data, error } = await getSupabase()
    .from("admin_expenses").select("*")
    // A repeating cost that started years ago still runs today, so it must not
    // be filtered out by its start date. Only one-off costs are windowed.
    .or(`incurred_on.gte.${since.toISOString().slice(0, 10)},interval.neq.one_time`)
    .order("incurred_on", { ascending: false })
    .limit(2000);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function upsertExpense(patch) {
  const clean = { ...patch };
  if (clean.amount_cents != null) clean.amount_cents = Math.max(0, Math.round(Number(clean.amount_cents) || 0));
  if (!live()) {
    const now = new Date().toISOString();
    if (clean.id) {
      const i = store.expenses.findIndex((e) => e.id === clean.id);
      if (i < 0) return { ok: false, error: "That cost is gone. Refresh the page." };
      store.expenses[i] = { ...store.expenses[i], ...clean, updated_at: now };
      return { ok: true, row: store.expenses[i], sample: true };
    }
    const row = {
      id: pid("e"), incurred_on: todayIso(), ended_on: null, category: "Other", vendor: null,
      description: null, amount_cents: 0, interval: "one_time", client_id: null,
      counts_toward_cac: false, notes: null, receipt_url: null, created_at: now, updated_at: now, ...clean,
    };
    store.expenses.unshift(row);
    return { ok: true, row, sample: true };
  }
  const sb = getSupabase();
  const q = clean.id
    ? sb.from("admin_expenses").update(clean).eq("id", clean.id).select().maybeSingle()
    : sb.from("admin_expenses").insert(clean).select().maybeSingle();
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: clean.id ? "Nothing was saved — that cost is gone, or your account cannot change it." : "Nothing was saved. Your account may not be allowed to add one." };
  return { ok: true, row: data };
}

export async function deleteExpense(id) {
  if (!live()) {
    const before = store.expenses.length;
    store.expenses = store.expenses.filter((e) => e.id !== id);
    if (store.expenses.length === before) return { ok: false, error: "That cost is already gone." };
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_expenses").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Nothing was removed. Deleting a cost is owners only — ask an owner." };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* INVOICES                                                            */
/* ------------------------------------------------------------------ */

export async function listInvoices() {
  if (!live()) {
    return { rows: [...store.invoices].sort((a, b) => String(b.issue_date).localeCompare(String(a.issue_date))), sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_invoices").select("*")
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function listInvoiceItems(invoiceId) {
  if (!live()) return { rows: [...(store.items[invoiceId] || [])], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_invoice_items").select("*").eq("invoice_id", invoiceId)
    .order("sort", { ascending: true }).order("created_at", { ascending: true });
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

export async function listPayments(invoiceId) {
  if (!live()) return { rows: [...(store.payments[invoiceId] || [])], sample: true };
  const { data, error } = await getSupabase()
    .from("admin_invoice_payments").select("*").eq("invoice_id", invoiceId)
    .order("paid_on", { ascending: false });
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/** Every payment across every invoice, for the collected-this-month figure. */
export async function listAllPayments({ sinceMonths = 18 } = {}) {
  if (!live()) {
    return { rows: Object.values(store.payments).flat(), sample: true };
  }
  const since = new Date();
  since.setMonth(since.getMonth() - sinceMonths, 1);
  const { data, error } = await getSupabase()
    .from("admin_invoice_payments").select("*")
    .gte("paid_on", since.toISOString().slice(0, 10))
    .order("paid_on", { ascending: false }).limit(2000);
  if (error) return { rows: [], error: error.message, sample: false };
  return { rows: data || [], sample: false };
}

/**
 * Save an invoice AND its lines in one call.
 *
 * The totals are worked out here from the lines, never taken from the browser
 * form — a total that disagrees with the lines under it is the single worst bug
 * an invoice can have. The lines are replaced wholesale (delete then insert)
 * because that is what "edit an invoice" means, and matching them up one by one
 * buys nothing on a five-line document.
 */
export async function saveInvoice({ invoice, items }) {
  const totals = invoiceTotals(items, { taxPct: invoice.tax_pct || 0, discountCents: invoice.discount_cents || 0 });
  const head = {
    ...invoice,
    subtotal_cents: totals.subtotalCents,
    discount_cents: totals.discountCents,
    tax_cents: totals.taxCents,
    total_cents: totals.totalCents,
  };
  delete head.amount_paid_cents; // written by the database from the payments
  delete head.paid_at;

  if (!live()) {
    const now = new Date().toISOString();
    let row;
    if (head.id) {
      const i = store.invoices.findIndex((x) => x.id === head.id);
      if (i < 0) return { ok: false, error: "That invoice is gone. Refresh the page." };
      store.invoices[i] = { ...store.invoices[i], ...head, updated_at: now };
      row = store.invoices[i];
    } else {
      row = {
        amount_paid_cents: 0, paid_at: null, sent_at: null, stripe_invoice_id: null,
        hosted_url: null, currency: "usd", status: "draft", created_at: now, updated_at: now,
        ...head, id: pid("i"),
      };
      store.invoices.unshift(row);
    }
    store.items[row.id] = totals.lines.map((l, idx) => ({
      id: pid("ii"), invoice_id: row.id, description: l.description, qty: l.qty,
      unit_cents: l.unit_cents, amount_cents: l.amount_cents, sort: idx,
    }));
    return { ok: true, row, items: store.items[row.id], sample: true };
  }

  const sb = getSupabase();
  const q = head.id
    ? sb.from("admin_invoices").update(head).eq("id", head.id).select().maybeSingle()
    : sb.from("admin_invoices").insert(head).select().maybeSingle();
  const { data, error } = await q;
  if (error) {
    const dup = /duplicate key|unique constraint/i.test(error.message || "");
    return { ok: false, error: dup ? "That invoice number is already used. Change the number and save again." : error.message };
  }
  if (!data) return { ok: false, error: "Nothing was saved. Refresh the page and try again." };

  /* NEW LINES GO IN FIRST, then the old ones come out.
   *
   * The other way round — delete, then insert — leaves the invoice with NO
   * lines at all if the insert fails or the connection drops between the two,
   * while the total on the invoice still reads the old amount. A printed copy
   * would then show an empty table under a real total. Doing it this way, the
   * worst case is an invoice that briefly carries both sets of lines, which is
   * visible and fixable, instead of one that silently carries none. */
  const rows = totals.lines.map((l, idx) => ({
    invoice_id: data.id, description: l.description, qty: l.qty,
    unit_cents: l.unit_cents, amount_cents: l.amount_cents, sort: idx,
  }));
  let inserted = [];
  if (rows.length) {
    const ins = await sb.from("admin_invoice_items").insert(rows).select("id");
    if (ins.error) {
      return { ok: false, error: `The invoice itself saved, but its lines did not: ${ins.error.message}. The old lines are still there — open it and try again.` };
    }
    inserted = (ins.data || []).map((r) => r.id);
  }
  const del = inserted.length
    ? await sb.from("admin_invoice_items").delete().eq("invoice_id", data.id).not("id", "in", `(${inserted.join(",")})`)
    : await sb.from("admin_invoice_items").delete().eq("invoice_id", data.id);
  if (del.error) {
    return { ok: false, error: `The new lines saved but the old ones could not be cleared: ${del.error.message}. Open the invoice and check its lines before sending it.` };
  }
  return { ok: true, row: data, items: rows };
}

/** Mark an invoice sent. Stamps the date, so days-to-pay can be counted later. */
export async function markInvoiceSent(id) {
  const patch = { status: "sent", sent_at: new Date().toISOString() };
  if (!live()) {
    const i = store.invoices.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: "That invoice is gone." };
    store.invoices[i] = { ...store.invoices[i], ...patch };
    return { ok: true, row: store.invoices[i], sample: true };
  }
  const { data, error } = await getSupabase().from("admin_invoices").update(patch).eq("id", id).select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Nothing changed. Refresh the page." };
  return { ok: true, row: data };
}

export async function voidInvoice(id) {
  if (!live()) {
    const i = store.invoices.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: "That invoice is gone." };
    store.invoices[i] = { ...store.invoices[i], status: "void" };
    return { ok: true, row: store.invoices[i], sample: true };
  }
  const { data, error } = await getSupabase().from("admin_invoices").update({ status: "void" }).eq("id", id).select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Nothing changed. Refresh the page." };
  return { ok: true, row: data };
}

export async function deleteInvoice(id) {
  if (!live()) {
    const before = store.invoices.length;
    store.invoices = store.invoices.filter((x) => x.id !== id);
    delete store.items[id];
    delete store.payments[id];
    if (store.invoices.length === before) return { ok: false, error: "That invoice is already gone." };
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_invoices").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Nothing was removed. Deleting an invoice is owners only — cancel it instead." };
  return { ok: true };
}

/**
 * Record money received. The paid total and the paid date on the invoice are
 * written by the database trigger, not here — so a browser that dies half way
 * through cannot leave an invoice claiming to be paid.
 */
export async function addPayment({ invoiceId, amountCents, paidOn, method, reference, note }) {
  const amount = Math.round(Number(amountCents) || 0);
  if (amount <= 0) return { ok: false, error: "Enter how much came in — it has to be more than zero." };
  const row = {
    invoice_id: invoiceId, amount_cents: amount, paid_on: paidOn || todayIso(),
    method: method || null, reference: reference || null, note: note || null,
  };
  if (!live()) {
    const saved = { id: pid("ip"), ...row };
    store.payments[invoiceId] = [saved, ...(store.payments[invoiceId] || [])];
    const i = store.invoices.findIndex((x) => x.id === invoiceId);
    if (i >= 0) {
      const paid = store.payments[invoiceId].reduce((s, p) => s + p.amount_cents, 0);
      const inv = store.invoices[i];
      store.invoices[i] = {
        ...inv,
        amount_paid_cents: paid,
        status: inv.status === "void" ? "void" : (inv.total_cents > 0 && paid >= inv.total_cents ? "paid" : inv.status === "draft" ? "draft" : "sent"),
        paid_at: inv.total_cents > 0 && paid >= inv.total_cents ? new Date(row.paid_on).toISOString() : null,
      };
    }
    return { ok: true, row: saved, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_invoice_payments").insert(row).select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Nothing was saved. Your account may not be allowed to record a payment." };
  return { ok: true, row: data };
}

export async function deletePayment(id, invoiceId) {
  if (!live()) {
    store.payments[invoiceId] = (store.payments[invoiceId] || []).filter((p) => p.id !== id);
    const i = store.invoices.findIndex((x) => x.id === invoiceId);
    if (i >= 0) {
      const inv = store.invoices[i];
      const paid = (store.payments[invoiceId] || []).reduce((s, p) => s + p.amount_cents, 0);
      const fullyPaid = inv.total_cents > 0 && paid >= inv.total_cents;
      /* Same rules as the database trigger in 0007_finance.sql, on purpose: an
       * invoice that drops below its total goes back to sent, a draft stays a
       * draft, a cancelled one stays cancelled. Preview mode that behaves
       * differently from the real thing is a trap, not a preview. */
      store.invoices[i] = {
        ...inv,
        amount_paid_cents: paid,
        status: inv.status === "void" ? "void" : inv.status === "draft" ? "draft" : fullyPaid ? "paid" : "sent",
        paid_at: fullyPaid ? inv.paid_at : null,
      };
    }
    return { ok: true, sample: true };
  }
  const { data, error } = await getSupabase().from("admin_invoice_payments").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Nothing was removed. Deleting a payment is owners only." };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* SETTINGS                                                            */
/* ------------------------------------------------------------------ */

export async function getFinanceSettings() {
  if (!live()) return { row: { ...store.settings }, sample: true };
  const { data, error } = await getSupabase().from("admin_finance_settings").select("*").eq("id", true).maybeSingle();
  /* On a failure this hands back NOTHING, not the sample company details. It
   * used to return the preview row with sample: false, which meant a moment of
   * bad network could print "billing@aisyndicate.com" and the sample payment
   * instructions onto a real invoice — and saving from that screen would write
   * the sample text into the real row. */
  if (error) return { row: null, error: error.message, sample: false };
  // No row means migration 0007 has not been run. Say so rather than crash.
  if (!data) return { row: null, missing: true, sample: false };
  return { row: data, sample: false };
}

export async function saveFinanceSettings(patch) {
  if (!live()) {
    store.settings = { ...store.settings, ...patch, updated_at: new Date().toISOString() };
    return { ok: true, row: { ...store.settings }, sample: true };
  }
  const { data, error } = await getSupabase()
    .from("admin_finance_settings").update(patch).eq("id", true).select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Nothing was saved — run migration 0007 in Supabase first (SETUP.md § Finance)." };
  return { ok: true, row: data };
}
