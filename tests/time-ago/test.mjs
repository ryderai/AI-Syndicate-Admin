/* "3d ago" — and, since 30 Aug 2026, "in 3d".
 *
 * Two bugs, both on screen, both found on the first client ever created in this
 * console. A client whose start date was TOMORROW showed "1h ago" in the
 * "With us" column — because the elapsed seconds went negative and the very
 * first branch was `if (s < 60) return "just now"`, which every negative number
 * passes. And an unparseable value printed the words "Invalid Date".
 *
 * `now` is injected so none of this is a race against the real clock.
 */
import { readFileSync } from "node:fs";
import { timeAgo } from "../../src/lib/timeAgo.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};
const NOW = Date.parse("2026-08-30T20:53:00-05:00"); // the moment the bug was seen
const eq = (name, input, want, now = NOW) => {
  const got = timeAgo(input, now);
  ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};
const ago = (ms) => NOW - ms;
const ahead = (ms) => NOW + ms;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

console.log("\nTHE PAST, WHICH ALWAYS WORKED");

eq("a few seconds", ago(3000), "just now");
eq("59 seconds", ago(59000), "just now");
eq("a minute", ago(MIN), "1m ago");
eq("forty minutes", ago(40 * MIN), "40m ago");
eq("an hour", ago(HOUR), "1h ago");
eq("five hours", ago(5 * HOUR), "5h ago");
eq("a day", ago(DAY), "1d ago");
eq("twenty-nine days", ago(29 * DAY), "29d ago");
ok("past thirty days it gives the date instead of a big number",
  /^[A-Z][a-z]{2} \d/.test(timeAgo(ago(60 * DAY), NOW)), timeAgo(ago(60 * DAY), NOW));

console.log("\nTHE FUTURE, WHICH READ AS THE PAST");

/* THE EXACT BUG. The client created at 8:53pm Chicago on 30 Aug with a start
 * date of 2026-08-31 sat 1h44m in the future and the column said "1h ago". */
eq("a start date an hour and three quarters away is NOT in the past",
  ahead(HOUR + 44 * MIN), "in 1h");
eq("tomorrow", ahead(DAY), "in 1d");
eq("a client starting in three weeks", ahead(21 * DAY), "in 21d");
eq("thirty seconds away is still just now — nobody wants 'in 30s'", ahead(30000), "just now");
eq("two minutes away", ahead(2 * MIN), "in 2m");
ok("further than a month ahead gives the date, not 'just now'",
  /^[A-Z][a-z]{2} \d/.test(timeAgo(ahead(60 * DAY), NOW)), timeAgo(ahead(60 * DAY), NOW));

/* The regression in one line: nothing in the future may ever contain "ago". */
for (const ms of [1000, MIN, HOUR, DAY, 10 * DAY, 400 * DAY]) {
  ok(`+${ms}ms never says "ago"`, !timeAgo(ahead(ms), NOW).includes("ago"), timeAgo(ahead(ms), NOW));
}

console.log("\nNOTHING UNREADABLE EVER REACHES A SCREEN");

eq("null", null, "—");
eq("undefined", undefined, "—");
eq("empty string", "", "—");
eq("nonsense never renders as Invalid Date", "not a date at all", "—");
eq("NaN", NaN, "—");
eq("an ISO string is parsed", "2026-08-29T20:53:00-05:00", "1d ago");
eq("a raw epoch number is taken as-is", ago(2 * HOUR), "2h ago");
eq("epoch zero is a real time, not a missing one", 0, timeAgo(0, NOW));
ok("epoch zero gives a date, not a dash", timeAgo(0, NOW) !== "—", timeAgo(0, NOW));

console.log("\nTHE COLUMN THAT SHOWED THE BUG NOW ASKS THE TEAM CLOCK");

const CLIENTS = readFileSync(new URL("../../src/components/admin/Clients.jsx", import.meta.url), "utf8");
ok("Clients.jsx no longer parses start_date as UTC midnight",
  !CLIENTS.includes('Date.parse(`${c.start_date}T00:00:00Z`)'));
ok("...it uses teamDayStartOf", CLIENTS.includes("teamDayStartOf(c.start_date)"));

const SHARED = readFileSync(new URL("../../src/components/admin/shared.jsx", import.meta.url), "utf8");
ok("shared.jsx re-exports timeAgo rather than keeping a second copy",
  SHARED.includes('export { timeAgo } from "../../lib/timeAgo.js"')
  && !SHARED.includes("export function timeAgo"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
