/* Getting CJ's outreach sheet in — and keeping the work already done in it.
 *
 * Pure functions, no database. The one import is the column reader beside
 * it, which is pure too. Same reason as lib/sales-rules.js:
 * the browser has to show a person exactly what an import WILL do before it
 * does it, and tests/sales/test.mjs pins every rule below against real rows
 * copied out of the actual sheet.
 *
 * THE THING THIS FILE IS REALLY FOR
 * An import that drops the six hand-filled columns is not an import, it is a
 * reset. Larry claimed 50 firms. Brandon claimed 51. Somebody typed the date
 * they first emailed. That work has to survive the move or nobody will make
 * the move. Every function below exists to carry one of those columns across
 * without guessing.
 *
 * WHAT THE SHEET ACTUALLY LOOKS LIKE (read Aug 21 2026)
 *   Tabs: "Rules of Engagement" + one per business type — Luxury Agents, Law
 *   Firm Marketing Directors, Medspas, Car Dealership, Jewelry, Dental
 *   Practices, and more past the tab arrow.
 *   Columns: six a human fills in, then the raw Apollo export.
 *   AND THE APOLLO COLUMNS ARE NOT THE SAME ON EVERY TAB — Luxury Agents has
 *   "# Employees" where Car Dealership has "Departments" and "Industry". So
 *   nothing here may assume a fixed layout. Every tab is mapped on its own.
 */

import { mapColumns } from "./sheet-columns.js";

/* ------------------------------------------------------------------ */
/* The fields a sales row can hold                                     */
/* ------------------------------------------------------------------ */

/** Everything the importer can map a column onto. `where` says whether the
 * value belongs to the PERSON or to the FIRM — that split is what stops the
 * sheet's habit of copying one website onto four rows and letting three go
 * stale. */
export const SALES_FIELDS = [
  { key: "first_name", label: "First name", where: "lead" },
  { key: "last_name", label: "Last name", where: "lead" },
  { key: "name", label: "Full name", where: "lead" },
  { key: "title", label: "Job title", where: "lead" },
  { key: "seniority", label: "Seniority", where: "lead" },
  { key: "department", label: "Department", where: "lead" },
  { key: "email", label: "Email", where: "lead" },
  { key: "phone", label: "Phone (direct)", where: "lead" },
  { key: "linkedin_url", label: "LinkedIn (person)", where: "lead" },
  { key: "city", label: "City (person)", where: "lead" },
  { key: "state", label: "State (person)", where: "lead" },

  { key: "company", label: "Company", where: "company" },
  { key: "domain", label: "Website", where: "company" },
  { key: "company_phone", label: "Phone (company)", where: "company" },
  { key: "company_address", label: "Address", where: "company" },
  { key: "company_city", label: "City (company)", where: "company" },
  { key: "company_state", label: "State (company)", where: "company" },
  { key: "company_country", label: "Country", where: "company" },
  { key: "company_linkedin_url", label: "LinkedIn (company)", where: "company" },
  { key: "facebook_url", label: "Facebook", where: "company" },
  { key: "twitter_url", label: "Twitter / X", where: "company" },
  { key: "vertical", label: "Industry", where: "company" },
  { key: "employees", label: "Employees", where: "company" },
  { key: "annual_revenue", label: "Annual revenue", where: "company" },
  { key: "site_score", label: "Site score", where: "company" },
  /* Added Aug 30 2026. Each of these was already being read off CJ's sheet
   * and then thrown away, because there was nowhere to put it. Migration 0025
   * gives each one a column. */
  { key: "address", label: "Location line (person)", where: "lead" },
  { key: "country", label: "Country (person)", where: "lead" },
  { key: "company_alias", label: "Company name for emails", where: "company" },
  { key: "keywords", label: "Keywords / technology", where: "company" },
  { key: "total_funding", label: "Total funding", where: "company" },

  { key: "sales_owner", label: "Sales owner (their name)", where: "work" },
  { key: "contacted", label: "Contacted?", where: "work" },
  { key: "status", label: "Sales cycle status", where: "work" },
  { key: "first_contact", label: "First contact date", where: "work" },
  { key: "last_touch", label: "Last touch date", where: "work" },
  { key: "next_step", label: "Next steps / notes", where: "work" },
  { key: "notes", label: "Notes", where: "work" },
];

export const SALES_FIELD_KEYS = SALES_FIELDS.map((f) => f.key);

/* ------------------------------------------------------------------ */
/* Matching a column heading                                           */
/* ------------------------------------------------------------------ */

/* Order matters — the FIRST match wins, so the specific patterns sit above the
 * general ones. "Company Linkedin Url" has to be tested before "Linkedin Url",
 * and "Company Phone" before "Phone", or every company column lands on the
 * person. That single ordering bug would have put a switchboard number on
 * four different people's direct-dial field. */
