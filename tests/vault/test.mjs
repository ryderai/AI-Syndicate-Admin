/* Tests for the Aug 21 2026 build: the Vault and the client Report.
 *
 * Run with:  bash tests/vault/run.sh
 *
 * No database, no network, no AI key, no VAULT_KEY on the way in — the crypto
 * tests set one themselves so they are the same every run.
 *
 * The last block is the one that matters most, and it is the lesson from the
 * Aug 20 review: it reads the CREATE TABLE statements out of
 * supabase/migrations/ and checks that every column this code writes actually
 * exists. Three files once wrote columns that were never there, and the tests
 * missed it because the fixtures had invented the same wrong names.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Three fixed test keys. They are the SHA-256 of a fixed word, so they are the
 * same on every run and yet look like real random keys — which matters now,
 * because a key of 32 identical bytes is refused as an obvious mistake (a
 * reviewer got an all-zero AES key past the first version of that check). */
import { createHash } from "node:crypto";
const testKey = (seed) => createHash("sha256").update(`ais-vault-test-${seed}`).digest();
const KEY_A = testKey("a").toString("base64");
const KEY_B = testKey("b").toString("base64");
const KEY_C = testKey("c").toString("hex");

process.env.VAULT_KEY = KEY_A;

const {
  VAULT_KINDS, SECRET_FIELDS, ALL_SECRET_FIELDS,
  onlyDigits, cardBrand, passesLuhn, lastFour, maskedCard, groupCardNumber,
  expiryText, cardExpired, cardExpiringSoon, passwordStrength, buildPassword,
  safeVaultHref, tidyUrl, checkVaultItem, checkSecret,
  hasSecret, holdsField, sortVaultItems, searchVaultItems, secretSummary, vaultItemLabel,
} = await import("../../lib/vault.js");

const {
  readVaultKey, isVaultConfigured, vaultKeyFingerprint, encryptSecret, decryptSecret, serverRandomInts,
} = await import("../../lib/vault-crypto.js");

const {
  REPORT_PRESETS, presetById, assembleReportFacts, missingFrom, reportFactsToText,
  buildReportInstruction, parseReport, assignsWork, checkReport, deterministicReport,
  reportToMarkdown, provenanceLine, MAX_INSTRUCTION_CHARS, buildFactsText, unbackedNumbersStrict,
  unbackedProseDates, unbackedWordNumbers, withoutQuotes,
} = await import("../../lib/client-report.js");

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* A fixed clock, so nothing here starts failing at midnight — which is exactly
 * the kind of bug a test suite is supposed to catch rather than cause. */
