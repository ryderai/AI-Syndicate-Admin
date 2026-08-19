import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { SourceBadge, TextInput, fmtMoney, timeAgo, EmptyState } from "./shared.jsx";

/* Customers — every paying account, straight from Stripe. */

const SAMPLE = {
  configured: false,
  customers: [
    { id: "cus_sample1", email: "greg@sample.com", name: "Olson Law PLLC", created: Date.now() / 1000 - 90 * 86400, delinquent: false, subscription: { status: "active", plan: "Radar Pro", mrrCents: 99900, currentPeriodEnd: Date.now() / 1000 + 12 * 86400 } },
    { id: "cus_sample2", email: "dana@sample.com", name: "Lakeside Realty Group", created: Date.now() / 1000 - 24 * 86400, delinquent: false, subscription: { status: "active", plan: "Pulse", mrrCents: 49900, currentPeriodEnd: Date.now() / 1000 + 6 * 86400 } },
    { id: "cus_sample3", email: "j@sample.com", name: "Harbor Injury Law", created: Date.now() / 1000 - 200 * 86400, delinquent: false, subscription: { status: "active", plan: "Territory", mrrCents: 199900, currentPeriodEnd: Date.now() / 1000 + 20 * 86400 } },
    { id: "cus_sample4", email: "mike@sample.com", name: "Summit Roofing Co", created: Date.now() / 1000 - 4 * 86400, delinquent: false, subscription: { status: "trialing", plan: "Pulse", mrrCents: 49900, currentPeriodEnd: Date.now() / 1000 + 10 * 86400 } },
    { id: "cus_sample5", email: "old@sample.com", name: "Former Client LLC", created: Date.now() / 1000 - 300 * 86400, delinquent: false, subscription: { status: "canceled", plan: "Pulse", mrrCents: 0, currentPeriodEnd: null } },
  ],
};

const STATUS_TONE = {
  active: { c: "#006b1a", bg: "var(--success-soft)" },
  trialing: { c: "var(--accent-deep)", bg: "var(--accent-soft)" },
  past_due: { c: "#92400e", bg: "#fffbeb" },
  unpaid: { c: "#991b1b", bg: "#fef2f2" },
  canceled: { c: "var(--ink-dim)", bg: "var(--bg-3)" },
};

export default function Customers() {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("loading");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    if (!isConfigured()) { setData(SAMPLE); setMode("sample"); return; }
    const res = await apiFetch("/api/stripe-customers");
    if (res.ok && res.data.configured) { setData(res.data); setMode("live"); }
    else if (res.ok) { setData(SAMPLE); setMode("waiting"); }
    else { setData(SAMPLE); setMode("waiting"); toast.error("Couldn't reach Stripe", res.error); }
  }, []);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const rows = useMemo(() => {
    let list = data?.customers || [];
    if (statusFilter !== "all") {
      list = list.filter((c) => (statusFilter === "none" ? !c.subscription : c.subscription?.status === statusFilter));
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((c) => `${c.email || ""} ${c.name || ""}`.toLowerCase().includes(needle));
    }
    return list;
  }, [data, q, statusFilter]);

  const totalMrr = rows.reduce((s, c) => s + (c.subscription?.mrrCents || 0), 0);
  const badgeMode = mode === "loading" ? "sample" : mode;

  return (
    <>
      <div className="card" style={{ padding: 18, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px" }}>
          <TextInput placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="adm-input" style={{ width: 170 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="past_due">Past due</option>
          <option value="canceled">Canceled</option>
          <option value="none">No subscription</option>
        </select>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
            <strong style={{ color: "var(--ink)" }}>{rows.length}</strong> shown · {fmtMoney(totalMrr)}/mo
          </span>
          <SourceBadge mode={badgeMode} hint={mode === "waiting" ? "Wired — goes live with STRIPE_SECRET_KEY (SETUP.md § Stripe)" : undefined} />
        </div>
      </div>

      {rows.length ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Customer</th><th>Plan</th><th>Status</th><th style={{ textAlign: "right" }}>MRR</th><th>Renews</th><th>Since</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const sub = c.subscription;
                  const tone = STATUS_TONE[sub?.status] || STATUS_TONE.canceled;
                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{c.name || "—"}</div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{c.email || c.id}</div>
                      </td>
                      <td>{sub?.plan || <span style={{ color: "var(--ink-faint)" }}>none</span>}</td>
                      <td>
                        <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em", color: tone.c, background: tone.bg }}>
                          {(sub?.status || "no sub").toUpperCase()}
                        </span>
                        {c.delinquent && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--danger)", fontFamily: "var(--mono)", fontWeight: 800 }}>DELINQUENT</span>}
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "var(--ink)" }}>{sub?.mrrCents ? fmtMoney(sub.mrrCents) : "—"}</td>
                      <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</td>
                      <td style={{ whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 11 }}>{timeAgo(c.created * 1000)}</td>
                      <td>
                        <a
                          className="btn btn-ghost"
                          style={{ padding: "6px 10px", fontSize: 12, textDecoration: "none" }}
                          href={`https://dashboard.stripe.com/customers/${c.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open this customer in Stripe"
                        >
                          Stripe →
                        </a>
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
          icon="◎"
          title={q || statusFilter !== "all" ? "No customers match that filter" : "No customers yet"}
          body={q || statusFilter !== "all" ? "Clear the search box or set status back to All." : "New Stripe customers appear here automatically the moment they pay."}
          action={(q || statusFilter !== "all") && (
            <button className="btn" onClick={() => { setQ(""); setStatusFilter("all"); }}>Clear filters</button>
          )}
        />
      )}
    </>
  );
}
