import RowPanel, { Facts, PanelSection, PanelLink } from "./rowPanel.jsx";
import MeetingsPanel from "./meetingsPanel.jsx";
import { timeAgo } from "./shared.jsx";

/* WHAT EACH KIND OF ROW SHOWS WHEN YOU OPEN IT — 12 Sep 2026.
 *
 * The shell is rowPanel.jsx. This is the contents, one small renderer per kind
 * of subject, all of them going through the same frame so that opening a
 * ticket and opening a client feel like the same act.
 *
 * THREE RULES THEY ALL KEEP.
 *
 * 1. EVERY PANEL HAS A DOOR TO THE FULL RECORD. This is a quick look, not a
 *    replacement for the pages that can change things. A panel that tried to be
 *    the editor as well would be a third lead drawer, which is the thing the
 *    shell exists to avoid.
 *
 * 2. A MISSING VALUE SAYS "not recorded". Facts() does it; nothing here passes
 *    a "—" or an empty string to fake it. An empty cell reads as "nothing to
 *    say" and that is a different fact from "nobody filled this in".
 *
 * 3. NOTHING IS COMPUTED THAT THE ROW DOES NOT ALREADY CARRY. These renderers
 *    take the row the page already has in memory and read it. They do not
 *    fetch, so opening a panel cannot be slow and cannot show a number the page
 *    behind it disagrees with. The one exception is the meetings list on a
 *    person, which reads its own table and says so while it is reading.
 */

export default function SubjectPanel({
  kind, row, ctx = {}, member = null, open = true,
  onClose, onPrev = null, onNext = null,
}) {
  if (!row) return null;
  const R = RENDERERS[kind];
  if (!R) return null;
  const view = R(row, ctx);
  return (
    <RowPanel
      open={open} onClose={onClose} onPrev={onPrev} onNext={onNext}
      kicker={view.kicker} title={view.title} subtitle={view.subtitle} badges={view.badges}
      footer={view.link ? <PanelLink to={view.link.to}>{view.link.label}</PanelLink> : null}
    >
      <PanelSection title="The facts">
        <Facts rows={view.facts} />
      </PanelSection>

      {view.body}

      {/* MEETINGS, wherever there is a person to have met. This is the same
          panel the Sales record uses — one list of meetings, read from one
          table, not a second summary that can disagree with it. */}
      {member && (view.leadId || view.clientId) && (
        <PanelSection title="Meetings" hint="Everything recorded with this person, newest first.">
          <MeetingsPanel leadId={view.leadId || null} clientId={view.clientId || null} member={member} />
        </PanelSection>
      )}
    </RowPanel>
  );
}

/* ------------------------------------------------------------------ */

const when = (v) => (v ? `${new Date(v).toLocaleDateString()} · ${timeAgo(v)}` : null);
const nameOf = (list, id, key = "name") => (id ? (list || []).find((x) => x.id === id)?.[key] || null : null);

