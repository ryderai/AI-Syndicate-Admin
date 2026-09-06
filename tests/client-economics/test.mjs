/* CLIENT ECONOMICS — what a client pays, what they cost, what is left.
 *
 * The temptation with a money file is to test that the arithmetic adds up and
 * stop. The arithmetic is the easy half. What is tested hardest here is the
 * refusals — the cases where this file must NOT produce a number, because a
 * confident wrong margin is worse than a blank cell that says why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientEconomics, centsToMicros, MARGIN_WHY, REVENUE_STATUSES, BASE_CURRENCY } from "../../lib/client-economics.js";

/* A window wide enough that nothing in these fixtures falls outside it. Every
 * test passes one, because without a window the file refuses to state a
 * margin at all — which is itself tested, at the bottom. */
const WINDOW = { fromMs: Date.parse("2020-01-01T00:00:00Z"), toMs: Date.parse("2030-01-01T00:00:00Z") };
const TS = "2026-09-01T12:00:00Z";
const DAY = "2026-09-01";

const CLIENT_A = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Shiner Law Group" };
const CLIENT_B = { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "Dahler Group" };
const WS_A = "cccccccc-0000-0000-0000-000000000003";
const WS_UNMAPPED = "dddddddd-0000-0000-0000-000000000004";

const rowFor = (out, client) => out.rows.find((r) => r.clientId === client.id);

/* ------------------------------------------------------------ the base unit */

test("cents become micro-dollars as whole integers", () => {
  assert.equal(centsToMicros(1), 10_000);
  assert.equal(centsToMicros(250_000), 2_500_000_000); // $2,500
  assert.equal(centsToMicros(0), 0);
  assert.equal(centsToMicros(null), 0);
  assert.equal(centsToMicros("nonsense"), 0);
});

test("a fraction of a cent cannot leak into the total", () => {
  /* The console has already shipped a bug putting fractions of a cent into a
   * whole-cent accumulator.
   *
   * The first version asserted `Number.isInteger(centsToMicros(1.4))`, which
   * is integer-times-integer and therefore true for every possible input — it
   * could not fail. It checks the VALUE now, and that many fractional cents
   * cannot drift. */
  assert.equal(centsToMicros(1.4), 10_000, "1.4c rounds to 1c");
  assert.equal(centsToMicros(1.6), 20_000);
  assert.equal(centsToMicros(-2), -20_000, "a credit note keeps its sign");
  let total = 0;
  for (let i = 0; i < 1000; i += 1) total += centsToMicros(0.5);
  assert.equal(total, 1000 * 10_000, "a thousand half-cents do not drift");
});

/* ------------------------------------------------------------- attribution */

test("console spend and platform spend land on the same client, and stay tellable apart", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    workspaces: [{ workspace_id: WS_A, client_id: CLIENT_A.id }],
    usage: [
      { ts: TS, client_id: CLIENT_A.id, cost_micros: 5_000 },                 // direct
      { ts: TS, workspace_id: WS_A, cost_micros: 7_000 },                     // mapped
      { ts: TS, workspace_id: WS_A, cost_micros: 3_000 },                     // mapped
    ],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: DAY }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.aiCostMicros, 15_000);
  assert.equal(r.aiCostDirectMicros, 5_000);
  assert.equal(r.aiCostMappedMicros, 10_000);
  assert.equal(r.calls, 3);
});

test("spend in a workspace NOBODY has mapped is never quietly given to a client", () => {
  /* The failure this blocks: an unmapped workspace resolving to undefined,
   * then to a default, and a client silently wearing somebody else's bill. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A, CLIENT_B],
    workspaces: [{ workspace_id: WS_A, client_id: CLIENT_A.id }],
    usage: [
      { ts: TS, workspace_id: WS_A, cost_micros: 1_000 },
      { ts: TS, workspace_id: WS_UNMAPPED, cost_micros: 900_000 },
    ],
  });
  assert.equal(rowFor(out, CLIENT_A).aiCostMicros, 1_000);
  assert.equal(rowFor(out, CLIENT_B).aiCostMicros, 0);
  /* And it is not lost either — it is reported as the gap it is. */
  assert.equal(out.unattributed.costMicros, 900_000);
  assert.equal(out.unattributed.calls, 1);
  assert.equal(out.unattributed.workspaces, 1);
});