const NOW = Date.parse("2026-08-21T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const day = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);

/* ================================================================== */
/* 1. CARDS                                                            */
/* ================================================================== */

test("onlyDigits strips everything a person types around a card number", () => {
  assert.equal(onlyDigits("4242 4242-4242 4242"), "4242424242424242");
  assert.equal(onlyDigits(null), "");
});

test("cardBrand reads the well-known ranges", () => {
  assert.equal(cardBrand("4242424242424242"), "Visa");
  assert.equal(cardBrand("5555555555554444"), "Mastercard");
  assert.equal(cardBrand("2223003122003222"), "Mastercard");   // the 2-series
  assert.equal(cardBrand("378282246310005"), "American Express");
  assert.equal(cardBrand("6011111111111117"), "Discover");
  assert.equal(cardBrand("9999999999999999"), null);           // says "I don't know"
});

test("the Luhn check passes real numbers and catches a single-digit typo", () => {
  assert.equal(passesLuhn("4242424242424242"), true);
  assert.equal(passesLuhn("378282246310005"), true);
  assert.equal(passesLuhn("4242424242424243"), false);
  assert.equal(passesLuhn("42424"), false);                     // too short to be one
});

test("last 4 and the masked form line up, Amex included", () => {
  assert.equal(lastFour("4242424242424242"), "4242");
  assert.equal(maskedCard("4242", "Visa"), "•••• •••• •••• 4242");
  assert.equal(maskedCard("0005", "American Express"), "•••• •••••• •0005");
  assert.equal(maskedCard(null), "•••• ••••");
});

test("a revealed number is grouped the way it is printed on the card", () => {
  assert.equal(groupCardNumber("4242424242424242"), "4242 4242 4242 4242");
  assert.equal(groupCardNumber("378282246310005"), "3782 822463 10005");
});

test("expiry is padded, and expired vs expiring-soon are different answers", () => {
  const now = { year: 2026, month: 8 };
  assert.equal(expiryText(8, 2027), "08 / 27");
  assert.equal(expiryText(null, 2027), null);
  assert.equal(cardExpired(7, 2026, now), true);
  assert.equal(cardExpired(8, 2026, now), false);      // the month it expires IS still valid
  assert.equal(cardExpired(1, 2027, now), false);
  assert.equal(cardExpiringSoon(9, 2026, now), true);
  assert.equal(cardExpiringSoon(7, 2026, now), false); // already expired is not "soon"
  assert.equal(cardExpiringSoon(6, 2027, now), false);
});

/* ================================================================== */
/* 2. PASSWORDS                                                        */
/* ================================================================== */

test("password strength bands read the way a person would judge them", () => {
  assert.equal(passwordStrength("").band, "none");
  assert.equal(passwordStrength("Password1").band, "weak");     // one word + a digit
  assert.equal(passwordStrength("dog").band, "weak");
  assert.equal(passwordStrength("Tr0ub4dor&3xY!zQ9w").band, "strong");
});

test("a generated password contains every class that was asked for", () => {
  // Fake randomness, so the same test runs the same way every time.
  const ints = (n) => Array.from({ length: n }, (_, i) => i * 7919);
  const pw = buildPassword({ length: 24, symbols: true, digits: true, randomInts: ints });
  assert.equal(pw.length, 24);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[2-9]/);
  assert.match(pw, /[!@#$%^&*\-_=+?]/);
});

test("a generated password never contains the characters people misread", () => {
  const pw = buildPassword({ length: 60, symbols: true, digits: true, randomInts: serverRandomInts });
  for (const bad of ["l", "I", "1", "O", "0"]) {
    assert.equal(pw.includes(bad), false, `contains ${bad}, which gets misread down a phone`);
  }
});

test("EVERY generated password really does carry every class asked for", () => {
  /* The old placement let two required classes land on the same character, and
   * the second wrote over the first: 0.6% of 20-character passwords came out
   * with no digit, 12% at length 8. Small, but the code claimed a guarantee.
   * 4,000 draws at the worst length is enough to catch a 12% failure many times
   * over. */
  let missing = 0;
  for (let i = 0; i < 4000; i += 1) {
    const pw = buildPassword({ length: 8, symbols: true, digits: true, randomInts: serverRandomInts });
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[2-9]/.test(pw) || !/[!@#$%^&*\-_=+?]/.test(pw)) missing += 1;
  }
  assert.equal(missing, 0, `${missing} of 4000 passwords were missing a required class`);
});

test("the generated length is clamped rather than trusted", () => {
  const ints = (n) => Array.from({ length: n }, (_, i) => i);
  assert.equal(buildPassword({ length: 2, randomInts: ints }).length, 8);
  assert.equal(buildPassword({ length: 9999, randomInts: ints }).length, 64);
});

/* ================================================================== */
/* 3. WHAT IS ALLOWED IN                                               */
/* ================================================================== */

test("a link is only a link when it is http or https", () => {
  assert.equal(safeVaultHref("https://x.com"), "https://x.com");
  assert.equal(safeVaultHref("http://x.com"), "http://x.com");
  assert.equal(safeVaultHref("javascript:alert(1)"), null);     // a live script, not a link
  assert.equal(safeVaultHref("data:text/html,x"), null);
  assert.equal(safeVaultHref(""), null);
});

test("a pasted bare domain gets https, and an odd scheme is left to be refused", () => {
  assert.equal(tidyUrl("godaddy.com"), "https://godaddy.com");
  assert.equal(tidyUrl("https://x.com"), "https://x.com");
  assert.equal(tidyUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(safeVaultHref(tidyUrl("javascript:alert(1)")), null);
});

test("checkVaultItem refuses the things that would break the list", () => {
  assert.equal(checkVaultItem({ kind: "login", label: "GoDaddy" }).ok, true);
  assert.equal(checkVaultItem({ kind: "login", label: "  " }).field, "label");
  assert.equal(checkVaultItem({ kind: "nope", label: "x" }).field, "kind");
  assert.equal(checkVaultItem({ kind: "login", label: "x", url: "javascript:1" }).field, "url");
  assert.equal(checkVaultItem({ kind: "login", label: "x", vault_url: "notalink" }).field, "vault_url");
  // A card with no last 4 cannot be told apart in a list.
  assert.equal(checkVaultItem({ kind: "card", label: "Chase" }).field, "card_last4");
  assert.equal(checkVaultItem({ kind: "card", label: "Chase", card_last4: "4242" }).ok, true);
  assert.equal(checkVaultItem({ kind: "card", label: "C", card_last4: "4242", card_exp_month: 13, card_exp_year: 2028 }).field, "card_exp_month");
  // Half an expiry is worse than none: it renders as a date that is not one.
  assert.equal(checkVaultItem({ kind: "card", label: "C", card_last4: "4242", card_exp_month: 5 }).field, "card_exp_month");
});

test("checkSecret refuses a field that does not belong to that kind of item", () => {
  assert.equal(checkSecret("login", "password", "hunter2").ok, true);
  assert.equal(checkSecret("login", "number", "4242424242424242").ok, false);
  assert.equal(checkSecret("card", "number", "4242424242424242").ok, true);
  assert.equal(checkSecret("card", "password", "x").ok, false);
  assert.equal(checkSecret("card", "cvv", "12").ok, false);
  assert.equal(checkSecret("card", "cvv", "1234").ok, true);
  assert.equal(checkSecret("login", "password", "   ").ok, false);
  assert.equal(checkSecret("login", "password", "x".repeat(5000)).ok, false);
});

test("every kind's secret fields are inside the known set", () => {
  for (const k of VAULT_KINDS) {
    for (const f of SECRET_FIELDS[k]) {
      assert.equal(ALL_SECRET_FIELDS.includes(f), true, `${k}.${f} is not in ALL_SECRET_FIELDS`);
    }
  }
});

/* ================================================================== */
/* 4. READING THE LIST                                                 */
/* ================================================================== */

const ITEMS = [
  { id: "a", label: "Zebra hosting", kind: "login", client_id: null, username: "ops@x.com", secret_set_at: ago(1), secret_fields: ["password"], favorite: false, active: true, sort: 0, tags: ["hosting"] },
  { id: "b", label: "Alpha registrar", kind: "login", client_id: "c1", username: "billing@x.com", secret_set_at: null, secret_fields: [], favorite: false, active: true, sort: 0, tags: [] },
  { id: "c", label: "Pinned card", kind: "card", client_id: null, card_last4: "4242", card_brand: "Visa", secret_set_at: ago(3), secret_fields: ["number", "cvv"], favorite: true, active: true, sort: 5, tags: ["money"] },
  { id: "d", label: "Old thing", kind: "note", client_id: "c1", secret_set_at: ago(50), secret_fields: ["body"], favorite: false, active: false, sort: 0, tags: [] },
];

test("hasSecret needs BOTH a date and a field name — one alone is a half-written row", () => {
  assert.equal(hasSecret(ITEMS[0]), true);
  assert.equal(hasSecret(ITEMS[1]), false);
  assert.equal(hasSecret({ secret_set_at: ago(1), secret_fields: [] }), false);
  assert.equal(hasSecret({ secret_set_at: null, secret_fields: ["password"] }), false);
});

test("holdsField reads the stored names, without unscrambling anything", () => {
  assert.equal(holdsField(ITEMS[2], "cvv"), true);
  assert.equal(holdsField(ITEMS[2], "pin"), false);
});

test("the sort is: live before retired, pinned before not, then by name", () => {
  const order = sortVaultItems(ITEMS).map((r) => r.id);
  assert.equal(order[0], "c");                 // pinned
  assert.equal(order[order.length - 1], "d");  // retired, last whatever else it is
});

test("search covers the readable fields and nothing else", () => {
  const names = { c1: "Harbor Injury Law" };
  assert.deepEqual(searchVaultItems(ITEMS, "zebra", names).map((r) => r.id), ["a"]);
  assert.deepEqual(searchVaultItems(ITEMS, "harbor", names).map((r) => r.id), ["b", "d"]);
  assert.deepEqual(searchVaultItems(ITEMS, "4242", names).map((r) => r.id), ["c"]);
  assert.deepEqual(searchVaultItems(ITEMS, "money", names).map((r) => r.id), ["c"]);
  // Every word has to match, so two words narrow rather than widen.
  assert.deepEqual(searchVaultItems(ITEMS, "alpha harbor", names).map((r) => r.id), ["b"]);
  assert.deepEqual(searchVaultItems(ITEMS, "", names).length, ITEMS.length);
});

test("secretSummary says what is stored, in words, without opening it", () => {
  assert.equal(secretSummary(ITEMS[0]), "Password saved");
  assert.equal(secretSummary(ITEMS[2]), "Card number and security code (cvv) saved");
  assert.equal(secretSummary(ITEMS[1]), "Nothing saved yet");
});

test("an item with no name still reads as something in a list", () => {
  assert.equal(vaultItemLabel({ label: "" }, "Harbor"), "Harbor — untitled");
  assert.equal(vaultItemLabel({ label: "" }), "Untitled item");
});

/* ================================================================== */
/* 5. THE SCRAMBLING                                                   */
/* ================================================================== */

test("the key is read from base64 and from hex, and nothing else", () => {
  const keep = process.env.VAULT_KEY;

  process.env.VAULT_KEY = KEY_B;
  assert.equal(readVaultKey().ok, true);

  process.env.VAULT_KEY = KEY_C;
  assert.equal(readVaultKey().ok, true);

  process.env.VAULT_KEY = "too-short";
  assert.equal(readVaultKey().ok, false);
  assert.match(readVaultKey().why, /openssl rand -base64 32/);

  process.env.VAULT_KEY = "";
  assert.equal(isVaultConfigured(), false);

  process.env.VAULT_KEY = keep;
  assert.equal(isVaultConfigured(), true);
});

test("a secret goes in and comes back out unchanged", () => {
  const enc = encryptSecret({ password: "hunter2", totp: "ABCDEF" }, "item-1");
  assert.equal(enc.ok, true);
  const out = decryptSecret(enc.blob, "item-1");
  assert.equal(out.ok, true);
  assert.deepEqual(out.payload, { password: "hunter2", totp: "ABCDEF" });
});

test("the stored blob does not contain the secret anywhere in it", () => {
  const enc = encryptSecret({ password: "correct-horse-battery-staple" }, "item-1");
  assert.equal(enc.blob.includes("correct"), false);
  assert.equal(enc.blob.includes("horse"), false);
  // And it is not just base64 of the plaintext either.
  assert.equal(enc.blob.includes(Buffer.from("correct-horse-battery-staple").toString("base64")), false);
});

test("the same secret encrypts differently every time (a fresh iv per save)", () => {
  const a = encryptSecret({ password: "same" }, "item-1").blob;
  const b = encryptSecret({ password: "same" }, "item-1").blob;
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, "item-1").payload.password, "same");
  assert.equal(decryptSecret(b, "item-1").payload.password, "same");
});

test("a blob moved onto a different row REFUSES to open", () => {
  // This is the SQL-editor case: copy the ciphertext from the Chase card onto
  // the Wells Fargo row, and the wrong number would show under the wrong name.
  const enc = encryptSecret({ number: "4242424242424242" }, "item-chase");
  const out = decryptSecret(enc.blob, "item-wells");
  assert.equal(out.ok, false);
  assert.match(out.why, /different item|changed by hand/);
});

test("one altered character breaks it loudly instead of returning something wrong", () => {
  const enc = encryptSecret({ password: "hunter2" }, "item-1");
  const parts = enc.blob.split(".");
  parts[4] = parts[4].slice(0, -2) + (parts[4].slice(-2) === "AA" ? "AB" : "AA");
  const out = decryptSecret(parts.join("."), "item-1");
  assert.equal(out.ok, false);
});

test("a different key gives a plain sentence, not a crash", () => {
  const keep = process.env.VAULT_KEY;
  const enc = encryptSecret({ password: "hunter2" }, "item-1");
  process.env.VAULT_KEY = KEY_B;
  const out = decryptSecret(enc.blob, "item-1");
  process.env.VAULT_KEY = keep;
  assert.equal(out.ok, false);
  assert.match(out.why, /DIFFERENT VAULT_KEY/);
  assert.match(out.why, /Nothing is lost while the old key exists/);
});

test("the fingerprint is a hash, not the key", () => {
  const fp = vaultKeyFingerprint();
  assert.equal(fp.length, 8);
  assert.equal(process.env.VAULT_KEY.includes(fp), false);
});

test("a typed passphrase is refused, however base64-shaped it looks", () => {
  const keep = process.env.VAULT_KEY;
  /* Every one of these decodes to exactly 32 bytes through Buffer.from(x,
   * "base64"), which is why the length check alone waved them through. They are
   * all guessable offline, which is the one thing the key must not be. */
  for (const typed of [
    "ThisIsMyReallyLongSecretPassphraseForVault1",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "password-password-password-password-passwor",
    "MySuperSecretVaultKeyForAISyndicate12345678",
    "correcthorsebatterystaplecorrecthorsebatter",
    // 43 capital A characters decodes to 32 ZERO bytes — an all-zero AES key.
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    // The obvious workaround once a typed phrase is refused: base64 the phrase.
    Buffer.from("correcthorsebatterystaplecorrect").toString("base64"),
    Buffer.from(" ".repeat(32)).toString("base64"),
    // And the same shapes in hex.
    "0".repeat(64),
    "deadbeef".repeat(8),
  ]) {
    process.env.VAULT_KEY = typed;
    const k = readVaultKey();
    assert.equal(k.ok, false, `"${typed}" was accepted as a key`);
    assert.match(k.why, /does not look like a randomly generated key/);
  }
  process.env.VAULT_KEY = keep;
  assert.equal(readVaultKey().ok, true);
});

test("a real random key is still accepted after that check", () => {
  const keep = process.env.VAULT_KEY;
  /* 4,000 real keys in every shape `openssl` and friends produce. A key that is
   * good and gets refused is worse than annoying: the message tells the person
   * to run the command they just ran. The word test used to be
   * case-INSENSITIVE and refused about 1 real key in 500 on "tokEN" / "paSSw".
   * Measured over 1.2 million keys after the fix: none. */
  const shapes = [
    (b) => b.toString("base64"),
    (b) => b.toString("base64").replace(/=+$/, ""),
    (b) => b.toString("base64url"),
    (b) => b.toString("hex"),
  ];
  let refused = 0;
  for (let i = 0; i < 1000; i += 1) {
    const bytes = Buffer.from(serverRandomInts(32).map((n) => n % 256));
    for (const shape of shapes) {
      process.env.VAULT_KEY = shape(bytes);
      if (!readVaultKey().ok) refused += 1;
    }
  }
  process.env.VAULT_KEY = keep;
  assert.equal(refused, 0, `${refused} of 4000 real keys were refused`);
});

test("junk in, plain answer out — never an exception", () => {
  for (const junk of ["", null, "v1.aa.bb", "nonsense", "v2.aaaaaaaa.a.b.c"]) {
    const out = decryptSecret(junk, "item-1");
    assert.equal(out.ok, false);
    assert.equal(typeof out.why, "string");
  }
});

test("a secret cannot be saved against nothing", () => {
  assert.equal(encryptSecret({ password: "x" }, "").ok, false);
});

/* ================================================================== */
/* 6. THE REPORT — counting                                            */
/* ================================================================== */

const CLIENT = { id: "c1", name: "Harbor Injury Law", domain: "harbor.com", stage: "Week 3", status: "active", start_date: day(40), notes: null };

const REPORT_INPUT = {
  client: CLIENT,
  tasks: [
    { id: "t1", name: "Ship the AI files", status: "done", updated_at: ago(4), latest_report: "All three live." },
    { id: "t2", name: "Schema on listing pages", status: "in_progress", due_date: day(-3) },
    { id: "t3", name: "Unblock the crawlers", status: "blocked", latest_report: "Blocked until the firewall login exists." },
    { id: "t4", name: "Weekly report", status: "todo", due_date: day(6) },   // past its date
  ],
  weekly: [
    { id: "w1", week_no: 1, week_status: "complete", readiness: "verified", what_we_did: "Baseline audit.", what_moved: "Baseline set.", whats_next: "Head package." },
    { id: "w2", week_no: 2, week_status: "in_progress", readiness: "draft", what_we_did: "Head package." },
  ],
  emailThreads: [
    { id: "e1", status: "needs_reply", subject: "Audit question", last_message_at: ago(1), last_direction: "in" },
    { id: "e2", status: "waiting", subject: "Second office address", last_message_at: ago(6) },
  ],
  sites: [
    { id: "s1", kind: "main", label: "Main site", url: "https://harbor.com", live: true },
    { id: "s2", kind: "authority", label: "Injury Claim Guide", url: "https://guide.com", live: false },
  ],
  reminders: [{ id: "r1", done_at: null }],
  invoices: [
    { number: "AIS-0001", status: "paid", issue_date: day(35), due_date: day(21), total_cents: 250000, amount_paid_cents: 250000, paid_at: ago(20) },
    { number: "AIS-0002", status: "sent", issue_date: day(5), due_date: day(2), total_cents: 150000, amount_paid_cents: 0 },
    { number: "AIS-0003", status: "void", issue_date: day(9), due_date: day(1), total_cents: 999900, amount_paid_cents: 0 },
  ],
  tickets: [{ id: "k1", subject: "Form not sending", status: "open", priority: "high", created_at: ago(2) }],
  notes: [{ id: "n1", title: "Call notes", body: "They want reports on Thursdays.", updated_at: ago(7) }],
  platformAccounts: [{ id: "p1", active: true }, { id: "p2", active: false }],
  vaultItems: [{ id: "v1", secret_set_at: ago(3) }, { id: "v2", secret_set_at: null }],
  previousReports: [],
  nowMs: NOW,
};

const FACTS = assembleReportFacts(REPORT_INPUT);

test("the counts carry through from the shared counting in client-standing", () => {
  assert.equal(FACTS.counts.tasksTotal, 4);
  assert.equal(FACTS.counts.tasksDone, 1);
  assert.equal(FACTS.counts.tasksOpen, 3);
  assert.equal(FACTS.counts.tasksBlocked, 1);
  assert.equal(FACTS.counts.tasksLate, 1);          // t4 only; t2 is due in the future
  assert.equal(FACTS.counts.sites, 2);
  assert.equal(FACTS.counts.sitesLive, 1);
  assert.equal(FACTS.counts.emailsNeedingReply, 1);
  assert.equal(FACTS.counts.emailsWaitingOnThem, 1);
});

test("a void invoice is not money — it is left out of every total", () => {
  assert.equal(FACTS.money.invoices, 2);
  assert.equal(FACTS.money.billedCents, 400000);
  assert.equal(FACTS.money.paidCents, 250000);
  assert.equal(FACTS.money.owedCents, 150000);
  assert.equal(FACTS.money.overdueCount, 1);        // AIS-0002, due two days ago
  assert.equal(FACTS.money.overdueCents, 150000);
});

test("a paid invoice is never overdue, whatever its due date says", () => {
  const f = assembleReportFacts({
    ...REPORT_INPUT,
    invoices: [{ number: "X", status: "paid", issue_date: day(40), due_date: day(30), total_cents: 100, amount_paid_cents: 100 }],
  });
  assert.equal(f.money.overdueCount, 0);
});

test("the vault appears as a COUNT and nothing else", () => {
  assert.equal(FACTS.access.vaultItems, 2);
  assert.equal(FACTS.access.vaultItemsWithSecret, 1);
  const text = reportFactsToText(FACTS);
  /* Nothing that could identify an item, and obviously no value. The word
   * "password" DOES appear, in the one honest sentence "1 with a password or
   * number stored" — so the check is for the things that would leak, not for
   * the word itself. */
  assert.equal(/secret_cipher|secret_fields|cvv|card_last4|4242/i.test(text), false);
  assert.equal(text.includes("GoDaddy"), false);
  assert.match(text, /2 items in the vault \(1 with a password or number stored\)/);
});

test("what the records cannot answer is stated, not skipped", () => {
  const gaps = missingFrom(FACTS).join(" ");
  assert.match(gaps, /Scores from the platform/);
  assert.match(gaps, /outside this console/);
  // And the list grows when something really is missing.
  const bare = assembleReportFacts({ ...REPORT_INPUT, weekly: [], sites: [], invoices: [], emailThreads: [] });
  const bareGaps = missingFrom(bare).join(" ");
  assert.match(bareGaps, /no weekly log/i);
  assert.match(bareGaps, /No websites are on file/i);
});

test("the facts the AI sees carry the money, the notes and the gaps", () => {
  const text = reportFactsToText(FACTS);
  assert.match(text, /MONEY/);
  assert.match(text, /\$4,000\.00 billed/);
  assert.match(text, /NOTES OUR TEAM WROTE BY HAND/);
  assert.match(text, /WHAT THESE RECORDS CANNOT ANSWER/);
});

test("the facts text is capped, and says exactly what was cut", () => {
  const { text, cutChars } = buildFactsText(FACTS, { maxChars: 900 });
  assert.equal(cutChars > 0, true);
  assert.match(text, /NOT EVERYTHING FITTED: about \d+ characters/);
  /* The old marker read "the counts above cover everything", which was false —
   * it cut mid-list. Nothing may say that any more. */
  assert.equal(/cover everything/.test(text), false);
});

test("the parts that must never be cut are never cut", () => {
  /* A reviewer found the sheet was assembled head-then-tail and trimmed off the
   * END — so the very last section to go was "what these records cannot
   * answer", and the model was told to finish with a section it had never been
   * shown. These four survive even at an absurd budget. */
  const { text } = buildFactsText(FACTS, { maxChars: 900 });
  assert.match(text, /COUNTS TAKEN AT/);
  assert.match(text, /TOTALS:/);
  assert.match(text, /MONEY \(from invoices/);
  assert.match(text, /ACCESS WE HOLD/);
  assert.match(text, /WHAT THESE RECORDS CANNOT ANSWER/);
});

test("the number of characters left out is measured, not guessed", () => {
  /* It used to add 1 to the count whenever the shared half had been trimmed, so
   * a client that lost 2,514 characters was told "about 1 characters did not
   * fit". A specific reassuring wrong number is worse than silence. */
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const wide = assembleReportFacts({
    ...REPORT_INPUT,
    sites: many(300, (i) => ({ id: `s${i}`, kind: "authority", label: `Ranking site number ${i}`, url: `https://ranking-site-number-${i}-example.com`, live: true })),
  });
  const { text, cutChars, headCut } = buildFactsText(wide);
  assert.equal(headCut, true);
  assert.equal(cutChars > 100, true, `only ${cutChars} characters reported as cut`);
  assert.equal(cutChars !== 1, true, "the +1 hack is back");
  assert.match(text, new RegExp(`about ${cutChars} characters`));
});

test("nothing is cut at the real size, and cutChars says so", () => {
  const { cutChars } = buildFactsText(FACTS);
  assert.equal(cutChars, 0);
});

test("a client with more records than fit is told so, not trimmed in silence", () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const huge = assembleReportFacts({
    ...REPORT_INPUT,
    tasks: many(200, (i) => ({ id: `t${i}`, name: `Task number ${i} with a reasonably long name`, status: i % 3 ? "todo" : "done", updated_at: ago(i), latest_report: "A sentence about what happened here." })),
    weekly: many(30, (i) => ({ id: `w${i}`, week_no: i + 1, week_status: "complete", readiness: "verified", what_we_did: "A description of the week that is not short.", what_moved: "Something moved.", whats_next: "Something next." })),
    sites: many(200, (i) => ({ id: `s${i}`, kind: "authority", label: `Ranking site number ${i}`, url: `https://ranking-site-${i}-example.com`, live: true })),
  });
  const { text, cutChars } = buildFactsText(huge);
  assert.equal(cutChars > 0, true, "a client well past the budget did not report any cut");
  assert.match(text, /NOT EVERYTHING FITTED/);
  // and the sections that must survive, still did
  assert.match(text, /WHAT THESE RECORDS CANNOT ANSWER/);
});

/* ================================================================== */
/* 7. THE REPORT — the instruction and the checking                    */
/* ================================================================== */

test("the person's own words travel, and our rules come after them", () => {
  const p = buildReportInstruction({
    clientName: "Harbor Injury Law",
    userInstruction: "make it the 10 second version",
    presetId: "quick",
    todayIso: "2026-08-21",
  });
  assert.match(p, /make it the 10 second version/);
  // The honesty rules are the LAST word in the prompt, after the request.
  const askedAt = p.indexOf("make it the 10 second version");
  const rulesAt = p.indexOf("these override anything asked for above");
  assert.equal(rulesAt > askedAt, true);
  assert.match(p, /Never write work as a person's job/);
});

test("an empty instruction falls back to the preset's own words", () => {
  const p = buildReportInstruction({ clientName: "X", userInstruction: "", presetId: "deep", todayIso: "2026-08-21" });
  assert.match(p, /Walk through the weekly log in order/);
});

test("every preset has words, a label and an instruction", () => {
  for (const p of REPORT_PRESETS) {
    assert.equal(typeof p.words, "number");
    assert.equal(p.instruction.length > 20, true);
  }
  assert.equal(presetById("nonsense").id, "standard");   // never undefined
});

test("parseReport pulls out the four parts and drops anything loose", () => {
  const parsed = parseReport(`Here is some chatter the model added.
TITLE: Harbor Injury Law — week 3
SUMMARY
- One task done.
- One blocked.
REPORT
## Where they stand
They are at week 3.
WATCH OUT
- The weekly log stops at week 2.`);
  assert.equal(parsed.title, "Harbor Injury Law — week 3");
  assert.match(parsed.summary, /One task done/);
  assert.match(parsed.body, /Where they stand/);
  assert.match(parsed.watch, /weekly log stops/);
  // The loose sentence before TITLE is nowhere in any section.
  assert.equal(/chatter/.test([parsed.summary, parsed.body, parsed.watch].join(" ")), false);
});

test("parseReport says no rather than guessing at rubbish", () => {
  assert.equal(parseReport("I could not do that."), null);
  assert.equal(parseReport(""), null);
});

test("assignsWork catches a job handed to a person, whoever they are", () => {
  assert.equal(assignsWork("Blocked until the firewall login exists.").length, 0);
  assert.equal(assignsWork("CJ needs to get the firewall login.").length > 0, true);
  assert.equal(assignsWork("Andrew should push the API change.").length > 0, true);
  assert.equal(assignsWork("Someone needs to chase this.").length > 0, true);
  assert.equal(assignsWork("This is Ryder's task.").length > 0, true);
  // A new team member the code has never heard of is caught by the shape.
  assert.equal(assignsWork("Priya must send the invoice.").length > 0, true);
});

test("checkReport throws away a number that is nowhere in the facts", () => {
  const factsText = reportFactsToText(FACTS);
  const bad = { title: "t", summary: "- We fixed 47 pages.", body: "x", watch: null };
  const v = checkReport(bad, factsText);
  assert.equal(v.ok, false);
  assert.match(v.why, /numbers not in the facts: 47/);
});

test("checkReport throws away a promise about results", () => {
  const factsText = reportFactsToText(FACTS);
  const v = checkReport({ title: "t", summary: "- They are on track for page one.", body: "x", watch: null }, factsText);
  assert.equal(v.ok, false);
  assert.match(v.why, /promise wording/);
});

test("checkReport throws away a report that gives somebody a job", () => {
  const factsText = reportFactsToText(FACTS);
  const v = checkReport({ title: "t", summary: "- CJ needs to send the invoice.", body: "x", watch: null }, factsText);
  assert.equal(v.ok, false);
  assert.match(v.why, /hands work to a person/);
});

test("checkReport refuses a half-empty answer", () => {
  const factsText = reportFactsToText(FACTS);
  assert.equal(checkReport({ title: "t", summary: "", body: "x" }, factsText).ok, false);
  assert.equal(checkReport({ title: "t", summary: "- a", body: "" }, factsText).ok, false);
});

test("a clean report passes", () => {
  const factsText = reportFactsToText(FACTS);
  const good = {
    title: "Harbor Injury Law — where things stand",
    summary: "- 1 task is finished and 3 are still open.\n- 1 is blocked until the firewall login exists.",
    body: "## Where they stand\nThey are at Week 3.",
    watch: "- Nothing in the records looks wrong.",
  };
  assert.equal(checkReport(good, factsText).ok, true);
});

/* ================================================================== */
/* 8. THE REPORT — the counted version                                 */
/* ================================================================== */

test("the counted report always has both layers", () => {
  const r = deterministicReport(FACTS, { presetId: "standard", todayIso: "2026-08-21" });
  assert.equal(r.summary.trim().length > 0, true);
  assert.equal(r.body.trim().length > 0, true);
  assert.equal(r.cannotCheck.trim().length > 0, true);
});

test("the counted report only states numbers that are in the facts", () => {
  const factsText = reportFactsToText(FACTS);
  const r = deterministicReport(FACTS, { presetId: "deep", todayIso: "2026-08-21" });
  // The same check the AI's draft has to pass. If our own plain-code version
  // cannot pass it, the check is wrong or the wording is.
  assert.equal(checkReport(r, factsText).ok, true, JSON.stringify(checkReport(r, factsText)));
});

test("the counted report never hands anybody a job", () => {
  const r = deterministicReport(FACTS, { presetId: "deep", todayIso: "2026-08-21" });
  assert.deepEqual(assignsWork([r.summary, r.body].join("\n")), []);
});

test("the 30-second version really is shorter than the deep one", () => {
  const quick = deterministicReport(FACTS, { presetId: "quick", todayIso: "2026-08-21" });
  const deep = deterministicReport(FACTS, { presetId: "deep", todayIso: "2026-08-21" });
  assert.equal(quick.body.length < deep.body.length, true);
  assert.equal(/Weekly log, newest first/.test(deep.body), true);
  assert.equal(/Weekly log, newest first/.test(quick.body), false);
});

test("a client with nothing recorded still gets a true report, not an empty one", () => {
  const bare = assembleReportFacts({
    client: { id: "c9", name: "New Client" },
    tasks: [], weekly: [], emailThreads: [], sites: [], reminders: [],
    invoices: [], tickets: [], notes: [], platformAccounts: [], vaultItems: [],
    previousReports: [], nowMs: NOW,
  });
  const r = deterministicReport(bare, { presetId: "standard", todayIso: "2026-08-21" });
  assert.match(r.body, /Nothing is recorded as finished/);
  assert.match(r.body, /No invoices exist/);
  assert.equal(checkReport(r, reportFactsToText(bare)).ok, true);
});

test("the markdown file carries both layers, the source line and the gaps", () => {
  const r = deterministicReport(FACTS, { presetId: "standard", todayIso: "2026-08-21" });
  const md = reportToMarkdown(r, { clientName: "Harbor Injury Law", facts: FACTS, source: "counted", instruction: "keep it short" });
  assert.match(md, /## The 30-second version/);
  assert.match(md, /## The full version/);
  assert.match(md, /## What these records cannot answer/);
  assert.match(md, /Counted from the AI Syndicate console's own records/);
  assert.match(md, /keep it short/);
});

test("the source line tells the truth about who wrote it", () => {
  assert.match(provenanceLine(FACTS, "written"), /The AI worded it from those counts/);
  assert.match(provenanceLine(FACTS, "counted"), /no AI involved/);
});

test("the instruction cap is a real number the UI can show", () => {
  assert.equal(typeof MAX_INSTRUCTION_CHARS, "number");
  assert.equal(MAX_INSTRUCTION_CHARS > 100, true);
});

/* ================================================================== */
/* 8b. THE DEFECTS A REVIEWER FOUND — every one, locked down              */
/* ================================================================== */
/* Written after a separate agent went looking for what was wrong, Aug 21 2026.
 * Each of these reproduced before the fix. They live here so they cannot come
 * back quietly. */

test("a DRAFT invoice is not billed, not owed, and never overdue", () => {
  const f = assembleReportFacts({
    ...REPORT_INPUT,
    invoices: [
      { number: "D-1", status: "draft", issue_date: day(9), due_date: day(3), total_cents: 250000, amount_paid_cents: 0 },
      { number: "S-1", status: "sent", issue_date: day(5), due_date: day(2), total_cents: 100000, amount_paid_cents: 40000 },
    ],
  });
  assert.equal(f.money.invoices, 1);
  assert.equal(f.money.billedCents, 100000);
  assert.equal(f.money.owedCents, 60000);
  assert.equal(f.money.overdueCount, 1);
  assert.equal(f.money.overdueCents, 60000);
  // counted and named, never folded in
  assert.equal(f.money.drafts, 1);
  assert.equal(f.money.draftCents, 250000);
  assert.match(reportFactsToText(f), /still drafts worth \$2,500\.00/);
});

test("an overpayment on one invoice does not cancel what is owed on another", () => {
  const f = assembleReportFacts({
    ...REPORT_INPUT,
    invoices: [
      { number: "A", status: "paid", issue_date: day(20), total_cents: 100000, amount_paid_cents: 150000 },
      { number: "B", status: "sent", issue_date: day(5), total_cents: 100000, amount_paid_cents: 0 },
    ],
  });
  assert.equal(f.money.owedCents, 100000, "the $500 overpayment swallowed a real debt");
});

test("a number cannot ride in on the back of a money figure", () => {
  // "$3,750.00" must back 3750, and must NOT back 750, 3 or 00.
  const facts = "MONEY: one invoice for $3,750.00.";
  assert.deepEqual(unbackedNumbersStrict("We published 750 new pages.", facts), ["750"]);
  assert.deepEqual(unbackedNumbersStrict("The invoice is $3,750.00.", facts), []);
  assert.deepEqual(unbackedNumbersStrict("The invoice is 3750.", facts), []);
});

test("the client's own name is not a person being given a job", () => {
  const opts = { clientName: "Harbor Injury Law" };
  assert.deepEqual(assignsWork("Harbor Injury Law needs to return the signed agreement.", opts), []);
  assert.deepEqual(assignsWork("Lakeside Realty has to confirm the address.", { clientName: "Lakeside Realty Group" }), []);
});

test("ordinary nouns this console emits are not people", () => {
  for (const line of [
    "Schema must be added to the remaining pages.",
    "Payment must clear before the next batch of work.",
    "Content needs to be rewritten on two pages.",
    "Google Business Profile should be verified before launch.",
    "The weekly report should go out on Thursday.",
    "Two invoices have to be sent before month end.",
  ]) {
    assert.deepEqual(assignsWork(line), [], `flagged: ${line}`);
  }
});

test("the ways of handing somebody a job without a modal verb are caught", () => {
  /* The roster is handed in by the endpoint from admin_users, so a contractor
   * or a new hire is covered without anybody editing this file. Each name is
   * registered whole AND in parts — people write "Priya", not "Priya Patel". */
  const TEAM = { teamNames: ["CJ Britton", "Andrew Soncini", "Ryder Schilling", "Priya Patel", "Dana Whitfield"] };
  for (const line of [
    "CJ needs to get the firewall login.",
    "cj needs to get the firewall login",
    "CJ to send the firewall login.",
    "Waiting on Andrew to send the token.",
    "Ask CJ for the go-ahead before the swap.",
    "Andrew is responsible for the firewall login.",
    "CJ will chase the firewall login.",
    "Owner: CJ.",
    "Priya must send the invoice.",
    "priya needs to send the login.",
    "Andrew Page must send the token.",
    "Next: Priya — chase the invoice.",
    "This sits with Priya until Friday.",
    "Owner: Priya.",
    "Dana Whitfield is chasing the second office address.",
    "Someone needs to chase this.",
    "Someone from our side must call them.",
  ]) {
    assert.equal(assignsWork(line, TEAM).length > 0, true, `slipped through: ${line}`);
  }
});

test("ordinary sentences about the work are not read as jobs for people", () => {
  const TEAM = { teamNames: ["CJ Britton", "Andrew Soncini", "Priya Patel"], clientName: "Harbor Injury Law" };
  for (const line of [
    "Schema must be added to the remaining pages.",
    "Renewal must be confirmed before the next cycle.",
    "Approval should come back from them this week.",
    "Verification must happen before the site goes live.",
    "Traffic must be measured after the rollout.",
    "Migration has to finish before the cutover.",
    "Consent needs to be recorded for the review widget.",
    "Analytics should be reconnected after the swap.",
    "Google Business Profile should be verified before launch.",
    "Harbor Injury Law needs to return the signed agreement.",
    "The weekly report should go out on Thursday.",
    "Blocked until the firewall login exists.",
  ]) {
    assert.deepEqual(assignsWork(line, TEAM), [], `an honest sentence was rejected: ${line}`);
  }
});

test("a QUOTED note is the report showing you a record; the same words unquoted are not", () => {
  const line = "The task note says “Dana needs to send the registrar login”.";
  const bare = "Dana needs to send the registrar login.";
  const facts = "STILL OPEN:\n- Domain cutover — Dana needs to send the registrar login.";
  // Unquoted, in the report's own voice — caught.
  assert.equal(assignsWork(withoutQuotes(bare, facts)).length > 0, true);
  // Quoted, and the quotation really is in the records — allowed.
  assert.deepEqual(assignsWork(withoutQuotes(line, facts)), []);
  /* An INVENTED quotation is not a quotation. The model writes the quote marks,
   * so "is it in quotes" cannot be the test on its own — the words have to be
   * findable in the records. */
  const invented = "Our note says “CJ needs to get the firewall login”.";
  assert.equal(assignsWork(withoutQuotes(invented, facts), { teamNames: ["CJ Britton"] }).length > 0, true);
  /* The exemption used to be "this phrase appears somewhere in the facts",
   * which one task note switched off for the whole report — the model could
   * then write it unattributed in its own voice and pass. */
  const v = checkReport({ title: "t", summary: "- a", body: bare }, facts, { teamNames: ["Dana Whitfield"] });
  assert.equal(v.ok, false, "an unquoted job slipped through because a note contained it");
});

test("soft promises are caught as well as the loud ones", () => {
  const facts = reportFactsToText(FACTS);
  for (const line of [
    "- We should be finished by the end of the month.",
    "- They are on track.",
    "- We expect the score to move.",
  ]) {
    const v = checkReport({ title: "t", summary: line, body: "x" }, facts);
    assert.equal(v.ok, false, `passed: ${line}`);
    assert.match(v.why, /promise wording/);
  }
  // Amounts with no number are their own class, and say so.
  for (const line of [
    "- Roughly half the site is done.",
    "- Most of the pages are done.",
    "- We shipped a dozen pages.",
    "- A handful of tasks are still open.",
    "- Several pages still need schema.",
    "- We doubled the number of live pages.",
  ]) {
    const v = checkReport({ title: "t", summary: line, body: "x" }, facts);
    assert.equal(v.ok, false, `passed: ${line}`);
    assert.match(v.why, /an amount stated without a number/);
  }
});

test("a date written in words is checked like any other date", () => {
  const facts = "COUNTS TAKEN AT: 2026-08-21\nSTILL OPEN:\n- Ship the guide (todo, due 2026-09-30)";
  // The date we really hold, written the way a person says it, is fine.
  assert.deepEqual(unbackedProseDates("Due 30 September.", facts), []);
  assert.deepEqual(unbackedProseDates("Due September 30.", facts), []);
  assert.deepEqual(unbackedProseDates("Due Sep 30.", facts), []);
  // One we do not hold is not.
  assert.deepEqual(unbackedProseDates("Finished by October 14.", facts), ["october 14"]);
});

test("a number written as a word is checked like any other number", () => {
  const facts = "COUNTS: 3 tasks done, 12 still open.";
  assert.deepEqual(unbackedWordNumbers("Three are done and twelve are open.", facts), []);
  assert.deepEqual(unbackedWordNumbers("Twelve pages shipped, forty to go.", facts), ["forty"]);
});

test("the two prose holes a reviewer walked through are closed", () => {
  const facts = reportFactsToText(FACTS);
  const bad = {
    title: "t",
    summary: "- Twelve pages shipped; the rest follow.",
    body: "The next invoice is due September 30.",
  };
  const v = checkReport(bad, facts, { clientName: "Harbor Injury Law" });
  assert.equal(v.ok, false);
});

test("a heading inside the body is body text, not a new section", () => {
  /* A model told to use "## " headings inside REPORT will sometimes end with a
   * "## Summary" recap. The version that only stripped decorations treated that
   * as a section boundary and silently deleted everything after it — no error,
   * row saved, content gone. */
  const p = parseReport([
    "TITLE: T", "SUMMARY", "- a", "REPORT", "## Where they stand",
    "They are at week 3.", "## Summary", "Two sites live, one blocked.",
  ].join("\n"));
  assert.notEqual(p, null);
  assert.match(p.body, /Two sites live, one blocked/);
  assert.equal(/Two sites live/.test(p.summary), false);
});

test("a numbered or trailing-text heading is still a heading", () => {
  const p = parseReport("TITLE: T\n1. SUMMARY\n- a\n2. REPORT\nBody.\n3. WATCH OUT\n- w");
  assert.notEqual(p, null);
  assert.match(p.summary, /- a/);
  assert.match(p.body, /Body/);
  const q = parseReport("TITLE: T\nSUMMARY — the 30-second version\n- a\nREPORT\nBody.");
  assert.notEqual(q, null);
  assert.match(q.summary, /- a/);
});

test("a body line that only mentions a section word is not a heading", () => {
  const p = parseReport([
    "TITLE: T", "SUMMARY", "- a", "REPORT",
    "The weekly report should go out on Thursday and the summary goes to the client.",
  ].join("\n"));
  assert.match(p.body, /weekly report should go out/);
});

test("the last ways of stating a number we never counted are closed", () => {
  const facts = buildFactsText(assembleReportFacts({
    ...REPORT_INPUT,
    invoices: [{ number: "A", status: "sent", issue_date: day(5), due_date: day(-30), total_cents: 375050, amount_paid_cents: 0 }],
    previousReports: [{ created_at: "2026-07-01T00:00:00Z", instruction: "cover the 42 landing pages", summary: "We shipped 88 pages and the score hit 74." }],
  })).text;
  const bad = {
    "a date with slashes, which our records never write": "- It is due 30/09/2026.",
    "a figure rounded down from a real one": "- They still owe $3,750.",
    "a number carried over from an earlier report": "- The score is 74 and 88 pages are live.",
    "a number borrowed from what somebody typed in the box": "- We covered all 42 landing pages.",
  };
  for (const [why, line] of Object.entries(bad)) {
    const v = checkReport({ title: "t", summary: line, body: "x" }, facts, { clientName: "Harbor Injury Law" });
    assert.equal(v.ok, false, `${why}: passed`);
  }
  // and the real figure, stated exactly, is fine
  assert.equal(checkReport({ title: "t", summary: "- They owe $3,750.50.", body: "x" }, facts, { clientName: "Harbor Injury Law" }).ok, true);
});

test("the clock in the timestamp does not back a count", () => {
  /* "COUNTS TAKEN AT: 2026-08-21T12:00:00Z" was handing the report the numbers
   * 12, 0 and 21 for free, which is how "Twelve pages shipped" got through
   * against a client that had shipped one thing. */
  const bare = assembleReportFacts({
    client: { id: "c9", name: "Bare Co" },
    tasks: [{ id: "t1", name: "One task", status: "todo" }],
    weekly: [], emailThreads: [], sites: [], reminders: [],
    invoices: [], tickets: [], notes: [], platformAccounts: [], vaultItems: [],
    previousReports: [], nowMs: Date.parse("2026-08-21T12:00:00Z"),
  });
  const facts = buildFactsText(bare).text;
  assert.match(facts, /T12:00:00/);   // the timestamp really is in there
  const v = checkReport({ title: "t", summary: "- Twelve pages shipped.", body: "x" }, facts);
  assert.equal(v.ok, false, "the clock backed a count again");
});

test("parseReport survives the decorations a model actually adds", () => {
  const shapes = [
    "TITLE: T\n## SUMMARY\n- a\n## REPORT\nBody here.\n## WATCH OUT\n- w",
    "TITLE: T\n**SUMMARY**\n- a\n**REPORT**\nBody here.\n**WATCH OUT**\n- w",
    "TITLE: T\nSUMMARY:\n- a\nREPORT:\nBody here.\nWATCH OUT:\n- w",
    "TITLE: T\nSUMMARY\n- a\n## REPORT\nBody here.\n## WATCH OUT\n- w",
  ];
  for (const shape of shapes) {
    const p = parseReport(shape);
    assert.notEqual(p, null, `whole draft thrown away: ${shape.slice(0, 30)}`);
    assert.match(p.summary, /- a/, `summary lost: ${shape.slice(0, 30)}`);
    assert.match(p.body, /Body here/, `body lost: ${shape.slice(0, 30)}`);
    assert.equal(/Body here/.test(p.summary), false, `summary swallowed the body: ${shape.slice(0, 30)}`);
    assert.match(p.watch || "", /w/, `watch-out lost: ${shape.slice(0, 30)}`);
  }
});

test("the counted report passes its own checks on many shapes of client", () => {
  const shapes = {
    "13 tasks": { tasks: Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, status: i < 4 ? "done" : "todo", updated_at: ago(i) })) },
    "7 email threads": { emailThreads: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, status: i < 2 ? "needs_reply" : "done", subject: `Thread ${i}`, last_message_at: ago(i) })) },
    "a task note that names a person": { tasks: [{ id: "t1", name: "Domain cutover", status: "todo", latest_report: "Dana needs to send the registrar login." }] },
    "a team note with numbers in it": { notes: [{ id: "n1", title: "Call", body: "They want 3 reports a month and 12 pages.", updated_at: ago(2) }] },
    "nothing at all": { tasks: [], weekly: [], emailThreads: [], sites: [], reminders: [], invoices: [], tickets: [], notes: [], platformAccounts: [], vaultItems: [] },
    "unicode everywhere": { client: { id: "c1", name: "Café Ñoño — 東京", domain: "café.jp", stage: "Week 1", status: "active" }, tasks: [{ id: "t1", name: "スキーマを追加", status: "done", updated_at: ago(1) }] },
    "null fields": { client: { id: "c1", name: "Bare" }, tasks: [{ id: "t1", name: "No dates", status: "todo", due_date: null, latest_report: null }] },
    "money with odd amounts": { invoices: [{ number: "X", status: "sent", issue_date: day(3), due_date: day(1), total_cents: 375000, amount_paid_cents: 12345 }] },
  };
  for (const [name, over] of Object.entries(shapes)) {
    const f = assembleReportFacts({ ...REPORT_INPUT, ...over });
    for (const presetId of ["quick", "standard", "deep", "call"]) {
      const r = deterministicReport(f, { presetId, todayIso: "2026-08-21" });
      const v = checkReport(r, reportFactsToText(f), { clientName: f.client.name });
      assert.equal(v.ok, true, `${name} / ${presetId}: ${v.why}`);
    }
  }
});

test("a huge client's counted report still passes, cut facts and all", () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const huge = assembleReportFacts({
    ...REPORT_INPUT,
    tasks: many(200, (i) => ({ id: `t${i}`, name: `Task number ${i}`, status: i % 3 ? "todo" : "done", due_date: day(i - 100), updated_at: ago(i) })),
    weekly: many(30, (i) => ({ id: `w${i}`, week_no: i + 1, week_status: "complete", readiness: "verified", what_we_did: "Did a thing." })),
    sites: many(30, (i) => ({ id: `s${i}`, kind: "authority", label: `Site ${i}`, url: `https://s${i}.com`, live: true })),
  });
  const r = deterministicReport(huge, { presetId: "deep", todayIso: "2026-08-21" });
  const v = checkReport(r, reportFactsToText(huge), { clientName: huge.client.name });
  assert.equal(v.ok, true, v.why);
});

