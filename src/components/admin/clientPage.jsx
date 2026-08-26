import { useEffect, useState } from "react";
import { Modal, Field, TextInput, TextArea, Select, EmptyState, SourceBadge } from "./shared.jsx";
import { Chip } from "./opsCells.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import {
  upsertClientSite, deleteClientSite, readSavedStanding, computeStandingPreview,
  listClientContacts, listLeadActivity, listTasks, listClientSites, listWeekly,
  listClientReports, listClientConnections, listVaultItems,
} from "../../lib/data.js";
import { buildTimeline, prettyDay, joinWords } from "../../lib/clientTimeline.js";
import { SITE_KINDS, SITE_KIND_LABELS, SITE_KIND_HELP, normalizeUrl, prettyUrl } from "../../../lib/client-standing.js";

/* The two client-page sections added Aug 18 2026:
 *
 *   StandingCard — "where this client stands", in short plain words.
 *   SitesPanel   — every website that belongs to the client.
 *
 * The summary is never written from thin air. Facts are counted from the real
 * rows (tasks, weekly log, emails, follow-ups, websites) and only those facts
 * are handed to the AI. The counts it saw are saved next to the text and shown
 * underneath it, so anyone can check the words against the numbers. With no AI
 * key set, the same facts are turned into the same sections by plain code and
 * labelled COUNTED instead of AI-WRITTEN.
 */

const KIND_COLOR = {
  main: "blue",
  authority: "purple",
  landing: "pink",
  gbp: "green",
  directory: "yellow",
  review: "orange",
  social: "gray",
  other: "default",
};

/* ------------------------------------------------------------------ */
/* WHERE THIS CLIENT STANDS                                            */
/* ------------------------------------------------------------------ */

