import { useMemo, useState } from "react";
import { toast } from "../../lib/toast.js";
import { upsertExpense, deleteExpense } from "../../lib/finance.js";
import { Modal, Field, TextInput, TextArea, Select, fmtMoney } from "./shared.jsx";
import { Block, BasisBadge } from "./financeParts.jsx";
import { EXPENSE_CATEGORIES, todayIso, expenseToMonths, lastMonths, monthKey, monthLabel } from "../../../lib/finance-math.js";

/* The cost list — every dollar that goes out, typed in by hand.
 *
 * This panel is the reason the profit line on the Finance page can exist at
 * all. Stripe knows what came in; nothing anywhere knows what we paid.
 *
 * Three things worth knowing about how a cost behaves:
 *   · "Every month" repeats from its start date until you set an end date. Type
 *     Vercel in once and it is in all twelve months.
 *   · "Once a year" is divided by twelve across the months it covers, so one
 *     January payment does not make January look like a disaster.
 *   · The "won us clients" tick is what the cost-per-new-client number divides.
 *     A category cannot tell a sales contractor from a delivery one; a person can.
 */

const BLANK = {
  incurred_on: todayIso(),
  ended_on: "",
  category: "Software",
  vendor: "",
  description: "",
  amount: "",
  interval: "monthly",
  client_id: "",
  counts_toward_cac: false,
  notes: "",
  receipt_url: "",
};

const INTERVALS = [
  ["monthly", "Every month"],
  ["one_time", "Once"],
  ["yearly", "Once a year"],
];

function toForm(row) {
  return {
    id: row.id,
    incurred_on: row.incurred_on || todayIso(),
    ended_on: row.ended_on || "",
    category: row.category || "Other",
    vendor: row.vendor || "",
    description: row.description || "",
    amount: row.amount_cents != null ? String(row.amount_cents / 100) : "",
    interval: row.interval || "one_time",
    client_id: row.client_id || "",
    counts_toward_cac: Boolean(row.counts_toward_cac),
    notes: row.notes || "",
    receipt_url: row.receipt_url || "",
  };
}