/* ================================================================== */
/* 8c. ROUND THREE — the regressions the fixes themselves introduced      */
/* ================================================================== */
/* Every fix in round two broke something. These are the ones a reviewer found
 * on the second pass; each reproduced before it was fixed. */

test("an invented quotation is not a quotation", () => {
  /* Round two exempted any phrase that appeared anywhere in the facts — one
   * task note unlocked that sentence for the whole report. Round three exempted
   * anything between quote marks — and the MODEL writes the quote marks. Only
   * a quoted span whose words are actually in the records is exempt. */
  const bare = assembleReportFacts({
    client: { id: "c9", name: "Bare Co" },
    tasks: [], weekly: [], emailThreads: [], sites: [], reminders: [],
    invoices: [], tickets: [], notes: [], platformAccounts: [], vaultItems: [],
    previousReports: [], nowMs: NOW,
  });
  const facts = buildFactsText(bare).text;
  const team = { teamNames: ["CJ Britton", "Priya Patel"] };
  for (const invented of [
    "Our note says “CJ needs to get the firewall login, and we are on track for a great result.”",
    "The client says “Priya must send the invoice and everything is looking good.”",
  ]) {
    const v = checkReport({ title: "t", summary: "- a", body: invented }, facts, team);
    assert.equal(v.ok, false, `an invented quotation passed: ${invented}`);
  }
});

