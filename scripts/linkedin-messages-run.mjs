#!/usr/bin/env node
/* Run the LinkedIn messaging engine (Build 1) on one client's answers.
 * 3 Nov 2026.
 *
 *   set -a; . ./.env.local; set +a
 *   node scripts/linkedin-messages-run.mjs <answers.json> <out-dir>                 real model call
 *   node scripts/linkedin-messages-run.mjs <answers.json> <out-dir> --check <x.json>  no model call:
 *        parse + check JSON someone already wrote (a hand edit, or a draft
 *        made while .env.local had no ANTHROPIC_API_KEY, as on 3-3 Nov 2026)
 *   add --site <url-or-none> to override the website lookup
 *
 * Writes into <out-dir>: system.txt + user.txt (exactly what the model is
 * sent), raw.txt (what came back), result.json, review.txt (the sheet Julie
 * or CJ reviews). NOT METERED (no database from here) — prints the tokens
 * instead. Sends nothing to anyone. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { draft, isAiConfigured } from "../lib/ai.js";
import { generate, formatForReview, riskReview, parseOutput, checkOutput, expiresOn, buildSystem, buildUserMessage, PROMPT_VERSION } from "../lib/linkedin-messages.js";
import { fetchSiteText } from "../lib/linkedin-site-text.js";

const args = process.argv.slice(2);
const [file, outDir] = args;
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const checkFile = flag("--check");
const siteFlag = flag("--site");
if (!file || !outDir) { console.error("usage: node scripts/linkedin-messages-run.mjs <answers.json> <out-dir> [--check <draft.json>] [--site <url|none>]"); process.exit(2); }
if (!checkFile && !isAiConfigured()) { console.error("ANTHROPIC_API_KEY is not set. Load .env.local first, or use --check <draft.json>."); process.exit(2); }

const answers = JSON.parse(readFileSync(file, "utf8"));
mkdirSync(outDir, { recursive: true });
const siteUrl = siteFlag === "none" ? "" : (siteFlag || answers.website || "");
const siteText = siteUrl ? await fetchSiteText(siteUrl) : "";

let result;
if (checkFile) {
  const risk = riskReview(answers);
  const raw = readFileSync(checkFile, "utf8");
  const parsed = parseOutput(raw);
  result = {
    content: parsed.content, parseError: parsed.error, risk,
    issues: parsed.error ? [] : checkOutput(parsed.content, answers, risk),
    expires: parsed.content ? expiresOn(parsed.content, answers) : null,
    retried: null, promptVersion: PROMPT_VERSION,
    system: buildSystem(answers, risk), userMessage: buildUserMessage(answers, siteText), raw, calls: [], mode: "check (no model call)",
  };
} else {
  result = await generate({ answers, siteText, draftFn: (a) => draft({ ...a, brainRows: [], personalRows: [] }) });
}

writeFileSync(join(outDir, "system.txt"), result.system);
writeFileSync(join(outDir, "user.txt"), result.userMessage);
writeFileSync(join(outDir, "raw.txt"), result.raw || "");
const { system, userMessage, raw, ...rest } = result;
writeFileSync(join(outDir, "result.json"), JSON.stringify({ ...rest, siteTextChars: siteText.length }, null, 2));
const sheet = formatForReview(result, answers);
writeFileSync(join(outDir, "review.txt"), sheet);

const tokens = result.calls.reduce((t, c) => ({ in: t.in + (c.usage?.input_tokens || 0), out: t.out + (c.usage?.output_tokens || 0) }), { in: 0, out: 0 });
console.log(sheet);
console.log(`\n--- ${result.mode || "model"} · ${result.calls.length} call(s) · ${tokens.in} in / ${tokens.out} out tokens · model ${result.calls[0]?.model || "none"} · retried: ${result.retried || "no"} · site text: ${siteText.length} chars`);
console.log(`--- blocking problems: ${result.issues.filter((i) => i.level === "block").length + (result.parseError ? 1 : 0)} · warnings: ${result.issues.filter((i) => i.level === "warn").length}`);
