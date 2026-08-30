/* WORKING OUT WHAT A COLUMN HOLDS BY LOOKING AT WHAT IS IN IT.
 *
 * WHY THIS FILE EXISTS
 * The importer used to trust the heading row. On CJ's real workbook that is
 * wrong on three of its seven lead tabs, and wrong SILENTLY:
 *
 *   · "Luxury Agents" has NO heading row at all. 821 people. The old importer
 *     read row 1 as headings, recognised nothing, and skipped the tab.
 *   · "Jewelry" has three columns in the data that the heading row does not
 *     have. Everything from column 12 on slides right, so the heading says
 *     "Website" over a LinkedIn address and "Annual Revenue" over the word
 *     "Los Angeles".
 *   · "Car Dealership" slides by three from column 22 on, so the heading says
 *     "Company Address" over the contact's own city.
 *
 * Nobody would ever have noticed. The rows import, the count looks right, and
 * a rep rings a switchboard that is actually a LinkedIn URL.
 *
 * AND IT KEEPS HAPPENING
 * CJ pulls these lists out of Apollo. Apollo's export columns change with the
 * search, so the next drop will not have the same shape as this one. A reader
 * that depends on a heading row being correct is a reader that breaks again.
 *
 * SO: every column is scored on its own CONTENT, and the heading row is
 * demoted to a hint. A strong content signal (0.9+) beats a heading (0.55). A
 * heading still decides the cases content genuinely cannot — first name vs
 * last name, city vs state on a tab where both are plain words.
 *
 * Pure functions. No imports, no database, no browser. tests/sheet-columns
 * runs every rule below against rows copied out of the real workbook.
 */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const s = (v) => String(v ?? "").trim();
const lower = (v) => s(v).toLowerCase();

/** Up to `cap` non-empty values from a column, plus how full the column is.
 *
 * Every row is LOOKED AT — the fill rate has to be true of the whole column,
 * and it is a signal in its own right: the six hand-typed columns are mostly
 * blank, the Apollo block is mostly full. What is capped is how many values
 * are kept for scoring, which is what keeps a ten-tab workbook instant. */
export function columnSample(rows, index, { cap = 120, skipFirst = 0 } = {}) {
  const values = [];
  let seen = 0;
  let filled = 0;
  for (let r = skipFirst; r < rows.length; r += 1) {
    const v = s((rows[r] || [])[index]);
    seen += 1;
    if (!v) continue;
    filled += 1;
    if (values.length < cap) values.push(v);
  }
  return { values, seen, filled, fill: seen ? filled / seen : 0 };
}

/** What share of the sampled values pass `test`.
 *
 * Two things it deliberately does NOT do.
 *
 * Zero values scores 0, not 1 — an empty column matching everything vacuously
 * is how a blank column steals a field from the column that really holds it.
 *
 * And a column with one or two stray values in nine hundred rows is held back
 * in proportion: one "California" three thousand rows down should not make a
 * blank column the State column. Found on the real Car Dealership tab, where
 * empty columns 41 and 49 took City and Keywords off the columns that had
 * them. MIN_SAMPLE is the number of values below which a column is not
 * trusted on its own. */
const MIN_SAMPLE = 5;
function share(values, test) {
  if (!values.length) return 0;
  let n = 0;
  for (const v of values) if (test(v)) n += 1;
  return n / values.length;
}

/**
 * How much a column's own score is worth, given how much is actually IN it.
 *
 * Relative to the tab, not a fixed count. Three stray emails in a nine-hundred
 * row column is somebody's typo; three emails in a six-row pasted list is the
 * email column. A flat "five values is enough" gets one of those wrong
 * whichever number is picked — at five, three values in nine hundred rows
 * still scored 0.6 and took the field off the column that really held it.
 *
 * So: at least MIN_SAMPLE values, and at least two per cent of the rows. Found
 * 30 Aug 2026 by an adversarial reviewer, who also pointed out that the first
 * version of this had no test at all.
 */
function trustOf({ filled, seen, values }) {
  const have = filled ?? values?.length ?? 0;
  const rows = seen ?? values?.length ?? have;
  const need = Math.max(MIN_SAMPLE, Math.round(rows * 0.02));
  return Math.min(1, have / need);
}

const uniqueCount = (values) => new Set(values.map(lower)).size;

/* ------------------------------------------------------------------ */
/* The vocabularies                                                    */
/* ------------------------------------------------------------------ */

/* Apollo writes seniority from a closed list. So does the sheet's own
 * Contacted? and Sales Cycle Status. A closed list is the strongest signal
 * there is, because no other column in a lead export looks like it. */
const SENIORITY = new Set([
  "c suite", "c-suite", "csuite", "founder", "owner", "partner", "vp", "vp ",
  "director", "manager", "head", "senior", "entry", "intern", "executive",
]);

const DEPARTMENTS = [
  "marketing", "sales", "c-suite", "c suite", "operations", "design",
  "engineering", "finance", "medical", "human resources", "legal",
  "information technology", "it", "product", "consulting", "education",
  "support", "business development", "accounting", "administrative",
  "executive", "data science", "arts and design", "media",
];

const CONTACTED = [/^yes\b/i, /^no$/i, /^n\/a$/i];

const STATUS_WORDS = [
  "contacted", "closed", "lost", "won", "bad contact", "skip", "proposal",
  "meeting", "follow", "nurtur", "replied", "in conversation", "reopened",
  "no answer", "not a fit", "interested", "booked", "demo",
];

/* Every US state and DC, plus the Canadian provinces and the two-letter
 * codes. Apollo writes them out in full; a pasted list sometimes uses codes. */
const STATES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "district of columbia", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota",
  "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
  "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "puerto rico", "ontario", "quebec", "british columbia", "alberta",
  "manitoba", "saskatchewan", "nova scotia", "new brunswick",
  "newfoundland and labrador", "prince edward island",
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "dc", "fl", "ga", "hi", "id",
  "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo",
  "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa",
  "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
]);

/* Deliberately short. A country column in these exports is "United States" on
 * every row bar a handful, and a longer list would start swallowing city
 * names ("Georgia" is a state here, not the country). */
const COUNTRIES = new Set([
  "united states", "united states of america", "usa", "us", "canada",
  "united kingdom", "uk", "australia", "mexico", "estados unidos",
  "puerto rico", "india", "germany", "france", "spain", "brazil",
]);

