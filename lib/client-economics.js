/* WHAT A CLIENT PAYS US, WHAT THEY COST US, AND WHETHER THAT IS A GOOD DEAL.
 *
 * ============================== WHY THIS EXISTS =============================
 *
 * Every ingredient for this has been in the database since 0024 and none of
 * them had ever been put on the same row.
 *
 *   admin_invoices.client_id      what they pay us
 *   admin_expenses.client_id      what we spend on them by hand
 *   admin_usage_events.client_id  what our own console spends on them
 *   admin_platform_workspaces     (0032) what the PLATFORM spends on them
 *
 * The Finance page already renders revenue-by-client and cost-by-client as
 * two separate charts, on the same screen, and never subtracts one from the
 * other. So the agency can say what it earns and what it spends and cannot
 * say which clients are worth having. That is the question, and this file is
 * the answer to it.
 *
 * ============================ THE RULES IT KEEPS ============================
 *
 * 1. MONEY IS WHOLE INTEGERS. Micro-dollars for AI (that is what cost_micros
 *    is), cents for invoices and expenses. They are converted at exactly one
 *    place, `centsToMicros`, and never with floating point in between. The
 *    console has already shipped a bug where fractions of a cent went into a
 *    whole-cent accumulator.
 *
 * 2. "WE DO NOT KNOW" IS NOT ZERO, AND IT IS NEVER HIDDEN. A call we could
 *    not price has cost_micros NULL. It is excluded from the money total —
 *    a null is not a number — and COUNTED in `unpricedCalls`, which the
 *    screen prints next to the total. A margin worked out over a pile of
 *    unpriced calls is a guess wearing a percentage sign, so `marginPct` goes
 *    NULL, with `marginWhy` saying which of the four reasons it is.
 *
 * 3. IT NEVER INVENTS AN ATTRIBUTION. Spend reaches a client one of two ways:
 *    `direct`, the row already carried the client id, or `mapped`, it came
 *    from a platform workspace a person linked to that client. Both are
 *    counted separately and reported separately, because the first question
 *    anybody asks a number like this is where it came from. Spend in a
 *    workspace nobody has mapped is not quietly dropped and not quietly
 *    spread around — it is returned on its own as `unattributed`, so it is
 *    visible as the gap it is.
 *
 * 4. IT ONLY COUNTS MONEY THAT LEFT THE BUILDING. A draft invoice is not
 *    revenue and a void one never was. Only 'sent' and 'paid' count, and
 *    which of the two is reported separately, because "they owe us" and "they
 *    paid us" are different facts about a client.
 *
 * 5. ALL THREE SIDES COVER THE SAME DAYS, OR THERE IS NO MARGIN.
 *
 *    The first version of this file took whatever rows the caller handed it.
 *    The caller — the AI Cost page — reads usage for the chosen window
 *    (30/90/365 days), invoices with NO date filter at all, and expenses for
 *    the last 18 months. So "left over" was all-time revenue minus 30 days of
 *    cost, and a client invoiced $50k over two years printed a ~99% margin
 *    against one month of spend. The tell was that changing the window tab
 *    moved the margin while revenue stayed put.
 *
 *    An adversarial review caught it. A margin is a statement about a period;
 *    a `window` is now required to produce one, every side is filtered to it
 *    here rather than trusted from the caller, and `periodFrom`/`periodTo`
 *    come back out so the screen can print the days it is talking about.
 *    Without a window the money still adds up and `marginPct` is null.
 */

import { MICROS_PER_CENT } from "./ai-cost.js";
import { teamDate } from "./brain-context.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const int = (v) => (isNum(Number(v)) ? Math.round(Number(v)) : 0);

/** Cents -> micro-dollars, as whole integers. One cent is 10,000
 * micro-dollars. The only place the two bases meet. */
export function centsToMicros(cents) {
  return int(cents) * MICROS_PER_CENT;
}

/** Invoice statuses that represent money we have actually asked for.
 * 'draft' is a thought and 'void' is a retraction; neither is revenue. */
export const REVENUE_STATUSES = ["sent", "paid"];

/* The only currency this file will add up. admin_invoices.currency defaults to
 * 'usd' (0007_finance.sql:117). Anything else is counted and set aside. */
export const BASE_CURRENCY = "usd";

/** Why a margin could not be worked out. The screen prints these words, so a
 * blank cell always explains itself instead of looking like a zero. */
