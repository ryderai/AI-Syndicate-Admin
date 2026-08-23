/* The scrambling. SERVER ONLY — never import this from the browser.
 *
 * WHAT IT DOES, IN PLAIN WORDS
 * Turns "hunter2" into a line of gibberish that can only be turned back with a
 * key that lives in one place: the VAULT_KEY environment variable on Vercel.
 * The gibberish goes in the database. The key never does.
 *
 * So: whoever gets a copy of the database gets names, usernames and last-4s.
 * They do not get a single password. That is the whole point of the design, and
 * it is why the key must never be written into a migration, a note, Notion, or
 * this repo.
 *
 * THE FORMAT
 *   v1.<key fingerprint>.<iv>.<tag>.<ciphertext>     (all base64url)
 *
 * · v1                — so a future format can be told apart from this one.
 * · key fingerprint   — the first 8 hex characters of the SHA-256 of the key.
 *                       It is NOT the key and cannot be turned back into one.
 *                       It exists so that a rotated or mistyped key produces
 *                       "this was saved with a different key" instead of a raw
 *                       decryption crash that reads like a bug.
 * · iv                — 12 fresh random bytes per save. Never reused: reusing
 *                       one with the same key is the classic way AES-GCM leaks.
 * · tag               — the 16-byte authentication tag. If one character of the
 *                       ciphertext is altered, decryption FAILS rather than
 *                       returning a wrong answer.
 * · ciphertext        — the JSON of the secret fields, encrypted.
 *
 * TIED TO ITS ROW
 * Every encrypt mixes in "vault:<item id>" as additional authenticated data.
 * That id is not secret; the point is that the ciphertext is bound to the row
 * it belongs to. Copy the blob from one item onto another in the SQL editor and
 * the decrypt fails loudly instead of quietly revealing the wrong card under
 * the wrong name.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/* ------------------------------------------------------------------ */
/* The key                                                             */
/* ------------------------------------------------------------------ */

let cached = null;