test("a usage row for a client that is not in the list is not dumped on another client", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [{ ts: TS, client_id: "99999999-0000-0000-0000-000000000009", cost_micros: 500_000 }],
  });
  assert.equal(rowFor(out, CLIENT_A).aiCostMicros, 0);
  assert.equal(out.totals.costMicros, 0);
});

test("a non-billable call is not charged to anybody", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [
      { ts: TS, client_id: CLIENT_A.id, cost_micros: 5_000 },
      { ts: TS, client_id: CLIENT_A.id, cost_micros: 50_000, billable: false },
    ],
  });
  assert.equal(rowFor(out, CLIENT_A).aiCostMicros, 5_000);
  assert.equal(rowFor(out, CLIENT_A).calls, 1);
});

/* ------------------------------------------------------- unknown is not zero */

test("a call we could not price adds nothing to the money and is still counted", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [
      { ts: TS, client_id: CLIENT_A.id, cost_micros: 8_000 },
      { ts: TS, client_id: CLIENT_A.id, cost_micros: null },
      { ts: TS, client_id: CLIENT_A.id },
    ],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: DAY }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.aiCostMicros, 8_000, "nulls must not become zeros in the sum");
  assert.equal(r.calls, 3);
  assert.equal(r.unpricedCalls, 2);
});

test("too many unpriced calls REFUSES to print a margin percentage", () => {
  /* 2 of 3 calls unpriced. The margin would move more with what we could not
   * read than with what we spent, so there is no percentage — and the reason
   * is on the row, for the screen to print in place of it. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [
      { ts: TS, client_id: CLIENT_A.id, cost_micros: 1_000 },
      { ts: TS, client_id: CLIENT_A.id, cost_micros: null },
      { ts: TS, client_id: CLIENT_A.id, cost_micros: null },
    ],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: DAY }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.marginPct, null);
  assert.equal(r.marginWhy, MARGIN_WHY.TOO_UNPRICED);
  assert.equal(r.marginMicros, 1_000_000_000 - 1_000, "the money itself is still worked out");
});

test("a client with no invoice gets no margin, and says why", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [{ ts: TS, client_id: CLIENT_A.id, cost_micros: 40_000 }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.marginPct, null);
  assert.equal(r.marginMicros, null);
  assert.equal(r.marginWhy, MARGIN_WHY.NO_REVENUE);
});

test("a paying client we have spent nothing on does NOT print 100%", () => {
  /* 100% would read as a measurement. It is an absence. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 50_000, issue_date: DAY }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.marginPct, null);
  assert.equal(r.marginWhy, MARGIN_WHY.NO_COST);
  assert.equal(r.marginMicros, 500_000_000);
});

/* ------------------------------------------------------------------ revenue */

test("only money we actually asked for counts as revenue", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    invoices: [
      { client_id: CLIENT_A.id, status: "draft", total_cents: 999_999, issue_date: DAY },
      { client_id: CLIENT_A.id, status: "void", total_cents: 999_999, issue_date: DAY },
      { client_id: CLIENT_A.id, status: "sent", total_cents: 100_000, issue_date: DAY },
      { client_id: CLIENT_A.id, status: "paid", total_cents: 200_000, issue_date: DAY },
    ],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.revenueMicros, centsToMicros(300_000));
  assert.equal(r.paidMicros, centsToMicros(200_000), "paid and merely sent are different facts");
  assert.equal(r.invoicedMicros, centsToMicros(100_000));
  /* Asserting REVENUE_STATUSES equals its own literal proves nothing. What
   * matters is that every status OUTSIDE it is excluded — including one
   * nobody has invented yet. */
  for (const bogus of ["draft", "void", "pending", "refunded", "", null]) {
    const only = clientEconomics({
      window: WINDOW, clients: [CLIENT_A],
      invoices: [{ client_id: CLIENT_A.id, status: bogus, total_cents: 999_999, issue_date: DAY }],
    });
    assert.equal(rowFor(only, CLIENT_A).revenueMicros, 0, `status ${JSON.stringify(bogus)} must not be revenue`);
  }
  assert.equal(REVENUE_STATUSES.length, 2);
});

test("hand-typed expenses tagged to a client count against them too", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [{ ts: TS, client_id: CLIENT_A.id, cost_micros: 10_000 }],
    expenses: [{ client_id: CLIENT_A.id, amount_cents: 5_000, incurred_on: DAY }],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: DAY }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.handEnteredCostMicros, centsToMicros(5_000));
  assert.equal(r.totalCostMicros, 10_000 + centsToMicros(5_000));
});

