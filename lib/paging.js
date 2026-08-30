/* READING MORE THAN A THOUSAND ROWS.                        Aug 30 2026
 *
 * Supabase answers a single request with at most 1,000 rows. It does not
 * error and it does not flag it: you ask for 2,000 and you get 1,000, and the
 * only way to find out is to count.
 *
 * NOBODY COUNTED. Four readers in src/lib/data.js asked for more than a
 * thousand rows and then checked `if (rows.length > CAP)` to decide whether to
 * warn that they had capped. Every one of those CAPs was 2,000 or more, so the
 * check could never be true — and four carefully worded warnings about missing
 * data were unreachable code:
 *
 *   listLeads            cap  2,000  the Sales page showed 1,000 of 3,663
 *   listCompanies        cap  2,000  the sheet importer's duplicate check
 *   listAllLeadActivity  cap  4,000  the cadence counts touches from these
 *   listLeadTagState     cap 12,000  tags, and the tag filters' counts
 *
 * `listCompanies` is the one that would have cost real work. It is how the
 * importer decides which firms it already has. With 2,761 firms on file it
 * could see 1,000 of them, so the next import would have made a second copy of
 * the other 1,761 and reported them on screen as new.
 *
 * Found 30 Aug 2026 when Ryder read the screen: "this says 999 leads, when i
 * think we have 3000+." The AI-cost reader had already solved this on 29 Aug
 * (listUsage); nothing else was given the same treatment.
 *
 * Pure — no browser, no Supabase client, nothing to mock but a query builder.
 * tests/paging drives it against a fake that enforces the real 1,000 ceiling.
 */

/** One page. This is Supabase's own ceiling, not a number we chose. */
export const PAGE = 1000;

/**
 * Read EVERY row, a page at a time.
 *
 * @param build      () => a fresh query, with its filters already on it and
 *                   NO order and NO range — this adds both, and a query object
 *                   cannot be reused across requests
 * @param order      the column to sort on
 * @param ascending  sort direction
 * @param max        a hard ceiling so a runaway read cannot hang a page. Unlike
 *                   a bare `.limit()`, reaching it is REPORTED.
 *
 * @returns { rows, truncated, error, partial }
 *   truncated  a sentence, when the ceiling was reached and more remains
 *   partial    true when the database stopped answering part way. The rows
 *              already read are still true, so they are handed back rather
 *              than thrown away — a page can show what it has and say the rest
 *              is missing, instead of showing a part total as if it were whole.
 */
export async function fetchPaged(build, { order = "created_at", ascending = false, max = 50000 } = {}) {
  const rows = [];

  for (let page = 0; page * PAGE < max; page += 1) {
    /* ORDERED ON THE COLUMN AND THEN ON id, and the second key is
     * load-bearing.
     *
     * `created_at` is not unique. An import writes two hundred rows inside one
     * statement and they share a timestamp to the microsecond. Postgres gives
     * no stable order inside a tie group across two separate range queries, so
     * with a tie straddling a page boundary, page 2 can hand back rows page 1
     * already had while others are never returned at all.
     *
     * Sorting on the timestamp alone would have replaced a visible undercount
     * with an invisible, non-repeatable one — which is worse, because the
     * visible one is the one somebody eventually notices. Same reasoning as
     * listUsage in data.js, written for the same reason a day earlier. */
    const { data, error } = await build()
      .order(order, { ascending })
      .order("id", { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1);

    if (error) {
      return { rows, error: error.message, sample: false, partial: rows.length > 0 };
    }

    const batch = data || [];
    rows.push(...batch);

    /* A short page means there is nothing behind it. This is the normal exit,
     * and it is why a table holding exactly PAGE rows costs one extra request
     * rather than being mistaken for a capped read. */
    if (batch.length < PAGE) return { rows, sample: false, truncated: null };
  }

  return {
    rows,
    sample: false,
    truncated: `Only the first ${rows.length.toLocaleString()} rows were loaded — there are more than this page is built to hold. Everything counted below comes from those.`,
  };
}
