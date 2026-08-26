import { useCallback, useEffect, useState } from "react";
import { listImportBatches, clearImport } from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import { Modal, TextInput, timeAgo } from "./shared.jsx";

/* START OVER — the only screen in this console that deletes in bulk.
 *
 * Ryder, Aug 25 2026: *"i cant have the real google sheet messed up at all, then
 * when we actually start using the admin then i want to delete all that data and
 * import the list fresh again so that everything is up to date."*
 *
 * The first half was already true and always was: the importer reads a
 * DOWNLOADED copy of the spreadsheet, and there is no code path from this
 * console to Google Sheets. Nothing here can write a cell back because nothing
 * here knows how. That is worth saying on the screen, once, where somebody
 * about to press a button called "Delete" can read it.
 *
 * The second half is this. Four rules it is built on:
 *
 * 1. THE NUMBER SHOWN IS THE NUMBER THAT GOES. The preview and the delete are
 *    the same database function called twice — this file never works out what
 *    to delete. On Aug 22 the importer printed "412 already in the pipeline ·
 *    412 rows dropped" and imported all 412, because the screen read one value
 *    and the write path read another. The same mistake here deletes work.
 * 2. WHAT IT REFUSES TO TOUCH IS SHOWN, NOT SUMMED AWAY. "We kept 12" and
 *    "nothing happened" look identical on a screen otherwise.
 * 3. YOU TYPE THE WORD. A destructive action behind a button you can hit by
 *    reflex is a destructive action you will hit by reflex.
 * 4. IT SAYS WHAT CANNOT BE UNDONE, before, not after.
 */

const CONFIRM_WORD = "start over";

