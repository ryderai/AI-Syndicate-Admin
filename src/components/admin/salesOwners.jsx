import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import { EmptyState } from "./shared.jsx";

/* EVERY NAME IN THE SHEET GETS AN ACCOUNT — 31 Aug 2026.
 *
 * The sheet went in on Aug 30: 3,663 people, and the Sales Owner text kept
 * exactly as it was typed. What did not go in is the reps. Nine spellings, no
 * accounts, so every claim CJ's floor had built up came in as nobody's.
 *
 * This screen makes the accounts and hands the rows back. It NEVER sends an
 * email — see lib/sales-owners.js for why that matters here. It never takes a
 * lead off a rep who already has one, and it never guesses which of two people
 * a first name meant.
 *
 * Pressing the button twice is safe: an account that exists is skipped, and a
 * row that already has an owner is left alone. */
export default function SalesOwnersPanel({ member }) {
  const [state, setState] = useState({ loading: true });
  const [emails, setEmails] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async () => {
    setState({ loading: true });
    const res = await apiFetch("/api/sales-owners");
    if (!res.ok) { setState({ loading: false, error: res.error }); return; }
    setState({ loading: false, ...res.data });
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setBusy(true);
    const res = await apiFetch("/api/sales-owners", { method: "POST", body: { dryRun: false, emails } });
    setBusy(false);
    if (!res.ok) { toast.error("It did not finish", res.error); return; }
    setDone(res.data);
    toast.success(
      `${res.data.created.length} accounts made`,
      `${res.data.leadsClaimed} rows handed back to the rep who worked them.`,
    );
    load();
  };

  if (state.loading) return <div className="adm-db-warn">Reading every lead row…</div>;
  if (state.error) {
    return <div className="adm-db-warn">This could not be read: {state.error}</div>;
  }

  const canRun = member?.role === "owner" || member?.role === "admin";

  return (
    <div style={{ padding: 2 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>The reps on the sheet</h3>
      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, margin: "0 0 14px" }}>
        Read from {Number(state.leadsRead || 0).toLocaleString()} lead rows just now — not from the
        spreadsheet. Making an account here <strong>sends nobody an email</strong>. Anyone without a
        real address gets a placeholder one that can never receive mail, so their claimed rows land
        back on them today and a proper invite can go out whenever you have their address.
      </p>
      {state.truncated ? <div className="adm-db-warn" style={{ marginBottom: 12 }}>{state.truncated}</div> : null}

      {!state.wouldCreate?.length && !state.alreadyHaveAnAccount?.length ? (
        <EmptyState icon="👤" title="No Sales Owner names on any row"
          body="Nothing on the sheet says who owns it, so there is nobody to create." />
      ) : null}

      {state.wouldCreate?.length ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px" }}>
            {state.wouldCreate.length} accounts to make
          </div>
          <table className="adm-table" style={{ marginBottom: 16 }}>
            <thead><tr><th>Rep</th><th>Spelled</th><th>Rows</th><th>Email (optional)</th></tr></thead>
            <tbody>
              {state.wouldCreate.map((p) => (
                <tr key={p.fullName}>
                  <td><strong>{p.fullName}</strong></td>
                  <td style={{ fontSize: 12, color: "var(--ink-2)" }}>{p.spellings.join(" · ")}</td>
                  <td>{p.rows}</td>
                  <td>
                    <input
                      className="adm-input" style={{ minWidth: 220 }}
                      placeholder={p.email}
                      value={emails[p.fullName] || ""}
                      onChange={(e) => setEmails((m) => ({ ...m, [p.fullName]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {state.alreadyHaveAnAccount?.length ? (
        <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.7, marginBottom: 14 }}>
          <strong>Already here:</strong>{" "}
          {state.alreadyHaveAnAccount.map((a) => (
            a.matchedAs
              ? `${a.label} → ${a.matchedAs} (${a.rows} rows, matched by ${a.how})`
              : `${a.label} — ${a.rows} rows, and more than one person could be meant (${(a.candidates || []).join(", ")}), so nothing was decided`
          )).join(" · ")}
        </div>
      ) : null}

      <div style={{ fontSize: 13, marginBottom: 14 }}>
        <strong>{Number(state.claimableRightNow || 0).toLocaleString()}</strong> rows can be handed
        back the moment those accounts exist.{" "}
        {state.skipped ? `${Number(state.skipped.alreadyOwned || 0).toLocaleString()} already have an owner and will not be touched.` : null}
      </div>

      {state.ambiguousNames?.length ? (
        <div className="adm-db-warn" style={{ marginBottom: 14 }}>
          These spellings could be more than one person, so nothing is guessed:{" "}
          {state.ambiguousNames.map((a) => `"${a.name}" (${a.rows} rows — could be ${a.couldBe.join(" or ")})`).join(" · ")}
        </div>
      ) : null}

      <button className="btn btn-accent" onClick={run} disabled={busy || !canRun || !state.wouldCreate?.length}>
        {busy ? "Making the accounts…" : `Make ${state.wouldCreate?.length || 0} accounts and hand the rows back`}
      </button>
      {!canRun ? <span style={{ marginLeft: 10, fontSize: 12, color: "var(--ink-2)" }}>Only an owner or an admin can do this.</span> : null}

      {done ? (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 10, border: "1px solid var(--rule)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {done.created.length} accounts made · {Number(done.leadsClaimed).toLocaleString()} rows handed back
          </div>
          {done.leadsClaimed !== done.leadsPlanned ? (
            <div className="adm-db-warn">
              {done.leadsPlanned - done.leadsClaimed} of the {done.leadsPlanned} planned rows were not
              written. A row that gained an owner between reading and writing is left with that owner
              on purpose. Press the button again to see what is left.
            </div>
          ) : null}
          {done.failed?.length ? (
            <div className="adm-db-warn" style={{ marginTop: 8 }}>
              {done.failed.length} accounts could not be made:
              <ul style={{ margin: "6px 0 0 16px" }}>
                {done.failed.map((f, i) => <li key={i}>{f.fullName} ({f.email}) — {f.why}</li>)}
              </ul>
            </div>
          ) : null}
          {done.unresolved?.length ? (
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 8, lineHeight: 1.7 }}>
              Still unclaimed because the name matched nobody or more than one person:{" "}
              {done.unresolved.map((u) => `"${u.name}" (${u.rows} rows, ${u.how})`).join(" · ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
