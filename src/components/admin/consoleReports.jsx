import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import {
  listConsoleReports, deleteConsoleReport, generateConsoleReportPreview,
  listConsoleFeedback, saveConsoleFeedback,
} from "../../lib/data.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { toast } from "../../lib/toast.js";
import {
  Modal, Field, TextArea, SourceBadge, timeAgo,
} from "./shared.jsx";
import {
  CONSOLE_PRESETS, MODE_HELP, MAX_INSTRUCTION_CHARS, MAX_FEEDBACK_CHARS,
  consoleReportToMarkdown, provenanceLine, presetById,
} from "../../../lib/console-report.js";

/* THE OVERVIEW GENERATOR — the strip, the form, and the reader.
 *
 * Collapsed it is one row. Open it and the whole thing unfolds in place: the
 * starting points, the box, the mode switch, and everything written before.
 *
 * It borrows the rules of `clientReports.jsx` rather than its layout — "a
 * preset only fills the box, the box is what travels", the saved history with
 * Read / Delete, Copy / Download, and the same honesty badges. Somebody who has
 * used one has used both.
 *
 * The MODE switch is the one control that is genuinely new, so it says what it
 * does in full rather than hiding it in a tooltip.
 */

/* ------------------------------------------------------------------ */

export function useConsoleReports() {
  const [state, setState] = useState({ rows: [], loading: true, error: null, sample: false, ratings: {} });

  const reload = useCallback(async () => {
    const [res, fb] = await Promise.all([listConsoleReports(25), listConsoleFeedback(80)]);
    /* Newest wins. The feedback table is append-only, so rating the same answer
     * twice leaves two rows and the second one is what the person meant. The
     * read is already newest-first, so the first one seen per report is it. */
    const ratings = {};
    for (const f of fb.rows || []) {
      if (!ratings[f.report_id]) ratings[f.report_id] = f;
    }
    setState({
      rows: res.rows || [], loading: false,
      error: res.error || null, sample: Boolean(res.sample), ratings,
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/* One badge, one meaning. There used to be a purple "DRAFT · NUMBERS UNCHECKED"
 * variant for the free mode; that mode is gone, so every saved answer wears
 * this. */
function ModeChip() {
  return (
    <span
      title={MODE_HELP.records}
      style={{
        padding: "2px 8px", borderRadius: 4, whiteSpace: "nowrap", cursor: "help",
        fontSize: 9.5, fontWeight: 800, fontFamily: "var(--mono)", letterSpacing: "0.06em",
        background: "var(--success-soft)", color: "#006b1a",
      }}
    >CHECKED AGAINST OUR ROWS</span>
  );
}

/* ------------------------------------------------------------------ */

/** Five stars and an optional line. Small, optional, and the only thing on this
 * page that changes what the NEXT answer looks like. */
function StarRating({ value, onPick, size = 20, readOnly = false }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value || 0;
  return (
    <span style={{ display: "inline-flex", gap: 2 }} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          aria-pressed={value === n}
          onMouseEnter={() => !readOnly && setHover(n)}
          onClick={() => !readOnly && onPick?.(n)}
          style={{
            border: 0, background: "none", padding: 0, lineHeight: 1,
            cursor: readOnly ? "default" : "pointer", fontSize: size,
            color: n <= shown ? "#eab308" : "var(--rule)",
          }}
        >★</button>
      ))}
    </span>
  );
}

/** The block under a finished answer. Collapses to a thank-you once used. */
function RateThis({ report, existing, onSaved }) {
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const already = done || existing;

  async function send() {
    const use = rating;
    if (!use) return;
    setBusy(true);
    const res = await saveConsoleFeedback({ reportId: report.id, rating: use, note });
    setBusy(false);
    if (!res.ok) return toast.error("Couldn't save that", res.error);
    setDone(res.row);
    onSaved?.();
    toast.success(
      use <= 3 ? "Noted — the next one will try that" : "Thanks",
      note.trim() ? "Your note goes into the next answer's instructions." : undefined,
    );
  }

  if (already) {
    return (
      <div style={{
        marginTop: 16, padding: "11px 13px", borderRadius: 9, background: "var(--bg-3)",
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <StarRating value={already.rating} size={16} readOnly />
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {already.note
            ? <>Saved. Your note — “{already.note}” — goes into the next answer&apos;s instructions.</>
            : "Saved."}
        </span>
      </div>
    );
  }

  /* Nothing to rate until the row has an id. An unsaved answer (the database
   * refused the insert) has nowhere to hang a rating. */
  if (!report?.id) return null;

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)", fontWeight: 600 }}>How was this?</span>
        {/* Picking a star only OPENS the note box. It used to save immediately
          * when the note was empty, which meant the note box never appeared and
          * the useful half of this — telling it WHY — was unreachable. Caught by
          * walking the built page. */}
        <StarRating value={rating} onPick={setRating} />
        <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>Optional</span>
      </div>
      {rating > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <TextArea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, MAX_FEEDBACK_CHARS))}
            style={{ minHeight: 52, flex: "1 1 320px" }}
            placeholder="How could it be better? Too long, lead with the money, stop repeating the client's name…"
          />
          {/* Works with or without a note — the stars alone are worth saving. */}
          <button className="btn btn-primary" disabled={busy} onClick={send}>
            {busy ? "Saving…" : note.trim() ? "Save note" : "Save rating"}
          </button>
        </div>
      )}
      {rating > 0 && (
        <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 6, lineHeight: 1.5 }}>
          Notes are read on the next run and put into the instructions. They change tone, length and
          what it leads with — they can never let it invent a number.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function ConsoleReportsPanel({ reports, aiReady }) {
  /* SMALL BY DEFAULT.
   *
   * The first version of this was a full-height panel with a section header, a
   * paragraph and an empty state — it pushed the agency numbers below the fold
   * on a laptop, which is the opposite of what a snapshot page is for. Ryder,
   * Aug 23 2026: "put the ai generator as like a small box but when you click
   * open it enlarges the box with the full thing."
   *
   * So: one strip until you want it. Clicking it expands the WHOLE thing in
   * place — the mode switch, the starting points, the box, and the history —
   * rather than opening a modal. One click to the cursor being in the textarea.
   */
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(null);
  const live = isConfigured();
  const { rows, loading, error, sample, reload, ratings } = reports;

  async function remove(row) {
    if (!window.confirm("Delete this one? It cannot be brought back.")) return;
    const res = await deleteConsoleReport(row.id);
    if (!res.ok) return toast.error("Couldn't delete that", res.error);
    toast.info("Deleted");
    reload();
  }

  const savedLine = loading ? "Loading…"
    : error ? "The saved list could not be read"
      : rows.length ? `${rows.length} saved · newest ${timeAgo(rows[0].created_at)}`
        : "Nothing written yet";

  /* ---------------- collapsed: one strip ---------------- */
  if (!open) {
    return (
      <>
        <button
          className="card"
          onClick={() => setOpen(true)}
          style={{
            width: "100%", padding: "14px 18px", cursor: "pointer", textAlign: "left",
            border: "1px solid var(--rule)", background: "white", fontFamily: "var(--body)",
            display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 34, height: 34, flex: "0 0 auto", borderRadius: 9,
              background: "var(--accent-soft)", color: "var(--accent-deep)",
              display: "grid", placeItems: "center", fontSize: 15,
            }}
          >✎</span>
          <span style={{ flex: "1 1 240px", minWidth: 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>
                Ask for anything, written from the records
              </span>
              <SourceBadge
                mode={sample ? "sample" : error ? "error" : aiReady ? "live" : "waiting"}
                hint={sample ? "Preview mode — you get the counted version, no AI call"
                  : aiReady ? "Reads every table this console holds"
                    : "Wired and waiting on ANTHROPIC_API_KEY — SETUP.md § AI"}
              />
            </span>
            <span style={{ display: "block", fontSize: 12.5, color: "var(--ink-dim)", marginTop: 3, lineHeight: 1.5 }}>
              Reads the whole console and writes what you asked for · a Monday update for CJ ·
              everything about one client before a call · a plan for the week
            </span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11.5, color: error ? "var(--danger)" : "var(--ink-dim)", fontFamily: "var(--mono)" }}>
              {savedLine}
            </span>
            <span style={{
              fontSize: 12.5, fontWeight: 700, color: "var(--accent-deep)", whiteSpace: "nowrap",
            }}>Open ▾</span>
          </span>
        </button>
        {reading && (
          <ReadModal
            row={reading}
            existing={ratings?.[reading.id] || null}
            onSaved={reload}
            onClose={() => setReading(null)}
          />
        )}
      </>
    );
  }

  /* ---------------- expanded: the whole thing, in place ---------------- */
  return (
    <>
      <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent-deep)" }}>
        <div style={{
          padding: "15px 18px", display: "flex", alignItems: "flex-start",
          justifyContent: "space-between", gap: 14, flexWrap: "wrap",
          borderBottom: "1px solid var(--line)",
        }}>
          <div style={{ minWidth: 0, flex: "1 1 320px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>
                Ask for anything, written from the records
              </div>
              <SourceBadge
                mode={sample ? "sample" : error ? "error" : aiReady ? "live" : "waiting"}
                hint={sample ? "Preview mode — you get the counted version, no AI call"
                  : aiReady ? "Reads every table this console holds"
                    : "Wired and waiting on ANTHROPIC_API_KEY — SETUP.md § AI"}
              />
            </div>
          </div>
          <button
            className="btn"
            onClick={() => setOpen(false)}
            style={{ whiteSpace: "nowrap" }}
          >Close ▴</button>
        </div>

        <div style={{ padding: "16px 18px" }}>
          <GenerateForm
            live={live}
            aiReady={aiReady}
            onDone={(row) => { reload(); setReading(row); }}
          />
        </div>

        {/* ---- what has been written before ---- */}
        <div style={{ borderTop: "1px solid var(--line)" }}>
          <div style={{ padding: "13px 18px 4px", display: "flex", alignItems: "baseline", gap: 8 }}>
            <div className="label" style={{ marginBottom: 0 }}>Written before</div>
            <span style={{ fontSize: 11.5, color: "var(--ink-dim)", fontFamily: "var(--mono)" }}>
              {loading ? "loading…" : rows.length || "none yet"}
            </span>
          </div>

          {error && (
            <div style={{
              margin: "6px 18px 14px", padding: "10px 12px", borderRadius: 8,
              background: "#fef3f2", color: "#b42318", fontSize: 12.5, lineHeight: 1.5,
            }}>
              The saved list could not be read, so this is not &quot;nothing written yet&quot;.
              <span style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}> {error}</span>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div style={{ padding: "2px 18px 16px", fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>
              Nothing yet.
            </div>
          )}

          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: "11px 18px",
                borderTop: "1px solid var(--line)", flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{r.title}</span>
                  <ModeChip />
                  {ratings?.[r.id] && <StarRating value={ratings[r.id].rating} size={13} readOnly />}
                  <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--ink-faint)" }}>
                    {r.source === "written" ? "AI-WRITTEN" : "COUNTED"}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-dim)", marginTop: 3 }}>
                  {timeAgo(r.created_at)}
                  {r.created_by_email ? ` · ${r.created_by_email}` : ""}
                  {r.instruction ? ` · asked for: "${String(r.instruction).slice(0, 80)}${r.instruction.length > 80 ? "…" : ""}"` : ""}
                </div>
                {r.rejected_why && (
                  <div style={{ fontSize: 11.5, color: "#b54708", marginTop: 4, lineHeight: 1.5 }}>
                    The written version was thrown away — {r.rejected_why}
                  </div>
                )}
                {ratings?.[r.id]?.note && (
                  <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5, fontStyle: "italic" }}>
                    You said: “{ratings[r.id].note}”
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn btn-sm" onClick={() => setReading(r)}>Read</button>
                <button className="btn btn-sm" onClick={() => remove(r)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {reading && (
        <ReadModal
          row={reading}
          existing={ratings?.[reading.id] || null}
          onSaved={reload}
          onClose={() => setReading(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/** The form itself. Lives inline in the expanded box rather than in a modal —
 * one click from the strip to a cursor in the textarea. */
function GenerateForm({ live, aiReady, onDone }) {
  /* No mode state any more. Every answer is checked against the counts. The
   * "free draft" that skipped it was removed on Aug 23 2026 — a badge saying
   * "numbers unchecked" is not a control, because the person who forwards the
   * thing is not the person who read the badge. */
  const [preset, setPreset] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const over = instruction.length > MAX_INSTRUCTION_CHARS;
  const empty = !instruction.trim();

  function pick(p) {
    setPreset(p.id);
    setInstruction(p.instruction);
  }

  async function run() {
    setBusy(true);
    const res = live
      ? await apiFetch("/api/console-report", { method: "POST", body: { instruction: instruction.trim(), preset } })
      : await generateConsoleReportPreview({ instruction: instruction.trim(), preset });
    setBusy(false);

    if (live && !res.ok) return toast.error("Couldn't write that", res.error);
    const data = live ? res : res;
    const payload = live ? res.data : data;
    if (!payload?.report) return toast.error("Nothing came back", "Try again, or check the AI key.");

    if (payload.saved === false) toast.warn("Written, but not filed", payload.saveError);
    else if (payload.rejected && payload.source !== "written") toast.warn("Counted version saved", payload.rejected);
    else toast.success("Done");
    onDone(payload.report);
  }

  return (
    <>
      {!aiReady && live && (
        <div style={{
          padding: "10px 12px", borderRadius: 8, background: "var(--bg-3)",
          fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 14,
        }}>
          There is no AI key set, so this will hand back the <strong>counted</strong> version — the
          real numbers, no writing. Set <span style={{ fontFamily: "var(--mono)" }}>ANTHROPIC_API_KEY</span> and
          the same button starts writing.
        </div>
      )}

      <Field label="Start from one of these">
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {CONSOLE_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => pick(p)}
              title={p.hint}
              style={{
                textAlign: "left", cursor: "pointer", padding: "8px 11px", borderRadius: 8,
                background: preset === p.id ? "var(--accent-soft)" : "white",
                border: preset === p.id ? "1.5px solid var(--accent-deep)" : "1px solid var(--rule)",
                fontFamily: "var(--body)", maxWidth: 205,
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{p.label}</div>
              <div style={{ fontSize: 11, color: "var(--ink-dim)", marginTop: 2, lineHeight: 1.4 }}>{p.hint}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Say what you want, in your own words">
        <TextArea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          style={{ minHeight: 110 }}
          placeholder="Everything Michelle Creamer needs to hear on tomorrow's call, and what I must not promise her."
        />
      </Field>
      <div style={{
        fontSize: 11, fontFamily: "var(--mono)", textAlign: "right", marginTop: -8,
        color: over ? "var(--danger)" : "var(--ink-faint)",
      }}>{instruction.length} / {MAX_INSTRUCTION_CHARS}</div>

      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, flexWrap: "wrap", marginTop: 4,
      }}>
        {/* ONE LINE, not the two paragraphs that used to be here. Ryder cut the
          * paragraphs on Aug 23 2026, but what the tool cannot see is not
          * decoration — a person who does not know it is missing will ask it for
          * a GEO score and believe the answer. So: one line, still true. */}
        <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.6, flex: "1 1 320px", maxWidth: 560 }}>
          Every number is checked against the records. It cannot see the vault, Stripe, the platform&apos;s
          scores, or the text of an email.
        </div>
        <button className="btn btn-primary" disabled={busy || over || empty} onClick={run}>
          {busy ? "Reading the records…" : "Write it"}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Minimal renderer — the same approach clientReports.jsx uses. No markdown
 * library, because the only things the instruction asks for are "## " headings,
 * bullets and paragraphs. */
function RichText({ text }) {
  const blocks = useMemo(() => {
    const lines = String(text || "").split("\n");
    const out = [];
    let list = null;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*[-*•]\s+/.test(line)) {
        list = list || [];
        list.push(line.replace(/^\s*[-*•]\s+/, ""));
        continue;
      }
      if (list) { out.push({ t: "ul", items: list }); list = null; }
      if (!line.trim()) continue;
      if (/^\s{0,3}#{2,6}\s+/.test(line)) out.push({ t: "h", text: line.replace(/^\s{0,3}#+\s+/, "") });
      else out.push({ t: "p", text: line });
    }
    if (list) out.push({ t: "ul", items: list });
    return out;
  }, [text]);

  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "h") {
          return <h4 key={i} style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", margin: "16px 0 6px", letterSpacing: "-0.01em" }}>{b.text}</h4>;
        }
        if (b.t === "ul") {
          return (
            <ul key={i} style={{ margin: "6px 0 10px", paddingLeft: 20 }}>
              {b.items.map((it, j) => (
                <li key={j} style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.65, marginBottom: 3 }}>{it}</li>
              ))}
            </ul>
          );
        }
        return <p key={i} style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.7, margin: "0 0 10px" }}>{b.text}</p>;
      })}
    </>
  );
}

