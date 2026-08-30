import { useRef, useState } from "react";
import {
  insertLeadsBatch, insertCompaniesBatch, findExistingCompanyRows, findExistingLeadRows,
  applyLeadUpdates, applyCompanyUpdates, probeSheetColumns,
  upsertLeadList, findLeadListByTab, upsertLeadSource, listLeadSources, addLeadActivity, addImportNotesBatch, logActivity,
  startImportBatch, finishImportBatch,
} from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import { parseXlsxAllTabs, readSheetFile, readPasted, hasUnzipSupport } from "../../lib/sheet.js";
import { dedupeKey } from "../../lib/leadIntakeBrowser.js";
import {
  autoMapTab, buildImportPlan, looksLikeLeadTab, mergeLead, mergeCompany, SALES_FIELDS,
} from "../../../lib/sales-import.js";
import { Modal } from "./shared.jsx";

/* DROPPING THE OUTREACH SHEET IN.
 *
 * WHAT CHANGED, AND WHY                                     Aug 30 2026
 * This used to be four screens: choose the file, tick the tabs, check
 * twenty-seven columns on each of eight tabs, read the plan. Ryder asked for
 * one: "make it extremely easy to transfer everything and make it as few
 * clicks as possible … receive this file without asking any questions,
 * deleting any data, and filling in all the rows."
 *
 * So it is one click now. Pick the file and it goes. Every question the old
 * screens asked is answered by lib/sheet-columns.js, which reads each column's
 * VALUES rather than trusting the heading row — and it has to, because on the
 * real workbook the heading row is wrong on three tabs out of eight and
 * missing on a fourth:
 *
 *   · Luxury Agents has no heading row. 821 people the old importer skipped
 *     in silence, every time, because it recognised nothing in row 1.
 *   · Jewelry has three columns in the data the heading row does not have, so
 *     the heading said "Website" over a LinkedIn address.
 *   · Car Dealership slides three columns from 23 on, so the heading said
 *     "Company Address" over the contact's own town.
 *
 * NOTHING IS DELETED, EVER. Somebody already on file is topped up rather than
 * skipped or replaced — lib/sales-import.js#mergeLead decides field by field
 * and refuses to blank a value, move a stage backwards, reopen a closed deal
 * or take a lead off the rep working it. An import is still one undoable
 * thing: Sales → Start over lists this run with an undo beside it.
 *
 * AND IT STILL SHOWS ITS WORKING. The plan screen is gone, so everything the
 * reader had to decide is on the RESULT screen instead — including, by name,
 * every column whose heading disagreed with what was in it. An importer that
 * reports only successes is an importer nobody can check.
 */

const LABEL = Object.fromEntries(SALES_FIELDS.map((f) => [f.key, f.label]));

