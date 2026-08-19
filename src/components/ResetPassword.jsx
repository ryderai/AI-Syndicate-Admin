import { useState } from "react";
import { updatePassword } from "../lib/auth.js";
import LogoMark from "./LogoMark.jsx";

/* Landed on from the reset-link email (and from invite emails, which we
 * point here so new teammates set their first password). */

export default function ResetPassword({ go }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true);
    const res = await updatePassword(password);
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setDone(true);
  };

  return (
    <div className="auth-splash" style={{ overflowY: "auto" }}>
      <div className="auth-splash-orb" aria-hidden="true" />
      <div className="auth-splash-inner" style={{ width: "min(420px, 92vw)" }}>
        <div className="auth-splash-logo"><LogoMark size={64} animate={false} /></div>
        {done ? (
          <div className="adm-signin-card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "white" }}>Password set ✓</div>
            <button className="btn btn-accent btn-lg" style={{ width: "100%", marginTop: 16, justifyContent: "center" }} onClick={() => go("/dashboard")}>
              Open the console <span className="arr">→</span>
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="adm-signin-card">
            <div style={{ fontSize: 15, fontWeight: 700, color: "white", textAlign: "center", marginBottom: 12 }}>
              Set your password
            </div>
            <label className="adm-signin-label" htmlFor="rp-1">New password</label>
            <input id="rp-1" type="password" autoComplete="new-password" className="adm-signin-input" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label className="adm-signin-label" htmlFor="rp-2" style={{ marginTop: 14 }}>Type it again</label>
            <input id="rp-2" type="password" autoComplete="new-password" className="adm-signin-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {error && <div className="adm-signin-error">{error}</div>}
            <button type="submit" className="btn btn-accent btn-lg" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} disabled={busy}>
              {busy ? "Saving…" : "Save password"} <span className="arr">→</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
