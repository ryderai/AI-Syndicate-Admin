/* The console's LinkedIn page helpers (lib/linkedin-questions.js). 30 Oct 2026.
 * Run: node tests/linkedin/test.mjs */
import { answerSections, readinessFlags, weekOf, weeklyTotals, rates } from "../../lib/linkedin-questions.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const s = answerSections({ contact_name: "Dana", headcount: ["1-10 employees", "11-50 employees"], brand_new_q: "kept" }, [{ field: "files_resources", name: "a.pdf", path: "x/a.pdf" }]);
ok("form order", s.map((x) => x.id).join(",") === "contact,linkedin,business,other");
ok("checkbox answers joined", s[2].rows.find((r) => r.key === "headcount").value === "1-10 employees, 11-50 employees");
ok("files land in their own row", s[2].rows.find((r) => r.key === "files_resources").files.length === 1);
ok("an unknown answer is shown, not dropped", s[3].rows[0].value === "kept");
ok("flags only non-Yes", JSON.stringify(readinessFlags({ sales_nav: "Yes", two_factor_on: "No", id_verified: "Not sure" })) === JSON.stringify(["2FA on: No", "ID verified: Not sure"]));
ok("week starts Monday (Sun 1 Nov 2026 -> Mon 26 Oct)", weekOf("2026-11-01") === "2026-10-26");
ok("Monday is its own week", weekOf("2026-10-26") === "2026-10-26");
ok("bad date -> blank", weekOf("10/26/2026") === "");
const w = weeklyTotals([
  { day: "2026-10-26", connections_sent: 20, accepted: 5, replies: 2, inmails: 0, leads: 1 },
  { day: "2026-10-27", connections_sent: 20, accepted: 3, replies: 1, inmails: 1, leads: 0 },
  { day: "2026-11-02", connections_sent: 10, accepted: 0, replies: 0, inmails: 0, leads: 0 },
]);
ok("two weeks, newest first", w.length === 2 && w[0].week === "2026-11-02");
ok("totals add up", w[1].connections_sent === 40 && w[1].accepted === 8 && w[1].replies === 3 && w[1].days === 2);
ok("rates are whole percents", JSON.stringify(rates(w[1])) === JSON.stringify({ acceptRate: 20, replyRate: 38 }));
ok("no denominator = not measured", rates(w[0]).replyRate === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
