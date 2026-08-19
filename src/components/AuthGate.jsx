import { useEffect, useState } from "react";
import { useAuth, signOut } from "../lib/auth.js";
import LogoMark from "./LogoMark.jsx";

/* AuthGate for the ADMIN console. Stricter than the platform's:
 *
 *   1. No Supabase env → PREVIEW mode: render children with sample data.
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

  useEffect(() => {
    if (!configured || loading) return;
    if (!user) go?.("/signin");
  }, [configured, loading, user, go]);

  if (!configured) return children; // preview mode
  if (loading) return <LoadingSplash />;
  if (!user) return null;
  if (membership === undefined) return <LoadingSplash />; // roster check in flight
  if (!membership) return <NotAuthorized email={user.email} go={go} />;
  return children;
}
