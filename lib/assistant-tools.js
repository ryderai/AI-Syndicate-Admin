/* What the assistant is allowed to DO, and the code that does it.
 *
 * The assistant runs on the service-role Supabase client, which bypasses row
 * level security completely. So the database is NOT the guard here — this file
 * is. Trap #6 in CONTEXT-FOR-AI.md ("UI-only permission guards are not
 * guards") has a twin: a tool list is not a guard either, because the model
 * chooses from the list it is given. Both halves are enforced below:
 *
 *   1. toolsForRole() decides which tools even exist for this person.
 *   2. runTool() re-checks the role before touching a row, so a hand-crafted
 *      request naming a tool that was never offered still gets refused.
 *
 * FOUR RULES BUILT IN
 *
 * - Nothing here deletes anything. There is no delete tool, at any role. An
 *   assistant that can remove a client on a misheard sentence is not worth the
 *   convenience. Deleting stays a human action with a confirm box on it.
 *
 * - Every write is logged to admin_assistant_log with who asked, what ran, and
 *   whether it worked — before the answer comes back, not after.
 *
 * - Every write is scoped by id. No tool takes a filter and updates whatever
 *   matches; the assistant has to name the row, which means it has to have
 *   read it first.
 *
 * - Free text is capped and trimmed on the way in. The model is a source of
 *   text like any other, and it is not trusted more than a form field.
 */

/* THE STAGE GATE, imported rather than copied. It moved into this folder on
 * 2 Sep 2026 precisely so this file could reach it: the assistant is a writer
 * like every screen, and a rule enforced in one of four writers is not a rule.
 * See the note over STAGE_REQUIRES in lib/stage-move.js. */
import { STAGE_REQUIRES, stageRequirementMet } from "./stage-move.js";
/* The team's own clock. A date with no timezone is a date that lands on the
 * wrong day for somebody, and this file has already been bitten by it once —
 * "remind me Friday" stored at 09:00Z arrived at 4am Central, overdue at
 * breakfast. A meeting is worse: the DAY is the whole fact being recorded. */
import { TEAM_TZ } from "./brain-context.js";
/* The same vocabulary and the same timeline wording the screens use. Imported,
 * not restated: lib/meetings.js is pure with no imports of its own, which is
 * exactly why it can be shared between the browser and this server file. Two
 * copies of the sentence that goes on a timeline is two sentences. */
import { meetingBody, kindLabel, outcomeLabel, teamInstant, UNTIMED_HOUR } from "./meetings.js";

const MAX_TEXT = 4000;
const MAX_TITLE = 300;

function clean(v, n = MAX_TEXT) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, n) : null;
}

/** A plain YYYY-MM-DD, or null. Rejects anything else rather than guessing —
 * a due date the assistant invented is worse than no due date. */
function cleanDate(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : s;
}