/* -------------------------------------------------------------- the ordering */

test("the worst deal is at the top, and unknowns sort last", () => {
  /* The list exists to find the client costing more than they bring in. If
   * that client is not first the list has failed at its only job. */
  const LOSS = { id: "l", name: "Loss maker" };
  const GOOD = { id: "g", name: "Good deal" };
  const UNKNOWN = { id: "u", name: "No invoice yet" };
  const out = clientEconomics({
    window: WINDOW,
    clients: [GOOD, UNKNOWN, LOSS],
    usage: [
      { ts: TS, client_id: "g", cost_micros: 10_000 },
      { ts: TS, client_id: "l", cost_micros: 2_000_000_000 },
      { ts: TS, client_id: "u", cost_micros: 5_000 },
    ],
    invoices: [
      { client_id: "g", status: "paid", total_cents: 100_000, issue_date: DAY },
      { client_id: "l", status: "paid", total_cents: 100_000, issue_date: DAY },
    ],
  });
  assert.equal(out.rows[0].clientId, "l");
  assert.ok(out.rows[0].marginPct < 0, "and it really is a loss");
  assert.equal(out.rows[1].clientId, "g");
  assert.equal(out.rows[2].clientId, "u", "an unknown is not a bad number");
});

/* ---------------------------------------------------------------- the totals */

test("the totals are the rows added up, and unattributed spend is kept apart", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A, CLIENT_B],
    workspaces: [{ workspace_id: WS_A, client_id: CLIENT_B.id }],
    usage: [
      { ts: TS, client_id: CLIENT_A.id, cost_micros: 1_000 },
      { ts: TS, workspace_id: WS_A, cost_micros: 2_000 },
      { ts: TS, workspace_id: WS_UNMAPPED, cost_micros: 4_000 },
    ],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 10_000, issue_date: DAY }],
  });
  assert.equal(out.totals.costMicros, 3_000, "unattributed spend is NOT in the client total");
  assert.equal(out.totals.unattributedCostMicros, 4_000);
  assert.equal(out.totals.revenueMicros, centsToMicros(10_000));
  assert.equal(out.totals.calls, 2);
});

test("empty input produces empty output, not a crash and not a zero-filled lie", () => {
  const out = clientEconomics();
  assert.deepEqual(out.rows, []);
  assert.equal(out.totals.clients, 0);
  assert.equal(out.unattributed.calls, 0);
});

test("hostile rows cannot throw, and cannot silently invent money either", () => {
  /* A bare doesNotThrow passes over a function that returns nonsense. The
   * output is checked too. */
  let out;
  assert.doesNotThrow(() => {
    out = clientEconomics({
      window: WINDOW,
      clients: [CLIENT_A, null, {}, { id: null }],
      usage: [null, {}, { ts: TS, client_id: CLIENT_A.id, cost_micros: "abc" }, { ts: TS, cost_micros: 5 }],
      workspaces: [null, {}, { workspace_id: WS_A }],
      invoices: [null, {}, { client_id: CLIENT_A.id, status: null, issue_date: DAY }],
      expenses: [null, {}],
    });
  });
  assert.equal(out.rows.length, 1, "only the one real client makes a row");
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.aiCostMicros, 0, '"abc" is unpriced, not free');
  assert.equal(r.unpricedCalls, 1);
  assert.equal(r.revenueMicros, 0, "an invoice with no status is not revenue");
  assert.equal(out.totals.orphanCostMicros, 5, "and the row belonging to nobody is still counted");
});

