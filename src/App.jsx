import { useEffect, useState } from "react";
import { useRoute } from "./lib/router.js";
import { useAuth } from "./lib/auth.js";
import { signInDisabled } from "./lib/supabase.js";
import SignIn from "./components/SignIn.jsx";
import ResetPassword from "./components/ResetPassword.jsx";
import AuthGate from "./components/AuthGate.jsx";
import AdminDashboard from "./components/AdminDashboard.jsx";

export default function App() {
  const [route, go] = useRoute();
  const { user, loading, configured } = useAuth();
  // Captured once at mount, BEFORE Supabase consumes the URL hash: invite
  // and password-recovery links must land on the set-password screen.
  const [needsPassword] = useState(() =>
    /type=(invite|recovery)/.test(window.location.hash));

  // After the auth callback (invite accept / email verify), Supabase leaves
  // the user at "/" — forward signed-in users to where they belong.
  useEffect(() => {
    if (loading) return;
    const liveHash = window.location.hash.slice(1) || "/";
    const atEntry = liveHash === "/" || liveHash === "" || liveHash === "/signin";
    if (!atEntry) return;
    if (needsPassword && user) { go("/reset-password"); return; }
    if (user || !configured) go("/dashboard");
  }, [user, loading, configured, route, go, needsPassword]);

  // Sign-in switched off: there is no login screen to land on and no
  // password-reset flow to run. Everything is the dashboard.
  if (signInDisabled()) {
    return (
      <AuthGate go={go}>
        <AdminDashboard go={go} />
      </AuthGate>
    );
  }

  let page;
  if (route === "/signin") page = <SignIn go={go} />;
  else if (route === "/reset-password") page = <ResetPassword go={go} />;
  else if (route.startsWith("/dashboard")) page = <AuthGate go={go}><AdminDashboard go={go} /></AuthGate>;
  else page = <SignIn go={go} />;

  return page;
}