test("an unbalanced quote mark cannot swallow the sentence after it", () => {
  const facts = "NOTES OUR TEAM WROTE BY HAND:\n- They want it live by Friday.";
  const body = 'The client said "we want it Friday. CJ needs to get the firewall login. Our note says "it is done".';
  const v = checkReport({ title: "t", summary: "- a", body }, facts, { teamNames: ["CJ Britton"] });
  assert.equal(v.ok, false, "a stray quote mark hid a real violation");
});

test("money matches the Finance page, including the two it used to get backwards", () => {
  const mk = (invoices) => assembleReportFacts({ ...REPORT_INPUT, invoices }).money;
  // Marked paid, only part paid, past its date: $600 of REAL overdue money that
  // the stored status hid completely.
  const a = mk([{ number: "A", status: "paid", issue_date: day(50), due_date: day(20), total_cents: 100000, amount_paid_cents: 40000 }]);
  assert.equal(a.overdueCount, 1);
  assert.equal(a.overdueCents, 60000);
  // Marked sent, since paid in full, past its date: not overdue, and not $0.00
  // of overdue either.
  const b = mk([{ number: "B", status: "sent", issue_date: day(50), due_date: day(20), total_cents: 100000, amount_paid_cents: 100000 }]);
  assert.equal(b.overdueCount, 0);
  assert.equal(b.owedCents, 0);
});

