import { useEffect, useState } from "react";

// Hash router — same pattern as the platform, minus the legal-path handling
// (the admin console has no public pages).
function readRoute() {
  return window.location.hash.slice(1) || "/";
}

export function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  const go = (r) => {
    window.location.hash = r;
    window.scrollTo(0, 0);
  };
  return [route, go];
}

/** Rewrite the address bar WITHOUT adding a history entry and without moving
 * the page. Used to stamp the page you are on into the URL, so a reload comes
 * back to the same page instead of the landing page. `go()` is wrong for that
 * job: it pushes a history entry, so Back would walk through addresses the
 * user never chose. */
export function stampRoute(r) {
  if (readRoute() === r) return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}#${r}`);
}
