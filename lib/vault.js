/* Shared rules for the Vault.
 *
 * WHY THIS FILE IS PURE
 * It is imported by BOTH the browser (src/components/admin/VaultPage.jsx) and
 * the server (api/vault-secret.js). No imports, no node built-ins, no fetch, no
 * database, no environment. Data in, data out.
 *
 * If the two sides disagreed about what counts as a card number, or which
 * fields belong to which kind of item, you would get a row that saves in the
 * browser and is refused by the server — or worse, a "security code saved"
 * badge over a blob that has no security code in it.
 *
 * NOTHING IN THIS FILE EVER SEES A KEY. The scrambling lives in
 * lib/vault-crypto.js, which is server-only. This file only decides what is
 * allowed to be a secret, and what a person is shown when it is hidden.
 */

/* ------------------------------------------------------------------ */
/* The four kinds of item                                              */
/* ------------------------------------------------------------------ */

export const VAULT_KINDS = ["login", "card", "api_key", "note"];

export const VAULT_KIND_LABELS = {
  login: "Login",
  card: "Credit card",
  api_key: "Key or token",
  note: "Secure note",
};

export const VAULT_KIND_HELP = {
  login: "A username and password for a website.",
  card: "A payment card. The full number is hidden; the list shows the last four.",
  api_key: "A long key or token a program uses to sign in.",
  note: "Anything private that is not a login — a door code, an account number, an answer to a security question.",
};

/** The secret fields each kind may hold. Anything not listed here is refused,
 * on the server as well as here, so a stray field cannot ride along inside the
 * scrambled blob where nobody would ever see it again. */
export const SECRET_FIELDS = {
  login: ["password", "totp", "recovery"],
  card: ["number", "cvv", "pin"],
  api_key: ["key", "secret"],
  note: ["body"],
};

export const SECRET_FIELD_LABELS = {
  password: "Password",
  totp: "Two-factor setup code",
  recovery: "Recovery codes",
  number: "Card number",
  cvv: "Security code (CVV)",
  pin: "PIN",
  key: "Key",
  secret: "Secret",
  body: "Private note",
};

export const SECRET_FIELD_HELP = {
  password: "The password you type to sign in.",
  totp: "The long setup code an app like Authy or Google Authenticator was given. Not the 6 digits it shows.",
  recovery: "The one-time backup codes a site gives you when you turn on two-factor.",
  number: "The full 15 or 16 digits from the front of the card.",
  cvv: "The 3 digits on the back. 4 on the front for American Express.",
  pin: "The number typed at a card machine or an ATM.",
  key: "The long string the service gave you.",
  secret: "The second half of a key pair, if the service gave you one.",
  body: "Anything you would not want in a normal note.",
};

/** Every secret field name the vault knows about, across all kinds. */
export const ALL_SECRET_FIELDS = [...new Set(Object.values(SECRET_FIELDS).flat())];

/** Longest a single secret may be. Long enough for a page of recovery codes,
 * short enough that nobody pastes a file in. */
export const MAX_SECRET_CHARS = 4000;

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

/** Digits only. Card numbers get typed with spaces and dashes. */
export function onlyDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

/** Which card company, from the number. Best effort — it is a label on a card,
 * not a decision anything depends on. Returns null when it cannot tell. */
export function cardBrand(number) {
  const n = onlyDigits(number);
  if (!n) return null;
  if (/^4/.test(n)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(n)) return "Mastercard";
  if (/^3[47]/.test(n)) return "American Express";
  if (/^(6011|65|64[4-9]|622)/.test(n)) return "Discover";
  if (/^3(0[0-5]|[68])/.test(n)) return "Diners Club";
  if (/^35/.test(n)) return "JCB";
  return null;
}

/** The Luhn check — the arithmetic every card number satisfies. It catches a
 * typo, not a fake: a made-up number that happens to pass is still made up.
 * Used to WARN, never to block, because odd-length store cards exist. */
