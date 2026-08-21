/* Lead intake — the one place that decides what a lead row looks like and
 * whether two rows are the same lead.
 *
 * Leads arrive three ways: somebody imports a spreadsheet, the scraper pulls
 * them from a provider, or a person types one in. All three end up here, which
 * is the point: three code paths meant three ideas of what counts as a
 * duplicate, and duplicates are what makes a sales rep stop trusting a list.
 *
 * dedupeKey() is a deliberate copy of the SQL function
 * public.admin_lead_dedupe_key in migration 0006. Two copies is a real cost,
 * and it is paid on purpose: the browser has to be able to show "12 of these
 * are already in the pipeline" BEFORE anything is written, and it cannot do
 * that by asking a database function per row. tests/brain/test.mjs pins this
 * side's answers; tests/brain/sql-crosscheck.sh runs the SAME cases through a
 * real Postgres and diffs the two. Change one, change both, run both.
 */

/* ------------------------------------------------------------------ */
/* Cleaning one field at a time                                        */
/* ------------------------------------------------------------------ */

export function cleanEmail(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  // The same shape check as the rest of the console: one @, a dot after it,
  // no spaces. Deliberately not a full RFC test — the real test is whether
  // mail to it bounces, and no regular expression knows that.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Digits only → the 10-digit US number.
 *
 * Drop a leading 1 (the country code), then take the FIRST ten. Taking the
 * LAST ten was the obvious version and it is wrong: "(850) 555-0100 ext 4"
 * becomes 85055501004, whose last ten are 5055501004 — a different number,
 * so the same business imported twice with and without its extension would
 * not be spotted as a duplicate. A test caught it.
 *
 * Known limit, written down rather than hidden: an 11-digit number that does
 * not start with 1 (some international formats) gets its first ten taken and
 * so is not a real phone number any more. It is still STABLE — the same input
 * always gives the same key — so deduping still works, and these leads are US
 * businesses. Revisit if we ever work a non-US list.
 */
export function cleanPhone(v) {
  let digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length < 10) return null;
  return digits.slice(0, 10);
}

/** A bare hostname: no scheme, no www, no path, no trailing dot. */
export function cleanDomain(v) {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0].replace(/\.$/, "");
  if (!s.includes(".") || /\s/.test(s)) return null;
  return s;
}

export function cleanText(v, n = 200) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, n) : null;
}

/** Two letters, uppercase. Full state names are left alone rather than guessed
 * at — "Washington" could be the state or the city, and a wrong state sends a
 * rep to the wrong time zone. */