export const MARGIN_WHY = {
  NO_WINDOW: "no period chosen",
  NO_REVENUE: "no invoice sent yet",
  NO_COST: "nothing spent on them yet",
  TOO_UNPRICED: "too many calls we could not price",
  OK: null,
};

/* A margin worked out while this share of the client's calls have no price on
 * them is not worth printing. A fifth is the line; above it the number moves
 * more with what we could not read than with what we spent. */
const UNPRICED_LIMIT = 0.2;

/**
 * @param {object} input
 * @param {Array}  input.clients    admin_clients rows: { id, name }
 * @param {Array}  input.usage      admin_usage_events rows (must include
 *                                  workspace_id + platform_feature, 0032)
 * @param {Array}  input.workspaces admin_platform_workspaces rows
 * @param {Array}  input.invoices   admin_invoices rows
 * @param {Array}  input.expenses   admin_expenses rows (optional)
 * @returns {{ rows: Array, unattributed: object, totals: object }}
 */
export function clientEconomics({
  clients = [], usage = [], workspaces = [], invoices = [], expenses = [], window: win = null,
} = {}) {
  /* The window every side is cut to. `null` means the caller did not give
   * one, in which case no margin is claimed. */
  const fromMs = Number.isFinite(win?.fromMs) ? win.fromMs : null;
  const toMs = Number.isFinite(win?.toMs) ? win.toMs : (fromMs === null ? null : Date.now());
  const windowed = fromMs !== null;
  /* THE WINDOW EDGES ARE THE TEAM'S DAYS, NOT UTC DAYS.
   *
   * issue_date and incurred_on are date-only columns and are compared as
   * strings — a date-only value parsed with new Date() is midnight UTC, which
   * is the previous evening in Chicago, and this codebase has shipped that bug
   * twice. But deriving the two edge strings with toISOString() is the SAME
   * bug wearing the other hat: at 8pm Chicago, toISOString() has already
   * rolled over to tomorrow, so tomorrow's invoice counted as revenue while
   * an hour-old API call did not. A verification pass measured exactly that.
   *
   * teamDate() renders the day in the team's calendar, which is the calendar
   * every other date on these screens is already counted in. */
  const fromDay = windowed ? teamDate(fromMs) : null;
  const toDay = windowed ? teamDate(toMs) : null;
  const inWindowByDay = (day) => {
    if (!windowed) return true;
    const d = String(day || "").slice(0, 10);
    if (!d) return false;
    return d >= fromDay && d <= toDay;
  };
  const inWindowByTs = (ts) => {
    if (!windowed) return true;
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t >= fromMs && t <= toMs : false;
  };
  /* workspace -> client, built once. Only MAPPED workspaces go in; an
   * unmapped one must not resolve to undefined and then to some default. */
  const ownerOf = new Map();
  for (const w of workspaces) {
    if (w?.workspace_id && w?.client_id) ownerOf.set(w.workspace_id, w.client_id);
  }

  const blank = (client) => ({
    clientId: client.id,
    name: client.name || "(unnamed)",
    aiCostMicros: 0,
    aiCostDirectMicros: 0,
    aiCostMappedMicros: 0,
    calls: 0,
    unpricedCalls: 0,
    handEnteredCostMicros: 0,
    revenueMicros: 0,
    invoicedMicros: 0,
    paidMicros: 0,
    marginMicros: null,
    marginPct: null,
    foreignInvoices: 0,
    marginWhy: MARGIN_WHY.NO_REVENUE,
  });

  const byClient = new Map();
  for (const c of clients) if (c?.id) byClient.set(c.id, blank(c));

  /* Spend in a workspace nobody has claimed. Returned on its own rather than
   * folded into any client's number. */
  const unattributed = { costMicros: 0, calls: 0, unpricedCalls: 0, workspaces: new Set() };

  /* Spend with no client AND no workspace — nothing to attach it to at all.
   * Kept separately from `unattributed`, which is spend we CAN attach as soon
   * as somebody maps its workspace. Money that appears in none of the totals
   * is money nobody can find, and the first version of this file dropped
   * these rows on the floor. */
  const orphan = { costMicros: 0, calls: 0 };

  /* A row carrying a client id AND a workspace mapped to a DIFFERENT client.
   * The row's own client id wins — it is the more specific statement — but a
   * disagreement that nothing reports is how a wrong mapping survives. */
  let attributionClashes = 0;

  /* Rows naming a client the caller did not hand us. */
  const unknownClient = { costMicros: 0, calls: 0, revenueMicros: 0, invoices: 0, clients: new Set() };

  for (const e of usage) {
    if (!inWindowByTs(e?.ts)) continue;
    /* A call marked non-billable cost us nothing to serve — a provider
     * credit, a replayed test. Counting it against a client would overstate
     * what they cost. */
    if (e?.billable === false) continue;

    const direct = e?.client_id || null;
    const mapped = !direct && e?.workspace_id ? ownerOf.get(e.workspace_id) || null : null;
    /* PRECEDENCE, STATED: a client id ON THE ROW beats the workspace mapping.
     * The row's own id was written by the code that made the call and knows
     * exactly whose work it was; the mapping is a human's later guess about a
     * whole workspace. */
    if (direct && e?.workspace_id) {
      const viaWorkspace = ownerOf.get(e.workspace_id);
      if (viaWorkspace && viaWorkspace !== direct) attributionClashes += 1;
    }
    const clientId = direct || mapped;

    if (!clientId) {
      if (e?.workspace_id) {
        unattributed.calls += 1;
        unattributed.workspaces.add(e.workspace_id);
        if (isNum(e?.cost_micros)) unattributed.costMicros += int(e.cost_micros);
        else unattributed.unpricedCalls += 1;
      } else {
        orphan.calls += 1;
        if (isNum(e?.cost_micros)) orphan.costMicros += int(e.cost_micros);
      }
      continue;
    }

    const row = byClient.get(clientId);
    /* A row naming a client that is not in the list — deleted since, or a
     * filtered list. It must not land on somebody else's total, and it must
     * not vanish either: a verification pass fed in $50,000 of invoices for a
     * client the caller had not fetched and EVERY counter came back zero, so
     * a whole client's spend could leave the page with nothing saying so. */
    if (!row) {
      unknownClient.calls += 1;
      unknownClient.clients.add(clientId);
      if (isNum(e?.cost_micros)) unknownClient.costMicros += int(e.cost_micros);
      continue;
    }

    row.calls += 1;
    if (isNum(e?.cost_micros)) {
      const c = int(e.cost_micros);
      row.aiCostMicros += c;
      if (direct) row.aiCostDirectMicros += c;
      else row.aiCostMappedMicros += c;
    } else {
      row.unpricedCalls += 1;
    }
  }

  /* ONLY ONE-OFF EXPENSES. A row with interval 'monthly' or 'yearly' is a
   * RATE, not an amount: "$300/month" is not $300, and how much of it falls
   * inside the window depends on when it started and whether it has ended —
   * which `admin_expenses` records but this file does not yet apportion. So a
   * recurring cost is left out entirely and `recurringCostsSkipped` says how
   * many, rather than a monthly retainer being counted once and the client
   * looking cheaper to serve than they are.
   *
   * The window check comes FIRST. Counting it the other way round reported a
   * monthly expense from 2020 as "skipped" inside a September 2026 window,
   * which would put a line on screen about costs that have nothing to do with
   * the period being shown. */
  let recurringCostsSkipped = 0;
  for (const x of expenses) {
    const row = x?.client_id ? byClient.get(x.client_id) : null;
    if (!row) continue;
    if (!inWindowByDay(x?.incurred_on)) continue;
    const interval = String(x?.interval || "one_time").toLowerCase();
    if (interval !== "one_time") { recurringCostsSkipped += 1; continue; }
    row.handEnteredCostMicros += centsToMicros(x.amount_cents);
  }

  /* Invoices in a currency that is not the base one are NOT converted and NOT
   * added. There is no rate table in this codebase, and adding GBP to USD as
   * if they were the same unit produces a margin percentage computed over
   * mixed units — a wrong number that looks right. They are counted and
   * reported instead, so the screen can say the total is incomplete. */
  let foreignCurrencyInvoices = 0;
  for (const inv of invoices) {
    const row = inv?.client_id ? byClient.get(inv.client_id) : null;
    if (!row) {
      /* Same rule as usage: an invoice for a client we were not given is
       * counted as missing rather than quietly discarded. */
      const status = String(inv?.status || "").toLowerCase();
      if (inv?.client_id && REVENUE_STATUSES.includes(status) && inWindowByDay(inv?.issue_date)) {
        unknownClient.invoices += 1;
        unknownClient.clients.add(inv.client_id);
        if (String(inv?.currency || BASE_CURRENCY).toLowerCase() === BASE_CURRENCY) {
          unknownClient.revenueMicros += centsToMicros(inv.total_cents);
        }
      }
      continue;
    }
    const status = String(inv?.status || "").toLowerCase();
    if (!REVENUE_STATUSES.includes(status)) continue;
    if (!inWindowByDay(inv?.issue_date)) continue;
    if (String(inv?.currency || BASE_CURRENCY).toLowerCase() !== BASE_CURRENCY) {
      foreignCurrencyInvoices += 1;
      row.foreignInvoices += 1;
      continue;
    }
    /* total_cents is `bigint not null default 0` and every writer sets it, so
     * a `??` fallback to subtotal_cents can never fire — and 0 ?? x is 0
     * anyway, so an invoice genuinely totalling zero would read as its
     * subtotal. Read the column that exists, like every other reader in this
     * codebase does. */
    const micros = centsToMicros(inv.total_cents);
    row.revenueMicros += micros;
    if (status === "paid") row.paidMicros += micros;
    else row.invoicedMicros += micros;
  }

  const rows = [...byClient.values()];
  for (const row of rows) {
    const cost = row.aiCostMicros + row.handEnteredCostMicros;
    const unpricedShare = row.calls > 0 ? row.unpricedCalls / row.calls : 0;

    if (!windowed) {
      /* Revenue, cost and expenses would be three different periods. The
       * money is still reported; the percentage is not. */
      row.marginMicros = null; row.marginPct = null; row.marginWhy = MARGIN_WHY.NO_WINDOW;
    } else if (row.revenueMicros <= 0) {
      row.marginMicros = null; row.marginPct = null; row.marginWhy = MARGIN_WHY.NO_REVENUE;
    } else if (cost <= 0 && row.calls === 0) {
      /* They pay us and we have spent nothing measurable on them. That is a
       * real answer, not a missing one — but say so rather than printing
       * 100%, which reads as a measurement. */
      row.marginMicros = row.revenueMicros; row.marginPct = null; row.marginWhy = MARGIN_WHY.NO_COST;
    } else if (unpricedShare > UNPRICED_LIMIT) {
      row.marginMicros = row.revenueMicros - cost; row.marginPct = null; row.marginWhy = MARGIN_WHY.TOO_UNPRICED;
    } else {
      row.marginMicros = row.revenueMicros - cost;
      /* Rounded to one decimal by working in tenths of a percent as integers,
       * so the figure on screen is the figure that was computed. */
      row.marginPct = Math.round((row.marginMicros / row.revenueMicros) * 1000) / 10;
      row.marginWhy = MARGIN_WHY.OK;
    }
    row.totalCostMicros = cost;
  }

  /* Worst margin first: the list exists to find the client who is costing
   * more than they bring in, and that client must be at the top of it. Rows
   * with no margin sort last — an unknown is not a bad number. */
  rows.sort((a, b) => {
    if (a.marginPct === null && b.marginPct === null) return b.totalCostMicros - a.totalCostMicros;
    if (a.marginPct === null) return 1;
    if (b.marginPct === null) return -1;
    return a.marginPct - b.marginPct;
  });

  const totals = {
    clients: rows.length,
    revenueMicros: rows.reduce((n, r) => n + r.revenueMicros, 0),
    costMicros: rows.reduce((n, r) => n + r.totalCostMicros, 0),
    calls: rows.reduce((n, r) => n + r.calls, 0),
    unpricedCalls: rows.reduce((n, r) => n + r.unpricedCalls, 0),
    unattributedCostMicros: unattributed.costMicros,
    unattributedCalls: unattributed.calls,
    unattributedWorkspaces: unattributed.workspaces.size,
    recurringCostsSkipped,
    foreignCurrencyInvoices,
    orphanCostMicros: orphan.costMicros,
    orphanCalls: orphan.calls,
    attributionClashes,
    unknownClientCostMicros: unknownClient.costMicros,
    unknownClientCalls: unknownClient.calls,
    unknownClientRevenueMicros: unknownClient.revenueMicros,
    unknownClientInvoices: unknownClient.invoices,
    unknownClients: unknownClient.clients.size,
    windowed,
    periodFrom: fromDay,
    periodTo: toDay,
  };

  return {
    rows,
    unattributed: {
      costMicros: unattributed.costMicros,
      calls: unattributed.calls,
      unpricedCalls: unattributed.unpricedCalls,
      workspaces: unattributed.workspaces.size,
    },
    totals,
  };
}
