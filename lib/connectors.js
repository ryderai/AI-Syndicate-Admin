/* The client's own accounts — what we can connect, and what each one answers.
 *
 * PURE. No imports, no database, no fetch. The browser reads it to draw the
 * Connections tab; the server reads it to decide what to ask Google for; the
 * tests read it against the database constraint in migration 0013. One list,
 * three readers — a picker offering a provider the database refuses is the
 * bug this shape prevents.
 *
 * PLAIN WORDS FIRST, because these are all initials:
 *   GSC  — Google Search Console. Shows how often the client's site appeared
 *          in Google and how many people clicked it.
 *   GBP  — Google Business Profile. The map/business listing. Shows calls,
 *          direction taps, website taps and how people found it.
 *   GA4  — Google Analytics 4. Shows what people did once on the site.
 *   Bing — Bing Webmaster Tools. Same idea as Search Console, for Bing —
 *          which is what Copilot searches with.
 */

export const PROVIDERS = ["gsc", "gbp", "ga4", "bing", "other"];

export const PROVIDER_LABELS = {
  gsc: "Google Search Console",
  gbp: "Google Business Profile",
  ga4: "Google Analytics 4",
  bing: "Bing Webmaster Tools",
  other: "Something else",
};

/** The short name used where space is tight. */
export const PROVIDER_SHORT = {
  gsc: "Search Console",
  gbp: "Business Profile",
  ga4: "Analytics",
  bing: "Bing",
  other: "Other",
};

export const PROVIDER_HELP = {
  gsc: "How often their website showed up in Google search, and how many people clicked it. Also which searches brought people in.",
  gbp: "Their Google map listing. Phone calls, direction taps, website taps, and how many people saw it.",
  ga4: "What people did once they were on the website — visits, where they came from, how many took action.",
  bing: "The same as Search Console, but for Bing. Worth having because Microsoft Copilot searches with Bing.",
  other: "Anything else worth writing down. Numbers get typed in by hand.",
};

/** What a report can honestly say once this one is connected. Shown on the
 * card, so the reason for connecting is on screen next to the button. */
export const PROVIDER_ANSWERS = {
  gsc: ["Times shown in Google", "Clicks from Google", "Average position", "Top searches", "Top pages"],
  gbp: ["Calls from the listing", "Direction taps", "Website taps", "Times the listing was shown"],
  ga4: ["Visitors", "Sessions", "Where visitors came from", "Actions taken"],
  bing: ["Clicks from Bing", "Times shown in Bing"],
  other: ["Whatever is typed in"],
};

/** Which ones connect with a Google sign-in. The rest are typed in by hand
 * for now — named here rather than assumed, because a card that offers a
 * Connect button that cannot work is worse than one that says "type it in". */
export const GOOGLE_PROVIDERS = ["gsc", "gbp", "ga4"];

export function isGoogleProvider(provider) {
  return GOOGLE_PROVIDERS.includes(provider);
}

/* The permissions each one needs, read-only in every case.
 *
 * READ-ONLY IS NOT A DETAIL. These tokens sit in our database. The widest
 * thing anybody holding one can do is look at numbers the client already sees
 * — they cannot edit a listing, change a site, or delete anything. Google
 * offers write scopes for all three; we never ask for them. */
export const PROVIDER_SCOPES = {
  gsc: ["https://www.googleapis.com/auth/webmasters.readonly"],
  ga4: ["https://www.googleapis.com/auth/analytics.readonly"],
  // Business Profile has no "readonly" scope of its own — this one covers
  // manage and read alike. The console only ever calls GET endpoints with it,
  // and that is a promise the code keeps, not one Google enforces. Say so out
  // loud rather than letting the scope list imply read-only.
  gbp: ["https://www.googleapis.com/auth/business.manage"],
};

export const SCOPE_IS_READ_ONLY = { gsc: true, ga4: true, gbp: false };

/** Everything a connect for this provider asks for, including who you are. */
export function scopesFor(provider) {
  const own = PROVIDER_SCOPES[provider];
  if (!own) return null;
  return [...own, "openid", "email"];
}

/** True when a stored connection was granted less than it now needs — the
 * person has to connect again. Checked against the scope string Google
 * returned, never guessed from a date. */
export function connectionNeedsReconnect(provider, scope) {
  const need = PROVIDER_SCOPES[provider];
  if (!need) return false;
  const got = String(scope || "");
  return need.some((s) => !got.includes(s));
}

/* ------------------------------------------------------------------ */
/* Properties                                                          */
/* ------------------------------------------------------------------ */

/**
 * What "one property" means for each provider, in the exact shape its API
 * wants. A connection row holds ONE of these, because a Google login can see
 * twenty sites and a report about "the site" has to say which.
 */
export const PROPERTY_HELP = {
  gsc: "The exact site in Search Console. Looks like sc-domain:example.com or https://example.com/",
  ga4: "The Analytics property. Looks like properties/123456789",
  gbp: "The one business location. Looks like locations/1234567890",
  bing: "The site address as Bing has it.",
  other: "Whatever names the account.",
};