/* Words that appear in a job title and nowhere else in a lead export. */
const TITLE_WORDS = /\b(director|manager|officer|president|vp|vice president|chief|head of|owner|partner|founder|co-?founder|coordinator|specialist|associate|executive|lead|principal|supervisor|administrator|ceo|cmo|cfo|coo|cto|cio|broker|realtor|real estate agent|agent|advisor|adviser|consultant|analyst|strategist|representative|rep|assistant|engineer|designer|architect|attorney|counsel|dentist|physician|doctor|dr\.|md|dds|esq|manager|marketing|sales|operations|development|relations)\b/i;

/* Words that end a company name. Used as a hint only — plenty of firms are
 * just "Bishop Ranch". */
const COMPANY_WORDS = /\b(llc|l\.l\.c|inc|inc\.|incorporated|corp|corporation|co\.|company|group|partners|associates|holdings|ventures|realty|properties|law|firm|pllc|p\.c|pc|ltd|limited|plc|team|agency|studio|clinic|center|centre|dental|medical|jewelers|motors|auto|honda|toyota|bmw|audi|mercedes)\b/i;

/* ------------------------------------------------------------------ */
/* Shape tests                                                         */
/* ------------------------------------------------------------------ */

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v);
/* A bare hostname needs a LETTER top-level domain.
 *
 * Written as `[a-z0-9-]+(\.[a-z0-9-]+)+` first, which matches "42.0" — and the
 * browser's own .xlsx reader hands every whole number back with a ".0" on it.
 * So the employee-count column read as a column of websites, took the Website
 * field off the real one, and the real one was dropped. Three tabs lost their
 * website and their headcount to a regular expression that was one character
 * too generous. */
const isUrl = (v) => /^(https?:\/\/|www\.)/i.test(v)
  || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\/?$/i.test(v);
const host = (v) => {
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i.exec(v);
  return m ? m[1].toLowerCase() : "";
};
const isPersonLinkedIn = (v) => /linkedin\.com\/(in|pub)\//i.test(v);
const isCompanyLinkedIn = (v) => /linkedin\.com\/(company|school|showcase)\//i.test(v);
const isFacebook = (v) => /(^|\.)facebook\.com/i.test(host(v)) || /facebook\.com\//i.test(v);
const isTwitter = (v) => /(^|\.)(twitter\.com|x\.com)/i.test(host(v)) || /twitter\.com\//i.test(v);
const isSocial = (v) => isPersonLinkedIn(v) || isCompanyLinkedIn(v) || isFacebook(v) || isTwitter(v)
  || /linkedin\.com/i.test(v) || /instagram\.com|youtube\.com|tiktok\.com/i.test(v);

/** A plain website: a URL that is not one of the social networks. */
const isPlainSite = (v) => isUrl(v) && !isSocial(v);

/** A plain number, however the spreadsheet wrote it.
 *
 * The browser's .xlsx reader returns the cell's raw stored value, and Excel
 * stores a big round number in SCIENTIFIC NOTATION: ten million and a bit is
 * "1.0156E7". Accepting only digits meant the Annual Revenue column scored as
 * text on three tabs and was dropped — while the values that happened to be
 * small enough came through, so the column looked half-full rather than
 * broken. */
const NUMBER = /^-?\d{1,15}(\.\d+)?([eE][+-]?\d{1,3})?$/;
const isIntLike = (v) => NUMBER.test(v.replace(/[,$\s]/g, ""));
const intOf = (v) => Number(v.replace(/[,$\s]/g, ""));

/** Phone-shaped: at least 7 digits, and nothing that is not a phone character.
 * Written loosely on purpose — these exports carry "+1 844-533-1031",
 * "(561) 406-2878" and "5614062878" in the same column.
 *
 * A NUMBER IS NOT A PHONE NUMBER. The loose character set includes the letters
 * of "ext", which means "1.0156E7" is made only of phone characters and has
 * eight digits — so ten million dollars read as a switchboard and the Annual
 * Revenue column lost to it. So a value with a DECIMAL POINT or an EXPONENT is
 * refused: no phone number has either, and every spreadsheet number big enough
 * to be mistaken for one does. A bare "5614062878" is still a phone. */
const NOT_A_PHONE = /^-?\d+(\.\d+|[eE][+-]?\d+)/;   // has a decimal point or an exponent
const isPhone = (v) => !NOT_A_PHONE.test(v.replace(/[,$\s]/g, ""))
  && /^[+()\d\s.\-x/,;ext]{7,40}$/i.test(v)
  && (v.replace(/\D/g, "").length >= 7);

/** An Excel date cell arrives as the serial number of days since 30 Dec 1899.
 * The window is 36000 (1998) to 60000 (2064) — wide enough for anything a
 * lead list holds, narrow enough that a headcount or a revenue figure cannot
 * fall inside it. Also accepts what a person types. */
const isDateish = (v) => {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 36000 && n <= 60000 && /^\d{4,5}(\.\d+)?$/.test(v)) return true;
  if (/^\d{1,2}([/.-])\d{1,2}\1(\d{2}|\d{4})$/.test(v)) return true;
  if (/^\d{4}-\d{2}-\d{2}([T\s]|$)/.test(v)) return true;
  return false;
};

/** "2600 Camino Ramon, San Ramon, California, United States, 94583" — a
 * street address. Starts with a building number and has commas. */
const isStreetAddress = (v) => /^\s*\d+[\w-]*\s+\S/.test(v) && (v.match(/,/g) || []).length >= 1;

/** "Walnut Creek, California, United States" — a place line with no street.
 * This is what Apollo puts in the contact's own "Address" column, and it is
 * NOT the firm's street address. Getting the two mixed up is what makes the
 * console show a rep's home city as the office. */
const isPlaceLine = (v) => !isStreetAddress(v)
  && (v.match(/,/g) || []).length >= 1
  && !/\d{5}/.test(v)
  && v.length < 90;

