import { useEffect, useMemo, useState } from "react";
import { toast } from "../../lib/toast.js";
import { Modal, Field, TextInput, TextArea, Select, fmtMoney, MONEY_RED } from "./shared.jsx";
import { BasisBadge } from "./financeParts.jsx";
import {
  invoiceTotals, effectiveInvoiceStatus, invoiceOutstandingCents, todayIso,
  INVOICE_STATUS_LABELS, daysBetween,
} from "../../../lib/finance-math.js";

/* The parts of the Invoices page: the status chip, the editor, the drawer that
 * shows one invoice, and the printable copy. Aug 20 2026. */

/* ------------------------------------------------------------------ */
/* Status chip                                                         */
/* ------------------------------------------------------------------ */

const TONE = {
  draft: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
  sent: { c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  part_paid: { c: "#92400e", bg: "#fffbeb" },
  paid: { c: "#006b1a", bg: "var(--success-soft)" },
  overdue: { c: "#991b1b", bg: "#fef2f2" },
  void: { c: "var(--ink-faint)", bg: "var(--bg-3)" },
};

export function InvoiceStatusChip({ status }) {
  const t = TONE[status] || TONE.draft;
  return (
    <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: t.c, background: t.bg, whiteSpace: "nowrap" }}>
      {(INVOICE_STATUS_LABELS[status] || status).toUpperCase()}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The editor                                                          */
/*                                                                      */
/* Line items are typed in dollars and held in cents. The total is       */
/* worked out from the lines as you type and can never be typed over —   */
/* an invoice whose total disagrees with the lines under it is the worst  */
/* bug an invoice can have.                                              */
/* ------------------------------------------------------------------ */

function centsFromInput(v) {
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function InvoiceEditor({ open, onClose, initial, clients, settings, onSave }) {
  const [inv, setInv] = useState(initial.invoice);
  const [items, setItems] = useState(
    (initial.items || []).map((it) => ({
      description: it.description || "",
      qty: it.qty ?? 1,
      unitInput: it.unit_cents != null ? String(it.unit_cents / 100) : "",
    }))
  );
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setInv((x) => ({ ...x, [k]: v }));

  const priced = useMemo(
    () => items.map((it) => ({ description: it.description, qty: Number(it.qty) || 0, unit_cents: centsFromInput(it.unitInput) })),
    [items]
  );
  /* A line with no description is not saved, so it must not be in the total on
   * screen either. Showing $1,450 and storing $450 because one line had no words
   * in it is the worst kind of quiet wrong. `totals` is what gets saved; `shown`
   * lines up with the rows on screen so each row can still show its own amount. */
  const usable = useMemo(() => priced.filter((l) => l.description.trim() && l.qty > 0), [priced]);
  // Counted apart, because "you left the description blank" and "you left the
  // quantity blank" are two different mistakes and one message for both sends
  // people looking in the wrong place.
  const noWords = priced.filter((l) => !l.description.trim()).length;
  const noQty = priced.filter((l) => l.description.trim() && !(l.qty > 0)).length;
  const dropped = noWords + noQty;
  const shown = useMemo(
    () => invoiceTotals(priced, { taxPct: Number(inv.tax_pct) || 0, discountCents: Number(inv.discount_cents) || 0 }),
    [priced, inv.tax_pct, inv.discount_cents]
  );
  const totals = useMemo(
    () => invoiceTotals(usable, { taxPct: Number(inv.tax_pct) || 0, discountCents: Number(inv.discount_cents) || 0 }),
    [usable, inv.tax_pct, inv.discount_cents]
  );
  /* The discount box is held as TEXT while it is being typed. Held as
   * cents ÷ 100 it deleted the decimal point as you typed it, so $12.50 could
   * not be entered at all. */
  const [discountInput, setDiscountInput] = useState(
    initial.invoice.discount_cents ? String(initial.invoice.discount_cents / 100) : ""
  );

  const setItem = (i, k, v) => setItems((list) => list.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)));
  const addLine = () => setItems((list) => [...list, { description: "", qty: 1, unitInput: "" }]);
  const removeLine = (i) => setItems((list) => (list.length === 1 ? list : list.filter((_, idx) => idx !== i)));

  /* Picking a client copies their name and email onto the invoice. It copies —
   * it does not link — because renaming a client next year must not rewrite an
   * invoice already sitting in their inbox. */
  const pickClient = (id) => {
    const c = clients.find((x) => x.id === id);
    setInv((x) => ({
      ...x,
      client_id: id,
      bill_to_name: c ? c.name : x.bill_to_name,
      bill_to_email: c?.contact_email || x.bill_to_email,
    }));
  };

  const save = async () => {
    if (!String(inv.number || "").trim()) { toast.error("It needs a number", "That is what the client pays against."); return; }
    if (!String(inv.bill_to_name || "").trim()) { toast.error("Who is it for?", "Pick a client, or type a name."); return; }
    if (!usable.length) { toast.error("It needs at least one line", "Write what the money is for and how much."); return; }
    if (inv.due_date && inv.issue_date && inv.due_date < inv.issue_date) {
      toast.error("Those dates are backwards", "The due date has to be on or after the issue date."); return;
    }
    setSaving(true);
    const ok = await onSave({
      invoice: {
        ...(inv.id ? { id: inv.id } : {}),
        number: String(inv.number).trim(),
        client_id: inv.client_id || null,
        bill_to_name: String(inv.bill_to_name).trim(),
        bill_to_email: inv.bill_to_email?.trim() || null,
        bill_to_address: inv.bill_to_address?.trim() || null,
        status: inv.status || "draft",
        issue_date: inv.issue_date || todayIso(),
        due_date: inv.due_date || null,
        currency: inv.currency || "usd",
        tax_pct: Number(inv.tax_pct) || 0,
        discount_cents: Number(inv.discount_cents) || 0,
        notes: inv.notes?.trim() || null,
        terms: inv.terms?.trim() || null,
        internal_note: inv.internal_note?.trim() || null,
      },
      items: usable,
    });
    setSaving(false);
    if (ok === false) return;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      kicker={inv.id ? "EDIT INVOICE" : "NEW INVOICE"}
      title={inv.id ? `Change ${inv.number}` : "Make an invoice"}
      width={780}
      footer={<>
        <span style={{ marginRight: "auto", fontSize: 13, color: "var(--ink-2)" }}>
          Total <strong style={{ color: "var(--ink)", fontSize: 15 }}>{fmtMoney(totals.totalCents)}</strong>
        </span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : (inv.id ? "Save changes" : "Save as draft")}</button>
      </>}
    >
      <div className="adm-fin-form2">
        <Field label="Invoice number" hint="Has to be one of a kind.">
          <TextInput value={inv.number} onChange={(e) => set("number", e.target.value)} />
        </Field>
        <Field label="Client">
          <Select
            value={inv.client_id || ""}
            onChange={(e) => pickClient(e.target.value)}
            options={[["", "Someone not on the client list"], ...clients.map((c) => [c.id, c.name])]}
          />
        </Field>
      </div>

      <div className="adm-fin-form2">
        <Field label="Bill to — name">
          <TextInput value={inv.bill_to_name} onChange={(e) => set("bill_to_name", e.target.value)} placeholder="Harbor Injury Law" />
        </Field>
        <Field label="Bill to — email">
          <TextInput value={inv.bill_to_email || ""} onChange={(e) => set("bill_to_email", e.target.value)} placeholder="billing@theirfirm.com" />
        </Field>
      </div>

      <Field label="Bill to — address" hint="Optional. Printed on the invoice.">
        <TextArea value={inv.bill_to_address || ""} onChange={(e) => set("bill_to_address", e.target.value)} style={{ minHeight: 54 }} />
      </Field>

      <div className="adm-fin-form3">
        <Field label="Issued"><TextInput type="date" value={inv.issue_date} onChange={(e) => set("issue_date", e.target.value)} /></Field>
        <Field label="Due"><TextInput type="date" value={inv.due_date || ""} onChange={(e) => set("due_date", e.target.value)} /></Field>
        <Field label="Tax %" hint="0 if none"><TextInput value={inv.tax_pct} onChange={(e) => set("tax_pct", e.target.value)} inputMode="decimal" /></Field>
      </div>

      {/* ---- lines ---- */}
      <div className="label" style={{ marginTop: 6, marginBottom: 8 }}>What they are paying for</div>
      <div className="adm-inv-lines">
        <div className="adm-inv-line adm-inv-line-head">
          <span>Description</span><span>Qty</span><span>Price each</span><span>Amount</span><span />
        </div>
        {items.map((it, i) => (
          <div className="adm-inv-line" key={i}>
            <TextInput value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} placeholder="GEO retainer — monthly" />
            <TextInput value={it.qty} onChange={(e) => setItem(i, "qty", e.target.value)} inputMode="decimal" />
            <TextInput value={it.unitInput} onChange={(e) => setItem(i, "unitInput", e.target.value)} inputMode="decimal" placeholder="450.00" />
            <span className="adm-inv-line-amt">{fmtMoney(shown.lines[i]?.amount_cents || 0)}</span>
            <button className="btn btn-sm" onClick={() => removeLine(i)} disabled={items.length === 1} title="Remove this line">×</button>
          </div>
        ))}
      </div>
      <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={addLine}>+ Another line</button>

      {dropped > 0 && (
        <div className="adm-fin-callout" style={{ marginTop: 10 }}>
          {noWords > 0 && <>{noWords} line{noWords === 1 ? " has" : "s have"} no description. </>}
          {noQty > 0 && <>{noQty} line{noQty === 1 ? " has" : "s have"} no quantity. </>}
          {dropped === 1 ? "It is" : "They are"} not in the total and will not be saved — fill the line in, or
          remove it.
        </div>
      )}

      <div className="adm-inv-totals">
        <div><span>Subtotal</span><strong>{fmtMoney(totals.subtotalCents)}</strong></div>
        <div>
          <span>Discount</span>
          <TextInput
            style={{ width: 110, textAlign: "right" }}
            value={discountInput}
            placeholder="0.00"
            onChange={(e) => { setDiscountInput(e.target.value); set("discount_cents", centsFromInput(e.target.value)); }}
            inputMode="decimal"
          />
        </div>
        <div><span>Tax ({Number(inv.tax_pct) || 0}%)</span><strong>{fmtMoney(totals.taxCents)}</strong></div>
        <div className="adm-inv-total-big"><span>Total</span><strong>{fmtMoney(totals.totalCents)}</strong></div>
      </div>

      <Field label="Note on the invoice" hint="The client reads this.">
        <TextArea value={inv.notes || ""} onChange={(e) => set("notes", e.target.value)} style={{ minHeight: 54 }} />
      </Field>
      <Field label="Terms line" hint="Printed at the bottom.">
        <TextInput value={inv.terms || ""} onChange={(e) => set("terms", e.target.value)} placeholder={settings.default_terms_text || "Payment due within 14 days of the invoice date."} />
      </Field>
      <Field label="Note to ourselves" hint="Never leaves this console.">
        <TextInput value={inv.internal_note || ""} onChange={(e) => set("internal_note", e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* The drawer — one invoice, everything about it                       */
/* ------------------------------------------------------------------ */

export function InvoiceDrawer({
  invoice, member, onClose, loadItems, loadPayments, onEdit, onMarkSent, onVoid,
  onDelete, onAddPayment, onRemovePayment, onPrint, settings,
}) {
  const [items, setItems] = useState([]);
  const [payments, setPayments] = useState([]);
  const [payOpen, setPayOpen] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pay, setPay] = useState({ amount: "", paidOn: todayIso(), method: "Stripe", reference: "", note: "" });

  useEffect(() => {
    let alive = true;
    (async () => {
      const [i, p] = await Promise.all([loadItems(invoice.id), loadPayments(invoice.id)]);
      if (!alive) return;
      setItems(i.rows || []);
      setPayments(p.rows || []);
    })();
    return () => { alive = false; };
  }, [invoice, loadItems, loadPayments]);

  const status = effectiveInvoiceStatus(invoice);
  const owed = invoiceOutstandingCents(invoice);
  // Plain dates on both sides. new Date("2026-08-10") is midnight UTC, which in
  // Chicago is the 9th, so this used to read one day later than it was.
  const late = status === "overdue" && invoice.due_date ? daysBetween(invoice.due_date, todayIso()) : null;

  const savePayment = async () => {
    const cents = centsFromInput(pay.amount);
    if (cents <= 0) { toast.error("How much came in?", "Type an amount bigger than zero."); return; }
    if (cents > owed + 1) {
      toast.warn("That is more than is owed", `Only ${fmtMoney(owed)} is outstanding — saving it anyway, so fix it if that was a slip.`);
    }
    const ok = await onAddPayment(invoice, {
      amountCents: cents, paidOn: pay.paidOn, method: pay.method, reference: pay.reference, note: pay.note,
    });
    if (ok === false) return;
    setPayOpen(false);
    setPay({ amount: "", paidOn: todayIso(), method: "Stripe", reference: "", note: "" });
    const p = await loadPayments(invoice.id);
    setPayments(p.rows || []);
  };

  const copyEmail = async () => {
    const text = [
      `Hi${invoice.bill_to_name ? ` ${invoice.bill_to_name}` : ""},`,
      "",
      `Invoice ${invoice.number} for ${fmtMoney(invoice.total_cents)} is attached.`,
      invoice.due_date ? `It is due on ${invoice.due_date}.` : null,
      "",
      settings.payment_instructions || null,
      "",
      "Thank you,",
      settings.company_name || "AI Syndicate",
    ].filter((x) => x != null).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied", "Paste it into an email and attach the printed invoice.");
    } catch {
      toast.error("Could not copy", "Your browser blocked it. Select the text by hand instead.");
    }
  };

  return (
    <>
      <div className="adm-drawer-backdrop" onClick={onClose} />
      <div className="adm-drawer" role="dialog" aria-modal="true" aria-label={`Invoice ${invoice.number}`}>
        <div className="adm-drawer-head">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "var(--mono)", fontWeight: 800, fontSize: 13 }}>{invoice.number}</span>
                <InvoiceStatusChip status={status} />
                <BasisBadge basis="typed" />
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 700, marginTop: 6, color: "var(--ink)" }}>
                {invoice.bill_to_name}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 2 }}>
                {fmtMoney(invoice.total_cents)} · issued {invoice.issue_date}
                {invoice.due_date ? ` · due ${invoice.due_date}` : ""}
                {late ? ` · ${late} day${late === 1 ? "" : "s"} late` : ""}
              </div>
            </div>
            <button className="adm-modal-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="adm-drawer-body">
          {owed > 0 && (
            <div className="adm-fin-callout" style={{ borderColor: status === "overdue" ? MONEY_RED : undefined }}>
              <strong style={{ color: status === "overdue" ? MONEY_RED : undefined }}>{fmtMoney(owed)} still owed.</strong>{" "}
              {invoice.amount_paid_cents > 0 ? `${fmtMoney(invoice.amount_paid_cents)} of ${fmtMoney(invoice.total_cents)} has come in.` : "Nothing has come in yet."}
            </div>
          )}

          <div className="label" style={{ marginTop: 16, marginBottom: 8 }}>Lines</div>
          <table className="adm-table">
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.description}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap", color: "var(--ink-dim)" }}>{it.qty} × {fmtMoney(it.unit_cents)}</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(it.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="adm-inv-totals" style={{ marginTop: 10 }}>
            <div><span>Subtotal</span><strong>{fmtMoney(invoice.subtotal_cents)}</strong></div>
            {invoice.discount_cents > 0 && <div><span>Discount</span><strong>−{fmtMoney(invoice.discount_cents)}</strong></div>}
            {invoice.tax_cents > 0 && <div><span>Tax ({invoice.tax_pct}%)</span><strong>{fmtMoney(invoice.tax_cents)}</strong></div>}
            <div className="adm-inv-total-big"><span>Total</span><strong>{fmtMoney(invoice.total_cents)}</strong></div>
            <div><span>Paid</span><strong>{fmtMoney(invoice.amount_paid_cents)}</strong></div>
          </div>

          <div className="label" style={{ marginTop: 20, marginBottom: 8 }}>Money received</div>
          {payments.length ? (
            <table className="adm-table">
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{p.paid_on}</td>
                    <td>{p.method || "—"}{p.reference && <span style={{ color: "var(--ink-dim)" }}> · {p.reference}</span>}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: "#006300" }}>{fmtMoney(p.amount_cents)}</td>
                    {member.role === "owner" && (
                      <td style={{ textAlign: "right" }}>
                        <button className="btn btn-sm" onClick={async () => {
                          const ok = await onRemovePayment(invoice, p.id);
                          if (ok !== false) setPayments((list) => list.filter((x) => x.id !== p.id));
                        }}>Remove</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="adm-fin-empty">No money recorded against this invoice yet.</div>
          )}

          {invoice.notes && (<><div className="label" style={{ marginTop: 20, marginBottom: 6 }}>Note on the invoice</div><p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>{invoice.notes}</p></>)}
          {invoice.internal_note && (<><div className="label" style={{ marginTop: 16, marginBottom: 6 }}>Note to ourselves</div><p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>{invoice.internal_note}</p></>)}

          <div style={{ marginTop: 20, fontSize: 11.5, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>
            Made {timeAgoSafe(invoice.created_at)}{invoice.sent_at ? ` · sent ${timeAgoSafe(invoice.sent_at)}` : ""}{invoice.paid_at ? ` · paid ${timeAgoSafe(invoice.paid_at)}` : ""}
          </div>
        </div>

        <div className="adm-drawer-foot" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-sm" onClick={() => onEdit(invoice)}>Edit</button>
          <button className="btn btn-sm" onClick={() => onPrint(invoice)}>Print / PDF</button>
          <button className="btn btn-sm" onClick={copyEmail}>Copy email text</button>
          {invoice.status === "draft" && <button className="btn btn-sm btn-primary" onClick={() => onMarkSent(invoice)}>Mark as sent</button>}
          {owed > 0 && invoice.status !== "void" && <button className="btn btn-sm btn-primary" onClick={() => setPayOpen(true)}>Record a payment</button>}
          {invoice.status === "draft" && (
            <span style={{ alignSelf: "center", fontSize: 11.5, color: "var(--ink-dim)" }}>
              Money is recorded after it is marked sent — a draft is not something anyone can pay against.
            </span>
          )}
          {invoice.status !== "void" && <button className="btn btn-sm" onClick={() => setConfirmVoid(true)}>Cancel invoice</button>}
          {member.role === "owner" && <button className="btn btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>
      </div>

      {/* record a payment */}
      <Modal open={payOpen} onClose={() => setPayOpen(false)} kicker="MONEY IN" title={`Record a payment on ${invoice.number}`} width={520}
        footer={<>
          <button className="btn" onClick={() => setPayOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={savePayment}>Save</button>
        </>}>
        <div className="adm-fin-form2">
          <Field label="How much (dollars)" hint={`${fmtMoney(owed)} is outstanding`}>
            <TextInput value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} inputMode="decimal" placeholder={String((owed / 100).toFixed(2))} />
          </Field>
          <Field label="Date it arrived">
            <TextInput type="date" value={pay.paidOn} onChange={(e) => setPay((p) => ({ ...p, paidOn: e.target.value }))} />
          </Field>
        </div>
        <div className="adm-fin-form2">
          <Field label="How it arrived">
            <Select value={pay.method} onChange={(e) => setPay((p) => ({ ...p, method: e.target.value }))}
              options={[["Stripe", "Stripe"], ["Bank transfer", "Bank transfer"], ["Check", "Check"], ["Cash", "Cash"], ["Other", "Other"]]} />
          </Field>
          <Field label="Reference" hint="A Stripe id, a check number.">
            <TextInput value={pay.reference} onChange={(e) => setPay((p) => ({ ...p, reference: e.target.value }))} />
          </Field>
        </div>
        <Field label="Note"><TextInput value={pay.note} onChange={(e) => setPay((p) => ({ ...p, note: e.target.value }))} /></Field>
        <p style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>
          Part payments are fine. The invoice adds up what it has received and marks itself paid only
          when the whole amount is in.
        </p>
      </Modal>

      <Modal open={confirmVoid} onClose={() => setConfirmVoid(false)} kicker="CANCEL AN INVOICE" title={`Cancel ${invoice.number}?`} width={440}
        footer={<>
          <button className="btn" onClick={() => setConfirmVoid(false)}>Keep it</button>
          <button className="btn btn-primary" onClick={() => { setConfirmVoid(false); onVoid(invoice); }}>Cancel it</button>
        </>}>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          It stays on record with CANCELLED across it and drops out of every total — owed, overdue,
          billed. Use this instead of deleting, so the numbering stays unbroken.
        </p>
      </Modal>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} kicker="DELETE AN INVOICE" title={`Delete ${invoice.number} for good?`} width={440}
        footer={<>
          <button className="btn" onClick={() => setConfirmDelete(false)}>Keep it</button>
          <button className="btn btn-primary" onClick={() => { setConfirmDelete(false); onDelete(invoice); }}>Delete it</button>
        </>}>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          The invoice and every payment recorded against it go away, and the number leaves a hole in the
          sequence. Owners only, and there is no undo. Cancelling is almost always the right move instead.
        </p>
      </Modal>
    </>
  );
}