function cleanUuid(v) {
  const s = String(v ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

/* ------------------------------------------------------------------ */
/* The tool list                                                       */
/* ------------------------------------------------------------------ */

/* A LOCAL COPY, and it has to track PICKABLE_STAGES in src/lib/data.js by hand.
 *
 * It cannot import it: this file runs on the server, and src/lib/data.js pulls
 * in src/lib/supabase.js, which reads `import.meta.env` and is undefined under
 * node. Two lists in two files is exactly the shape this repo has been bitten
 * by, so `tests/pipeline-spec` reads BOTH out of their source and fails if they
 * drift.
 *
 * It used to be ["new","contacted",...] and the two derived stages in it were a
 * third door into the room the sheet and the drawer had just locked. */
const LEAD_STAGES = ["follow_up", "meeting_booked", "meeting_complete", "proposal", "won", "lost", "not_a_fit"];
/* WHAT THE ASSISTANT MAY ACTUALLY SET, which is not the same list.
 *
 * Won and Lost both require a reason now — a counted one and a sentence in the
 * person's own words — and they write a dated note and a tag in the same act. The
 * tool refuses them at runtime; leaving them in the SCHEMA meant the model was
 * told it could set them, tried, and burned a turn on a refusal for a value we had
 * offered it. Found by the third review, Aug 27 2026. */
/* FROM PICKABLE_STAGES, NOT LEAD_STAGES — 30 Aug 2026.
 *
 * It filtered the full twelve, so after the sheet and the drawer stopped
 * offering the derived stages, "move Acme to contacted" in AI Brain still
 * worked. That is the third door on the same room, and a checker walked
 * through it within the hour: restricting the controls is not restricting the
 * act, and the model is a control.
 *
 * Won and Lost stay out for the older reason above — they need a reason box,
 * and a tool cannot ask for one. */
const SETTABLE_STAGES = LEAD_STAGES.filter((s) => !["won", "lost"].includes(s));
const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"];
const TASK_PRIORITIES = ["high", "medium", "low"];
const EMAIL_STATUSES = ["needs_reply", "waiting", "scheduled", "done", "ignored"];

export const TOOLS = {
  /* ---- reading ---- */

  search: {
    roles: ["owner", "admin", "sales"],
    writes: false,
    spec: {
      name: "search",
      description:
        "Search the console's own records by text when what you need is not in the context block. "
        + "The context block is capped, so anything older or further down the list is only reachable this way. "
        + "Returns matching rows with their ids — you need an id before you can change anything.",
      input_schema: {
        type: "object",
        properties: {
          what: { type: "string", enum: ["leads", "clients", "tasks", "emails", "tickets", "memory"],
            description: "Which records to search." },
          query: { type: "string", description: "Words to look for. Matched against names, titles and subjects." },
          limit: { type: "integer", description: "How many to return. Default 15, most 50." },
        },
        required: ["what", "query"],
      },
    },
  },

  /* ---- sales ---- */

  update_lead: {
    roles: ["owner", "admin", "sales"],
    writes: true,
    spec: {
      name: "update_lead",
      description:
        "Change a lead: its stage, who owns it, or its notes. Only pass the fields you are actually changing. "
        + "A sales rep may only change a lead that is theirs or unclaimed.",
      input_schema: {
        type: "object",
        properties: {
          lead_id: { type: "string", description: "The lead's id." },
          stage: { type: "string", enum: SETTABLE_STAGES },
          owner_id: { type: "string", description: "Team member's user id, or the word 'me', or 'none' to unassign." },
          notes: { type: "string", description: "Replaces the lead's notes. Pass the full new text." },
        },
        required: ["lead_id"],
      },
    },
  },

  log_lead_activity: {
    roles: ["owner", "admin", "sales"],
    writes: true,
    spec: {
      name: "log_lead_activity",
      description:
        "Write a call, email, text or note onto a lead's timeline. Use this when the person tells you what "
        + "they just did. Rep stats are counted from these rows, so an unlogged call is an uncounted call.",
      input_schema: {
        type: "object",
        properties: {
          lead_id: { type: "string" },
          type: { type: "string", enum: ["call", "email", "text", "note"] },
          outcome: { type: "string",
            enum: ["talked", "voicemail", "no_answer", "booked", "not_interested", "bad_number"],
            description: "Required for call, email and text. Leave out for a note." },
          body: { type: "string", description: "What happened, in their words where possible." },
        },
        required: ["lead_id", "type"],
      },
    },
  },

  /* ---- meetings ---- (12 Sep 2026, migration 0034)
   *
   * Julia asked for this in the group DM and Ryder's answer was that it had to
   * be done by hand. This is the other half of the answer: she can say a whole
   * list in one message and it files all of them.
   *
   * TWO THINGS MAKE THIS TOOL DIFFERENT FROM EVERY OTHER WRITE IN THIS FILE.
   *
   * 1. IT TAKES A LIST. Every other tool writes one row. A tool that wrote one
   *    meeting would turn "I met Dave, Sarah and Mike" into three turns and
   *    three chances to lose the thread — which is the manual work she is
   *    trying to stop doing.
   *
   * 2. CALLED WITHOUT `confirmed`, IT WRITES NOTHING and returns the list back
   *    in words to be read out and approved. Getting a meeting onto the wrong
   *    person's record is the failure that looks most normal afterwards, and
   *    the only cheap moment to catch it is before the write.
   *
   *    BE PRECISE ABOUT WHAT THIS IS. `confirmed` is a field in the MODEL'S own
   *    input. The server does not know whether a human ever saw the readback, and
   *    a model that sets `confirmed: true` on its first call writes immediately.
   *    An earlier version of this comment called it a guard enforced in runTool
   *    "because a description is a request and this file is the guard" — that
   *    was false, and a comment asserting a check that does not happen is the
   *    worst defect this format produces. It is a two-step protocol the model is
   *    asked to follow, not a permission boundary.
   *
   *    WHAT ACTUALLY BOUNDS THE DAMAGE, and these are real: the role check below
   *    and the per-lead owner check, which are the same ones log_lead_activity
   *    keeps; nothing here can delete or overwrite an existing meeting; every
   *    run is written to admin_assistant_log with its arguments; and everything
   *    it writes lands in one batch that Sales → Past meetings can put back in a
   *    click. A wrong write is visible and reversible, which is the property to
   *    buy when a true boundary is not available.
   */
  log_meeting: {
    roles: ["owner", "admin", "sales"],
    writes: true,
    spec: {
      name: "log_meeting",
      description:
        "Record meetings that have already happened — one, or a whole list in one go. Use this whenever "
        + "somebody tells you who they met and when, including 'I had these meetings last month'. "
        + "ALWAYS CALL IT FIRST WITH confirmed=false: nothing is written, and you get back exactly what "
        + "would be recorded, which you must show them and get a yes for before calling again with "
        + "confirmed=true. Look every person up with search first — never guess an id from a name. "
        + "If you cannot find somebody, leave them out, write the rest, and say who you could not place. "
        + "This does not move anybody's pipeline stage and does not change any follow-up date.",
      input_schema: {
        type: "object",
        properties: {
          meetings: {
            type: "array",
            description: "One entry per meeting. Up to 50.",
            items: {
              type: "object",
              properties: {
                lead_id: { type: "string", description: "The lead's id, from search. Give this or client_id." },
                client_id: { type: "string", description: "The client's id, for somebody who has already signed." },
                occurred_on: { type: "string", description: "The day it happened, as YYYY-MM-DD. Work it out from today's date in the context block. Never guess a year." },
                occurred_time: { type: "string", description: "Optional, as HH:MM on a 24-hour clock. Leave it out unless they said a time." },
                kind: { type: "string", enum: ["discovery", "demo", "follow_up", "proposal", "check_in", "other"] },
                outcome: { type: "string", enum: ["happened", "went_well", "no_show", "rescheduled", "they_passed", "booked_next"], description: "Use 'happened' unless they actually said how it went. Do not upgrade it to 'went_well' on your own." },
                note: { type: "string", description: "What came out of it, in their words." },
              },
              required: ["occurred_on"],
            },
          },
          confirmed: { type: "boolean", description: "False or absent = show them what would be written and write nothing. True = they have said yes, write it." },
        },
        required: ["meetings"],
      },
    },
  },

  /* ---- everyone ---- */

  create_reminder: {
    roles: ["owner", "admin", "sales"],
    writes: true,
    spec: {
      name: "create_reminder",
      description:
        "Set a dated follow-up for someone. It shows on their Work page. Use this whenever the person says "
        + "'remind me', 'chase this on Friday', or agrees to come back to something.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "What to do, starting with the verb." },
          due_at: { type: "string", description: "The date, as YYYY-MM-DD. Work it out from today's date in the context block." },
          owner_id: { type: "string", description: "Whose follow-up. 'me' for the person asking. Defaults to them." },
        },
        required: ["title", "due_at"],
      },
    },
  },

  /* ---- delivery ---- */

  create_task: {
    roles: ["owner", "admin"],
    writes: true,
    spec: {
      name: "create_task",
      description:
        "Add a task to Operations. Give it a client and a due date whenever you can work them out — a task "
        + "with neither lands in a view nobody looks at.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          client_id: { type: "string", description: "The client's id, if it belongs to one." },
          assigned_to: { type: "string", description: "Team member's user id, or 'me'." },
          due_date: { type: "string", description: "YYYY-MM-DD." },
          priority: { type: "string", enum: TASK_PRIORITIES },
          notes: { type: "string" },
        },
        required: ["title"],
      },
    },
  },

  update_task: {
    roles: ["owner", "admin"],
    writes: true,
    spec: {
      name: "update_task",
      description: "Change a task's status, date, owner or priority. Only pass what changes.",
      input_schema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          status: { type: "string", enum: TASK_STATUSES },
          due_date: { type: "string", description: "YYYY-MM-DD." },
          assigned_to: { type: "string", description: "Team member's user id, or 'me'." },
          priority: { type: "string", enum: TASK_PRIORITIES },
        },
        required: ["task_id"],
      },
    },
  },

  set_email_status: {
    roles: ["owner", "admin"],
    writes: true,
    spec: {
      name: "set_email_status",
      description:
        "Move an email thread's status in the shared inbox. This changes what the whole team sees, so only "
        + "do it when asked plainly. It does not send anything and does not touch Gmail.",
      input_schema: {
        type: "object",
        properties: {
          thread_row_id: { type: "string", description: "The admin_email_threads row id from the context block." },
          status: { type: "string", enum: EMAIL_STATUSES },
        },
        required: ["thread_row_id", "status"],
      },
    },
  },

  /* ---- memory ---- */

  remember: {
    roles: ["owner", "admin"],
    writes: true,
    spec: {
      name: "remember",
      description:
        "Keep something for later. Use it when you learn a fact that will still be true next week: how a "
        + "client likes to be contacted, why a decision was made, a trap in a tool, who handles what. "
        + "Do NOT use it for things already in a row (a lead's stage, a task's date) — those are read fresh "
        + "every time and a copy would go stale. Do not store passwords or card numbers, ever.",
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "What it is about. A client name, a tool, a person." },
          body: { type: "string", description: "The fact itself, in plain words. One or two sentences." },
          kind: { type: "string", enum: ["fact", "preference", "event", "person", "decision", "gotcha"] },
          weight: { type: "integer", description: "1 to 5. 5 = would be a real problem to forget. Default 3." },
          client_id: { type: "string", description: "Attach it to a client, if it belongs to one." },
        },
        required: ["subject", "body"],
      },
    },
  },

  confirm_memory: {
    roles: ["owner", "admin"],
    writes: true,
    spec: {
      name: "confirm_memory",
      description:
        "Mark a remembered fact as checked by a person, or switch it off because it is wrong. "
        + "Only call this when the person actually says so.",
      input_schema: {
        type: "object",
        properties: {
          memory_id: { type: "string" },
          verdict: { type: "string", enum: ["confirm", "retire"],
            description: "confirm = a person says it is right. retire = it is wrong; keep the row, stop using it." },
        },
        required: ["memory_id", "verdict"],
      },
    },
  },

  write_note: {
    roles: ["owner", "admin"],
    writes: true,
    spec: {
      name: "write_note",
      description:
        "Put a note on the Notes page. Use it for something worth the team seeing that the counting rules "
        + "would not have caught. Say plainly in the body where the facts came from.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          category: { type: "string", enum: ["in_circulation", "follow_up", "attention", "win"] },
          client_id: { type: "string" },
          urgency: { type: "integer", description: "1 to 3. 3 = today." },
        },
        required: ["title", "body"],
      },
    },
  },
};