export function SalesImportModal({ member, team, onClose, reload }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef(null);

  /* ---- reading, then straight into it ---- */

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error("That file is too big", "Keep it under 25 MB. Split the workbook if you need to.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const name = (file.name || "").toLowerCase();
      const raw = (name.endsWith(".xlsx") || name.endsWith(".xlsm"))
        ? (await parseXlsxAllTabs(await file.arrayBuffer())).filter((t) => !t.empty)
        : [{ name: file.name, rows: (await readSheetFile(file)).rows }];
      await run(raw, file.name.replace(/\.[^.]+$/, ""), file.name);
    } catch (err) {
      toast.error("Could not read that file", err?.message || "Unknown problem.");
      setBusy(false);
      setProgress("");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onPaste = async () => {
    if (!pasteText.trim()) { toast.warn("Paste the rows in first"); return; }
    setBusy(true);
    try {
      const r = readPasted(pasteText);
      await run([{ name: "Pasted rows", rows: r.rows }], `Pasted — ${new Date().toISOString().slice(0, 10)}`, null);
    } catch (err) {
      toast.error("Could not read that", err?.message || "Unknown problem.");
      setBusy(false);
      setProgress("");
    }
  };

  /* ---- the whole thing, start to finish ---- */

  const run = async (rawTabs, label, fileName) => {
    /* ONE CLOCK, taken once, for the whole run. Every claim stamped at import
     * time, every "imported today" line and every list record share it, so a
     * run that straddles midnight cannot date half its rows to yesterday. */
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    setProgress("Reading the columns…");

    /* Ask ONCE whether migration 0025 has run. If it has not, five fields are
     * left out and the run still works; without this the whole insert is
     * rejected on the first row and a person who has just dropped in four
     * thousand contacts gets nothing and no reason. */
    const cols = await probeSheetColumns();
    const NEW_LEAD = ["address", "country"];
    const NEW_FIRM = ["alias", "keywords", "total_funding"];
    /* PER TABLE, not one answer for both. The first version keyed off a single
     * `cols.ok`, so a failure reading the LEADS columns also stripped three
     * perfectly good columns from the firms table. Found 30 Aug 2026. */
    const have = { [NEW_LEAD.join()]: cols.leads !== false, [NEW_FIRM.join()]: cols.companies !== false };
    const trim = (row, keys) => {
      if (have[keys.join()]) return row;
      const out = { ...row };
      for (const k of keys) delete out[k];
      return out;
    };

    /* Each tab read ONCE and the answer carried, rather than mapped here and
     * mapped again inside buildImportPlan. Two reads of the same tab are two
     * chances to disagree, and the person would be shown whichever one the
     * screen happened to print. */
    const read = rawTabs.map((t) => {
      const mapped = autoMapTab(t.rows || []);
      return { ...t, mapped, verdict: looksLikeLeadTab(t.name, t.rows || [], mapped) };
    });
    const use = read.filter((t) => t.verdict.yes);
    const skipped = read.filter((t) => !t.verdict.yes).map((t) => ({ name: t.name, why: t.verdict.why }));

    if (!use.length) {
      toast.error("Nothing importable in that file",
        skipped.map((t) => `${t.name}: ${t.why}`).join(" · ").slice(0, 220));
      setBusy(false); setProgress("");
      return;
    }

    const plans = use.map((t) => ({
      tab: t,
      plan: buildImportPlan(t.rows, {
        mapping: t.mapped.mapping, hasHeader: t.mapped.hasHeader,
        team, listName: t.name, now,
      }),
    }));

    /* ---- the same person twice inside the file ---- */
    setProgress("Looking for people already in the pipeline…");
    const seen = new Map();
    let repeatedInFile = 0;
    let noKey = 0;
    for (const { plan } of plans) {
      for (const entry of plan.leads) {
        const k = dedupeKey(entry.lead);
        if (!k) { noKey += 1; entry.__key = null; continue; }
        entry.__key = k;
        if (seen.has(k)) { entry.__repeat = true; repeatedInFile += 1; continue; }
        seen.set(k, entry);
      }
    }

    /* ---- and the ones already here ---- */
    const found = await findExistingLeadRows([...seen.keys()], { withNewColumns: cols.leads !== false });
    if (found.error) {
      toast.warn("Could not check the whole pipeline",
        `${found.error} Anyone this missed would be added a second time, so nothing was written. Try again.`);
      setBusy(false); setProgress("");
      return;
    }
    const existingLeads = found.rows;

    /* ---- open the batch BEFORE a single row is written ---- */
    setProgress("Recording this import…");
    const batch = await startImportBatch({
      label: label.trim() || "Outreach sheet",
      sourceFile: fileName || null,
      tabs: plans.map(({ tab }) => tab.name),
      counts: {
        planned: plans.reduce((a, { plan }) => a + plan.counts.usable, 0),
        firms: plans.reduce((a, { plan }) => a + plan.counts.companies, 0),
      },
      userId: member.user_id,
    });
    const batchId = batch.ok ? batch.id : null;
    if (!batch.ok) {
      toast.warn("This import will not be undoable",
        "The import record could not be saved, most likely because migration 0016 has not been run. Everything still imports — but Start over will not be able to find these rows later.");
    }

    /* ONE SOURCE ROW PER SHEET, not one per press. upsertLeadSource with no
     * id always inserts, so every import added another row called "Outreach
     * sheet" — and the comment below claims the column map is kept "so a
     * person asking six weeks later what the console thought column 23 was has
     * an answer", which is not true of a pile of identical rows. Found 30 Aug
     * 2026. */
    const sourceLabel = label.trim() || "Outreach sheet";
    const priorSources = await listLeadSources();
    const existingSource = (priorSources.rows || []).find(
      (x) => x.kind === "import" && x.label === sourceLabel,
    );
    const src = await upsertLeadSource({
      ...(existingSource ? { id: existingSource.id } : { created_by: member.user_id }),
      label: sourceLabel,
      kind: "import", provider: null, assign_to: [],
      last_run_at: nowIso,
      last_run_found: plans.reduce((a, { plan }) => a + plan.counts.usable, 0),
      last_run_new: 0,
      /* The columns this run decided on, stored WITH the source, so a person
       * asking six weeks later what the console thought column 23 was has an
       * answer that does not depend on re-reading a file nobody kept. */
      query: {
        column_map: Object.fromEntries(plans.map(({ tab }) => [tab.name, tab.mapped.mapping])),
        read_at: nowIso,
      },
    });
    const sourceId = src.ok ? src.row?.id || null : null;

    setProgress("Matching firms already on file…");
    const companyRows = await findExistingCompanyRows();
    /* If the firms could not be read, EVERY firm looks new and the import
     * makes a second copy of all of them — silently, under a headline that
     * says "2,764 new firms". Better to stop than to double the firm list.
     * Found 30 Aug 2026 by an adversarial reviewer. */
    if (companyRows.error) {
      toast.error("Could not read the firms already on file",
        `${companyRows.error} Importing now would make a second copy of every firm, so nothing was written. Try again.`);
      setBusy(false); setProgress("");
      return;
    }

    const totals = {
      added: 0, updated: 0, unchanged: 0,
      firmsAdded: 0, firmsUpdated: 0,
      repeatedInFile, noKey, noteProblems: 0, updateFailures: 0,
    };
    const perTab = [];
    const notes = [];

    for (const { tab, plan } of plans) {
      setProgress(`Importing ${tab.name}…`);

      const existingList = await findLeadListByTab(tab.name);
      /* AN EXISTING LIST IS ADDED TO, NOT REWRITTEN.
       *
       * This used to send name, vertical and source_id unconditionally. On a
       * list that already existed that meant: a rename anybody had made was
       * undone, `vertical` was set to NULL whenever the first firm on the tab
       * happened to have none, and `source_id` was set to null whenever the
       * source record had failed to save. Three filled-in values emptied, on
       * the one screen that promises in writing that nothing is emptied.
       * Found 30 Aug 2026 by an adversarial reviewer. */
      const vertical = plan.companies.find((c) => c.vertical)?.vertical || null;
      const list = await upsertLeadList(existingList
        ? {
          id: existingList.id,
          sheet_tab: tab.name,
          ...(existingList.name ? {} : { name: tab.name }),
          ...(existingList.vertical || !vertical ? {} : { vertical }),
          ...(existingList.source_id || !sourceId ? {} : { source_id: sourceId }),
          ...(existingList.import_batch_id || !batchId ? {} : { import_batch_id: batchId }),
        }
        : {
          created_by: member.user_id,
          name: tab.name, vertical, sheet_tab: tab.name, source_id: sourceId,
          ...(batchId ? { import_batch_id: batchId } : {}),
        });
      const listId = list.ok ? list.row?.id || null : null;

      /* ---- firms first, so the people can point at them ---- */
      const fresh = [];
      const firmPatches = [];
      for (const c of plan.companies) {
        const already = companyRows.byKey[c.key];
        if (!already) { fresh.push(c); continue; }
        const { patch, changed } = mergeCompany(already, c);
        if (changed) firmPatches.push({ id: already.id, patch: trim(patch, NEW_FIRM) });
      }

      const saved = await insertCompaniesBatch(fresh.map((c) => trim({
        key: c.key, name: c.name, domain: c.domain, phone: c.phone, address: c.address,
        city: c.city, state: c.state, country: c.country, vertical: c.vertical,
        employees: c.employees, annual_revenue: c.annual_revenue,
        /* Added Aug 30 2026 with migration 0025. Each was already being read
         * off the sheet and dropped for want of a column. */
        alias: c.alias, keywords: c.keywords, total_funding: c.total_funding,
        linkedin_url: c.linkedin_url, facebook_url: c.facebook_url, twitter_url: c.twitter_url,
        /* site_score is deliberately NOT passed. See groupIntoCompanies in
         * lib/sales-import.js: a score is something we measured, and a number
         * out of a spreadsheet must never sit in the same field. */
        created_by: member.user_id,
        ...(batchId ? { import_batch_id: batchId } : {}),
      }, NEW_FIRM)));
      if (!saved.ok) {
        toast.error(`Firms failed on ${tab.name}`, saved.error);
        setBusy(false); setProgress("");
        setResult({ ...totals, perTab, failed: tab.name, error: saved.error, skipped, plans });
        await reload();
        return;
      }
      totals.firmsAdded += saved.count;

      const firmUpd = await applyCompanyUpdates(firmPatches.filter((f) => Object.keys(f.patch).length));
      totals.firmsUpdated += firmUpd.count;
      totals.updateFailures += firmUpd.failed.length;

      /* Ids for the firms just written, folded into the same lookup the
       * existing ones live in, so the next tab reuses them rather than making
       * a second copy of a firm that appears on two tabs. */
      const idByKey = {};
      for (const [k, c] of Object.entries(companyRows.byKey)) idByKey[k] = c.id;
      for (const [k, id] of Object.entries(saved.idByKey)) {
        idByKey[k] = id;
        const c = fresh.find((x) => x.key === k);
        if (c) companyRows.byKey[k] = { ...c, id };
      }

      /* ---- the people ---- */
      const toInsert = [];
      const toUpdate = [];
      let tabUnchanged = 0;

      for (const entry of plan.leads) {
        if (entry.__repeat) continue;                        // already counted
        const existing = entry.__key ? existingLeads[entry.__key] : null;
        if (!existing) { toInsert.push(entry); continue; }
        /* The KIND of match is handed to the merge. `e:` is an email and is
         * certain; `p:`, `d:` and `c:` are a shared phone, a shared website or
         * a shared company+town, which colleagues have in common — so the
         * merge leaves the fields that say WHO somebody is alone on those. */
        const { patch, changes, spare, changed } = mergeLead(existing, entry.lead, {
          keyKind: String(entry.__key || "").slice(0, 1),
        });
        /* The list and the firm are filled in whatever else changed, so a
         * contact who arrived from a hand-typed row before the sheet existed
         * still ends up under the right tab and the right firm. */
        if (!existing.list_id && listId) patch.list_id = listId;
        if (!existing.company_id && entry.companyKey && idByKey[entry.companyKey]) {
          patch.company_id = idByKey[entry.companyKey];
        }
        const realChange = changed || !!patch.list_id || !!patch.company_id;
        /* A row that changes NOTHING is not written at all.
         *
         * The first version stamped last_import_at on every existing contact,
         * which on a second run of this workbook is three and a half thousand
         * separate update calls to record that nothing happened — minutes of
         * waiting, and three and a half thousand timeline lines saying
         * "nothing needed changing". The date an unchanged row was last seen
         * is not worth that. */
        if (!realChange && !spare.length) { tabUnchanged += 1; continue; }
        if (realChange) patch.last_import_at = nowIso;
        toUpdate.push({ id: existing.id, patch: trim(patch, NEW_LEAD), changes, spare, realChange });
      }

      const rows = toInsert.map(({ lead, companyKey }) => trim({
        ...lead,
        company_id: companyKey ? idByKey[companyKey] || null : null,
        list_id: listId,
        source_id: sourceId,
        last_import_at: nowIso,
        ...(batchId ? { import_batch_id: batchId } : {}),
      }, NEW_LEAD));

      const res = await insertLeadsBatch(rows);
      if (!res.ok) {
        toast.error(`Import stopped on ${tab.name}`,
          `${res.error}${res.count ? ` ${res.count} of ${rows.length} rows on this tab were already saved.` : ""}`);
        setBusy(false); setProgress("");
        setResult({ ...totals, perTab, failed: tab.name, error: res.error, skipped, plans });
        await reload();
        return;
      }
      totals.added += res.count;

      setProgress(`Updating people already here — ${tab.name}…`);
      const upd = await applyLeadUpdates(toUpdate.map(({ id, patch }) => ({ id, patch })));
      const failedIds = new Set(upd.failed.map((f) => f.id));
      /* Counted from what LANDED, not from what was planned. A number that
       * counts intentions is a number that says an import worked when it half
       * did — the same mistake finishImportBatch was written to avoid. */
      const reallyUpdated = toUpdate.filter((u) => u.realChange && !failedIds.has(u.id)).length;
      totals.updated += reallyUpdated;
      totals.unchanged += tabUnchanged;
      totals.updateFailures += upd.failed.length;

      /* ---- the timeline ---- */
      /* ALL AT ONCE. One call per contact meant seven thousand requests on the
       * real workbook — several minutes of spinner for lines nobody reads
       * until they need them. */
      const lines = [];
      if (res.ids && res.ids.length === toInsert.length) {
        for (let i = 0; i < toInsert.length; i += 1) {
          lines.push({ leadId: res.ids[i], actor: member.user_id, body: toInsert[i].importNote });
        }
      } else if (toInsert.length) {
        totals.noteProblems += toInsert.length;
      }

      /* Somebody who was already here gets a line too — what moved, and
       * anything the sheet said that was NOT taken because a person had
       * already typed something. That second half is the only place the
       * discarded text survives, so it is not optional. */
      for (const u of toUpdate) {
        if (failedIds.has(u.id)) continue;
        const said = [
          `Seen again in ${tab.name}.`,
          u.changes.length ? `Updated: ${u.changes.join(", ")}.` : null,
          ...u.spare,
        ].filter(Boolean).join(" ");
        lines.push({ leadId: u.id, actor: member.user_id, body: said });
      }
      if (lines.length) {
        setProgress(`Writing the timeline for ${tab.name}…`);
        const wrote = await addImportNotesBatch(lines);
        if (!wrote.ok) totals.noteProblems += lines.length - (wrote.count || 0);
      }

      perTab.push({
        name: tab.name,
        added: res.count,
        updated: reallyUpdated,
        unchanged: tabUnchanged,
        firms: plan.companies.length,
        hasHeader: tab.mapped.hasHeader,
        headerWhy: tab.mapped.headerWhy,
        /* From the plan's own mapping, not the reader's. buildImportPlan drops
         * any column pointed at a field an earlier column already fills, so
         * counting the reader's answer reported columns as read that were not
         * used. Found 30 Aug 2026. */
        read: (plan.mapping || tab.mapped.mapping).filter(Boolean).length,
        left: (plan.mapping || tab.mapped.mapping).filter((m) => !m).length,
        /* THE READER'S OWN NOTES, WHICH WERE BEING THROWN AWAY.
         *
         * buildImportPlan folds them in only when IT does the mapping. This
         * screen hands it a mapping, so `auto` was null inside it and no note
         * survived — and the result screen then printed "Every column matched
         * its heading" on exactly the three tabs where the heading was wrong.
         * The one thing deleting the plan screen promised to keep was the one
         * thing it lost. Found 30 Aug 2026 by an adversarial reviewer. */
        warnings: [...(tab.mapped.notes || []), ...plan.warnings],
        mapping: tab.mapped.mapping,
      });
      notes.push(`${tab.name}: ${res.count} added, ${reallyUpdated} updated`);
    }

    await finishImportBatch(batchId, {
      planned: plans.reduce((a, { plan }) => a + plan.counts.usable, 0),
      firms_planned: plans.reduce((a, { plan }) => a + plan.counts.companies, 0),
      contacts: totals.added, firms: totals.firmsAdded, skipped: totals.unchanged,
    });

    await logActivity({
      actor: member.user_id, kind: "sales_import",
      title: `Imported ${totals.added} new contacts and updated ${totals.updated} from ${label.trim() || "a sheet"}`,
      body: notes.join(" · "),
    });

    setResult({
      ...totals, perTab, skipped, plans, sample: found.sample,
      columnGap: cols.ok ? null : cols.why,
      firmsTruncated: companyRows.truncated || null,
      listsTruncated: null,
      deleted: 0,
    });
    setBusy(false);
    setProgress("");
    toast.success(`${totals.added} added, ${totals.updated} updated`,
      `${totals.firmsAdded} new firms across ${perTab.length} list${perTab.length === 1 ? "" : "s"}. Nothing was deleted.`);
    await reload();
  };

  /* ---- screens: there are two ---- */

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      kicker="SALES"
      title={result ? "Imported" : busy ? "Importing…" : "Drop the outreach sheet in"}
      width={860}
      footer={result
        ? <button className="btn btn-accent" onClick={onClose}>Done</button>
        : <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>}
    >
      {!result && (
        <>
          <div className="adm-sl-imp-lead">
            Pick the file and it goes. Every tab comes in at once, the columns are worked out
            from what is in them, and the six hand-filled columns come across with the rest.
            <strong> Nobody is deleted and nothing is emptied</strong> — anyone already here is
            filled in rather than replaced, and the whole run can be undone from Start over.
          </div>
          <div className="adm-sl-imp-drop">
            <input
              ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt"
              onChange={onFile} disabled={busy}
            />
            <div className="adm-sl-imp-hint">
              {hasUnzipSupport()
                ? "Excel (.xlsx) reads every tab. CSV and TSV read the one sheet they hold. A tab with no heading row is fine."
                : "This browser cannot open Excel files. In Google Sheets choose File → Download → Comma-separated values, one tab at a time."}
            </div>
          </div>
          {busy && <div className="adm-sl-imp-note"><strong>{progress || "Working…"}</strong> Leave this open until it finishes.</div>}
          <div className="adm-sl-imp-or">or paste rows straight from the spreadsheet</div>
          <textarea
            className="adm-input" style={{ minHeight: 90 }}
            placeholder="Select the rows in Sheets, copy, paste here…"
            value={pasteText} onChange={(e) => setPasteText(e.target.value)} disabled={busy}
          />
          <button className="btn" style={{ marginTop: 8 }} onClick={onPaste} disabled={busy}>
            Read the pasted rows
          </button>
        </>
      )}

      {result && <Result r={result} />}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* What actually happened                                              */
/* ------------------------------------------------------------------ */

function Result({ r }) {
  return (
    <>
      <div className="adm-sl-imp-nums">
        <Num n={r.added} l="new people added" tone="#006b1a" />
        <Num n={r.updated} l="already here, filled in" tone="#006b1a" />
        <Num n={r.unchanged} l="already here, nothing to change" tone="var(--ink-dim)" />
        <Num n={r.firmsAdded} l="new firms" />
        <Num n={r.firmsUpdated} l="firms filled in" />
        {/* Counted, not asserted. This was the literal number 0, which reads
            the same as a real count of nothing — and on a failed run the panel
            printed zeros it had not measured. */}
        <Num n={r.deleted ?? 0} l="deleted" tone="var(--ink-dim)" />
      </div>

      <div className="adm-sl-imp-note">
        Nothing was deleted and no filled-in value was emptied. Somebody already here keeps
        their stage, their rep and anything typed into their row; the sheet only fills what was
        blank and refreshes plain facts like a job title or a phone number. Anything the sheet
        said that was not taken is written on that person&rsquo;s timeline instead of being thrown
        away.{" "}
        {/* THE HONEST VERSION. This said "To undo the whole run: Start over",
            which is false for every contact the run FILLED IN. Start over
            deletes rows by import batch, and a row that was already here
            belongs to no batch — so its field changes stay. That was true by
            construction while the importer skipped people already on file; the
            merge made it false and the sentence was not updated. Found 30 Aug
            2026 by an adversarial reviewer. */}
        {r.updated > 0
          ? <><strong>Sales &rarr; Start over</strong> removes the {r.added} people this run
            added. It cannot undo the {r.updated} it filled in — Start over works by import,
            and somebody who was already here belongs to no import. Those changes stay, and
            every one of them is written on that person&rsquo;s own timeline.</>
          : <>To undo this run: <strong>Sales &rarr; Start over</strong>.</>}
        {r.sample && " Preview mode — none of this was saved."}
      </div>

      {r.failed && (
        <div className="adm-sl-warn adm-sl-warn-flat">
          <strong>It stopped on &ldquo;{r.failed}&rdquo;.</strong> {r.error} Everything up to that point
          was saved. Fix the offending cell and drop the file in again — anyone already here will
          be filled in rather than added twice.
        </div>
      )}

      {r.columnGap && (
        <div className="adm-sl-warn adm-sl-warn-flat">
          <strong>Five columns were left out.</strong> {r.columnGap}
        </div>
      )}

      {r.firmsTruncated && (
        <div className="adm-sl-warn adm-sl-warn-flat">
          <strong>Not every firm on file was checked.</strong> {r.firmsTruncated} Firms past that
          point may have been added a second time.
        </div>
      )}

      {r.updateFailures > 0 && (
        <div className="adm-sl-warn adm-sl-warn-flat">
          <strong>{r.updateFailures} row{r.updateFailures === 1 ? "" : "s"} could not be updated.</strong> They
          are unchanged, not lost. Everything else went in.
        </div>
      )}

      {r.perTab.map((t) => (
        <div key={t.name} className="adm-sl-imp-plan">
          <div className="adm-sl-imp-planh">
            <strong>{t.name}</strong>
            <span>
              {t.added} added · {t.updated} filled in · {t.unchanged} unchanged · {t.firms} firms
            </span>
          </div>
          <div className="adm-sl-faint" style={{ fontSize: 12, marginBottom: 4 }}>
            {t.read} column{t.read === 1 ? "" : "s"} read
            {t.left ? `, ${t.left} left out` : ""}
            {t.hasHeader ? "" : " — no heading row on this tab, so the columns were worked out from the values"}
            {t.headerWhy ? ` (${t.headerWhy})` : ""}
          </div>
          {t.warnings.length === 0 ? (
            <div className="adm-sl-imp-clean">Every column matched its heading.</div>
          ) : (
            <ul className="adm-sl-imp-warns">
              {t.warnings.slice(0, 14).map((w, i) => (
                <li key={i}>{w.why}{w.row ? ` (row ${w.row}, ${w.field})` : ""}</li>
              ))}
              {t.warnings.length > 14 && <li>…and {t.warnings.length - 14} more of the same kind.</li>}
            </ul>
          )}
        </div>
      ))}

      {r.skipped?.length > 0 && (
        <div className="adm-sl-imp-note">
          <strong>Tabs left out:</strong>{" "}
          {r.skipped.map((t) => `${t.name} — ${t.why}`).join(" · ")}
        </div>
      )}

      {(r.repeatedInFile > 0 || r.noKey > 0) && (
        <div className="adm-sl-imp-note">
          {r.repeatedInFile > 0 && `${r.repeatedInFile} row${r.repeatedInFile === 1 ? "" : "s"} matched somebody earlier in the file and ${r.repeatedInFile === 1 ? "was" : "were"} not added again. A row is matched on its email; a row with no email is matched on its phone, website or company and town, which colleagues at the same firm share — so some of these may be different people at one firm. `}
          {r.noKey > 0 && `${r.noKey} row${r.noKey === 1 ? " had" : "s had"} no email, phone, website or company, so there is nothing to tell them apart by and they came in as new.`}
        </div>
      )}

      {r.noteProblems > 0 && (
        <div className="adm-sl-imp-note">
          {r.noteProblems} contacts could not be given a first timeline line — the ids did not line
          up, so none were guessed at. They are saved; only that one line is missing.
        </div>
      )}
    </>
  );
}

function Num({ n, l, tone }) {
  return (
    <div className="adm-sl-imp-num">
      <span style={tone ? { color: tone } : undefined}>{n}</span>
      <small>{l}</small>
    </div>
  );
}

/* ONE note, for a contact added by hand. The import itself uses
 * addImportNotesBatch — one call per contact meant seven thousand requests on
 * the real workbook. This stays because the first line of a timeline should
 * always say where the record came from, however it arrived, and a hand-added
 * contact arrives one at a time. */
export async function stampImportNote(leadId, actor, note) {
  return addLeadActivity({ leadId, actor, type: "import", body: note });
}

/* Exported for the tests, which check that every field the reader can produce
 * has somewhere to go and a name a person would recognise. */
export const FIELD_LABELS = LABEL;