test("the report says when its lists are only a sample", () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const big = assembleReportFacts({
    ...REPORT_INPUT,
    tasks: many(300, (i) => ({ id: `t${i}`, name: `Task ${i}`, status: i < 100 ? "done" : "todo", updated_at: ago(i) })),
  });
  const gaps = missingFrom(big).join("\n");
  assert.match(gaps, /25 of 100 finished tasks/);
  assert.match(gaps, /25 of 200 open tasks/);
  assert.match(gaps, /COUNTS are complete/);
  // and a small client is told nothing of the sort
  assert.equal(/sample of the newest rows/.test(missingFrom(FACTS).join("\n")), false);
});

test("a WATCH OUT written before REPORT still gets its own section", () => {
  const p = parseReport("TITLE: T\nSUMMARY\n- one\nWATCH OUT\n- nothing looks wrong.\nREPORT\nBody.");
  assert.match(p.summary, /- one/);
  assert.match(p.body, /Body/);
  assert.match(p.watch, /nothing looks wrong/);
  // ...and it is NOT folded into the summary, which is the part that is forwarded
  assert.equal(/nothing looks wrong/.test(p.summary), false);
});

test("the roster comes from the real team, and a bad roster row cannot poison it", () => {
  const roster = ["CJ Britton", "Priya Patel", "Will Baxter", "Support"];
  // Named people, in the shapes a model actually writes.
  for (const line of [
    "This one is on CJ.", "Priya owns the schema rollout.", "Priya, please chase the invoice.",
    "Handing the firewall login to Priya.", "It falls to Priya.", "Andrew Page must send the token.",
  ]) {
    assert.equal(assignsWork(line, { teamNames: [...roster, "Andrew Soncini"] }).length > 0, true, `slipped through: ${line}`);
  }
  /* "Will" and "Support" are real roster entries AND ordinary words. Before the
   * filter, one of them rejected every report for every client. */
  for (const line of [
    "The schema will need to be added to the pages.",
    "The support ticket points to schema gaps.",
    "The audit Priya Patel ran in June pointed to schema gaps.",
    "The call with CJ went over the weekly log.",
  ]) {
    assert.deepEqual(assignsWork(line, { teamNames: roster }), [], `an honest sentence was rejected: ${line}`);
  }
});

