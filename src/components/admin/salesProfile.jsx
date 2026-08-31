import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  LEAD_STAGES, LEAD_STAGE_LABELS, LEAD_STAGE_HELP, PICKABLE_STAGES,
  listLeadActivity, addLeadActivity, listProposals, upsertProposal, deleteProposal,
  claimLead, releaseLead, upsertLead, upsertCompany, claimTextSend, logActivity,
  listTasks, listWeekly, listClientReports, listTickets,
} from "../../lib/data.js";
import { listInvoices } from "../../lib/finance.js";
import { buildPersonTimeline, timelineSummary } from "../../../lib/person-timeline.js";
import {
  claimState, cadenceState, scoreGate, textGate, companyClaimWarning,
  CADENCE, CADENCE_STOPS, SEVEN_MOVES, ROE,
} from "../../../lib/sales-rules.js";
import { apiFetch } from "../../lib/adminApi.js";
import { toast } from "../../lib/toast.js";
import { Modal, Field, TextInput, TextArea, Select, timeAgo } from "./shared.jsx";
import { StagePill, ClaimChip, ScoreChip, FirmWarning, money, SiteLink } from "./salesParts.jsx";
/* One place decides how a date is written for a person to read, and it counts
 * days in the team's own calendar rather than the browser's. */
import { sheetDateLong } from "../../lib/salesSheet.js";

/* THE PROFILE — one person, everything about them, in one place.
 *
 * This is the thing a spreadsheet cannot be. The sheet has one row per person
 * and six editable cells; overwrite "Last Touch" and what was there before is
 * gone forever. Here every call, email, note, stage change, claim and score
 * run is a row that is never edited and never deleted, so "what has actually
 * happened with this firm" is a question with an answer.
 *
 * Five tabs, in the order a rep actually needs them:
 *   Work      — what is owed right now, and the buttons to do it
 *   Timeline  — everything that has happened, newest first
 *   Details   — the person and the firm, editable in place
 *   Proposals — what was sent, for how much, and what came back
 *   Playbook  — the 7 moves and the cadence, so nobody has to remember them
 */

const OUTCOMES = [
  ["talked", "Talked to them"], ["voicemail", "Left a voicemail"], ["no_answer", "No answer"],
  ["booked", "Booked a meeting"], ["not_interested", "Not interested"], ["bad_number", "Bad number"],
];

const TABS = [
  ["work", "Work"], ["timeline", "Timeline"], ["details", "Details"],
  ["proposals", "Proposals"], ["playbook", "Playbook"],
];