const HEADER_RULES = [
  ["company_linkedin_url", /^company\s*linkedin/i],
  ["company_address", /^company\s*(address|street)/i],
  ["company_city", /^company\s*city/i],
  ["company_state", /^company\s*(state|province)/i],
  ["company_country", /^company\s*country/i],
  ["company_phone", /^(company|corporate|main|office|switchboard)\s*phone/i],
  /* "Company Name for Emails" is Apollo's cleaned-up version of the same firm.
   * It used to be left unmapped, so that two columns could not both write
   * `company` — the second would silently overwrite the first and which one
   * won depended on column order.
   *
   * It now has a field of its own instead of being dropped. CJ's mail merge
   * uses this exact string, so without it the console cannot reproduce an
   * email he sent. It must stay ABOVE the plain "company" rule: the two
   * headings both start "Company Name" and the first match wins. */
  ["company_alias", /^company\s*name\s*for\s*e-?mails?$/i],
  ["company", /^company(\s*name)?$/i],
  ["company", /\b(business name|firm name|organi[sz]ation|account name|practice name|dba)\b/i],

  ["first_name", /^first\s*name$/i],
  ["last_name", /^last\s*name$/i],
  ["name", /^(full\s*name|contact\s*name|name|person)$/i],
  ["title", /^(title|job\s*title|position|role)$/i],
  ["seniority", /^seniority$/i],
  ["department", /^departments?$/i],
  ["email", /\b(e-?mail|email address|work email)\b/i],
  ["linkedin_url", /^(person\s*)?linkedin/i],

  ["site_score", /\b(site\s*score|ai\s*score|readiness\s*score)\b/i],
  // Above `annual_revenue`, or "Total Funding" never matches — the loose
  // revenue rule below has no anchor and would take it first.
  ["total_funding", /^total\s*funding$/i],
  ["annual_revenue", /\b(annual\s*revenue|revenue)\b/i],
  ["employees", /(#\s*employees|employee\s*count|headcount|number of employees|^employees$)/i],
  ["keywords", /^(keywords?|technologies|tech\s*stack)$/i],
  ["vertical", /^(industry|vertical|category|niche|sector|trade)$/i],
  ["domain", /^(website|web ?site|url|domain|site)$/i],
  ["facebook_url", /facebook/i],
  ["twitter_url", /(twitter|^x url$)/i],

  ["sales_owner", /^(sales\s*owner|owner|rep|assigned to|claimed by)$/i],
  ["contacted", /^contacted\??$/i],
  ["status", /^(sales\s*cycle\s*status|status|stage)$/i],
  ["first_contact", /^(first\s*contact|1st\s*contact|date\s*claimed)/i],
  ["last_touch", /^(last\s*touch|last\s*contact|last\s*activity)/i],
  ["next_step", /^(next\s*steps?|next\s*step\s*\/?\s*notes?)/i],
  ["notes", /^(notes?|comments?|remarks?|description)$/i],

  // Last, because these are the loosest. A heading that only says "phone",
  // "city" or "country" belongs to the person; the company versions were
  // caught above.
  ["phone", /\b(phone|tel|telephone|mobile|cell|direct)\b/i],
  ["city", /^(city|town|locality)$/i],
  ["state", /^(state|province|region)$/i],
  ["country", /^country$/i],
  ["address", /^(address|street|location)$/i],
];

/** A column heading → the field it should fill, or "" for leave it alone.
 *
 * "Keywords" is a 400-word blob of what the firm does and what its website
 * runs on. It used to match nothing here, so that a paragraph of "Facebook
 * Pixel, Varnish, jQuery" could not land in a rep's notes field. It now has a
 * column of its own on the FIRM (migration 0025) and is never rendered on a
 * row — kept, because it is the raw material for a first email, and thrown
 * away it cannot be got back without re-exporting from Apollo. */
export function guessSalesColumn(header) {
  const h = String(header ?? "").replace(/\s+/g, " ").trim();
  if (!h) return "";
  for (const [field, re] of HEADER_RULES) {
    if (re.test(h)) return field;
  }
  return "";
}

/** Guess a whole header row, and never let two columns fight over one field.
 * The first column to claim a field keeps it; later ones are left unmapped and
 * reported, so a person can point the second one somewhere sensible instead of
 * discovering later that it quietly overwrote the first. */
export function guessHeaderRow(headers) {
  const taken = new Set();
  const mapping = [];
  const clashes = [];
  (headers || []).forEach((h, i) => {
    const field = guessSalesColumn(h);
    if (!field) { mapping.push(""); return; }
    if (taken.has(field)) {
      mapping.push("");
      clashes.push({ index: i, header: String(h ?? ""), field });
      return;
    }
    taken.add(field);
    mapping.push(field);
  });
  return { mapping, clashes };
}

/* ------------------------------------------------------------------ */
/* Dates that were typed by hand                                       */
/* ------------------------------------------------------------------ */

/**
 * The sheet's date columns are free text, and they hold "8/11/26", "8/11/2026"
 * and "8/19/2026" — sometimes in the same column. This turns what can be read
 * into a real date and says so when it cannot.
 *
 * Returns { iso, ok, why }. It NEVER returns today's date as a fallback: a
 * made-up "first contact" date starts a real 14-day cold timer on a firm
 * nobody has actually rung.
 *
 * US order (month first) is assumed, and that assumption is stated on the
 * import screen rather than buried here. 3/4/2026 is genuinely ambiguous and
 * no amount of code can tell which the typist meant.
 */
export function parseSheetDate(value, { now = Date.now() } = {}) {
  if (value === null || value === undefined || value === "") return { iso: null, ok: true, why: "blank" };

  // Excel gives a date cell as a serial number: days since 30 Dec 1899.
  const asNum = typeof value === "number" ? value : (/^\d{4,5}(\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN);
  if (Number.isFinite(asNum) && asNum > 20000 && asNum < 60000) {
    const ms = Math.round((asNum - 25569) * 86400000);
    return { iso: new Date(ms).toISOString().slice(0, 10), ok: true, why: "excel date" };
  }

  const s = String(value).trim();

  /* An ISO-SHAPED string is not automatically a real date. This branch used to
   * return "2026-13-45" happily, which then reached Postgres as
   * `2026-13-45T12:00:00Z` and failed the whole insert with "date/time field
   * value out of range" — after earlier tabs had already been written. Round
   * trip it, exactly like the US branch below. */
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);   // anchored: "2026-08-1199" is not a date
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return { iso: null, ok: false, why: `"${s}" is not a real date` };
    }
    return { iso: `${iso[1]}-${iso[2]}-${iso[3]}`, ok: true, why: "already a date" };
  }

  /* One separator, used consistently. Matching them independently accepted
   * "8-11/26", which is a typo, not a date. */
  const us = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})$/.exec(s);
  if (us) {
    const m = Number(us[1]);
    const d = Number(us[3]);
    let y = Number(us[4]);
    if (us[4].length === 2) y = y <= 69 ? 2000 + y : 1900 + y;
    if (m < 1 || m > 12 || d < 1 || d > 31) {
      return { iso: null, ok: false, why: `"${s}" is not a real date` };
    }
    const dt = new Date(Date.UTC(y, m - 1, d));
    // Round-trip check: 2/31 parses happily into 3 March otherwise.
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      return { iso: null, ok: false, why: `"${s}" is not a real date` };
    }
    if (dt.getTime() > now + 86400000) {
      // Kept, but flagged. A future "last touch" is usually a typo in the
      // year, and silently accepting it makes a stale firm look fresh forever.
      return { iso: dt.toISOString().slice(0, 10), ok: false, why: `"${s}" is in the future — check the year` };
    }
    return { iso: dt.toISOString().slice(0, 10), ok: true, why: "read as month/day/year" };
  }

  return { iso: null, ok: false, why: `could not read "${s.slice(0, 30)}" as a date` };
}