test("a monthly retainer cost is NOT counted as a one-off amount", () => {
  /* "$300/month" is a rate, not $300. Counting it once makes the client look
   * cheaper to serve than they are, and nothing on screen would say so. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    expenses: [
      { client_id: CLIENT_A.id, amount_cents: 5_000, interval: "one_time", incurred_on: DAY },
      { client_id: CLIENT_A.id, amount_cents: 30_000, interval: "monthly", incurred_on: DAY },
      { client_id: CLIENT_A.id, amount_cents: 90_000, interval: "yearly", incurred_on: DAY },
    ],
  });
  assert.equal(rowFor(out, CLIENT_A).handEnteredCostMicros, centsToMicros(5_000));
  assert.equal(out.totals.recurringCostsSkipped, 2, "and it is COUNTED as skipped, not silently dropped");
});

test("an expense with no interval is treated as one-off, matching the column default", () => {
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    expenses: [{ client_id: CLIENT_A.id, amount_cents: 1_000, incurred_on: DAY }],
  });
  assert.equal(rowFor(out, CLIENT_A).handEnteredCostMicros, centsToMicros(1_000));
  assert.equal(out.totals.recurringCostsSkipped, 0);
});

/* ==========================================================================
 * THE DEFECTS A SEPARATE CHECKER FOUND IN THE FIRST VERSION OF THIS FILE.
 * Each one is pinned so it cannot come back quietly.
 * ====================================================================== */

test("a margin is refused when no period was given, instead of comparing three of them", () => {
  /* The original bug: the page read usage for 30 days, invoices for ALL TIME,
   * and expenses for 18 months, and printed the result as a margin. A client
   * invoiced $50k over two years showed ~99% against one month of spend. */
  const out = clientEconomics({
    clients: [CLIENT_A],
    usage: [{ ts: TS, client_id: CLIENT_A.id, cost_micros: 10_000 }],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: DAY }],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.marginPct, null);
  assert.equal(r.marginWhy, MARGIN_WHY.NO_WINDOW);
  assert.equal(out.totals.windowed, false);
});

test("revenue outside the window is not counted against cost inside it", () => {
  const narrow = { fromMs: Date.parse("2026-09-01T00:00:00Z"), toMs: Date.parse("2026-09-30T23:59:59Z") };
  const out = clientEconomics({
    window: narrow,
    clients: [CLIENT_A],
    usage: [
      { ts: "2026-09-10T00:00:00Z", client_id: CLIENT_A.id, cost_micros: 10_000 },
      { ts: "2026-05-10T00:00:00Z", client_id: CLIENT_A.id, cost_micros: 999_999 },
    ],
    invoices: [
      { client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: "2026-09-05" },
      { client_id: CLIENT_A.id, status: "paid", total_cents: 5_000_000, issue_date: "2024-01-05" },
    ],
    expenses: [
      { client_id: CLIENT_A.id, amount_cents: 2_000, interval: "one_time", incurred_on: "2026-09-07" },
      { client_id: CLIENT_A.id, amount_cents: 900_000, interval: "one_time", incurred_on: "2023-02-07" },
    ],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.aiCostMicros, 10_000, "the old call is outside the window");
  assert.equal(r.revenueMicros, centsToMicros(100_000), "the 2024 invoice is outside the window");
  assert.equal(r.handEnteredCostMicros, centsToMicros(2_000));
  /* The edges are the TEAM'S days. 2026-09-01T00:00Z is 31 Aug, 7pm in
   * Chicago, so that is the day the window starts on — the same calendar
   * every other date on these screens is counted in. */
  assert.equal(out.totals.periodFrom, "2026-08-31");
  assert.equal(out.totals.periodTo, "2026-09-30");
});

test("the window edge is the team's day, so tomorrow's invoice is not today's revenue", () => {
  /* Measured by a verification pass on the first version, which derived the
   * edges with toISOString(): at 8pm Chicago that has already rolled over to
   * tomorrow, so an invoice dated TOMORROW counted as revenue while an
   * hour-old API call fell outside the window. Both edges wrong, in opposite
   * directions, on the same screen. */
  const eveningInChicago = Date.parse("2026-09-07T01:00:00Z"); // 6 Sep, 8pm CDT
  const out = clientEconomics({
    window: { fromMs: eveningInChicago - 30 * 86400000, toMs: eveningInChicago },
    clients: [CLIENT_A],
    usage: [{ ts: "2026-09-07T04:00:00Z", client_id: CLIENT_A.id, cost_micros: 4_000 }], // 6 Sep 11pm Chicago
    invoices: [
      { client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, issue_date: "2026-09-07" }, // tomorrow
      { client_id: CLIENT_A.id, status: "paid", total_cents: 50_000, issue_date: "2026-09-06" },  // today
    ],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(out.totals.periodTo, "2026-09-06", "the window ends on the team's today");
  assert.equal(r.revenueMicros, centsToMicros(50_000), "tomorrow's invoice is not today's revenue");
});

test("money for a client the caller did not fetch is COUNTED, not silently dropped", () => {
  /* A verification pass fed in $50,000 of invoices for a client that was not
   * in the clients array and every single counter came back zero — a whole
   * client's spend could leave the page with nothing saying so. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    usage: [{ ts: TS, client_id: "99999999-9999-9999-9999-999999999999", cost_micros: 123_456 }],
    invoices: [{ client_id: "99999999-9999-9999-9999-999999999999", status: "paid", total_cents: 5_000_000, issue_date: DAY }],
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.totals.unknownClientCostMicros, 123_456);
  assert.equal(out.totals.unknownClientCalls, 1);
  assert.equal(out.totals.unknownClientRevenueMicros, centsToMicros(5_000_000));
  assert.equal(out.totals.unknownClientInvoices, 1);
  assert.equal(out.totals.unknownClients, 1);
});

test("a recurring cost from OUTSIDE the window is not reported as skipped inside it", () => {
  const out = clientEconomics({
    window: { fromMs: Date.parse("2026-09-01T12:00:00Z"), toMs: Date.parse("2026-09-30T12:00:00Z") },
    clients: [CLIENT_A],
    expenses: [
      { client_id: CLIENT_A.id, amount_cents: 30_000, interval: "monthly", incurred_on: "2020-01-01" },
      { client_id: CLIENT_A.id, amount_cents: 30_000, interval: "monthly", incurred_on: "2026-09-10" },
    ],
  });
  assert.equal(out.totals.recurringCostsSkipped, 1, "only the one inside the window is worth mentioning");
});

test("a foreign-currency invoice is set aside, not added to dollars", () => {
  /* There is no rate table in this codebase. Adding GBP to USD produces a
   * margin computed over mixed units — a wrong number that looks right. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A],
    invoices: [
      { client_id: CLIENT_A.id, status: "paid", total_cents: 100_000, currency: "usd", issue_date: DAY },
      { client_id: CLIENT_A.id, status: "paid", total_cents: 400_000, currency: "gbp", issue_date: DAY },
    ],
  });
  const r = rowFor(out, CLIENT_A);
  assert.equal(r.revenueMicros, centsToMicros(100_000));
  assert.equal(r.foreignInvoices, 1, "and it is COUNTED, so the screen can say the total is incomplete");
  assert.equal(out.totals.foreignCurrencyInvoices, 1);
  assert.equal(BASE_CURRENCY, "usd");
});

test("an invoice with no currency is treated as dollars, matching the column default", () => {
  const out = clientEconomics({
    window: WINDOW, clients: [CLIENT_A],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 7_000, issue_date: DAY }],
  });
  assert.equal(rowFor(out, CLIENT_A).revenueMicros, centsToMicros(7_000));
  assert.equal(out.totals.foreignCurrencyInvoices, 0);
});

test("an invoice totalling zero is zero, not its subtotal", () => {
  /* The old `total_cents ?? subtotal_cents` could never fire (total_cents is
   * NOT NULL) and `0 ?? x` is 0 anyway — so the fallback was dead code that
   * read as a safety net. */
  const out = clientEconomics({
    window: WINDOW, clients: [CLIENT_A],
    invoices: [{ client_id: CLIENT_A.id, status: "paid", total_cents: 0, subtotal_cents: 500_000, issue_date: DAY }],
  });
  assert.equal(rowFor(out, CLIENT_A).revenueMicros, 0);
});

test("a usage row with neither a client nor a workspace is counted SOMEWHERE, not dropped", () => {
  /* The checker's find: `{ cost_micros: 5 }` appeared in no client row and in
   * no unattributed total either. Money that is in none of the totals is
   * money nobody can find. */
  const out = clientEconomics({
    window: WINDOW, clients: [CLIENT_A],
    usage: [{ ts: TS, cost_micros: 5_000 }],
  });
  assert.equal(out.totals.orphanCostMicros, 5_000);
  assert.equal(out.totals.orphanCalls, 1);
});

test("when a row carries BOTH a client id and a mapped workspace, the client wins AND the clash is counted", () => {
  /* Somebody has to win. What must not happen is one attribution being
   * silently discarded with nothing anywhere saying two disagreed. */
  const out = clientEconomics({
    window: WINDOW,
    clients: [CLIENT_A, CLIENT_B],
    workspaces: [{ workspace_id: WS_A, client_id: CLIENT_B.id }],
    usage: [{ ts: TS, client_id: CLIENT_A.id, workspace_id: WS_A, cost_micros: 6_000 }],
  });
  assert.equal(rowFor(out, CLIENT_A).aiCostMicros, 6_000, "the row's own client id wins");
  assert.equal(rowFor(out, CLIENT_B).aiCostMicros, 0);
  assert.equal(out.totals.attributionClashes, 1, "and the disagreement is reported");
});