export default function ExpensesPanel({ member, rows, sample, clients, onChanged }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [month, setMonth] = useState(monthKey(new Date()));
  const [confirmId, setConfirmId] = useState(null);

  const monthOptions = useMemo(
    () => [["all", "Every cost on record"], ...lastMonths(12).slice().reverse().map((m) => [m, monthLabel(m, { long: true })])],
    []
  );

  /* A repeating cost belongs to every month it covers, not just the month it
   * started — otherwise the list for August would be empty while August's total
   * said $1,200, and the two would never agree. */
  const shown = useMemo(() => {
    if (month === "all") return rows;
    return rows.filter((r) => expenseToMonths(r, [month]).length > 0);
  }, [rows, month]);

  const monthTotal = useMemo(() => {
    if (month === "all") return null;
    let t = 0;
    for (const r of rows) for (const hit of expenseToMonths(r, [month])) t += hit.cents;
    return t;
  }, [rows, month]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const dollars = Number(String(form.amount).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(dollars) || dollars <= 0) { toast.error("How much was it?", "Type an amount bigger than zero."); return; }
    if (!form.incurred_on) { toast.error("When was it paid?", "Pick a date."); return; }
    if (form.ended_on && form.ended_on < form.incurred_on) { toast.error("Those dates are backwards", "The end date has to come after the start date."); return; }
    setSaving(true);
    const res = await upsertExpense({
      ...(form.id ? { id: form.id } : {}),
      incurred_on: form.incurred_on,
      ended_on: form.ended_on || null,
      category: form.category,
      vendor: form.vendor.trim() || null,
      description: form.description.trim() || null,
      amount_cents: Math.round(dollars * 100),
      interval: form.interval,
      client_id: form.client_id || null,
      counts_toward_cac: form.counts_toward_cac,
      notes: form.notes.trim() || null,
      receipt_url: form.receipt_url.trim() || null,
    });
    setSaving(false);
    if (!res.ok) { toast.error("Not saved", res.error); return; }
    setOpen(false);
    setForm(BLANK);
    toast.success(form.id ? "Cost updated" : "Cost added", "Every number on this page just changed with it.");
    onChanged?.();
  };

  const remove = async (id) => {
    const res = await deleteExpense(id);
    setConfirmId(null);
    if (!res.ok) { toast.error("Not removed", res.error); return; }
    toast.success("Cost removed", null);
    onChanged?.();
  };

  return (
    <Block
      title="The cost list"
      blurb="Every dollar out, one row each. This is the only place money out comes from — no integration knows what we pay, so an empty list means a profit line that is wrong on the high side."
      right={
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <BasisBadge basis={sample ? "sample" : "typed"} />
          <select className="adm-input" style={{ width: 190 }} value={month} onChange={(e) => setMonth(e.target.value)}>
            {monthOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={() => { setForm(BLANK); setOpen(true); }}>+ Add a cost</button>
        </div>
      }
    >
      {monthTotal != null && (
        <div className="adm-fin-callout" style={{ marginBottom: 12 }}>
          <strong>{fmtMoney(monthTotal)}</strong> lands in {monthLabel(month, { long: true })} across{" "}
          {shown.length} cost{shown.length === 1 ? "" : "s"}. Repeating costs are counted in every month
          they cover; a yearly cost is counted at one twelfth.
        </div>
      )}

      {shown.length ? (
        <div style={{ overflowX: "auto" }}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>What</th><th>Category</th><th>How often</th><th>Started</th>
                <th style={{ textAlign: "right" }}>Amount</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: "var(--ink)" }}>{r.vendor || r.description || "—"}</div>
                    {r.vendor && r.description && <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{r.description}</div>}
                    {r.counts_toward_cac && <span className="adm-fin-tag">WON US CLIENTS</span>}
                    {r.client_id && (
                      <span className="adm-fin-tag" style={{ marginLeft: 6 }}>
                        {(clients.find((c) => c.id === r.client_id)?.name) || "CLIENT"}
                      </span>
                    )}
                  </td>
                  <td>{r.category}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.interval === "monthly" ? "Every month" : r.interval === "yearly" ? "Once a year" : "Once"}
                    {r.ended_on && <div style={{ fontSize: 11, color: "var(--ink-dim)" }}>stopped {r.ended_on}</div>}
                  </td>
                  <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{r.incurred_on}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: "var(--ink)" }}>
                    {fmtMoney(r.amount_cents)}
                    {r.interval !== "one_time" && <span style={{ fontSize: 11, color: "var(--ink-dim)" }}>{r.interval === "monthly" ? "/mo" : "/yr"}</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button className="btn btn-sm" onClick={() => { setForm(toForm(r)); setOpen(true); }}>Edit</button>
                    {member.role === "owner" && (
                      <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setConfirmId(r.id)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="adm-fin-empty">
          No costs {month === "all" ? "on record" : `land in ${monthLabel(month, { long: true })}`} yet.
          Add the ones you pay every month first — hosting, AI, software — and the profit line starts telling the truth.
        </div>
      )}

      {/* ---- add / edit ---- */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        kicker={form.id ? "EDIT A COST" : "ADD A COST"}
        title={form.id ? "Change this cost" : "What did we pay for?"}
        width={620}
        footer={<>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </>}
      >
        <div className="adm-fin-form2">
          <Field label="Who got paid" hint="Anthropic, Vercel, a contractor's name">
            <TextInput value={form.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="Anthropic" />
          </Field>
          <Field label="How much (dollars)" hint="Per payment. A yearly cost goes in as the full yearly amount.">
            <TextInput value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="241.00" inputMode="decimal" />
          </Field>
        </div>

        <div className="adm-fin-form2">
          <Field label="Category">
            <Select value={form.category} onChange={(e) => set("category", e.target.value)} options={EXPENSE_CATEGORIES.map((c) => [c, c])} />
          </Field>
          <Field label="How often">
            <Select value={form.interval} onChange={(e) => set("interval", e.target.value)} options={INTERVALS} />
          </Field>
        </div>

        <div className="adm-fin-form2">
          <Field label={form.interval === "one_time" ? "Date paid" : "First payment"}>
            <TextInput type="date" value={form.incurred_on} onChange={(e) => set("incurred_on", e.target.value)} />
          </Field>
          <Field label="Stopped paying" hint={form.interval === "one_time" ? "Not used for a one-off." : "Leave blank while it is still running."}>
            <TextInput type="date" value={form.ended_on} onChange={(e) => set("ended_on", e.target.value)} disabled={form.interval === "one_time"} />
          </Field>
        </div>

        <Field label="What it was for">
          <TextInput value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Claude API — scans, drafts, reports" />
        </Field>

        <Field label="Spent on one client?" hint="Only for costs that exist because of one client. Leave on 'No client' for everything else.">
          <Select
            value={form.client_id}
            onChange={(e) => set("client_id", e.target.value)}
            options={[["", "No client — this is ours"], ...clients.map((c) => [c.id, c.name])]}
          />
        </Field>

        <label className="adm-fin-check">
          <input type="checkbox" checked={form.counts_toward_cac} onChange={(e) => set("counts_toward_cac", e.target.checked)} />
          <span>
            <strong>This money went into winning clients.</strong>
            <span> Ads, a lead list, a sales contractor's pay. Ticking it puts this cost into the
              cost-per-new-client figure. Ads are counted whether or not you tick it.</span>
          </span>
        </label>

        <Field label="Note to ourselves" hint="Never shown to a client.">
          <TextArea value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <Field label="Link to the receipt" hint="A link only. Files do not live in here.">
          <TextInput value={form.receipt_url} onChange={(e) => set("receipt_url", e.target.value)} placeholder="https://…" />
        </Field>
      </Modal>

      {/* ---- confirm remove ---- */}
      <Modal
        open={Boolean(confirmId)}
        onClose={() => setConfirmId(null)}
        kicker="REMOVE A COST"
        title="Take this off the books?"
        width={440}
        footer={<>
          <button className="btn" onClick={() => setConfirmId(null)}>Keep it</button>
          <button className="btn btn-primary" onClick={() => remove(confirmId)}>Remove it</button>
        </>}
      >
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          Every profit and margin number on this page will change. Removing a cost is owners only, and
          there is no undo — if you are unsure, set an end date on it instead so the history stays right.
        </p>
      </Modal>
    </Block>
  );
}
