/* Does lib/sales-rules.js count days the same way src/lib/teamDay.js does?
 *
 * WHY TWO IMPLEMENTATIONS EXIST AT ALL
 * `teamDay.js` is the console's date authority (memory: team-time-dates). It
 * imports TEAM_TZ from lib/brain-context.js — which imports isOpenStage from
 * lib/sales-rules.js. So sales-rules cannot import teamDay: that is a cycle.
 * And sales-rules HAS to stay import-free, because api/sales-sweep.js runs it
 * on the server and the tests run it with no bundler at all.
 *
 * So there are two copies of "what day is it in Chicago", on purpose — the same
 * deal as dedupeKey() vs the SQL function it mirrors. Two copies are only
 * acceptable if something proves they still agree. This is that something.
 *
 * Run inside tests/sales/run.sh, in five timezones.
 */

import assert from "node:assert/strict";
import { localDayNumber, daysBetween } from "../../lib/sales-rules.js";
import { teamDayStartOf, teamDayEndOf } from "../../src/lib/teamDay.js";
import { teamDate } from "../../lib/brain-context.js";

let checked = 0;
const mismatches = [];

/* Every day of 2026 at seven hours each — deliberately including 04:00-06:00
 * UTC, which is the late-evening Central window where a fixed -5 or -6 offset
 * gets the day wrong, and both DST switch days. */
for (let d = 0; d < 365; d += 1) {
  for (const h of [0, 4, 5, 6, 12, 22, 23]) {
    const ms = Date.UTC(2026, 0, 1, h) + d * 86400000;
    const ymd = teamDate(new Date(ms).toISOString());
    const mine = localDayNumber(ms);
    const start = teamDayStartOf(ymd);
    const end = teamDayEndOf(ymd);
    checked += 1;
    if (localDayNumber(start) !== mine || localDayNumber(end) !== mine) {
      mismatches.push(`${new Date(ms).toISOString()} → teamDay says ${ymd}, sales-rules says day ${mine}`);
    }
  }
}

assert.equal(mismatches.length, 0,
  `sales-rules.js and teamDay.js disagree about the day at ${mismatches.length} of ${checked} instants:\n  ` +
  mismatches.slice(0, 5).join("\n  "));

/* And the thing that actually broke in the wild: an evening touch must not buy
 * a lead an extra day, in either half of the year. */
assert.equal(daysBetween("2026-01-15T18:00:00Z", "2026-01-16T05:30:00Z"), 0, "winter evening");
assert.equal(daysBetween("2026-07-15T18:00:00Z", "2026-07-16T04:30:00Z"), 0, "summer evening");

console.log(`  ok   sales-rules and teamDay agree on all ${checked} instants (TZ=${process.env.TZ || "system"})`);
