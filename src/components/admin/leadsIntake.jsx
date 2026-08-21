import { useMemo, useRef, useState } from "react";
import {
  insertLeadsBatch, findExistingLeadKeys, upsertLeadSource, logActivity,
} from "../../lib/data.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import { readSheetFile, readPasted, hasUnzipSupport } from "../../lib/sheet.js";
import { dedupeKey, dedupeWithin, guessColumn, toLeadRow } from "../../lib/leadIntakeBrowser.js";
import { Modal, Field, TextInput, Select, timeAgo } from "./shared.jsx";

/* Getting leads in — a spreadsheet, a paste, or a saved search.
 *
 * THE THING THAT MAKES THIS WORTH THE CODE
 * A lead list is only useful if a rep trusts it. The fastest way to destroy
 * that trust is a duplicate: a rep calls someone, is told "your colleague
 * rang yesterday", and stops believing the list. So NOTHING saves until the
 * duplicates have been counted and shown — both duplicates inside the file
 * itself, and rows already in the pipeline.
 *
 * Excel is read directly (src/lib/sheet.js — no library, the browser can
 * already unzip). Pasting straight from a spreadsheet works too, which in
 * practice is how most short lists arrive.
 */

const FIELD_OPTIONS = [
  ["", "— skip this column —"],
  ["name", "Name"],
  ["company", "Company"],
  ["domain", "Website"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["city", "City"],
  ["state", "State"],
  ["vertical", "Industry"],
  ["notes", "Notes"],
];

/* ================================================================== */
/* IMPORT                                                              */
/* ================================================================== */

export function ImportModal({ member, team, onClose, reload }) {
  const [step, setStep] = useState("choose");   // choose → map → check → done
  const [rows, setRows] = useState(null);
  const [mapping, setMapping] = useState([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [label, setLabel] = useState("");
  const [readNote, setReadNote] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);     // the duplicate report
  const [assignTo, setAssignTo] = useState([]); // rep ids to share the list between
  const fileRef = useRef(null);

  const accept = (result, name) => {
    if (result.rows.length < 1) {
      toast.error("Nothing in that", "There were no rows to read.");
      return;
    }
    if (result.rows.length > 5000) {
      toast.error("That is a very long list", "Keep each import under 5,000 rows — split the file and do it twice.");
      return;
    }
    setRows(result.rows);
    setReadNote(result.note);
    setLabel(name || `Pasted list — ${new Date().toISOString().slice(0, 10)}`);
    setMapping(result.rows[0].map((h) => guessColumn(h)));
    setStep("map");
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast.error("That file is too big", "Keep imports under 15 MB. Split the list if you need to.");
      return;
    }
    setBusy(true);
    try {
      const result = await readSheetFile(file);
      accept(result, file.name);
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
      accept(readPasted(pasteText), "");
    } catch (err) {
      toast.error("Could not read that", err?.message || "Unknown problem.");
    }
  };

  /* The mapped rows, recomputed as the person changes the mapping so the
   * preview and the count always describe the same thing. */
  const mapped = useMemo(() => {
    if (!rows) return [];
    const body = hasHeader ? rows.slice(1) : rows;
    const out = [];
    for (const r of body) {
      const raw = {};
      mapping.forEach((field, i) => {
        if (!field) return;
        const v = String(r[i] ?? "").trim();
        if (v) raw[field] = v;
      });
      const lead = toLeadRow(raw, { source: "sheet" });
      if (lead) out.push(lead);
    }
    return out;
  }, [rows, mapping, hasHeader]);

  const unusable = (hasHeader ? (rows?.length || 1) - 1 : (rows?.length || 0)) - mapped.length;

  const runCheck = async () => {
    if (!mapping.some((m) => ["name", "company", "email"].includes(m))) {
      toast.warn("Match at least one of Name, Company or Email", "Without one of those, the rows cannot be told apart.");
      return;
    }
    if (!mapped.length) {
      toast.error("Nothing importable", "Every row was empty once the columns were matched.");
      return;
    }
    setBusy(true);
    const { kept, dupes } = dedupeWithin(mapped);
    const keys = kept.map((r) => dedupeKey(r)).filter(Boolean);
    const existing = await findExistingLeadKeys(keys);
    const already = [];
    const fresh = [];
    for (const r of kept) {
      const k = dedupeKey(r);
      if (k && existing.keys.has(k)) already.push(r);
      else fresh.push(r);
    }
    setBusy(false);
    setCheck({
      fresh, already, dupes,
      noKey: kept.filter((r) => !dedupeKey(r)).length,
      checkError: existing.error || null,
      sample: existing.sample,
    });
    setStep("check");
  };

  const doImport = async () => {
    setBusy(true);
    // The source row is written first, so every lead can carry a link back to
    // the file it came from. A lead whose origin you cannot name is a lead
    // nobody can judge. If that write is refused, the import still goes ahead
    // and the person is told what they are losing — see below.
    const src = await upsertLeadSource({
      label: label.trim() || "Imported list",
      kind: "import",
      provider: null,
      assign_to: assignTo,
      created_by: member.user_id,
      last_run_at: new Date().toISOString(),
      last_run_found: mapped.length,
      last_run_new: check.fresh.length,
    });
    /* Only an owner or admin may create a lead source (migration 0006), so a
     * sales rep's import fails here. That is fine — the leads still import —
     * but it used to fail SILENTLY, leaving every one of those leads with no
     * record of where it came from, under a comment claiming the opposite.
     * Say it out loud instead, so somebody can decide whether it matters. */
    const sourceId = src.ok ? src.row?.id || null : null;
    if (!src.ok) {
      toast.warn("The list itself was not saved",
        "The leads still import, but they will not say which file they came from. Ask an admin to run the import if that matters.");
    }

    const owners = assignTo.length
      ? check.fresh.map((_, i) => assignTo[i % assignTo.length])
      : check.fresh.map(() => null);

    const toInsert = check.fresh.map((r, i) => ({
      ...r,
      source_id: sourceId,
      owner_id: owners[i],
      last_import_at: new Date().toISOString(),
    }));

    const res = await insertLeadsBatch(toInsert);
    setBusy(false);
    if (!res.ok) { toast.error("Import failed", res.error); return; }
    await logActivity({
      actor: member.user_id, kind: "leads_imported",
      title: `Imported ${res.count} leads from ${label.trim() || "a list"}`,
      body: `${check.already.length} were already in the pipeline and were skipped.`,
    });
    toast.success(`${res.count} leads imported`,
      `${check.already.length} already here, ${check.dupes.length} repeated inside the file, ${unusable} rows unusable.`);
    onClose();
    reload();
  };

  const reps = (team || []).filter((t) => t.active);

  return (
    <Modal open onClose={onClose} kicker="SALES"
      title={step === "choose" ? "Bring a lead list in" : step === "map" ? "Check the columns" : "Before anything saves"}
      width={step === "choose" ? 620 : 860}
      footer={
        step === "map" ? (
          <>
            <button className="btn" onClick={() => { setRows(null); setCheck(null); setStep("choose"); }}>Back</button>
            <button className="btn btn-accent" onClick={runCheck} disabled={busy}>
              {busy ? "Checking…" : "Check for duplicates"}
            </button>
          </>
        ) : step === "check" ? (
          <>
            <button className="btn" onClick={() => setStep("map")}>Back</button>
            <button className="btn btn-accent" onClick={doImport} disabled={busy || !check?.fresh.length}>
              {busy ? "Importing…" : `Import ${check?.fresh.length || 0} new lead${check?.fresh.length === 1 ? "" : "s"}`}
            </button>
          </>
        ) : null
      }>

      {/* ---- choose ---- */}
      {step === "choose" && (
        <>
          <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
            Two ways in. Either is fine — nothing saves until you have seen how many are duplicates.
          </p>

          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <div style={{ padding: 16, border: "1px solid var(--rule)", borderRadius: 12, background: "var(--bg-1)" }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>1. Choose a file</div>
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)", margin: "4px 0 10px", lineHeight: 1.5 }}>
                Excel (.xlsx) or CSV. Excel is read directly — you do not have to save it as anything first.
                {!hasUnzipSupport() && " This browser cannot open Excel files, so use CSV here."}
              </div>
              <label className="btn btn-accent" style={{ cursor: "pointer" }}>
                {busy ? "Reading…" : "Choose a file"}
                <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,.xlsm,.xls,text/csv" style={{ display: "none" }} onChange={onFile} />
              </label>
            </div>

            <div style={{ padding: 16, border: "1px solid var(--rule)", borderRadius: 12, background: "var(--bg-1)" }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>2. Or paste the rows</div>
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)", margin: "4px 0 10px", lineHeight: 1.5 }}>
                In the spreadsheet, select the rows including the header row, copy, and paste them here.
              </div>
              <textarea
                className="adm-input"
                rows={4}
                placeholder={"Name\tCompany\tEmail\tPhone\nSarah Chen\tChen Dental\tsarah@…\t(555) 000-0000"}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                style={{ fontFamily: "var(--mono)", fontSize: 12 }}
              />
              <button className="btn" style={{ marginTop: 8 }} onClick={onPaste}>Read what I pasted</button>
            </div>
          </div>
        </>
      )}

      {/* ---- map ---- */}
      {step === "map" && rows && (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
              <strong>{hasHeader ? rows.length - 1 : rows.length}</strong> rows. {readNote}
            </span>
            <label style={{ fontSize: 12.5, color: "var(--ink-2)", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={hasHeader} onChange={(e) => {
                setHasHeader(e.target.checked);
                // Re-guess from row 1 when it becomes a header again; when it
                // is not a header there is nothing to guess from, so the
                // person picks. Guessing off a data row is how "Sarah Chen"
                // ends up matched as a column name.
                if (e.target.checked) setMapping(rows[0].map((h) => guessColumn(h)));
              }} />
              The first row is the column names
            </label>
            <div style={{ marginLeft: "auto", minWidth: 240 }}>
              <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this list — e.g. CJ's realtor sheet" />
            </div>
          </div>

          <div style={{ overflowX: "auto", border: "1px solid var(--rule)", borderRadius: 10 }}>
            <table className="adm-table" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  {rows[0].map((h, i) => (
                    <th key={i} style={{ minWidth: 140 }}>
                      <div style={{ marginBottom: 6, color: "var(--ink)", textTransform: "none", letterSpacing: 0, fontFamily: "var(--body)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {hasHeader ? (h || `Column ${i + 1}`) : `Column ${i + 1}`}
                      </div>
                      <select className="adm-input" style={{ padding: "5px 8px", fontSize: 12 }} value={mapping[i] || ""}
                        onChange={(e) => { const m = [...mapping]; m[i] = e.target.value; setMapping(m); }}>
                        {FIELD_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(hasHeader ? rows.slice(1, 4) : rows.slice(0, 3)).map((r, ri) => (
                  <tr key={ri}>
                    {rows[0].map((_, ci) => (
                      <td key={ci} style={{ fontSize: 12, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r[ci]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 8 }}>
            Showing the first {hasHeader ? Math.min(3, rows.length - 1) : Math.min(3, rows.length)} rows.
            {" "}<strong>{mapped.length}</strong> rows can be imported with these matches
            {unusable > 0 ? `, ${unusable} cannot (no name, company or email).` : "."}
          </div>
        </>
      )}

      {/* ---- check ---- */}
      {step === "check" && check && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            {[
              ["New — will be added", check.fresh.length, "#006b1a", "var(--success-soft, #eafce9)"],
              ["Already in the pipeline", check.already.length, "#92400e", "#fffbeb"],
              ["Repeated inside this file", check.dupes.length, "#92400e", "#fffbeb"],
              ["Unusable rows", unusable, "var(--ink-dim)", "var(--bg-2)"],
            ].map(([label2, n, c, bg]) => (
              <div key={label2} style={{ padding: 12, borderRadius: 10, background: bg, border: "1px solid var(--rule)" }}>
                <div style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, color: c }}>{n}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.4 }}>{label2}</div>
              </div>
            ))}
          </div>

          {check.checkError && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12.5, color: "var(--danger)" }}>
              The duplicate check did not finish: {check.checkError}. Importing now could add leads that are already here.
            </div>
          )}
          {check.sample && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 12.5, color: "#92400e" }}>
              Preview mode — the duplicate check only compared email addresses against the sample data. On the real console it also matches phone numbers, websites and company-plus-city.
            </div>
          )}
          {check.noKey > 0 && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--ink-dim)" }}>
              {check.noKey} of these have no email, phone or website, so there was nothing solid to match them on.
              They will be added — a lead nobody can match is still a lead, and dropping it loses a real one.
            </div>
          )}

          {check.already.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="label" style={{ marginBottom: 6 }}>Already here — these will be skipped</div>
              <div style={{ maxHeight: 130, overflowY: "auto", border: "1px solid var(--rule)", borderRadius: 8, padding: 8, fontSize: 12, color: "var(--ink-2)" }}>
                {check.already.slice(0, 40).map((r, i) => (
                  <div key={i}>{r.name || r.company} — {r.email || r.phone || r.domain}</div>
                ))}
                {check.already.length > 40 && <div style={{ color: "var(--ink-faint)" }}>+{check.already.length - 40} more</div>}
              </div>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div className="label" style={{ marginBottom: 6 }}>Hand them out (optional)</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginBottom: 8 }}>
              Tick reps to share the new leads between them, one each in turn. Leave it empty and they land unclaimed in the pool.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {reps.map((t) => {
                const on = assignTo.includes(t.user_id);
                return (
                  <button key={t.user_id} className={`btn ${on ? "btn-accent" : ""}`} style={{ padding: "6px 12px", fontSize: 12 }}
                    onClick={() => setAssignTo(on ? assignTo.filter((x) => x !== t.user_id) : [...assignTo, t.user_id])}>
                    {on ? "✓ " : ""}{t.full_name || t.email}
                  </button>
                );
              })}
              {!reps.length && <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No active team members to hand them to.</span>}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ================================================================== */
/* SAVED SEARCHES (the scraper)                                        */
/* ================================================================== */

const PROVIDERS = [
  ["platform", "Our platform's lead generator"],
  ["apollo", "Apollo (contact details)"],
];

export function SourcesModal({ member, team, sources, onClose, reload }) {
  const [editing, setEditing] = useState(null);
  const [runningId, setRunningId] = useState(null);

  const run = async (s) => {
    setRunningId(s.id);
    const res = await apiFetch("/api/lead-scrape", { method: "POST", body: { source_id: s.id } });
    setRunningId(null);
    if (!res.ok) {
      // A missing key is not a failure of the feature — it is a feature that
      // has not been switched on. Said differently, and on purpose.
      if (res.status === 503) toast.warn("Waiting on a key", res.error);
      else if (res.preview) toast.info("Preview mode", "With the keys set, this runs the search and drops what it finds into the pipeline.");
      else toast.error("The search failed", res.error);
      reload();
      return;
    }
    const { found, added, duplicates } = res.data;
    toast.success(`${added} new lead${added === 1 ? "" : "s"}`,
      `${found} found, ${duplicates} already in the pipeline.`);
    reload();
  };

  return (
    <>
      <Modal open onClose={onClose} kicker="SALES" title="Where leads come from" width={760}
        footer={<>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-accent" onClick={() => setEditing({})}>+ New saved search</button>
        </>}>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          A saved search runs against our own lead generator and drops what it finds straight into the pipeline,
          already checked against everyone who is in there. Imported spreadsheets show here too, so you can always
          tell where a lead came from.
        </p>

        {!sources.length ? (
          <div style={{ padding: "20px 0", textAlign: "center", color: "var(--ink-dim)", fontSize: 13 }}>
            Nothing yet. A saved search is the way to stop buying lists.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            {sources.map((s) => (
              <div key={s.id} className="card" style={{ padding: 14, opacity: s.active ? 1 : 0.6 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{s.label}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 2 }}>
                      {s.kind === "scraper" ? "Saved search" : s.kind === "import" ? "Imported list" : s.kind}
                      {s.provider ? ` · ${PROVIDERS.find((p) => p[0] === s.provider)?.[1] || s.provider}` : ""}
                      {s.auto_daily ? " · runs every day" : ""}
                      {s.kind === "scraper" ? ` · up to ${s.daily_cap} a run` : ""}
                    </div>
                    {s.kind === "scraper" && (
                      <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 3, fontFamily: "var(--mono)" }}>
                        {[s.query?.vertical, s.query?.city, s.query?.state, s.query?.keywords].filter(Boolean).join(" · ") || "no search set"}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
                      {s.last_run_at ? `Last run ${timeAgo(s.last_run_at)}` : "Never run"}
                    </div>
                    {s.last_run_at && !s.last_run_error && (
                      <div style={{ fontSize: 11.5, color: "#006b1a", fontWeight: 600 }}>
                        {s.last_run_new ?? 0} new of {s.last_run_found ?? 0} found
                      </div>
                    )}
                  </div>
                </div>

                {s.last_run_error && (
                  <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12, color: "var(--danger)" }}>
                    Last run failed: {s.last_run_error}
                  </div>
                )}

                {s.kind === "scraper" && (
                  <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn btn-accent" style={{ padding: "6px 12px", fontSize: 12 }}
                      onClick={() => run(s)} disabled={runningId === s.id || !s.active}>
                      {runningId === s.id ? "Searching…" : "Run it now"}
                    </button>
                    <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setEditing(s)}>Edit</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {editing && (
        <SourceEditor member={member} team={team} source={editing.id ? editing : null}
          onClose={() => setEditing(null)} reload={reload} />
      )}
    </>
  );
}

function SourceEditor({ member, team, source, onClose, reload }) {
  const [f, setF] = useState({
    label: source?.label || "",
    provider: source?.provider || "platform",
    vertical: source?.query?.vertical || "",
    city: source?.query?.city || "",
    state: source?.query?.state || "",
    keywords: source?.query?.keywords || "",
    daily_cap: source?.daily_cap ?? 25,
    auto_daily: source?.auto_daily ?? false,
    active: source?.active ?? true,
  });
  const [assignTo, setAssignTo] = useState(source?.assign_to || []);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.label.trim()) { toast.warn("Give the search a name"); return; }
    if (!f.vertical.trim() && !f.keywords.trim()) {
      toast.warn("Say what to look for", "An industry or some keywords — otherwise the search returns everything.");
      return;
    }
    setBusy(true);
    const res = await upsertLeadSource({
      ...(source?.id ? { id: source.id } : { created_by: member.user_id, kind: "scraper" }),
      label: f.label.trim(),
      provider: f.provider,
      query: {
        vertical: f.vertical.trim() || null,
        city: f.city.trim() || null,
        state: f.state.trim() || null,
        keywords: f.keywords.trim() || null,
      },
      daily_cap: Math.min(Math.max(parseInt(f.daily_cap, 10) || 25, 1), 500),
      auto_daily: Boolean(f.auto_daily),
      active: Boolean(f.active),
      assign_to: assignTo,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not save it", res.error); return; }
    toast.success(source ? "Search updated" : "Search saved",
      f.auto_daily ? "It runs every day from now on." : "Run it whenever you want more leads.");
    onClose(); reload();
  };

  const reps = (team || []).filter((t) => t.active);

  return (
    <Modal open onClose={onClose} kicker="SALES" title={source ? "Edit the search" : "New saved search"} width={600}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save the search"}</button>
      </>}>
      <Field label="Name it" hint="What you would call this list out loud.">
        <TextInput value={f.label} onChange={set("label")} placeholder="Destin med spas" />
      </Field>
      <Field label="Where to look" hint="Our platform finds businesses that AI search cannot see. Apollo finds the person to ring.">
        <Select value={f.provider} onChange={set("provider")} options={PROVIDERS} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <Field label="Industry"><TextInput value={f.vertical} onChange={set("vertical")} placeholder="medical spa" /></Field>
        <Field label="Keywords"><TextInput value={f.keywords} onChange={set("keywords")} placeholder="botox, injectables" /></Field>
        <Field label="City"><TextInput value={f.city} onChange={set("city")} placeholder="Destin" /></Field>
        <Field label="State"><TextInput value={f.state} onChange={set("state")} placeholder="FL" /></Field>
      </div>
      <Field label="Most leads per run" hint="Each run costs money. 25 is a sensible start.">
        <TextInput type="number" min="1" max="500" value={f.daily_cap} onChange={set("daily_cap")} />
      </Field>

      <Field label="Hand them out" hint="New leads go to these reps in turn. Empty = they land unclaimed.">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {reps.map((t) => {
            const on = assignTo.includes(t.user_id);
            return (
              <button key={t.user_id} className={`btn ${on ? "btn-accent" : ""}`} style={{ padding: "6px 12px", fontSize: 12 }}
                onClick={() => setAssignTo(on ? assignTo.filter((x) => x !== t.user_id) : [...assignTo, t.user_id])}>
                {on ? "✓ " : ""}{t.full_name || t.email}
              </button>
            );
          })}
          {!reps.length && <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>No active team members yet.</span>}
        </div>
      </Field>

      <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "var(--ink-2)", display: "flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={f.auto_daily} onChange={(e) => setF({ ...f, auto_daily: e.target.checked })} />
          Run it every day on its own
        </label>
        <label style={{ fontSize: 13, color: "var(--ink-2)", display: "flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          This search is in use
        </label>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 10, lineHeight: 1.5 }}>
        Daily runs are off unless you tick the box. A search nobody asked for is a bill nobody asked for.
      </p>
    </Modal>
  );
}
