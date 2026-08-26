import { PREVIEW_ACCOUNTS, enterAsPreviewAccount } from "../lib/previewAccounts.js";
import { signInDisabled } from "../lib/supabase.js";
import LogoMark from "./LogoMark.jsx";

/* PICK AN ACCOUNT — the preview console's front door.
 *
 * Built Aug 26 2026 for Ryder, who needs to check the sales view and the owner
 * view against each other without a login in the way.
 *
 * Before this, preview mode signed everybody in as a hard-coded owner with no
 * screen at all. There was no password then either — see the long note at the
 * top of lib/previewAccounts.js for why a picker is not a way past the real
 * login. The one line worth repeating here: this screen cannot exist when
 * sign-in is on.
 *
 * Three things this screen has to say out loud, because a console that looks
 * real and is not is its own kind of lie:
 *   1. Nothing here is real data.
 *   2. Nothing you do here is saved.
 *   3. This is not the real sign-in, and here is the switch that brings it back.
 */
export default function PreviewSignIn() {
  return (
    /* adm-pick-screen turns off the centring that was clipping the logo — see the
       long note on that class in index.css. */
    <div className="auth-splash adm-pick-screen">
      <div className="auth-splash-orb" aria-hidden="true" />
      <div className="auth-splash-orb auth-splash-orb-2" aria-hidden="true" />
      <div className="auth-splash-inner" style={{ width: "min(560px, 94vw)" }}>
        <div className="auth-splash-logo"><LogoMark size={44} animate /></div>
        <div className="auth-splash-wordmark">
          <span className="auth-splash-ai">AI</span>
          <span className="auth-splash-syn">SYNDICATE</span>
        </div>
        <div style={{ marginTop: 4, fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.22em", color: "rgba(255,255,255,0.55)", textAlign: "center" }}>
          COMMAND CONSOLE
        </div>

        <div className="adm-pick-head">
          {/* Two different states land here and they need different words. The
              switch being on is a choice somebody made; missing keys is a setup
              that was never finished. Printing "sign-in is off" for both sent
              people to change an env line that was already right. */}
          <div className="adm-pick-kicker">
            {signInDisabled() ? "SIGN-IN IS OFF · SAMPLE DATA" : "NO KEYS SET · SAMPLE DATA"}
          </div>
          <h1>Who do you want to be?</h1>
          <p>
            Click an account to go straight in. No password, because there is nothing to
            protect — every page runs on sample rows and nothing here reaches a database or
            anybody real. Sign out any time to come back and pick a different one.
          </p>
        </div>

        {/* One button per role, not a dropdown and a Go button: the whole ask was
            "just click if you want to enter as which account". */}
        <div className="adm-pick-list">
          {PREVIEW_ACCOUNTS.map((a) => (
            <button
              key={a.user_id}
              type="button"
              className="adm-pick-card"
              onClick={() => enterAsPreviewAccount(a.user_id)}
            >
              <span className="adm-pick-role">{a.label}</span>
              <span className="adm-pick-name">{a.full_name} · {a.email}</span>
              <span className="adm-pick-blurb">{a.blurb}</span>
              {/* The quiet line is the one that saves you a confused ten minutes:
                  it says whether the account has sample work attached to it. */}
              <span className="adm-pick-detail">{a.detail}</span>
              <span className="adm-pick-go" aria-hidden="true">Enter →</span>
            </button>
          ))}
        </div>

        <div className="adm-pick-foot">
          Remembered per tab, so two tabs can be two people. Edits last until you reload. This
          screen disappears once there is real data to protect —{" "}
          {signInDisabled()
            ? <>set <code>VITE_NO_SIGNIN=false</code> and restart the dev server.</>
            : <>the Supabase keys are not set; add them, see SETUP.md.</>}
        </div>
      </div>
    </div>
  );
}