/* ------------------------------------------------------------------ */
/* Two columns that say the same thing → one stage                     */
/* ------------------------------------------------------------------ */

/**
 * The sheet has "Contacted?" (Yes - Email / Yes - Email and Phone / No) AND
 * "Sales Cycle Status" (Contacted / Closed - Lost / Bad contact info / …).
 * They overlap, reps fill one or the other, and neither can be trusted alone.
 *
 * Status wins where it says something definite, because it is the more
 * specific of the two. "Contacted?" is used to catch the rows where somebody
 * ticked that they had emailed and never touched the status column — which in
 * the real sheet is most of them.
 */
export function stageFromSheet(contacted, status) {
  const st = String(status ?? "").toLowerCase().trim();
  const co = String(contacted ?? "").toLowerCase().trim();

  if (/skip|90\+/.test(st)) return { stage: "skip_90", note: "marked Skip – 90+ in the sheet" };
  if (/bad\s*(contact|info|number|email)/.test(st)) return { stage: "bad_contact", note: "marked bad contact info in the sheet" };
  if (/\bwon\b|closed\s*[-–—]?\s*won/.test(st)) return { stage: "won", note: "marked Won in the sheet" };
  if (/\blost\b|not a fit|closed\s*[-–—]?\s*lost/.test(st)) return { stage: "lost", note: "marked Lost in the sheet" };
  if (/reopen/.test(st)) return { stage: "reopened", note: "marked Reopened in the sheet" };
  if (/proposal/.test(st)) return { stage: "proposal", note: "at proposal in the sheet" };
  if (/meeting|booked|demo/.test(st)) return { stage: "meeting", note: "meeting booked per the sheet" };
  if (/follow|nurtur/.test(st)) return { stage: "follow_up", note: "following up per the sheet" };
  if (/replied|convers|engaged|interested/.test(st)) return { stage: "in_conversation", note: "in conversation per the sheet" };
  if (/contacted|reached/.test(st)) return { stage: "contacted", note: "marked Contacted in the sheet" };

  if (/^yes/.test(co)) return { stage: "contacted", note: `Contacted? said "${String(contacted).trim()}"` };
  if (/^no$/.test(co)) return { stage: "new", note: "Contacted? said No" };
  return { stage: "new", note: null };
}

/* ------------------------------------------------------------------ */
/* "Brandon R" is Brandon Roberts                                      */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

/**
 * A name typed into a spreadsheet → a real user account.
 *
 * The sheet holds "Brandon Roberts" and "Brandon R" on the same tab, plus
 * "Sawyer", "Troy" and "Andrew" with no surname at all. Getting this wrong in
 * either direction is expensive: an unmatched claim hands 50 worked firms back
 * to the floor, and a WRONG match gives one rep another rep's pipeline.
 *
 * So it is deliberately conservative, and it always says which rule fired:
 *   exact     — the full name matches.
 *   initial   — first name plus a last initial that only one person has.
 *   first     — a first name only ONE active member has.
 *   ambiguous — more than one person could be meant. Never guessed.
 *   unknown   — nobody close. The raw text is kept on the row either way.
 */
export function matchOwner(rawName, team) {
  const raw = String(rawName ?? "").trim();
  if (!raw) return { user_id: null, how: "blank", candidates: [] };

  const want = norm(raw);
  const people = (team || []).filter((t) => t.active !== false).map((t) => ({
    user_id: t.user_id,
    full: norm(t.full_name || t.email || ""),
    first: norm(t.full_name || "").split(" ")[0] || norm(String(t.email || "").split("@")[0]),
    last: (norm(t.full_name || "").split(" ")[1] || ""),
    label: t.full_name || t.email,
  }));

  const exact = people.filter((p) => p.full === want);
  if (exact.length === 1) return { user_id: exact[0].user_id, how: "exact", label: exact[0].label, candidates: [] };
  if (exact.length > 1) return { user_id: null, how: "ambiguous", candidates: exact.map((p) => p.label) };

  const parts = want.split(" ");
  const first = parts[0];
  const rest = parts.slice(1).join(" ");

  if (rest) {
    // "brandon r" → first name matches and the surname STARTS WITH what was typed.
    const initial = people.filter((p) => p.first === first && p.last && p.last.startsWith(rest));
    if (initial.length === 1) return { user_id: initial[0].user_id, how: "initial", label: initial[0].label, candidates: [] };
    if (initial.length > 1) return { user_id: null, how: "ambiguous", candidates: initial.map((p) => p.label) };
  }

  const byFirst = people.filter((p) => p.first === first);
  if (byFirst.length === 1) return { user_id: byFirst[0].user_id, how: "first", label: byFirst[0].label, candidates: [] };
  if (byFirst.length > 1) return { user_id: null, how: "ambiguous", candidates: byFirst.map((p) => p.label) };

  return { user_id: null, how: "unknown", candidates: [] };
}