/** Tidy a property string the way its own API writes it. Returns null for
 * anything empty, so a blank box never becomes the string "null". */
export function normalizeProperty(provider, raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (provider === "ga4") {
    const digits = v.replace(/^properties\//, "").trim();
    return /^\d+$/.test(digits) ? `properties/${digits}` : v;
  }
  if (provider === "gbp") {
    if (/^locations\/\d+$/.test(v)) return v;
    const m = /(?:^|\/)locations\/(\d+)/.exec(v);
    if (m) return `locations/${m[1]}`;
    if (/^\d+$/.test(v)) return `locations/${v}`;
    return v;
  }
  return v;
}

/** How a property should read on screen: short, and never a bare id. */
export function prettyProperty(provider, property, fallback = "") {
  const v = String(property || "").trim();
  if (!v) return fallback;
  if (provider === "gsc") return v.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (provider === "ga4") return v.replace(/^properties\//, "Property ");
  if (provider === "gbp") return v.replace(/^locations\//, "Location ");
  return v;
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export const STATUSES = ["manual", "connected", "needs_reconnect", "error"];

export const STATUS_LABELS = {
  manual: "Typed in by hand",
  connected: "Connected",
  needs_reconnect: "Connect again",
  error: "Not working",
};

export const STATUS_HELP = {
  manual: "Nobody has signed in to this account here. Any numbers on it were typed in by a person.",
  connected: "We can read this account's numbers whenever we want.",
  needs_reconnect: "The sign-in no longer covers what we need. One press fixes it.",
  error: "The last read failed. The reason is on the card.",
};

/** Can the server actually pull numbers for this row right now? */
export function canSync(row) {
  return Boolean(
    row &&
    row.active !== false &&
    row.auth_kind === "google" &&
    row.property &&
    (row.status === "connected" || row.status === "error")
  );
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

/* Google Search Console data settles about two days late, and Business
 * Profile is worse. Asking for "up to today" reliably returns a number that
 * is too small and then grows — which reads as a drop in the next report.
 * Every window therefore ENDS at a lag, and the lag is named here rather
 * than hidden inside a fetch. */
export const REPORT_LAG_DAYS = { gsc: 3, ga4: 1, gbp: 5, bing: 3, other: 0 };

export const RANGES = [
  { id: "28d", label: "Last 28 days", days: 28 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "7d", label: "Last 7 days", days: 7 },
];

export function rangeById(id) {
  return RANGES.find((r) => r.id === id) || RANGES[0];
}

/** ISO day string, no clock reading — the caller passes the time in, so the
 * same inputs always produce the same window. */
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The start and end dates to ask for, given a provider, a range and now.
 * End is pulled back by that provider's lag; start is `days` before the end,
 * counting the end day itself, so "last 28 days" is 28 days and not 29.
 */
export function windowFor(provider, rangeId, nowMs) {
  const days = rangeById(rangeId).days;
  const lag = REPORT_LAG_DAYS[provider] ?? 0;
  const DAY = 86400000;
  const endMs = nowMs - lag * DAY;
  return {
    start: isoDay(endMs - (days - 1) * DAY),
    end: isoDay(endMs),
    days,
    lagDays: lag,
  };
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

/* Every number a snapshot may hold, with the words to print it in. Reports
 * read these labels, so the console and the report never call the same
 * number two different things. */
export const METRIC_LABELS = {
  // Search Console
  clicks: "clicks from Google search",
  impressions: "times shown in Google search",
  ctr: "click rate",
  position: "average position",
  // Business Profile
  callClicks: "phone calls from the listing",
  directionRequests: "direction taps",
  websiteClicks: "website taps from the listing",
  businessImpressions: "times the listing was shown",
  bookings: "bookings from the listing",
  // Analytics
  users: "visitors",
  sessions: "sessions",
  engagedSessions: "engaged sessions",
  conversions: "actions taken",
  // Bing
  bingClicks: "clicks from Bing",
  bingImpressions: "times shown in Bing",
};

/** The numbers each provider fills in, in the order a report should read them. */
export const PROVIDER_METRICS = {
  gsc: ["clicks", "impressions", "ctr", "position"],
  gbp: ["businessImpressions", "callClicks", "directionRequests", "websiteClicks", "bookings"],
  ga4: ["users", "sessions", "engagedSessions", "conversions"],
  bing: ["bingClicks", "bingImpressions"],
  other: [],
};

/** How a metric should be printed. Rates and positions are not counts. */
export function formatMetric(key, value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  if (key === "ctr") return `${(n * 100).toFixed(1)}%`;
  if (key === "position") return n.toFixed(1);
  return n.toLocaleString("en-US");
}

/**
 * One snapshot as plain lines, for a report's fact sheet.
 *
 * EVERY LINE SAYS WHO MEASURED IT AND WHEN. That is the whole point: these
 * numbers did not come out of our own records, they came out of the client's
 * account, and a report that blends the two is the exact mistake this is
 * built to stop.
 */
export function snapshotToLines(snap) {
  if (!snap) return [];
  const label = PROVIDER_LABELS[snap.provider] || snap.provider;
  const how = snap.source === "manual"
    ? "typed in by one of us from that account"
    : "read straight out of that account by this console";
  const lines = [];
  lines.push(
    `${label}${snap.property ? ` (${prettyProperty(snap.provider, snap.property)})` : ""} — ` +
    `covering ${snap.period_start} to ${snap.period_end}, ${how} on ${String(snap.taken_at || "").slice(0, 10)}:`
  );
  const keys = PROVIDER_METRICS[snap.provider] || [];
  const m = snap.metrics || {};
  let printed = 0;
  for (const k of keys) {
    if (m[k] === null || m[k] === undefined) continue;
    lines.push(`  - ${formatMetric(k, m[k])} ${METRIC_LABELS[k] || k}`);
    printed += 1;
  }
  // Anything the provider does not list but the snapshot holds anyway, so a
  // number in the database can never be silently invisible to a report.
  for (const k of Object.keys(m)) {
    if (keys.includes(k)) continue;
    if (m[k] === null || m[k] === undefined) continue;
    lines.push(`  - ${formatMetric(k, m[k])} ${METRIC_LABELS[k] || k}`);
    printed += 1;
  }
  if (!printed) lines.push("  - No numbers were returned for this window.");

  const d = snap.detail || {};
  if (Array.isArray(d.topQueries) && d.topQueries.length) {
    lines.push(`  - Top searches that showed their site: ${d.topQueries.slice(0, 8).map((q) => `"${q.query}" (${q.clicks} clicks, ${q.impressions} shown)`).join("; ")}`);
  }
  if (Array.isArray(d.topPages) && d.topPages.length) {
    lines.push(`  - Most-clicked pages: ${d.topPages.slice(0, 5).map((p) => `${p.page} (${p.clicks} clicks)`).join("; ")}`);
  }
  if (Array.isArray(d.topChannels) && d.topChannels.length) {
    lines.push(`  - Where visitors came from: ${d.topChannels.slice(0, 6).map((c) => `${c.channel} (${c.sessions})`).join("; ")}`);
  }
  if (d.note) lines.push(`  - Note saved with these numbers: ${d.note}`);
  return lines;
}

/**
 * Every snapshot handed to a report, as one block of plain lines.
 * Newest per provider+property only — an older read of the same thing is
 * history, and putting two of them in front of a writer invites a comparison
 * nobody asked for out of windows that may not line up.
 */
/* THE CLIENT IS PART OF THE KEY. It has to be: two clients can both have a
 * typed-in Business Profile card with no property chosen, and keying on
 * provider alone made one client's numbers replace the other's — silently,
 * with the loser vanishing from the page entirely. It is harmless where the
 * input is one client's rows, and essential where it is not (the assistant's
 * context reads every client's at once). */
export function newestPerProperty(snapshots = []) {
  const byKey = new Map();
  for (const s of snapshots) {
    const key = `${s.client_id || ""}|${s.provider}|${s.property || ""}`;
    const prev = byKey.get(key);
    if (!prev || String(s.taken_at || "") > String(prev.taken_at || "")) byKey.set(key, s);
  }
  return [...byKey.values()].sort((a, b) =>
    String(a.client_id || "").localeCompare(String(b.client_id || "")) ||
    PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider) ||
    String(a.property || "").localeCompare(String(b.property || ""))
  );
}

/** How many days one reading covers, counting both ends. */
export function windowDays(snap) {
  if (!snap?.period_start || !snap?.period_end) return null;
  const a = Date.parse(`${snap.period_start}T00:00:00Z`);
  const b = Date.parse(`${snap.period_end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * True when the readings handed in do not all cover the same length of time.
 *
 * WHY ANYBODY CARES. The Refresh button has a range picker, and the newest
 * reading is the one every report quotes. Press it once with "Last 7 days"
 * selected and the 7-day figure quietly becomes the number in every report
 * from then on — so month to month a client appears to have lost three
 * quarters of their clicks. The dates are always printed, but a reader
 * comparing two numbers should be TOLD they are not comparable.
 */
export function windowsDisagree(snapshots = []) {
  const lengths = snapshots.map(windowDays).filter((n) => typeof n === "number");
  return new Set(lengths).size > 1;
}

export function measuredToText(snapshots = []) {
  const newest = newestPerProperty(snapshots);
  if (!newest.length) return "";
  const out = [
    "MEASURED IN THE CLIENT'S OWN ACCOUNTS (these are NOT our records — they are the client's real numbers, read on the dates below):",
  ];
  for (const s of newest) out.push(...snapshotToLines(s));
  if (windowsDisagree(newest)) {
    out.push("WARNING: these readings do not all cover the same number of days. Never put two of them side by side as if they were, and never say one is bigger than another.");
  }
  return out.join("\n");
}