export function StartOverPanel({ member, onDone }) {
  const [batches, setBatches] = useState(null);
  const [ask, setAsk] = useState(null);      // { scope, label }
  const isAdmin = member.role === "owner" || member.role === "admin";

  const load = useCallback(async () => {
    /* Caught. Without this a throw left `batches` null and the panel stuck on
     * "Reading the import history…" for good, with nothing on screen saying
     * anything had gone wrong. */
    try {
      setBatches(await listImportBatches());
    } catch (err) {
      setBatches({ rows: [], error: String(err?.message || err) });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!isAdmin) {
    return (
      <div className="adm-sl-empty">
        <strong>Only an owner or an admin can clear an import.</strong>
        <div>A rep who mis-clicks should lose an afternoon, not a list. Ask CJ or Andrew.</div>
      </div>
    );
  }

  if (batches === null) return <div className="adm-sl-loading">Reading the import history…</div>;

  return (
    <>
      <div className="adm-so-safe">
        <strong>Your Google Sheet cannot be harmed by anything on this screen.</strong>
        <div>
          The importer reads a copy you downloaded. Nothing in this console has ever written a cell
          back to Google — there is no code here that knows how. Clearing an import removes rows from
          <em> this </em>console only, and your spreadsheet is untouched either way.
        </div>
      </div>

      {batches.error ? (
        <div className="adm-sl-warn" role="alert">
          <strong>The import history did not load.</strong> {batches.error} Nothing below is counted
          from it — this is not the same as saying there have been no imports.
        </div>
      ) : null}

      <div className="adm-so-head">
        <div>
          <strong>Imports</strong>
          <span>
            {batches.rows.length
              ? `${batches.rows.length} on record. Undo any one of them, or clear everything imported at once.`
              : "Nothing has been imported yet."}
          </span>
        </div>
        <button
          className="btn btn-danger"
          onClick={() => setAsk({ scope: { allImported: true }, label: "everything that was ever imported" })}
        >
          Clear everything imported
        </button>
      </div>

      {batches.rows.length === 0 ? (
        <div className="adm-sl-empty">
          <strong>No imports yet.</strong>
          <div>Import a sheet and each run shows up here, with an undo beside it.</div>
        </div>
      ) : (
        <div className="adm-so-list">
          {batches.rows.map((b) => (
            <div key={b.id} className={`adm-so-row${b.cleared_at ? " cleared" : ""}`}>
              <div className="adm-so-main">
                <div className="adm-so-t">
                  {b.label}
                  {b.cleared_at ? <span className="adm-so-tag">cleared {timeAgo(b.cleared_at)}</span> : null}
                </div>
                <div className="adm-so-s">
                  {[
                    b.source_file,
                    (b.tabs || []).length ? `${b.tabs.length} tab${b.tabs.length === 1 ? "" : "s"}` : null,
                    b.counts?.contacts !== undefined ? `${b.counts.contacts} contacts` : null,
                    b.counts?.firms !== undefined ? `${b.counts.firms} firms` : null,
                    b.created_at ? timeAgo(b.created_at) : null,
                  ].filter(Boolean).join(" · ")}
                </div>
                {/* Planned and landed are both kept. A run that fell short is
                    the one thing worth spotting later, and overwriting the
                    plan with the result is what would hide it. */}
                {b.counts?.planned !== undefined && b.counts?.contacts !== undefined
                  && b.counts.planned !== b.counts.contacts ? (
                    <div className="adm-so-short">
                      Planned {b.counts.planned}, landed {b.counts.contacts}
                      {b.counts.skipped ? ` — ${b.counts.skipped} were already in the pipeline.` : "."}
                    </div>
                  ) : null}
              </div>
              {b.cleared_at ? (
                <span className="adm-so-done">nothing left to clear</span>
              ) : (
                <button className="btn btn-sm" onClick={() => setAsk({ scope: { batchId: b.id }, label: b.label })}>
                  Undo this import
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {ask && (
        <ClearModal
          scope={ask.scope} label={ask.label} role={member.role}
          onClose={() => setAsk(null)}
          onCleared={async () => { setAsk(null); await load(); await onDone(); }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Ask the database what would happen, show exactly that, then ask it to do it.
 *  This component never decides anything itself. */
function ClearModal({ scope, label, role, onClose, onCleared }) {
  const [plan, setPlan] = useState(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    clearImport({ ...scope, dryRun: true, role }).then((res) => { if (alive) setPlan(res); })
      .catch((err) => { if (alive) setPlan({ ok: false, error: String(err?.message || err) }); });
    return () => { alive = false; };
  }, [scope, role]);

  const go = async () => {
    setBusy(true);
    let res;
    /* try/finally, so a rejection cannot leave the button reading "Clearing…"
     * for ever with no error and no way to tell whether rows went. */
    try {
      res = await clearImport({
        ...scope, dryRun: false, role,
        /* WHAT THE PERSON WAS SHOWN. The database refuses if the answer has
         * changed since the preview — two RPCs are two transactions, and
         * without this the button could say "Delete 1" while four went. */
        expectLeads: plan.leads,
      });
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    } finally {
      setBusy(false);
    }
    if (!res.ok) {
      toast.error(res.stale ? "It changed while you were looking at it" : "Nothing was cleared", res.error);
      /* Re-ask, so the screen is showing the new truth rather than the promise
       * that just failed. */
      if (res.stale) {
        setTyped("");
        const again = await clearImport({ ...scope, dryRun: true, role }).catch(() => null);
        if (again) setPlan(again);
      }
      return;
    }
    /* Reported from what the DELETE returned, not from the preview. If the two
     * ever disagree, the person is told the truth rather than the promise. */
    toast.success(
      `Cleared ${res.leads} contact${res.leads === 1 ? "" : "s"}`,
      res.keptTotal
        ? `${res.companies} firm${res.companies === 1 ? "" : "s"} and ${res.lists} list${res.lists === 1 ? "" : "s"} went with them. ${res.keptTotal} were left alone — they were not test data.`
        : `${res.companies} firm${res.companies === 1 ? "" : "s"} and ${res.lists} list${res.lists === 1 ? "" : "s"} went with them.`,
    );
    await onCleared();
  };

  const ready = typed.trim().toLowerCase() === CONFIRM_WORD && plan?.ok && plan.leads > 0;

  return (
    <Modal
      open onClose={onClose} kicker="SALES" width={620}
      title={`Clear ${label}`}
      footer={<>
        {/* Disabled mid-delete. It used to look like a cancel and was not one:
            the dialog closed and the delete carried on regardless. */}
        <button className="btn" onClick={onClose} disabled={busy}>Leave it alone</button>
        <button className="btn btn-danger" disabled={!ready || busy} onClick={go}>
          {busy ? "Clearing…" : plan?.ok ? `Delete ${plan.leads} contact${plan.leads === 1 ? "" : "s"}` : "Delete"}
        </button>
      </>}
    >
      {!plan ? (
        <div className="adm-sl-loading">Working out exactly what would go…</div>
      ) : !plan.ok ? (
        <div className="adm-sl-warn" role="alert">
          <strong>This cannot be worked out.</strong> {plan.error} Nothing has been changed.
        </div>
      ) : (
        <>
          <div className="adm-so-count">
            <div><b>{plan.leads}</b> contacts</div>
            <div><b>{plan.companies}</b> firms left with nobody</div>
            <div><b>{plan.lists}</b> lists left empty</div>
          </div>

          <p className="adm-so-p">
            Worked out by the database, not by this screen — and the button below asks the same
            question again to do it, so what you are reading is what will go.
            {plan.considered
              ? ` It looked at ${plan.considered} row${plan.considered === 1 ? "" : "s"}.`
              : " It found nothing in scope to look at."}
          </p>

          {plan.companiesKept > 0 && (
            <div className="adm-so-keep">
              <strong>{plan.companiesKept} firm{plan.companiesKept === 1 ? "" : "s"} will be left standing with nobody at {plan.companiesKept === 1 ? "it" : "them"}.</strong>
              <div className="adm-so-keep-n">
                {plan.companiesKept === 1 ? "It was" : "They were"} built by hand rather than by an
                import, so {plan.companiesKept === 1 ? "its" : "their"} typed details and site score
                are not this screen&rsquo;s to throw away. Delete {plan.companiesKept === 1 ? "it" : "them"} from
                the Firms view if you want {plan.companiesKept === 1 ? "it" : "them"} gone.
              </div>
            </div>
          )}

          {plan.keptTotal > 0 && (
            <div className="adm-so-keep">
              <strong>{plan.keptTotal} will be left exactly where they are:</strong>
              <ul>
                {Object.entries(plan.kept).map(([why, n]) => (
                  <li key={why}><b>{n}</b> — {why}</li>
                ))}
              </ul>
              <div className="adm-so-keep-n">
                These are refused whatever this screen is asked for. They are not test data.
              </div>
            </div>
          )}

          {plan.leads === 0 ? (
            <div className="adm-sl-empty">
              <strong>There is nothing here to clear.</strong>
              <div>
                {plan.keptTotal
                  ? "Everything in scope is real work and is being kept."
                  : "No imported contacts match. Nothing will be deleted."}
              </div>
            </div>
          ) : (
            <>
              <div className="adm-so-warn">
                <strong>This cannot be undone from here.</strong>
                <div>
                  Deleting a contact takes their whole timeline with them — every call, email, note
                  and stage change logged against them — and any proposal still in draft. Your
                  spreadsheet is not touched, so re-importing brings the rows back; anything typed
                  into this console since the import does not come back.
                </div>
              </div>

              <label className="adm-so-confirm">
                <span>Type <b>{CONFIRM_WORD}</b> to turn the button on</span>
                <TextInput
                  value={typed} onChange={(e) => setTyped(e.target.value)}
                  placeholder={CONFIRM_WORD} autoFocus
                />
              </label>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export default StartOverPanel;
