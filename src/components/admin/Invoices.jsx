import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { listClients } from "../../lib/data.js";
import { useScreenContext } from "../../lib/screenContext.js";
import {
  listInvoices, listInvoiceItems, listPayments, saveInvoice, markInvoiceSent,
  voidInvoice, deleteInvoice, addPayment, deletePayment, getFinanceSettings, saveFinanceSettings,
} from "../../lib/finance.js";
import {
  SourceBadge, Modal, Field, TextInput, TextArea, Select, EmptyState, fmtMoney, MONEY_RED,
} from "./shared.jsx";
import { Figure, FigureGrid, Block, BasisBadge } from "./financeParts.jsx";
import { InvoiceStatusChip, InvoiceEditor, InvoiceDrawer, invoiceHtml } from "./invoiceParts.jsx";
import {
  effectiveInvoiceStatus, invoiceOutstandingCents, agingBuckets, avgDaysToPay,
  billedVsCollected, nextInvoiceNumber, addDays, todayIso, monthKey, dateOnly, sum,
} from "../../../lib/finance-math.js";

/* ==================================================================
 * INVOICES — raise them, send them, chase them, record the money.
 * Aug 20 2026. Lives under Finance in the sidebar.
 *
 * OURS VS STRIPE'S, because mixing the two would be a mess:
 *   · The list you can edit is OUR invoices, in our own database. An invoice
 *     is a record of what we sent someone, so the client's name and address
 *     are copied onto it when it is made — renaming a client next year must
 *     not rewrite an invoice that is already in someone's hands.
 *   · The second tab is Stripe's own invoices, READ ONLY. This console never
 *     writes to Stripe. They are here so a subscription charge and a hand-made
 *     invoice can be seen in one place without one pretending to be the other.
 *
 * STATUSES: only four are stored — draft, sent, paid, cancelled. "Overdue" and
 * "Part paid" are worked out from the due date and the payments on record, so
 * nobody has to remember to change anything.
 * ================================================================== */

const FILTERS = [
  ["all", "All"],
  ["unpaid", "Owed to us"],
  ["overdue", "Overdue"],
  ["draft", "Drafts"],
  ["paid", "Paid"],
  ["void", "Cancelled"],
];

