import { useEffect, useState } from "react";
import { getHealth } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import { toast } from "../../lib/toast.js";
import { Explainer, SectionHeader } from "./shared.jsx";

/* Settings — the truth table. Which integration is live, which is waiting
 * on a key, and exactly what to paste where. Never shows secret values. */

const INTEGRATIONS = [
  {
    key: "supabase",
    name: "Supabase (login + database)",
    what: "Sign-in, roles, and every table: leads, clients, tasks, tickets, the Brain.",
    envs: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    setup: "SETUP.md § 1 — copy 3 values from the platform's Vercel project (Ryder has access), run one SQL file.",
  },
  {
    key: "stripe",
    name: "Stripe (revenue + customers)",
    what: "MRR, the revenue chart, recent payments, and the whole Customers page.",
    envs: ["STRIPE_SECRET_KEY"],
    setup: "SETUP.md § 3 — create a read-only restricted key in the Stripe dashboard. 5 minutes.",
  },
  {
    key: "ai",
    name: "Anthropic (AI drafting)",
    what: "Email drafts, ticket replies, lead outreach, and the Brain test chat.",
    envs: ["ANTHROPIC_API_KEY"],
    setup: "SETUP.md § 4 — the platform already has this key in its Vercel env; copy it over.",
  },
  {
    key: "gmail",
    name: "Google (Gmail inbox)",
    what: "The Inbox page — each teammate connects their own Gmail.",
    envs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    setup: "SETUP.md § 5 — one Google Cloud OAuth app, click-by-click. ~15 minutes, once.",
  },
  {
    key: "usageIngest",
    name: "Token usage feed",
    what: "The AI-spend numbers on Overview, fed by the platform's backend.",
    envs: ["USAGE_INGEST_KEY"],
    setup: "SETUP.md § 6 — invent a long random secret, set it here, hand the endpoint + secret to the platform backend.",
  },
];

export default function SettingsPage({ member }) {
  const [health, setHealth] = useState(null);

  const load = () => getHealth(true).then(setHealth);
  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, []);

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast.success("Copied", text); }
    catch { toast.warn("Couldn't copy — select it by hand."); }
  };

  const liveCount = health ? INTEGRATIONS.filter((i) => health[i.key]).length : 0;

  return (
    <>
      <Explainer
        icon="🔧"
        kicker="THE TRUTH TABLE"
        title={health ? `${liveCount} of ${INTEGRATIONS.length} integrations live` : "Checking integrations…"}
        body="Every screen in this console works today — cards without a key show WAITING ON KEY and switch to LIVE the moment the key lands in Vercel. This page is the checklist. No secret is ever shown or stored here."
      />

      <div style={{ display: "grid", gap: 14 }}>
        {INTEGRATIONS.map((intg) => {
          const live = Boolean(health?.[intg.key]);
          return (
            <div key={intg.key} className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ minWidth: 0, flex: "1 1 300px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 99, background: live ? "#00b833" : "var(--warn)", boxShadow: `0 0 0 4px ${live ? "rgba(0,184,51,0.15)" : "rgba(255,159,67,0.15)"}` }} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>{intg.name}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", color: live ? "#006b1a" : "#92400e", background: live ? "var(--success-soft)" : "#fffbeb", padding: "2px 8px", borderRadius: 4 }}>
                      {live ? "LIVE" : "WAITING ON KEY"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.55 }}>{intg.what}</div>
                  {!live && <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginTop: 4 }}>{intg.setup}</div>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {intg.envs.map((env) => (
                    <button key={env} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 11, fontFamily: "var(--mono)", justifyContent: "space-between", gap: 10 }} onClick={() => copy(env)} title="Copy the variable name">
                      {env} <span style={{ color: "var(--ink-faint)" }}>⧉</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <SectionHeader kicker="Where keys go" title="One place: Vercel → the admin project → Settings → Environment Variables" subtitle="Paste each value there, click Save, then Redeploy. Keys never go in the code, never in Notion, never in this page. The full click-by-click is in SETUP.md in the repo." />

      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", marginBottom: 8 }}>Session</div>
        <dl className="adm-kv" style={{ margin: 0 }}>
          <dt>Signed in as</dt><dd>{member.email}</dd>
          <dt>Role</dt><dd style={{ textTransform: "capitalize" }}>{member.role}</dd>
          <dt>Mode</dt><dd>{isConfigured() ? "Connected to Supabase" : "Preview (sample data, nothing persists)"}</dd>
        </dl>
      </div>
    </>
  );
}
