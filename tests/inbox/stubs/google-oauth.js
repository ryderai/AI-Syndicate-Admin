/* Fake Gmail. Records every call so a test can assert exactly what we asked
 * Google to do — and prove we never asked it to delete anything. */
export const GMAIL = { calls: [], labels: [], nextCreateFails409: false };

export function accountNeedsReconnect(scope) {
  return !String(scope || "").includes("https://www.googleapis.com/auth/gmail.modify");
}
export async function accessTokenFromRefresh() { return "TOKEN"; }

export async function gmailFetch(token, path, init = {}) {
  GMAIL.calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
  if (path === "/labels" && (init.method || "GET") === "GET") return { labels: GMAIL.labels };
  if (path === "/labels" && init.method === "POST") {
    const name = JSON.parse(init.body).name;
    if (GMAIL.nextCreateFails409) {
      GMAIL.nextCreateFails409 = false;
      GMAIL.labels.push({ id: `id_${name}`, name });   // the other person's create won the race
      const err = new Error("Label name exists or conflict");
      err.statusCode = 409;
      throw err;
    }
    const label = { id: `id_${name}`, name };
    GMAIL.labels.push(label);
    return label;
  }
  if (path.startsWith("/threads?")) return { threads: [] };
  if (path.endsWith("/modify")) return { ok: true };
  if (path === "/messages/send") return { id: "m_sent", threadId: JSON.parse(init.body).threadId || "t_new" };
  return {};
}
