/* TAGS ON A LEAD — reading the event log, and working out what to write.
 *
 * PURE. No imports beyond the rules file, no database, no fetch, no clock of its
 * own. Same reason lib/sales-rules.js is pure: several callers need identical
 * answers and must never disagree.
 *
 * WHO ACTUALLY CALLS IT TODAY, rather than who should: the Floor's chips and
 * filters, the tag history in the drawer, and the per-lead "Bring the automatic
 * tags up to date" button. An earlier version of this line also named "the import
 * that tags a fresh sheet, and the overnight sweep" — NEITHER EXISTS.
 * api/sales-sweep.js has no tag code in it (and is not scheduled anyway), and
 * lib/sales-import.js writes no tag events. So on a fresh database every lead
 * starts untagged and the tag filters return nothing until somebody presses that
 * button on those rows. It is a real gap; the two places it belongs are the sweep
 * and the import. Corrected after a review, Aug 27 2026.
 *
 * THE MODEL, AND WHY IT LOOKS LIKE THIS
 *
 * There is no `tags` column on a lead and no `current` flag on an event. A
 * lead's tags right now are worked out by replaying its events:
 *
 *     added medspa       Aug 26 11:02   import
 *     added quiet        Aug 24 06:00   auto    "7 days with no update"
 *     removed quiet      Aug 25 14:12   auto    "she replied"
 *     -> on right now:   medspa
 *
 * A current-state column and an event log are two copies of one fact, and the
 * day they disagree there is no way to tell which is right. The console has
 * already paid for that twice — see §42 PART 2 on stored totals. The event list
 * is also, for free, exactly the dated history Ryder asked to be able to read on
 * the lead, which a state column could not give at all.
 *
 * THE ONE RULE THAT MAKES AUTOMATIC TAGS BEARABLE
 *
 * An automatic rule never puts back a tag a person took off by hand. That is not
 * a flag on a row — it falls out of the event log: if the NEWEST event for a tag
 * is a removal by a person, the rules leave it alone. So "stop telling me this
 * one is quiet" is a thing a rep can actually do, and nothing has to remember it
 * separately.
 */

import { autoTagState } from "./sales-rules.js";

/* ------------------------------------------------------------------ */
/* Reading the log                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sort events oldest first, deterministically.
 *
 * `at` alone is not enough: an import writes several events in the same
 * statement and Postgres gives them all the same `now()`, so ties are real and
 * common. Falling back to the id keeps the answer stable between two reads of
 * the same rows — without it, "which tag won" could flip between page loads and
 * nobody could reproduce it.
 */