const RENDERERS = {
  /* ---- a person in the pipeline ---- */
  lead: (l, ctx) => ({
    kicker: "Sales",
    title: l.name || l.company || "Unnamed lead",
    subtitle: [l.company, l.city && l.state ? `${l.city}, ${l.state}` : l.city || l.state].filter(Boolean).join(" · ") || null,
    badges: [
      { label: ctx.stageLabel?.(l.stage) || l.stage || "no stage" },
      l.reason ? { label: l.reason, tone: l.urgency === 0 ? "bad" : undefined } : null,
      l.became_customer ? { label: "client", tone: "good" } : null,
      l.bounced_at ? { label: "email bounced", tone: "bad" } : null,
    ],
    leadId: l.id,
    clientId: l.client_id || null,
    facts: [
      ["Email", l.email],
      ["Phone", l.phone],
      ["Website", l.domain],
      ["Owned by", ctx.teamName?.(l.owner_id) || null],
      ["Last touched", when(l.last_touch || l.last_touch_at)],
      ["First contact", when(l.first_contact_at)],
      ["They replied", when(l.first_reply_at)],
      ["Follow-up due", when(l.next_follow_up_at)],
      ["Meeting", when(l.meeting_at)],
      ["Added", when(l.created_at)],
    ],
    body: l.follow_up_note || l.notes
      ? <PanelSection title="Notes"><div className="adm-mtg-item-note">{l.follow_up_note || l.notes}</div></PanelSection>
      : null,
    link: { to: "/dashboard/sales", label: "Open the full record on Sales" },
  }),

  /* ---- a paying client ---- */
  client: (c) => ({
    kicker: "Client",
    title: c.name || "Unnamed client",
    subtitle: c.domain || null,
    badges: [
      { label: c.status || "no status", tone: c.status === "active" ? "good" : undefined },
      c.stage ? { label: c.stage } : null,
      c.vertical ? { label: c.vertical } : null,
    ],
    clientId: c.id,
    facts: [
      ["Contact", c.contact_name],
      ["Email", c.contact_email],
      ["Phone", c.contact_phone],
      ["Started", c.start_date],
      ["Added", when(c.created_at)],
    ],
    body: c.notes ? <PanelSection title="Notes"><div className="adm-mtg-item-note">{c.notes}</div></PanelSection> : null,
    link: { to: "/dashboard/operations", label: "Open the client page" },
  }),

  /* ---- a job ---- */
  task: (t, ctx) => ({
    kicker: "Operations",
    title: t.name || "Unnamed task",
    subtitle: nameOf(ctx.clients, t.client_id) || "No client on this one",
    badges: [
      { label: ctx.statusLabel?.(t.status) || t.status || "no status", tone: t.status === "blocked" ? "bad" : t.status === "done" ? "good" : undefined },
      t.priority ? { label: `${t.priority} priority` } : null,
      t.due_date && Date.parse(`${t.due_date}T23:59:59`) < Date.now() && t.status !== "done"
        ? { label: "past its date", tone: "bad" } : null,
    ],
    facts: [
      ["Client", nameOf(ctx.clients, t.client_id)],
      ["Assigned to", ctx.teamName?.(t.assigned_to) || null],
      ["Due", t.due_date],
      ["Category", t.category],
      ["Phase", t.phase],
      ["Added", when(t.created_at)],
    ],
    body: (t.latest_report || t.description)
      ? <>
          {t.latest_report && <PanelSection title="Latest update"><div className="adm-mtg-item-note">{t.latest_report}</div></PanelSection>}
          {t.description && <PanelSection title="The brief"><div className="adm-mtg-item-note">{t.description}</div></PanelSection>}
        </>
      : null,
    link: { to: "/dashboard/operations", label: "Open it in Operations" },
  }),

  /* ---- a support ticket ---- */
  ticket: (t, ctx) => ({
    kicker: "Tickets",
    title: t.subject || "No subject",
    subtitle: t.requester_name || t.requester_email || null,
    badges: [
      { label: t.status || "no status", tone: t.status === "open" ? "bad" : t.status === "solved" || t.status === "closed" ? "good" : undefined },
      t.priority ? { label: t.priority } : null,
      t.source ? { label: `came in by ${t.source}` } : null,
    ],
    facts: [
      ["From", t.requester_email],
      ["Assigned to", ctx.teamName?.(t.assigned_to) || null],
      ["Opened", when(t.created_at)],
      ["Last change", when(t.updated_at)],
    ],
    link: { to: "/dashboard/tickets", label: "Open the ticket" },
  }),

  /* ---- a follow-up somebody set themselves ---- */
  reminder: (r, ctx) => {
    const ms = Date.parse(r.due_at);
    const late = Number.isFinite(ms) && ms < new Date().setHours(0, 0, 0, 0);
    return {
      kicker: "Follow-up",
      title: r.body || "No wording on this one",
      subtitle: null,
      badges: [
        late ? { label: "past its date", tone: "bad" } : { label: "still open" },
        r.done_at ? { label: "ticked off", tone: "good" } : null,
      ],
      facts: [
        ["Due", when(r.due_at)],
        ["Whose", ctx.teamName?.(r.owner_id) || null],
        ["Set by", ctx.teamName?.(r.created_by) || null],
        ["Set on", when(r.created_at)],
        ["Ticked off", when(r.done_at)],
      ],
      link: { to: "/dashboard/work", label: "Back to your Work page" },
    };
  },

  /* ---- a note ----
   *
   * TWO DIFFERENT NOTES SHARE THIS RENDERER, on purpose, and the fields are
   * read defensively because of it. The Notes page draws generated notes
   * (category, urgency, evidence, written_by) and the Work page draws the
   * private ones somebody typed (title, body, pinned). Both are "a note" to
   * whoever clicks one.
   *
   * COUNTED vs AI-WRITTEN IS CARRIED THROUGH, NEVER DROPPED. The Notes page
   * badges every note with it for a reason — one is arithmetic over real rows
   * and the other is a model's sentence — and a panel that showed the words
   * without the badge would quietly merge the two. `written_by` is the field
   * that says which; a note that carries no such field (the typed ones) gets no
   * badge at all rather than a guessed one. */
  note: (n, ctx) => ({
    kicker: "Notes",
    title: n.title || n.subject || "Note",
    subtitle: nameOf(ctx.clients, n.client_id) || null,
    badges: [
      n.category ? { label: n.category.replace(/_/g, " ") } : null,
      n.urgency === 3 ? { label: "urgent", tone: "bad" } : null,
      n.written_by === "counted" ? { label: "counted", tone: "good" }
        : n.written_by ? { label: String(n.written_by).replace(/_/g, " ") } : null,
      n.status && n.status !== "open" ? { label: n.status } : null,
      n.pinned ? { label: "pinned", tone: "accent" } : null,
    ],
    facts: [
      ["Written", when(n.generated_at || n.created_at)],
      ["Client", nameOf(ctx.clients, n.client_id)],
      ["Status", n.status],
      ["Rows behind it", Array.isArray(n.evidence) && n.evidence.length ? `${n.evidence.length} counted` : null],
    ],
    body: (n.body || n.text)
      ? <PanelSection title="What it says"><div className="adm-mtg-item-note">{n.body || n.text}</div></PanelSection>
      : null,
    link: { to: "/dashboard/notes", label: "Open Notes" },
  }),

  /* ---- an email thread ---- */
  email: (e, ctx) => ({
    kicker: "Inbox",
    title: e.subject || "No subject",
    subtitle: e.from_name ? `${e.from_name} · ${e.from_email || ""}`.trim() : e.from_email || null,
    badges: [
      { label: e.status || "new", tone: e.status === "needs_reply" ? "bad" : e.status === "done" ? "good" : undefined },
      e.priority && e.priority !== "normal" ? { label: `${e.priority} priority` } : null,
    ],
    facts: [
      ["From", e.from_email],
      ["Client", nameOf(ctx.clients, e.client_id)],
      ["Owned by", ctx.teamName?.(e.owner_id) || null],
      ["Last message", when(e.last_message_at)],
      ["Follow up on", when(e.follow_up_at)],
    ],
    body: e.notes ? <PanelSection title="Notes"><div className="adm-mtg-item-note">{e.notes}</div></PanelSection> : null,
    link: { to: "/dashboard/inbox", label: "Open it in the Inbox" },
  }),

  /* ---- somebody on the team ---- */
  member: (m) => ({
    kicker: "Team",
    title: m.full_name || m.email || "Unnamed",
    subtitle: m.email || null,
    badges: [
      { label: m.role || "no role" },
      m.active ? { label: "active", tone: "good" } : { label: "not active", tone: "bad" },
    ],
    facts: [["Role", m.role], ["Email", m.email], ["Joined", when(m.created_at)]],
    link: { to: "/dashboard/team", label: "Open the Team page" },
  }),
};

export { RENDERERS };