/* ONE RESPONSE, ONE SCROLL.
 *
 * This used to be four tabs — the 30-second version, the full version, worth a
 * look, what it could not check — so the same ground was covered twice and you
 * had to click to find out whether anything had been left unchecked. Ryder,
 * Aug 23 2026: *"i want it to be just one response that speaks and formats the
 * data to how the memory and prompt suggest."*
 *
 * So: one document, top to bottom. Rows written before that date still have the
 * old fields, and they are printed in order rather than hidden. What the
 * records cannot answer stays — it is the honesty line — but as the last part
 * of the same document instead of a tab nobody opens. */
function ReadModal({ row, existing, onSaved, onClose }) {
  const [factsOpen, setFactsOpen] = useState(false);
  const counts = row.facts?.counts || {};

  function download() {
    const md = consoleReportToMarkdown(row, {
      facts: { takenAt: row.counts_at }, source: row.source, instruction: row.instruction,
    });
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `overview-${String(row.created_at || "").slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyAll() {
    const ok = await copyToClipboard(consoleReportToMarkdown(row, {
      facts: { takenAt: row.counts_at }, source: row.source, instruction: row.instruction,
    }));
    if (ok) toast.success("Copied");
    else toast.error("Couldn't copy", "Use Download instead.");
  }

  return (
    <Modal
      open
      onClose={() => { if (!factsOpen) onClose(); }}
      kicker="FROM OUR RECORDS"
      title={row.title || "Overview"}
      width={820}
      footer={<>
        <button className="btn" style={{ marginRight: "auto" }} onClick={() => setFactsOpen(true)}>Check the numbers</button>
        <button className="btn" onClick={download}>Download</button>
        <button className="btn" onClick={copyAll}>Copy all</button>
        <button className="btn btn-primary" onClick={onClose}>Close</button>
      </>}
    >
      <div style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.6, marginBottom: 12 }}>
        {provenanceLine({ takenAt: row.counts_at }, row.source)}
        {row.instruction ? <> Asked for: “{row.instruction}”</> : null}
      </div>

      {row.rejected_why && (
        <div style={{
          padding: "10px 12px", borderRadius: 8, background: "#fffaeb",
          color: "#b54708", fontSize: 12.5, lineHeight: 1.55, marginBottom: 12,
        }}>
          The written version was thrown away, so this is the counted one. Reason: {row.rejected_why}
        </div>
      )}

      {String(row.summary || "").trim() ? <RichText text={row.summary} /> : null}
      <RichText text={row.body} />
      {String(row.watch || "").trim() ? (
        <>
          <h4 style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", margin: "18px 0 6px" }}>Worth a look</h4>
          <RichText text={row.watch} />
        </>
      ) : null}

      {String(row.cannot_check || "").trim() ? (
        <div style={{
          marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--rule)",
        }}>
          <div className="label" style={{ marginBottom: 6 }}>What these records cannot answer</div>
          <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6, marginBottom: 6 }}>
            Nothing above is based on these. Named out loud on purpose — a gap nobody mentions reads
            as “checked, all fine”.
          </div>
          <RichText text={row.cannot_check} />
        </div>
      ) : null}

      <RateThis report={row} existing={existing} onSaved={onSaved} />

      <Modal
        open={factsOpen}
        onClose={() => setFactsOpen(false)}
        kicker="THE COUNTS BEHIND IT"
        title="Check the numbers"
        width={720}
      >
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
          Read at {row.counts_at ? new Date(row.counts_at).toLocaleString("en-US") : "an unknown time"}.
          {" Every number in the answer had to appear in these."}
        </div>
        {(row.facts?.unreadable || []).length > 0 && (
          <div style={{
            marginTop: 10, padding: "9px 11px", borderRadius: 8, background: "#fef3f2",
            color: "#b42318", fontSize: 12, lineHeight: 1.5,
          }}>
            These reads failed and are UNKNOWN, not empty: {row.facts.unreadable.join(", ")}.
          </div>
        )}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 8, marginTop: 12,
        }}>
          {Object.entries(counts).map(([k, v]) => (
            <div key={k} style={{ padding: 10, borderRadius: 8, background: "var(--bg-3)" }}>
              <div style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--ink-dim)", letterSpacing: "0.05em" }}>
                {k.replace(/([A-Z])/g, " $1").toUpperCase()}
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginTop: 3 }}>
                {/^.*Cents$/.test(k) ? `$${Math.round(Number(v || 0) / 100).toLocaleString("en-US")}` : String(v)}
              </div>
            </div>
          ))}
        </div>
        {(row.facts?.cannotAnswer || []).length > 0 && (
          <>
            <div className="label" style={{ marginTop: 16 }}>What these records cannot answer</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
              {row.facts.cannotAnswer.map((l, i) => (
                <li key={i} style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 4 }}>{l}</li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </Modal>
  );
}

export { presetById };