export function cleanState(v) {
  const s = String(v ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return cleanText(s, 40);
}

/* ------------------------------------------------------------------ */
/* The dedupe key                                                      */
/* ------------------------------------------------------------------ */

/**
 * What makes two rows the same lead. Returns null when there is nothing
 * strong enough to match on — and null NEVER matches null. Two rows with only
 * a first name are not the same person, and treating them as one loses a real
 * lead, which is worse than dialling a number twice.
 *
 * Order is strongest-signal-first and matches the SQL function exactly.
 */
export function dedupeKey({ email, phone, domain, company, city } = {}) {
  const e = cleanEmail(email);
  if (e) return `e:${e}`;
  const p = cleanPhone(phone);
  if (p) return `p:${p}`;
  const d = cleanDomain(domain);
  if (d) return `d:${d}`;
  const c = String(company ?? "").trim();
  if (c) {
    const slug = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `c:${slug}:${String(city ?? "").trim().toLowerCase()}`;
  }
  return null;
}

/** Same lead twice inside ONE import. Keeps the first, and reports the rest
 * with the row number so a person can go and look at their spreadsheet. */
export function dedupeWithin(rows) {
  const seen = new Map();
  const kept = [];
  const dupes = [];
  rows.forEach((row, i) => {
    const key = dedupeKey(row);
    if (key && seen.has(key)) {
      dupes.push({ row, index: i, matchesIndex: seen.get(key), key });
      return;
    }
    if (key) seen.set(key, i);
    kept.push(row);
  });
  return { kept, dupes };
}

/** Rows that are already in the pipeline. `existingKeys` is a Set of dedupe
 * keys read from admin_leads. */
export function splitAgainstExisting(rows, existingKeys) {
  const fresh = [];
  const already = [];
  for (const row of rows) {
    const key = dedupeKey(row);
    if (key && existingKeys.has(key)) already.push({ row, key });
    else fresh.push(row);
  }
  return { fresh, already };
}

/* ------------------------------------------------------------------ */
/* Turning anything into a lead row                                    */
/* ------------------------------------------------------------------ */

export const LEAD_FIELDS = ["name", "company", "domain", "email", "phone", "city", "state", "vertical", "notes"];

/** Column-name guessing for an imported sheet. Wider than the old CSV-only
 * version because real exports say "Business Name", "Work Phone", "Mobile",
 * "Web Site", "Full Address". */
const HEADER_HINTS = [
  ["email", /\b(e-?mail|email address|work email|contact email)\b/i],
  ["phone", /\b(phone|tel|telephone|mobile|cell|contact number|work phone)\b/i],
  ["company", /\b(company|business|organi[sz]ation|firm|account|practice|business name|dba)\b/i],
  ["name", /\b(name|contact|owner|first ?name|full ?name|person|lead)\b/i],
  ["domain", /\b(domain|website|web ?site|url|site|web)\b/i],
  ["city", /\b(city|town|locality)\b/i],
  ["state", /\b(state|province|region|st\.?)\b/i],
  ["vertical", /\b(industry|vertical|category|niche|type|sector|trade)\b/i],
  ["notes", /\b(note|notes|comment|comments|description|details|remark)\b/i],
];

export function guessColumn(header) {
  const h = String(header ?? "").trim();
  if (!h) return "";
  for (const [field, re] of HEADER_HINTS) {
    if (re.test(h)) return field;
  }
  return "";
}

/** One raw object → one lead row, or null if there is not enough to work with.
 * A lead with no name, no company and no email cannot be told apart from any
 * other blank row, so it is dropped rather than saved as noise. */
export function toLeadRow(raw, { source = "manual", sourceId = null } = {}) {
  const row = {
    name: cleanText(raw.name, 160),
    company: cleanText(raw.company, 200),
    domain: cleanDomain(raw.domain),
    email: cleanEmail(raw.email),
    phone: null,
    city: cleanText(raw.city, 90),
    state: cleanState(raw.state),
    vertical: cleanText(raw.vertical, 90),
    notes: cleanText(raw.notes, 1000),
  };
  // The phone is stored as it was written, not as the 10 digits — a rep reads
  // it, and (850) 555-0100 is easier to read back over the phone. Only the
  // dedupe key uses the digits.
  const digits = cleanPhone(raw.phone);
  row.phone = digits ? cleanText(raw.phone, 40) : null;

  if (!row.name && !row.company && !row.email) return null;
  return { ...row, source, source_id: sourceId, stage: "new" };
}

/* ------------------------------------------------------------------ */
/* Provider answers → raw objects                                      */
/* ------------------------------------------------------------------ */

/** Apollo's people search shape. Written against their documented fields and
 * kept forgiving: a provider that renames a field should cost us that one
 * field, not the whole run. */
export function normalizeApollo(person) {
  const org = person?.organization || {};
  return {
    name: [person?.first_name, person?.last_name].filter(Boolean).join(" ") || person?.name || null,
    company: org.name || person?.organization_name || null,
    domain: org.website_url || org.primary_domain || null,
    email: person?.email || null,
    phone: person?.phone_numbers?.[0]?.raw_number || org.phone || null,
    city: person?.city || org.city || null,
    state: person?.state || org.state || null,
    vertical: org.industry || null,
    notes: [person?.title, org.estimated_num_employees ? `${org.estimated_num_employees} staff` : null]
      .filter(Boolean).join(" · ") || null,
  };
}

/** The platform's own lead generator. Its rows are already close to ours, so
 * this mostly picks the field whichever of two names it came under. */
export function normalizePlatform(row) {
  return {
    name: row?.name || row?.contact_name || null,
    company: row?.company || row?.business_name || row?.business || null,
    domain: row?.domain || row?.website || row?.url || null,
    email: row?.email || row?.contact_email || null,
    phone: row?.phone || row?.telephone || null,
    city: row?.city || row?.locality || null,
    state: row?.state || row?.region || null,
    vertical: row?.vertical || row?.category || row?.industry || null,
    notes: row?.notes || row?.summary || null,
  };
}

/** Round-robin across the reps on a source. Returns owner ids the same length
 * as rows. An empty rep list means the leads land unclaimed, which is a
 * choice a person made on the source and not a bug. */
export function assignRoundRobin(rows, repIds, startAt = 0) {
  if (!repIds?.length) return rows.map(() => null);
  return rows.map((_, i) => repIds[(startAt + i) % repIds.length]);
}
