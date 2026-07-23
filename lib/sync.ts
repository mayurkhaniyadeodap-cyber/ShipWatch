// Sync engine: in-process singleton job, INCREMENTAL.
//
// The cache covers a rolling WINDOW_DAYS (180d ≈ 957k orders). That is far too
// much to re-fetch every cycle, so the sync is split:
//
//   Phase 1 "Incremental"  — orders whose `updated_at` falls in the last few days
//                            (~33k/day ≈ 66 pages). Catches every new and changed
//                            order. Runs every sync; this is the steady state.
//   Phase 2 "Backfill"     — walks BACKWARDS one day at a time from today to the
//                            window edge, bounded by BACKFILL_BUDGET_MS. Only
//                            runs until the window is filled, then it's a no-op.
//   Phase 3 "Prune"        — drops orders that fell out of the rolling window.
//   Phase 4 "Live track"   — courier status for a bounded batch (own budget).
//   Phase 5 "KPI"          — portal-wide aggregates, best-effort.
//
// Rows are UPSERTed into `orders` by id as each page arrives — there is no
// staging table and no whole-window Map, because holding ~957k rows in memory to
// swap them wholesale would need ~1-2GB of heap. Upserting in place also means a
// failed sync can never wipe the cache (the old design needed an empty-guard for
// exactly that), and `courier_live_status` survives untouched, which is what the
// old carry-forward-then-swap dance existed to fake.
//
// Backfill slices BY DAY rather than by offset on one huge query: the portal
// returns newest-first, so deep offset paging would drift as new orders arrive
// at the front. A day is a stable, bounded slice (~5.3k orders).

import {
  blockCourier,
  courierBlockedUntil,
  getDb,
  getSyncState,
  setSyncState,
  UPSERT_ORDER_SQL,
} from "./db";
import { callTool, type ListOrdersResponse } from "./mcp";
import {
  BACKFILL_BUDGET_MS,
  INCREMENTAL_OVERLAP_DAYS,
  KPI_TIMEOUT_MS,
  LIVE_TRACK_BREAKER_COOLDOWN_MS,
  LIVE_TRACK_BUDGET_MS,
  LIVE_TRACK_CONCURRENCY,
  LIVE_TRACK_COURIER_SPACING_MS,
  LIVE_TRACK_MAX,
  LIVE_TRACK_ON_SYNC,
  LIVE_TRACK_SPACING_MS,
  MAX_PAGES_PER_PHASE,
  MCP_CONCURRENCY,
  PAGE_LIMIT,
  SYNC_TIME_BUDGET_MS,
  WINDOW_DAYS,
} from "./config";
import {
  daysAgoIST,
  LIVE_TRACK_ACTIVE_PRIORITY_SQL,
  LIVE_TRACK_ACTIVE_SQL,
  normalizeDate,
  todayIST,
} from "./definitions";
import {
  courierIsSweepable,
  courierSweepBudget,
  resolveDirectCourier,
  statusText,
} from "./courier-tracking";

export type SyncStatus = {
  state: "idle" | "running" | "error";
  phase: string | null;
  page: number;
  total_pages: number | null;
  rows_done: number;
  started_at: string | null;
  last_synced_at: string | null;
  error: string | null;
};

export type PortalSyncPhase = {
  label: string;
  params: Record<string, unknown>;
  keep?: (row: StagedRow) => boolean;
  maxPages?: number;
  callOpts?: { timeoutMs?: number; retries?: number };
};

type SyncState = SyncStatus & { job: Promise<void> | null };

declare global {
  // eslint-disable-next-line no-var
  var __shipwatchSync: SyncState | undefined;
}

function state(): SyncState {
  if (!globalThis.__shipwatchSync) {
    globalThis.__shipwatchSync = {
      state: "idle",
      phase: null,
      page: 0,
      total_pages: null,
      rows_done: 0,
      started_at: null,
      last_synced_at: readLastSyncedAt(),
      error: null,
      job: null,
    };
  }
  return globalThis.__shipwatchSync;
}

function readLastSyncedAt(): string | null {
  try {
    const row = getDb()
      .prepare("SELECT finished_at FROM sync_log WHERE state='success' ORDER BY id DESC LIMIT 1")
      .get() as { finished_at: string } | undefined;
    return row?.finished_at ?? null;
  } catch {
    return null;
  }
}

export function getSyncStatus(): SyncStatus {
  const { job: _job, ...rest } = state();
  return rest;
}

