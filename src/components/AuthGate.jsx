import { useEffect, useState } from "react";
import { useAuth, signOut } from "../lib/auth.js";
import { usePreviewAccount } from "../lib/previewAccounts.js";
import PreviewSignIn from "./PreviewSignIn.jsx";
import LogoMark from "./LogoMark.jsx";

/* AuthGate for the ADMIN console. Stricter than the platform's:
 *
 *   1. No Supabase env → PREVIEW mode: pick an account, then render children
 *      with sample data. Before Aug 26 2026 this step signed everybody in as a
 *      hard-coded owner with no screen at all; now you choose which role you
 *      are, so the sales view can actually be tested. There was no password on
 *      this path then and there is none now — see lib/previewAccounts.js.
 *   2. Loading session → brand splash.
 *   3. No user → /signin.
 *   4. Signed in but NOT on the admin_users roster → hard "not authorized"
 *      screen. This is what keeps platform customers out even though the
 *      console shares the platform's Supabase auth.
 *   5. Signed in + on the roster → render, with membership forwarded. */

const LOADING_PHRASES = [
  "Unlocking the command console",
  "Pulling the latest numbers",
  "Checking your access",
];

function LoadingSplash() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  useEffect(() => {
    const tid = setInterval(() => setPhraseIndex((i) => (i + 1) % LOADING_PHRASES.length), 1800);
    return () => clearInterval(tid);
  }, []);
  return (
    <div className="auth-splash">
      <div className="auth-splash-orb" aria-hidden="true" />
      <div className="auth-splash-orb auth-splash-orb-2" aria-hidden="true" />
      <div className="auth-splash-inner">
        <div className="auth-splash-logo"><LogoMark size={88} animate /></div>
        <div className="auth-splash-wordmark">
          <span className="auth-splash-ai">AI</span>
          <span className="auth-splash-syn">SYNDICATE</span>
        </div>
        <div className="auth-splash-phrase" key={phraseIndex}>
          {LOADING_PHRASES[phraseIndex]}
          <span className="auth-splash-dots" aria-hidden="true"><span /><span /><span /></span>
        </div>
        <div className="auth-splash-bar" aria-hidden="true"><span /></div>
      </div>
    </div>
  );
}

function NotAuthorized({ email, go }) {
  return (
    <div className="auth-splash">
      <div className="auth-splash-inner" style={{ maxWidth: 480, textAlign: "center" }}>
        <div className="auth-splash-logo"><LogoMark size={64} animate={false} /></div>
        <h1 style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, color: "white", marginTop: 18 }}>
          This console is team-only
        </h1>
        <p style={{ marginTop: 12, color: "rgba(255,255,255,0.75)", fontSize: 14.5, lineHeight: 1.6 }}>
          You're signed in as <strong style={{ color: "white" }}>{email}</strong>, but that account
          isn't on the AI Syndicate team roster. If you should have access, ask an owner to add you
          from the Team page.
        </p>
        <button
          className="btn btn-lg"
          style={{ marginTop: 24 }}
          onClick={async () => { await signOut(); go("/signin"); }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function AuthGate({ children, go }) {
  const { user, loading, configured, membership } = useAuth();
  /* Read on every render, not only in the preview branch: a hook has to be
   * called the same number of times each time or React loses track of them. */
  const previewAccount = usePreviewAccount();

  useEffect(() => {
    if (!configured || loading) return;
    if (!user) go?.("/signin");
  }, [configured, loading, user, go]);

  /* PREVIEW MODE. Nobody picked an account yet → the picker. It stands in for
   * the sign-in screen, which does not exist on this path. */
  if (!configured) return previewAccount ? children : <PreviewSignIn />;
  if (loading) return <LoadingSplash />;
  if (!user) return null;
  if (membership === undefined) return <LoadingSplash />; // roster check in flight
  if (!membership) return <NotAuthorized email={user.email} go={go} />;
  return children;
}
