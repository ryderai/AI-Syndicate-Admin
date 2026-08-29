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
 *   4. Signed in but the roster check COULD NOT RUN → "we couldn't check your
 *      access", with the database's own reason printed on it.
 *   5. Signed in but NOT on the admin_users roster → hard "not authorized"
 *      screen. This is what keeps platform customers out even though the
 *      console shares the platform's Supabase auth.
 *   6. Signed in + on the roster → render, with membership forwarded.
 *
 * 4 AND 5 USED TO BE THE SAME SCREEN, and that was a real bug rather than a
 * tidy simplification. On Sat Aug 29 2026 the live database had lost one grant
 * (`admin_is_member()` to `authenticated`), so every roster read raised a
 * permission error — and an owner whose row was present, correct and active
 * was told, in confident words, that he was not on the team. An hour went into
 * looking for a missing row that was never missing. A screen that states the
 * wrong cause is worse than one that admits it does not know. */

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

/* The check did not run. NOT the same as being turned away — see the header.
 * The database's own words go on screen, because that string ("permission
 * denied for function admin_is_member") is the entire diagnosis and hiding it
 * is what made this expensive. */
function CheckFailed({ email, reason, go }) {
  return (
    <div className="auth-splash">
      <div className="auth-splash-inner" style={{ maxWidth: 520, textAlign: "center" }}>
        <div className="auth-splash-logo"><LogoMark size={64} animate={false} /></div>
        <h1 style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, color: "white", marginTop: 18 }}>
          We couldn&rsquo;t check your access
        </h1>
        <p style={{ marginTop: 12, color: "rgba(255,255,255,0.75)", fontSize: 14.5, lineHeight: 1.6 }}>
          You&rsquo;re signed in as <strong style={{ color: "white" }}>{email}</strong>. The sign-in
          worked — what failed is the second step, where the console asks the database whether
          you&rsquo;re on the team. <strong style={{ color: "white" }}>This is not the same as being
          turned away.</strong> Your access may be perfectly fine.
        </p>
        <p style={{
          marginTop: 14, padding: "10px 14px", borderRadius: 8,
          background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)",
          color: "rgba(255,255,255,0.9)", fontFamily: "var(--mono)", fontSize: 12.5,
          lineHeight: 1.55, textAlign: "left", wordBreak: "break-word",
        }}>
          {reason}
        </p>
        <p style={{ marginTop: 12, color: "rgba(255,255,255,0.6)", fontSize: 13, lineHeight: 1.6 }}>
          Show that line to whoever runs the database. A &ldquo;permission denied&rdquo; here usually
          means a grant went missing on the <code>admin_users</code> table or on one of the
          <code> admin_is_*</code> functions.
        </p>
        <button
          className="btn btn-lg"
          style={{ marginTop: 22 }}
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
        <button
          className="btn"
          style={{ marginTop: 10, background: "transparent", color: "rgba(255,255,255,0.6)" }}
          onClick={async () => { await signOut(); go("/signin"); }}
        >
          Sign out
        </button>
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
  const { user, loading, configured, membership, membershipError } = useAuth();
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
  /* Order matters: the error case is checked FIRST, because when the read
   * fails membership is also null and the old code fell straight through to
   * "you are not on the roster". */
  if (membershipError) return <CheckFailed email={user.email} reason={membershipError} go={go} />;
  if (!membership) return <NotAuthorized email={user.email} go={go} />;
  return children;
}