/** The tool definitions this role is allowed to be offered. */
export function toolsForRole(role, { allowWrites = true } = {}) {
  return Object.values(TOOLS)
    .filter((t) => t.roles.includes(role))
    .filter((t) => allowWrites || !t.writes)
    .map((t) => t.spec);
}

/* ------------------------------------------------------------------ */
/* Running one                                                         */
/* ------------------------------------------------------------------ */

function fail(msg) { return { ok: false, text: msg }; }
function done(text, target) { return { ok: true, text, ...target }; }

/**
 * Run one tool call.
 *
 * @param admin   service-role Supabase client
 * @param member  { user, membership } from requireMember
 * @param name    tool name the model asked for
 * @param input   the model's arguments — untrusted
 * @param opts    { allowWrites }
 * @returns       { ok, text, target_table?, target_id? }
 */
export async function runTool(admin, member, name, input = {}, { allowWrites = true } = {}) {
  const role = member.membership.role;
  const me = member.membership.user_id;
  const def = TOOLS[name];

  // The second half of the guard. The model can only pick from the list it was
  // given, but the request that carries its answer is still just a request.
  if (!def) return fail(`There is no tool called "${name}".`);
  if (!def.roles.includes(role)) return fail(`Not allowed: "${name}" is not available to the ${role} role.`);
  if (def.writes && !allowWrites) {
    return fail(`Actions are switched off in this conversation, so I did not run "${name}". Tell them what you would have done and let them turn actions on.`);
  }

  /** "me" is the one alias accepted, and it resolves to the person asking —
   * never to a name the model typed. "none" means unassign. Anything else must
   * be a real uuid.
   *
   * BAD is returned for anything else, and every caller must refuse rather
   * than continue. Returning null for an unparseable value meant "assign that
   * lead to Andrew" — where the model passes the string "Andrew" — silently
   * UNASSIGNED the lead and reported "✓ DID THIS · owner_id → none". Nothing
   * told the person their lead had just been dropped into the pool. Found by
   * an adversarial review, Aug 20 2026. */
  const BAD = Symbol("not-a-person");
  const person = (v) => {
    if (v === "me" || v === undefined || v === null || v === "") return me;
    if (v === "none") return null;
    return cleanUuid(v) ?? BAD;
  };
  const badPerson = (v) => v === BAD;

  try {
    switch (name) {
      /* ---------------------------------------------------------- */
      case "search": {
        const q = clean(input.query, 120);
        if (!q) return fail("Search needs some words to look for.");
        const limit = Math.min(Math.max(parseInt(input.limit, 10) || 15, 1), 50);
        const like = `%${q.replace(/[%_,]/g, " ")}%`;
        const MAP = {
          leads: ["admin_leads", "id,name,company,email,phone,domain,city,state,stage,owner_id,source,last_activity_at",
            `name.ilike.${like},company.ilike.${like},email.ilike.${like},domain.ilike.${like},city.ilike.${like}`],
          clients: ["admin_clients", "id,name,domain,status,stage,vertical,notes",
            `name.ilike.${like},domain.ilike.${like},notes.ilike.${like}`],
          // admin_tasks stores the task's words in `name` and `latest_report`.
          // There is no `title` and no `notes`; selecting them errored on every
          // task search until an adversarial review caught it, Aug 20 2026.
          tasks: ["admin_tasks", "id,name,status,client_id,assigned_to,due_date,priority",
            `name.ilike.${like},latest_report.ilike.${like}`],
          emails: ["admin_email_threads", "id,subject,from_email,from_name,status,client_id,last_message_at",
            `subject.ilike.${like},from_email.ilike.${like},from_name.ilike.${like}`],
          tickets: ["admin_tickets", "id,subject,status,priority,requester_email,updated_at",
            `subject.ilike.${like},requester_email.ilike.${like}`],
          memory: ["admin_brain_memory", "id,subject,body,kind,weight,confirmed,active",
            `subject.ilike.${like},body.ilike.${like}`],
        };
        // A rep can search leads and nothing else. Same rule as the context
        // block — this endpoint must not become the way around it.
        if (role === "sales" && input.what !== "leads") {
          return fail("A sales rep can only search leads.");
        }
        // Object.hasOwn, not a truthiness check: `what: "constructor"` finds
        // a function on the prototype, passes a plain `if (!entry)`, and dies
        // in the destructuring below with an unreadable error.
        if (!Object.hasOwn(MAP, input.what)) return fail(`Cannot search "${input.what}".`);
        const entry = MAP[input.what];
        const [table, cols, filter] = entry;
        /* A REP MAY ONLY FIND LEADS THEY MAY SEE — 30 Aug 2026.
         *
         * `role === "sales"` was already stopped from searching anything but
         * leads. It was not stopped from searching ALL of them: this runs on the
         * service role, which ignores row-level security, so a rep could type a
         * competitor's name into AI Brain and get back another rep's contact
         * with `owner_id` in the columns. That is the same door
         * `visibleToMember` (src/lib/salesSheet.js) closes on the Sales page and
         * `repLeadFilter` (lib/brain-context.js) closes on the context block.
         * Three doors, one rule; change one and change all three.
         *
         * Two `.or()` calls are ANDed by PostgREST, so this reads as
         * "(the words match) AND (it is mine or unclaimed)". */
        let query = admin.from(table).select(cols).or(filter);
        if (role === "sales" && me) query = query.or(`owner_id.eq.${me},owner_id.is.null`);
        const { data, error } = await query.limit(limit);
        if (error) return fail(`Search failed: ${error.message}`);
        if (!data?.length) return done(`Nothing in ${input.what} matches "${q}".`);
        return done(`${data.length} match${data.length === 1 ? "" : "es"} in ${input.what}:\n`
          + JSON.stringify(data, null, 0));
      }

      /* ---------------------------------------------------------- */
      case "update_lead": {
        const id = cleanUuid(input.lead_id);
        if (!id) return fail("update_lead needs the lead's id.");
        const { data: lead, error: readErr } = await admin
          /* `meeting_at` and `next_follow_up_at` are read because the stage
             gate below needs them. A gate that judges a partial row would
             refuse a lead that already has its date. */
          .from("admin_leads").select("id,name,company,stage,owner_id,meeting_at,next_follow_up_at").eq("id", id).maybeSingle();
        if (readErr) return fail(`Could not read that lead: ${readErr.message}`);
        if (!lead) return fail("No lead with that id.");

        // A rep may work their own leads and claim unclaimed ones. They may
        // not reach into another rep's pipeline, and they may not hand a lead
        // to somebody else.
        if (role === "sales") {
          if (lead.owner_id && lead.owner_id !== me) {
            return fail("That lead belongs to another rep. Only an admin can move it.");
          }
          const wanted = person(input.owner_id);
          if (input.owner_id !== undefined && (badPerson(wanted) || wanted !== me)) {
            return fail("A rep can claim a lead for themselves but cannot assign it to someone else.");
          }
        }

        const patch = {};
        if (input.stage !== undefined) {
          if (!LEAD_STAGES.includes(input.stage)) return fail(`"${input.stage}" is not a stage.`);

          /* THE ASSISTANT GOES THROUGH THE SAME GATE THE SCREENS DO — 2 Sep 2026.
           *
           * It did not, and a checker found it the same day the Meeting stage
           * was split: "move Acme to meeting complete" produced a lead at that
           * stage with `meeting_at` NULL — the exact state migration 0030 says
           * is impossible, and the one that makes every meeting count
           * uncheckable. Three stages have a requirement and the chat box could
           * reach all three of them without meeting any.
           *
           * It ASKS rather than silently filling anything in. Inventing a date
           * on somebody's behalf is the console making up a fact about the
           * world, which is worse than a refusal — and the sentence tells them
           * exactly what to say next, so it is one more message, not a wall. */
          const need = STAGE_REQUIRES[input.stage];
          if (need) {
            /* The proposal check needs the lead's proposals, so read them —
               and only when the stage in question actually asks for one. */
            let proposals = [];
            if (need.kind === "proposal") {
              const { data: rows } = await admin
                .from("admin_proposals").select("lead_id,amount_cents").eq("lead_id", id);
              proposals = rows || [];
            }
            const already = stageRequirementMet(input.stage, lead, { proposals });
            if (!already) {
              if (need.kind === "date") {
                const when = input[need.field];
                if (!when) return fail(`${need.ask} Say it in the same message — for example "move them to ${input.stage} on Tuesday at 2pm".`);
                const at = Date.parse(when);
                if (!Number.isFinite(at)) return fail(`I could not read "${when}" as a date and a time.`);
                if (need.when === "future" && at <= Date.now()) return fail(`${need.ask} That one has already passed.`);
                if (need.when === "past" && at > Date.now()) return fail("A meeting that has not happened yet cannot be marked complete.");
                patch[need.field] = new Date(at).toISOString();
              } else {
                return fail(`${need.ask} ${need.why} I cannot add a proposal from here — open the record and add it under Proposals.`);
              }
            }
          }

          patch.stage = input.stage;
          /* `became_customer` is NOT set here. It used to be, and it created a
           * lead flagged as a customer with no client record behind it —
           * a state that then made the Won button on every screen refuse to do
           * anything, saying "already a client" about a client that did not
           * exist. The flag is written by admin_lead_to_client (migration 0015)
           * and by nothing else. Moving a stage from a chat message is not the
           * place to create a client record. */
        }
        if (input.owner_id !== undefined) {
          const owner = person(input.owner_id);
          if (badPerson(owner)) {
            return fail(`"${input.owner_id}" is not a team member's id. Look the person up first, or say "me" or "none".`);
          }
          patch.owner_id = owner;
        }
        if (input.notes !== undefined) {
          // An empty string is "the model had nothing to say", not "erase what
          // is there". clean() returns null for empty, and writing that null
          // wiped the lead's notes with no copy kept — in a file whose own
          // header says nothing here deletes anything. Clearing a note stays a
          // human action, in the drawer, where the old text is still on screen.
          const text = clean(input.notes);
          if (!text) return fail("I will not blank a lead's notes. Clear them by hand on the lead if that is what you want.");
          patch.notes = text;
        }
        /* ---- A DEAL IS NOT CLOSED FROM A CHAT MESSAGE ----
         *
         * Aug 27 2026. Won and Lost both require a reason now — a counted one and
         * a sentence in the person's own words — and they write a dated note and a
         * tag in the same act (closeLeadWon / markLeadLost in src/lib/data.js).
         * This tool wrote the stage straight to the row: no reason, no
         * `closed_at`, no note, no tag. So a fifth path existed that closed deals
         * invisibly, and those closes then fell out of both reason breakdowns AND
         * out of every window (nothing counts a close with no date), while the
         * screens said "every one of those closed before the reason box existed".
         *
         * Refused rather than extended. A reason box belongs in front of a person
         * who is looking at the record, not inside a chat turn — and the whole
         * point of "one action, one function" is that a fifth way of doing it is
         * the bug, not the feature. Found by an adversarial review. */
        if (["won", "lost"].includes(patch.stage)) {
          return fail(
            patch.stage === "won"
              ? "I cannot mark a deal won. Won asks why, in your own words, and records a dated note and the client link in the same act — press Won on the lead itself."
              : "I cannot mark a deal lost. Lost asks why, in your own words, and records a dated note — press Lost on the lead itself. Six months of those reasons is how the gap gets found.",
          );
        }
        if (!Object.keys(patch).length) return fail("Nothing to change — no fields were given.");

        const { error } = await admin.from("admin_leads").update(patch).eq("id", id);
        if (error) return fail(`Save failed: ${error.message}`);

        // The change goes on the lead's own timeline too, so it reads the same
        // as a change a person made by hand.
        const what = Object.entries(patch)
          .map(([k, v]) => `${k} → ${v === null ? "none" : v}`).join(", ");
        await admin.from("admin_lead_activity").insert({
          lead_id: id, actor: me, type: "status_change",
          body: `Assistant, asked by ${member.membership.full_name || member.membership.email}: ${what}`,
        });
        await admin.from("admin_leads").update({ last_activity_at: new Date().toISOString() }).eq("id", id);
        /* Moving the stage to Won is NOT the same as making them a client, and
         * this tool deliberately does not make one — creating a client record
         * from a chat message is not a thing that should happen without
         * somebody looking at it. Said out loud, so nobody assumes it happened. */
        /* Won and Lost are refused above, so nothing reaching here can be a
         * close. The sentence that used to sit here — "the stage moved, but no
         * client record was created" — described a state this tool can no longer
         * produce. */
        const note = "";
        return done(`Updated ${lead.name || lead.company || "the lead"}: ${what}.${note}`,
          { target_table: "admin_leads", target_id: id });
      }

      /* ---------------------------------------------------------- */
      case "log_lead_activity": {
        const id = cleanUuid(input.lead_id);
        if (!id) return fail("log_lead_activity needs the lead's id.");
        const type = ["call", "email", "text", "note"].includes(input.type) ? input.type : null;
        if (!type) return fail("type must be call, email, text or note.");
        const outcome = type === "note" ? null : clean(input.outcome, 40);
        if (type !== "note" && !outcome) return fail("A call, email or text needs an outcome.");
        const body = clean(input.body, 2000);
        if (type === "note" && !body) return fail("A note needs some text.");

        const { data: lead } = await admin
          .from("admin_leads").select("id,name,company,owner_id").eq("id", id).maybeSingle();
        if (!lead) return fail("No lead with that id.");
        if (role === "sales" && lead.owner_id && lead.owner_id !== me) {
          return fail("That lead belongs to another rep.");
        }

        const { error } = await admin.from("admin_lead_activity")
          .insert({ lead_id: id, actor: me, type, outcome, body });
        if (error) return fail(`Could not log it: ${error.message}`);
        await admin.from("admin_leads").update({ last_activity_at: new Date().toISOString() }).eq("id", id);
        return done(`Logged a ${type}${outcome ? ` (${outcome})` : ""} on ${lead.name || lead.company || "the lead"}.`,
          { target_table: "admin_lead_activity", target_id: id });
      }

      /* ---------------------------------------------------------- */
      case "log_meeting": {
        const list = Array.isArray(input.meetings) ? input.meetings.slice(0, 50) : null;
        if (!list || !list.length) return fail("log_meeting needs at least one meeting.");

        /* ---- read every row first, and refuse the WHOLE list on any problem.
         *
         * Same rule the grid keeps (Rule 4 in lib/meetings.js) and for the same
         * reason: a half-written list leaves a backlog nobody can audit. Here it
         * matters more, not less — the person is talking, not looking at a
         * screen, so "12 of 15 saved" is a sentence they will not chase. */
        const parsed = [];
        const problems = [];
        for (let i = 0; i < list.length; i++) {
          const m = list[i] || {};
          const at = i + 1;
          const leadId = m.lead_id ? cleanUuid(m.lead_id) : null;
          const clientId = m.client_id ? cleanUuid(m.client_id) : null;
          if (m.lead_id && !leadId) { problems.push(`#${at}: "${m.lead_id}" is not a lead id. Look the person up with search first.`); continue; }
          if (m.client_id && !clientId) { problems.push(`#${at}: "${m.client_id}" is not a client id.`); continue; }
          if (!leadId && !clientId) { problems.push(`#${at}: no idea who this meeting was with. Give a lead_id or a client_id.`); continue; }

          const day = cleanDate(m.occurred_on);
          if (!day) { problems.push(`#${at}: occurred_on must be a real date as YYYY-MM-DD, not "${m.occurred_on ?? ""}".`); continue; }
          const time = /^\d{1,2}:\d{2}$/.test(String(m.occurred_time || "")) ? String(m.occurred_time).padStart(5, "0") : null;
          const iso = teamInstantFromDay(day, time || "12:00");
          if (!iso) { problems.push(`#${at}: could not turn ${day}${time ? ` ${time}` : ""} into a real time.`); continue; }

          const kind = ["discovery", "demo", "follow_up", "proposal", "check_in", "other"].includes(m.kind) ? m.kind : "discovery";
          /* NOT UPGRADED. An outcome the model was not given is "happened",
           * never "went_well" — a default that reads as a good meeting would
           * manufacture a scoreboard out of somebody dictating a list. */
          const outcome = ["happened", "went_well", "no_show", "rescheduled", "they_passed", "booked_next"].includes(m.outcome) ? m.outcome : "happened";
          parsed.push({ leadId, clientId, day, time, iso, kind, outcome, note: clean(m.note, 1200) });
        }
        if (problems.length) return fail(`Nothing was recorded. ${problems.join(" ")}`);

        /* ---- who these people are, and whether this rep may touch them ---- */
        const leadIds = [...new Set(parsed.map((p2) => p2.leadId).filter(Boolean))];
        const clientIds = [...new Set(parsed.map((p2) => p2.clientId).filter(Boolean))];
        const leadRows = leadIds.length
          ? (await admin.from("admin_leads").select("id,name,company,owner_id").in("id", leadIds)).data || []
          : [];
        const clientRows = clientIds.length
          ? (await admin.from("admin_clients").select("id,name").in("id", clientIds)).data || []
          : [];
        const leadById = new Map(leadRows.map((r) => [r.id, r]));
        const clientById = new Map(clientRows.map((r) => [r.id, r]));

        for (const p2 of parsed) {
          if (p2.leadId && !leadById.has(p2.leadId)) return fail(`Nothing was recorded. There is no lead with the id ${p2.leadId}.`);
          if (p2.clientId && !clientById.has(p2.clientId)) return fail(`Nothing was recorded. There is no client with the id ${p2.clientId}.`);
          /* The same row lock log_lead_activity keeps. The assistant runs on the
           * service key and goes straight past RLS, so this line IS the lock. */
          if (role === "sales" && p2.leadId) {
            const owner = leadById.get(p2.leadId)?.owner_id;
            if (owner && owner !== me) return fail(`Nothing was recorded. ${leadById.get(p2.leadId)?.name || "One of those leads"} belongs to another rep.`);
          }
          p2.who = p2.leadId
            ? (leadById.get(p2.leadId)?.name || leadById.get(p2.leadId)?.company || "a lead")
            : (clientById.get(p2.clientId)?.name || "a client");
        }

        const readback = parsed.map((p2) =>
          `${p2.who} — ${p2.day}${p2.time ? ` at ${p2.time}` : ""} · ${kindLabel(p2.kind)} · ${outcomeLabel(p2.outcome)}${p2.note ? ` · "${p2.note}"` : ""}`);

        /* ---- the gate. Nothing above this line wrote anything. ---- */
        if (input.confirmed !== true) {
          return done(
            `NOT SAVED YET — read this back to them and ask for a yes before calling again with confirmed=true:\n`
            + readback.map((l, i) => `${i + 1}. ${l}`).join("\n")
            + `\n\nThat is ${parsed.length} ${parsed.length === 1 ? "meeting" : "meetings"}. `
            + `Nobody's pipeline stage will move and no follow-up dates will change.`,
            /* `preview` IS WHY THIS IS NOT A LIE ON SCREEN.
             *
             * Every successful tool run draws a green "✓ DID THIS" receipt in
             * the assistant panel, and this run deliberately does nothing. A
             * green tick over an unwritten list is the same defect this repo
             * already has a note about — "a guard whose failure mode is silence
             * is not a guard", and its twin, a ✓ DID THIS printed over an
             * action that quietly meant something else. The flag is carried
             * through ai-agent.js into the receipt, which draws it as
             * NOTHING SAVED YET. */
            { preview: true }
          );
        }

        /* ---- the batch, so a dictated list is as undoable as a typed one ---- */
        const { data: batch } = await admin.from("admin_meeting_batches")
          .insert({ created_by: me, entry: "chat", row_count: 0, note: "Told to the assistant." })
          .select("id").maybeSingle();
        const batchId = batch?.id || null;

        /* ---- THE MEETINGS FIRST, with ids chosen here ----
         *
         * No positional pairing anywhere. An earlier version inserted the
         * timeline rows first and matched the ids back BY POSITION, guarded by
         * "the lead_id at position i matches" — which distinguishes nothing when
         * two meetings in one batch are with the same person, and a dictated
         * backlog is mostly that. Generating the ids up front means each
         * timeline row simply carries the id of the meeting it describes. */
        const withId = parsed.map((p2) => ({ ...p2, id: randomUuid() }));

        const { error: mErr } = await admin.from("admin_meetings")
          .insert(withId.map((p2) => ({
            id: p2.id,
            lead_id: p2.leadId, client_id: p2.clientId,
            occurred_at: p2.iso, kind: p2.kind, outcome: p2.outcome,
            notes: p2.note, source: "chat", entered_by: me,
            batch_id: batchId,
          })));
        if (mErr) return fail(`The meetings did not save: ${mErr.message}`);

        /* ---- the backdated timeline rows ---- */
        const withLead = withId.filter((p2) => p2.leadId);
        let timelineProblem = null;
        if (withLead.length) {
          const { error: actErr } = await admin.from("admin_lead_activity")
            .insert(withLead.map((p2) => ({
              lead_id: p2.leadId, actor: me, type: "meeting", outcome: p2.outcome,
              body: meetingBody({ kind: p2.kind, outcome: p2.outcome, note: p2.note }),
              created_at: p2.iso,
              meeting_id: p2.id,
            })));
          if (actErr) timelineProblem = actErr.message;
        }

        if (batchId) await admin.from("admin_meeting_batches").update({ row_count: withId.length }).eq("id", batchId);
        const saved = withId;

        return done(
          `Recorded ${saved.length} ${saved.length === 1 ? "meeting" : "meetings"}:\n`
          + readback.map((l) => `· ${l}`).join("\n")
          + `\n\nEach one is dated to the day it happened and marked CLAIMED — typed from memory, not measured. `
          + `Nobody's stage moved. They can all be put back together from Sales → Past meetings.`
          /* SAID OUT LOUD RATHER THAN SWALLOWED. The meetings are saved and are
           * the record; their lines on the timeline are a second fact, and if
           * those failed the person has to know why their history looks empty. */
          + (timelineProblem ? `\n\nOne thing did not work: the lines on their timelines could not be written (${timelineProblem}), so these will not show in anybody's history until that is fixed.` : ""),
          { target_table: "admin_meetings", target_id: batchId || undefined }
        );
      }

      /* ---------------------------------------------------------- */
      case "create_reminder": {
        const title = clean(input.title, MAX_TITLE);
        if (!title) return fail("A follow-up needs a title.");
        const due = cleanDate(input.due_at);
        if (!due) return fail("due_at must be a real date as YYYY-MM-DD.");
        // A rep sets follow-ups for themselves only.
        const asked = role === "sales" ? me : person(input.owner_id);
        if (badPerson(asked)) return fail(`"${input.owner_id}" is not a team member's id. Say "me", or look the person up first.`);
        const owner = asked || me;
        const { data, error } = await admin.from("admin_reminders")
          // `body`, not `title` — and it is NOT NULL, so getting this wrong
          // meant no follow-up the assistant set could ever save.
          // 14:00Z is 9am Central, the team's morning. Storing 09:00Z put a
          // "remind me Friday" at 4am Central, already overdue at breakfast.
          .insert({ owner_id: owner, created_by: me, body: title, due_at: `${due}T14:00:00Z` })
          .select("id").maybeSingle();
        if (error) return fail(`Could not set it: ${error.message}`);
        return done(`Follow-up set for ${due}: "${title}".`,
          { target_table: "admin_reminders", target_id: data?.id });
      }

      /* ---------------------------------------------------------- */
      case "create_task": {
        const title = clean(input.title, MAX_TITLE);
        if (!title) return fail("A task needs a title.");
        const row = {
          name: title,                       // the column is `name`, not `title`
          client_id: cleanUuid(input.client_id),
          assigned_to: null,   // set below, after it has been checked
          due_date: cleanDate(input.due_date),
          priority: TASK_PRIORITIES.includes(input.priority) ? input.priority : "medium",
          latest_report: clean(input.notes),  // the column is `latest_report`
          status: "todo",
        };
        if (input.assigned_to !== undefined) {
          const who2 = person(input.assigned_to);
          if (badPerson(who2)) return fail(`"${input.assigned_to}" is not a team member's id. Say "me", or look the person up first.`);
          row.assigned_to = who2;
        }
        const { data, error } = await admin.from("admin_tasks").insert(row).select("id").maybeSingle();
        if (error) return fail(`Could not add the task: ${error.message}`);
        return done(`Task added: "${title}"${row.due_date ? `, due ${row.due_date}` : ", no date"}.`,
          { target_table: "admin_tasks", target_id: data?.id });
      }

      /* ---------------------------------------------------------- */
      case "update_task": {
        const id = cleanUuid(input.task_id);
        if (!id) return fail("update_task needs the task's id.");
        const patch = {};
        if (input.status !== undefined) {
          if (!TASK_STATUSES.includes(input.status)) return fail(`"${input.status}" is not a status.`);
          patch.status = input.status;
        }
        if (input.due_date !== undefined) {
          const d = cleanDate(input.due_date);
          if (!d) return fail("due_date must be YYYY-MM-DD.");
          patch.due_date = d;
        }
        if (input.assigned_to !== undefined) {
          const who2 = person(input.assigned_to);
          if (badPerson(who2)) return fail(`"${input.assigned_to}" is not a team member's id. Say "me", or look the person up first.`);
          patch.assigned_to = who2;
        }
        if (input.priority !== undefined) {
          if (!TASK_PRIORITIES.includes(input.priority)) return fail(`"${input.priority}" is not a priority.`);
          patch.priority = input.priority;
        }
        if (!Object.keys(patch).length) return fail("Nothing to change.");
        const { data, error } = await admin.from("admin_tasks")
          .update(patch).eq("id", id).select("name").maybeSingle();
        if (error) return fail(`Save failed: ${error.message}`);
        if (!data) return fail("No task with that id.");
        return done(`"${data.name}" updated: `
          + Object.entries(patch).map(([k, v]) => `${k} → ${v === null ? "none" : v}`).join(", ") + ".",
        { target_table: "admin_tasks", target_id: id });
      }

      /* ---------------------------------------------------------- */
      case "set_email_status": {
        const id = cleanUuid(input.thread_row_id);
        if (!id) return fail("set_email_status needs the thread row id.");
        if (!EMAIL_STATUSES.includes(input.status)) return fail(`"${input.status}" is not an email status.`);
        const { data, error } = await admin.from("admin_email_threads")
          .update({ status: input.status, status_changed_at: new Date().toISOString(), status_changed_by: me })
          .eq("id", id).select("subject").maybeSingle();
        if (error) return fail(`Save failed: ${error.message}`);
        if (!data) return fail("No email thread with that id.");
        return done(`"${data.subject || "thread"}" moved to ${input.status.replace("_", " ")}.`,
          { target_table: "admin_email_threads", target_id: id });
      }

      /* ---------------------------------------------------------- */
      case "remember": {
        const subject = clean(input.subject, 200);
        const body = clean(input.body, 2000);
        if (!subject || !body) return fail("A memory needs both a subject and a body.");
        const kind = ["fact", "preference", "event", "person", "decision", "gotcha"].includes(input.kind)
          ? input.kind : "fact";
        const weight = Math.min(Math.max(parseInt(input.weight, 10) || 3, 1), 5);
        const { data, error } = await admin.from("admin_brain_memory")
          .insert({ subject, body, kind, weight, origin: "assistant", created_by: me,
            client_id: cleanUuid(input.client_id) })
          .select("id").maybeSingle();
        // 23505 is the unique index doing its job: this exact memory is
        // already stored. That is a success, not an error — say so plainly
        // rather than storing a second copy or reporting a failure.
        if (error?.code === "23505") return done(`Already remembered: "${subject}".`);
        if (error) return fail(`Could not remember it: ${error.message}`);
        return done(`Remembered (unconfirmed, weight ${weight}): ${subject} — ${body}`,
          { target_table: "admin_brain_memory", target_id: data?.id });
      }

      /* ---------------------------------------------------------- */
      case "confirm_memory": {
        const id = cleanUuid(input.memory_id);
        if (!id) return fail("confirm_memory needs the memory's id.");
        const patch = input.verdict === "retire"
          ? { active: false }
          : { confirmed: true, confirmed_by: me };
        const { data, error } = await admin.from("admin_brain_memory")
          .update(patch).eq("id", id).select("subject").maybeSingle();
        if (error) return fail(`Save failed: ${error.message}`);
        if (!data) return fail("No memory with that id.");
        return done(input.verdict === "retire"
          ? `Retired: "${data.subject}". Kept on the record, no longer used.`
          : `Confirmed: "${data.subject}".`,
        { target_table: "admin_brain_memory", target_id: id });
      }

      /* ---------------------------------------------------------- */
      case "write_note": {
        const title = clean(input.title, MAX_TITLE);
        const body = clean(input.body, 4000);
        if (!title || !body) return fail("A note needs a title and a body.");
        const category = ["in_circulation", "follow_up", "attention", "win"].includes(input.category)
          ? input.category : "attention";
        const urgency = Math.min(Math.max(parseInt(input.urgency, 10) || 2, 1), 3);
        const { data, error } = await admin.from("admin_ai_notes").insert({
          title, body, category, urgency,
          client_id: cleanUuid(input.client_id),
          owner_id: me,
          // ai_written, not counted: a person asked for this in a chat, so its
          // facts came from a conversation, not from counting rows. The badge
          // on the page has to say so.
          written_by: "ai_written",
          evidence: [{ table: "chat", id: null, label: `Asked for by ${member.membership.full_name || member.membership.email}` }],
        }).select("id").maybeSingle();
        if (error) return fail(`Could not write the note: ${error.message}`);
        return done(`Note added to the Notes page: "${title}".`,
          { target_table: "admin_ai_notes", target_id: data?.id });
      }

      default:
        return fail(`"${name}" is not wired up.`);
    }
  } catch (err) {
    return fail(`That failed: ${err?.message || "unknown error"}`);
  }
}

