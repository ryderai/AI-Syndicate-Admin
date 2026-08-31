/* EVERY NAME IN THE SHEET'S SALES OWNER COLUMN GETS AN ACCOUNT.
 *
 * The sheet is already in — 3,663 people, and the Sales Owner text on each
 * row was kept exactly as it was typed, in admin_leads.imported_owner_name
 * (lib/sales-import.js). What is NOT in is the people. A name with no account
 * matched nothing, so the row came in UNCLAIMED, and every claim CJ's floor
 * had built up reads as nobody's.
 *
 * This file turns those names into accounts and then hands the rows back to
 * them. The rules half only — no database, no React.
 *
 * WHY THIS DOES NOT USE /api/invite:
 * That endpoint calls inviteUserByEmail, which SENDS AN EMAIL. Most of these
 * reps are names in a spreadsheet column — "Cameron", "Troy", "Sawyer" — with
 * no address on record anywhere. Guessing an address and emailing it is a
 * message sent to a stranger on the agency's behalf. So an account made here
 * is created quietly, with no email, and is marked `placeholder` until a real
 * address is typed in. The Team page's invite button is still the way a real
 * person gets a login.
 *
 * THE RULES:
 *  1. NEVER TAKE A LEAD OFF SOMEBODY. A row that already has an owner_id is
 *     never touched, whatever the sheet says. Migration 0020 closed exactly
 *     this hole from the other direction.
 *  2. ONLY A CONFIDENT MATCH CLAIMS. matchOwner in lib/sales-import.js already
 *     answers this and says which rule fired. "ambiguous" and "unknown" are
 *     reported, never guessed — a wrong match gives one rep another rep's
 *     pipeline.
 *  3. ONE PERSON, ONE ACCOUNT. "Brandon R" and "Brandon Roberts" are one man
 *     across 82 rows. The names are grouped BEFORE any account is made.
 *  4. A PLACEHOLDER ADDRESS CAN NEVER RECEIVE MAIL. .invalid is reserved by
 *     RFC 2606 and resolves nowhere, so a stray send bounces at our end
 *     instead of reaching a real person who never agreed to any of this.
 *  5. NOTHING IS CREATED TWICE. An email already on the roster is left exactly
 *     as it is, role included.
 */

import { matchOwner } from "./sales-import.js";

export const PLACEHOLDER_DOMAIN = "sheet.aisyndicate.invalid";

