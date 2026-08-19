/* Lightweight global toast — emit from anywhere, render via <Toaster />. */

export const toastListeners = [];
let toastNextId = 0;

export function toast(input, type = "info") {
  const t = typeof input === "string"
    ? { id: ++toastNextId, type, title: input }
    : { id: ++toastNextId, type: input.type || type, title: input.title, body: input.body, action: input.action };
  toastListeners.forEach((fn) => fn(t));
  return t.id;
}
toast.success = (msg, body) => toast({ type: "success", title: msg, body });
toast.info = (msg, body) => toast({ type: "info", title: msg, body });
toast.warn = (msg, body) => toast({ type: "warn", title: msg, body });
toast.error = (msg, body) => toast({ type: "error", title: msg, body });

/** Wire any passive button: <button onClick={flash}>Apply</button> → toast echoing the label. */
export function flash(e) {
  const raw = (e.currentTarget?.textContent || "").trim();
  const label = raw.replace(/^[+]\s*/, "").replace(/\s*[→↑↓✕×]+\s*$/, "").trim();
  if (!label) return;
  toast({ type: "success", title: `${label} — done`, body: "AI Syndicate is on it." });
}
