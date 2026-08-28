import { useCallback, useEffect, useMemo, useState } from "react";
import { listUserBrain, upsertUserBrain, deleteUserBrain } from "../../lib/data.js";
import { checkPersonalRule, PERSONAL_RULE_MAX_CHARS } from "../../../lib/sales-rules.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import {
  SectionHeader, SourceBadge, Modal, Field, TextInput, TextArea, Select, EmptyState, timeAgo,
} from "./shared.jsx";
import { useScreenContext } from "../../lib/screenContext.js";

/* A REP'S OWN AI SETTINGS — how the AI writes for this one person.
 *
 * Aug 27 2026. Every rep sells differently and writes differently, and until now
 * the AI wrote every draft the same way. This page is where one rep teaches it
 * their own voice.
 *
 * IT IS NOT Brain.jsx AND IT MUST NEVER BECOME IT. Brain.jsx is the COMPANY
 * brain: one global list, owner and admin only, closed to the sales role at the
 * database (0001) and closed again at the drafting endpoint (api/ai-draft.js) so
 * a rep cannot get the AI to recite it back. This page reads a different table,
 * admin_user_brain (0022), where every row carries a user_id and a rep can only
 * ever see their own. Two tables, two pages, and neither can leak into the
 * other whatever anybody writes next.
 *
 * THE ONE RULE THE WHOLE PAGE ENFORCES:
 *
 *   A PERSONAL SETTING SETS TONE, LENGTH, FORMAT AND SIGN-OFF. NEVER A FACT
 *   AND NEVER A NUMBER.
 *
 * The reason is mechanical, not a matter of taste, and it is written out in full
 * above checkPersonalRule in lib/sales-rules.js. Short version: what a rep types
 * here is shown to the AI AND to the honesty gate that checks every number in a
 * draft, so a number typed here becomes a number the gate believes we measured.
 * One rep's sentence would become a claim the agency made.
 *
 * So checkPersonalRule is IMPORTED and called before any button does anything.
 * It is not re-implemented here. A second copy of an honesty rule is one copy
 * that quietly stops matching, which is the trap this repo has been bitten by
 * before. It runs again inside upsertUserBrain, at the door, for the same reason
 * every guard in this project is doubled.
 */

/* ------------------------------------------------------------------ */
/* The five fixed settings                                             */
/* ------------------------------------------------------------------ */

/* WHY THESE FIVE ARE PICKERS AND BOXES RATHER THAN SENTENCES A REP TYPES.
 * "Keep it under six sentences" is a rule with a number in it, and a number is
 * exactly what a personal rule may not carry. Making length a picker means the
 * setting a rep actually wants is available without a digit ever being typed.
 *
 * `key` is the setting_key column, and the unique index in 0022 is on
 * (user_id, setting_key) — so picking "Formal" twice updates one row instead of
 * leaving two tone rules arguing inside one prompt.
 *
 * `kind` is 'voice' for all of them except the sign-off, which is 'signature'.
 * The kinds are how lib/ai.js will group these when it reads them, so a sign-off
 * filed as a voice rule would be read as a writing instruction rather than as
 * the line that goes at the bottom. */
const SETTINGS = [
  {
    key: "tone", kind: "voice", title: "Tone", type: "choice",
    label: "Tone",
    help: "How you come across in writing.",
    options: ["Plain and direct", "Warm and friendly", "Formal"],
  },
  {
    key: "length", kind: "voice", title: "Length", type: "choice",
    label: "How long",
    help: "How much you want it to write.",
    options: ["Short — a few sentences at most", "Medium", "Long"],
  },
  {
    key: "subject", kind: "voice", title: "Subject lines", type: "choice",
    label: "Subject lines",
    help: "The line that shows up in their inbox before they open anything.",
    options: ["Lowercase, no punctuation", "Title Case", "A question"],
  },
  {
    key: "signoff", kind: "signature", title: "Sign-off", type: "text",
    label: "Sign-off",
    help: "The last line of your emails. Your name goes here, not a phone number — a phone number is a digit, and no setting on this page may hold one. Put it in your Gmail signature instead, where it is attached to the mailbox that sends the mail.",
    placeholder: "— Your name, AI Syndicate",
  },
  {
    key: "never_say", kind: "voice", title: "Never say", type: "text",
    label: "Words you never want it to use",
    help: "Type them separated by commas. The AI keeps them out of anything it writes for you.",
    placeholder: "synergy, leverage, circle back, touch base",
  },
];

