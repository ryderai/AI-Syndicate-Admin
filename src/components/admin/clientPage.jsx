import { useState } from "react";
import { Modal, Field, TextInput, TextArea, Select, EmptyState, SourceBadge } from "./shared.jsx";
import { Chip } from "./opsCells.jsx";
import { toast } from "../../lib/toast.js";
import { apiFetch } from "../../lib/adminApi.js";
import { isConfigured } from "../../lib/supabase.js";
import {
  upsertClientSite, deleteClientSite, readSavedStanding, computeStandingPreview,
} from "../../lib/data.js";
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