/** Start a sync. Returns false (→ 409) if one is already running. */
export function startSync(): boolean {
  const s = state();
  if (s.state === "running") return false;
  s.state = "running";
  s.phase = "starting";
  s.page = 0;
  s.total_pages = null;
  s.rows_done = 0;
  s.started_at = new Date().toISOString();
  s.error = null;
  s.job = run().catch(() => {
    /* error already recorded in run() */
  });
  return true;
}

/** Start a sync (or join the one already running) and resolve when it finishes.
 *  Never rejects — sync errors are recorded in state/sync_log, not thrown here.
 *  Used by the server-side background scheduler. */
export async function runSyncAndWait(): Promise<void> {
  const s = state();
  if (s.state !== "running") startSync();
  await s.job?.catch(() => {
    /* error already recorded in run() */
  });
}

/** Auto-trigger a first sync when the cache is empty (spec §5). */
export function ensureFirstSync(): void {
  const s = state();
  if (s.state === "running") return;
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
  if (count === 0 && !s.last_synced_at) startSync();
}

type StagedRow = Record<string, unknown>;

/** Watermark keys in the `sync_state` table. */
const BACKFILL_CURSOR = "backfill_cursor"; // oldest day fully backfilled ("YYYY-MM-DD")
const INCREMENTAL_THROUGH = "incremental_through"; // newest day the delta pull covered

/** The delta pull: every order created or status-changed since the last sync.
 *
 *  TWO passes, not one, and deliberately NOT on `updated_at`. Measured against
 *  the live portal (2026-07-15, one 500-row page):
 *
 *      order_date              993ms   (~5.3k rows/day)
 *      last_status_updated_at  558ms   (~21k rows/day)
 *      updated_at             7703ms   (~33k rows/day)   <-- unindexed
 *
 *  `updated_at` is the obvious "what changed" field and the wrong one: it costs
 *  ~14x per page (flat across offsets, so it's the filter, not paging), which
 *  works out to ~470s of fetching per cycle — more than the whole budget.
 *
 *  `last_status_updated_at` is indexed and fast, but it is EMPTY on orders that
 *  haven't had a status event yet, so on its own it silently misses brand-new
 *  orders. Pairing it with an `order_date` pass covers both: new orders from one,
 *  status transitions on older orders from the other. Anything the portal edits
 *  WITHOUT a status change (e.g. a re-quoted rate) is picked up by the next
 *  backfill pass over that day rather than in the delta.
 *
 *  `from` is the last covered day minus INCREMENTAL_OVERLAP_DAYS: the portal's
 *  date filters are day-granular and `updated_at` isn't a returned field, so
 *  there is no timestamp to resume from. Upserts are idempotent, so overlap only
 *  costs bandwidth. A cold cache pulls just the overlap; the backfill fills in
 *  the history behind it. */
export function buildIncrementalPhases(today: string): PortalSyncPhase[] {
  const last = getSyncState(INCREMENTAL_THROUGH);
  const from = last
    ? isoDayMinus(last, INCREMENTAL_OVERLAP_DAYS)
    : daysAgoIST(INCREMENTAL_OVERLAP_DAYS);
  return [
    {
      label: "Incremental — new orders",
      params: { date_field: "order_date", from, to: today },
      maxPages: MAX_PAGES_PER_PHASE,
    },
    {
      label: "Incremental — status changes",
      params: { date_field: "last_status_updated_at", from, to: today },
      maxPages: MAX_PAGES_PER_PHASE,
    },
  ];
}

/** "YYYY-MM-DD" minus n days, without touching the IST "today" helpers.
 *  Anchored at UTC midnight so it can't be shifted by the host's local zone or
 *  a DST jump — these are calendar labels for the portal's date filters, not
 *  instants. */
