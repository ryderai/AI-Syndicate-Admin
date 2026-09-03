/* WHAT KIND OF BUSINESS THIS IS — 2 Sep 2026.
 *
 * Ryder: "in the ad contact make sure there's always all the options for adding
 * industries such as tech finance construction etc."
 *
 * Before this there was NO list anywhere in the console. `vertical` was free
 * text in three different places with three different placeholders — "realtor /
 * lawyer / …", "medical spa", and a bare "Industry" — so the same trade got
 * typed four ways and the sheet's Industry grouping counted each spelling as
 * its own line. The values actually in the data prove it: `realtor` AND
 * `real estate`, `medspa` AND `medical spa`, `lawyer` AND `legal`.
 *
 * TWO RULES:
 *
 * 1. THE STORED VALUE MATCHES WHAT IS ALREADY THERE. `value` is the string
 *    written to `admin_leads.vertical` / `admin_companies.vertical`, and for
 *    every trade already in the data it is spelled exactly as the existing rows
 *    spell it — `realtor`, `medspa`, `lawyer`, `car dealership`, `roofing`. A
 *    prettier slug would have started a fifth spelling.
 *
 * 2. FREE TEXT STILL WORKS. The column stays text and nothing is rewritten.
 *    A row holding `real estate` keeps it and keeps displaying it; the picker
 *    offers `Other…` so a trade nobody thought of can still be typed. A list
 *    that cannot be escaped gets worked around with a wrong answer.
 */

/** value = what is stored. label = what a person reads. group = the optgroup. */
export const BUSINESS_TYPES = [
  /* Property and building — the agency's own home ground. */
  { value: "realtor", label: "Realtor / real estate agent", group: "Property & building" },
  { value: "property management", label: "Property management", group: "Property & building" },
  { value: "mortgage", label: "Mortgage / lending", group: "Property & building" },
  { value: "title insurance", label: "Title & escrow", group: "Property & building" },
  { value: "construction", label: "Construction / general contractor", group: "Property & building" },
  { value: "home builder", label: "Home builder", group: "Property & building" },
  { value: "architect", label: "Architecture & design", group: "Property & building" },
  { value: "interior design", label: "Interior design", group: "Property & building" },

  /* Trades and home services. */
  { value: "roofing", label: "Roofing", group: "Trades & home services" },
  { value: "hvac", label: "HVAC / heating & cooling", group: "Trades & home services" },
  { value: "plumbing", label: "Plumbing", group: "Trades & home services" },
  { value: "electrical", label: "Electrical", group: "Trades & home services" },
  { value: "landscaping", label: "Landscaping & lawn", group: "Trades & home services" },
  { value: "pest control", label: "Pest control", group: "Trades & home services" },
  { value: "cleaning", label: "Cleaning services", group: "Trades & home services" },
  { value: "solar", label: "Solar", group: "Trades & home services" },
  { value: "pool", label: "Pools & spas", group: "Trades & home services" },
  { value: "moving", label: "Moving & storage", group: "Trades & home services" },

  /* Professional services. */
  { value: "lawyer", label: "Law firm", group: "Professional services" },
  { value: "accounting", label: "Accounting & bookkeeping", group: "Professional services" },
  { value: "insurance", label: "Insurance", group: "Professional services" },
  { value: "consulting", label: "Consulting", group: "Professional services" },
  { value: "staffing", label: "Staffing & recruiting", group: "Professional services" },
  { value: "marketing agency", label: "Marketing / advertising agency", group: "Professional services" },
  { value: "it services", label: "IT services & managed IT", group: "Professional services" },

  /* Money. */
  { value: "finance", label: "Finance", group: "Money" },
  { value: "financial advisor", label: "Financial advice & wealth", group: "Money" },
  { value: "bank", label: "Bank or credit union", group: "Money" },
  { value: "fintech", label: "Fintech", group: "Money" },

  /* Tech and media. */
  { value: "tech", label: "Tech", group: "Tech & media" },
  { value: "saas", label: "Software / SaaS", group: "Tech & media" },
  { value: "ecommerce", label: "Ecommerce", group: "Tech & media" },
  { value: "media", label: "Media & publishing", group: "Tech & media" },

  /* Health and wellness. */
  { value: "medspa", label: "Med spa", group: "Health & wellness" },
  { value: "dentist", label: "Dental", group: "Health & wellness" },
  { value: "chiropractor", label: "Chiropractic", group: "Health & wellness" },
  { value: "veterinary", label: "Veterinary", group: "Health & wellness" },
  { value: "medical practice", label: "Medical practice / clinic", group: "Health & wellness" },
  { value: "mental health", label: "Therapy & counselling practice", group: "Health & wellness" },
  { value: "gym", label: "Gym & fitness", group: "Health & wellness" },
  { value: "salon", label: "Salon & barber", group: "Health & wellness" },

  /* Auto. */
  { value: "car dealership", label: "Car dealership", group: "Auto" },
  { value: "auto repair", label: "Auto repair & service", group: "Auto" },
  { value: "auto detailing", label: "Auto detailing & wraps", group: "Auto" },

  /* Retail, food, events. */
  { value: "restaurant", label: "Restaurant / bar", group: "Retail, food & events" },
  { value: "retail", label: "Retail shop", group: "Retail, food & events" },
  { value: "events", label: "Events & venues", group: "Retail, food & events" },
  { value: "photography", label: "Photography & video", group: "Retail, food & events" },
  { value: "travel", label: "Travel & hospitality", group: "Retail, food & events" },

  /* Everything else. */
  { value: "education", label: "Education & training", group: "Other" },
  { value: "nonprofit", label: "Non-profit", group: "Other" },
  { value: "manufacturing", label: "Manufacturing & industrial", group: "Other" },
  { value: "logistics", label: "Logistics & trucking", group: "Other" },
  { value: "agriculture", label: "Agriculture", group: "Other" },
  { value: "energy", label: "Energy & utilities", group: "Other" },
  { value: "government", label: "Government & public sector", group: "Other" },
];

/** The optgroups, in the order they should be drawn. */
export const BUSINESS_TYPE_GROUPS = [...new Set(BUSINESS_TYPES.map((t) => t.group))];

const BY_VALUE = new Map(BUSINESS_TYPES.map((t) => [t.value, t]));

/** Is this one of the values the picker offers? */
export function isKnownBusinessType(value) {
  return BY_VALUE.has(String(value ?? "").trim().toLowerCase());
}

/**
 * What to show for a stored value.
 *
 * A value the picker does not offer is returned AS IT WAS TYPED, not blanked
 * and not silently mapped to something near it. There are rows holding
 * `real estate` and `medical spa` from before this list existed, and showing
 * them is how somebody notices and fixes them.
 */
export function businessTypeLabel(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  return BY_VALUE.get(v.toLowerCase())?.label || v;
}

/**
 * The list to offer, with anything already on the record kept on it.
 *
 * Same rule the people pickers follow: a screen must never contradict the
 * database. If a lead's industry is `real estate`, that has to be selectable or
 * the dropdown shows a different answer from the record it is editing.
 */
export function businessTypeOptions(current = null) {
  const cur = String(current ?? "").trim();
  const extra = cur && !isKnownBusinessType(cur)
    ? [{ value: cur, label: `${cur} (already on this record)`, group: "Already on this record" }]
    : [];
  return [...extra, ...BUSINESS_TYPES];
}
