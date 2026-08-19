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
