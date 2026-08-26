import { useMemo, useRef, useState } from "react";
import {
  insertLeadsBatch, insertCompaniesBatch, findExistingCompanies, findExistingLeadKeys,
  upsertLeadList, findLeadListByTab, upsertLeadSource, addLeadActivity, logActivity,
  startImportBatch, finishImportBatch,
} from "../../lib/data.js";
import { toast } from "../../lib/toast.js";
import { parseXlsxAllTabs, readSheetFile, readPasted, hasUnzipSupport } from "../../lib/sheet.js";
import { dedupeKey } from "../../lib/leadIntakeBrowser.js";
import {
  SALES_FIELDS, guessHeaderRow, buildImportPlan, looksLikeLeadTab,
} from "../../../lib/sales-import.js";
import { Modal, Field, TextInput, Select } from "./shared.jsx";

/* IMPORTING CJ's OUTREACH SHEET.
 *
 * WHY THIS IS NOT THE OLD IMPORTER
 * The Aug 20 importer reads ONE tab and maps nine fields. CJ's sheet has eight
 * lead tabs plus a rules tab, twenty-seven columns, and six of those columns
 * are months of hand-typed work — who claimed what, when they first emailed,
 * what the next step is. An import that drops those six is not an import, it
 * is a reset, and the team would rightly refuse to move.
 *
 * So this one:
 *   · reads every tab in the workbook at once, and skips the rules tab,
 *   · maps each tab on its own, because the Apollo columns genuinely differ
 *     between tabs (Luxury Agents has "# Employees" where Car Dealership has
 *     "Departments" and "Industry"),
 *   · matches "Brandon R" to Brandon Roberts and says which rule it used,
 *   · folds the rows of one firm together so four ACME people are one firm,
 *   · and shows the whole plan — including everything it could NOT read —
 *     before a single row is written.
 *
 * Four steps: choose the file → tick the tabs → check the columns → look at
 * the plan and import.
 */

const FIELD_OPTIONS = [
  ["", "— leave this column out —"],
  ...SALES_FIELDS.map((f) => [f.key, `${f.label}${f.where === "company" ? " (firm)" : f.where === "work" ? " (the work)" : ""}`]),
];