export default function SalesProfile({
  lead, company, siblings, member, team, teamName, now,
  touches, onClose, reload,
  /* ---- added Aug 27 2026 with The Floor ----
   *
   * `readOnly` is the row lock, DERIVED BY THE PAGE and handed down rather than
   * worked out here. The Floor shows every lead in the company, so this drawer
   * now opens on leads the reader may not change — and a drawer that decided for
   * itself whether it was read-only could disagree with the row it was opened
   * from. One derivation, in SalesPage, from canEditLead().
   *
   * Read-only means READ-ONLY, not hidden: every field, every note and the whole
   * timeline are visible, and there is not one button. A rep has to be able to
   * see that somebody else is already in this building and what was said — that
   * is the entire reason for showing them the row. */
  readOnly = false,
  heldByName = "another rep",
  /* Tags, the newest scan, and the four things a button in here can now ask the
   * page to do. Every one of them is ONE function that also writes the dated
   * line; nothing in this file writes a tag or closes a deal itself. */
  tags = [], allTags = [], onTag = null, onRefreshTags = null,
  report = null, onScan = null, onCloseDeal = null,
  /* onStage(stage, note, extra) — THE ONLY WAY THIS DRAWER MOVES A LEAD, and it
   * is the page's gated path, not this file's local `patch`. Every stage write
   * in here used to call `upsertLead` directly, which meant the Follow up /
   * Meeting / Proposal requirements existed on the sheet and nowhere else.
   * Restricting one control is not restricting the act. 30 Aug 2026 */
  onStage = () => {},
}) {
  const [tab, setTab] = useState("work");
  const [activity, setActivity] = useState(null);
  const [proposals, setProposals] = useState([]);
  /* Everything that happened AFTER the sale. Only fetched once this person is
   * attached to a client — before that there is nothing to fetch, and firing
   * five reads on every drawer open for the 99% of contacts who are not
   * clients would make opening a lead slow for no reason.
   *
   * `null` means NOT READ. It is not the same as `[]`, and the timeline says
   * which it was underneath — an unread source and an empty one look identical
   * on screen and mean opposite things. */
  const [after, setAfter] = useState({ tasks: null, weekly: null, reports: null, invoices: null, tickets: null, incomplete: [] });
  const [busy, setBusy] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [logOpen, setLogOpen] = useState(null);       // 'call' | 'email' | 'text' | 'linkedin' | 'note'
  const [proposalOpen, setProposalOpen] = useState(false);

  const load = useCallback(async () => {
    const [a, p] = await Promise.all([listLeadActivity(lead.id), listProposals(lead.id)]);
    setActivity(a.rows);
    setProposals(p.rows);

    const clientId = lead.client_id || company?.client_id || null;
    if (!clientId) { setAfter({ tasks: null, weekly: null, reports: null, invoices: null, tickets: null, incomplete: [] }); return; }
    const [t, w, r, inv, k] = await Promise.all([
      listTasks(clientId), listWeekly(clientId), listClientReports(clientId), listInvoices(), listTickets(),
    ]);
    /* Invoices and tickets are read WHOLE — neither reader takes a client id —
     * and both have their own row limits. Past those limits an older client's
     * rows simply are not in what came back, and filtering here cannot tell
     * that apart from having none. So the cap is carried through to the
     * timeline and printed, instead of a short read looking like a quiet one. */
    /* EVERY reader's own limit, not just the two whole-table ones. A reviewer
     * found that `listClientReports` stops at 25 — about six months of weekly
     * reports — and `listTasks` at 500, and neither was reported. A cap that is
     * not said is a timeline quietly missing its own history, in a file whose
     * stated rule is "THE CAP SAYS SO". */
    const INVOICE_LIMIT = 1000;
    const TICKET_LIMIT = 500;
    const REPORT_LIMIT = 25;
    const TASK_LIMIT = 500;
    const incomplete = [];
    if (!inv.error && (inv.rows || []).length >= INVOICE_LIMIT) incomplete.push("invoices");
    if (!k.error && (k.rows || []).length >= TICKET_LIMIT) incomplete.push("support tickets");
    if (!r.error && (r.rows || []).length >= REPORT_LIMIT) incomplete.push("reports");
    if (!t.error && (t.rows || []).length >= TASK_LIMIT) incomplete.push("the work list");

    setAfter({
      /* A read that FAILED comes back null, not empty. Turning an error into an
       * empty array here would print "nothing was ever done for this client"
       * with total confidence. */
      tasks: t.error ? null : (t.rows || []),
      weekly: w.error ? null : (w.rows || []),
      reports: r.error ? null : (r.rows || []),
      invoices: inv.error ? null : (inv.rows || []).filter((x) => x.client_id === clientId),
      tickets: k.error ? null : (k.rows || []).filter((x) => x.client_id === clientId),
      incomplete,
    });
  }, [lead.id, lead.client_id, company?.client_id]);

  useEffect(() => { load(); }, [load]);

  const claim = claimState(lead, now);
  const cadence = cadenceState(lead, now, touches);
  const gate = scoreGate(company?.site_score);
  const text = textGate(lead);
  /* THE FIRM WARNING NAMES NOBODY FOR A REP — 30 Aug 2026.
   *
   * A rep no longer sees another rep's rows (visibleToMember in
   * src/lib/salesSheet.js), so printing that rep's NAME in a warning would hand
   * back through a sentence exactly what was hidden as a record. The warning
   * itself stays — it is the whole reason the rows can be hidden safely — and
   * it stays counted from every contact at the firm.
   *
   * Done by swapping the naming function rather than by adding a branch inside
   * companyClaimWarning: that function is pure, tested, and shared with the
   * owner's page, where the names are the point. */
  const warnName = member.role === "sales"
    ? () => "Somebody on the team"
    : teamName;
  const warning = companyClaimWarning(lead, siblings, warnName, now, member.user_id);

  const patch = async (p, note) => {
    setBusy(true);
    const res = await upsertLead({ id: lead.id, ...p });
    setBusy(false);
    if (!res.ok) { toast.error("Save failed", res.error); return false; }
    if (note) await addLeadActivity({ leadId: lead.id, actor: member.user_id, type: "status_change", body: note });
    await load();
    await reload();
    return true;
  };

  const doClaim = async (withSiblings) => {
    const also = withSiblings ? siblings.filter((s) => !s.owner_id).map((s) => s.id) : [];
    setBusy(true);
    const res = await claimLead(lead.id, member.user_id, {
      alsoSiblings: also, name: member.full_name || member.email,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not claim it", res.error); return; }
    toast.success(
      res.count > 1 ? `Claimed ${res.count} contacts` : "Claimed",
      `First contact is due within ${ROE.FIRST_CONTACT_BUSINESS_DAYS} business days, or it goes back to the floor.`
    );
    await load();
    await reload();
  };

  const doRelease = async () => {
    setBusy(true);
    const res = await releaseLead(lead.id, {
      actor: member.user_id,
      why: `${member.full_name || member.email} handed this back to the floor.`,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not release it", res.error); return; }
    toast.info("Back on the floor", "Anybody can claim it now.");
    await load();
    await reload();
  };

  const runScore = async () => {
    if (!company) { toast.warn("No firm on this contact", "Add a company in Details first — the score belongs to the firm."); return; }
    if (!company.domain) { toast.warn("No website to score", "Add the firm's website in Details first."); return; }
    setScoring(true);
    const res = await apiFetch("/api/sales-score", { method: "POST", body: { companyId: company.id, domain: company.domain } });
    setScoring(false);
    if (!res.ok) {
      toast.error("Could not run the score", res.preview
        ? "Preview mode — scoring needs the Supabase keys and PLATFORM_SCORE_URL. See SETUP.md."
        : res.error);
      return;
    }
    const g = scoreGate(res.data.score);
    toast[g.skip ? "warn" : "success"](`Scored ${res.data.score}`, g.why);
    await load();
    await reload();
  };

  /* THE ONE WON PATH FOR THIS WHOLE DRAWER.
   *
   * Three buttons in here used to close a deal — this one, the Stage dropdown,
   * and setting a proposal to Won — and all three wrote `stage:"won"` by hand
   * and created no client. Because the sheet's converting path skipped
   * anything already at Won, using any of them first made the working path a
   * no-op for that lead FOREVER. All three call this now. See markLeadWon in
   * src/lib/data.js for the rules it holds. */
  /* WON AND LOST BOTH GO THROUGH THE REASON BOX NOW — Aug 27 2026.
   *
   * This function used to write. It asks instead: the box is owned by SalesPage
   * and it sits in front of ONE function (closeLeadWon / markLeadLost in
   * src/lib/data.js), not in front of the four buttons that reach it. That is the
   * lesson from Won itself — four buttons each holding their own version of one
   * act had four behaviours, and one of them permanently blocked the only one
   * that worked. Putting a reason box on each of them would have put it on three
   * and missed one.
   *
   * markLeadWon is still the function underneath. It is just no longer reachable
   * without a reason.
   *
   * The fallback keeps the drawer usable if it is ever mounted without the
   * handler: it says plainly that the reason box is not wired up rather than
   * silently doing nothing, which is the failure mode of a button that used to
   * work. */
  const doClose = (kind) => {
    if (!onCloseDeal) {
      toast.error("The reason box is not open on this screen", "Close and mark it from the list instead — a deal is not recorded without a reason.");
      return;
    }
    onCloseDeal(kind);
  };

  const doWin = () => doClose("won");
  const flipToClient = () => doClose("won");

  return createPortal(
    <>
      <div className="adm-drawer-backdrop" onClick={onClose} />
      <div className="adm-drawer adm-sl-drawer" role="dialog" aria-modal="true" aria-label={`Lead: ${lead.name || lead.company}`}>
        {/* ---- head ---- */}
        <div className="adm-drawer-head">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="adm-sl-name">{lead.name || lead.company || "Contact"}</div>
              <div className="adm-sl-sub">
                {[lead.title, company?.name || lead.company, lead.city ? `${lead.city}${lead.state ? `, ${lead.state}` : ""}` : null]
                  .filter(Boolean).join(" · ")}
              </div>
            </div>
            <button className="adm-modal-x" onClick={onClose} aria-label="Close">×</button>
          </div>

          <div className="adm-sl-chips">
            <StagePill stage={lead.stage} />
            <ClaimChip lead={lead} now={now} />
            <ScoreChip score={company?.site_score} onRun={readOnly ? undefined : runScore} busy={scoring} />
            {/* THE THREE SCORES, next to the one. `site_score` is the single
                number admin_companies can hold and it is what the 90+ gate reads;
                the scan report holds AI Access, ordinary search, and how often an
                AI names the firm. Both are shown because they are different
                measurements taken at different times — folding them into one chip
                would mean picking which date to print.
                A dash is a half of the scan that did not come back. It is missing,
                not zero: a firm shown as 0 for AI Access reads as the worst site
                anybody has seen, and that is the hardest a rep would ever go in. */}
            {onScan && (
              <button
                type="button"
                className="adm-sl-pill adm-sl-pill-btn"
                title={report
                  ? `Measured ${report.measuredAt ? sheetDateLong(report.measuredAt) : "on an unreadable date"} on ${report.domain || "an unrecorded website"}. Click for the findings.`
                  : "Nobody has scanned this site. That is no score, not a bad one."}
                onClick={onScan}
              >
                {report
                  ? `AI ${report.aiAccess === null ? "—" : report.aiAccess} · SEO ${report.seo === null ? "—" : report.seo}${report.simTotal ? ` · named ${report.simHits}/${report.simTotal}` : ""}`
                  : "NO SCAN"}
              </button>
            )}
            {lead.owner_id && (
              <span className="adm-sl-owner">
                {lead.owner_id === member.user_id ? "Yours" : `Claimed by ${teamName(lead.owner_id)}`}
              </span>
            )}
          </div>

          {/* ---- TAGS, on the record itself ----
              Chips read off the event log (replayed by the page, never a
              column), and the whole dated history is one click away. Shown on a
              read-only record too: a rep about to email a firm has to be able to
              see that it is already tagged `hot`. */}
          {(tags.length > 0 || (!readOnly && onTag)) && (
            <div className="adm-sl-chips" style={{ marginTop: 6 }}>
              {tags.map((t) => (
                <button
                  key={t.tag_id}
                  type="button"
                  className="adm-sl-pill adm-sl-pill-btn"
                  disabled={readOnly}
                  title={readOnly
                    ? (t.why || "No reason recorded.")
                    : `${t.why || "No reason recorded."} Click to take it off.`}
                  onClick={() => onTag?.({ id: t.tag_id, label: t.label }, "removed")}
                >
                  {t.label}
                </button>
              ))}
              {/* ADDING A TAG FROM THE RECORD ITSELF. Without this a rep working
                  inside a record had to close it, find the row again and use the
                  Floor's tag panel — and a control that only exists one screen
                  away is a control nobody uses.
                  Only tags on the company's list: naming a brand new tag is an
                  owner's decision (0018), because three spellings of one tag is
                  a filter menu nobody can use. */}
              {!readOnly && onTag && allTags.length > 0 && (
                <select
                  className="adm-input"
                  style={{ width: 168 }}
                  value=""
                  aria-label="Add a tag"
                  onChange={(e) => {
                    const tag = allTags.find((t) => t.id === e.target.value);
                    if (tag) onTag(tag, "added");
                  }}
                >
                  <option value="">+ add a tag…</option>
                  {allTags
                    .filter((t) => t.active !== false && !tags.some((x) => x.tag_id === t.id))
                    .map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              )}
              {!readOnly && onRefreshTags && (
                <button
                  className="btn btn-sm"
                  title="Works out the website, size, score, quiet and claim tags from the record as it stands now. A tag you took off by hand is never put back."
                  onClick={onRefreshTags}
                >
                  Update the automatic tags
                </button>
              )}
            </div>
          )}

          {/* ---- THE ROW LOCK, said out loud where somebody would look for a
              button ----
              Before this the drawer had no idea whose lead it was on, because a
              rep could only ever open their own or an unclaimed one. The Floor
              shows every lead in the company, so this is now the ordinary case
              rather than the odd one. Aug 27 2026 */}
          {readOnly && (
            <div className="adm-sl-warn adm-sl-warn-flat" role="status">
              <strong>Read-only — {heldByName} holds this one.</strong> You can see everything on
              this record: the fields, the notes, the whole timeline and the scan. That is on purpose,
              so two of us never land in the same inbox on the same day. Nothing here can change it —
              only {heldByName} or an owner can.
            </div>
          )}

          <FirmWarning warning={warning} />

          {/* The 90+ banner is about who to SPEND A TOUCH ON, so it only shows
              before a conversation exists. Telling a rep at proposal stage that
              a live deal is "not a prospect" — because somebody scored the
              website after the conversation started — is advice nobody can act
              on, and it teaches people to scroll past the banner. */}
          {/* "BEFORE A CONVERSATION EXISTS" IS `first_contact_at`, not a stage
              list. salesQueue stopped using the stage list on 30 Aug — the four
              early stages became unsettable, so a lead worked for a month still
              reads `new` — and this banner kept the old test for a few hours,
              which is how one screen came to disagree with the queue about the
              same lead. */}
          {gate.skip && !lead.first_contact_at && (
            <div className="adm-sl-warn adm-sl-warn-flat" role="status">
              <strong>Not a prospect.</strong> {gate.why} The rules say mark it Skip and move on rather than
              spend a touch here.
            </div>
          )}
          {gate.skip && lead.first_contact_at && (
            <div className="adm-sl-warn adm-sl-warn-flat" role="status">
              <strong>This firm scores {gate.score}.</strong> Normally that is a pass — but you are already
              in conversation, so keep going. Just do not lead with the gap.
            </div>
          )}

          <div className="adm-sl-tabs">
            {TABS.map(([id, label]) => (
              <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
                {label}
                {id === "proposals" && proposals.length ? <span className="adm-sl-tabn">{proposals.length}</span> : null}
              </button>
            ))}
          </div>
        </div>

        {/* ---- body ---- */}
        <div className="adm-drawer-body">
          {tab === "work" && (
            <WorkTab
              lead={lead} member={member} team={team}
              claim={claim} cadence={cadence} text={text} gate={gate}
              busy={busy} onClaim={doClaim} onRelease={doRelease}
              siblings={siblings} onLog={setLogOpen} onPatch={patch}
              onFlip={flipToClient} onWin={doWin} teamName={teamName}
              /* THE GATED PATH, threaded down rather than reached for. Two
                 buttons in here set Meeting and Follow up — the exact two
                 stages that need a date — and they were writing them straight
                 through this file's local `patch`. */
              onStage={onStage}
              onCloseDeal={doClose} readOnly={readOnly}
            />
          )}

          {tab === "timeline" && <TimelineTab activity={activity} proposals={proposals} after={after} lead={lead} teamName={teamName} />}

          {tab === "details" && (
            <DetailsTab lead={lead} company={company} onPatch={patch} reload={reload} readOnly={readOnly} />
          )}

          {tab === "proposals" && (
            <ProposalsTab
              proposals={proposals} lead={lead} member={member}
              onAdd={() => setProposalOpen(true)} reload={load} onWin={doWin}
              onCloseDeal={doClose} readOnly={readOnly}
            />
          )}

          {tab === "playbook" && <PlaybookTab lead={lead} company={company} cadence={cadence} />}
        </div>
      </div>

      {logOpen && (
        <LogModal
          kind={logOpen} lead={lead} member={member} text={text}
          onClose={() => setLogOpen(null)}
          reload={async () => { await load(); await reload(); }}
        />
      )}
      {proposalOpen && (
        <ProposalModal
          lead={lead} company={company} member={member}
          onClose={() => setProposalOpen(false)}
          reload={async () => { await load(); await reload(); }}
        />
      )}
    </>,
    document.body
  );
}

/* ================================================================== */
/* WORK — what is owed right now                                       */
/* ================================================================== */

function WorkTab({
  lead, member, team, claim, cadence, text, gate, busy,
  onClaim, onRelease, siblings, onLog, onPatch, onStage, onFlip, onWin, teamName,
  /* Both closes ask for a reason first — see doClose in the parent. Passed down
   * rather than reached for, so this component still has no idea how a deal is
   * recorded, which is what stops it growing a fourth way of doing it. */
  onCloseDeal, readOnly = false,
}) {
  const unclaimedSiblings = siblings.filter((s) => !s.owner_id && s.id !== lead.id);
  const mine = lead.owner_id === member.user_id;

  /* ---- SOMEBODY ELSE'S LEAD: EVERY FACT, NO BUTTONS ----
   *
   * An early return rather than `disabled` on twenty controls. Two reasons, and
   * the second is the one that matters: a screen of dead controls reads as a
   * broken screen, and the next control somebody adds to this tab would arrive
   * live on a locked record because nobody remembered to disable it. There is
   * nothing to forget here.
   *
   * Everything a rep needs in order not to double up on the firm is on screen:
   * where the claim stands, how many touches have been logged, what the person
   * holding it says they are doing next. The notes and the whole timeline are on
   * the next tab, and they are not hidden either. */
  if (readOnly) {
    return (
      <>
        <div className="adm-sl-next">
          <div className="adm-sl-next-k">WHERE THIS STANDS</div>
          <div className="adm-sl-next-t">{claim.state === "closed" ? "Nobody is chasing this any more" : "Somebody else is working this"}</div>
          <div className="adm-sl-next-b">{claim.why}</div>
        </div>

        <div className="adm-sl-two">
          <div className="adm-sl-fieldwrap">
            <div className="label">Stage</div>
            <div style={{ fontSize: 14 }}>{LEAD_STAGE_LABELS[lead.stage] || lead.stage}</div>
            <div className="adm-sl-help">{LEAD_STAGE_HELP[lead.stage]}</div>
          </div>
          <div className="adm-sl-fieldwrap">
            <div className="label">Whose is it</div>
            <div style={{ fontSize: 14 }}>{teamName(lead.owner_id) || "nobody"}</div>
            <div className="adm-sl-help">
              Only they, or an owner, can change this record. You can read all of it.
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="label" style={{ marginBottom: 6 }}>What they say they do next</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            {lead.next_step || <span className="adm-sl-faint">Nothing written down.</span>}
          </div>
        </div>

        <div className="adm-sl-actions" style={{ marginTop: 18 }}>
          <div className="label" style={{ marginBottom: 8 }}>Touches logged</div>
          <div style={{ fontSize: 13.5 }}>
            {cadence.done} of {CADENCE.length} on the cadence.
            {" "}Counted from real calls and emails on the timeline — nothing here is a number
            somebody typed.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* WHAT TO DO NEXT — one box, one instruction. */}
      <div className="adm-sl-next">
        <div className="adm-sl-next-k">WHAT TO DO NEXT</div>
        {!lead.owner_id ? (
          <>
            <div className="adm-sl-next-t">Claim it before you reach out</div>
            <div className="adm-sl-next-b">
              The rules say the claim comes first, so nobody else starts the same conversation.
              {gate.known ? ` ${gate.why}` : " Run the site score first — you need the gap to talk about."}
            </div>
            <div className="adm-sl-next-a">
              <button className="btn btn-accent" disabled={busy} onClick={() => onClaim(false)}>
                Claim this contact
              </button>
              {unclaimedSiblings.length > 0 && (
                <button className="btn" disabled={busy} onClick={() => onClaim(true)}>
                  Claim the whole firm ({unclaimedSiblings.length + 1} people)
                </button>
              )}
            </div>
          </>
        ) : claim.state === "claim_expired" ? (
          <>
            <div className="adm-sl-next-t">Your claim has run out</div>
            <div className="adm-sl-next-b">{claim.why} Log a first contact now and it is yours again, or hand it back.</div>
            <div className="adm-sl-next-a">
              <button className="btn btn-accent" onClick={() => onLog("email")}>Log the first email</button>
              <button className="btn" disabled={busy} onClick={onRelease}>Hand it back</button>
            </div>
          </>
        ) : cadence.stop === "replied" ? (
          /* ABOVE the expired-claim branch below — see the ordering note there. */
          /* ---- THEY WROTE BACK. THE SEQUENCE IS OVER. ----
             This branch sits ABOVE the finished/step ones because a reply beats
             the schedule rather than being ranked against it. The buttons are
             the two things you actually do next; there is deliberately no "log
             the email" here, because the pre-written email is the exact thing
             that must not go out now. 30 Aug 2026 */
          <>
            <div className="adm-sl-next-t">They replied — answer them</div>
            <div className="adm-sl-next-b">{CADENCE_STOPS.replied}</div>
            <div className="adm-sl-next-a">
              <button className="btn btn-accent" onClick={() => onLog("email")}>Log your reply</button>
              {/* NOT a direct stage write. Meeting needs a date in the diary
                  (STAGE_REQUIRES), and this button was the fastest way in the
                  console to produce a Meeting with nothing booked — on the very
                  panel that exists because somebody replied. It routes through
                  the page's gate now, which refuses and says what is missing. */}
              <button className="btn" onClick={() => onStage("meeting", "They replied and we are booking a meeting.")}>
                Book a meeting
              </button>
            </div>
          </>
        ) : cadence.stop === "bounced" ? (
          <>
            <div className="adm-sl-next-t">That address is dead</div>
            <div className="adm-sl-next-b">{CADENCE_STOPS.bounced}</div>
            <div className="adm-sl-next-a">
              <button className="btn btn-accent" onClick={() => onLog("call")}>Log a call instead</button>
              <button className="btn" onClick={() => onCloseDeal("lost")}>Mark it Not a fit</button>
            </div>
          </>
        ) : cadence.finished ? (
          <>
            <div className="adm-sl-next-t">All five touches are done</div>
            <div className="adm-sl-next-b">
              The breakup email has gone. The rules say set the status and move on rather than keep poking.
            </div>
            <div className="adm-sl-next-a">
              {/* THE HARD-CODED REASON IS GONE. This was the only button in the
                  console that ever wrote `lost_reason`, and it wrote the same
                  sentence every time — so the loss breakdown would have been one
                  bar tall for ever. It opens the reason box like every other
                  close now, with "No reply at all" one click away in the
                  dropdown. Aug 27 2026 */}
              <button className="btn" onClick={() => onCloseDeal("lost")}>
                Mark it lost
              </button>
              <button className="btn" onClick={() => onStage("follow_up", "Kept for a later follow-up.")}>
                Keep for later
              </button>
            </div>
          </>
        ) : cadence.step ? (
          <>
            <div className="adm-sl-next-t">
              {cadence.step.label} — day {cadence.step.day}
              {cadence.over > 0 ? ` · ${cadence.over} day${cadence.over === 1 ? "" : "s"} late` : cadence.over === 0 ? " · due today" : ` · ${Math.abs(cadence.over)} days from now`}
            </div>
            <div className="adm-sl-next-b">{cadence.step.hint}</div>
            <div className="adm-sl-next-a">
              <button className="btn btn-accent" onClick={() => onLog(cadence.step.kind)}>
                Log {cadence.step.kind === "call" ? "a call" : "the email"}
              </button>
              <button className="btn" onClick={() => onLog("note")}>Add a note</button>
            </div>
          </>
        ) : (
          <>
            <div className="adm-sl-next-t">Nothing is owed right now</div>
            <div className="adm-sl-next-b">{claim.why}</div>
            <div className="adm-sl-next-a">
              <button className="btn" onClick={() => onLog("note")}>Add a note</button>
            </div>
          </>
        )}
      </div>

      {/* THE FIVE TOUCHES, as a row of dots you can read in one glance. */}
      {lead.owner_id && (
        <div className="adm-sl-cadence">
          <div className="label">The 5-touch cadence</div>
          <div className="adm-sl-dots">
            {CADENCE.map((c) => {
              const done = cadence.done >= c.n;
              const current = cadence.step?.n === c.n;
              return (
                <div key={c.n} className={`adm-sl-dot${done ? " done" : ""}${current ? " current" : ""}`} title={`${c.label} — day ${c.day}. ${c.hint}`}>
                  <span className="adm-sl-dot-n">{done ? "✓" : c.n}</span>
                  <span className="adm-sl-dot-l">{c.label}</span>
                  <span className="adm-sl-dot-d">Day {c.day}</span>
                </div>
              );
            })}
          </div>
          <div className="adm-sl-cadence-note">
            {cadence.done} of {CADENCE.length} logged. Counted from real calls and emails on the timeline —
            nothing here is a number somebody types in.
          </div>
        </div>
      )}

      {/* LOG SOMETHING */}
      <div className="adm-sl-actions">
        <div className="label" style={{ marginBottom: 8 }}>Log what you did</div>
        <div className="adm-sl-actrow">
          <button className="btn" onClick={() => onLog("call")} disabled={!lead.phone} title={lead.phone ? undefined : "No phone number on this contact"}>Call</button>
          <button className="btn" onClick={() => onLog("email")} disabled={!lead.email} title={lead.email ? undefined : "No email on this contact"}>Email</button>
          <button className="btn" onClick={() => onLog("linkedin")} disabled={!lead.linkedin_url} title={lead.linkedin_url ? undefined : "No LinkedIn on this contact"}>LinkedIn</button>
          <button className="btn" onClick={() => onLog("text")} disabled={!text.allowed} title={text.reason}>Text</button>
          <button className="btn" onClick={() => onLog("note")}>Note</button>
        </div>
        {/* The refusal is always written out. A greyed button with no reason
            reads as a broken button, and then people stop trusting the page. */}
        {!text.allowed && <div className="adm-sl-gate">Texting: {text.reason}</div>}
      </div>

      {/* STAGE + OWNER */}
      <div className="adm-sl-two">
        <label className="adm-sl-fieldwrap">
          <div className="label">Stage</div>
          <select className="adm-input" value={lead.stage} onChange={(e) => {
            /* Won goes through the one Won path, so choosing it from this
               dropdown creates the client exactly like the green button does.
               Before this it silently did not, and then blocked the button.
               Lost joined it on Aug 27 2026: both of them now open the reason box
               first, because a close with no reason next to it is the thing this
               whole feature exists to stop. */
            if (e.target.value === "won") { if (!busy) onWin(); return; }
            if (e.target.value === "lost") { if (!busy) onCloseDeal("lost"); return; }
            /* THROUGH THE PAGE'S GATE. This called `onPatch` — the drawer's own
               upsert — so Follow up, Meeting and Proposal were gated on the
               sheet and free here. `closed_at` still rides along, because this
               is the only stage path in the console that sets it. */
            onStage(
              e.target.value,
              `${LEAD_STAGE_LABELS[lead.stage] || lead.stage} → ${LEAD_STAGE_LABELS[e.target.value] || e.target.value}`,
              ["lost", "skip_90", "bad_contact", "not_a_fit"].includes(e.target.value)
                ? { closed_at: new Date().toISOString() }
                : { closed_at: null },
            );
          }}>
            {/* THE SAME SEVEN THE SHEET OFFERS — 30 Aug 2026.
                This mapped every value in LEAD_STAGES, so the drawer was a way
                to set the four derived stages the sheet had just stopped
                offering, and to reach Proposal with no proposal on the record.
                A checker found it within an hour of the sheet being changed:
                restricting one control is not restricting the act.
                The lead's CURRENT stage is added even when it is not pickable,
                or a lead sitting on `contacted` would render with the first
                option selected and one stray click would move it. */}
            {[...new Set([...PICKABLE_STAGES, lead.stage].filter(Boolean))].map((s) => (
              <option key={s} value={s} disabled={!PICKABLE_STAGES.includes(s)}>
                {LEAD_STAGE_LABELS[s] || s}
                {PICKABLE_STAGES.includes(s) ? "" : " — the system sets this one"}
              </option>
            ))}
          </select>
          <div className="adm-sl-help">{LEAD_STAGE_HELP[lead.stage]}</div>
        </label>
        <label className="adm-sl-fieldwrap">
          <div className="label">Whose is it</div>
          <select className="adm-input" value={lead.owner_id || ""} onChange={(e) => {
            const v = e.target.value || null;
            const stamp = new Date().toISOString();
            /* A NEW owner gets a NEW clock. Keeping the previous rep's
             * `claimed_at` handed the next person a claim that was already
             * three weeks old, so their card read "run out" the moment they
             * got it and the sweep took it back that night. Unassigning clears
             * the cadence too, so the next claimer does not inherit a sequence
             * that started weeks ago. */
            onPatch(
              v
                ? (v === lead.owner_id
                  ? { owner_id: v }
                  : { owner_id: v, claimed_at: stamp, cadence_started_at: stamp, claim_contacted_at: null })
                : { owner_id: null, claimed_at: null, cadence_started_at: null, claim_contacted_at: null },
              v ? `Assigned to ${teamName(v)}` : "Handed back to the floor"
            );
          }}>
            <option value="">Nobody — on the floor</option>
            {team.filter((t) => t.active).map((t) => <option key={t.user_id} value={t.user_id}>{t.full_name || t.email}</option>)}
          </select>
          <div className="adm-sl-help">
            {lead.imported_owner_name
              ? `The sheet said "${lead.imported_owner_name}".`
              : "Anybody on the team can take or move this — there are no locks between reps."}
          </div>
        </label>
      </div>

      {/* NEXT STEP — free text, because half of selling is a sentence you
          wrote to yourself last Tuesday. */}
      <div style={{ marginTop: 18 }}>
        <div className="label" style={{ marginBottom: 6 }}>Next step</div>
        <NextStep lead={lead} onPatch={onPatch} readOnly={readOnly} />
      </div>

      {/* disabled while busy, like every other action in this panel. Without it
          a double-click ran the whole Won path twice: the database is safe (the
          row lock serialises it and the second call reports already_customer)
          but the stage patch and its timeline line are written BEFORE that
          lock, so the record picked up two "→ Won" entries. */}
      {mine && ["proposal", "meeting"].includes(lead.stage) && (
        <button className="btn btn-accent" style={{ marginTop: 18 }} disabled={busy} onClick={onFlip}>
          They signed — mark as won
        </button>
      )}
    </>
  );
}

function NextStep({ lead, onPatch }) {
  const [v, setV] = useState(lead.next_step || "");
  const [dirty, setDirty] = useState(false);
  // Never clobber an unsaved edit — see LeadField.
  useEffect(() => {
    setV((cur) => (dirty ? cur : lead.next_step || ""));
  }, [lead.id, lead.next_step]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDirty(false); }, [lead.id]);
  return (
    <>
      <TextArea
        value={v}
        onChange={(e) => { setV(e.target.value); setDirty(true); }}
        placeholder="What you will do next, in your own words…"
        style={{ minHeight: 64 }}
      />
      {dirty && (
        <button className="btn" style={{ marginTop: 6 }} onClick={async () => {
          if (await onPatch({ next_step: v.trim() || null })) { setDirty(false); toast.success("Saved"); }
        }}>Save the next step</button>
      )}
    </>
  );
}

/* ================================================================== */
/* TIMELINE                                                            */
/* ================================================================== */

/* The words for each kind of event moved into lib/person-timeline.js
 * (EVENT_KINDS), so the timeline and anything else that reads it cannot end up
 * with two different words for a phone call. */

/* THE WHOLE LIFE OF ONE PERSON, IN ONE LIST.
 *
 * Was: the sales activity rows and nothing else, so the record stopped at the
 * sale. Everything after it — the work we did, the weekly logs, the reports,
 * the invoices, the support tickets — lived on the Clients page behind a link
 * nothing wrote. Two histories of the same relationship, neither of them whole.
 *
 * Ryder, Aug 25 2026: *"context saved to all people in our system from the time
 * there created as a lead all the way to a paying client and beyond."*
 *
 * Every line says which table it was read out of, and the footer says what was
 * NOT read. See lib/person-timeline.js for the five rules this obeys.
 */
function TimelineTab({ activity, proposals, after, lead, teamName }) {
  if (activity === null) return <div className="adm-sl-loading">Reading the timeline…</div>;

  const t = buildPersonTimeline(
    { lead, activity, proposals, ...after },
    { teamName },
  );

  /* THE SUMMARY IS PRINTED EVEN WHEN THE LIST IS EMPTY.
   *
   * The first version returned early here and never rendered it — so the
   * sources that could not be read, and the entries whose dates were
   * unreadable, were dropped at exactly the moment the screen was at its most
   * confident. An empty list is the one place "nothing happened" and "we could
   * not look" are hardest to tell apart. */
  if (!t.events.length) {
    return (
      <div className="adm-sl-empty">
        <strong>Nothing on the record yet.</strong>
        <div>The first call or email you log starts the timeline. Nothing here is ever
          overwritten — that is the whole difference from the spreadsheet.</div>
        <div className="adm-sl-tl-summary" style={{ marginTop: 12 }}>{timelineSummary(t)}</div>
      </div>
    );
  }

  /* Where the star goes: the newest chase-era entry is the first one below the
   * line, because the list runs newest first. Worked out once rather than by
   * mutating a flag inside the map — a variable reassigned during render is
   * not reliable across re-renders, and React's own lint rule says so. */
  const divideAt = t.becameClientAt ? t.events.findIndex((e) => e.era === "chase") : -1;

  return (
    <>
      <div className="adm-sl-tl-summary">{timelineSummary(t)}</div>
      <div className="adm-timeline">
        {t.events.map((e, i) => {
          const mark = i === divideAt;
          return (
            <div key={e.id}>
              {mark ? (
                <div className="adm-sl-tl-divide">
                  <span>★ became a paying client</span>
                </div>
              ) : null}
              <div className={`adm-timeline-item adm-sl-tl-${e.era}`}>
                <div className="adm-sl-tl-top">
                  <span className="adm-sl-tl-icon" aria-hidden="true">{e.icon}</span>
                  <span className="adm-sl-tl-type">{e.head}</span>
                  {e.title && <span className="adm-sl-tl-out">{e.title}</span>}
                  {e.amountCents !== null && <span className="adm-sl-tl-amt">{money(e.amountCents)}</span>}
                  <span className="adm-sl-tl-when">{timeAgo(e.at).toUpperCase()}</span>
                </div>
                {e.detail && <div className="adm-sl-tl-body">{e.detail}</div>}
                <div className="adm-sl-tl-who">
                  {e.by === "theirs" ? "them"
                    : e.by === "system" ? "the system"
                      : e.who || "someone"}
                  <span className="adm-sl-tl-src"> · from {e.sourceLabel}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {t.truncated && <div className="adm-sl-tl-cap">{t.truncated}</div>}
    </>
  );
}

function DetailsTab({ lead, company, onPatch, reload, readOnly = false }) {
  const [c, setC] = useState(company || null);
  const [cDirty, setCDirty] = useState(false);
  /* Keyed on the firm's ID, not the object.
   *
   * `company` is a fresh object out of a Map rebuilt on every load, so
   * depending on the object meant ANY background refresh — logging a call in
   * another tab of this same drawer, the adm-refresh event — replaced the form
   * mid-keystroke and made the Save button vanish. Depending on the id means
   * the form only resets when it is genuinely a different firm.
   *
   * The trade-off, stated: if somebody else edits this firm while you are
   * typing, you will not see their change until you save or reopen. Losing
   * somebody's typing with no message is worse. */
  useEffect(() => { setC(company || null); setCDirty(false); }, [company?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const saveCompany = async () => {
    const res = await upsertCompany({
      id: c.id, name: c.name, domain: c.domain || null, phone: c.phone || null,
      city: c.city || null, state: c.state || null, vertical: c.vertical || null,
      employees: c.employees === "" ? null : Number(c.employees) || null,
      annual_revenue: c.annual_revenue === "" ? null : Number(c.annual_revenue) || null,
      notes: c.notes || null,
    });
    if (!res.ok) { toast.error("Could not save the firm", res.error); return; }
    setCDirty(false);
    toast.success("Firm saved", "Everybody at this firm sees the change.");
    await reload();
  };

  return (
    <>
      <div className="label" style={{ marginBottom: 8 }}>The person</div>
      <div className="adm-sl-grid2">
        <LeadField lead={lead} k="name" label="Name" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="title" label="Job title" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="email" label="Email" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="phone" label="Phone" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="seniority" label="Seniority" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="department" label="Department" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="linkedin_url" label="LinkedIn" onPatch={onPatch} readOnly={readOnly} />
        <LeadField lead={lead} k="city" label="City" onPatch={onPatch} readOnly={readOnly} />
      </div>

      <div className="label" style={{ margin: "22px 0 8px" }}>
        The firm{c ? "" : " — none linked"}
      </div>
      {!c ? (
        <div className="adm-sl-empty">
          <strong>This contact has no firm attached.</strong>
          <div>Company facts — the website, the score, the revenue — live on the firm so they are
            not copied onto every person and left to go stale. Imported rows get one automatically.</div>
        </div>
      ) : (
        <>
          <div className="adm-sl-grid2">
            {[["name", "Company"], ["domain", "Website"], ["phone", "Phone"], ["vertical", "Industry"],
              ["city", "City"], ["state", "State"], ["employees", "Employees"], ["annual_revenue", "Annual revenue"]].map(([k, label]) => (
              /* The FIRM is shown read-only on a locked record too, and that is
                 a slightly different judgement from the person's fields: a firm
                 belongs to everybody, so an argument could be made for letting
                 anybody correct its website. It is locked anyway, because the
                 database locks it (0020 scopes the lead, and the firm's own
                 policy is member-wide) and a form that saves where the row it
                 was opened from does not is a screen disagreeing with itself.
                 An owner or an admin can edit any firm from any record. */
              <Field key={k} label={label}>
                {readOnly ? (
                  <div style={{ fontSize: 14, padding: "8px 0", minHeight: 20 }}>
                    {c[k] || <span className="adm-sl-faint">Empty</span>}
                  </div>
                ) : (
                  <TextInput value={c[k] ?? ""} onChange={(e) => { setC({ ...c, [k]: e.target.value }); setCDirty(true); }} />
                )}
              </Field>
            ))}
          </div>
          <Field label="Notes about the firm">
            {readOnly ? (
              <div style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {c.notes || <span className="adm-sl-faint">Empty</span>}
              </div>
            ) : (
              <TextArea value={c.notes ?? ""} onChange={(e) => { setC({ ...c, notes: e.target.value }); setCDirty(true); }} />
            )}
          </Field>
          {c.site_score !== null && c.site_score !== undefined && (
            <div className="adm-sl-scored">
              Site score <strong>{c.site_score}</strong>, measured{" "}
              {c.site_score_at ? timeAgo(c.site_score_at) : "at an unknown time"}.
              {c.site_score_note ? ` ${c.site_score_note}` : ""}
            </div>
          )}
          {cDirty && !readOnly && <button className="btn btn-accent" onClick={saveCompany}>Save the firm</button>}
        </>
      )}

      {lead.imported_owner_name && (
        <div className="adm-sl-imported">
          Imported from a spreadsheet. The Sales Owner column said{" "}
          <strong>&ldquo;{lead.imported_owner_name}&rdquo;</strong>. That text is kept exactly as it was
          typed so a wrong match can be found later.
        </div>
      )}
    </>
  );
}

function LeadField({ lead, k, label, onPatch, readOnly = false }) {
  const [v, setV] = useState(lead[k] ?? "");
  const [dirty, setDirty] = useState(false);
  /* Same reason as DetailsTab: `lead` is a new object on every refresh, so
   * depending on it wiped whatever was half-typed. Depend on the id and the
   * saved value, and never overwrite an unsaved edit. */
  useEffect(() => {
    setV((cur) => (dirty ? cur : lead[k] ?? ""));
  }, [lead.id, lead[k], k]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDirty(false); }, [lead.id, k]);
  /* A LOCKED RECORD SHOWS THE VALUE, NOT A BOX. An input somebody can type into
   * and cannot save is worse than plain text: they type, they tab away, and
   * nothing happens with no explanation. Aug 27 2026 */
  if (readOnly) {
    return (
      <Field label={label}>
        <div style={{ fontSize: 14, padding: "8px 0", minHeight: 20 }}>
          {lead[k] || <span className="adm-sl-faint">Empty</span>}
        </div>
      </Field>
    );
  }
  return (
    <Field label={label}>
      <TextInput
        value={v}
        onChange={(e) => { setV(e.target.value); setDirty(true); }}
        onBlur={async () => {
          if (!dirty) return;
          if (await onPatch({ [k]: v.trim() || null })) setDirty(false);
        }}
      />
    </Field>
  );
}

/* ================================================================== */
/* PROPOSALS                                                           */
/* ================================================================== */

const PROPOSAL_STATUS = [
  ["draft", "Draft"], ["sent", "Sent"], ["viewed", "They opened it"],
  ["won", "Won"], ["lost", "Lost"], ["withdrawn", "Withdrawn"],
];

function ProposalsTab({ proposals, lead, member, onAdd, reload, onWin, onCloseDeal, readOnly = false }) {
  return (
    <>
      <div className="adm-sl-rowbetween">
        <div className="label">Proposals</div>
        {!readOnly && <button className="btn btn-accent" onClick={onAdd}>+ New proposal</button>}
      </div>

      {!proposals.length ? (
        <div className="adm-sl-empty">
          <strong>No proposal yet.</strong>
          <div>The spreadsheet stops at &ldquo;meeting held&rdquo;, so there is no record of what was offered
            or why it was lost — which is the half that would tell us what to do differently.</div>
        </div>
      ) : proposals.map((p) => (
        <div key={p.id} className="adm-sl-prop">
          <div className="adm-sl-prop-top">
            <div>
              <div className="adm-sl-prop-t">{p.title}</div>
              <div className="adm-sl-prop-s">
                {[p.package, p.term, p.sent_at ? `sent ${timeAgo(p.sent_at)}` : "not sent yet",
                  p.viewed_at ? `opened ${timeAgo(p.viewed_at)}` : null].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="adm-sl-prop-amt">{money(p.amount_cents)}</div>
          </div>
          <div className="adm-sl-prop-foot">
            <select className="adm-input" style={{ width: 170 }} value={p.status} disabled={readOnly} onChange={async (e) => {
              const status = e.target.value;
              const now = new Date().toISOString();
              const res = await upsertProposal({
                id: p.id, status,
                ...(status === "sent" && !p.sent_at ? { sent_at: now } : {}),
                ...(status === "viewed" && !p.viewed_at ? { viewed_at: now } : {}),
                ...(["won", "lost", "withdrawn"].includes(status) ? { decided_at: now } : {}),
              });
              if (!res.ok) { toast.error("Could not save", res.error); return; }
              await addLeadActivity({ leadId: lead.id, actor: member.user_id, type: "proposal", body: `Proposal "${p.title}" → ${status}.` });
              /* Same one path. This used to write stage/became_customer by hand
                 and make no client — and then block the button that would. */
              /* Same one path for both. Setting a proposal to Won or Lost is a
                 close, so it asks for the reason exactly like the other three
                 buttons do — and the proposal's own status is already saved above
                 whatever the person then does with the box, which is right: the
                 proposal really was sent and really was decided. */
              if (status === "won") { onWin(); }
              if (status === "lost") { onCloseDeal("lost"); }
              await reload();
            }}>
              {PROPOSAL_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {p.doc_url && <a className="adm-sl-link" href={p.doc_url} target="_blank" rel="noopener noreferrer">Open the document</a>}
            {!readOnly && <button className="btn btn-sm" onClick={async () => {
              const res = await deleteProposal(p.id);
              if (!res.ok) { toast.error("Could not delete", res.error); return; }
              toast.info("Proposal deleted");
              await reload();
            }}>Delete</button>}
          </div>
          {p.lost_reason && <div className="adm-sl-prop-lost">Lost because: {p.lost_reason}</div>}
        </div>
      ))}
    </>
  );
}

/* ================================================================== */
/* PLAYBOOK                                                            */
/* ================================================================== */

/* The Rules of Engagement tab, on the screen where the work happens. It lived
 * in a spreadsheet tab nobody opened twice. */

function PlaybookTab({ lead, company, cadence }) {
  const g = scoreGate(company?.site_score);
  return (
    <>
      <div className="label" style={{ marginBottom: 8 }}>The 7 moves — every strong cold touch hits these, in order</div>
      {SEVEN_MOVES.map((m) => (
        <div key={m.n} className="adm-sl-move">
          <span className="adm-sl-move-n">{m.n}</span>
          <div>
            <div className="adm-sl-move-t">{m.name}</div>
            <div className="adm-sl-move-b">{m.body}</div>
            {m.n === 3 && (
              <div className="adm-sl-move-x">
                For this one: ask ChatGPT &ldquo;best {company?.vertical || lead.vertical || "business"} in{" "}
                {company?.city || lead.city || "their city"}&rdquo; and screenshot who comes up instead of them.
              </div>
            )}
            {m.n === 6 && g.known && (
              <div className="adm-sl-move-x">
                For this one: their site scores <strong>{g.score}</strong>. {g.why} Name the gap — never the fixes.
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="label" style={{ margin: "22px 0 8px" }}>The cadence — 5 touches over about 2 weeks</div>
      {CADENCE.map((c) => (
        <div key={c.n} className={`adm-sl-cad${cadence.done >= c.n ? " done" : ""}`}>
          <span className="adm-sl-cad-d">Day {c.day}</span>
          <span className="adm-sl-cad-l">{c.label}</span>
          <span className="adm-sl-cad-h">{c.hint}</span>
        </div>
      ))}

      <div className="adm-sl-rules">
        <div><strong>Keep it high level.</strong> Reference the score and the gap — never hand over the specific
          fixes. The audit is what they pay for.</div>
        <div><strong>Scarcity is real.</strong> One client per market. Say so.</div>
        <div><strong>Texting.</strong> Only after they have opened an email, and only one. Cold-blasting texts
          gets our numbers flagged and burns the whole list.</div>
        <div><strong>{ROE.SKIP_SCORE_AT_OR_ABOVE} or above is not a prospect.</strong> Mark it Skip and spend the
          touch somewhere it can land.</div>
      </div>
    </>
  );
}

/* ================================================================== */
/* MODALS                                                              */
/* ================================================================== */

/* EXPORTED, so the Floor's row can log a touch without opening the record.
 * A second copy of this modal would be a second copy of the one-text rule, and
 * that rule is the reason claimTextSend lives in the database rather than in a
 * browser. Aug 27 2026 */
export function LogModal({ kind, lead, member, text, onClose, reload }) {
  const [outcome, setOutcome] = useState(kind === "call" ? "talked" : "talked");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (kind === "note" && !body.trim()) { toast.warn("Write the note first"); return; }
    /* No client-side re-check here on purpose. Re-running textGate against the
     * same object the drawer already used is not a check — it evaluates
     * identical inputs and can never disagree. The real check is the database
     * claim below, which is the only one a second tab cannot beat. */
    setBusy(true);
    /* THE COUNTER IS BUMPED BEFORE THE TIMELINE ROW, not after.
     *
     * The other way round, a failed counter write left the text on the record
     * with `texts_sent` still 0 — so the gate opened again, and again. Failing
     * on the counter now means nothing is logged at all, which is recoverable;
     * failing the other way meant unlimited texts, which is the one thing this
     * gate exists to prevent. */
    /* THE TEXT IS CLAIMED FROM THE DATABASE BEFORE ANYTHING IS LOGGED.
     *
     * `texts_sent = texts_sent + 1` in the browser is a read-modify-write: two
     * open tabs both read 0 and both write 1, so two texts go out under a
     * counter that says one. claimTextSend is one statement that only
     * increments if the lead is still under the limit, so exactly one caller
     * wins. And it happens FIRST — a failure here means nothing is logged,
     * which is recoverable, where the other order meant the text was on the
     * record with the gate still open. */
    if (kind === "text") {
      const claimed = await claimTextSend(lead.id);
      if (!claimed.ok) {
        setBusy(false);
        toast.error("That text was not logged", claimed.error);
        return;
      }
    }
    const res = await addLeadActivity({
      leadId: lead.id, actor: member.user_id, type: kind,
      outcome: kind === "note" ? null : outcome, body: body.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not log that", res.error); return; }
    await logActivity({
      actor: member.user_id, kind: `lead_${kind}`,
      title: `${kind === "note" ? "Note on" : `${kind[0].toUpperCase()}${kind.slice(1)} to`} ${lead.name || lead.company || "a lead"}`,
      body: body.trim() || outcome,
    });
    toast.success("Logged", "It is on the timeline and the timers have reset.");
    onClose();
    await reload();
  };

  const LABEL = { call: "a call", email: "an email", text: "a text", linkedin: "a LinkedIn touch", note: "a note" };

  return (
    <Modal open onClose={onClose} kicker="SALES" title={`Log ${LABEL[kind]}`} width={520}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Log it"}</button>
      </>}>
      {kind === "text" && (
        <div className="adm-sl-warn adm-sl-warn-flat">
          <strong>This is your one text.</strong> {text.reason} After this the button locks for good.
        </div>
      )}
      {kind !== "note" && (
        <Field label="How did it go" hint="This is what the rep stats count, so it is worth being honest about.">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} options={OUTCOMES} />
        </Field>
      )}
      <Field label={kind === "note" ? "The note" : "Anything worth remembering (optional)"}>
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function ProposalModal({ lead, company, member, onClose, reload }) {
  const [f, setF] = useState({ title: "", package: "", amount: "", term: "monthly", doc_url: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.title.trim()) { toast.warn("Give the proposal a name"); return; }
    /* `"abc".replace(/[^0-9.]/g,"")` is "", and `Number("")` is 0 — finite, so
     * the obvious guard passed and "TBD" saved as $0.00. Check the digits are
     * actually there. */
    // A leading minus was silently stripped, so "-500" saved as $500.
    if (/^\s*-/.test(f.amount || "")) { toast.warn("An amount cannot be negative"); return; }
    const digits = String(f.amount ?? "").replace(/[^0-9.]/g, "");
    const cents = digits ? Math.round(Number(digits) * 100) : null;
    if (f.amount.trim() && (!digits || !Number.isFinite(cents))) {
      toast.warn("That amount is not a number", `Write it in dollars, like 4500. "${f.amount.trim()}" would save as $0.`);
      return;
    }
    setBusy(true);
    const res = await upsertProposal({
      lead_id: lead.id, company_id: company?.id || null,
      title: f.title.trim(), package: f.package.trim() || null,
      amount_cents: cents, term: f.term, doc_url: f.doc_url.trim() || null,
      notes: f.notes.trim() || null, status: "draft", created_by: member.user_id,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not save", res.error); return; }
    await addLeadActivity({ leadId: lead.id, actor: member.user_id, type: "proposal", body: `Proposal drafted: ${f.title.trim()}.` });
    toast.success("Proposal saved", "Set it to Sent once it goes out.");
    onClose();
    await reload();
  };

  return (
    <Modal open onClose={onClose} kicker="SALES" title="New proposal" width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save proposal"}</button>
      </>}>
      <Field label="What is it called"><TextInput value={f.title} onChange={set("title")} placeholder="Radar Pro — 6 month GEO package" autoFocus /></Field>
      <div className="adm-sl-grid2">
        <Field label="Package"><TextInput value={f.package} onChange={set("package")} placeholder="Radar Pro" /></Field>
        <Field label="Amount" hint="Dollars. 4500 means $4,500.">
          <TextInput value={f.amount} onChange={set("amount")} placeholder="4500" inputMode="decimal" />
        </Field>
        <Field label="How often">
          <Select value={f.term} onChange={set("term")} options={[["monthly", "Every month"], ["one-off", "One-off"], ["annual", "Yearly"]]} />
        </Field>
        <Field label="Link to the document"><TextInput value={f.doc_url} onChange={set("doc_url")} placeholder="https://…" /></Field>
      </div>
      <Field label="Notes"><TextArea value={f.notes} onChange={set("notes")} /></Field>
    </Modal>
  );
}