/* The sample lead the Preview button asks for a draft about.
 *
 * IT IS MADE UP ON PURPOSE, and it says so in its own first words. Pointing the
 * preview at a real lead would put a real firm's name into a draft nobody asked
 * for and log a real AI call against a test press. Nothing here is a number, so
 * the preview cannot itself be the thing that puts one into a prompt. */
const SAMPLE_LEAD = [
  "This is a made-up lead, used only to show how a draft would read.",
  "Dana Whitlock runs Ridgeline Roofing, a roofing company in Alabama.",
  "She filled in the form on our site and asked what we actually do.",
  "Write the first email back to her.",
].join(" ");

/* What this rep's AI can and cannot see, in plain words.
 *
 * EVERY LINE HERE IS TRUE OF THIS CODEBASE TODAY, and each one was read off the
 * code rather than off a wishlist: the CAN list is SCOPE_BY_ROLE.sales in
 * lib/brain-context.js, and the CANNOT list is the cannotAnswer block in
 * lib/rep-report.js plus the two tables that are never read for a rep at all.
 * A page that promises a boundary the code does not keep is worse than no page,
 * because somebody reads it once and then trusts it for a year. */
const CAN_SEE = [
  ["Your own leads",
    "The firms you have claimed, what has been logged on them, and where each one is up to."],
  ["The lead list",
    "It reads the lead rows, the same ones you can already see on the Floor. But when it answers about YOUR work, only the firms you have claimed count as yours. A lead another rep has claimed is counted as theirs, never described as yours."],
  ["Firms, lists and proposals",
    "Including the amount written on a proposal, which it is allowed to quote back to you."],
  ["Your own follow-ups",
    "The ones that are on you. Nobody else's."],
  ["Who is on the team",
    "Names and roles, so it knows who it is talking about."],
];

const CANNOT_SEE = [
  ["Money",
    "Invoices, payments and what anything cost are not in a rep's records at all. Nothing it writes can say what a deal is worth beyond the amount written on a proposal."],
  ["Our paying clients' work",
    "Their tasks, their weekly logs and their reports are not in your records. A firm marked as already a client is the only trace of one."],
  ["The company AI Brain",
    "The agency-wide rules the owners keep. It is shut to a rep in the database, and shut again in the part of the console that writes drafts, so nothing can read it back to you."],
  ["The password vault",
    "Not restricted — simply never read. There is no vault lookup anywhere in the AI's reading, so no label, username or password can end up in a draft."],
  ["Anybody else's follow-ups",
    "Only your own are ever counted."],
  ["Platform scans",
    "No scan results and no citation history from the AI Syndicate platform. The only platform figure anywhere is the website score on a firm, and only where a score has actually been run."],
  ["Anything nobody wrote down",
    "A call that was never logged did not happen as far as these rows go."],
];

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