export function SalesImportModal({ member, team, onClose, reload }) {
  const [step, setStep] = useState("choose");   // choose → tabs → map → plan
  const [tabs, setTabs] = useState([]);         // [{ name, rows, use, mapping, hasHeader, verdict }]
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState(null);
  /* Kept so the import record can name the file it came from. Without it,
     "Outreach sheet" is the only clue three imports later about which download
     produced which rows. */
  const [fileName, setFileName] = useState(null);
  const [progress, setProgress] = useState("");
  const fileRef = useRef(null);

  /* One clock for the life of this modal, taken once. A Date.now() read during
   * render changes between renders, so the plan a person is reading could
   * quietly recompute under them — and React's purity rule rightly refuses it. */
  const [now] = useState(() => Date.now());

  /* ---- reading the file ---- */

  const acceptTabs = (raw, sourceLabel) => {
    const prepared = raw.map((t) => {
      const verdict = looksLikeLeadTab(t.name, t.rows);
      const { mapping, clashes } = guessHeaderRow(t.rows[0] || []);
      return { ...t, use: verdict.yes, verdict, mapping, clashes, hasHeader: true };
    });
    if (!prepared.some((t) => t.verdict.yes)) {
      toast.error("Nothing importable in that file",
        prepared.map((t) => `${t.name}: ${t.verdict.why}`).join(" · ").slice(0, 200));
      return;
    }
    setTabs(prepared);
    setActive(prepared.findIndex((t) => t.use));
    setLabel(sourceLabel);
    setStep("tabs");
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error("That file is too big", "Keep it under 25 MB. Split the workbook if you need to.");
      return;
    }
    setBusy(true);
    try {
      setFileName(file.name || null);
      const name = (file.name || "").toLowerCase();
      if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
        const all = await parseXlsxAllTabs(await file.arrayBuffer());
        acceptTabs(all.filter((t) => !t.empty), file.name.replace(/\.[^.]+$/, ""));
      } else {
        // One-tab formats still work — CSV, TSV, and the old .xls message.
        const one = await readSheetFile(file);
        acceptTabs([{ name: file.name, rows: one.rows, empty: false }], file.name.replace(/\.[^.]+$/, ""));
      }
    } catch (err) {
      toast.error("Could not read that file", err?.message || "Unknown problem.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onPaste = () => {
    if (!pasteText.trim()) { toast.warn("Paste the rows in first"); return; }
    try {
      const r = readPasted(pasteText);
      acceptTabs([{ name: "Pasted rows", rows: r.rows, empty: false }], `Pasted — ${new Date().toISOString().slice(0, 10)}`);
    } catch (err) {
      toast.error("Could not read that", err?.message || "Unknown problem.");
    }
  };

  /* ---- the plan for every ticked tab ---- */

  const plans = useMemo(() => {
    return tabs.filter((t) => t.use).map((t) => ({
      tab: t,
      plan: buildImportPlan(t.rows, {
        mapping: t.mapping, hasHeader: t.hasHeader, team, listName: t.name, now,
      }),
    }));
    // `now` is captured once per modal on purpose — a plan that changes under
    // the person while they read it is a plan they cannot check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, team]);

  const totals = useMemo(() => plans.reduce((acc, { plan }) => ({
    usable: acc.usable + plan.counts.usable,
    companies: acc.companies + plan.counts.companies,
    claimed: acc.claimed + plan.counts.claimed,
    blank: acc.blank + plan.counts.blank,
    alreadyWorked: acc.alreadyWorked + plan.counts.alreadyWorked,
    warnings: acc.warnings + plan.warnings.length,
  }), { usable: 0, companies: 0, claimed: 0, blank: 0, alreadyWorked: 0, warnings: 0 }), [plans]);

  /* ---- the duplicate check, before anything is written ---- */

  const [dupes, setDupes] = useState(null);

  /* THE CHECK HAS TO DECIDE SOMETHING, NOT JUST COUNT.
   *
   * The first version of this computed the duplicate counts, printed them —
   * "412 already in the pipeline · 412 rows dropped" — and then imported every
   * row anyway, because the import read `plan.leads` rather than the checked
   * set. Importing the same sheet twice doubled the pipeline while the screen
   * said it had not. The check now produces `skip`, a Set of the exact rows
   * that will not be written, and doImport reads it. */
  const runCheck = async () => {
    setBusy(true);
    setProgress("Checking for people already in the pipeline…");

    const all = plans.flatMap(({ plan }) => plan.leads);
    const skip = new Set();
    const seenKeys = new Map();

    // Same person twice inside the file(s) — the first one is kept.
    for (const entry of all) {
      const k = dedupeKey(entry.lead);
      if (!k) continue;
      if (seenKeys.has(k)) { skip.add(entry); continue; }
      seenKeys.set(k, entry);
    }
    const within = all.filter((e) => skip.has(e)).length;

    // Already in the pipeline.
    const keys = [...seenKeys.keys()];
    const existing = await findExistingLeadKeys(keys);
    let already = 0;
    for (const [k, entry] of seenKeys) {
      if (existing.keys.has(k)) { skip.add(entry); already += 1; }
    }

    setDupes({
      skip,
      within,
      already,
      noKey: all.filter((e) => !dedupeKey(e.lead)).length,
      willImport: all.length - skip.size,
      error: existing.error || null,
      sample: existing.sample,
    });
    setBusy(false);
    setProgress("");
    setStep("plan");
  };

  /* ---- writing it ---- */

  const doImport = async () => {
    setBusy(true);
    try {
      /* THE BATCH IS OPENED FIRST, before a single row is written. A run that
       * dies half way still leaves a row naming what it was, and those rows are
       * still clearable — an import with no batch behind it is one nobody can
       * undo. */
      setProgress("Recording this import…");
      const batch = await startImportBatch({
        label: label.trim() || "Outreach sheet",
        sourceFile: fileName || null,
        tabs: plans.map(({ tab }) => tab.name),
        counts: { planned: totals.usable, firms: totals.companies },
        userId: member.user_id,
      });
      const batchId = batch.ok ? batch.id : null;
      if (!batch.ok) {
        toast.warn("This import will not be undoable",
          "The import record could not be saved, most likely because migration 0016 has not been run. Everything still imports — but Start over will not be able to find these rows later.");
      }

      setProgress("Saving the list…");
      const src = await upsertLeadSource({
        label: label.trim() || "Outreach sheet",
        kind: "import", provider: null, assign_to: [],
        created_by: member.user_id,
        last_run_at: new Date().toISOString(),
        last_run_found: totals.usable,
        last_run_new: totals.usable,
        /* The column mapping is stored WITH the source, so importing the same
         * sheet again next month does not mean matching 27 columns by hand a
         * second time. */
        query: { column_map: Object.fromEntries(plans.map(({ tab }) => [tab.name, tab.mapping])) },
      });
      const sourceId = src.ok ? src.row?.id || null : null;
      if (!src.ok) {
        toast.warn("The list record was not saved",
          "The leads still import, but they will not say which file they came from.");
      }

      setProgress("Matching firms already on file…");
      const existingCompanies = await findExistingCompanies();

      let leadTotal = 0;
      let companyTotal = 0;
      let skippedTotal = 0;
      let noteProblems = 0;
      const notes = [];

      for (const { tab, plan } of plans) {
        setProgress(`Importing ${tab.name}…`);

        /* Look the list up by its tab name first. Importing the same workbook
         * next month used to make a SECOND "Medspas", splitting that vertical
         * across two entries in the filter dropdown. */
        const existingList = await findLeadListByTab(tab.name);
        const list = await upsertLeadList({
          ...(existingList ? { id: existingList.id } : { created_by: member.user_id }),
          name: tab.name, vertical: plan.companies[0]?.vertical || null,
          sheet_tab: tab.name, source_id: sourceId,
          ...(batchId ? { import_batch_id: batchId } : {}),
        });
        const listId = list.ok ? list.row?.id || null : null;

        /* Firms first, so the people can point at them. A firm that is already
         * on file is reused rather than duplicated — importing the same sheet
         * twice must not double every company. */
        const fresh = plan.companies.filter((c) => !existingCompanies.byKey[c.key]);
        const saved = await insertCompaniesBatch(fresh.map((c) => ({
          key: c.key, name: c.name, domain: c.domain, phone: c.phone, address: c.address,
          city: c.city, state: c.state, country: c.country, vertical: c.vertical,
          employees: c.employees, annual_revenue: c.annual_revenue,
          linkedin_url: c.linkedin_url, facebook_url: c.facebook_url, twitter_url: c.twitter_url,
          site_score: c.site_score, created_by: member.user_id,
          ...(batchId ? { import_batch_id: batchId } : {}),
        })));
        if (!saved.ok) { toast.error(`Firms failed on ${tab.name}`, saved.error); setBusy(false); setProgress(""); return; }
        companyTotal += saved.count;
        const idByKey = { ...existingCompanies.byKey, ...saved.idByKey };
        for (const [k, v] of Object.entries(saved.idByKey)) existingCompanies.byKey[k] = v;

        /* The duplicates decided on the previous screen are dropped HERE, so
         * what gets written is exactly what the person was shown. */
        const keep = plan.leads.filter((entry) => !dupes.skip.has(entry));
        const rows = keep.map(({ lead, companyKey }) => ({
          ...lead,
          company_id: companyKey ? idByKey[companyKey] || null : null,
          list_id: listId,
          source_id: sourceId,
          last_import_at: new Date().toISOString(),
          ...(batchId ? { import_batch_id: batchId } : {}),
        }));
        skippedTotal += plan.leads.length - keep.length;

        const res = await insertLeadsBatch(rows);
        if (!res.ok) {
          toast.error(`Import stopped on ${tab.name}`,
            `${res.error}${res.count ? ` ${res.count} of ${rows.length} rows on this tab were already saved.` : ""}`);
          setBusy(false); setProgress("");
          setResult({ leadTotal: leadTotal + (res.count || 0), companyTotal, notes, failed: tab.name, error: res.error });
          await reload();
          return;
        }
        leadTotal += res.count;
        notes.push(`${tab.name}: ${res.count}`);

        /* The first line of every imported contact's timeline: which file,
         * which row, and what the sheet said. Written here rather than promised
         * — the plan screen tells the person this happens, and for a while it
         * did not, because the note was computed and then thrown away.
         *
         * The ids come back from the insert, so this is matched by position
         * within the chunk the insert reports. If anything is out of step the
         * notes are skipped rather than attached to the wrong person. */
        if (res.ids && res.ids.length === keep.length) {
          setProgress(`Writing the timeline for ${tab.name}…`);
          for (let i = 0; i < keep.length; i += 1) {
            await stampImportNote(res.ids[i], member.user_id, keep[i].importNote);
          }
        } else if (keep.length) {
          noteProblems += keep.length;
        }
      }

      /* Closed with what ACTUALLY landed, not what was planned. The planned
       * number is already on the row from the start; overwriting it with the
       * real one would lose the difference, which is the only evidence that a
       * run fell short. */
      await finishImportBatch(batchId, {
        planned: totals.usable, firms_planned: totals.companies,
        contacts: leadTotal, firms: companyTotal, skipped: skippedTotal,
      });

      await logActivity({
        actor: member.user_id, kind: "sales_import",
        title: `Imported ${leadTotal} contacts and ${companyTotal} firms from ${label.trim() || "a sheet"}`,
        body: notes.join(" · "),
      });

      setResult({ leadTotal, companyTotal, notes, skippedTotal, noteProblems });
      setBusy(false);
      setProgress("");
      toast.success(`${leadTotal} contacts imported`,
        `${companyTotal} firms across ${plans.length} list${plans.length === 1 ? "" : "s"}${skippedTotal ? `, ${skippedTotal} duplicate${skippedTotal === 1 ? "" : "s"} skipped` : ""}.`);
      await reload();
    } catch (err) {
      setBusy(false);
      setProgress("");
      toast.error("The import stopped", err?.message || "Unknown problem.");
    }
  };

  /* ---- screens ---- */

  const tab = tabs[active];

  return (
    <Modal
      open
      onClose={onClose}
      kicker="SALES"
      title={
        step === "choose" ? "Import the outreach sheet"
          : step === "tabs" ? "Which tabs do you want"
            : step === "map" ? `Check the columns — ${tab?.name || ""}`
              : result ? "Imported" : "Before anything saves"
      }
      width={860}
      footer={
        result ? <button className="btn btn-accent" onClick={onClose}>Done</button>
          : <>
            {step !== "choose" && (
              <button className="btn" onClick={() => setStep(step === "plan" ? "map" : step === "map" ? "tabs" : "choose")} disabled={busy}>
                Back
              </button>
            )}
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            {step === "tabs" && (
              <button className="btn btn-accent" onClick={() => setStep("map")} disabled={busy || !tabs.some((t) => t.use)}>
                Check the columns
              </button>
            )}
            {step === "map" && (
              <button className="btn btn-accent" onClick={runCheck} disabled={busy}>
                {busy ? progress || "Checking…" : "See what will happen"}
              </button>
            )}
            {step === "plan" && (
              <button className="btn btn-accent" onClick={doImport} disabled={busy || !(dupes?.willImport)}>
                {busy ? progress || "Importing…" : `Import ${dupes?.willImport ?? 0} contacts`}
              </button>
            )}
          </>
      }
    >
      {step === "choose" && (
        <>
          <div className="adm-sl-imp-lead">
            Pick the workbook and every tab comes in at once — the tabs become lists, the six
            hand-filled columns come across, and the people at one firm are grouped under that firm.
            Nothing is written until you have seen exactly what will happen.
          </div>
          <div className="adm-sl-imp-drop">
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={onFile} disabled={busy} />
            <div className="adm-sl-imp-hint">
              {hasUnzipSupport()
                ? "Excel (.xlsx) reads every tab. CSV and TSV read the one sheet they hold."
                : "This browser cannot open Excel files. In Google Sheets choose File → Download → Comma-separated values, one tab at a time."}
            </div>
          </div>
          <div className="adm-sl-imp-or">or paste rows straight from the spreadsheet</div>
          <textarea
            className="adm-input" style={{ minHeight: 110 }}
            placeholder="Select the rows in Sheets, copy, paste here…"
            value={pasteText} onChange={(e) => setPasteText(e.target.value)}
          />
          <button className="btn" style={{ marginTop: 8 }} onClick={onPaste} disabled={busy}>Read the pasted rows</button>
        </>
      )}

      {step === "tabs" && (
        <>
          <Field label="What is this list called" hint="Shown on every contact so you can always tell where they came from.">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          {/* A pasted block often has no header row, and assuming one silently
              ate the first person on the list. */}
          <label className="adm-sl-imp-header">
            <input
              type="checkbox"
              checked={tabs.every((t) => t.hasHeader)}
              onChange={(e) => setTabs(tabs.map((t) => ({ ...t, hasHeader: e.target.checked })))}
            />
            <span>The first row is column headings, not a person</span>
          </label>
          <div className="adm-sl-imp-tabs">
            {tabs.map((t, i) => (
              <label key={t.name + i} className={`adm-sl-imp-tab${t.use ? " on" : ""}`}>
                <input
                  type="checkbox" checked={t.use}
                  onChange={(e) => setTabs(tabs.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)))}
                />
                <div>
                  <div className="adm-sl-imp-tabn">{t.name}</div>
                  <div className="adm-sl-imp-tabw">{t.verdict.why}</div>
                </div>
                <span className="adm-sl-imp-tabc">{Math.max(0, t.rows.length - 1)} rows</span>
              </label>
            ))}
          </div>
          <div className="adm-sl-imp-note">
            Tabs that are instructions rather than lists are unticked to start with. The
            &ldquo;Rules of Engagement&rdquo; tab is prose — importing it makes a hundred contacts called
            &ldquo;•&rdquo;.
          </div>
        </>
      )}

      {step === "map" && tab && (
        <>
          <div className="adm-sl-imp-tabbar">
            {tabs.map((t, i) => t.use && (
              <button key={t.name + i} className={i === active ? "active" : ""} onClick={() => setActive(i)}>{t.name}</button>
            ))}
          </div>
          <div className="adm-sl-imp-note">
            Each tab is matched on its own, because the columns really are different between them.
            Anything left out is left out — nothing is guessed at.
            {tab.clashes?.length > 0 && (
              <> <strong>{tab.clashes.length} column{tab.clashes.length === 1 ? "" : "s"}</strong> wanted a field
                another column had already taken ({tab.clashes.map((c) => c.header).join(", ")}), so they are
                left out rather than silently overwriting it.</>
            )}
          </div>
          <div className="adm-sl-imp-map">
            {(tab.rows[0] || []).map((h, i) => (
              <div key={i} className="adm-sl-imp-col">
                <div className="adm-sl-imp-colh" title={String(h)}>{String(h || `Column ${i + 1}`)}</div>
                <Select
                  value={tab.mapping[i] || ""}
                  onChange={(e) => setTabs(tabs.map((x, j) => (j === active
                    ? { ...x, mapping: x.mapping.map((m, k) => (k === i ? e.target.value : m)) }
                    : x)))}
                  options={FIELD_OPTIONS}
                />
                <div className="adm-sl-imp-colv" title={String(tab.rows[1]?.[i] ?? "")}>
                  {String(tab.rows[1]?.[i] ?? "") || <span className="adm-sl-faint">blank</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {step === "plan" && !result && (
        <>
          <div className="adm-sl-imp-nums">
            <Num n={dupes?.willImport ?? totals.usable} l="will be imported" tone="#006b1a" />
            <Num n={totals.companies} l="firms" />
            <Num n={totals.claimed} l="claims carried over" />
            <Num n={totals.alreadyWorked} l="already worked" />
            <Num n={dupes?.already ?? 0} l="skipped — already here" tone="var(--ink-dim)" />
            <Num n={totals.blank + (dupes?.within ?? 0)} l="skipped — blank or repeated" tone="var(--ink-dim)" />
          </div>

          <div className="adm-sl-imp-note">
            Dates are read as month/day/year, which is how this sheet writes them.
            {dupes?.sample && " Preview mode — the duplicate check can only see the sample pipeline."}
            {dupes?.error && ` The duplicate check could not finish: ${dupes.error}. The counts above may be low.`}
          </div>

          {plans.map(({ tab: t, plan }) => (
            <div key={t.name} className="adm-sl-imp-plan">
              <div className="adm-sl-imp-planh">
                <strong>{t.name}</strong>
                <span>{plan.counts.usable} contacts · {plan.counts.companies} firms · {plan.counts.claimed} claimed</span>
              </div>
              {plan.warnings.length === 0 ? (
                <div className="adm-sl-imp-clean">Nothing unreadable on this tab.</div>
              ) : (
                <ul className="adm-sl-imp-warns">
                  {plan.warnings.slice(0, 12).map((w, i) => (
                    <li key={i}>{w.why}{w.row ? ` (row ${w.row}, ${w.field})` : ""}</li>
                  ))}
                  {plan.warnings.length > 12 && <li>…and {plan.warnings.length - 12} more of the same kind.</li>}
                </ul>
              )}
            </div>
          ))}

          <div className="adm-sl-imp-note">
            Every contact gets a first timeline line saying which file and row it came from, dated
            today, so nothing that came out of a spreadsheet can later be mistaken for something we
            measured.
          </div>
        </>
      )}

      {result && (
        <>
          <div className="adm-sl-imp-nums">
            <Num n={result.leadTotal} l="contacts imported" tone="#006b1a" />
            <Num n={result.companyTotal} l="firms created" tone="#006b1a" />
          </div>
          <div className="adm-sl-imp-note">
            {result.notes.join(" · ")}
            {result.skippedTotal ? ` · ${result.skippedTotal} skipped as duplicates.` : ""}
            {result.noteProblems ? ` · ${result.noteProblems} contacts could not be given a timeline note — the ids did not line up, so none were guessed at.` : ""}
          </div>
          {result.failed && (
            <div className="adm-sl-warn adm-sl-warn-flat">
              <strong>It stopped on &ldquo;{result.failed}&rdquo;.</strong> {result.error} Everything up to that
              point was saved. Fix the offending cell and import the remaining tabs again — anything
              already here will be skipped as a duplicate.
            </div>
          )}
          <div className="adm-sl-imp-note">
            Claims came across where a name matched an account. Anything that did not match is on
            the floor for anybody to take — nothing was assigned to the wrong person on a guess.
          </div>
        </>
      )}
    </Modal>
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

/* Kept out of the modal so the caller can log the same line for a hand-added
 * contact — the first line of a timeline should always say where the record
 * came from, however it arrived. */
export async function stampImportNote(leadId, actor, note) {
  return addLeadActivity({ leadId, actor, type: "import", body: note });
}