export function isPlaceholderEmail(email) {
  return String(email || "").toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

/** "Brandon Roberts" → "brandon-roberts". Used only to build a placeholder
 * address, never to compare two people. */
export function slug(name) {
  return String(name ?? "").toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rep";
}

export function placeholderEmail(name, taken = []) {
  const base = slug(name);
  const used = new Set(taken.map((e) => String(e || "").toLowerCase()));
  let candidate = `${base}@${PLACEHOLDER_DOMAIN}`;
  let n = 2;
  while (used.has(candidate)) { candidate = `${base}-${n}@${PLACEHOLDER_DOMAIN}`; n += 1; }
  return candidate;
}

/**
 * The distinct Sales Owner spellings in the sheet, grouped into PEOPLE.
 *
 * Two spellings are the same person when the longer one starts with the
 * shorter one at a word boundary — "Brandon R" ⊂ "Brandon Roberts". That is
 * the same shape as matchOwner's "initial" rule and no looser: "Matt Brown"
 * and "Matt McCall" do not fold together, because neither is a prefix of the
 * other. A one-word name only ever joins a group when exactly ONE longer name
 * extends it; if two do, it stays on its own and is reported, because folding
 * "Andrew" into the wrong Andrew hands over a pipeline.
 *
 * @param counts [{name, rows}] — distinct imported_owner_name and how many rows
 */
/* WHICH SPELLING A PERSON SEES when the same name was typed three ways.
 * Title Case wins: "Larry Pike" over "larry pike" and over "LARRY PIKE". Counting
 * capital letters alone picked the shouting one — a first attempt that a test
 * caught. Score = words that begin with a capital, then fewest capitals overall,
 * then the earlier one, so it is stable rather than dependent on read order. */
export function betterSpelling(a, b) {
  const score = (s) => {
    const words = String(s).trim().split(/\s+/);
    const titled = words.filter((w) => /^[A-Z]/.test(w)).length;
    return [titled, -(String(s).replace(/[^A-Z]/g, "").length)];
  };
  const [ta, ca] = score(a);
  const [tb, cb] = score(b);
  if (tb > ta) return b;
  if (tb < ta) return a;
  return cb > ca ? b : a;
}

export function groupOwnerNames(counts) {
  /* Identical to matchOwner's own normalisation, on purpose. */
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

  /* TWO SPELLINGS THAT DIFFER ONLY IN CASE ARE ONE STRING, NOT TWO PEOPLE.
   * matchOwner already reads "larry pike" and "Larry Pike" as the same man, so
   * leaving them apart here would ask for two accounts for one person and then
   * refuse to claim for either, because the roster would hold two Larrys. The
   * spelling that survives is the one with capital letters in it — that is the
   * one worth showing on screen. */
  const byNorm = new Map();
  for (const c of counts || []) {
    const name = String(c.name ?? "").trim();
    if (!name) continue;
    const k = norm(name);
    if (!k) continue;
    const rows = Number(c.rows) || 0;
    const seen = byNorm.get(k);
    if (!seen) { byNorm.set(k, { name, rows }); continue; }
    seen.rows += rows;
    seen.name = betterSpelling(seen.name, name);
  }
  const clean = [...byNorm.values()];
  const parts = (s) => { const w = norm(s).split(" "); return { first: w[0] || "", rest: w.slice(1).join(" "), second: w[1] || "" }; };

  /* B extends A when the first names match and B's surname carries on where
   * A's stopped. "brandon r" -> "brandon roberts". A bare first name extends
   * into anyone with that first name. This is matchOwner's "initial" and
   * "first" rules read in the other direction, so a name that groups here is
   * a name that would have matched there. */
  const extendsOf = (a, b) => {
    const A = parts(a), B = parts(b);
    if (norm(a) === norm(b)) return false;
    if (A.first !== B.first) return false;
    if (!A.rest) return Boolean(B.rest);                  // matchOwner's "first" rule
    /* matchOwner's "initial" rule compares the typed remainder against the
     * member's SECOND WORD and nothing further — `norm(full_name).split(" ")[1]`.
     * Reading it any more generously than that makes this file and that one
     * disagree: "Mary Jo B" folded into "Mary Jo Baker" here while matchOwner
     * refused to claim for her, so the screen showed 5 rows as Baker's and the
     * run handed over none of them. Found by an adversarial checker, 31 Aug. */
    return Boolean(B.second) && B.second.startsWith(A.rest);
  };

  const groups = [];
  const ambiguous = [];
  const folded = new Map();          // short name -> the one longer name

  for (const c of clean) {
    const longer = clean.filter((o) => extendsOf(c.name, o.name));
    if (longer.length === 1) { folded.set(c.name, longer[0].name); continue; }
    if (longer.length > 1) {
      /* Two people could be meant. Never guessed — the same refusal
       * matchOwner makes, for the same reason. */
      ambiguous.push({ name: c.name, rows: c.rows, couldBe: longer.map((e) => e.name) });
      continue;
    }
    groups.push({ label: c.name, spellings: [c.name], rows: c.rows });
  }

  for (const [short, long] of folded) {
    const g = groups.find((x) => norm(x.label) === norm(long));
    const row = clean.find((c) => c.name === short);
    if (g) { g.spellings.push(short); g.rows += row.rows; }
    else ambiguous.push({ name: short, rows: row.rows, couldBe: [long] });
  }

  groups.sort((a, b) => b.rows - a.rows);
  for (const g of groups) g.spellings.sort((a, b) => b.length - a.length);
  return { groups, ambiguous };
}

/**
 * What accounts need making, given the groups and who is already on the roster.
 * A group whose label already matches an active member is skipped entirely.
 */
/* WHICH matchOwner ANSWERS ARE GOOD ENOUGH TO ACT ON.
 *
 * matchOwner returns four kinds of hit. "exact" is the full name. "initial" is
 * a first name plus a surname only one person has. Both are safe.
 *
 * "first" is NOT. It fires when a first name belongs to exactly one member and
 * nothing else matched — so a sheet name of "Andrew Miller" matches Andrew
 * Soncini, and 40 rows of one person's work land on another. Nine tenths of
 * the danger in this whole feature sits in that one word, so it is named here
 * rather than left implied. A "first"-only hit is SHOWN and never acted on:
 * no account is skipped because of it, and no row is claimed on it. */
export const CONFIDENT = ["exact", "initial"];

export function planAccounts(groups, team, chosenEmails = {}) {
  const create = [];
  const already = [];
  const needsAPerson = [];
  const taken = (team || []).map((t) => t.email);

  for (const g of groups || []) {
    const hit = matchOwner(g.label, team);
    if (hit.user_id && CONFIDENT.includes(hit.how)) { already.push({ label: g.label, rows: g.rows, matchedAs: hit.label, how: hit.how }); continue; }
    if (hit.user_id) {
      /* A first-name-only hit. Somebody has to say whether these are the same
       * person; nothing here decides it either way. */
      needsAPerson.push({ label: g.label, rows: g.rows, couldBe: hit.label, how: hit.how, spellings: g.spellings });
      continue;
    }
    if (hit.how === "ambiguous") { already.push({ label: g.label, rows: g.rows, matchedAs: null, how: "ambiguous", candidates: hit.candidates }); continue; }
    const typed = String(chosenEmails[g.label] || "").trim().toLowerCase();
    const email = typed || placeholderEmail(g.label, taken);
    taken.push(email);
    create.push({ fullName: g.label, email, placeholder: !typed, rows: g.rows, spellings: g.spellings });
  }
  return { create, already, needsAPerson };
}

/** The roster as it WILL be once `create` has run. The screen has to count
 * claimable rows against this, not against today's roster — reading it against
 * today's said "1 row" before a button that was about to move three thousand. */
export function projectedTeam(team, create) {
  return [...(team || []), ...(create || []).map((c) => ({
    user_id: `will-be:${c.email}`, email: c.email, full_name: c.fullName, role: "sales", active: true,
  }))];
}

/**
 * Who each unclaimed lead should now belong to. `team` must already include
 * the accounts just created.
 *
 * @param leads [{id, owner_id, imported_owner_name}]
 * @returns { claim: [{id, user_id, name, how}], skipped: {...counts}, unresolved: [...] }
 */
export function planClaims(leads, team) {
  const claim = [];
  const unresolved = new Map();
  const skipped = { alreadyOwned: 0, noNameOnTheRow: 0 };
  const cache = new Map();

  for (const l of leads || []) {
    if (l.owner_id) { skipped.alreadyOwned += 1; continue; }        // rule 1
    const raw = String(l.imported_owner_name ?? "").trim();
    if (!raw) { skipped.noNameOnTheRow += 1; continue; }
    const k = raw.toLowerCase();
    if (!cache.has(k)) cache.set(k, matchOwner(raw, team));
    const hit = cache.get(k);
    if (hit.user_id && CONFIDENT.includes(hit.how)) { claim.push({ id: l.id, user_id: hit.user_id, name: raw, how: hit.how, firstContactAt: l.first_contact_at || null }); continue; }
    const cur = unresolved.get(raw) || {
      name: raw, rows: 0,
      how: hit.user_id ? "only the first name matched" : hit.how,
      candidates: hit.user_id ? [hit.label] : hit.candidates,
    };
    cur.rows += 1;
    unresolved.set(raw, cur);
  }
  return { claim, skipped, unresolved: [...unresolved.values()].sort((a, b) => b.rows - a.rows) };
}