export function passesLuhn(number) {
  const n = onlyDigits(number);
  if (n.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i -= 1) {
    let d = Number(n[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function lastFour(number) {
  const n = onlyDigits(number);
  return n.length >= 4 ? n.slice(-4) : null;
}

/** "•••• •••• •••• 4242" — what the list shows when nothing is revealed. */
export function maskedCard(last4, brand) {
  if (!last4) return "•••• ••••";
  const amex = String(brand || "").toLowerCase().includes("american");
  return amex ? `•••• •••••• •${last4}` : `•••• •••• •••• ${last4}`;
}

/** "4242424242424242" → "4242 4242 4242 4242" (Amex groups 4-6-5). Only ever
 * used on a number a person just chose to reveal. */
export function groupCardNumber(number) {
  const n = onlyDigits(number);
  if (!n) return "";
  if (n.length === 15) return `${n.slice(0, 4)} ${n.slice(4, 10)} ${n.slice(10)}`.trim();
  return n.replace(/(.{4})/g, "$1 ").trim();
}

/** "08 / 27", or null. Padded, because "8/27" reads as a typo on a card. */
export function expiryText(month, year) {
  if (!month || !year) return null;
  const m = String(month).padStart(2, "0");
  const y = String(year).slice(-2);
  return `${m} / ${y}`;
}

/** True when the card's expiry month is in the past.
 * `nowYm` is {year, month} passed in, never read from a clock here — that is
 * what keeps this testable and keeps the answer the same for everyone. */
export function cardExpired(month, year, nowYm) {
  if (!month || !year || !nowYm) return false;
  if (year < nowYm.year) return true;
  if (year > nowYm.year) return false;
  return month < nowYm.month;
}

/** Within the next `months` months, and not already expired. */
export function cardExpiringSoon(month, year, nowYm, months = 2) {
  if (!month || !year || !nowYm) return false;
  if (cardExpired(month, year, nowYm)) return false;
  const away = (year - nowYm.year) * 12 + (month - nowYm.month);
  return away <= months;
}

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

/** A rough read on a password, for the box where one is typed. Four bands, in
 * plain words. It is a nudge, not a gate — nothing is ever refused for being
 * weak, because refusing to store the real password is worse than storing it. */
export function passwordStrength(value) {
  const v = String(value || "");
  if (!v) return { band: "none", label: "", score: 0 };
  let score = 0;
  if (v.length >= 8) score += 1;
  if (v.length >= 12) score += 1;
  if (v.length >= 16) score += 1;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score += 1;
  if (/\d/.test(v)) score += 1;
  if (/[^A-Za-z0-9]/.test(v)) score += 1;
  // Anything that looks like one dictionary word plus a couple of digits.
  if (/^[A-Za-z]+\d{0,4}!?$/.test(v)) score = Math.min(score, 2);
  if (score <= 2) return { band: "weak", label: "Weak — easy to guess", score };
  if (score <= 4) return { band: "ok", label: "OK", score };
  if (score <= 5) return { band: "good", label: "Good", score };
  return { band: "strong", label: "Strong", score };
}

/** Characters a generated password is built from. No l, I, 1, O, 0 — they get
 * misread when somebody reads a password down the phone. */
const GEN_LOWER = "abcdefghijkmnopqrstuvwxyz";
const GEN_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const GEN_DIGIT = "23456789";
const GEN_SYMBOL = "!@#$%^&*-_=+?";

/**
 * Build a password from random numbers handed in.
 *
 * `randomInts(n)` must return n whole numbers. The caller supplies it —
 * crypto.getRandomValues in the browser, node:crypto on the server — so this
 * file stays pure and, more importantly, so the randomness is always the real
 * kind. Math.random is not used anywhere near this.
 */
export function buildPassword({ length = 20, symbols = true, digits = true, randomInts }) {
  const len = Math.max(8, Math.min(64, Math.floor(length) || 20));
  let pool = GEN_LOWER + GEN_UPPER;
  if (digits) pool += GEN_DIGIT;
  if (symbols) pool += GEN_SYMBOL;

  // One extra draw per required class, so the result always contains one of
  // each thing that was asked for. Drawn from the same source, then placed.
  const required = [GEN_LOWER, GEN_UPPER];
  if (digits) required.push(GEN_DIGIT);
  if (symbols) required.push(GEN_SYMBOL);

  const draws = randomInts(len + required.length);
  const out = [];
  for (let i = 0; i < len; i += 1) out.push(pool[draws[i] % pool.length]);

  /* Each required class is placed at a position no other class has taken.
   * Before this, two classes could draw the same position and the second wrote
   * over the first — measured at 0.6% of 20-character passwords missing a
   * digit, and 12% at length 8. Small, but the comment above claimed a
   * guarantee, and a site with a "must contain a digit" rule would reject
   * roughly one generated password in 160 with no explanation. */
  const taken = new Set();
  required.forEach((set, i) => {
    let at = draws[len + i] % len;
    let tries = 0;
    while (taken.has(at) && tries < len) { at = (at + 1) % len; tries += 1; }
    taken.add(at);
    out[at] = set[draws[i] % set.length];
  });
  return out.join("");
}

/* ------------------------------------------------------------------ */
/* Validating an item before it is saved                               */
/* ------------------------------------------------------------------ */

/** Web addresses only. "javascript:..." in a link is a live script, not a link,
 * and a row can arrive from the SQL editor as well as from the box. Checked on
 * the way in AND at render — same rule as the platform login cards. */
export function safeVaultHref(url) {
  return /^https?:\/\//i.test(String(url || "")) ? String(url) : null;
}

/** Add https:// to a pasted bare domain. Leaves anything else alone. */
export function tidyUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;   // some other scheme — left as typed, and refused below
  return `https://${v.replace(/^\/+/, "")}`;
}

/**
 * Check the readable half of an item. Returns { ok } or { ok:false, field, why }.
 * `why` is written for the person, not for a log.
 */
export function checkVaultItem(item) {
  const kind = String(item?.kind || "");
  if (!VAULT_KINDS.includes(kind)) return { ok: false, field: "kind", why: "Pick what kind of item this is." };

  const label = String(item?.label || "").trim();
  if (!label) return { ok: false, field: "label", why: "Give it a name — whatever you would call it out loud. Example: GoDaddy." };
  if (label.length > 120) return { ok: false, field: "label", why: "That name is too long. Keep it under 120 characters." };

  const url = String(item?.url || "").trim();
  if (url && !safeVaultHref(url)) {
    return { ok: false, field: "url", why: "The web address has to start with http:// or https://." };
  }
  const vault = String(item?.vault_url || "").trim();
  if (vault && !safeVaultHref(vault)) {
    return { ok: false, field: "vault_url", why: "The Bitwarden link has to start with https://. Paste the link, not the password." };
  }

  if (kind === "card") {
    const last4 = String(item?.card_last4 || "");
    if (!/^\d{4}$/.test(last4)) {
      return { ok: false, field: "card_last4", why: "A card needs its last 4 digits, so you can tell it apart in the list." };
    }
    const m = item?.card_exp_month;
    const y = item?.card_exp_year;
    if ((m && !y) || (y && !m)) {
      return { ok: false, field: "card_exp_month", why: "Fill in both the expiry month and the year, or leave both empty." };
    }
    if (m && (m < 1 || m > 12)) return { ok: false, field: "card_exp_month", why: "The expiry month has to be between 1 and 12." };
    if (y && (y < 2000 || y > 2100)) return { ok: false, field: "card_exp_year", why: "Type the expiry year in full, like 2029." };
  }
  return { ok: true };
}

/**
 * Check one secret before it is scrambled.
 * `kind` decides which field names are allowed at all.
 */
export function checkSecret(kind, field, value) {
  const allowed = SECRET_FIELDS[kind] || [];
  if (!allowed.includes(field)) {
    return { ok: false, why: `A ${VAULT_KIND_LABELS[kind] || kind} has no "${field}" to save.` };
  }
  const v = String(value ?? "");
  if (!v.trim()) return { ok: false, why: "There is nothing to save — the box is empty." };
  if (v.length > MAX_SECRET_CHARS) {
    return { ok: false, why: `That is longer than the ${MAX_SECRET_CHARS} characters a vault item holds. Put a file in Drive and link to it instead.` };
  }
  if (field === "number") {
    const n = onlyDigits(v);
    if (n.length < 12 || n.length > 19) return { ok: false, why: "A card number is 12 to 19 digits. Check what was typed." };
  }
  if (field === "cvv") {
    const n = onlyDigits(v);
    if (n.length < 3 || n.length > 4) return { ok: false, why: "A security code is 3 digits, or 4 on American Express." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Reading the list                                                    */
/* ------------------------------------------------------------------ */

/** True when the item has anything scrambled saved against it at all. */
export function hasSecret(item) {
  return Boolean(item?.secret_set_at) && (item?.secret_fields || []).length > 0;
}

/** Does this item hold that particular field? Reads the NAMES stored beside the
 * blob, so the page can say "security code saved" without unscrambling. */
export function holdsField(item, field) {
  return (item?.secret_fields || []).includes(field);
}

/** What an item is called when nothing was typed. */
export function vaultItemLabel(item, clientName) {
  const label = String(item?.label || "").trim();
  if (label) return label;
  if (clientName) return `${clientName} — untitled`;
  return "Untitled item";
}

/** Favourites first, then live items, then the hand order, then by name. The
 * order somebody reads a list of logins in. */
export function sortVaultItems(rows) {
  return [...(rows || [])].sort((a, b) => {
    const off = (r) => (r.active === false ? 1 : 0);
    const fav = (r) => (r.favorite ? 0 : 1);
    return (
      off(a) - off(b) ||
      fav(a) - fav(b) ||
      (a.sort || 0) - (b.sort || 0) ||
      String(a.label || "").localeCompare(String(b.label || ""))
    );
  });
}

/**
 * Free-text search across the READABLE fields only.
 *
 * Note what is missing: the secret. You cannot search for a password, which is
 * not a gap — a search box that matched on secrets would mean the browser had
 * the secrets, which is the thing this whole design avoids.
 */
export function searchVaultItems(rows, query, clientNameById = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return rows;
  const words = q.split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    const hay = [
      r.label, r.description, r.username, r.url, r.notes,
      r.card_brand, r.card_last4, r.card_holder,
      VAULT_KIND_LABELS[r.kind] || r.kind,
      clientNameById[r.client_id] || (r.client_id ? "" : "ours AI Syndicate"),
      ...(r.tags || []),
    ].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A one-line description of what is stored, for the card face.
 * Example: "Password and two-factor setup code saved". */
export function secretSummary(item) {
  const fields = item?.secret_fields || [];
  if (!fields.length) return "Nothing saved yet";
  const names = fields.map((f) => (SECRET_FIELD_LABELS[f] || f).toLowerCase());
  if (names.length === 1) return `${cap(names[0])} saved`;
  return `${cap(names.slice(0, -1).join(", "))} and ${names[names.length - 1]} saved`;
}

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
