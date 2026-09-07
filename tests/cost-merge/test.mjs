/* mergeMeasuredCosts — where measured money out meets typed money out.
 *
 * This is the seam that decides what "profit" means on the Finance page now
 * that the platform reports its real AI spend. Every failure mode here is a
 * wrong money figure that still looks plausible, which is why it is tested
 * harder than it is long.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMeasuredCosts } from "../../lib/finance-math.js";

const M = ["2026-07", "2026-08", "2026-09"];
const run = (typed, measured) => mergeMeasuredCosts(M, typed, measured);

test("with nothing measured, the typed figures pass straight through", () => {
  const out = run({ "2026-07": 100, "2026-08": 200, "2026-09": 300 }, {});
  assert.deepEqual(out.costByMonth, { "2026-07": 100, "2026-08": 200, "2026-09": 300 });
});

test("a measured cost is added to the months nobody typed", () => {
  const out = run({ "2026-09": 1000 }, {
    ai: { byMonth: { "2026-07": 500, "2026-08": 600, "2026-09": 700 }, typedMonths: new Set() },
  });
  assert.equal(out.costByMonth["2026-07"], 500);
  assert.equal(out.costByMonth["2026-08"], 600);
  assert.equal(out.costByMonth["2026-09"], 1700, "typed and measured stack when they are different things");
});

test("THE DOUBLE-COUNT RULE: a typed month takes the typed figure and nothing else", () => {
  /* The failure this blocks doubles a cost. The total still looks like money,
   * which is exactly why nobody would catch it by eye. */
  const out = run({ "2026-09": 1000 }, {
    ai: { byMonth: { "2026-09": 700 }, typedMonths: new Set(["2026-09"]) },
  });
  assert.equal(out.costByMonth["2026-09"], 1000, "1000, not 1700");
  assert.equal(out.addedByMonth.ai["2026-09"], 0);
  assert.deepEqual(out.displacedByTyped.ai, ["2026-09"], "and the screen can say a measured figure was set aside");
});

test("two measured sources both apply, and are reported apart", () => {
  const out = run({}, {
    fees: { byMonth: { "2026-09": 130 }, typedMonths: new Set() },
    ai: { byMonth: { "2026-09": 700 }, typedMonths: new Set() },
  });
  assert.equal(out.costByMonth["2026-09"], 830);
  assert.equal(out.addedByMonth.fees["2026-09"], 130);
  assert.equal(out.addedByMonth.ai["2026-09"], 700);
});

test("one source displaced by a typed figure does not displace the other", () => {
  const out = run({ "2026-09": 900 }, {
    fees: { byMonth: { "2026-09": 130 }, typedMonths: new Set(["2026-09"]) },
    ai: { byMonth: { "2026-09": 700 }, typedMonths: new Set() },
  });
  assert.equal(out.costByMonth["2026-09"], 1600, "900 typed + 700 AI, fees displaced");
  assert.equal(out.addedByMonth.fees["2026-09"], 0);
  assert.equal(out.addedByMonth.ai["2026-09"], 700);
});

test("NULL IS NOT ZERO: an unpriceable month adds nothing and is counted as skipped", () => {
  /* pricedCost() returns null when a month's calls ran on models with no price
   * row. Treating that as 0 would quietly make the business look cheaper to
   * run than it is — the exact bug this codebase has fought all week. */
  const out = run({ "2026-09": 1000 }, {
    ai: { byMonth: { "2026-07": null, "2026-08": undefined, "2026-09": 700 }, typedMonths: new Set() },
  });
  assert.equal(out.costByMonth["2026-07"], 0);
  assert.equal(out.costByMonth["2026-08"], 0);
  assert.equal(out.costByMonth["2026-09"], 1700);
  assert.deepEqual(out.skippedNull.ai, ["2026-07", "2026-08"]);
});

test("a real zero IS added, and is not confused with null", () => {
  /* A measured 0 says "these calls were free" — that is a reading. An absent
   * month says "we do not know". They must not land in the same bucket. */
  const out = run({}, {
    ai: { byMonth: { "2026-07": 0, "2026-08": 0, "2026-09": 0 }, typedMonths: new Set() },
  });
  assert.equal(out.costByMonth["2026-09"], 0);
  assert.deepEqual(out.skippedNull.ai, [], "a measured zero is not a skip");

  const mixed = run({}, {
    ai: { byMonth: { "2026-07": 0, "2026-09": null }, typedMonths: new Set() },
  });
  assert.deepEqual(mixed.skippedNull.ai, ["2026-08", "2026-09"], "absent and null are skips; a real 0 is not");
});

test("a typed month with NO measured figure is not reported as displaced", () => {
  const out = run({ "2026-09": 1000 }, {
    ai: { byMonth: {}, typedMonths: new Set(["2026-09"]) },
  });
  assert.deepEqual(out.displacedByTyped.ai, [], "nothing was set aside, so nothing to mention");
});

test("typedMonths works as an array as well as a Set", () => {
  const out = run({ "2026-09": 1000 }, {
    ai: { byMonth: { "2026-09": 700 }, typedMonths: ["2026-09"] },
  });
  assert.equal(out.costByMonth["2026-09"], 1000);
});

test("every figure out is a whole integer", () => {
  /* This codebase holds money as whole cents and has already shipped a bug
   * putting fractions of a cent into a whole-cent accumulator. */
  const out = run({ "2026-09": 10.4 }, {
    ai: { byMonth: { "2026-09": 700.6 }, typedMonths: new Set() },
  });
  assert.equal(Number.isInteger(out.costByMonth["2026-09"]), true);
  assert.equal(out.costByMonth["2026-09"], 10 + 701);
});

test("a month with no data at all is 0, not undefined or NaN", () => {
  const out = run({}, { ai: { byMonth: {}, typedMonths: new Set() } });
  for (const m of M) assert.equal(out.costByMonth[m], 0);
});

test("hostile input cannot produce NaN in a money total", () => {
  const out = run({ "2026-09": "abc" }, {
    ai: { byMonth: { "2026-09": "nonsense" }, typedMonths: null },
    fees: null,
  });
  for (const m of M) assert.equal(Number.isFinite(out.costByMonth[m]), true, m);
  assert.equal(out.costByMonth["2026-09"], 0);
});

test("months not in the list are ignored entirely", () => {
  const out = run({ "2020-01": 999999 }, {
    ai: { byMonth: { "2020-01": 999999 }, typedMonths: new Set() },
  });
  assert.equal(out.costByMonth["2020-01"], undefined);
  assert.equal(Object.keys(out.costByMonth).length, 3);
});