/* ------------------------------------------------------------------ */
/* Rows → firms                                                        */
/* ------------------------------------------------------------------ */

/** A bare hostname: no scheme, no www, no path, no trailing slash or dot.
 *
 * Lower-casing alone was not enough and split real firms apart. Four Backbeat
 * Homes rows written as "https://www.backbeathomes.com", "backbeathomes.com",
 * "backbeathomes.com/" and a blank became FOUR firms — four site scores, four
 * headings, one office. Deliberately the same cleaning as
 * lib/lead-intake.js#cleanDomain and api/sales-score.js#cleanDomain, so a
 * website means the same thing everywhere it is compared. */
export function normaliseDomain(v) {
  let d = String(v ?? "").trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0].replace(/\.$/, "");
  if (!d.includes(".") || /\s/.test(d)) return null;
  return d;
}

/** Lower-cased, punctuation and spaces stripped. Kept character-for-character
 * identical to public.admin_company_name_key in migration 0009 — the same
 * two-copies-on-purpose deal as the lead dedupe key, and tests/sales/sql.sh
 * runs the same strings through both. */
export function companyKey(name) {
  const k = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return k || null;
}

/**
 * Fold rows onto firms. Domain first, then the folded name — a domain is a
 * far stronger signal than a name, and two firms called "Above & Beyond Real
 * Estate" in different states are genuinely two firms.
 *
 * Company facts are merged FIRST-NON-EMPTY-WINS rather than last: row 1 of
 * ACME already has the website, and letting row 4 overwrite it with a blank
 * is how a firm ends up with no site to score.
 */