export function isoDayMinus(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** One day of history, as a bounded slice. */
export function buildBackfillPhase(day: string): PortalSyncPhase {
  return {
    label: `Backfill ${day}`,
    params: { date_field: "order_date", from: day, to: day },
    maxPages: MAX_PAGES_PER_PHASE,
  };
}

async function run(): Promise<void> {
  const s = state();
  const db = getDb();
  const today = todayIST();
  // Rolling window start (WINDOW_DAYS). Everything older is pruned below.
  const windowStart = daysAgoIST(WINDOW_DAYS);
  const startedAt = new Date().toISOString();
  // Hard deadline for the DELTA pull. The backfill and live-track phases each
  // get their own budget on top, so a cold cache still makes history progress
  // instead of spending every cycle on the delta.
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;
  let pagesTotal = 0;
  let rowsTotal = 0;

  let degraded = false;

  try {
    // The portal is intermittently slow and returns transient timeouts / 500s.
    // A phase that fails after callTool's retries must not sink the run: rows
    // already upserted are committed regardless (there is no all-or-nothing
    // swap any more), so log it, flag the run degraded, and press on.
    const phase = async (label: string, fn: () => Promise<number>) => {
      try {
        pagesTotal += await fn();
      } catch (err) {
        degraded = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sync] phase "${label}" failed — continuing: ${msg}`);
      }
    };

    const sink = makeUpsertSink(() => rowsTotal, (n) => (rowsTotal = n));

    // Phase 1 — the delta: new orders + status transitions since the last sync.
    let incComplete = true;
    for (const inc of buildIncrementalPhases(today)) {
      await phase(inc.label, async () => {
        const r = await paginate(inc.label, inc.params, sink, inc.keep, inc.maxPages, deadline, inc.callOpts);
        if (!r.complete) incComplete = false;
        return r.pages;
      });
    }
    // Advance the watermark ONLY when BOTH passes succeeded and finished.
    // Running out of budget is not an error, so without the `complete` check a
    // truncated pull would look clean and the days it never reached would be
    // skipped forever — nothing would ever ask for them again.
    if (!degraded && incComplete) setSyncState(INCREMENTAL_THROUGH, today);

    // Phase 2 — backfill history, newest day first, on its own budget.
    await backfillPhase(windowStart, today, phase);

    // Phase 3 — drop what rolled out of the window.
    s.phase = "pruning";
    const pruned = db
      .prepare("DELETE FROM orders WHERE order_date IS NOT NULL AND date(order_date) < date(?)")
      .run(windowStart).changes;
    if (pruned > 0) console.log(`[sync] pruned ${pruned} orders older than ${windowStart}.`);

    // Phase 4 — live courier status, on its OWN budget so it's never starved by
    // the fetch phases. Reads its batch straight from `orders` (least-recently-
    // checked first) rather than from an in-memory snapshot.
    if (LIVE_TRACK_ON_SYNC) {
      await trackLive(Date.now() + LIVE_TRACK_BUDGET_MS);
    }

    // KPI cache. These portal-wide aggregates are non-critical to the order
    // tables that are already fetched, and the heavy one (ndr_analysis) is the
    // most prone to timing out / 500-ing. A failure here must NOT discard a
    // successful order sync, so fetch them best-effort and keep the previous
    // cached value for any that fail.
    s.phase = "KPI aggregates";
    s.page = 0;
    s.total_pages = null;
    const kpiParams = { from: windowStart, to: today };
    const kpiKeys = ["sla_performance", "ndr_analysis", "courier_performance"] as const;
    // Bounded, and exactly ONE retry. These run last, after the live-track phase
    // has spent ~60s making no MCP calls at all, which is long enough for the
    // portal to drop the idle Streamable HTTP session — all three then fail with
    // "Connection closed" against a transport that's already gone. The first
    // attempt is what triggers resetClient(); the retry is what actually
    // reconnects. Still bounded (1 retry, short timeout), so this can't become
    // the ~130s retry storm the old 3-retry default cost.
    const kpiSettled = await Promise.allSettled(
      kpiKeys.map((key) => callTool(key, kpiParams, { timeoutMs: KPI_TIMEOUT_MS, retries: 1 }))
    );
    kpiSettled.forEach((r, i) => {
      if (r.status === "rejected") {
        degraded = true;
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`[sync] KPI "${kpiKeys[i]}" failed — keeping previous cached value: ${reason}`);
      }
    });

    // No empty-guard needed any more: rows are upserted in place, so a run that
    // fetches nothing simply changes nothing. The old design rebuilt `orders`
    // from scratch every sync, which is what made an empty pull dangerous.

    s.phase = "writing cache";
    const syncedAt = new Date().toISOString();
    const commit = db.transaction(() => {
      const upsertKpi = db.prepare(
        "INSERT INTO kpi_cache (key, json, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at"
      );
      kpiKeys.forEach((key, i) => {
        const r = kpiSettled[i];
        if (r.status === "fulfilled") upsertKpi.run(key, JSON.stringify(r.value), syncedAt);
      });
      // A degraded run still counts as a success (its rows are committed), but
      // records a note so the history shows it wasn't a fully-clean pull.
      const note = degraded ? "degraded: some portal calls failed (see server logs)" : null;
      db.prepare(
        "INSERT INTO sync_log (started_at, finished_at, state, pages, rows, error) VALUES (?, ?, 'success', ?, ?, ?)"
      ).run(startedAt, syncedAt, pagesTotal, rowsTotal, note);
    });
    commit();

    s.state = "idle";
    s.phase = null;
    s.last_synced_at = syncedAt;
    s.rows_done = rowsTotal;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.state = "error";
    s.error = msg;
    try {
      db.prepare(
        "INSERT INTO sync_log (started_at, finished_at, state, pages, rows, error) VALUES (?, ?, 'error', ?, ?, ?)"
      ).run(startedAt, new Date().toISOString(), pagesTotal, s.rows_done, msg);
    } catch {
      /* keep original error */
    }
    throw err;
  }
}

/** Where a fetched page of rows goes. One transaction per page keeps the write
 *  cheap and bounded — the whole point of the incremental design is that no
 *  phase ever holds the window in memory. */
type RowSink = (rows: StagedRow[]) => void;

function makeUpsertSink(getCount: () => number, setCount: (n: number) => void): RowSink {
  const db = getDb();
  const upsert = db.prepare(UPSERT_ORDER_SQL);
  const writePage = db.transaction((rows: StagedRow[], syncedAt: string) => {
    for (const r of rows) upsert.run({ ...r, synced_at: syncedAt });
  });
  return (rows: StagedRow[]) => {
    if (rows.length === 0) return;
    writePage(rows, new Date().toISOString());
    setCount(getCount() + rows.length);
  };
}

/** Walk history backwards from the window edge, one day per slice, until the
 *  budget runs out or the window is full. Newest-first so the most useful data
 *  (recent orders, which is what TAT/NDR are about) lands first and the long
 *  tail fills in behind it over successive syncs.
 *
 *  The cursor is the oldest day already covered; it only moves once a day's
 *  slice completes, so an interrupted backfill resumes exactly where it stopped
 *  rather than restarting. */
async function backfillPhase(
  windowStart: string,
  today: string,
  phase: (label: string, fn: () => Promise<number>) => Promise<void>
): Promise<void> {
  const s = state();
  const cursor = getSyncState(BACKFILL_CURSOR);
  // Cold start: nothing backfilled yet, so begin at today and walk back.
  let day = cursor ? isoDayMinus(cursor, 1) : today;

  if (day < windowStart) {
    // Window is fully backfilled — the steady state. Nothing to do.
    return;
  }

  const budgetEnd = Date.now() + BACKFILL_BUDGET_MS;
  let days = 0;
  const sink = makeUpsertSink(
    () => s.rows_done,
    (n) => (s.rows_done = n)
  );

  while (day >= windowStart && Date.now() < budgetEnd) {
    const def = buildBackfillPhase(day);
    let ok = false;
    await phase(def.label, async () => {
      // Each day gets whatever is left of the backfill budget, so a slow day
      // can't run past the ceiling.
      const r = await paginate(def.label, def.params, sink, def.keep, def.maxPages, budgetEnd, def.callOpts);
      ok = r.complete;
      return r.pages;
    });
    // Only retire the day once it is FULLY fetched. A slice cut short by the
    // budget (or a thrown error, which leaves ok=false) must be retried next
    // sync, or that day is silently missing from the window forever.
    if (!ok) break;
    setSyncState(BACKFILL_CURSOR, day);
    days++;
    day = isoDayMinus(day, 1);
  }

  if (days > 0) {
    const remaining = Math.max(0, daysBetween(windowStart, day));
    console.log(
      `[sync] backfill: filled ${days} day(s) back through ${getSyncState(BACKFILL_CURSOR)}` +
        (remaining > 0 ? ` — ~${remaining} day(s) of history still to go.` : " — window complete.")
    );
  }
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"), floored at 0. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** Paginate one list_orders query into the sink. Returns pages fetched.
 *
 *  Completeness is driven by the server's `has_more` flag, NOT by `total_matched`
 *  — that count can be approximate or capped, so trusting it risks dropping the
 *  tail. We fetch in parallel *waves* (up to MCP_CONCURRENCY pages at once) and
 *  keep going as long as the last page of a wave still reports `has_more`, only
 *  stopping at the real end of the result set (or the maxPages / deadline guard).
 *  `total_matched` is used solely as a progress hint.
 *
 *  `complete` is false when the deadline or the page cap cut the result set
 *  short. Callers MUST NOT advance a watermark past an incomplete pull: running
 *  out of budget is not an error, so it would otherwise look like success and
 *  the unfetched pages would never be requested again. */
type PageResult = { pages: number; complete: boolean };

async function paginate(
  phaseLabel: string,
  params: Record<string, unknown>,
  sink: RowSink,
  keep?: (row: StagedRow) => boolean,
  maxPages: number = MAX_PAGES_PER_PHASE,
  deadline: number = Infinity,
  callOpts?: { timeoutMs?: number; retries?: number }
): Promise<PageResult> {
  const s = state();
  s.phase = phaseLabel;
  s.page = 0;
  s.total_pages = null;

  if (Date.now() >= deadline) {
    console.warn(`[sync] time budget spent before phase "${phaseLabel}" — skipped.`);
    return { pages: 0, complete: false };
  }

  // Each page is mapped and written straight through. Dedupe is the UPSERT's job
  // now (conflict on id), so nothing accumulates across pages.
  const absorb = (res: ListOrdersResponse) => {
    const rows: StagedRow[] = [];
    for (const raw of res.orders) {
      const row = mapOrder(raw);
      if (row && (!keep || keep(row))) rows.push(row);
    }
    sink(rows);
  };
  const estimatePages = (totalMatched: number) =>
    Math.min(maxPages, Math.max(1, Math.ceil(totalMatched / PAGE_LIMIT)));

  // Page 1 (serial) primes total_matched for the progress hint.
  const first = await callTool<ListOrdersResponse>("list_orders", {
    ...params,
    limit: PAGE_LIMIT,
    offset: 0,
  }, callOpts);
  s.total_pages = estimatePages(first.total_matched);
  absorb(first);
  let done = 1;
  s.page = done;
  if (!first.has_more) return { pages: 1, complete: true };

  // Fetch pages 2.. in parallel waves; continue while the *last* page of a wave
  // still has more. This trusts has_more, so an under-reported total_matched can
  // never cut the result set short.
  let nextPage = 2;
  let more = true;
  let stopped = false;
  let capped = false;
  while (more) {
    if (Date.now() >= deadline) {
      stopped = true;
      break;
    }
    if (nextPage > maxPages) {
      capped = true;
      break;
    }
    const waveSize = Math.min(MCP_CONCURRENCY, maxPages - nextPage + 1);
    const pageNos = Array.from({ length: waveSize }, (_, i) => nextPage + i);
    // allSettled, not all: a wave is up to MCP_CONCURRENCY x PAGE_LIMIT orders,
    // and Promise.all rejects on the first bad page — binning the siblings that
    // did arrive. Absorb everything that came back, THEN surface the failure.
    const settled = await Promise.allSettled(
      pageNos.map((page) =>
        callTool<ListOrdersResponse>("list_orders", {
          ...params,
          limit: PAGE_LIMIT,
          offset: (page - 1) * PAGE_LIMIT,
        }, callOpts).then((res) => ({ page, res }))
      )
    );
    const wave = settled
      .filter(
        (r): r is PromiseFulfilledResult<{ page: number; res: ListOrdersResponse }> =>
          r.status === "fulfilled"
      )
      .map((r) => r.value);
    for (const { res } of wave) {
      absorb(res);
      done++;
      s.page = done;
    }
    // The caller's `byId` already holds the salvaged rows, so the enclosing
    // phase() logs this and presses on with partial data.
    const failed = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) {
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
    // Only the highest-numbered page in the wave tells us if more remain.
    const last = wave.reduce((a, b) => (b.page > a.page ? b : a));
    s.total_pages = Math.max(s.total_pages ?? 0, estimatePages(last.res.total_matched));
    more = last.res.has_more;
    nextPage += waveSize;
  }

  if (stopped) {
    console.warn(`[sync] time budget reached during "${phaseLabel}" — fetched ${done} pages.`);
  } else if (capped) {
    console.warn(
      `[sync] page cap hit in phase "${phaseLabel}" (${maxPages}) — more data may remain.`
    );
  }
  return { pages: done, complete: !stopped && !capped };
}

// carryForwardCourierData() used to live here. It existed only because the old
// sync rebuilt `orders` from portal data every cycle, wiping courier columns —
// so they had to be read out and re-injected before the swap. The UPSERT now
// leaves those columns alone by construction (see PORTAL_OWNED_COLUMNS in db.ts),
// so there is nothing to carry forward.

/** Live-track a bounded batch straight from the courier sites, writing
 *  `courier_live_status` / `courier_live_checked_at` back to `orders`.
 *  Best-effort: individual failures are swallowed so a flaky courier never fails
 *  the whole sync. */
async function trackLive(deadline: number = Infinity): Promise<void> {
  const s = state();
  const db = getDb();
  s.phase = "Courier live status";
  s.page = 0;
  s.total_pages = null;

  if (Date.now() >= deadline) {
    console.warn("[sync] time budget spent before live-track — skipped.");
    return;
  }

  // Which couriers can the sweep call at all? resolveDirectCourier() matches on
  // name patterns rather than an enumerable list, so ask the cache for its
  // distinct courier names (~10) and test each once.
  const allCouriers = (
    db
      .prepare("SELECT DISTINCT shipping_company AS c FROM orders WHERE shipping_company IS NOT NULL")
      .all() as { c: string }[]
  ).map((r) => r.c);
  const integrated = allCouriers.filter((c) => courierIsSweepable(c));
  // Drop couriers the breaker benched on an earlier sync. Excluding them from
  // SELECTION (rather than selecting their rows and skipping them) is what keeps
  // a broken courier from eating the batch, while leaving its rows unmarked so
  // they're picked up the moment it recovers.
  const now = Date.now();
  const benched = integrated.filter((c) => courierBlockedUntil(c) > now);
  const sweepable = integrated.filter((c) => courierBlockedUntil(c) <= now);
  for (const c of benched) {
    const mins = Math.ceil((courierBlockedUntil(c) - now) / 60_000);
    console.log(`[sync] live-track: "${c}" is benched by the breaker for ~${mins} more min — skipping.`);
  }
  if (sweepable.length === 0) return;

  // Budgets are read once per sync (they hit the Maruti quota ledger). Split by
  // metered vs not, and select each metered courier's rows in its OWN query.
  //
  // This is load-bearing at window scale: Maruti has ~9.7k rows that are almost
  // all never-checked, so they sort to the very front of a global
  // least-recently-checked ordering. One shared `LIMIT LIVE_TRACK_MAX` would come
  // back as ~800 Maruti rows, ~799 of which get deferred by its ~1/sync quota —
  // starving every courier that actually works. Querying per-budget means a
  // quota-bound courier can only ever occupy its own budget's worth of the batch.
  const budgets = new Map<string, number>();
  for (const c of sweepable) budgets.set(c, courierSweepBudget(c));
  const metered = sweepable.filter((c) => budgets.get(c) !== Infinity);
  const unmetered = sweepable.filter((c) => budgets.get(c) === Infinity);

  // In-flight rows only (see the note on LIVE_TRACK_ACTIVE_SQL), in priority
  // order. SQLite sorts NULLs first on ASC, so never-checked rows lead and the
  // batch rotates through the set across successive syncs.
  const today = todayIST();
  const select = (couriers: string[], limit: number, where: string, order: string): StagedRow[] => {
    if (couriers.length === 0 || limit <= 0) return [];
    const keys = couriers.map((_, i) => `:c${i}`).join(",");
    const bind: Record<string, unknown> = { lim: limit, today };
    couriers.forEach((c, i) => (bind[`c${i}`] = c));
    return db
      .prepare(
        `SELECT id, awb, shipping_company, courier_live_checked_at FROM orders
         WHERE awb IS NOT NULL AND awb <> '' AND shipping_company IN (${keys}) AND (${where})
         ORDER BY ${order} LIMIT :lim`
      )
      .all(bind) as StagedRow[];
  };
  const selectFor = (couriers: string[], limit: number): StagedRow[] => {
    // Tiebreak on `edd ASC` (= worst breach first), NOT `id`. The TAT tab's
    // default sort is days_past_edd DESC, so an id-ordered sweep checks a
    // completely different 800 rows from the 50 on the user's first page — the
    // column reads as empty for hours even while coverage climbs. Matching the
    // sweep order to the read order fills what's actually on screen first.
    return select(
      couriers,
      limit,
      LIVE_TRACK_ACTIVE_SQL,
      `(${LIVE_TRACK_ACTIVE_PRIORITY_SQL}) ASC, courier_live_checked_at ASC, edd ASC, id ASC`
    );
  };

  const capped: StagedRow[] = selectFor(unmetered, LIVE_TRACK_MAX > 0 ? LIVE_TRACK_MAX : 1e9);
  for (const c of metered) {
    const budget = budgets.get(c)!;
    console.log(`[sync] live-track budget: "${c}" limited to ${budget} this sync (rate-limited courier)`);
    capped.push(...selectFor([c], budget));
  }

  // Interleave the batch round-robin by courier. The per-courier gate means a
  // run of same-courier rows serialises at ~1 per LIVE_TRACK_COURIER_SPACING_MS,
  // and since the batch is priority-ordered it IS mostly one courier — so every
  // worker ends up blocked on DTDC's gate while the Trackon/BlueDart rows further
  // down the array wait their turn. Interleaving lets the gates overlap: one
  // courier's wait is filled with another's call, up to the global gate.
  //
  // Safe to reorder: every row here already survived the priority selection, so
  // this changes the order calls go out in, not which rows get called.
  const order = interleaveByCourier(capped);

  s.total_pages = order.length;
  if (order.length === 0) return;

  const checkedAt = new Date().toISOString();
  let done = 0;
  let cursor = 0;

  // Results are written straight back to `orders` — there is no staging row to
  // mutate any more. Two statements so a "checked but no status" (breaker-
  // disabled, or the courier didn't recognise the AWB) never clobbers a good
  // status with NULL.
  const markChecked = db.prepare("UPDATE orders SET courier_live_checked_at = ? WHERE id = ?");
  const markStatus = db.prepare(
    "UPDATE orders SET courier_live_status = ?, courier_live_checked_at = ? WHERE id = ?"
  );

  // Circuit breaker: if a courier keeps erroring (e.g. all tokens 401) with zero
  // successes, stop hitting it so one broken integration doesn't fire thousands
  // of futile requests (and risk an IP block). Couriers that work are unaffected.
  const AUTH_FAIL_LIMIT = 15;
  const errors = new Map<string, number>();
  const oks = new Map<string, number>();
  const disabled = new Set<string>();

  // Two rate gates, because one isn't enough. The global gate caps our total
  // outbound rate; the PER-COURIER gate caps how fast any single courier is hit.
  //
  // The global gate alone was fine while the batch was a random mix across
  // couriers — each courier only saw a fraction of the rate. Now the batch is
  // priority-ordered (TAT breaches first) and those skew heavily to one courier
  // (DTDC is ~301k of ~957k orders), so a mostly-DTDC batch pushed DTDC's own
  // rate to nearly the full global rate and tripped its throttle. Prioritising
  // by usefulness necessarily concentrates the batch, so the gate has to be
  // per-courier to compensate.
  let nextSlot = 0;
  const nextSlotFor = new Map<string, number>();
  async function throttle(key: string): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, nextSlot, nextSlotFor.get(key) ?? 0);
    nextSlot = start + LIVE_TRACK_SPACING_MS;
    nextSlotFor.set(key, start + LIVE_TRACK_COURIER_SPACING_MS);
    const wait = start - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async function worker(): Promise<void> {
    while (cursor < order.length) {
      if (Date.now() >= deadline) return;
      const row = order[cursor++];
      const key = (row.shipping_company as string | null)?.toLowerCase() ?? "?";

      // The breaker gave up on this courier mid-sweep. Skip its remaining rows
      // WITHOUT marking them: they were never asked about, and stamping
      // courier_live_checked_at would both lie and retire them to the back of the
      // rotation for a full pass. (A 2-minute DNS outage did exactly that to the
      // top of the TAT list — the rows the sweep had just been re-ordered to
      // prioritise.) Starvation is handled by benching the courier so the NEXT
      // sync doesn't select these rows at all.
      if (disabled.has(key)) continue;

      await throttle(key);
      // Budget ran out while queued behind the rate gate. Leave this row UNMARKED
      // so it sorts first next sync: the gate serializes call starts to one per
      // LIVE_TRACK_SPACING_MS, so a LIVE_TRACK_BUDGET_MS window can only ever reach
      // ~budget/spacing calls (30s/75ms ≈ 400) — well under LIVE_TRACK_MAX (800).
      // Marking the unreached overflow (the old behaviour) retired ~half of every
      // batch without calling the courier and sent it to the BACK of the queue, so
      // those orders kept their null status for a full rotation. Over-selecting is
      // harmless once they stay unmarked; it just refills the next batch.
      if (Date.now() >= deadline) return;

      // Past this point the courier is actually asked, so the timestamp is honest.
      markChecked.run(checkedAt, row.id as number);
      done++;
      s.page = done;
      const direct = resolveDirectCourier(row.shipping_company as string | null);
      try {
        const res = await direct!.fetch(row.awb as string);
        oks.set(key, (oks.get(key) ?? 0) + 1);
        if (res.found) markStatus.run(statusText(res), checkedAt, row.id as number);
      } catch (err) {
        const n = (errors.get(key) ?? 0) + 1;
        errors.set(key, n);
        // `!disabled.has(key)` so this logs ONCE: without it every in-flight
        // worker (LIVE_TRACK_CONCURRENCY of them) re-trips the threshold on its
        // way out and prints a near-identical line.
        if (n >= AUTH_FAIL_LIMIT && !oks.get(key) && !disabled.has(key)) {
          disabled.add(key);
          // Bench it durably, so the next sync doesn't select its rows at all.
          blockCourier(row.shipping_company as string, Date.now() + LIVE_TRACK_BREAKER_COOLDOWN_MS);
          // Include the actual error. Without it "disabling dtdc" is unactionable
          // — a rate-limit reset, an expired token and a dead endpoint all look
          // identical, and they need completely different responses.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[sync] live-track: benching "${key}" for ${Math.round(LIVE_TRACK_BREAKER_COOLDOWN_MS / 60_000)} min ` +
              `after ${n} consecutive failures with no success. Last error: ${msg.slice(0, 200)}`
          );
        }
      }
    }
  }

  const pool = Array.from({ length: Math.min(LIVE_TRACK_CONCURRENCY, order.length) }, () => worker());
  await Promise.all(pool);

  const summary = [...oks.entries()].map(([k, n]) => `${k}:${n}ok`).concat(
    [...disabled].map((k) => `${k}:disabled`)
  );
  // Coverage of the IN-FLIGHT rows — the ones every tab is about — so a blank
  // courier column shows up here as a number instead of something you have to go
  // query for. Deliberately not measured over the whole 957k window: that number
  // is dominated by old delivered history the sweep intentionally ignores, and
  // would read as "3% broken" when the rows on screen are fully covered.
  const cov = db
    .prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN courier_live_checked_at IS NOT NULL THEN 1 ELSE 0 END) checked
       FROM orders WHERE awb IS NOT NULL AND awb <> '' AND (${LIVE_TRACK_ACTIVE_SQL})`
    )
    .get() as { total: number; checked: number };
  const pct = cov.total ? ((100 * cov.checked) / cov.total).toFixed(1) : "0.0";
  console.log(
    `[sync] live-track complete: ${done} checked · ${summary.join(" ")} · ` +
      `in-flight coverage ${cov.checked}/${cov.total} (${pct}%)`
  );
}

/** Round-robin rows by courier: A1,B1,C1,A2,B2,C2,… Keeps each courier's share
 *  spread across the batch so their per-courier rate gates overlap rather than
 *  queueing behind one another. */
export function interleaveByCourier(rows: StagedRow[]): StagedRow[] {
  const groups = new Map<string, StagedRow[]>();
  for (const r of rows) {
    const k = ((r.shipping_company as string | null) ?? "?").toLowerCase();
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const lists = [...groups.values()];
  const out: StagedRow[] = [];
  for (let i = 0; out.length < rows.length; i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

/** Keep only schema fields; "" dates → NULL; drop rate_summary etc. */
export function mapOrder(raw: Record<string, unknown>): StagedRow | null {
  const idValue = raw.id;
  const id =
    typeof idValue === "number"
      ? idValue
      : typeof idValue === "string" && /^\d+$/.test(idValue.trim())
        ? Number(idValue)
        : null;
  if (id === null) return null;
  const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  const num = (v: unknown) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? null : Number(v));
  const orderNo = str(raw.order_no) ?? str(raw.order_id) ?? str(raw.orderId) ?? str(raw.orderNumber);
  const awb = str(raw.awb) ?? str(raw.awb_no) ?? str(raw.awbNo) ?? str(raw.waybill) ?? str(raw.waybill_no);
  return {
    id,
    order_no: orderNo,
    marketplace_order_id: str(raw.marketplace_order_id) ?? str(raw.marketplaceOrderId),
    awb,
    status: str(raw.status),
    order_date: normalizeDate(raw.order_date),
    dispatched_at: normalizeDate(raw.dispatched_at),
    pickup_date: normalizeDate(raw.pickup_date),
    edd: normalizeDate(raw.edd),
    delivered_date: normalizeDate(raw.delivered_date),
    last_status_updated_at: normalizeDate(raw.last_status_updated_at),
    courier_slug: str(raw.courier_slug),
    shipping_company: str(raw.shipping_company),
    shipping_method: str(raw.shipping_method),
    warehouse: str(raw.warehouse),
    warehouse_id: num(raw.warehouse_id),
    seller_name: str(raw.seller_name),
    dropshipper_name: str(raw.dropshipper_name),
    customer_name: str(raw.customer_name),
    customer_contact: str(raw.customer_contact),
    customer_city: str(raw.customer_city),
    customer_state: str(raw.customer_state),
    pincode: str(raw.pincode),
    payment_type: str(raw.payment_type),
    order_total: num(raw.order_total),
    cod_total: num(raw.cod_total),
    is_ndr: raw.is_ndr ? 1 : 0,
    ndr_reason: str(raw.ndr_reason),
    attempt_count: num(raw.attempt_count) ?? 0,
    synced_at: "", // filled at insert time
    courier_live_status: null, // filled by the live-track phase
    courier_live_checked_at: null,
  };
}
