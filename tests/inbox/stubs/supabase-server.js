/* Fake Supabase for the inbox tests. Records every write so a test can assert
 * "the thread was marked waiting" without a database. */
export const DB = { rows: [], updates: [], inserts: [], failSelect: null };

function result(rows) { return { data: rows, error: null }; }

function builder(table) {
  const state = { table, filters: {}, inList: null };
  const api = {
    select() { return api; },
    order() { return api; },
    limit() { return finish(); },
    eq(col, val) { state.filters[col] = val; return api; },
    in(col, vals) { state.inList = [col, vals]; return api; },
    or(expr) { state.or = expr; return api; },
    is() { return api; },
    maybeSingle() { const r = finish(); return { data: r.data[0] || null, error: r.error }; },
    update(patch) { DB.updates.push({ table, patch, filters: { ...state.filters } }); return api; },
    insert(row) { DB.inserts.push({ table, row }); return api; },
    delete() { state.deleting = true; return api; },
    then(res) { return Promise.resolve(finish()).then(res); },
  };
  function finish() {
    if (DB.failSelect === table) return { data: null, error: { message: "boom" } };
    let rows = DB.rows.filter((r) => r.__table === table);
    for (const [col, val] of Object.entries(state.filters)) rows = rows.filter((r) => r[col] === val);
    if (state.or) {
      // mirrors the real "user_id.eq.<me>,shared.is.true"
      const uid = state.or.split(",")[0].split(".eq.")[1];
      rows = DB.rows.filter((r) => r.__table === table && (r.user_id === uid || r.shared === true));
    }
    return result(rows);
  }
  return api;
}

export function getAdminSupabase() { return { from: (t) => builder(t) }; }
export function isServerConfigured() { return true; }
export async function readJson(req) { return req.body || {}; }
export async function requireMember(req) { return req.__member || null; }