/** Write what happened to the log. Never throws — a logging failure must not
 * swallow the action's own result, but it IS reported back so a silently
 * unlogged action cannot happen without somebody being able to notice.
 *
 * The `error` in the response has to be READ. Supabase resolves with
 * `{ data, error }` rather than throwing, so `await insert(...)` inside a
 * try/catch succeeds no matter what went wrong, and this returned true
 * regardless — which made the "could not be logged" warning in api/ai-chat.js
 * unreachable. Deploy before running migration 0006 and the assistant would
 * change leads, tasks and email statuses with nothing written down anywhere
 * and no warning. Found by an adversarial review, Aug 20 2026. */
export async function logToolRun(admin, { actor, tool, args, result, screen }) {
  try {
    const { error } = await admin.from("admin_assistant_log").insert({
      actor,
      tool,
      args: args || {},
      ok: Boolean(result?.ok),
      result: String(result?.text || "").slice(0, 1000),
      target_table: result?.target_table || null,
      target_id: result?.target_id || null,
      screen: screen ? String(screen).slice(0, 120) : null,
    });
    return !error;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* The team's wall clock                                               */
/* ------------------------------------------------------------------ */
/* A DAY IS NOT AN INSTANT, and this is where that bites hardest.
 *
 * This server runs in UTC. "3 June" said by somebody in the office is a span of
 * 24 hours that starts at 05:00Z. Parsing "2026-06-03" as midnight UTC makes the
 * meeting read as the EVENING OF 2 JUNE to the whole team — the exact bug the
 * Finance page shipped with (CONTEXT-FOR-AI.md §18), which misfiled a month of
 * costs.
 *
 * THE CONVERSION IS lib/meetings.js's, NOT A SECOND COPY OF IT. This file
 * carried its own `tzOffsetMs`/`teamInstant` pair for a few hours, alongside a
 * comment claiming the grid and the assistant "land on the same instant". They
 * did not: the grid was using the BROWSER's midday and this was using Chicago's,
 * so a meeting dictated from New York printed a time nobody had given. One
 * function now decides it for both, and tests/meetings compares the two paths
 * directly rather than taking a comment's word for it. */
function teamInstantFromDay(day, hhmm) {
  const [y, mo, d] = String(day).split("-").map(Number);
  const [hh, mm] = String(hhmm || "").split(":").map(Number);
  const at = teamInstant(y, mo - 1, d, Number.isFinite(hh) ? hh : UNTIMED_HOUR, Number.isFinite(mm) ? mm : 0);
  return at ? at.toISOString() : null;
}

/** A row id we can choose before the database sees it. node 19+ has
 *  crypto.randomUUID globally; the fallback exists so this cannot be the thing
 *  that breaks on an older runtime. Not a secret — the primary key is what
 *  enforces uniqueness. */
function randomUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}