export function groupIntoCompanies(rows) {
  const list = rows || [];

  /* ---- Deciding the key is a two-pass job, and one pass gets it wrong ----
   *
   * The obvious version keys a row on its domain, falling back to the folded
   * name. On the real sheet that splits firms in half: four Backbeat Homes
   * rows where one has a blank Website column become "backbeathomes.com" and
   * "backbeathomes" — two firms, so the site gets scored twice and a rep sees
   * the same office listed under two headings.
   *
   * Nor can the name simply win instead. The same sheet writes one firm as
   * "ACME | SERHANT." on one row and "ACME" on the next — different folded
   * names, same website — so a name-first rule splits that firm in two.
   *
   * The domain is the strong signal, so it decides wherever it exists. The
   * only question is what to do with a row whose Website cell is blank, and
   * the first pass below answers it: look at every OTHER row with the same
   * folded name.
   *   · exactly one domain among them → the blank row joins it. Backbeat.
   *   · more than one → the name is genuinely shared by different firms
   *     ("Above & Beyond Real Estate" exists in more than one state), so the
   *     blank row is NOT pushed into whichever firm happens to come first.
   *     Guessing there hands one firm's contacts to another.
   *
   * The honest limit, stated rather than described away: in that second case
   * the blank-domain rows are grouped WITH EACH OTHER, under the shared name.
   * They are not split one-per-row. So two blank rows for two different
   * "Above & Beyond" offices still land together — there is genuinely nothing
   * in the sheet that tells them apart. buildImportPlan reports it as a warning
   * so a person can look, rather than the code pretending it knew.
   */
  const domainsByName = new Map();
  for (const row of list) {
    const nk = companyKey(row.company);
    if (!nk) continue;
    const d = normaliseDomain(row.domain);
    if (!d) continue;
    if (!domainsByName.has(nk)) domainsByName.set(nk, new Set());
    domainsByName.get(nk).add(d);
  }

  const keyFor = (row) => {
    const d = normaliseDomain(row.domain);
    if (d) return `d:${d}`;                       // a website always decides
    const nk = companyKey(row.company);
    if (!nk) return null;                         // no website and no name: on its own
    const seen = domainsByName.get(nk);
    if (seen && seen.size === 1) return `d:${[...seen][0]}`;   // the blank row joins its firm
    return `n:${nk}`;                             // ambiguous or nobody has a website
  };

  const byKey = new Map();
  const out = [];
  for (const row of list) {
    const key = keyFor(row);
    const nk = companyKey(row.company);
    if (!key) { out.push({ ...row, __company: null }); continue; }

    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: row.company || row.domain || "Unnamed firm",
        name_key: nk,
        domain: normaliseDomain(row.domain),
        phone: row.company_phone || null,
        address: row.company_address || null,
        city: row.company_city || row.city || null,
        state: row.company_state || row.state || null,
        country: row.company_country || null,
        vertical: row.vertical || null,
        alias: row.company_alias || null,
        keywords: row.keywords || null,
        employees: toInt(row.employees),
        annual_revenue: toInt(row.annual_revenue),
        total_funding: toInt(row.total_funding),
        linkedin_url: row.company_linkedin_url || null,
        facebook_url: row.facebook_url || null,
        twitter_url: row.twitter_url || null,
        /* THE SCORE IS NEVER TAKEN FROM A SPREADSHEET.
         *
         * mergeCompany deletes site_score from every update with the comment
         * "the score is ours, measured by us" — and then the first import of a
         * firm wrote it straight from a cell anyway. A number that came out of
         * a spreadsheet and a number our own scanner measured must never be
         * the same field, or a report cannot say which it is quoting. Left
         * here as null on purpose; the Site Score column is read and reported,
         * it just does not land. Found 30 Aug 2026 by an adversarial
         * reviewer. */
        site_score: null,
        site_score_from_sheet: toScore(row.site_score),
        contacts: 0,
      });
    }
    const c = byKey.get(key);
    c.contacts += 1;
    // First non-empty wins, per the note above.
    for (const [f, v] of [
      ["domain", normaliseDomain(row.domain)], ["phone", row.company_phone], ["address", row.company_address],
      ["city", row.company_city], ["state", row.company_state], ["country", row.company_country],
      ["vertical", row.vertical], ["linkedin_url", row.company_linkedin_url],
      ["facebook_url", row.facebook_url], ["twitter_url", row.twitter_url],
      ["alias", row.company_alias], ["keywords", row.keywords],
    ]) {
      if (!c[f] && v) c[f] = v;
    }
    if (c.employees === null) c.employees = toInt(row.employees);
    if (c.annual_revenue === null) c.annual_revenue = toInt(row.annual_revenue);
    if (c.total_funding === null) c.total_funding = toInt(row.total_funding);
    if (c.site_score_from_sheet === null) c.site_score_from_sheet = toScore(row.site_score);
    out.push({ ...row, __company: key });
  }
  return { companies: [...byKey.values()], rows: out };
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const raw = String(v).trim();

  /* SCIENTIFIC NOTATION IS A NUMBER TOO.
   *
   * Excel stores a big round number as "1.0156E7", and the browser's .xlsx
   * reader hands back the stored value. Stripping everything that is not a
   * digit, a dot or a minus turned that into "1.01567" — so a firm with ten
   * million dollars of revenue was saved as 1. Found 30 Aug 2026 by reading
   * the real Jewelry tab's revenue column, where every other row is written
   * this way. */
  const cleaned = raw.replace(/[,$\s]/g, "");

  /* TEXT IS NOT ZERO.
   *
   * "N/A".replace(/[^0-9.-]/g, "") is the empty string, and Number("") is 0.
   * So a cell reading "N/A", "unknown" or "--" was saved as a revenue of 0, a
   * headcount of 0 and — worst — a site score of 0, which is a real score
   * meaning the site failed everything. Migration 0025 says in as many words
   * that NULL means the sheet did not say and 0 means it said zero; this made
   * that false. It also meant a re-import could overwrite a real ten-million
   * revenue with 0 and call it "annual revenue updated".
   *
   * Anything that is not a number is now null. Found 30 Aug 2026 by an
   * adversarial reviewer. */
  if (!/\d/.test(cleaned)) return null;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(cleaned.replace(/[^0-9.eE+-]/g, ""))) return null;

  const n = Number(cleaned.replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toScore(v) {
  const n = toInt(v);
  if (n === null) return null;
  return n >= 0 && n <= 100 ? n : null;
}

/* ------------------------------------------------------------------ */
/* The whole plan, before anything is written                          */
/* ------------------------------------------------------------------ */

/**
 * Turn one mapped tab into exactly what would be saved, plus every warning
 * worth a person's attention. Nothing here touches a database. The import
 * screen renders this and the person decides.
 *
 * `warnings` is the honest half. An importer that reports only successes is an
 * importer nobody can check.
 */
export function buildImportPlan(rows, opts = {}) {
  /* THE MAPPING IS WORKED OUT HERE NOW, unless the caller supplies one.
   *
   * Callers used to have to pass a mapping and say whether row 1 was a heading
   * row, because a person answered both on a screen. Nobody answers anything
   * any more, so the plan reads the tab itself. A mapping passed in still
   * wins — the old tests, and any hand correction, go through that door. */
  const auto = opts.mapping ? null : autoMapTab(rows || []);
  const {
    mapping = auto.mapping,
    hasHeader = auto ? auto.hasHeader : true,
    team = [], listName = "", now = Date.now(),
  } = opts;
  const body = hasHeader ? (rows || []).slice(1) : (rows || []);
  const raws = [];
  const warnings = [];
  let blank = 0;

  /* Everywhere the heading row and the data disagreed, said out loud. On the
   * real workbook this is how a person finds out that the Jewelry tab's
   * "Website" column holds LinkedIn addresses — which is true, and which
   * nobody had noticed in the months it has been in use. */
  for (const n of (auto?.notes || [])) warnings.push({ kind: n.kind, why: n.why });

  /* guessHeaderRow refuses a second column claiming a field, but a person can
   * point two columns at the same field by hand in the mapper. Last-write-wins
   * meant the first column's value was silently replaced — the exact thing the
   * auto-mapper exists to prevent. First column wins, and the rest are reported. */
  const seen = new Set();
  const safeMapping = (mapping || []).map((f) => {
    if (!f) return "";
    if (seen.has(f)) return "";
    seen.add(f);
    return f;
  });
  const dropped = (mapping || [])
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => f && !safeMapping[i]);
  for (const { f, i } of dropped) {
    const label = SALES_FIELDS.find((x) => x.key === f)?.label || f;
    warnings.push({
      kind: "mapping", column: i + 1,
      why: `Column ${i + 1} was also pointed at "${label}", which an earlier column already fills. It was left out rather than overwriting the first one.`,
    });
  }

  body.forEach((r, i) => {
    const raw = {};
    safeMapping.forEach((field, col) => {
      if (!field) return;
      const v = String(r[col] ?? "").trim();
      if (v) raw[field] = v;
    });

    if (!raw.name && !raw.first_name && !raw.company && !raw.email) { blank += 1; return; }

    if (!raw.name) {
      const n = [raw.first_name, raw.last_name].filter(Boolean).join(" ").trim();
      if (n) raw.name = n;
    }
    raw.__row = i + (hasHeader ? 2 : 1);   // the line number in their spreadsheet
    raws.push(raw);
  });

  const { companies, rows: withCompany } = groupIntoCompanies(raws);

  /* Firms whose name is shared by more than one website in this file, where
   * some rows had no website at all. Those rows were grouped by name, which
   * may be wrong — say so rather than let it pass as certain. */
  const ambiguous = new Map();
  for (const c of companies) {
    if (!c.key.startsWith("n:")) continue;
    const clash = companies.filter((o) => o.name_key && o.name_key === c.name_key);
    if (clash.length > 1) ambiguous.set(c.name, c.contacts);
  }
  for (const [name, n] of ambiguous) {
    warnings.push({
      kind: "firm", name,
      why: `"${name}" appears under more than one website in this file, and ${n} row${n === 1 ? " has" : "s have"} no website at all. Those rows were grouped together by name — check they really are the same office.`,
    });
  }

  const ownerCache = new Map();
  const unmatchedOwners = new Map();
  const leads = withCompany.map((raw) => {
    const { stage, note } = stageFromSheet(raw.contacted, raw.status);

    let owner = { user_id: null, how: "blank" };
    if (raw.sales_owner) {
      const k = raw.sales_owner.toLowerCase();
      if (!ownerCache.has(k)) ownerCache.set(k, matchOwner(raw.sales_owner, team));
      owner = ownerCache.get(k);
      if (!owner.user_id) {
        const cur = unmatchedOwners.get(raw.sales_owner) || { name: raw.sales_owner, rows: 0, how: owner.how, candidates: owner.candidates };
        cur.rows += 1;
        unmatchedOwners.set(raw.sales_owner, cur);
      }
    }

    const first = parseSheetDate(raw.first_contact, { now });
    const last = parseSheetDate(raw.last_touch, { now });
    if (!first.ok) warnings.push({ kind: "date", row: raw.__row, field: "First contact", why: first.why });
    if (!last.ok) warnings.push({ kind: "date", row: raw.__row, field: "Last touch", why: last.why });

    /* The claim date. The sheet has no "date claimed" column even though its
     * own rules tell reps to fill one, so the first contact date is the best
     * evidence there is. With neither, the claim is stamped at import time and
     * the timeline note says so — the alternative is a claim dated 1970 that
     * the 3-day rule drops the moment the sweep runs. */
    const claimedAt = owner.user_id
      ? (first.iso ? `${first.iso}T12:00:00Z` : new Date(now).toISOString())
      : null;

    return {
      lead: {
        name: raw.name || null,
        company: raw.company || null,
        domain: normaliseDomain(raw.domain),
        email: raw.email || null,
        phone: raw.phone || raw.company_phone || null,
        city: raw.city || raw.company_city || null,
        state: raw.state || raw.company_state || null,
        vertical: raw.vertical || null,
        title: raw.title || null,
        seniority: raw.seniority || null,
        department: raw.department || null,
        linkedin_url: raw.linkedin_url || null,
        /* The CONTACT's own location line, kept apart from the firm's street
         * address on purpose: on this sheet they are different places on most
         * rows, and merging them sends a rep to the wrong town. */
        address: raw.address || null,
        country: raw.country || raw.company_country || null,
        stage,
        source: "sheet",
        owner_id: owner.user_id,
        imported_owner_name: raw.sales_owner || null,
        claimed_at: claimedAt,
        first_contact_at: first.iso ? `${first.iso}T12:00:00Z` : null,
        last_touch_at: last.iso ? `${last.iso}T12:00:00Z` : null,
        cadence_started_at: claimedAt,
        next_step: raw.next_step || null,
        notes: raw.notes || null,
      },
      companyKey: raw.__company,
      /* The first line of this person's timeline. Stamped "imported from the
       * sheet" and dated, so nothing that came out of a spreadsheet can ever
       * be mistaken later for something we measured. */
      importNote: [
        `Imported from ${listName || "the outreach sheet"}, row ${raw.__row}.`,
        note ? `Stage: ${note}.` : null,
        raw.sales_owner ? `Sheet said the owner was "${raw.sales_owner}"${owner.user_id ? ` — matched by ${owner.how}.` : " — no account matched, so this is unclaimed."}` : null,
        raw.next_step ? `Next step from the sheet: ${raw.next_step}` : null,
      ].filter(Boolean).join(" "),
    };
  });

  for (const u of unmatchedOwners.values()) {
    warnings.push({
      kind: "owner", name: u.name, rows: u.rows,
      why: u.how === "ambiguous"
        ? `"${u.name}" could be ${u.candidates.join(" or ")}. ${u.rows} row${u.rows === 1 ? "" : "s"} will come in unclaimed until you say which.`
        : `No account matches "${u.name}". ${u.rows} row${u.rows === 1 ? "" : "s"} will come in unclaimed.`,
    });
  }
  if (blank) warnings.push({ kind: "blank", rows: blank, why: `${blank} row${blank === 1 ? "" : "s"} had no name, company or email and cannot be told apart from an empty line.` });

  return {
    leads,
    companies,
    warnings,
    /* What was read and how it was decided, so the result screen can show it
     * without doing the work a second time and possibly getting a different
     * answer. */
    mapping,
    hasHeader,
    headerWhy: auto?.headerWhy || null,
    counts: {
      rows: body.length,
      usable: leads.length,
      blank,
      companies: companies.length,
      claimed: leads.filter((l) => l.lead.owner_id).length,
      unclaimed: leads.filter((l) => !l.lead.owner_id).length,
      withEmail: leads.filter((l) => l.lead.email).length,
      alreadyWorked: leads.filter((l) => l.lead.stage !== "new").length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Importing somebody who is already here                              */
/* ------------------------------------------------------------------ */

/* HOW FAR ALONG EACH STAGE IS. Only used to refuse to go backwards.
 *
 * EVERY STAGE THE DATABASE ACCEPTS HAS TO BE IN HERE, and the list is checked
 * against migration 0009's constraint by a test. `researching` was missing, so
 * `STAGE_ORDER[stage] ?? 0` scored it the same as `new`: a contact the console
 * had at researching counted as never worked, and could never be reached as a
 * destination either. `reopened` shared a rank with `contacted`, so a reopened
 * lead could never be moved on to contacted by an import. Both found 30 Aug
 * 2026 by an adversarial reviewer. */
const STAGE_ORDER = {
  new: 0, researching: 1, reopened: 1.5, contacted: 2, follow_up: 3,
  in_conversation: 4, meeting: 5, proposal: 6,
  won: 9, lost: 9, skip_90: 9, bad_contact: 9,
};
const CLOSED = new Set(["won", "lost", "skip_90", "bad_contact"]);

/* Facts about a person or a firm. A newer export knows these better than a
 * row imported three months ago, so a filled cell replaces what is there. */
const REFRESHABLE = [
  "name", "first_name", "last_name", "title", "seniority", "department",
  "email", "phone", "linkedin_url", "city", "state", "address", "country",
  "company", "domain", "vertical",
];

const blankish = (v) => v === null || v === undefined || String(v).trim() === "";

/**
 * What to change about a contact who is already in the console, given the row
 * the sheet just handed us. Returns only the fields that should actually move.
 * An empty object means leave this person exactly as they are.
 *
 * THE ONE RULE: NOTHING IS EVER DELETED, EMPTIED OR UNDONE.
 *
 * Ryder, 30 Aug 2026: "receive this file … without deleting any data." The
 * import used to answer this by skipping anybody already here, which is safe
 * and also means the console drifts further from the sheet on every run. This
 * fills gaps and refreshes facts instead, and refuses, specifically:
 *
 *   · An EMPTY cell never overwrites something. A blank column in an Apollo
 *     export means "this export did not have it", not "delete it".
 *   · A stage never moves BACKWARDS, and a closed deal never reopens. Somebody
 *     marked Won in the console stays Won even if the sheet still says
 *     Contacted, because the console is where the work happened.
 *   · A claimed lead is never taken off its rep. The import can only claim
 *     somebody nobody has.
 *   · First contact keeps the EARLIEST date either side knows, last touch the
 *     LATEST. Those two feed the timers, and a timer moved the wrong way makes
 *     a cold firm look fresh.
 *   · A next step already typed in the console is not replaced. The sheet's
 *     version goes on the timeline instead, where both survive.
 *
 * `changes` names every field that moved, in plain words, for the person's
 * timeline. A change nobody can see afterwards is a change nobody can check.
 */
/* Fields that say WHO somebody is, as opposed to facts about them. */
const IDENTITY_FIELDS = new Set(["name", "first_name", "last_name", "title", "email", "linkedin_url"]);

export function mergeLead(existing, incoming, { keyKind = "e" } = {}) {
  const patch = {};
  const changes = [];
  const spare = [];
  const set = (field, value, why) => { patch[field] = value; changes.push(why); };

  /* HOW SURE ARE WE THAT THIS IS THE SAME PERSON?
   *
   * The dedupe key falls back from email to phone to website to company+city
   * (lib/lead-intake.js), and migration 0006 says out loud that two real
   * businesses can share a switchboard. Every contact at a firm who has no
   * personal email therefore gets the SAME key as their colleagues.
   *
   * That was harmless while the importer skipped anybody already on file. It
   * is not harmless now that it merges: three agents at one brokerage would
   * take turns overwriting each other's name, title and LinkedIn, and the
   * timeline would say "name updated". So on anything weaker than an email
   * match, the fields that say who somebody IS are left alone and offered on
   * the timeline instead. Facts — phone, city, company, seniority — still
   * refresh, because those are true of whoever the row is.
   *
   * Found 30 Aug 2026 by an adversarial reviewer. */
  const sure = keyKind === "e";

  for (const f of REFRESHABLE) {
    const next = incoming[f];
    if (blankish(next)) continue;                       // never blank a value
    if (String(existing[f] ?? "").trim() === String(next).trim()) continue;
    if (blankish(existing[f])) { set(f, next, `${f.replace(/_/g, " ")} filled in`); continue; }
    if (!sure && IDENTITY_FIELDS.has(f)) {
      spare.push(`The sheet had a different ${f.replace(/_/g, " ")} for this row: ${next}. It was not applied — this row was matched on ${keyKind === "p" ? "a phone number" : keyKind === "d" ? "a website" : "a company name"}, which colleagues share.`);
      continue;
    }
    set(f, next, `${f.replace(/_/g, " ")} updated`);
  }

  /* The stage. Forward only, and never out of a closed one. */
  const from = String(existing.stage || "new");
  const to = String(incoming.stage || "new");
  if (to !== from && !CLOSED.has(from) && (STAGE_ORDER[to] ?? 0) > (STAGE_ORDER[from] ?? 0)) {
    set("stage", to, `moved from ${from.replace(/_/g, " ")} to ${to.replace(/_/g, " ")}`);
  }

  /* The claim. Only ever onto somebody nobody has. */
  if (!existing.owner_id && incoming.owner_id) {
    set("owner_id", incoming.owner_id, "claimed from the sheet");
    /* Named in `changes` as well as written. These three used to be set
     * silently, so a contact whose claim date and cadence clock had just been
     * started showed a timeline line that mentioned neither — and the cadence
     * clock is what decides when somebody is chased. */
    if (!existing.claimed_at && incoming.claimed_at) set("claimed_at", incoming.claimed_at, "claim dated from the sheet");
    if (!existing.cadence_started_at && incoming.cadence_started_at) set("cadence_started_at", incoming.cadence_started_at, "the chase clock started");
  }
  if (blankish(existing.imported_owner_name) && !blankish(incoming.imported_owner_name)) {
    set("imported_owner_name", incoming.imported_owner_name, `the sheet's own owner name recorded as "${incoming.imported_owner_name}"`);
  }

  /* The two dates that drive the timers. Widest window either side knows. */
  if (incoming.first_contact_at
      && (!existing.first_contact_at || incoming.first_contact_at < existing.first_contact_at)) {
    set("first_contact_at", incoming.first_contact_at, "first contact dated earlier");
  }
  if (incoming.last_touch_at
      && (!existing.last_touch_at || incoming.last_touch_at > existing.last_touch_at)) {
    set("last_touch_at", incoming.last_touch_at, "last touch dated later");
  }

  /* Typed words. Filled if empty; otherwise kept, and the new text is handed
   * back so the caller can put it on the timeline rather than throw it away. */
  for (const f of ["next_step", "notes"]) {
    if (blankish(incoming[f])) continue;
    if (blankish(existing[f])) set(f, incoming[f], `${f.replace(/_/g, " ")} filled in`);
    else if (String(existing[f]).trim() !== String(incoming[f]).trim()) {
      spare.push(`${f === "next_step" ? "Next step" : "Note"} in the sheet: ${incoming[f]}`);
    }
  }

  return { patch, changes, spare, changed: Object.keys(patch).length > 0 };
}

/**
 * The same idea for a firm. Simpler, because a firm has no stage and no owner:
 * fill what is empty, refresh what the export knows better, never blank.
 */
export function mergeCompany(existing, incoming) {
  const patch = {};
  const changes = [];
  const fields = [
    "name", "domain", "phone", "address", "city", "state", "country", "vertical",
    "alias", "keywords", "linkedin_url", "facebook_url", "twitter_url",
    "employees", "annual_revenue", "total_funding",
  ];
  for (const f of fields) {
    const next = incoming[f];
    if (blankish(next)) continue;
    if (String(existing[f] ?? "").trim() === String(next).trim()) continue;
    patch[f] = next;
    changes.push(blankish(existing[f]) ? `${f.replace(/_/g, " ")} filled in` : `${f.replace(/_/g, " ")} updated`);
  }
  /* The score is ours, measured by us, and no spreadsheet may touch it. */
  delete patch.site_score;
  return { patch, changes, changed: Object.keys(patch).length > 0 };
}

/* ------------------------------------------------------------------ */
/* Reading a tab with nobody watching                                  */
/* ------------------------------------------------------------------ */

/**
 * Work out a tab's columns on its own, with no questions asked.
 *
 * Ryder, 30 Aug 2026: "receive this file without asking any questions … even
 * if we're short a couple rows on a client it still puts them in, or if we
 * have a few extra it's ok."
 *
 * So there is no mapping screen any more. lib/sheet-columns.js scores every
 * column on what is IN it and treats the heading row as a hint, which is the
 * only way this can be right on a workbook where three tabs disagree with
 * their own headings and one has no heading row at all.
 *
 * Returns exactly what the old mapping screen produced — `mapping`,
 * `hasHeader` — plus `notes`, which is every place the heading and the data
 * disagreed, in plain words, for the screen to print afterwards.
 */
export function autoMapTab(rows) {
  return mapColumns(rows, { headerGuess: guessSalesColumn, fields: SALES_FIELD_KEYS });
}

/** Is this tab a lead list at all? "Rules of Engagement" is prose, not rows,
 * and importing it makes a hundred leads called "•".
 *
 * This used to read the heading row and nothing else, which meant the real
 * "Luxury Agents" tab — 821 people, no heading row — was rejected with "0
 * columns could be recognised" and silently skipped on every import. It now
 * asks the same reader the import itself uses, so a tab is judged on what it
 * actually holds.
 *
 * `mapped` may be passed in when the caller has already done the work, so a
 * ten-tab workbook is read once rather than twice. */
export function looksLikeLeadTab(name, rows, mapped) {
  if (/rules of engagement|instructions|read ?me|how to/i.test(String(name ?? ""))) {
    return { yes: false, why: "This tab is the instructions, not a list." };
  }
  if (!(rows || []).length) return { yes: false, why: "The tab is empty." };

  const m = mapped || autoMapTab(rows);
  const fields = m.mapping.filter(Boolean);
  const bodyRows = Math.max(0, rows.length - (m.hasHeader ? 1 : 0));

  /* A list needs somebody ON it. A tab with a heading row and nothing under it
   * — "Misc." and "Template" in the real workbook — maps perfectly and holds
   * nobody, and importing it creates a list nobody can ever use. */
  if (!bodyRows) return { yes: false, why: "The tab has column headings but nobody under them." };

  /* Somewhere to put a name or an email. Three recognised columns is not
   * enough on its own: Sales Owner, Contacted? and Status are three columns
   * and describe no person. */
  const identifies = ["email", "name", "first_name", "company"].some((f) => fields.includes(f));
  if (!identifies) {
    return { yes: false, why: `Nothing on this tab names a person or a firm — ${fields.length} column${fields.length === 1 ? "" : "s"} were recognised and none of them is a name, an email or a company.` };
  }
  if (fields.length < 3) {
    return { yes: false, why: `Only ${fields.length} column${fields.length === 1 ? "" : "s"} could be recognised — this does not look like a lead list.` };
  }
  return {
    yes: true,
    why: `${fields.length} columns read, ${bodyRows} row${bodyRows === 1 ? "" : "s"}${m.hasHeader ? "" : ", no heading row"}.`,
  };
}