function inOrder(events) {
  /* PARSED, NOT COMPARED AS STRINGS.
   *
   * Two ISO strings for the same instant can be written differently — a `Z`
   * suffix against a `+00:00` offset, fractional seconds against none — and
   * `"...:00.5Z" < "...:00Z"` is true as text while being false in time. Today
   * PostgREST returns offsets and every sample row comes from toISOString(), so
   * the string comparison happened to agree; the SQL view orders by a real
   * timestamptz, so the two would have disagreed the first time a differently
   * shaped string reached this function. Parsing costs nothing. Found by a
   * reviewer, Aug 27 2026.
   *
   * An unreadable date sorts FIRST rather than crashing or being dropped: it is
   * still a record of something that happened, and the panel that prints it says
   * the date could not be read. */
  const ms = (e) => {
    const t = Date.parse(e?.at);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...(events || [])].sort((a, b) => {
    const at = ms(a);
    const bt = ms(b);
    if (at !== bt) return at < bt ? -1 : 1;
    /* Ties are ordinary, not rare: an import writes several events in one
     * statement and Postgres gives them all the same now(). Without the id the
     * answer could flip between two reads of the same rows, and nobody could
     * reproduce the complaint. */
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

/**
 * The newest event per tag for one lead, whatever it was.
 *
 * Keyed on `tag_id`, which is what the rows actually carry. `slugOf` turns an id
 * into a slug where the vocabulary is known; a tag id with no row in the
 * vocabulary is kept under its id rather than dropped, because an event pointing
 * at a tag somebody deactivated is still a record of something that happened.
 */
export function latestPerTag(events) {
  const out = new Map();
  for (const e of inOrder(events)) {
    if (!e?.tag_id) continue;
    out.set(e.tag_id, e);
  }
  return out;
}

/**
 * Which tags are on this lead right now.
 *
 * Returns an array of `{ tag_id, slug, at, by, source, why }`, one per tag whose
 * newest event is an `added`. Ordered by the vocabulary's own `sort` where it is
 * known, so two rows on the Floor never show the same tags in a different order.
 *
 * `tagsById` is the vocabulary, `Map<tag_id, {slug,label,color,tag_group,sort}>`.
 */
export function currentTags(events, tagsById) {
  const latest = latestPerTag(events);
  const out = [];
  for (const [tagId, e] of latest) {
    if (e.action !== "added") continue;
    const tag = tagsById?.get(tagId) || null;
    out.push({
      tag_id: tagId,
      slug: tag?.slug || null,
      label: tag?.label || tag?.slug || "unknown tag",
      color: tag?.color || "default",
      tag_group: tag?.tag_group || null,
      sort: Number.isFinite(Number(tag?.sort)) ? Number(tag.sort) : Number.MAX_SAFE_INTEGER,
      at: e.at || null,
      by: e.by || null,
      source: e.source || null,
      why: e.why || null,
    });
  }
  out.sort((a, b) => (a.sort - b.sort) || String(a.label).localeCompare(String(b.label)));
  return out;
}

/** Just the slugs on this lead, as a Set. What the filters compare against. */
export function currentSlugs(events, tagsById) {
  return new Set(currentTags(events, tagsById).map((t) => t.slug).filter(Boolean));
}

/**
 * Group a flat list of events by lead, so one read of the table serves the whole
 * board. Returns `Map<lead_id, event[]>`.
 */
export function eventsByLead(events) {
  const out = new Map();
  for (const e of events || []) {
    if (!e?.lead_id) continue;
    if (!out.has(e.lead_id)) out.set(e.lead_id, []);
    out.get(e.lead_id).push(e);
  }
  return out;
}

/**
 * The history panel: every add and every remove, newest first, in words.
 *
 * `teamName` turns a user id into a name. A null `by` is the system — printed as
 * "automatic" rather than as a person, because pretending a rule was somebody is
 * worse than saying nobody.
 */
export function tagHistory(events, tagsById, { teamName = null } = {}) {
  return inOrder(events).reverse().map((e) => {
    const tag = tagsById?.get(e.tag_id) || null;
    const who = e.by ? (teamName ? teamName(e.by) || "someone" : "someone") : "automatic";
    return {
      id: e.id,
      at: e.at || null,
      action: e.action,
      slug: tag?.slug || null,
      label: tag?.label || tag?.slug || "unknown tag",
      by: e.by || null,
      who,
      source: e.source || null,
      why: e.why || null,
      /* One sentence, built here rather than in the component, so the drawer and
       * anything else that prints this history read identically. */
      line: `${tag?.label || tag?.slug || "a tag"} ${e.action === "added" ? "added" : "removed"} — ${e.source === "auto" ? "automatic" : who}${e.why ? `, ${e.why}` : ""}`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Working out what to write                                           */
/* ------------------------------------------------------------------ */

/** Was the newest event for this tag a removal somebody did by hand? */
export function removedByHand(events, tagId) {
  const e = latestPerTag(events).get(tagId);
  return Boolean(e && e.action === "removed" && e.source === "person");
}

/**
 * Was the newest event for this tag an ADD somebody did by hand?
 *
 * THE OTHER HALF OF THE SAME RULE, and it was missing. `removedByHand` stopped a
 * rule putting back a tag a person took off; nothing stopped a rule TAKING OFF a
 * tag a person put on. Every state tag is owned unconditionally by the rules, so:
 * a rep gets a call, opens the record and tags the firm "Replied" by hand;
 * anybody then presses "Bring the automatic tags up to date"; the tag is gone and
 * the dated line reads "Replied removed — the rule that added it no longer
 * applies". No rule added it. And the line cannot be corrected, only annotated,
 * because these records are append-only.
 *
 * Found by an adversarial review, Aug 27 2026. The header of this file already
 * claimed the rule in both directions; only one direction was written.
 */
export function addedByHand(events, tagId) {
  const e = latestPerTag(events).get(tagId);
  return Boolean(e && e.action === "added" && e.source === "person");
}

/**
 * What the automatic rules would change on this lead — as events to write, not
 * as writes.
 *
 * Returns `{ add: [{ tag_id, slug, why }], remove: [{ tag_id, slug, why }] }`,
 * both possibly empty. The caller does the writing, in ONE function that also
 * puts the line on the timeline — see setLeadTag in src/lib/data.js.
 *
 * `tagsBySlug` is the vocabulary keyed the other way. A slug the vocabulary does
 * not hold is SKIPPED and counted in `unknown` rather than guessed at: writing
 * an event needs a real tag id, and inventing one would break the foreign key at
 * best and point at the wrong tag at worst.
 *
 * A tag the rules do not own is never touched. A tag a person removed by hand is
 * never put back.
 */
export function autoTagPlan(lead, {
  company = null, touchCount = 0, now, events = [], tagsBySlug = new Map(), tagsById = new Map(),
} = {}) {
  const { want, owns } = autoTagState(lead, { company, touchCount, now });
  const on = currentSlugs(events, tagsById);
  const add = [];
  const remove = [];
  const unknown = [];

  for (const [slug, why] of want) {
    const tag = tagsBySlug.get(slug);
    if (!tag) { unknown.push(slug); continue; }
    if (on.has(slug)) continue;
    if (removedByHand(events, tag.id)) continue;
    add.push({ tag_id: tag.id, slug, why });
  }

  for (const slug of owns) {
    if (want.has(slug)) continue;
    if (!on.has(slug)) continue;
    const tag = tagsBySlug.get(slug);
    if (!tag) { unknown.push(slug); continue; }
    /* A TAG A PERSON PUT ON IS NEVER TAKEN OFF BY A RULE. See addedByHand above
     * for the click sequence this stops. The two guards are deliberately
     * separate functions rather than one "touchedByHand": the reasons differ, and
     * a single check would also have stopped a rule re-adding a tag the SYSTEM
     * had removed, which it should. */
    if (addedByHand(events, tag.id)) continue;
    /* A removal is written by the rules, so `source` is 'auto' and `why` says
     * which rule stopped applying. "quiet removed" with no reason next to it is
     * the kind of line that makes a timeline unreadable. */
    remove.push({ tag_id: tag.id, slug, why: "the rule that added it no longer applies" });
  }

  return { add, remove, unknown: [...new Set(unknown)] };
}

/**
 * The vocabulary, both ways round, from the rows the board read.
 *
 * Deactivated tags are kept in `byId` and left OUT of `bySlug`. That split is
 * the whole point: a switched-off tag must still be readable on the leads that
 * carry it (byId, for the chips and the history) and must not be offered or
 * auto-applied any more (bySlug, which is what the rules look in).
 */
export function tagIndex(rows) {
  const byId = new Map();
  const bySlug = new Map();
  for (const t of rows || []) {
    if (!t?.id) continue;
    byId.set(t.id, t);
    if (t.active !== false && t.slug) bySlug.set(t.slug, t);
  }
  return { byId, bySlug };
}

/**
 * How many leads carry each tag, across the rows given.
 *
 * Counted from the UNFILTERED rows by every caller, for the same reason
 * facetValues() in src/lib/salesSheet.js is: a filter menu built from what is on
 * screen hides its own options, which was a real shipped bug on the Operations
 * table.
 */
export function tagCounts(leadIds, byLead, tagsById) {
  const counts = new Map();
  for (const id of leadIds || []) {
    for (const t of currentTags(byLead.get(id) || [], tagsById)) {
      if (!t.slug) continue;
      counts.set(t.slug, (counts.get(t.slug) || 0) + 1);
    }
  }
  return counts;
}