function whenText(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* liveCounts is what the page is showing RIGHT NOW. If it disagrees with the
 * counts the summary was written from, the summary is out of date and says so.
 * A stale summary that looks current is the one real danger of writing one at
 * all. */
export function StandingCard({ client, reloadClients, liveCounts }) {
  const saved = readSavedStanding(client);
  const [busy, setBusy] = useState(false);
  const [openFacts, setOpenFacts] = useState(false);
  const live = isConfigured();

  const write = async () => {
    setBusy(true);
    const res = live
      ? await apiFetch("/api/client-standing", { method: "POST", body: { clientId: client.id } })
      : await computeStandingPreview(client.id);
    setBusy(false);

    if (live) {
      if (!res.ok) { toast.error("Could not write the summary", res.error); return; }
      if (res.data?.saved === false) toast.warn("Written, but not saved", res.data.saveError || "");
      else toast.success("Summary updated", res.data?.source === "written" ? "Written by the AI from our own records." : "Counted from our own records.");
    } else {
      if (!res.ok) { toast.error("Could not write the summary", res.error); return; }
      toast.success("Summary updated", "Counted from the sample records.");
    }
    reloadClients();
  };

  if (!saved) {
    return (
      <div className="card adm-cp-standing empty">
        <div>
          <div className="label" style={{ marginBottom: 4 }}>Where this client stands</div>
          <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55, maxWidth: 620 }}>
            One short read: what has been finished for {client.name}, and what is still needed. Built by counting
            this client&apos;s tasks, weekly logs, emails and websites — never from guesses.
          </div>
        </div>
        <button className="btn btn-accent" onClick={write} disabled={busy}>{busy ? "Working..." : "Write it"}</button>
      </div>
    );
  }

  const { standing, facts, at, source } = saved;
  const c = facts?.counts;
  /* Staleness is judged on every count the page can see — totals AND status
   * breakdowns. Totals alone missed the most ordinary change there is: a task
   * moving from To do to Done, which changes no row count at all but makes the
   * headline ("1 done, 4 open") wrong. Only what actually changed is named:
   * "5 tasks then, 5 now" is noise, and noise in a warning gets it ignored. */
  const WATCHED = [
    ["tasksTotal", "tasks"],
    ["tasksDone", "tasks finished"],
    ["tasksOpen", "tasks still open"],
    ["tasksBlocked", "blocked tasks"],
    ["sites", "websites"],
    ["sitesLive", "live websites"],
    ["weeksTotal", "weekly logs"],
    ["weeksLogged", "weekly logs complete"],
    ["emails", "emails"],
    ["emailsNeedingReply", "emails needing a reply"],
    ["emailsWaitingOnThem", "emails waiting on them"],
  ];
  const changes = [];
  if (c && liveCounts) {
    for (const [key, label] of WATCHED) {
      const now = liveCounts[key];
      if (typeof now === "number" && typeof c[key] === "number" && now !== c[key]) {
        changes.push(`${label}: ${c[key]} then, ${now} now`);
      }
    }
  }
  const stale = changes.length > 0;

  return (
    <div className="card adm-cp-standing">
      <div className="adm-cp-standing-head">
        <div style={{ minWidth: 0 }}>
          <div className="label" style={{ marginBottom: 6 }}>Where this client stands</div>
          {standing.headline && <div className="adm-cp-headline">{standing.headline}</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <Chip
            label={source === "written" ? "AI-WRITTEN" : "COUNTED"}
            color={source === "written" ? "purple" : "default"}
            title={source === "written"
              ? "The AI wrote these words from the counted facts below — it was shown nothing else."
              : "No AI key set, so this was built straight from the counts below by plain code."}
          />
          <button className="btn btn-sm" onClick={write} disabled={busy}>{busy ? "Working..." : "Refresh"}</button>
        </div>
      </div>

      {stale && (
        <div className="adm-cp-stale">
          The records have changed since this was written ({changes.slice(0, 4).join(" · ")}
          {changes.length > 4 ? ` and ${changes.length - 4} more` : ""}). Press Refresh.
        </div>
      )}

      <div className="adm-cp-cols">
        <div>
          <div className="adm-cp-colhead done">Done</div>
          <ul className="adm-cp-list">
            {(standing.done || []).map((line, i) => <li key={i}>{line}</li>)}
            {!standing.done?.length && <li className="muted">Nothing recorded as finished.</li>}
          </ul>
        </div>
        <div>
          <div className="adm-cp-colhead needed">Still needed</div>
          <ul className="adm-cp-list">
            {(standing.needed || []).map((line, i) => <li key={i}>{line}</li>)}
            {!standing.needed?.length && <li className="muted">Nothing outstanding in the records.</li>}
          </ul>
        </div>
      </div>

      <div className="adm-cp-foot">
        <span>
          Built from {c ? `${c.tasksTotal} tasks, ${c.weeksTotal} weekly logs, ${c.emails} emails, ${c.sites} websites` : "this client's records"}
          {" · "}{whenText(at)}
        </span>
        {facts && (
          <button className="adm-cp-link" onClick={() => setOpenFacts(true)}>
            Check the numbers
          </button>
        )}
      </div>

      {openFacts && facts && (
        <Modal open onClose={() => setOpenFacts(false)} kicker="THE FACTS IT WAS WRITTEN FROM" title={`${client.name} — counted records`} width={720}>
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 12 }}>
            These are the exact counts and lines the summary was built from, taken at {whenText(at)}. Nothing else
            was used. If a claim above is not backed by something here, it does not belong in the summary.
          </p>
          <div className="adm-cp-facts">
            {Object.entries(facts.counts || {}).map(([k, v]) => (
              <div key={k} className="adm-cp-fact">
                <span className="adm-cp-factn">{v}</span>
                <span className="adm-cp-factk">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
              </div>
            ))}
          </div>
          <pre className="adm-cp-raw">{JSON.stringify({ client: facts.client, done: facts.done, open: facts.open, blocked: facts.blocked, weeks: facts.weeks, sites: facts.sites, emailsOpen: facts.emailsOpen, lastContact: facts.lastContact }, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* WEBSITES                                                            */
/* ------------------------------------------------------------------ */

export function SitesPanel({ client, sites, reload }) {
  const [modal, setModal] = useState(null); // {} = new, row = edit
  const live = isConfigured();

  const hasMain = sites.some((s) => s.kind === "main");

  const setLive = async (site, isLive) => {
    const res = await upsertClientSite({ id: site.id, live: isLive });
    if (!res.ok) { toast.error("Could not change that", res.error); return; }
    reload();
  };

  const remove = async (site) => {
    if (!window.confirm(`Remove "${site.label}" from ${client.name}? The website itself is untouched — this only removes the link from this page.`)) return;
    const res = await deleteClientSite(site.id);
    if (!res.ok) { toast.error("Could not remove it", res.error); return; }
    toast.success("Removed", site.label);
    reload();
  };

  const addMainFromDomain = async () => {
    const res = await upsertClientSite({
      client_id: client.id, kind: "main", label: "Main site",
      url: normalizeUrl(client.domain), live: true, sort: 0,
    });
    if (!res.ok) { toast.error("Could not add it", res.error); return; }
    toast.success("Main website added", prettyUrl(normalizeUrl(client.domain)));
    reload();
  };

  /* Main site first, then the sites we built, then everything else — the order
   * someone actually asks about them in. */
  const order = (s) => SITE_KINDS.indexOf(s.kind);
  const rows = [...sites].sort((a, b) => order(a) - order(b) || (a.sort || 0) - (b.sort || 0) || String(a.label).localeCompare(String(b.label)));

  return (
    <>
      <div className="card adm-cp-sitesbar">
        <div style={{ minWidth: 0 }}>
          <div className="label" style={{ marginBottom: 4 }}>Websites</div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
            {sites.length ? `${sites.length} on file · ${sites.filter((s) => s.live !== false).length} live` : "Nothing on file yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!hasMain && client.domain && (
            <button className="btn" onClick={addMainFromDomain}>Add their main site ({prettyUrl(client.domain)})</button>
          )}
          <button className="btn btn-accent" onClick={() => setModal({})}>Add a website</button>
          <SourceBadge mode={live ? "live" : "sample"} />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="&#127760;"
          title="No websites on file"
          body="Put their main website here, plus every ranking site we build for them, their Google Business Profile and any listing worth checking. This is the list you open when someone asks 'what do they actually have?'"
          action={<button className="btn btn-accent" onClick={() => setModal({})}>Add the first one</button>}
        />
      ) : (
        <div className="card adm-cp-sites">
          {rows.map((s) => (
            <div key={s.id} className="adm-cp-site">
              <div className="adm-cp-site-main">
                <div className="adm-cp-site-top">
                  <Chip label={SITE_KIND_LABELS[s.kind] || s.kind} color={KIND_COLOR[s.kind] || "default"} title={SITE_KIND_HELP[s.kind]} />
                  <span className="adm-cp-site-label">{s.label}</span>
                  {s.live === false && <Chip label="NOT LIVE" color="red" title="Built, but not published yet." />}
                </div>
                <a className="adm-cp-site-url" href={normalizeUrl(s.url)} target="_blank" rel="noopener noreferrer">
                  {prettyUrl(s.url)}
                </a>
                {s.notes && <div className="adm-cp-site-notes">{s.notes}</div>}
              </div>
              <div className="adm-cp-site-actions">
                <button className="btn btn-sm" onClick={() => setLive(s, s.live === false)}>
                  {s.live === false ? "Mark live" : "Mark not live"}
                </button>
                <button className="btn btn-sm" onClick={() => setModal(s)}>Edit</button>
                <button className="btn btn-sm" style={{ color: "var(--danger)" }} onClick={() => remove(s)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <SiteModal
          client={client} site={modal.id ? modal : null} nextSort={rows.length}
          onClose={() => setModal(null)} reload={reload}
        />
      )}
    </>
  );
}

function SiteModal({ client, site, nextSort, onClose, reload }) {
  const [f, setF] = useState({
    kind: site?.kind || "authority",
    label: site?.label || "",
    url: site?.url || "",
    live: site?.live !== false,
    notes: site?.notes || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const save = async () => {
    const label = f.label.trim();
    const url = normalizeUrl(f.url);
    if (!label) { toast.warn("Give it a name", "Something you would recognise in a list."); return; }
    if (!url || !/^https?:\/\/[^\s.]+\.[^\s]+$/.test(url)) { toast.warn("Check the web address", "It needs a dot in it, like example.com."); return; }
    setBusy(true);
    const res = await upsertClientSite({
      ...(site ? { id: site.id } : { client_id: client.id, sort: nextSort }),
      kind: f.kind, label, url, live: Boolean(f.live), notes: f.notes.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { toast.error("Could not save it", res.error); return; }
    toast.success(site ? "Website updated" : "Website added", label);
    onClose();
    reload();
  };

  return (
    <Modal
      open onClose={onClose} kicker={client.name.toUpperCase()} title={site ? "Edit website" : "Add a website"} width={560}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? "Saving..." : "Save"}</button>
      </>}
    >
      <Field label="What kind of site is it?" hint={SITE_KIND_HELP[f.kind]}>
        <Select value={f.kind} onChange={set("kind")} options={SITE_KINDS.map((k) => [k, SITE_KIND_LABELS[k]])} />
      </Field>
      <Field label="Name" hint="What you would call it out loud. Example: Florida Injury Claim Guide.">
        <TextInput value={f.label} onChange={set("label")} placeholder="Main site" />
      </Field>
      <Field label="Web address" hint="Paste it in. If you leave off https:// it gets added for you.">
        <TextInput value={f.url} onChange={set("url")} placeholder="example.com" />
      </Field>
      <label className="adm-inbox-check" style={{ marginBottom: 14 }}>
        <input type="checkbox" checked={f.live} onChange={(e) => setF((cur) => ({ ...cur, live: e.target.checked }))} />
        It is live and anyone can open it
      </label>
      <Field label="Notes (optional)" hint="Why it exists, what it is waiting on. Passwords never go here — a Bitwarden link only.">
        <TextArea value={f.notes} onChange={set("notes")} style={{ minHeight: 70 }} />
      </Field>
    </Modal>
  );
}

/* ==================================================================== */
/* THE WHOLE STORY OF THIS CLIENT — every record we hold, in order      */
/* ==================================================================== */
/* Added Aug 25 2026 as "How they started", which showed only the sales side.
 * Turned into the client's whole timeline Aug 26 2026. Ryder: "a timeline of
 * the client from creation to now, with everything we have done, with dates."
 *
 * A client page used to begin on the day the money started. Everything before
 * it — who rang them, how many times, what nearly lost it — was on the Sales
 * page behind a link nothing wrote (migration 0015 writes it now). Everything
 * AFTER it was scattered across six tabs, so nobody could read the job as one
 * thing. This reads all of it and prints one list, oldest at the top, because
 * it is a story and a story reads forward.
 *
 * The merging is not in here. It is in src/lib/clientTimeline.js, which is
 * plain functions with a test suite, because the rules it holds are the quiet
 * kind that break without anything looking broken. This file only fetches and
 * draws.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not print zero when it could not read. A section we failed to read
 * and a section with nothing in it look identical once both are counted as 0,
 * and they mean opposite things. Failed reads are named, with the reason, above
 * the list.
 *
 * It will not let a thin list mean "we did nothing". The line at the top says
 * when our records BEGIN. Work done for a client we took on before this console
 * existed is in no row this code can read, and an old client with four events
 * must not read as an old client we ignored.
 *
 * It will not let two kinds of fact read alike. Every row is stamped with the
 * record it came from — "sales call", "weekly log", "task" — because a phone
 * call somebody logged and a week of work somebody wrote up are not the same
 * sort of claim.
 */
export function SalesHistoryPanel({ client, teamName = () => null }) {
  /* Pulled apart rather than passed whole. The effect below only needs these
     four fields, and depending on the object itself would re-read every record
     for the client each time the parent re-rendered. */
  const { id: clientId, name: clientName, created_at: clientCreatedAt, start_date: clientStartDate } = client;
  const [state, setState] = useState({ loading: true, tl: null, contacts: [], crashed: null });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, tl: null, contacts: [], crashed: null });

    (async () => {
      /* The contacts read comes FIRST and alone. Calls and emails are read one
         lead at a time (listLeadActivity takes a single lead id), so there is
         no way to ask for them until we know who is at this firm. */
      const contacts = await listClientContacts(clientId);
      const ids = (contacts.rows || []).map((r) => r.id);

      const [acts, tasks, sites, weekly, reports, connections, vault] = await Promise.all([
        Promise.all(ids.map((id) => listLeadActivity(id))),
        listTasks(clientId),
        listClientSites(clientId),
        listWeekly(clientId),
        listClientReports(clientId),
        listClientConnections(clientId),
        listVaultItems(clientId),
      ]);

      /* Keyed by lead id, so a person whose log failed to read stays told apart
         from a person with an empty log. A flat array would lose that. */
      const activityByContact = {};
      ids.forEach((id, i) => { activityByContact[id] = acts[i]; });

      if (!alive) return;
      setState({
        loading: false,
        contacts: contacts.rows || [],
        crashed: null,
        tl: buildTimeline({
          client: { id: clientId, name: clientName, created_at: clientCreatedAt, start_date: clientStartDate },
          contacts, activityByContact, tasks, sites, weekly, reports, connections, vault,
        }),
      });
    })().catch((e) => {
      /* A thrown error is different from a reader answering `{ error }`: it
         means the whole load stopped part-way, so we know nothing about any
         section and must not draw a list at all. */
      if (alive) setState({ loading: false, tl: null, contacts: [], crashed: e?.message || String(e) });
    });

    return () => { alive = false; };
  }, [clientId, clientName, clientCreatedAt, clientStartDate]);

  if (state.loading) return <div className="adm-sl-loading">Reading everything we have on this client…</div>;

  if (state.crashed) {
    return (
      <div className="card adm-cp-saleshist">
        <strong>The timeline could not be built.</strong>
        <p>
          {state.crashed} The load stopped part-way, so nothing is shown rather than half of it —
          this is not the same as saying there is nothing to show.
        </p>
      </div>
    );
  }

  const tl = state.tl;
  const eventWord = tl.events.length === 1 ? "dated thing" : "dated things";
  /* Aug 26 2026: EVERY SENTENCE BELOW TURNS ON THIS. Something we could not
     read is unknown, and an unknown printed as a number is a lie whichever
     number is chosen. So nothing here states a total, a cause, or a start date
     without first checking whether all eight reads actually worked. */
  const someUnread = tl.unknown.length > 0;

  return (
    <div className="card adm-cp-saleshist">
      <div className="adm-cp-saleshist-head">
        <strong>
          {/* With a failed read the true total is not known, so it is not
              printed. With SOME events and a failed read we know a floor and
              nothing more, which is what "at least" says. Printing a bare count
              in either case reported an unknown as a measurement. */}
          {someUnread
            ? (tl.events.length
              ? `At least ${tl.events.length} ${eventWord} we wrote down about ${clientName || "this client"}`
              : `We could not read part of the record for ${clientName || "this client"}, so how many dated things we hold is not known`)
            : `${tl.events.length} ${eventWord} we wrote down about ${clientName || "this client"}`}
        </strong>
        {/* NOT "everything we did for them". This counts ROWS WE HOLD. Work
            nobody wrote down is not in any of these tables and this panel has
            no way to know it happened.

            Both numbers below come from tl.kinds, which counts the eight kinds
            of record once each. They used to be counted two different ways —
            distinct source words for the first, one entry per failed read for
            the second — so the page could say "read from 2 kinds of record, 5
            of them could not be read". Same denominator now, so it cannot. */}
        <span>
          Read from {tl.kinds.read} of the {tl.kinds.total} kinds of record we hold on a client
          {tl.kinds.read > 0 ? `: ${joinWords(tl.kinds.readLabels)}.` : "."}
          {tl.kinds.failed > 0
            ? ` ${tl.kinds.failed} of the ${tl.kinds.total} could not be read — ${tl.kinds.failed === 1 ? "that one is unknown, not empty, and it is" : "those are unknown, not empty, and they are"} named below.`
            : ""}
        </span>
        <div style={{ marginTop: 8 }}><SourceBadge mode={tl.sample ? "sample" : "live"} /></div>
      </div>

      {/* Ryder asked for this line by name. Absence of a record is not evidence
          that nothing happened, and on an old client it usually is not. */}
      <div className="adm-tl-begin">
        {tl.recordsBegin && !tl.recordsBeginIsFloor ? (
          <>
            Our records for this client begin on <strong>{prettyDay(tl.recordsBegin)}</strong>. Anything
            before that was not written down here.
          </>
        ) : tl.recordsBegin ? (
          /* A read came back full, so the oldest row we have is only the oldest
             row we LOADED. This line used to name that date as the day our
             records begin, which for a contact with 250 logged calls named a
             day in April while fifty January calls sat unread. The date still
             shows — a list with no stated floor is its own kind of lie — but it
             is now described as where the read started. */
          <>
            The list below starts on <strong>{prettyDay(tl.recordsBegin)}</strong>. That is where the
            read started, not where our records start: {joinWords(tl.capped.map((c) => c.source))} came
            back holding every row it was allowed to load, so there may be older rows nobody fetched.
            Until that read can say whether it saw everything, we cannot say when our records begin.
          </>
        ) : someUnread ? (
          <>
            We cannot say when our records for this client begin, because part of what we hold could
            not be read. That is not the same as nothing having happened, and it is not the same as
            nothing having been written down — the reads that failed are named below.
          </>
        ) : (
          <>
            We hold no dated record for this client yet. Every read worked and every one came back
            empty, so nothing about them has been written down in this console.
          </>
        )}
      </div>

      {tl.unknown.length > 0 ? (
        <div className="adm-tl-unknown">
          <strong>Part of the record could not be read, so it is unknown — not empty.</strong>
          <ul>
            {/* Indexed key: two contacts at a firm can share a name, so the
                source words alone are not unique. */}
            {tl.unknown.map((u, i) => (
              <li key={`${u.source}-${i}`}><b>{u.source}:</b> {u.why}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Carried over word for word in meaning from the old panel: a read that
          fell back to the narrow query, or hit its row cap, gives a list that
          is real but short. Saying so HERE, above the list, is the point — the
          first version of the old panel showed this only when it had rows, so
          the one case where it mattered most threw the caveat away. */}
      {tl.caveats.map((c, i) => (
        <div className="adm-cp-saleshist-warn" key={`${c.source}-${i}`}><b>{c.source}:</b> {c.note}</div>
      ))}

      {tl.notes.map((n) => (
        <div className="adm-tl-note" key={n}>{n}</div>
      ))}

      {tl.events.length ? (
        <ol className="adm-tl-list">
          {tl.events.map((e) => (
            <li key={e.key} className="adm-tl-row">
              <span className="adm-tl-when">{prettyDay(e.ymd)}</span>
              {/* The source is never optional and never abbreviated. It is the
                  only thing telling the reader whether they are looking at a
                  logged phone call or a week somebody wrote up. */}
              <span className="adm-tl-src">{e.source}</span>
              <span className="adm-tl-what">
                {e.title}
                {e.detail ? <span className="adm-tl-detail">{e.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="adm-tl-note">
          {someUnread ? (
            /* It used to tell the reader to go and add a task when the real
               problem was that we could not read the tasks they already have. */
            <>
              Part of what we hold about this client could not be read, so there is no story to print.
              This is not an empty history — until those reads work, what is there is unknown. The
              reads that failed are named above.
            </>
          ) : (
            <>
              Nothing we hold about this client carries a date we can read, so there is no story to
              print yet. Adding a task, a website or a weekly entry starts one.
            </>
          )}
        </div>
      )}

      {tl.undated.length ? (
        <div className="adm-tl-undated">
          <strong>True, but we cannot say when</strong>
          <p>
            These are real facts from the same records. Nothing on the row says what day they
            happened, and a guessed date in the list above would be worse than this list.
          </p>
          <ul>
            {tl.undated.map((u) => (
              <li key={u.key}>
                <span className="adm-tl-src">{u.source}</span> {u.title}
                {u.why ? <span className="adm-tl-detail">Why there is no date: {u.why}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* THE SALES SIDE, kept as its own short list under the story.
          Two reasons it did not just dissolve into the timeline. One: the ★ and
          the link into each person's full Sales timeline are the fastest way
          into the detail, and a flat list of events has nowhere to put them.
          Two: the "no sales record is linked" guidance below is still the most
          useful sentence on this tab for a client whose firm was never joined,
          and it only makes sense next to the people. */}
      <div className="adm-tl-sub">
        {tl.sales.state === "unknown" ? (
          <>
            <strong>The sales side could not be read.</strong>
            <p>
              Nothing above is counted from it. That is not the same as saying there is none — see
              the reason in the unknown list at the top.
            </p>
          </>
        ) : tl.sales.state === "none" ? (
          <>
            <strong>No sales record is linked to this client.</strong>
            <p>
              Either they never went through the pipeline, or the firm in Sales has not been joined
              to this client record yet. Marking their deal <strong>Won</strong> on the Sales page
              links the two, and every call and email logged during the chase then joins the story
              above.
            </p>
          </>
        ) : (
          <>
            <strong>
              {state.contacts.length} {state.contacts.length === 1 ? "person" : "people"} on record at this firm
            </strong>
            {/* NOT "came through the sales pipeline". This is everyone we hold
                at the firm linked to this client, which includes contacts added
                by hand and contacts nobody ever worked. Saying they all came
                through the pipeline counted three dead rows as three sales
                conversations. */}
            <p>
              Everyone we hold at the firm, worked or not. A star marks a contact whose own deal
              closed — migration 0015 lets more than one person at a firm close their own, so there
              can be several.
            </p>
            <ul className="adm-cp-saleshist-list">
              {state.contacts.map((r) => (
                <li key={r.id}>
                  <a href={`#/dashboard/sales?lead=${r.id}`} title="Open their whole timeline in Sales">
                    <span className="adm-cp-sh-name">
                      {r.name || "unnamed contact"}
                      {r.became_customer ? <span className="adm-cp-sh-star" title="This contact closed a deal">★</span> : null}
                    </span>
                    <span className="adm-cp-sh-title">{r.title || "no job title on file"}</span>
                    <span className="adm-cp-sh-meta">
                      {r.owner_id ? `worked by ${teamName(r.owner_id) || "someone"}` : "nobody claimed them"}
                      {/* "first contact", not "first spoken to": that date is set
                          by a logged email or LinkedIn message as well as a
                          call. And "no first-contact date", not "never
                          contacted" — nothing here can know that. */}
                      {r.first_contact_at ? " · has a first-contact date" : " · no first-contact date"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