/** base64url with no padding — safe inside a dot-separated string. */
function b64(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(str) {
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/* Words nobody's random key contains and everybody's chosen one does.
 *
 * Matched CASE-SENSITIVELY, in lowercase and Capitalised form only. The first
 * version matched case-insensitively, which turned "tokEN" and "paSSw" inside
 * ordinary random base64 into rejections — measured at 1 in 500 real keys,
 * with an error message telling the person to run the exact command they had
 * just run. Case-sensitive drops that to about one key in fifty million while
 * still catching every phrase a person would actually choose. */
/* Five letters or more only: a shorter word turns up inside real base64 often
 * enough to refuse a good key. ("key" is deliberately not here for that
 * reason — "MySuperSecretVaultKey" is caught by "vault" and "secret".) */
const CHOSEN_WORDS = [
  "secret", "vault", "passw", "syndicate", "admin", "please", "letmein",
  "qwerty", "master", "private", "change", "hunter", "monkey", "dragon",
  "access", "token", "crypto", "aisyndicate",
];

/** The word that made this look chosen, or null. Returned rather than a
 * boolean so the refusal can SAY which word it found — a person told only
 * "run openssl rand -base64 32" about the output of that exact command has no
 * way to work out what happened. It happens to about one real key in 1.7
 * million, so the message has to be useful when it does. */
function chosenWordIn(raw) {
  const s = String(raw);
  for (const w of CHOSEN_WORDS) {
    const Capital = w[0].toUpperCase() + w.slice(1);
    if (s.includes(w)) return w;
    if (s.includes(Capital)) return Capital;
    if (s.includes(w.toUpperCase())) return w.toUpperCase();
  }
  return null;
}

/**
 * Does this look like the output of a random generator, rather than something a
 * person composed? Three cheap tests, and none of them is a promise that the
 * key is strong — see the note in readVaultKey().
 */
function looksLikeRealKey(raw, key, { fromHex = false } = {}) {
  /* WHAT THIS CANNOT SEE, said plainly: the SHA-256 of a memorable phrase. It
   * has the byte spread of a real key because it IS a hash, and nothing here
   * can tell it from `openssl rand`. Somebody who hashes "aisyndicate2026" to
   * get 32 bytes gets a key an attacker can brute-force through SHA-256 at
   * billions of guesses a second, and this function will accept it. That is why
   * the Vault page gives the exact command and says to paste its output, rather
   * than saying "any 32 bytes". */
  /* 1. THE BYTES THEMSELVES. Two shapes a reviewer got past the first version:
   *    43 capital A characters decodes to 32 ZERO bytes — an all-zero AES key —
   *    and `echo -n 'a memorable phrase of 32 chars' | base64` decodes back to
   *    the phrase, where the words are invisible in the encoded text. Both are
   *    obvious in the decoded bytes and in nothing else. */
  const distinct = new Set(key).size;
  if (distinct < 12) return { ok: false, why: "it is made of only a handful of different bytes, which a random key never is" };
  /* MOSTLY printable, not entirely. `echo 'a phrase' | base64` — without -n —
   * puts a newline on the end, and one non-printable byte was enough to walk
   * past an every() check written specifically to catch that command. */
  const printable = [...key].filter((b) => b >= 0x20 && b <= 0x7e).length;
  if (printable >= key.length - 2) {
    return { ok: false, why: "it decodes back into typed text, so it is a phrase wearing base64" };
  }

  // 64 hex characters cannot carry a phrase in the text, so the two text tests
  // below do not apply to them. The byte tests above still do.
  if (fromHex) return { ok: true };

  /* 2. DOES IT ROUND-TRIP? Re-encoding the 32 bytes must give back what was
   *    typed. `openssl rand -base64 32` always does; a typed phrase almost
   *    never does, because base64 only uses part of the last character. */
  const normalized = String(raw).replace(/-/g, "+").replace(/_/g, "/");
  const reEncoded = Buffer.from(key).toString("base64");
  const roundTrips =
    reEncoded === normalized ||
    reEncoded.replace(/=+$/, "") === normalized.replace(/=+$/, "");
  if (!roundTrips) {
    return { ok: false, why: "it is not what a base64 encoder would have produced, so it was typed rather than generated" };
  }

  /* 3. DOES IT READ AS WORDS? This is what catches the camel-case survivors of
   *    test 2, like "MySuperSecretVaultKeyForAISyndicate12345678". */
  const word = chosenWordIn(raw);
  if (word) return { ok: false, why: `it contains the word "${word}", which random keys do not` };

  return { ok: true };
}

/**
 * Read VAULT_KEY and turn it into 32 bytes.
 * Accepts base64 (what `openssl rand -base64 32` prints) or hex (64 characters).
 * Anything else is refused with a message that says how to make a good one,
 * because a half-working key is worse than none: it would scramble things that
 * could never be unscrambled again.
 */
export function readVaultKey() {
  const raw = (process.env.VAULT_KEY || "").trim();
  if (!raw) return { ok: false, why: "VAULT_KEY is not set on the server, so nothing can be scrambled or unscrambled." };
  if (cached && cached.raw === raw) return cached.result;

  let key = null;
  let fromHex = false;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
    fromHex = true;   // 64 hex characters cannot be a phrase; the checks below are for base64
  } else {
    try {
      const buf = unb64(raw);
      if (buf.length === 32) key = buf;
    } catch { /* falls through to the message below */ }
  }

  /* A PASSPHRASE IS NOT A KEY, and base64 will not tell you that.
   *
   * Buffer.from(x, "base64") never throws — it drops what it does not
   * understand — so any 43 characters from the base64 alphabet decode to 32
   * bytes and sail through a length check. "ThisIsMyReallyLongSecretPassphrase
   * ForVault1" is exactly 43 such characters, and before this the console
   * reported the vault as armed while every card number sat behind a key with a
   * few tens of bits of real entropy — guessable offline against exactly the
   * stolen ciphertext this design exists to survive. Caught by a reviewer,
   * Aug 21 2026.
   *
   * The three tests live in looksLikeRealKey() below, and none of them is a
   * promise that the key is strong. A determined person can still set a bad
   * one. The point is that the ordinary mistakes — pasting something memorable
   * instead of running the command, or base64-ing a phrase because the first
   * attempt was refused — get caught and explained instead of silently
   * accepted. */
  let typedWhy = null;
  if (key) {
    const verdict = looksLikeRealKey(raw, key, { fromHex });
    if (!verdict.ok) {
      typedWhy = verdict.why;
      key = null;
    }
  }

  const result = key
    ? { ok: true, key, fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 8) }
    : {
      ok: false,
      why: typedWhy
        ? `VAULT_KEY does not look like a randomly generated key — ${typedWhy}. A key somebody chose can be guessed offline; the whole point of this one is that it cannot. Make a real one with:  openssl rand -base64 32  and paste the whole line into Vercel. (If you DID generate it that way, generate another — this check refuses about one real key in a million.)`
        : "VAULT_KEY is not a 32-byte key. Make one with:  openssl rand -base64 32  and paste the whole line into Vercel.",
    };

  cached = { raw, result };
  return result;
}