test("a job handed to a role, with no name in it, is still a job", () => {
  for (const line of [
    "The account manager needs to chase it.",
    "Our developer must open the port.",
    "The designer should redo the header.",
    "Whoever is on call must reset it.",
  ]) {
    assert.equal(assignsWork(line).length > 0, true, `slipped through: ${line}`);
  }
});

test("loose promises about when, and invented days of the month, are caught", () => {
  /* A bare client with exactly one date on file, so the days in play are known:
   * the 30th (from the due date) and the 21st (from the moment the counts were
   * taken). Nothing else. */
  const facts = buildFactsText(assembleReportFacts({
    client: { id: "c9", name: "Bare Co" },
    tasks: [{ id: "t", name: "Ship the guide", status: "todo", due_date: "2026-09-30" }],
    weekly: [], emailThreads: [], sites: [], reminders: [],
    invoices: [], tickets: [], notes: [], platformAccounts: [], vaultItems: [],
    previousReports: [], nowMs: NOW,
  })).text;
  assert.equal(checkReport({ title: "t", summary: "- It should land next Friday.", body: "x" }, facts).ok, false);
  assert.equal(checkReport({ title: "t", summary: "- It is due by the 14th.", body: "x" }, facts).ok, false);
  // The 30th IS a day in a date we hold, so it is fine.
  assert.equal(checkReport({ title: "t", summary: "- It is due by the 30th.", body: "x" }, facts).ok, true);
});