function timeAgoSafe(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/* The printable copy                                                  */
/*                                                                      */
/* A whole HTML page as a string, opened in a new tab. Print it, or use  */
/* the browser's "Save as PDF" — which is how a PDF gets made here       */
/* without shipping a PDF library to every visitor.                      */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function invoiceHtml(inv, items, settings) {
  const money = (c) => fmtMoney(c, inv.currency || "usd");
  const status = effectiveInvoiceStatus(inv);
  const lines = (items || []).map((it) => `
    <tr>
      <td>${esc(it.description)}</td>
      <td class="n">${esc(it.qty)}</td>
      <td class="n">${money(it.unit_cents)}</td>
      <td class="n">${money(it.amount_cents)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Invoice ${esc(inv.number)} — ${esc(settings.company_name || "AI Syndicate")}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #16233a; margin: 0; padding: 48px; background: #fff; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 32px; border-bottom: 2px solid #16233a; padding-bottom: 20px; }
  h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .muted { color: #5a6784; font-size: 13px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .chip { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 800; letter-spacing: .06em; background: #eef2ff; color: #3730a3; }
  .chip.paid { background: #ecfdf5; color: #065f46; }
  .chip.overdue { background: #fef2f2; color: #991b1b; }
  .chip.void { background: #f3f4f6; color: #6b7280; }
  .cols { display: flex; gap: 40px; margin: 28px 0; }
  .cols > div { flex: 1; }
  .label { font-size: 10px; font-weight: 800; letter-spacing: .12em; color: #8895ad; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; font-size: 10px; letter-spacing: .1em; color: #8895ad; border-bottom: 1px solid #e3e8f0; padding: 8px 0; }
  td { padding: 10px 0; border-bottom: 1px solid #f0f3f8; }
  .n { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 280px; margin-top: 16px; }
  .totals div { display: flex; justify-content: space-between; padding: 6px 0; }
  .totals .big { border-top: 2px solid #16233a; margin-top: 6px; padding-top: 10px; font-size: 18px; font-weight: 800; }
  .foot { margin-top: 40px; border-top: 1px solid #e3e8f0; padding-top: 16px; font-size: 12.5px; color: #5a6784; }
  .void-stamp { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%) rotate(-18deg); font-size: 90px; font-weight: 900; color: rgba(153,27,27,.12); letter-spacing: .1em; }
  @media print { body { padding: 0; } .noprint { display: none; } }
  .noprint { margin-bottom: 24px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
</style></head>
<body>
${inv.status === "void" ? '<div class="void-stamp">CANCELLED</div>' : ""}
<div class="wrap">
  <div class="noprint"><button onclick="window.print()">Print, or save as PDF</button></div>
  <div class="top">
    <div>
      <h1>Invoice</h1>
      <div class="mono">${esc(inv.number)}</div>
      <div style="margin-top:8px"><span class="chip ${status === "paid" ? "paid" : status === "overdue" ? "overdue" : status === "void" ? "void" : ""}">${esc((INVOICE_STATUS_LABELS[status] || status).toUpperCase())}</span></div>
    </div>
    <div style="text-align:right">
      <div style="font-weight:800;font-size:16px">${esc(settings.company_name || "AI Syndicate")}</div>
      <div class="muted" style="white-space:pre-line">${esc(settings.company_address || "")}</div>
      <div class="muted">${esc(settings.company_email || "")}</div>
    </div>
  </div>

  <div class="cols">
    <div>
      <div class="label">BILL TO</div>
      <div style="font-weight:700">${esc(inv.bill_to_name)}</div>
      <div class="muted" style="white-space:pre-line">${esc(inv.bill_to_address || "")}</div>
      <div class="muted">${esc(inv.bill_to_email || "")}</div>
    </div>
    <div>
      <div class="label">ISSUED</div><div>${esc(inv.issue_date)}</div>
      <div class="label" style="margin-top:12px">DUE</div><div>${esc(inv.due_date || "on receipt")}</div>
    </div>
    <div>
      <div class="label">AMOUNT DUE</div>
      <div style="font-size:24px;font-weight:800">${money(Math.max(0, (inv.total_cents || 0) - (inv.amount_paid_cents || 0)))}</div>
      ${inv.amount_paid_cents ? `<div class="muted">${money(inv.amount_paid_cents)} already received</div>` : ""}
    </div>
  </div>

  <table>
    <thead><tr><th>DESCRIPTION</th><th class="n">QTY</th><th class="n">PRICE</th><th class="n">AMOUNT</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal</span><span>${money(inv.subtotal_cents)}</span></div>
    ${inv.discount_cents ? `<div><span>Discount</span><span>−${money(inv.discount_cents)}</span></div>` : ""}
    ${inv.tax_cents ? `<div><span>Tax (${esc(inv.tax_pct)}%)</span><span>${money(inv.tax_cents)}</span></div>` : ""}
    <div class="big"><span>Total</span><span>${money(inv.total_cents)}</span></div>
    ${inv.amount_paid_cents ? `<div><span>Paid</span><span>−${money(inv.amount_paid_cents)}</span></div><div style="font-weight:700"><span>Still owed</span><span>${money(Math.max(0, inv.total_cents - inv.amount_paid_cents))}</span></div>` : ""}
  </div>

  <div class="foot">
    ${inv.notes ? `<p>${esc(inv.notes)}</p>` : ""}
    ${settings.payment_instructions ? `<p><strong>How to pay:</strong> ${esc(settings.payment_instructions)}</p>` : ""}
    <p>${esc(inv.terms || settings.default_terms_text || "")}</p>
  </div>
</div>
</body></html>`;
}
