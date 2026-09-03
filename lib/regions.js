/* WHERE THEY ARE — 2 Sep 2026.
 *
 * Ryder: "when people are adding a contact, we need to make sure that they can
 * add them as a Canadian as well."
 *
 * `admin_leads.country` has existed since migration 0025 and `admin_companies.
 * country` since 0009. NOTHING in the console ever read or wrote either one
 * except the spreadsheet importer — so a contact added by hand had a city and a
 * state and no country at all, and a Canadian one had a province typed into a
 * field labelled "FL".
 *
 * THREE RULES:
 *
 * 1. THE CODE IS WHAT IS STORED. Two letters, upper case: `FL`, `ON`, `BC`.
 *    The rows already in the database are a MIX of `FL` and `California`
 *    (both spellings are in the sample data), which is why grouping by state
 *    double-counts today. Nothing here rewrites those rows — that is a data
 *    decision, not a code one — but everything written from now on is a code,
 *    and `normaliseRegion` turns a full name into one on the way in.
 *
 * 2. A PLACE THIS LIST DOES NOT KNOW IS STILL ALLOWED. `country: "other"` keeps
 *    the region a free text box. A picker that cannot be escaped gets worked
 *    around with a wrong answer, and "not in the dropdown" is not the same as
 *    "not a real place".
 *
 * 3. NOTHING IS INFERRED. A blank country stays blank rather than becoming US.
 *    Guessing the country of every row already in the table would put a fact in
 *    the database that nobody established.
 */

export const COUNTRIES = [
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "other", label: "Somewhere else" },
];

/** US states, DC and the territories that have ZIP codes. */
export const US_REGIONS = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["PR", "Puerto Rico"], ["VI", "U.S. Virgin Islands"], ["GU", "Guam"],
];

/** All ten provinces and all three territories. */
export const CA_REGIONS = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"],
  ["NB", "New Brunswick"], ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"], ["NT", "Northwest Territories"], ["NU", "Nunavut"],
  ["ON", "Ontario"], ["PE", "Prince Edward Island"], ["QC", "Quebec"],
  ["SK", "Saskatchewan"], ["YT", "Yukon"],
];

/** What the region field is CALLED, which is not the same word in both places. */
export const REGION_LABEL = { US: "State", CA: "Province", other: "State or region" };

export function regionsFor(country) {
  const c = String(country ?? "").trim().toUpperCase();
  if (c === "US") return US_REGIONS;
  if (c === "CA") return CA_REGIONS;
  return [];
}

/**
 * Turn whatever somebody has into a country code, or null.
 *
 * Accepts the code, the full name, and the spellings that turn up in exported
 * spreadsheets. Returns null for anything else rather than guessing — see
 * rule 3.
 */
export function normaliseCountry(value) {
  const v = String(value ?? "").trim().toLowerCase().replace(/\./g, "");
  if (!v) return null;
  if (["us", "usa", "u s", "u s a", "united states", "united states of america", "america"].includes(v)) return "US";
  if (["ca", "can", "canada"].includes(v)) return "CA";
  if (v === "other") return "other";
  return null;
}

/**
 * Turn whatever somebody has into a region code for that country, or null.
 *
 * `Georgia` is the trap: it is a US state here and a country elsewhere, so this
 * only ever answers within a country that has been established — it never
 * decides the country from the region.
 */
export function normaliseRegion(country, value) {
  const list = regionsFor(country);
  const v = String(value ?? "").trim();
  if (!v || !list.length) return v || null;
  const up = v.toUpperCase();
  if (list.some(([code]) => code === up)) return up;
  const byName = list.find(([, name]) => name.toLowerCase() === v.toLowerCase());
  return byName ? byName[0] : v;
}

/** What to show for a stored region. An unknown one is shown as typed. */
export function regionLabel(country, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const hit = regionsFor(country).find(([code]) => code === v.toUpperCase());
  return hit ? hit[1] : v;
}

/** One line: "Destin, FL" / "Toronto, ON, Canada". Blank parts are dropped. */
export function placeLine({ city, state, country } = {}) {
  const c = normaliseCountry(country);
  const bits = [String(city ?? "").trim(), String(state ?? "").trim()].filter(Boolean);
  /* The country is only worth printing when it is NOT the one most rows are —
   * "Destin, FL, United States" on every American row is noise that pushes the
   * useful part off the end of a cell. */
  if (c && c !== "US") {
    bits.push(COUNTRIES.find((x) => x.code === c)?.label || String(country).trim());
  }
  return bits.join(", ");
}