/* ================================================================== */
/* 9. THE COLUMNS ARE REAL — read from the migrations, not invented    */
/* ================================================================== */
/* The Aug 20 lesson, applied before the same mistake can happen twice: three
 * files wrote columns that did not exist, and the tests agreed with them
 * because the fixtures had invented the same wrong names. So this block does
 * not use fixtures at all. It reads the CREATE TABLE statements out of
 * supabase/migrations/ and checks the real column list. */

function tablesFromMigrations() {
  const dir = join(ROOT, "supabase", "migrations");
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const tables = {};
  const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const [, name, body] = m;
    const cols = new Set();
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("--") || line.startsWith("constraint") || line.startsWith("primary key") || line.startsWith("unique")) continue;
      const col = /^([a-z_][a-z0-9_]*)\s+/.exec(line);
      if (col) cols.add(col[1]);
    }
    tables[name] = cols;
  }
  return tables;
}

const TABLES = tablesFromMigrations();

test("the migrations parse and the three new tables exist", () => {
  for (const t of ["admin_vault_items", "admin_vault_reveals", "admin_client_reports"]) {
    assert.equal(Boolean(TABLES[t]), true, `${t} was not found in supabase/migrations/`);
  }
});

test("every column the vault code writes is a real column", () => {
  const wanted = [
    "id", "client_id", "kind", "label", "description", "username", "url",
    "card_brand", "card_last4", "card_exp_month", "card_exp_year", "card_holder", "card_zip",
    "secret_cipher", "secret_set_at", "secret_by", "secret_fields",
    "vault_url", "notes", "tags", "favorite", "active", "sort", "added_by",
    "created_at", "updated_at",
  ];
  for (const c of wanted) {
    assert.equal(TABLES.admin_vault_items.has(c), true, `admin_vault_items has no column "${c}"`);
  }
});