export default function RepBrain({ member }) {
  /* NO ID MEANS NOTHING, NEVER EVERYTHING. These are one person's own settings,
   * and reading them without knowing whose would show somebody else's — in
   * preview mode there is no database rule stopping it. listUserBrain refuses on
   * its own; this page surfaces that refusal in words instead of drawing an
   * empty list, because an empty list reads as "you have no settings" when the
   * truth is "we did not look". */
  const userId = member?.user_id || null;

  const [brain, setBrain] = useState({ rows: [], sample: true, error: null, loaded: false });
  const [drafts, setDrafts] = useState({});   // what has been TYPED into a text setting, not yet saved
  const [busyKey, setBusyKey] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [preview, setPreview] = useState(null); // null | { busy } | { text } | { error, keysMissing }

  const load = useCallback(async () => {
    const b = await listUserBrain(userId);
    setBrain({
      rows: b.rows || [],
      sample: Boolean(b.sample),
      error: b.error || null,
      loaded: true,
    });
  }, [userId]);

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("adm-refresh", onRefresh);
    return () => window.removeEventListener("adm-refresh", onRefresh);
  }, [load]);

  const byKey = useMemo(() => {
    const m = new Map();
    for (const r of brain.rows) if (r.setting_key) m.set(r.setting_key, r);
    return m;
  }, [brain.rows]);

  const rules = useMemo(() => brain.rows.filter((r) => r.kind === "rule"), [brain.rows]);

  useScreenContext(() => ({
    page: "AI Brain (your own)",
    label: `${byKey.size} settings set, ${rules.length} rules`,
    /* The rules themselves are named, not their contents. They are short and they
     * are this person's own, and the assistant answering "what are my rules" is
     * the point of publishing anything here. */
    visible: rules.slice(0, 12).map((r) => `my rule: ${r.body}`),
  }), [byKey.size, rules.length]);

  /* ---- writing ---------------------------------------------------- */

  /* ONE SAVE PATH FOR EVERY BOX ON THE PAGE.
   *
   * The gate runs FIRST, so a refused value writes nothing at all — not the row,
   * not a toast that says saved. Then upsertUserBrain, whose { ok, error } shape
   * is read rather than assumed: none of these writers throw, so a page that
   * does not check `ok` shows a green tick over a save that never happened.
   *
   * `body` is ALWAYS sent, even when only `enabled` is changing. upsertUserBrain
   * gates on patch.body, so a patch without one is refused with "Write the rule
   * first" — which would make the On/Off switch look broken for a reason nobody
   * could guess from the screen. */
  const saveRow = async ({ id, kind, settingKey, title, body, enabled, okTitle, okBody }) => {
    if (!userId) {
      toast.error("Nothing was saved", "This page does not know who you are, so it will not write a setting under somebody else's name.");
      return false;
    }
    const gate = checkPersonalRule(body);
    if (!gate.ok) { toast.warn("Not saved", gate.error); return false; }

    /* THE TITLE IS ONLY IN THE PATCH WHEN THE CALLER GAVE ONE.
     *
     * It used to be `title: title ?? null` unconditionally, which meant a patch
     * that only meant to flip On/Off also blanked the label — and the label is
     * what a person reads on the row. It also defeated the whole point of not
     * resending it: upsertUserBrain checks a title whenever the patch carries one,
     * so a rule with an old digit-bearing label could not be switched off.
     * Aug 27 2026, after a review. */
    const patch = {
      kind, body: gate.text, user_id: userId,
      setting_key: settingKey ?? null,
    };
    if (title !== undefined) patch.title = title ?? null;
    if (id) patch.id = id;
    if (enabled !== undefined) patch.enabled = enabled;

    setBusyKey(settingKey || id || "new");
    const res = await upsertUserBrain(patch);
    setBusyKey(null);
    if (!res.ok) {
      /* THE SCREEN DOES NOT MOVE ON A FAILED SAVE. No reload, no optimistic
       * change: the pickers are drawn straight from the rows, so leaving the
       * rows alone puts a refused pick back where it was by itself. The error
       * text is printed as it came, because "couldn't save" on its own sends
       * somebody to ask CJ instead of reading the reason. */
      toast.error("Not saved", res.error);
      return false;
    }
    toast.success(okTitle || "Saved", okBody);
    await load();
    return true;
  };

  const saveSetting = async (def, value) => {
    const existing = byKey.get(def.key);
    const ok = await saveRow({
      id: existing?.id, kind: def.kind, settingKey: def.key, title: def.title, body: value,
      okTitle: `${def.title} saved`,
      okBody: "Every draft written for you from now on follows it.",
    });
    /* The typed copy is dropped only once the row underneath really changed, so
     * a refused save leaves the words in the box rather than throwing away what
     * somebody just typed. */
    if (ok) setDrafts((d) => { const n = { ...d }; delete n[def.key]; return n; });
  };

  const removeRow = async (row, what) => {
    if (!window.confirm(`Remove this ${what}? Drafts stop using it straight away.`)) return;
    /* The owner id goes with it. deleteUserBrain refuses without one, in both
     * branches, so that preview mode cannot delete a rule the real database would
     * have protected. Aug 27 2026 */
    const res = await deleteUserBrain(row.id, userId);
    if (!res.ok) { toast.error("Not removed", res.error); return; }
    toast.success("Removed");
    load();
  };

  const toggleRule = async (row) => {
    await saveRow({
      /* THE TITLE IS DELIBERATELY NOT RESENT. Switching a rule off must work on
       * every rule, including one whose label was written before the no-numbers
       * check existed — and upsertUserBrain checks a title whenever it is given
       * one. Sending it back unchanged would have made the one action you want on
       * a bad rule the one action refused. Aug 27 2026, after a review. */
      id: row.id, kind: row.kind, settingKey: row.setting_key,
      body: row.body, enabled: !row.enabled,
      okTitle: row.enabled ? "Switched off" : "Switched on",
      okBody: row.enabled
        ? "It is kept here, it just does not shape drafts any more."
        : "Drafts follow it again.",
    });
  };

  /* ---- the preview draft ------------------------------------------ */

  const runPreview = async () => {
    setPreview({ busy: true });
    const res = await apiFetch("/api/ai-draft", {
      method: "POST",
      body: { kind: "lead_outreach", context: SAMPLE_LEAD },
    });
    if (!res.ok) {
      /* NO FAKE DRAFT, EVER. apiFetch answers { ok:false, preview:true } when the
       * keys are not set, and a made-up example in that box would be read as
       * "this is what the AI writes for me" by the one person who most needs to
       * know it has not run. So the box says what is missing instead. */
      setPreview({ error: res.error, keysMissing: Boolean(res.preview) });
      return;
    }
    setPreview({ text: res.data?.text || "" });
  };

  /* ---- the states before the page can work ------------------------ */

  if (!userId) {
    return (
      <>
        <PageHead />
        <div className="rb-note rb-note-stop">
          <strong>Nothing was read, on purpose.</strong> This page could not tell who is signed in.
          These are one person&apos;s own settings, so reading them without knowing whose would show
          you somebody else&apos;s. Sign out and back in, and if it still says this, send CJ a
          screenshot of this line.
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <SourceBadge
          mode={brain.error ? "error" : brain.sample ? "sample" : "live"}
          hint={brain.error
            ? "These settings were read and the read failed — the reason is on the page"
            : brain.sample
              ? "Preview only. Nothing here is being saved for real."
              : "Your own settings, read from the database just now"}
        />
      </div>

      {/* A READ THAT FAILED IS NOT AN EMPTY PAGE. The likeliest reason is that the
        * table these live in has not been made yet, but a permission rule and a
        * dropped connection look the same from here, so the reason is printed
        * rather than guessed at. */}
      {brain.error && (
        <div className="rb-note rb-note-stop">
          <strong>Your settings could not be read.</strong> What came back was: {brain.error}
          <div style={{ marginTop: 6 }}>
            Nothing below is your real setup, and nothing you change will save while this line is
            here. The likeliest cause is that the part of the database these settings live in has not
            been switched on yet. Send CJ or Andrew a screenshot of this line.
          </div>
        </div>
      )}

      {brain.sample && !brain.error && (
        <div className="rb-note rb-note-warn">
          <strong>This is a preview. Nothing is being saved.</strong> The settings below are sample
          ones, and anything you change here is gone the moment you reload. It starts saving for real
          once this console is connected to the database.
        </div>
      )}

      {/* THE WIRE IS IN — and this note said the opposite for a few hours on
        * Aug 27 2026, which was the most likely thing on this page to be acted on
        * wrongly: a rep reads "drafts are not reading these yet" and stops
        * bothering to set anything, while every draft is already following them.
        *
        * What is true now: api/ai-draft.js reads admin_user_brain for the caller,
        * unconditionally and for every role, and hands it to lib/ai.js
        * buildSystemPrompt, which places it AFTER the company rules and BEFORE
        * the job instruction with a line saying the company rules win.
        * api/rep-report.js does the same into repFactsText, so the honesty gate
        * reads the same words the model read.
        *
        * What is still NOT true, and is the reason this note exists at all rather
        * than being deleted: none of it can run without an AI key on the server,
        * and none of it saves without migration 0022. Both are said below in the
        * words a person can act on. */}
      <div className="rb-note">
        <strong>Where these actually get used.</strong> Every draft the AI writes for you reads
        these settings first — the email box on a lead, and the Preview button below. They sit under
        the agency&rsquo;s own writing rules, which always win: these change how a draft reads, never
        what it says is true.
      </div>

      {/* ---------------- Card 1 — how I write ---------------- */}
      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <CardHead
          icon="🎙"
          title="How I write"
          blurb="Five settings. Pick each one once and the AI writes the way you do."
        />
        {SETTINGS.map((def) => {
          const row = byKey.get(def.key);
          const saved = row?.body || "";
          if (def.type === "choice") {
            /* A SAVED VALUE THAT IS NOT ON THE LIST IS STILL SHOWN. Somebody else's
             * screen, an older list of choices or a value typed straight into the
             * database would otherwise make the picker quietly show the first
             * option while a different one was saved, and the first time anybody
             * noticed would be a draft written the wrong way. */
            const options = saved && !def.options.includes(saved)
              ? [saved, ...def.options]
              : def.options;
            return (
              <SettingRow key={def.key} def={def} row={row}>
                <Select
                  value={saved || ""}
                  disabled={busyKey === def.key}
                  onChange={(e) => saveSetting(def, e.target.value)}
                  options={[
                    ...(saved ? [] : [["", "Not set yet — pick one"]]),
                    ...options.map((o) => [o, o]),
                  ]}
                />
              </SettingRow>
            );
          }
          const typed = drafts[def.key];
          const value = typed === undefined ? saved : typed;
          const dirty = typed !== undefined && typed !== saved;
          const gate = checkPersonalRule(value);
          const showGate = value.trim().length > 0 && !gate.ok;
          return (
            <SettingRow key={def.key} def={def} row={row}>
              <TextInput
                value={value}
                placeholder={def.placeholder}
                onChange={(e) => setDrafts((d) => ({ ...d, [def.key]: e.target.value }))}
              />
              {showGate && <GateNote text={gate.error} />}
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <button
                  className="btn btn-accent btn-sm"
                  /* The button is dead while the words fail the check, so the
                   * refusal is something you see before you press rather than a
                   * red box after. */
                  disabled={!dirty || !gate.ok || busyKey === def.key}
                  onClick={() => saveSetting(def, value)}
                >
                  {busyKey === def.key ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
                {row && (
                  <button className="btn btn-sm" onClick={() => removeRow(row, "setting")}>Clear it</button>
                )}
              </div>
            </SettingRow>
          );
        })}
      </div>

      {/* ---------------- Card 2 — my rules ---------------- */}
      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <CardHead
          icon="⚖️"
          title="My rules"
          blurb="Lines you want the AI to keep to. Written in your own words, one at a time."
          right={
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn btn-sm" onClick={runPreview}>Preview a draft</button>
              <button className="btn btn-accent btn-sm" onClick={() => setAddOpen(true)}>+ Add a rule</button>
            </div>
          }
        />

        {/* THE WARNING IS A PARAGRAPH, NOT A CHIP, and it sits above the rules
          * rather than inside the add box — the person reading a list of rules is
          * the person about to write another one. */}
        <div className="rb-note rb-note-warn" style={{ marginTop: 12 }}>
          These set tone, length and format only, never facts or numbers. If you could type a fact in
          here, the AI could repeat it as if we measured it. Facts come from the records, always.
        </div>

        {rules.length === 0 ? (
          <EmptyState
            icon="⚖️"
            title="No rules yet"
            body="Start with one thing you always do and one thing you never do. Every draft written for you follows them from then on."
            action={<button className="btn btn-accent" onClick={() => setAddOpen(true)}>+ Add the first rule</button>}
          />
        ) : rules.map((row) => (
          <div
            key={row.id}
            style={{
              padding: "12px 0", borderTop: "1px solid var(--rule)",
              display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start",
              opacity: row.enabled ? 1 : 0.55,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {row.body}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--rb-quiet)" }}>
                {row.enabled ? "In use" : "Switched off, still here"} · added {timeAgo(row.created_at)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {/* SWITCHED OFF RATHER THAN GONE. A rep can try a rule, turn it off,
                * and still find it next week — which is why 0022 has an `enabled`
                * column at all. Remove is the separate, deliberate press. */}
              <button
                className="btn btn-sm"
                disabled={busyKey === row.id}
                onClick={() => toggleRule(row)}
                title={row.enabled ? "Stop using it, but keep it here" : "Start using it again"}
              >
                {row.enabled ? "On ✓" : "Off"}
              </button>
              <button className="btn btn-sm" onClick={() => removeRow(row, "rule")}>Remove</button>
            </div>
          </div>
        ))}

        <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--rb-quiet)", lineHeight: 1.6 }}>
          CJ and Andrew can read what is on this page. They cannot change it. How you write is yours,
          and a rule nobody can look at would quietly change what prospects get told.
        </div>
      </div>

      {/* ---------------- Card 3 — what it knows about you ---------------- */}
      <div className="card" style={{ padding: 18 }}>
        <CardHead
          icon="👁"
          title="What it knows about you"
          blurb="Exactly what the AI can read when it writes for you, and what it cannot. This is the real list, not a promise."
        />
        <KeyValues label="It can read" items={CAN_SEE} />
        <KeyValues label="It cannot read" items={CANNOT_SEE} tone="stop" />
      </div>

      {addOpen && (
        <AddRuleModal
          onClose={() => setAddOpen(false)}
          onSave={async (text) => {
            const ok = await saveRow({
              kind: "rule", body: text,
              okTitle: "Rule added",
              okBody: "Every draft written for you follows it from now on.",
            });
            if (ok) setAddOpen(false);
          }}
          busy={busyKey === "new"}
        />
      )}

      {preview && <PreviewModal state={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                             */
/* ------------------------------------------------------------------ */

function PageHead() {
  return (
    <SectionHeader
      kicker="YOUR OWN AI"
      title="AI Brain"
      subtitle="Your own AI, not the company one. This is where you teach it how you sell — how you write, how you sign off, what you say about price. Every draft it writes for you uses these."
    />
  );
}

function CardHead({ icon, title, blurb, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 6 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden="true">{icon}</span>
          <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{title}</span>
        </div>
        <div style={{ marginTop: 3, fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.55 }}>{blurb}</div>
      </div>
      {right}
    </div>
  );
}

function SettingRow({ def, row, children }) {
  return (
    <div style={{ padding: "14px 0", borderTop: "1px solid var(--rule)" }}>
      <div className="label" style={{ marginBottom: 6 }}>{def.label}</div>
      {children}
      <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--rb-quiet)", lineHeight: 1.6 }}>
        {def.help}
        {/* SET WHEN, OR NOT SET AT ALL — said in words. A blank box and a box
          * whose setting was cleared look identical, and only one of them means
          * the AI is falling back to the house default. */}
        {row
          ? ` Saved ${timeAgo(row.updated_at || row.created_at)}.`
          : " Nothing saved yet, so drafts use the house default."}
      </div>
    </div>
  );
}

/* The refusal, in the words checkPersonalRule itself uses. Not paraphrased: the
 * sentence a person reads has to be the sentence the check will keep giving
 * them, or they fix the wrong thing and press again. */
function GateNote({ text }) {
  return (
    <div className="rb-note rb-note-stop" style={{ marginTop: 8, marginBottom: 0 }}>
      {text}
    </div>
  );
}

function KeyValues({ label, items, tone }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="label" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {items.map(([k, v]) => (
          <div
            key={k}
            style={{
              padding: "10px 12px", borderRadius: 8,
              background: tone === "stop" ? "#fef3f2" : "var(--bg-3)",
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700, color: tone === "stop" ? "#b42318" : "var(--ink)" }}>{k}</div>
            <div style={{ marginTop: 3, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddRuleModal({ onClose, onSave, busy }) {
  const [text, setText] = useState("");
  const gate = checkPersonalRule(text);
  const showGate = text.trim().length > 0 && !gate.ok;

  return (
    <Modal
      open onClose={onClose} kicker="YOUR OWN AI" title="Add a rule" width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-accent"
          /* Dead until the words pass. The same check runs again in
           * upsertUserBrain, so a rule that got past this button still cannot
           * reach the database with a number in it. */
          disabled={busy || !gate.ok}
          onClick={() => onSave(text)}
        >
          {busy ? "Saving…" : "Save rule"}
        </button>
      </>}
    >
      <Field
        label="The rule"
        hint="One line, in your own words. Say what you always do or never do."
      >
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ minHeight: 110 }}
          placeholder={'e.g. Never open with "I hope this email finds you well".'}
        />
      </Field>
      {showGate && <GateNote text={gate.error} />}
      <div style={{ fontSize: 11.5, color: "var(--rb-quiet)" }}>
        {text.length} of {PERSONAL_RULE_MAX_CHARS} characters
      </div>
    </Modal>
  );
}

function PreviewModal({ state, onClose }) {
  return (
    <Modal open onClose={onClose} kicker="YOUR OWN AI" title="A draft, written your way" width={620}
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="rb-note rb-note-warn">
        <strong>This is a made-up lead.</strong> Dana at Ridgeline Roofing does not exist. Nothing is
        sent anywhere and no real firm is touched.
      </div>

      {state.busy && <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>Writing it…</div>}

      {state.error && (
        <div className="rb-note rb-note-stop">
          {state.keysMissing ? (
            <>
              <strong>No draft was written.</strong> Writing one needs the AI key, and this console
              does not have it yet. There is deliberately nothing in this box: a made-up example
              here would read as what the AI writes for you, which is the one thing it is not.
            </>
          ) : (
            <>
              <strong>No draft was written.</strong> What came back was: {state.error}
            </>
          )}
        </div>
      )}

      {state.text !== undefined && (
        <>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {state.text || "The AI answered with nothing at all. That is a fault, not an empty draft — try again, and tell Andrew if it keeps happening."}
          </div>
          {/* Said again HERE, next to the words, because this box is where somebody
            * would otherwise conclude their settings had been ignored. */}
          <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--rb-quiet)", lineHeight: 1.6 }}>
            Your settings above are not shaping this yet. The part of the console that writes drafts
            is still being connected to them, so this reads in the house voice rather than yours.
          </div>
        </>
      )}
    </Modal>
  );
}
