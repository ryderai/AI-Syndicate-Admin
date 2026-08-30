/* READING MORE THAN A THOUSAND ROWS.                       Aug 30 2026
 *
 * Supabase answers a single request with at most 1,000 rows. It does not error
 * and it does not flag it — you ask for 2,000 and you get 1,000 back, and the
 * only way to notice is to count.
 *
 * Nobody counted. Four readers in src/lib/data.js asked for more than a
 * thousand and then checked `if (rows.length > CAP)` to decide whether to warn
 * that they had capped. Every one of those CAPs was 2,000 or more, so the
 * check could never be true, and four carefully worded warnings were
 * unreachable code:
 *
 *   listLeads            cap  2,000 — the Sales page showed 1,000 of 3,663
 *   listCompanies        cap  2,000 — the importer's duplicate check, see below
 *   listAllLeadActivity  cap  4,000 — the cadence counts touches from these
 *   listLeadTagState     cap 12,000 — tags and the tag filters
 *
 * listCompanies is the one that would have cost real money: it is what the
 * sheet importer uses to decide which firms it already has. With 2,761 firms
 * on file it could see 1,000, so the next import would have made a second copy
 * of the other 1,761 and called them new.
 *
 * The fake Supabase below enforces the real server's 1,000-row ceiling. A
 * reader that stops asking after one page fails these.
 */
import assert from "node:assert/strict";
import { fetchPaged, PAGE } from "../../lib/paging.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok   ${name}`); })
    .catch((e) => { failed += 1; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").slice(0, 4).join("\n       ")}`); });
}

/** A stand-in for Supabase that behaves like the real one: it honours
 *  `.range()`, it never returns more than PAGE rows however wide the range,
 *  and it applies the ordering it was given. */
function fakeTable(rows, { failOnPage = null } = {}) {
  let calls = 0;
  const api = {
    calls: () => calls,
    _orders: [],
    order(col, { ascending }) { this._orders.push([col, ascending]); return this; },
    range(from, to) {
      calls += 1;
      if (failOnPage !== null && calls - 1 === failOnPage) {
        return Promise.resolve({ data: null, error: { message: "connection lost" } });
      }
      const sorted = [...rows].sort((a, b) => {
        for (const [col, asc] of api._orders) {
          const x = String(a[col]);
          const y = String(b[col]);
          if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      const width = Math.min(to - from + 1, PAGE);      // the real server's ceiling
      return Promise.resolve({ data: sorted.slice(from, from + width), error: null });
    },
  };
  return () => { api._orders = []; return api; };
}

const make = (n, sameTimestamp = false) => Array.from({ length: n }, (_, i) => ({
  id: String(i).padStart(6, "0"),
  created_at: sameTimestamp ? "2026-08-30T12:00:00.000Z" : new Date(1e12 + i * 1000).toISOString(),
}));

console.log("\nREADING MORE THAN A THOUSAND ROWS\n");

await test("3,663 rows come back as 3,663, not 1,000", async () => {
  const build = fakeTable(make(3663));
  const res = await fetchPaged(build, { order: "created_at", ascending: false, max: 50000 });
  assert.equal(res.rows.length, 3663, "this is the actual number in Ryder's pipeline");
  assert.equal(res.truncated, null, "it read everything, so there is nothing to warn about");
});

await test("exactly 1,000 rows does not look like a full page and stop early", async () => {
  /* The boundary case. A table holding exactly one page must not make the
   * reader believe there is a second one, and must not report a cap. */
  const build = fakeTable(make(1000));
  const res = await fetchPaged(build, { max: 50000 });
  assert.equal(res.rows.length, 1000);
  assert.equal(res.truncated, null);
});

await test("2,000 rows — the size the old cap claimed to allow", async () => {
  const build = fakeTable(make(2000));
  const res = await fetchPaged(build, { max: 50000 });
  assert.equal(res.rows.length, 2000);
});

await test("no row is read twice and none is skipped", async () => {
  const res = await fetchPaged(fakeTable(make(2500)), { max: 50000 });
  const ids = res.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "a repeated row means the pages overlap");
  assert.equal(ids.length, 2500, "a missing row means the pages have a hole");
});

await test("rows sharing one timestamp still page correctly", async () => {
  /* THE REASON THE SORT HAS TWO KEYS. An import writes two hundred rows inside
   * one statement and they share created_at to the microsecond. Postgres gives
   * no stable order inside a tie across two separate range queries, so without
   * the id tiebreak page 2 can hand back rows page 1 already had while others
   * are never returned at all — a silent, non-repeatable undercount, which is
   * worse than the visible one it replaced. */
  const res = await fetchPaged(fakeTable(make(3000, true)), { max: 50000 });
  const ids = res.rows.map((r) => r.id);
  assert.equal(ids.length, 3000);
  assert.equal(new Set(ids).size, 3000, "3,000 rows with identical timestamps must still come back once each");
});

await test("it orders on the given column AND on id, in that order", async () => {
  /* Asserted, not assumed. The first version of this test called fetchPaged
   * and then `assert.ok(true)` — it would have passed with the ordering
   * removed entirely, which is the one thing it exists to protect. */
  const seen = [];
  const spy = () => ({
    order(col, { ascending }) { seen.push([col, ascending]); return this; },
    range() { return Promise.resolve({ data: [], error: null }); },
  });
  await fetchPaged(spy, { order: "at", ascending: true, max: 50000 });
  assert.deepEqual(seen, [["at", true], ["id", true]],
    "the requested column first, then id as the tiebreak that makes paging stable");

  seen.length = 0;
  await fetchPaged(spy, { order: "created_at", ascending: false, max: 50000 });
  assert.deepEqual(seen, [["created_at", false], ["id", true]],
    "the tiebreak is always ascending, whichever way the main sort runs");
});

await test("the ceiling is REPORTED, never silently applied", async () => {
  /* The whole point. A bare .limit() stops and says nothing; this stops and
   * hands back a sentence a page can print. */
  const res = await fetchPaged(fakeTable(make(5000)), { max: 3000 });
  assert.equal(res.rows.length, 3000);
  assert.ok(res.truncated, "hitting the ceiling has to produce a warning");
  assert.match(res.truncated, /3,000/, "and the warning has to say how many it got");
});

await test("a database that stops answering keeps the rows already read", async () => {
  const res = await fetchPaged(fakeTable(make(3000), { failOnPage: 2 }), { max: 50000 });
  assert.equal(res.rows.length, 2000, "two full pages landed before it failed");
  assert.equal(res.partial, true, "and the caller is told the rest is missing");
  assert.match(res.error, /connection lost/);
});

await test("a failure on the FIRST page is an error, not a partial", async () => {
  const res = await fetchPaged(fakeTable(make(3000), { failOnPage: 0 }), { max: 50000 });
  assert.equal(res.rows.length, 0);
  assert.equal(res.partial, false, "nothing was read, so there is no part to keep");
});

await test("an empty table is not a cap", async () => {
  const res = await fetchPaged(fakeTable([]), { max: 50000 });
  assert.deepEqual(res.rows, []);
  assert.equal(res.truncated, null);
});

await test("it asks for as few pages as it can", async () => {
  const build = fakeTable(make(1500));
  await fetchPaged(build, { max: 50000 });
  assert.equal(build().calls(), 2, "1,500 rows is two pages, not three");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