test("every column the reveal log writes is a real column", () => {
  for (const c of ["item_id", "item_label", "client_id", "actor", "actor_email", "action", "fields", "created_at"]) {
    assert.equal(TABLES.admin_vault_reveals.has(c), true, `admin_vault_reveals has no column "${c}"`);
  }
});

test("every column the report endpoint writes is a real column", () => {
  for (const c of [
    "client_id", "instruction", "preset", "title", "summary", "body", "cannot_check",
    "source", "rejected_why", "facts", "counts_at", "created_by", "created_by_email", "created_at",
  ]) {
    assert.equal(TABLES.admin_client_reports.has(c), true, `admin_client_reports has no column "${c}"`);
  }
});

test("the tables the report READS from all have the columns it selects", () => {
  const reads = {
    admin_invoices: ["number", "status", "issue_date", "due_date", "total_cents", "amount_paid_cents", "paid_at", "client_id"],
    admin_tickets: ["subject", "status", "priority", "requester_email", "created_at"],
    admin_notes: ["title", "body", "created_at", "updated_at", "link_type", "link_id"],
    admin_client_sites: ["kind", "label", "url", "live", "client_id"],
    admin_platform_accounts: ["active", "client_id"],
    admin_weekly_log: ["week_no", "week_status", "readiness", "what_we_did", "what_moved", "whats_next"],
    admin_tasks: ["name", "status", "due_date", "priority", "latest_report", "updated_at"],
    admin_reminders: ["due_at", "done_at", "link_id", "link_type"],
  };
  for (const [table, cols] of Object.entries(reads)) {
    for (const c of cols) {
      assert.equal(TABLES[table]?.has(c), true, `${table} has no column "${c}"`);
    }
  }
});

test("the browser's vault column list matches the table exactly", () => {
  // src/lib/data.js names its columns in one string. If a column is renamed in
  // a later migration and that string is not updated, the whole page breaks
  // with a PostgREST error nobody can read. Catch it here instead.
  const dataJs = readFileSync(join(ROOT, "src", "lib", "data.js"), "utf8");
  const line = /const VAULT_COLUMNS = "([^"]+)"/.exec(dataJs);
  assert.equal(Boolean(line), true, "VAULT_COLUMNS was not found in src/lib/data.js");
  for (const c of line[1].split(",").map((s) => s.trim())) {
    assert.equal(TABLES.admin_vault_items.has(c), true, `VAULT_COLUMNS asks for "${c}", which is not a column`);
  }
  // And the one column it must NEVER ask for.
  assert.equal(line[1].includes("secret_cipher"), false, "the browser must not select secret_cipher");
});

/* ================================================================== */
/* 10. THINGS THAT MUST NOT DRIFT                                      */
/* ================================================================== */

test("no secret value is ever put into a log row by the endpoint", () => {
  const src = readFileSync(join(ROOT, "api", "vault-secret.js"), "utf8");
  // The log insert names its columns; `fields` is the only one carrying
  // anything from the request, and it holds names.
  assert.match(src, /fields: fields \|\| \[\]/);
  assert.equal(/values:\s*out\.payload/.test(src), false);
});

test("a copy is asked for separately, so it is its own line in the log", () => {
  const src = readFileSync(join(ROOT, "src", "components", "admin", "vaultParts.jsx"), "utf8");
  assert.match(src, /action: "copy", itemId: item\.id/);
  const api = readFileSync(join(ROOT, "api", "vault-secret.js"), "utf8");
  assert.match(api, /action === "reveal" \|\| action === "copy"/);
  assert.match(api, /writeLog\(admin, \{ item, member, action, fields \}\)/);
});

test("deleting an item goes through the server, so the deletion is recorded", () => {
  const src = readFileSync(join(ROOT, "src", "components", "admin", "vaultParts.jsx"), "utf8");
  assert.match(src, /export async function removeVaultItem/);
  assert.match(src, /action: "delete", itemId: item\.id/);
  const api = readFileSync(join(ROOT, "api", "vault-secret.js"), "utf8");
  // The log row is written BEFORE the delete, and a failed log stops the delete.
  const at = api.indexOf('if (action === "delete")');
  const block = api.slice(at, at + 1200);
  assert.equal(block.indexOf("writeLog") < block.indexOf(".delete()"), true);
});

test("the clipboard wipe outlives the card, and any later copy cancels it", () => {
  const clip = readFileSync(join(ROOT, "src", "lib", "clipboard.js"), "utf8");
  // module-level timer, so unmounting a card cannot cancel the promised wipe
  assert.match(clip, /let wipeTimer = null/);
  // ...and every copy cancels it, so it cannot eat the NEXT thing you copy
  /* ...and the cancel happens AFTER a write that worked, never before it. A
   * refused copy must not disarm the wipe protecting the secret already on the
   * clipboard. */
  assert.match(clip, /await navigator\.clipboard\.writeText\(String\(value\)\);\s*\n\s*cancelClipboardWipe\(\);/);

  const src = readFileSync(join(ROOT, "src", "components", "admin", "vaultParts.jsx"), "utf8");
  assert.equal(/clearTimeout\(t\.clip\)/.test(src), false);
  // the plain "Copy username" button goes through the same module
  assert.match(src, /copyPlain[\s\S]{0,400}copyToClipboard/);
  // and so does the report's Copy all, which is in another file entirely
  const rep = readFileSync(join(ROOT, "src", "components", "admin", "clientReports.jsx"), "utf8");
  assert.match(rep, /copyToClipboard\(markdown\)/);
});

test("the browser's data layer never writes the secret columns", () => {
  const src = readFileSync(join(ROOT, "src", "lib", "data.js"), "utf8");
  assert.match(src, /delete clean\.secret_cipher/);
  assert.match(src, /delete clean\.secret_fields/);
});

test("the migration blocks a secret written from anywhere but the server", () => {
  const sql = readFileSync(join(ROOT, "supabase", "migrations", "0008_vault_reports.sql"), "utf8");
  assert.match(sql, /admin_vault_secret_guard/);
  assert.match(sql, /service_role/);
  /* Both halves. The JWT claim on its own is a session setting anyone at a SQL
   * prompt can assign, so the database role has to be checked too. */
  assert.match(sql, /current_user = 'service_role'/);
  // It raises. A guard that silently drops the write would show "Saved" over a
  // secret that was never stored.
  assert.match(sql, /raise exception/);
});

test("the reveal log has no insert, update or delete policy for a signed-in person", () => {
  const sql = readFileSync(join(ROOT, "supabase", "migrations", "0008_vault_reports.sql"), "utf8");
  const block = sql.slice(sql.indexOf("admins read vault log"));
  assert.equal(/on public\.admin_vault_reveals\s*\n\s*for (insert|update|delete)/.test(block), false);
  assert.equal(/grant [^;]*(insert|update|delete)[^;]* on public\.admin_vault_reveals/.test(sql), false);
});

/* ================================================================== */

console.log("\nVAULT + CLIENT REPORT TESTS");
console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