/** A single plain word or two — a name, a city. No digits, no @, no slashes. */
const isWordy = (v) => /^[\p{L}][\p{L}\s'.\-’]{0,40}$/u.test(v);
const isSingleToken = (v) => isWordy(v) && v.split(/\s+/).length <= 2;

/** The technology / keywords blob: a very long comma-separated list. Apollo
 * calls it "Keywords" on one tab and "Technologies" on another, and on the
 * Jewelry tab it sits under a heading that says something else entirely. */
const isBlob = (v) => v.length > 90 && (v.match(/,/g) || []).length >= 4;

/* ------------------------------------------------------------------ */
/* Scoring one column                                                  */
/* ------------------------------------------------------------------ */

/* Each entry: [field, scorer]. A scorer returns 0..1 for "this column holds
 * this field". Several fields can score on the same column; the assignment
 * step below decides who gets it.
 *
 * The numbers are share-of-sample, so they degrade honestly: a Website column
 * with nine blanks and one LinkedIn URL in it still reads as a website. */
const SCORERS = [
  ["email", (v) => share(v, isEmail)],

  ["linkedin_url", (v) => share(v, isPersonLinkedIn)],
  ["company_linkedin_url", (v) => share(v, isCompanyLinkedIn)],
  ["facebook_url", (v) => share(v, isFacebook)],
  ["twitter_url", (v) => share(v, isTwitter)],
  ["domain", (v) => share(v, isPlainSite) * (share(v, isSocial) > 0.2 ? 0 : 1)],

  ["company_phone", (v) => share(v, isPhone) * 0.98],
  /* The contact's DIRECT line scores below the floor on content alone, so it
   * can only ever be filled by a heading that actually says direct, mobile or
   * cell. Every tab of the real sheet carries the switchboard number twice —
   * "Corporate Phone" and "Company Phone" — and the second copy used to land
   * on the person as a direct dial. A rep then rings a switchboard believing
   * it is somebody's mobile. */
  ["phone", (v) => share(v, isPhone) * 0.44],

  ["first_contact", (v) => share(v, isDateish)],
  ["last_touch", (v) => share(v, isDateish) * 0.99],

  ["company_address", (v) => share(v, isStreetAddress)],
  ["address", (v) => share(v, isPlaceLine) * 0.95],

  ["keywords", (v) => share(v, isBlob)],

  ["company_country", (v) => share(v, (x) => COUNTRIES.has(lower(x)))],
  ["country", (v) => share(v, (x) => COUNTRIES.has(lower(x))) * 0.97],
  ["company_state", (v) => share(v, (x) => STATES.has(lower(x))) * 0.96],
  ["state", (v) => share(v, (x) => STATES.has(lower(x))) * 0.95],

  ["seniority", (v) => share(v, (x) => SENIORITY.has(lower(x)))],
  ["department", (v) => {
    const hit = share(v, (x) => lower(x).split(/\s*,\s*/).every((p) => DEPARTMENTS.includes(p)));
    // A department column repeats a handful of values across hundreds of rows.
    return hit * (uniqueCount(v) <= Math.max(30, v.length * 0.35) ? 1 : 0.6);
  }],

  ["contacted", (v) => share(v, (x) => CONTACTED.some((re) => re.test(x)))
    * (uniqueCount(v) <= 8 ? 1 : 0.4)],
  ["status", (v) => share(v, (x) => STATUS_WORDS.some((w) => lower(x).includes(w)))
    * (uniqueCount(v) <= 20 ? 1 : 0.4)],

  ["employees", (v) => {
    const ints = share(v, isIntLike);
    if (ints < 0.85) return 0;
    const nums = v.filter(isIntLike).map(intOf);
    const plausible = nums.filter((n) => n >= 1 && n <= 500000).length / (nums.length || 1);
    const small = nums.filter((n) => n < 100000).length / (nums.length || 1);
    // Headcounts are small numbers. Revenue is not. The gap between them is
    // the only thing separating these two columns when the heading lies.
    return ints * plausible * (small > 0.9 ? 0.95 : 0.3);
  }],
  ["annual_revenue", (v) => {
    const ints = share(v, isIntLike);
    if (ints < 0.85) return 0;
    /* A BARE PHONE NUMBER IS A BIG INTEGER TOO.
     *
     * Every tab of the real sheet carries the switchboard twice. Once the
     * first copy takes company_phone, the second scored 0.44 as a phone —
     * below the floor — and 0.95 as revenue, because "5614062000" is an
     * integer over a hundred thousand. So a car dealership was imported with
     * five and a half billion dollars of revenue, under a printed note saying
     * the column holds phone numbers. Found 30 Aug 2026 by an adversarial
     * reviewer.
     *
     * Ten and eleven digit numbers in the North American range are refused
     * here. A firm with revenue in that range exists, but it is rarer than a
     * phone column, and the cost of the two mistakes is not symmetric: a
     * missing revenue is a blank, a phone in the revenue field is a number
     * somebody quotes. */
    const nums = v.filter(isIntLike).map(intOf);
    const phoney = nums.filter((n) => {
      const d = String(Math.abs(n)).length;
      return (d === 10 || d === 11) && Number.isInteger(n);
    }).length / (nums.length || 1);
    if (phoney > 0.7) return 0;
    const big = nums.filter((n) => n >= 100000).length / (nums.length || 1);
    return ints * (big > 0.7 ? 0.95 : 0.25);
  }],

  ["title", (v, m) => share(v, (x) => TITLE_WORDS.test(x) && x.length < 90) * 0.95
    // A job title is on almost every row. A typed note is on a handful.
    * ((m.fill ?? 1) > 0.6 ? 1 : 0.8)],

  ["company", (v) => {
    if (share(v, (x) => isEmail(x) || isUrl(x) || isPhone(x) || isIntLike(x)) > 0.3) return 0;
    const wordy = share(v, (x) => x.length <= 90 && !/[@]/.test(x));
    const many = uniqueCount(v) / (v.length || 1);          // firms repeat, but not much
    const looks = share(v, (x) => COMPANY_WORDS.test(x));
    /* Base 0.56, not 0.45. Plenty of firms are just "Bishop Ranch", and at
     * 0.45 a column of them could never clear the 0.5 floor on content — so
     * `company` could only ever be filled by a heading, and an EMPTY column
     * with the right heading beat a full column of real firm names. That
     * falsifies this file's own claim that the heading is a hint. Found
     * 30 Aug 2026 by an adversarial reviewer. */
    return wordy * Math.min(1, 0.56 + looks * 0.42) * (many > 0.25 ? 1 : 0.72);
  }],

  /* "Company Name for Emails" is Apollo's tidied copy of the firm name. It is
   * kept rather than dropped — CJ's mail merge uses it, so throwing it away
   * would mean the sheet held something the console does not. */
  ["company_alias", (v) => {
    /* A THRESHOLD, not "any at all". Written as a bare truthiness test first,
     * which meant one firm called "1823" — a real row on the Luxury Agents
     * tab — scored the whole column zero and lost the column. */
    if (share(v, (x) => isEmail(x) || isUrl(x) || isPhone(x) || isIntLike(x)) > 0.3) return 0;
    const wordy = share(v, (x) => x.length <= 90 && !/[@]/.test(x));
    const looks = share(v, (x) => COMPANY_WORDS.test(x));
    return wordy * Math.min(1, 0.45 + looks * 0.5) * 0.9;
  }],

  /* A FULL NAME COLUMN. Two or three capitalised words, almost all different,
   * and none of the words a firm's name ends in. Without a scorer for it, a
   * pasted list of the shape [name, company, town] had nothing that could win
   * `name`, and the town column took it — so every contact was called
   * "Los Angeles". Found 30 Aug 2026 by an adversarial reviewer. */
  ["name", (v) => {
    const twoWords = share(v, (x) => /^[\p{L}][\p{L}'’.-]*(\s+[\p{L}][\p{L}'’.-]*){1,2}$/u.test(x) && x.length <= 45);
    if (twoWords < 0.7) return 0;
    const varied = uniqueCount(v) / (v.length || 1);
    const firmish = share(v, (x) => COMPANY_WORDS.test(x));
    return twoWords * (varied > 0.75 ? 0.74 : 0.35) * (firmish > 0.15 ? 0.3 : 1);
  }],

  ["first_name", (v) => share(v, isSingleToken) * (uniqueCount(v) / (v.length || 1) > 0.4 ? 0.62 : 0.3)],
  ["last_name", (v) => share(v, isSingleToken) * (uniqueCount(v) / (v.length || 1) > 0.4 ? 0.6 : 0.3)],
  /* City and Company City are DELIBERATELY not scored here. A town name is one
   * or two capitalised words and so is a surname, a seniority band and the
   * word "Verified" — scoring it read the Jewelry tab's email-verification
   * column as the contact's city, and 821 first names on Luxury Agents as
   * cities too. The only thing that reliably identifies a town column is
   * sitting between an address line and a state, so geoRuns below decides
   * both of them and nothing else may.
   */

  ["vertical", (v) => {
    const short = share(v, (x) => x.length <= 60 && !isUrl(x) && !isEmail(x));
    const repeats = uniqueCount(v) <= Math.max(25, v.length * 0.25) ? 1 : 0.25;
    const industryish = share(v, (x) => /&|services|health|care|estate|legal|retail|goods|technology|construction|financial|practice|wellness/i.test(x));
    return short * repeats * Math.min(1, 0.3 + industryish * 0.7) * 0.9;
  }],

  ["next_step", (v, m) => {
    /* Free sentences a rep typed: three words or more, and none of the shapes
     * that belong to a real column.
     *
     * The first version accepted anything over twelve characters with a space
     * in it, which made "United States" a next step and cost the Real Estate
     * tab its Company Country column. A note reads like a sentence; a place
     * name does not. */
    const sentences = share(v, (x) => x.length > 15
      && x.split(/\s+/).length >= 3
      && !isUrl(x) && !isEmail(x) && !isBlob(x) && !isPhone(x)
      && !isPlaceLine(x) && !isStreetAddress(x)
      && !STATES.has(lower(x)) && !COUNTRIES.has(lower(x)));
    /* A next-step column is mostly EMPTY — it holds the handful of rows
     * somebody has actually worked. A column that is full on every row is a
     * job title, not a note, and reading 821 job titles as next steps is how
     * the Luxury Agents tab lost its Title column. */
    const sparse = (m.fill ?? 0) < 0.5 ? 1 : 0.35;
    return sentences * sparse * 0.7;
  }],

  ["sales_owner", (v, m) => {
    /* A HANDFUL of rep names, on SOME of the rows.
     *
     * The first version asked only for single tokens and twelve or fewer
     * distinct values — which is every ten-row sample of anything, including
     * the contacts' own names. On a pasted [name, company, town] list it took
     * the name column at 0.80 and the contacts were imported with no names at
     * all. Two more conditions, both true of a real owner column and of
     * nothing else: there are enough rows to judge, and most of them are
     * EMPTY, because most leads have not been claimed. Found 30 Aug 2026. */
    if (v.length < 15) return 0;
    if ((m.fill ?? 1) > 0.85) return 0;
    const names = share(v, (x) => isSingleToken(x) && x.length <= 30);
    const few = uniqueCount(v) <= 12 ? 1 : 0.15;
    return names * few * 0.8;
  }],
];