/** Is the vault armed? Used by /api/health so the page can say what it is
 * waiting for instead of failing at the first press. */
export function isVaultConfigured() {
  return readVaultKey().ok;
}

/** The key's fingerprint, or null. Safe to show — it is a hash, not the key. */
export function vaultKeyFingerprint() {
  const k = readVaultKey();
  return k.ok ? k.fingerprint : null;
}

/* ------------------------------------------------------------------ */
/* Encrypt / decrypt                                                   */
/* ------------------------------------------------------------------ */

function aad(itemId) {
  return Buffer.from(`vault:${String(itemId || "")}`, "utf8");
}

/**
 * Scramble an object of secret fields.
 * Returns { ok, blob } or { ok:false, why }.
 */
export function encryptSecret(payload, itemId) {
  const k = readVaultKey();
  if (!k.ok) return { ok: false, why: k.why };
  if (!itemId) return { ok: false, why: "A secret can only be saved against an item that already exists." };

  const json = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(itemId));
  const body = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { ok: true, blob: [VERSION, k.fingerprint, b64(iv), b64(tag), b64(body)].join(".") };
}

/**
 * Unscramble. Returns { ok, payload } or { ok:false, why }.
 *
 * Every failure is a plain sentence a person can act on. The one thing it never
 * does is return a partly-right answer: AES-GCM either verifies or throws, and
 * a throw is reported, never swallowed.
 */
export function decryptSecret(blob, itemId) {
  const k = readVaultKey();
  if (!k.ok) return { ok: false, why: k.why };
  if (!blob) return { ok: false, why: "Nothing is saved against this item yet." };

  const parts = String(blob).split(".");
  if (parts.length !== 5) return { ok: false, why: "The saved secret is not in a shape this console understands." };
  const [version, fingerprint, ivB64, tagB64, bodyB64] = parts;
  if (version !== VERSION) return { ok: false, why: `The saved secret is in format ${version}, which this console cannot read.` };
  if (fingerprint !== k.fingerprint) {
    return {
      ok: false,
      why: "This was saved with a DIFFERENT VAULT_KEY than the one on the server now. Put the old key back, or save the secret again with the new one. Nothing is lost while the old key exists.",
    };
  }

  let iv, tag, body;
  try {
    iv = unb64(ivB64);
    tag = unb64(tagB64);
    body = unb64(bodyB64);
  } catch {
    return { ok: false, why: "The saved secret is damaged and cannot be read." };
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return { ok: false, why: "The saved secret is damaged and cannot be read." };
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", k.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(itemId));
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return { ok: true, payload: JSON.parse(out.toString("utf8")) };
  } catch {
    return {
      ok: false,
      why: "The saved secret would not unscramble. It was either changed by hand in the database, or it belongs to a different item.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Password generation, server side                                    */
/* ------------------------------------------------------------------ */

/** Real random numbers for lib/vault.js's buildPassword. randomInt is the
 * cryptographic one from node:crypto — Math.random is not used here or
 * anywhere near a password. */
export function serverRandomInts(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = randomInt(0, 2 ** 30);
  return out;
}