export default function Invoices({ member }) {
  const [rows, setRows] = useState({ rows: [], sample: true });
  const [clients, setClients] = useState({ rows: [], sample: true });
  const [settings, setSettings] = useState(null);
  // loading | ok | missing | error — so the red banner cannot flash up during
  // the first fetch, when "not loaded yet" is not the same as "failed".
  const [settingsState, setSettingsState] = useState("loading");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("ours"); // ours | stripe
  const [stripeInv, setStripeInv] = useState(null);
  const [stripeState, setStripeState] = useState("loading");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);       // { invoice, items }
  const [openInvoice, setOpenInvoice] = useState(null); // the drawer
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    const [inv, cl, st] = await Promise.all([listInvoices(), listClients(), getFinanceSettings()]);
    setRows(inv);
    setClients(cl);
    setSettings(st.row);
    setSettingsState(st.missing ? "missing" : st.error ? "error" : "ok");
    if (st.missing) toast.warn("Finance tables are not in the database yet", "Run supabase/migrations/0007_finance.sql — SETUP.md § Finance.");
    else if (st.error) toast.error("Couldn't read the invoice settings", `${st.error} — printing is switched off until it loads.`);
    if (!isConfigured()) { setStripeInv(null); setStripeState("sample"); return; }
    const res = await apiFetch("/api/stripe-finance");
    if (res.ok && res.data.configured) { setStripeInv(res.data.invoices || []); setStripeState("live"); }
    else { setStripeInv([]); setStripeState("waiting"); }
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const all = useMemo(() => rows.rows || [], [rows]);

  const totals = useMemo(() => {
    const live = all.filter((x) => x.status !== "void");
    const overdue = live.filter((x) => effectiveInvoiceStatus(x) === "overdue");
    const thisMonth = monthKey(new Date());
    // dateOnly first: paid_at is stamped by the database as a DATE at midnight
    // UTC, and reading that through new Date() in Chicago moves an invoice paid
    // on the 1st into the month before.
    const paidThisMonth = all.filter((x) => x.paid_at && monthKey(dateOnly(x.paid_at)) === thisMonth);
    return {
      outstanding: sum(live, invoiceOutstandingCents),
      overdueCents: sum(overdue, invoiceOutstandingCents),
      overdueCount: overdue.length,
      drafts: all.filter((x) => x.status === "draft").length,
      draftCents: sum(all.filter((x) => x.status === "draft"), (x) => x.total_cents),
      paidThisMonth: sum(paidThisMonth, (x) => x.total_cents),
      paidCount: paidThisMonth.length,
      aging: agingBuckets(all),
      days: avgDaysToPay(all),
      collected: billedVsCollected(all),
    };
  }, [all]);

  const shown = useMemo(() => {
    let list = all;
    if (filter === "unpaid") list = list.filter((x) => invoiceOutstandingCents(x) > 0);
    else if (filter === "overdue") list = list.filter((x) => effectiveInvoiceStatus(x) === "overdue");
    else if (filter === "draft") list = list.filter((x) => x.status === "draft");
    else if (filter === "paid") list = list.filter((x) => effectiveInvoiceStatus(x) === "paid");
    else if (filter === "void") list = list.filter((x) => x.status === "void");
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((x) => `${x.number} ${x.bill_to_name} ${x.bill_to_email || ""}`.toLowerCase().includes(needle));
    }
    return list;
  }, [all, filter, q]);

  /* What the assistant may see here. Invoice NUMBERS and states, never
   * amounts — same rule as the Finance page: the shape of the page travels,
   * the ledger does not. It reads the real rows itself under the role gate in
   * lib/brain-context.js if it needs a figure. */
  useScreenContext(() => ({
    page: "Invoices",
    label: `${shown.length} of ${all.length} invoices shown${filter !== "all" ? `, filtered to ${filter}` : ""}`,
    record: openInvoice
      ? { type: "invoice", id: openInvoice.id, label: `${openInvoice.number} for ${openInvoice.bill_to_name}` }
      : null,
    visible: shown.slice(0, 20).map((x) => `${x.number} — ${x.bill_to_name} (${effectiveInvoiceStatus(x)})`),
  }), [shown, all.length, filter, openInvoice]);

  /* ---- actions ---- */

  const newInvoice = () => {
    const prefix = settings?.invoice_prefix || "AIS-";
    const terms = settings?.default_terms_days ?? 14;
    setEditing({
      invoice: {
        number: nextInvoiceNumber(all, { prefix }),
        client_id: "",
        bill_to_name: "",
        bill_to_email: "",
        bill_to_address: "",
        status: "draft",
        issue_date: todayIso(),
        due_date: addDays(new Date(), terms),
        currency: "usd",
        tax_pct: settings?.default_tax_pct || 0,
        discount_cents: 0,
        notes: "",
        terms: settings?.default_terms_text || "",
        internal_note: "",
      },
      items: [{ description: "", qty: 1, unit_cents: 0 }],
    });
    setEditorOpen(true);
  };

  const editInvoice = async (inv) => {
    const items = await listInvoiceItems(inv.id);
    setEditing({ invoice: { ...inv }, items: items.rows.length ? items.rows : [{ description: "", qty: 1, unit_cents: 0 }] });
    setEditorOpen(true);
  };

  const onSaved = async (payload) => {
    const res = await saveInvoice(payload);
    if (!res.ok) { toast.error("Not saved", res.error); return false; }
    toast.success(payload.invoice.id ? "Invoice updated" : `Invoice ${res.row.number} created`, "It is a draft until you mark it sent.");
    setEditorOpen(false);
    setEditing(null);
    await load();
    if (openInvoice?.id === res.row.id) setOpenInvoice(res.row);
    return true;
  };

  const doMarkSent = async (inv) => {
    const res = await markInvoiceSent(inv.id);
    if (!res.ok) { toast.error("Not changed", res.error); return; }
    toast.success(`${inv.number} marked sent`, "The clock for days-to-pay starts now.");
    setOpenInvoice(res.row);
    load();
  };

  const doVoid = async (inv) => {
    const res = await voidInvoice(inv.id);
    if (!res.ok) { toast.error("Not changed", res.error); return; }
    toast.success(`${inv.number} cancelled`, "It stays on record, out of every total.");
    setOpenInvoice(res.row);
    load();
  };

  const doDelete = async (inv) => {
    const res = await deleteInvoice(inv.id);
    if (!res.ok) { toast.error("Not removed", res.error); return; }
    toast.success("Invoice removed", null);
    setOpenInvoice(null);
    load();
  };

  const doPayment = async (inv, payment) => {
    const res = await addPayment({ invoiceId: inv.id, ...payment });
    if (!res.ok) { toast.error("Not saved", res.error); return false; }
    toast.success("Payment recorded", "The invoice total updates itself.");
    await load();
    return true;
  };

  const doRemovePayment = async (inv, paymentId) => {
    const res = await deletePayment(paymentId, inv.id);
    if (!res.ok) { toast.error("Not removed", res.error); return false; }
    await load();
    return true;
  };

  /* Open a clean, printable copy in a new tab. A blob URL rather than
   * document.write, because document.write into an opened window is blocked in
   * some browsers and silently does nothing — a print button that quietly fails
   * is worse than no print button. */
  const printInvoice = async (inv) => {
    /* No settings, no printing. A printed invoice carries our name, our billing
     * email and how to pay us; sending one with those fields empty or guessed is
     * worse than not printing at all. */
    if (settingsBroken) {
      toast.error("Not printing this yet", "The invoice settings could not be read, so our own details would be missing. Hit Refresh and try again.");
      return;
    }
    const items = await listInvoiceItems(inv.id);
    const html = invoiceHtml(inv, items.rows, settings || {});
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const w = window.open(url, "_blank", "noopener");
    if (!w) toast.warn("Your browser blocked the new tab", "Allow pop-ups for this site, then press Print again.");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const badge = <BasisBadge basis={rows.sample ? "sample" : "typed"} />;
  // A settings read that failed hands back nothing rather than sample details.
  // "Still loading" is not "failed", and "the migration has not been run" gets
  // its own wording — one red banner that says the wrong thing teaches people
  // to ignore red banners.
  const settingsBroken = isConfigured() && (settingsState === "error" || settingsState === "missing");

  return (
    <>
      {settingsBroken && (
        <div className="card adm-fin-callout" style={{ margin: 0, borderColor: MONEY_RED }}>
          {settingsState === "missing" ? (
            <>
              <strong style={{ color: MONEY_RED }}>The finance tables are not in the database yet.</strong>{" "}
              Nothing here saves and nothing prints until{" "}
              <code style={{ fontFamily: "var(--mono)" }}>supabase/migrations/0007_finance.sql</code> has been
              run in the Supabase SQL editor. The clicks are in SETUP.md § Finance — it takes about a minute.
            </>
          ) : (
            <>
              <strong style={{ color: MONEY_RED }}>The invoice settings did not load.</strong> Our own name,
              billing email and payment instructions are missing, so printing is switched off until they come
              back — nothing goes out with the wrong details on it. Press Refresh at the top of the page.
            </>
          )}
        </div>
      )}
      {/* ---- the numbers at the top ---- */}
      <FigureGrid min={200}>
        <Figure label="Owed to us" value={fmtMoney(totals.outstanding)} basis={rows.sample ? "sample" : "typed"}
          means="Everything sent and not fully paid." />
        <Figure label="Overdue" value={fmtMoney(totals.overdueCents)} basis={rows.sample ? "sample" : "typed"}
          tone={totals.overdueCount ? MONEY_RED : undefined}
          sub={`${totals.overdueCount} invoice${totals.overdueCount === 1 ? "" : "s"} past the due date`}
          means="Money we should already have." />
        <Figure label="Paid this month" value={fmtMoney(totals.paidThisMonth)} basis={rows.sample ? "sample" : "typed"}
          sub={`${totals.paidCount} invoice${totals.paidCount === 1 ? "" : "s"}`}
          means="Invoices that were fully settled this calendar month." />
        <Figure label="Sitting in drafts" value={fmtMoney(totals.draftCents)} basis={rows.sample ? "sample" : "typed"}
          sub={`${totals.drafts} draft${totals.drafts === 1 ? "" : "s"}`}
          means="Written but never sent. Nobody can pay these." />
        <Figure label="Average days to pay" value={totals.days.days != null ? `${totals.days.days.toFixed(0)} days` : null}
          basis={rows.sample ? "sample" : totals.days.basis} why="No invoice has been marked paid yet, so there is nothing to average."
          means="From the day an invoice is sent to the day it is fully paid." />
      </FigureGrid>

      {/* ---- toolbar ---- */}
      <div className="card adm-fin-toolbar">
        <div className="aia-tabs" role="tablist" aria-label="Which invoices" style={{ padding: 4 }}>
          <button role="tab" aria-selected={tab === "ours"} className={`aia-tab ${tab === "ours" ? "active" : ""}`} onClick={() => setTab("ours")} style={{ padding: "7px 13px", fontSize: 12.5 }}>
            Ours · {all.length}
          </button>
          <button role="tab" aria-selected={tab === "stripe"} className={`aia-tab ${tab === "stripe" ? "active" : ""}`} onClick={() => setTab("stripe")} style={{ padding: "7px 13px", fontSize: 12.5 }}>
            From Stripe · {stripeInv ? stripeInv.length : "—"}
          </button>
        </div>
        {tab === "ours" && (
          <>
            <div style={{ flex: "1 1 200px", minWidth: 160 }}>
              <TextInput placeholder="Search number, client or email…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="adm-input" style={{ width: 150 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
              {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {badge}
          <button className="btn btn-sm" onClick={() => setSettingsOpen(true)} disabled={settingsBroken} title={settingsBroken ? "The settings could not be read — refresh first" : undefined}>Invoice settings</button>
          <button className="btn btn-primary btn-sm" onClick={newInvoice}>+ New invoice</button>
        </div>
      </div>

      {/* ---- ours ---- */}
      {tab === "ours" && (shown.length ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th style={{ textAlign: "right" }}>Still owed</th>
                  <th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((inv) => {
                  const st = effectiveInvoiceStatus(inv);
                  const owed = invoiceOutstandingCents(inv);
                  return (
                    <tr key={inv.id}>
                      <td style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{inv.number}</td>
                      <td>
                        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{inv.bill_to_name}</div>
                        {inv.bill_to_email && <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{inv.bill_to_email}</div>}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{inv.issue_date}</td>
                      <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11, color: st === "overdue" ? MONEY_RED : undefined }}>{inv.due_date || "—"}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(inv.total_cents)}</td>
                      <td style={{ textAlign: "right", color: owed ? MONEY_RED : "var(--ink-faint)" }}>{owed ? fmtMoney(owed) : "—"}</td>
                      <td><InvoiceStatusChip status={st} /></td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button className="btn btn-sm" onClick={() => setOpenInvoice(inv)}>Open</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState
          icon="§"
          title={all.length ? "No invoices match that filter" : "No invoices yet"}
          body={all.length ? "Clear the search box or set the filter back to All." : "Make the first one. It saves as a draft, so nothing goes anywhere until you say so."}
          action={all.length
            ? <button className="btn" onClick={() => { setQ(""); setFilter("all"); }}>Clear filters</button>
            : <button className="btn btn-primary" onClick={newInvoice}>+ New invoice</button>}
        />
      ))}

      {/* ---- Stripe's own ---- */}
      {tab === "stripe" && (
        <Block
          title="Invoices Stripe raised"
          blurb="Read only. Subscription charges and anything you made inside Stripe itself. This console never writes to Stripe, so nothing here can be edited from this page."
          right={<SourceBadge mode={stripeState === "live" ? "live" : stripeState === "waiting" ? "waiting" : "sample"} hint={stripeState === "waiting" ? "Goes live with STRIPE_SECRET_KEY — SETUP.md § Stripe" : undefined} />}
        >
          {stripeInv && stripeInv.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="adm-table">
                <thead><tr><th>Number</th><th>Client</th><th>Raised</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Still owed</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {stripeInv.map((inv) => (
                    <tr key={inv.id}>
                      <td style={{ fontFamily: "var(--mono)" }}>{inv.number || inv.id.slice(0, 12)}</td>
                      <td>{inv.customerName || inv.customerEmail || "—"}</td>
                      <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{new Date(inv.created * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(inv.totalCents)}</td>
                      <td style={{ textAlign: "right" }}>{inv.dueCents ? fmtMoney(inv.dueCents) : "—"}</td>
                      <td><span className="adm-fin-tag">{String(inv.status || "").toUpperCase()}</span></td>
                      <td style={{ textAlign: "right" }}>
                        {inv.hostedUrl && <a className="btn btn-sm" href={inv.hostedUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>Stripe →</a>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="adm-fin-empty">
              {stripeState === "waiting"
                ? "This tab is wired and waiting on the Stripe key. Nothing is missing — there is just nothing to read yet."
                : "Stripe has not raised any invoices in the last twelve months."}
            </div>
          )}
        </Block>
      )}

      {/* ---- editor ---- */}
      {editorOpen && editing && (
        <InvoiceEditor
          open={editorOpen}
          onClose={() => { setEditorOpen(false); setEditing(null); }}
          initial={editing}
          clients={clients.rows || []}
          settings={settings || {}}
          onSave={onSaved}
        />
      )}

      {/* ---- one invoice ---- */}
      {openInvoice && (
        <InvoiceDrawer
          invoice={all.find((x) => x.id === openInvoice.id) || openInvoice}
          member={member}
          onClose={() => setOpenInvoice(null)}
          loadItems={listInvoiceItems}
          loadPayments={listPayments}
          onEdit={editInvoice}
          onMarkSent={doMarkSent}
          onVoid={doVoid}
          onDelete={doDelete}
          onAddPayment={doPayment}
          onRemovePayment={doRemovePayment}
          onPrint={printInvoice}
          settings={settings || {}}
        />
      )}

      {/* ---- settings ---- */}
      <InvoiceSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSaved={(row) => { setSettings(row); setSettingsOpen(false); }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Invoice settings — who we are on the document, and the defaults.    */
/* ------------------------------------------------------------------ */

function InvoiceSettings({ open, onClose, settings, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && settings) {
      setForm({
        company_name: settings.company_name || "",
        company_email: settings.company_email || "",
        company_address: settings.company_address || "",
        invoice_prefix: settings.invoice_prefix || "AIS-",
        default_terms_days: settings.default_terms_days ?? 14,
        default_tax_pct: settings.default_tax_pct ?? 0,
        default_terms_text: settings.default_terms_text || "",
        payment_instructions: settings.payment_instructions || "",
      });
    }
  }, [open, settings]);

  if (!open || !form) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    const res = await saveFinanceSettings({
      ...form,
      default_terms_days: Math.max(0, Number(form.default_terms_days) || 0),
      default_tax_pct: Math.max(0, Math.min(100, Number(form.default_tax_pct) || 0)),
    });
    setSaving(false);
    if (!res.ok) { toast.error("Not saved", res.error); return; }
    toast.success("Saved", "New invoices start with these.");
    onSaved(res.row);
  };

  return (
    <Modal open={open} onClose={onClose} kicker="INVOICE SETTINGS" title="What goes on every invoice" width={640}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </>}>
      <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 14 }}>
        These fill in every new invoice. Changing them here does not touch an invoice already made —
        an invoice is a record of what was sent, not a live document.
      </p>
      <div className="adm-fin-form2">
        <Field label="Our name"><TextInput value={form.company_name} onChange={(e) => set("company_name", e.target.value)} /></Field>
        <Field label="Billing email"><TextInput value={form.company_email} onChange={(e) => set("company_email", e.target.value)} placeholder="billing@aisyndicate.com" /></Field>
      </div>
      <Field label="Our address (shown on the invoice)">
        <TextArea value={form.company_address} onChange={(e) => set("company_address", e.target.value)} style={{ minHeight: 60 }} />
      </Field>
      <div className="adm-fin-form3">
        <Field label="Number starts with" hint="AIS- gives AIS-0001">
          <TextInput value={form.invoice_prefix} onChange={(e) => set("invoice_prefix", e.target.value)} />
        </Field>
        <Field label="Days to pay" hint="Sets the due date">
          <TextInput value={form.default_terms_days} onChange={(e) => set("default_terms_days", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Tax %" hint="0 if you do not charge tax">
          <TextInput value={form.default_tax_pct} onChange={(e) => set("default_tax_pct", e.target.value)} inputMode="decimal" />
        </Field>
      </div>
      <Field label="Terms line" hint="Printed at the bottom of the invoice.">
        <TextInput value={form.default_terms_text} onChange={(e) => set("default_terms_text", e.target.value)} />
      </Field>
      <Field label="How to pay us" hint="Bank details or a note about the card link. Printed on the invoice.">
        <TextArea value={form.payment_instructions} onChange={(e) => set("payment_instructions", e.target.value)} style={{ minHeight: 60 }} />
      </Field>
    </Modal>
  );
}