/** Every field's content score for one column. */
export function scoreColumn(values, meta = {}) {
  const out = {};
  const trust = trustOf({ ...meta, values });
  for (const [field, fn] of SCORERS) {
    const n = fn(values, meta) * trust;
    if (n > 0.05) out[field] = Math.min(1, n);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Is row 1 a heading row?                                             */
/* ------------------------------------------------------------------ */

/**
 * Decide whether the first row is column headings or the first person.
 *
 * The old importer had a tick-box for this and defaulted it to yes. On
 * "Luxury Agents" that ate Sabrina Ulicny and left the tab unreadable.
 *
 * A heading row looks unlike a data row in one specific way: it holds no
 * emails, no URLs, no phone numbers and no dates, while the rows under it are
 * full of them. That is the test — not a list of expected words, which is what
 * makes it survive an Apollo export nobody has seen before.
 */
export function detectHeaderRow(rows, { headerMatcher } = {}) {
  const first = (rows || [])[0] || [];
  const body = (rows || []).slice(1, 60);
  if (!first.length) return { hasHeader: false, why: "the tab is empty" };
  if (!body.length) return { hasHeader: true, why: "only one row, treated as headings" };

  const cells = first.map(s).filter(Boolean);
  if (!cells.length) return { hasHeader: false, why: "the first row is blank" };

  const dataShaped = (row) => {
    const vals = row.map(s).filter(Boolean);
    if (!vals.length) return 0;
    return vals.filter((v) => isEmail(v) || isUrl(v) || isPhone(v) || isDateish(v)).length / vals.length;
  };

  const firstIsData = dataShaped(first);
  const bodyIsData = body.reduce((a, r) => a + dataShaped(r), 0) / body.length;

  /* The first row carries as much email/URL/phone as the rows below it, so it
   * is one of them. 0.6 of the body's rate rather than "any at all": a real
   * heading row sometimes holds one stray value a person typed. */
  if (firstIsData > 0.15 && firstIsData >= bodyIsData * 0.6) {
    return { hasHeader: false, why: "the first row holds emails and web addresses, so it is a person, not a heading" };
  }

  /* Words we recognise as headings. Two is enough — a heading row is the only
   * place "First Name" and "Company Name" appear. */
  const known = headerMatcher ? cells.filter((c) => headerMatcher(c)).length : 0;
  if (known >= Math.min(2, cells.length)) {
    return { hasHeader: true, why: `${known} of ${cells.length} cells in the first row are column headings` };
  }

  /* WHEN IT CANNOT TELL, THE FIRST ROW IS A PERSON.
   *
   * This used to end at `hasHeader: firstIsData < 0.05` — no emails or URLs in
   * row 1 means row 1 is a heading row. But a tab of names, companies and
   * towns has no emails or URLs ANYWHERE, so the whole test collapsed and the
   * first person on it was eaten as a heading. That is the exact failure this
   * function was written to stop, still live for any list without web-shaped
   * columns. Found 30 Aug 2026 by an adversarial reviewer.
   *
   * The two mistakes do not cost the same. Reading a heading row as a person
   * makes ONE junk contact called "First Name", which lands on the list where
   * anybody can see it and delete it. Reading a person as a heading deletes
   * that person, silently, on every import for ever. So when the evidence runs
   * out, the answer is "a person", and the reason is printed either way. */
  if (known >= 1 && firstIsData < 0.05) {
    return { hasHeader: true, why: `the first row holds no data values and ${known} of its cells is a column heading` };
  }
  return {
    hasHeader: false,
    why: "nothing in the first row is recognisable as a column heading, so it was read as a person — a heading read as a person is one junk row you can see and delete, a person read as a heading is gone",
  };
}

/* ------------------------------------------------------------------ */
/* The six hand-filled columns                                         */
/* ------------------------------------------------------------------ */

/* Every tab of this workbook starts with the same six columns a human fills
 * in, in the same order, whether or not anything has been typed into them.
 * On "Luxury Agents" all six are empty on all 821 rows, so nothing about
 * their CONTENT can identify them — but their position and the fact that the
 * Apollo block starts right after them can.
 *
 * Used only when there is no heading row and the contact block starts at
 * column seven. It does NOT require the six to be empty — a column with
 * something in it that scored a human-block field keeps it, and one that
 * scored some other field blocks the rule entirely, so a real column is never
 * relabelled underneath its own data. Written as "only when the six columns
 * are blank" first, which described a check the code does not make. */
export const HUMAN_BLOCK = ["sales_owner", "contacted", "status", "first_contact", "last_touch", "next_step"];

/* ------------------------------------------------------------------ */
/* Two things the values alone cannot say                              */
/* ------------------------------------------------------------------ */

/* THE SIX HAND-FILLED COLUMNS ONLY EVER SIT ON THE LEFT.
 *
 * Every list CJ builds is the same shape: the columns the team types into,
 * then the block Apollo exported. So a column to the RIGHT of the contact's
 * name or email is never Sales Owner and never a Sales Cycle Status.
 *
 * Without this the Jewelry tab read its email-verification column — the word
 * "Verified" on all 70 rows — as the Sales Owner, and the real Sales Owner
 * column, which has one name in it, lost and was dropped. */
export const HUMAN_ONLY = new Set([...HUMAN_BLOCK, "notes"]);
const IDENTITY = ["first_name", "last_name", "name", "email", "title", "company"];

/** The four place shapes that cannot be mistaken for anything else in a lead
 * export. Deliberately NOT "a short word that is not a state" — that also
 * describes the Sales Owner column, the Seniority column and half the job
 * titles, and using it as an anchor read "Larry Pike" as a city. */
function geoAnchor(values) {
  if (share(values, isStreetAddress) > 0.6) return "street";
  if (share(values, isPlaceLine) > 0.6) return "place";
  if (share(values, (x) => COUNTRIES.has(lower(x))) > 0.6) return "country";
  if (share(values, (x) => STATES.has(lower(x))) > 0.6) return "state";
  return null;
}

/** A town name: words, not a state, not a country, and repeated across the
 * list the way towns are. Only ever consulted for the ONE column sitting
 * between an address anchor and a state anchor, so it never has to tell a
 * town from a surname on its own. */
function looksLikeTown(values) {
  if (!values.length) return false;
  if (share(values, (x) => isWordy(x) && !STATES.has(lower(x)) && !COUNTRIES.has(lower(x))) < 0.85) return false;
  return uniqueCount(values) / values.length < 0.9;
}

/**
 * Whose address is this — the contact's or the firm's?
 *
 * Nothing in the word "California" answers that, and it appears twice on most
 * of these tabs. What DOES answer it is which block the column sits in.
 * Apollo writes the contact's location first, as a plain "Walnut Creek,
 * California, United States" line and then city, state, country; then the
 * firm's, which always begins with a STREET address, because only a firm has
 * one. So a street address starts the firm's block, every time.
 *
 * Read whole runs, not single columns. This is the rule that stopped the Car
 * Dealership tab putting the contact's own town in the office address and the
 * office's town on the contact — which the heading row, being three columns
 * out of step, said to do.
 */
export function geoRuns(columns) {
  const anchors = columns
    .filter((c) => !c.beyond)
    .map((c) => ({ index: c.index, kind: geoAnchor(c.values) }))
    .filter((a) => a.kind);
  if (!anchors.length) return [];

  const runs = [];
  for (const a of anchors) {
    const last = runs[runs.length - 1];
    const near = last && a.index - last[last.length - 1].index <= 2;
    // A street address always opens the firm's block, however close it sits.
    if (near && a.kind !== "street") last.push(a);
    else runs.push([a]);
  }

  const out = [];
  runs.forEach((run, i) => {
    const hasStreet = run.some((a) => a.kind === "street");
    const hasPlace = run.some((a) => a.kind === "place");
    const owner = hasStreet ? "company" : hasPlace ? "person" : (i === 0 ? "person" : "company");
    /* A run with NEITHER a street address nor a location line is a guess.
     * Apollo omits Company Address on some searches, and then a block of
     * [city, state, country] could be the contact's or the firm's — nothing in
     * the values says which. The order is the only evidence there is, and it
     * is weak, so the caller is told rather than left to assume. Found 30 Aug
     * 2026 by an adversarial reviewer. */
    const guessed = !hasStreet && !hasPlace;
    const put = (index, field) => out.push({ index, field, owner, run: i, guessed });

    for (const a of run) {
      if (a.kind === "street") put(a.index, "company_address");
      else if (a.kind === "place") put(a.index, "address");
      else put(a.index, owner === "company" ? `company_${a.kind}` : a.kind);
    }

    /* The town. It is the single column between the address line and the
     * state — Apollo's order is address, city, state, country — so it is
     * found by its POSITION in the run rather than by its values, which is
     * the only thing that reliably tells a town from a surname. */
    const firstRegion = run.find((a) => a.kind === "state" || a.kind === "country");
    if (firstRegion) {
      const gap = firstRegion.index - 1;
      const isAnchor = anchors.some((a) => a.index === gap);
      const col = columns[gap];
      if (!isAnchor && col && !col.beyond && gap >= 0 && looksLikeTown(col.values)) {
        put(gap, owner === "company" ? "company_city" : "city");
      }
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Putting it together                                                 */
/* ------------------------------------------------------------------ */

/* How much a matching heading ADDS to a column's own score — it is never
 * compared against the content, only added to it, so a heading can only ever
 * improve a column's case for a field, never make one on its own.
 *
 * The size is what matters. At 0.55 it is smaller than the gap between a
 * strong content signal and a weak one, so on the Jewelry tab — where the
 * headings are three columns out of step — the right data still beats the
 * wrong heading, while a heading can still settle first-name from last-name,
 * which content genuinely cannot. A header-only pair, from a column with
 * nothing in it at all, is considered after every pair that has content behind
 * it, whatever the arithmetic says. */
const HEADER_BONUS = 0.55;

/* A field will not be filled from a column scoring under this. Better an
 * empty field than a switchboard number in a rep's direct-dial box. */
const FLOOR = 0.5;

/**
 * Work out the whole mapping for one tab.
 *
 * @param rows        every row of the tab, first row included
 * @param headerGuess (heading text) => field key or "" — the old heading rules
 * @param fields      the list of field keys that may be assigned
 * @returns { mapping, hasHeader, headerWhy, notes, confidence }
 *
 * `notes` is the honest half: every column the heading and the data disagreed
 * about, every column left out, and why. The import screen prints it.
 */
export function mapColumns(rows, { headerGuess, fields, sample = 120 } = {}) {
  const grid = rows || [];
  const width = grid.reduce((m, r) => Math.max(m, (r || []).length), 0);
  const allowed = new Set(fields || []);

  const notes = [];
  const head = detectHeaderRow(grid, { headerMatcher: (c) => !!headerGuess(c) });
  const hasHeader = head.hasHeader;
  const headerRow = hasHeader ? (grid[0] || []) : [];
  const skipFirst = hasHeader ? 1 : 0;

  /* ---- score every column ---- */
  const columns = [];
  for (let i = 0; i < width; i += 1) {
    const { values, fill, filled, seen } = columnSample(grid, i, { cap: sample, skipFirst });
    const content = scoreColumn(values, { fill, filled, seen });
    const headerText = s(headerRow[i]);
    const headerField = headerText ? headerGuess(headerText) : "";
    columns.push({ index: i, values, fill, filled, headerText, headerField, content });
  }

  /* ---- where the list stops ----
   *
   * The real Car Dealership tab is 72 columns wide. Columns 1 to 32 are the
   * list; after that somebody has pasted a SECOND record block alongside it,
   * with its own address, city, state, country, company address, phone,
   * keywords and revenue. Its Keywords column was beating the real one by a
   * hundredth of a point and the real one was being dropped.
   *
   * One contact has one firm, and one firm has one street address and one
   * email. So a SECOND street-address column, or a second email column, is
   * where this record ends and something else begins. Everything from there
   * on is left out — which is what was asked for: bring in everything there is
   * a row for, and leave the rest.
   */
  /* A SECOND EMAIL IS NORMAL — a work address and a personal one. Using it as
   * the end of the list cut six real columns (phone, website, LinkedIn, city,
   * state, country) off any tab that carried both. Only a repeated ADDRESS
   * block marks a second record, because a contact has one office and one
   * home town, and Apollo writes each exactly once. Found 30 Aug 2026 by an
   * adversarial reviewer. */
  const MARKERS = {
    street: isStreetAddress,   // a firm has one street address
    place: isPlaceLine,        // a contact has one "town, state, country" line
  };
  const marker = (kind) => columns
    .filter((c) => share(c.values, MARKERS[kind]) > 0.6)
    .map((c) => c.index);
  let cut = width;
  for (const kind of Object.keys(MARKERS)) {
    const at = marker(kind);
    if (at.length > 1) cut = Math.min(cut, at[1]);
  }
  if (cut < width) {
    notes.push({
      kind: "extra",
      why: `Column ${cut + 1} starts a second copy of the same kind of record — a second company address, a second location line or a second email — so this list was read as columns 1 to ${cut}, and everything after that was left out.`,
    });
    /* Marked as well as emptied. geoRuns reads the VALUES, not the scores, so
     * clearing the scores alone left the second block's Country column still
     * winning the contact's country — the exact failure this cut exists to
     * stop, surviving the fix for it.
     *
     * The heading is cleared too. The header-only branch below re-adds any
     * column whose heading names a spare field, at a score above the floor —
     * so without this the cut was a no-op on every tab whose second block had
     * recognisable headings, which is to say on every tab where it mattered.
     * It only ever fired where it did damage. Found 30 Aug 2026. */
    for (let i = cut; i < width; i += 1) {
      columns[i].content = {};
      columns[i].beyond = true;
      columns[i].headerField = "";
    }
  }

  /* ---- pinned by position, before anything else ----
   *
   * Two columns of one capitalised word each, immediately to the left of the
   * job title, are the given name and the surname. Nothing in the VALUES says
   * so — "Sabrina" and "Los Angeles" are both one capitalised word — which is
   * why the Luxury Agents tab read 821 people's names as City and Company
   * City until this existed.
   *
   * Only used where the heading row does not already answer it. A heading that
   * says "First Name" is better evidence than any shape rule. */
  const pinned = new Map();
  const strong = (i, field, min) => (columns[i]?.content?.[field] ?? 0) >= min;
  const namey = (i) => {
    const col = columns[i];
    if (!col || col.headerField) return false;
    if (col.values.length < 8) return false;
    const tokens = share(col.values, isSingleToken);
    const varied = uniqueCount(col.values) / col.values.length;
    return tokens > 0.85 && varied > 0.55;
  };
  const titleCol = columns.findIndex((c) => strong(c.index, "title", 0.5));
  if (titleCol >= 2 && !columns[titleCol - 1]?.headerField && !columns[titleCol - 2]?.headerField
      && namey(titleCol - 1) && namey(titleCol - 2)) {
    pinned.set(titleCol - 2, "first_name");
    pinned.set(titleCol - 1, "last_name");
    notes.push({
      kind: "position",
      why: `This tab has no heading for them, so columns ${titleCol - 1} and ${titleCol} were read as first name and last name — they are two columns of single names sitting immediately before the job title.`,
    });
  }

  /* ---- candidate pairs ---- */
  const pairs = [];
  for (const col of columns) {
    const seen = new Set();
    for (const [field, score] of Object.entries(col.content)) {
      if (!allowed.has(field)) continue;
      seen.add(field);
      const bonus = col.headerField === field ? HEADER_BONUS : 0;
      /* NOT capped at 1. Two columns can both hold country names — the
       * contact's and the firm's — and then the only thing separating them is
       * which one is headed "Company Country". Capping the sum threw that away
       * and handed the firm's field to the contact's column, purely because it
       * came first. */
      pairs.push({ col: col.index, field, score: score + bonus, content: score, fromHeader: bonus > 0 });
    }
    /* A heading nothing in the data confirms is still worth something — an
     * empty "Last Touch" column has no content to read, and dropping it would
     * lose the column the moment somebody starts filling it in. */
    if (col.headerField && allowed.has(col.headerField) && !seen.has(col.headerField)) {
      pairs.push({ col: col.index, field: col.headerField, score: HEADER_BONUS + (col.fill < 0.02 ? 0.06 : 0), content: 0, fromHeader: true, headerOnly: true });
    }
  }

  /* ---- greedy assignment: best pair first, one field and one column each ----
   *
   * Greedy rather than clever. A full optimal assignment would let a weak pair
   * displace a strong one to raise a total score, and "the column I am 96%
   * sure is the website" must never lose its field to arithmetic. */
  /* REAL DATA BEATS AN EMPTY LABEL, ALWAYS.
   *
   * Sorting on score alone let a header-only pair (0.55, from a column with
   * nothing in it) beat a column full of plain firm names scoring 0.56 — so
   * on a tab whose heading row is shifted by one, `company` went to the empty
   * column and fourteen real firm names were dropped. Any pair with content
   * behind it is now considered before any pair without, whatever the
   * arithmetic says. Found 30 Aug 2026 by an adversarial reviewer. */
  pairs.sort((a, b) => (b.content > 0) - (a.content > 0) || b.score - a.score || a.col - b.col);
  const mapping = new Array(width).fill("");
  const takenField = new Map();
  const confidence = {};

  /* Pinned first, so a shape rule that knows something the values cannot say
   * is never outvoted by a score. */
  for (const [col, field] of pinned) {
    if (!allowed.has(field) || takenField.has(field)) continue;
    mapping[col] = field;
    takenField.set(field, { col, field, score: 0.9, content: 0 });
    confidence[col] = 0.9;
  }

  /* Where the contact's own details start. Everything left of it is the block
   * the team types into; everything right of it came out of Apollo. */
  let identityAt = width;
  for (const col of columns) {
    const best = Object.entries(col.content).sort((a, b) => b[1] - a[1])[0];
    const isIdentity = (col.headerField && IDENTITY.includes(col.headerField))
      || (best && IDENTITY.includes(best[0]) && best[1] >= 0.6);
    if (isIdentity) { identityAt = Math.min(identityAt, col.index); }
  }

  for (const p of pairs) {
    if (p.score < FLOOR) continue;
    if (mapping[p.col]) continue;
    if (takenField.has(p.field)) continue;
    /* A Sales Owner column to the right of the contact's name is not a Sales
     * Owner column. Skipped rather than scored down, because a wrong answer
     * here also DENIES the field to the column that really holds it. */
    if (HUMAN_ONLY.has(p.field) && p.col > identityAt && !p.fromHeader) continue;
    if (HUMAN_ONLY.has(p.field) && p.col > identityAt && p.content < 0.9) continue;
    mapping[p.col] = p.field;
    takenField.set(p.field, p);
    confidence[p.col] = p.score;
  }

  /* ---- whose city is it ---- */
  const geo = geoRuns(columns);
  if (geo.length) {
    const guessedRuns = [...new Set(geo.filter((g) => g.guessed).map((g) => g.run))];
    for (const run of guessedRuns) {
      const cols2 = geo.filter((g) => g.run === run);
      notes.push({
        kind: "geo",
        why: `Columns ${cols2.map((g) => g.index + 1).sort((a, b) => a - b).join(", ")} hold a town, a state or a country, and there is no street address beside them to say whose they are. They were read as ${cols2[0].owner === "company" ? "the firm's" : "the contact's"} — check that, because nothing in the values themselves decides it.`,
      });
    }
    /* Clear whatever the scores guessed for these columns first: half-applying
     * a correction leaves the field on the old column AND the new one, and the
     * second write silently loses. */
    for (const g of geo) {
      const had = mapping[g.index];
      if (!had) continue;
      if (takenField.get(had)?.col === g.index) takenField.delete(had);
      mapping[g.index] = "";
      delete confidence[g.index];
    }
    for (const g of geo) {
      if (!allowed.has(g.field) || takenField.has(g.field)) continue;
      mapping[g.index] = g.field;
      takenField.set(g.field, { col: g.index, field: g.field, score: 0.85, content: 0.85 });
      confidence[g.index] = 0.85;
    }
    /* Anything the correction emptied and did not refill goes back to its
     * heading, if the heading named a field still going spare. A column left
     * blank by a fix is a column of data thrown away. */
    for (const col of columns) {
      if (mapping[col.index] || !col.headerField) continue;
      if (!allowed.has(col.headerField) || takenField.has(col.headerField)) continue;
      mapping[col.index] = col.headerField;
      takenField.set(col.headerField, { col: col.index, field: col.headerField, score: HEADER_BONUS, content: 0 });
      confidence[col.index] = HEADER_BONUS;
    }
  }

  /* ---- the hand-filled block, when there is no heading row ----
   *
   * Every list in this workbook starts with the same six columns the team
   * types into, in the same order, whether or not anything has been typed yet.
   * On "Luxury Agents" nobody has, so there is nothing in them to read — and
   * a column with nothing in it can never be identified by its content.
   *
   * The position identifies them instead: if the contact block starts at
   * column seven with no heading row above it, columns one to six are that
   * template. Claiming them now is what makes the columns work the day
   * somebody types a status into one, rather than on the next import. */
  if (!hasHeader) {
    const anchor = ["first_name", "name", "email"]
      .map((f) => mapping.indexOf(f)).filter((i) => i >= 0).sort((x, y) => x - y)[0];
    const roomFor = (i) => !mapping[i] || HUMAN_ONLY.has(mapping[i]);
    if (anchor === HUMAN_BLOCK.length
        && HUMAN_BLOCK.every((_, i) => roomFor(i))) {
      HUMAN_BLOCK.forEach((field, i) => {
        const had = mapping[i];
        if (had === field) return;
        if (had && takenField.get(had)?.col === i) takenField.delete(had);
        if (takenField.has(field) || !allowed.has(field)) { mapping[i] = ""; return; }
        mapping[i] = field;
        takenField.set(field, { col: i, field, score: 0.5, content: 0 });
        confidence[i] = 0.5;
      });
      notes.push({
        kind: "template",
        why: "This tab has no heading row and the contact details start at column 7, which is this workbook's own layout. Columns 1 to 6 were read as Sales Owner, Contacted?, Sales Cycle Status, First Contact, Last Touch and Next Steps, so they work the moment somebody types into one.",
      });
    }
  }

  /* ---- first name before last name ----
   *
   * Content cannot tell them apart: both are one capitalised word. Left to the
   * scores it comes down to which happened to sort first, which is a coin
   * toss. On every export of this shape the given name is the left-hand one. */
  const fnCol = mapping.indexOf("first_name");
  const lnCol = mapping.indexOf("last_name");
  if (fnCol >= 0 && lnCol >= 0 && fnCol > lnCol
      && !columns[fnCol].headerField && !columns[lnCol].headerField) {
    mapping[fnCol] = "last_name";
    mapping[lnCol] = "first_name";
    notes.push({ kind: "order", why: "First and last name were read left to right — there is nothing in the values themselves that tells them apart." });
  }

  /* ---- a given name and a surname always arrive together ----
   *
   * Nothing in the values tells a first name from a town: both are one
   * capitalised word. What DOES tell them apart is that an export writes the
   * two of them side by side. A lone `first_name` with no `last_name` beside
   * it is a column of something else — on a [name, company, town] list it was
   * the town, and every contact came in called "Los Angeles".
   *
   * A heading that says so is still believed; this only governs the case where
   * the values were the only evidence. Found 30 Aug 2026. */
  for (const f of ["first_name", "last_name"]) {
    const at = mapping.indexOf(f);
    if (at < 0) continue;
    if (columns[at].headerField === f) continue;             // the heading said so
    const partner = f === "first_name" ? "last_name" : "first_name";
    const other = mapping.indexOf(partner);
    if (other >= 0 && Math.abs(other - at) === 1) continue;  // they are side by side
    mapping[at] = "";
    takenField.delete(f);
    delete confidence[at];
    notes.push({
      kind: "pair",
      column: at + 1,
      why: `Column ${at + 1} looked like a column of first names, but there is no surname column beside it and no heading to confirm it, so it was left out rather than guessed at.`,
    });
  }

  /* ---- say where the heading and the data disagreed ---- */
  for (const col of columns) {
    const got = mapping[col.index];
    if (!col.headerField || col.headerField === got) continue;
    if (!allowed.has(col.headerField)) continue;
    const winner = takenField.get(col.headerField);
    notes.push({
      kind: "override",
      column: col.index + 1,
      header: col.headerText,
      why: got
        ? `Column ${col.index + 1} is headed "${col.headerText}" but holds ${describe(col.values)}, so it was read as ${got.replace(/_/g, " ")} instead.`
        : `Column ${col.index + 1} is headed "${col.headerText}" but holds ${describe(col.values)}, which does not match, so it was left out.`
        + (winner ? ` "${col.headerText}" was taken from column ${winner.col + 1} instead.` : ""),
    });
  }

  return { mapping, hasHeader, headerWhy: head.why, notes, confidence, width };
}

/** One short phrase for what is actually in a column, for the notes above.
 * Kept plain: a person reading the import screen should not have to know what
 * a regular expression is to check our work. */
export function describe(values) {
  if (!values.length) return "nothing";
  const tests = [
    [isEmail, "email addresses"],
    [isPersonLinkedIn, "personal LinkedIn addresses"],
    [isCompanyLinkedIn, "company LinkedIn addresses"],
    [isFacebook, "Facebook addresses"],
    [isTwitter, "Twitter addresses"],
    [isPlainSite, "web addresses"],
    [isPhone, "phone numbers"],
    [isDateish, "dates"],
    [isStreetAddress, "street addresses"],
    [isBlob, "long lists of keywords"],
    [(v) => STATES.has(lower(v)), "US states"],
    [(v) => COUNTRIES.has(lower(v)), "country names"],
    [isPlaceLine, "city, state and country lines"],
    [isIntLike, "numbers"],
  ];
  for (const [fn, label] of tests) {
    if (share(values, fn) > 0.7) return label;
  }
  return `text like "${values[0].slice(0, 28)}"`;
}
