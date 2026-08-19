import { useState } from "react";
import { signInWithPassword, requestPasswordReset } from "../lib/auth.js";
import { isConfigured } from "../lib/supabase.js";
import LogoMark from "./LogoMark.jsx";

/* Admin sign-in. Invite-only — there is deliberately NO sign-up form.
 * New teammates arrive via the Team page invite flow. */

export default function SignIn({ go }) {
  const configured = isConfigured();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setNotice("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Enter a valid email address."); return; }
    if (!password) { setError("Enter your password."); return; }
    setBusy(true);
    const res = await signInWithPassword({ email, password });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    go("/dashboard");
  };

  const forgot = async () => {
    setError(""); setNotice("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Type your email above first, then click reset."); return; }
    setBusy(true);
    const res = await requestPasswordReset(email);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setNotice(`Reset link sent to ${email}. Check your inbox.`);
  };

  return (
    <div className="auth-splash" style={{ overflowY: "auto" }}>
      <div className="auth-splash-orb" aria-hidden="true" />
      <div className="auth-splash-orb auth-splash-orb-2" aria-hidden="true" />
      <div className="auth-splash-inner" style={{ width: "min(420px, 92vw)" }}>
        <div className="auth-splash-logo"><LogoMark size={72} animate /></div>
        <div className="auth-splash-wordmark">
          <span className="auth-splash-ai">AI</span>
          <span className="auth-splash-syn">SYNDICATE</span>
        </div>
        <div style={{ marginTop: 4, fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.22em", color: "rgba(255,255,255,0.55)", textAlign: "center" }}>
          COMMAND CONSOLE
        </div>

        {configured ? (
          <form onSubmit={submit} className="adm-signin-card">
            <label className="adm-signin-label" htmlFor="adm-email">Email</label>
            <input
              id="adm-email"
              type="email"
              autoComplete="email"
              className="adm-signin-input"
              placeholder="you@aisyndicate.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="adm-signin-label" htmlFor="adm-pass" style={{ marginTop: 14 }}>Password</label>
            <input
              id="adm-pass"
              type="password"
              autoComplete="current-password"
              className="adm-signin-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <div className="adm-signin-error">{error}</div>}
            {notice && <div className="adm-signin-notice">{notice}</div>}
            <button type="submit" className="btn btn-accent btn-lg" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"} <span className="arr">→</span>
            </button>
            <button type="button" onClick={forgot} disabled={busy} className="adm-signin-forgot">
              Forgot password? Email me a reset link
            </button>
            <div style={{ marginTop: 16, fontSize: 11.5, color: "rgba(255,255,255,0.45)", textAlign: "center", lineHeight: 1.5 }}>
              Invite-only. No public sign-up — a team owner adds you from the Team page.
            </div>
          </form>
        ) : (
          <div className="adm-signin-card" style={{ textAlign: "center" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#fbbf24" }}>
              PREVIEW MODE
            </div>
            <p style={{ marginTop: 10, fontSize: 13.5, color: "rgba(255,255,255,0.8)", lineHeight: 1.6 }}>
              Supabase keys aren't set yet, so sign-in is off and every page runs on
              clearly-labeled sample data. SETUP.md wires the real thing.
            </p>
            <button className="btn btn-accent btn-lg" style={{ width: "100%", marginTop: 16, justifyContent: "center" }} onClick={() => go("/dashboard")}>
              Open the preview <span className="arr">→</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
