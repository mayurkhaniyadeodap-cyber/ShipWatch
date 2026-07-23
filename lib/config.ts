// Central knobs for ShipWatch. Change here, not inline.

/** Rolling data window in days — 6 months. Every order with an order_date inside
 *  this window is cached; anything older is pruned each sync.
 *
 *  ~957k orders at this width (measured 2026-07-15), which is why the sync is
 *  incremental: it backfills the window once, day by day, then each cycle pulls
 *  only orders whose `updated_at` changed. Re-fetching the whole window every
 *  cycle (the old design) would be ~1,900 pages and ~30 min per sync.
 *
 *  Widening this is cheap in steady state (the incremental phase is unaffected)
 *  but re-opens the backfill for the newly-exposed days, and costs ~1.2GB of
 *  SQLite per 6 months at ~1.2KB/row. */
export const WINDOW_DAYS = Number(process.env.WINDOW_DAYS) || 180;

/** How much of each sync may go to backfilling history. Only spent while the
 *  backfill cursor hasn't reached the window edge — once the window is filled,
 *  this phase is a no-op and every sync is just the (cheap) incremental pull.
 *  At ~5.3k orders/day (~11 pages, ~6s) this fills ~10 days per cycle; a cold
 *  180-day backfill therefore takes ~18 cycles. Raise it to fill faster at the
 *  cost of a longer, heavier sync. */
export const BACKFILL_BUDGET_MS = Number(process.env.BACKFILL_BUDGET_MS) || 60_000;

/** Days of overlap re-pulled by the incremental phase, on top of the days since
 *  the last successful sync.
 *
 *  The portal's from/to filters are DATE-granular (YYYY-MM-DD) and `updated_at`
 *  is not a returned field, so the watermark can only ever be a day — not a
 *  timestamp. Re-pulling the trailing day (or more) is what stops an order that
 *  changed after the last sync's cut-off from being missed until it happens to
 *  change again. Upserts are idempotent, so overlap only costs bandwidth. */
export const INCREMENTAL_OVERLAP_DAYS = Number(process.env.INCREMENTAL_OVERLAP_DAYS) || 2;

/** MCP pagination page size (server max 500). */
export const PAGE_LIMIT = 500;

/** Safety cap per sync phase (warn if hit). */
export const MAX_PAGES_PER_PHASE = 400;

// The DELIVERED_LATE_* knobs lived here. They existed because the old sync had a
// dedicated `status=Delivered` scan that had to be kept to a tight ~14-day
// window (deliveries are ~10x TAT volume and a wide query timed out) and a page
// cap, which is why the Delivered-Late list only ever reached back ~a week.
// The window is now backfilled for ALL statuses day by day, so delivered-late
// falls out of the cache for the full WINDOW_DAYS with no special-casing and no
// wide Delivered query to time out.

/** Max concurrent MCP calls and spacing between call starts. These are the
 *  global throttle protecting the portal — every MCP call funnels through them.
 *  Tuned high so a single sync saturates its time budget (SYNC_TIME_BUDGET_MS,
 *  ~120s by default); dial back via env (MCP_CONCURRENCY / MCP_CALL_SPACING_MS)
 *  if the portal rate-limits. */
export const MCP_CONCURRENCY = Number(process.env.MCP_CONCURRENCY) || 3;
export const MCP_CALL_SPACING_MS = process.env.MCP_CALL_SPACING_MS
  ? Number(process.env.MCP_CALL_SPACING_MS)
  : 75;
export const MCP_TIMEOUT_MS = 30_000;
export const MCP_RETRIES = 3;

/** The KPI-aggregate phase runs AFTER the fetch deadline and its calls are
 *  best-effort (a failure keeps the previous cached value). To stop a slow
 *  portal from blowing the whole budget on retries, KPI calls use this shorter
 *  timeout and skip retries — worst case the phase adds ~KPI_TIMEOUT_MS, not the
 *  ~130s a full retry storm on the 30s timeout would cost. */
export const KPI_TIMEOUT_MS = Number(process.env.KPI_TIMEOUT_MS) || 15_000;

/** Wall-clock safety budget for one sync. This is a BACKSTOP, not a routine cap:
 *  set high enough that a normal day fetches every page and commits complete data
 *  well before it, and only a pathological run (portal crawling, runaway volume)
 *  is stopped so the job can never hang indefinitely. When it does fire, the sync
 *  commits whatever it has gathered (highest-priority phases first) and logs it.
 *  Lower it if you'd rather trade completeness for a firmer ceiling, or raise it
 *  for very large data windows. Tune via SYNC_TIME_BUDGET_MS. */
export const SYNC_TIME_BUDGET_MS = Number(process.env.SYNC_TIME_BUDGET_MS) || 120_000;

/** Server-side 24/7 background sync. When enabled, the Node process keeps the
 *  cache fresh on its own — re-syncing BACKGROUND_SYNC_GAP_MS after each sync
 *  finishes — so data stays current even with no browser tab open. Self-pacing
 *  (measured from completion), so it never overlaps a running sync. Requires a
 *  long-lived server (`next start` / `next dev`), not serverless. Disable with
 *  BACKGROUND_SYNC=false. */
export const BACKGROUND_SYNC = process.env.BACKGROUND_SYNC !== "false";
// Conservative cadence: re-sync ~5 min after each run finishes. The server-side
// scheduler is the SOLE sync driver (the client no longer triggers syncs), so
// this gap alone governs portal load — long enough that the portal gets idle
// breathing room between pulls and never gets rate-limited.
export const BACKGROUND_SYNC_GAP_MS = Number(process.env.BACKGROUND_SYNC_GAP_MS) || 300_000;
/** Grace period after server boot before the first background sync fires, so the
 *  app finishes starting up first. */
export const BACKGROUND_SYNC_STARTUP_DELAY_MS =
  Number(process.env.BACKGROUND_SYNC_STARTUP_DELAY_MS) || 3_000;

export const PAGE_SIZES = [50, 100, 200] as const;

/** Live courier tracking during sync. When enabled, each synced order with an
 *  AWB and a supported courier is tracked directly from the courier site and
 *  the result stored alongside the panel status. Disable with
 *  LIVE_TRACK_ON_SYNC=false if courier APIs are rate-limiting. */
export const LIVE_TRACK_ON_SYNC = process.env.LIVE_TRACK_ON_SYNC !== "false";
/** Max concurrent courier tracking calls during the sync live-track phase.
 *  Higher = faster sync but more load on courier APIs. */
export const LIVE_TRACK_CONCURRENCY = Number(process.env.LIVE_TRACK_CONCURRENCY) || 6;
/** Minimum gap between courier-tracking call STARTS, across all workers. Without
 *  this, concurrency 6 × ~250ms/call bursts ~25 req/s at one courier, which is
 *  enough to get the IP connection-reset (observed with DTDC). ~75ms caps the
 *  burst near 13/s; combined with BACKGROUND_SYNC_GAP_MS the sustained rate is
 *  far lower. Raise if a courier still rate-limits. */
export const LIVE_TRACK_SPACING_MS = Number(process.env.LIVE_TRACK_SPACING_MS ?? 0) || 75;

/** Minimum gap between call starts AT ONE COURIER, on top of the global gate
 *  above. The global gate caps our total outbound rate but says nothing about
 *  how that rate is distributed: once the sweep is priority-ordered, the batch
 *  concentrates on TAT breaches, which skew to whichever courier carries the most
 *  volume (DTDC, ~301k of ~957k). A mostly-single-courier batch therefore aims
 *  almost the entire global rate at one host and trips its throttle — observed as
 *  a run of consecutive DTDC failures that disabled it mid-sweep. ~200ms caps any
 *  single courier near 5/s while the global gate still allows ~13/s across all of
 *  them. Raise if a courier still rate-limits; lower only if coverage stalls. */
export const LIVE_TRACK_COURIER_SPACING_MS =
  Number(process.env.LIVE_TRACK_COURIER_SPACING_MS ?? 0) || 200;
/** How many orders to live-track per sync. Bounded (not 0/unlimited) so one sync
 *  stays rate-limit-safe: the phase refreshes the least-recently-checked batch,
 *  and prior courier results are carried forward, so coverage accumulates across
 *  successive syncs instead of re-fetching everything every time. */
export const LIVE_TRACK_MAX = Number(process.env.LIVE_TRACK_MAX ?? 0) || 800;
/** How long a courier stays benched after the live-track circuit breaker trips.
 *  Long enough that a genuinely broken integration (expired tokens, dead
 *  endpoint) doesn't burn AUTH_FAIL_LIMIT calls every sync; short enough that a
 *  transient blip — a DNS wobble, a brief rate-limit — costs one cooldown, not a
 *  day. While benched the courier's rows are simply not SELECTED, so they keep
 *  their place at the front of the rotation instead of being retired unchecked. */
export const LIVE_TRACK_BREAKER_COOLDOWN_MS =
  Number(process.env.LIVE_TRACK_BREAKER_COOLDOWN_MS) || 1_800_000; // 30 min

/** Dedicated wall-clock budget for the live-track phase, SEPARATE from the panel
 *  fetch budget so courier enrichment always gets a slice (it used to run last
 *  and get starved).
 *
 *  Throughput is set by LIVE_TRACK_SPACING_MS, NOT by LIVE_TRACK_CONCURRENCY: the
 *  rate gate serializes call STARTS, so the phase can only reach
 *  ~LIVE_TRACK_BUDGET_MS / LIVE_TRACK_SPACING_MS orders per sync regardless of how
 *  many workers are running. At 75ms spacing: 30s ≈ 400, 60s ≈ 800. Sized to match
 *  LIVE_TRACK_MAX (800) so a full batch is actually reachable — an earlier 30s
 *  default left half of every batch uncalled. Rows past the budget stay unmarked
 *  and are picked up first next sync, so raising this widens coverage per sync
 *  without changing the per-second load on any courier. */
export const LIVE_TRACK_BUDGET_MS = Number(process.env.LIVE_TRACK_BUDGET_MS) || 60_000;

/** Per-request ceiling for a single courier tracking HTTP call. This is a
 *  correctness guard, not a tuning knob: without it a courier host that accepts
 *  the connection and then goes silent pins a live-track worker indefinitely
 *  (Node's http.request has NO default timeout, and undici's is 300s — 5x the
 *  whole LIVE_TRACK_BUDGET_MS). Because the phase deadline is only checked
 *  BETWEEN orders, a hung call can never be interrupted, so one bad socket would
 *  otherwise stall the sync — and with it the scheduler loop — for the life of
 *  the process. Keep it well under LIVE_TRACK_BUDGET_MS. */
export const COURIER_HTTP_TIMEOUT_MS = Number(process.env.COURIER_HTTP_TIMEOUT_MS) || 15_000;

/** How many Shree Maruti orders the live-track sweep may look up per sync.
 *  Maruti's tracker allows only ~50 requests per ~15h (measured), so it cannot be
 *  swept like the others — it trickles. Raising this does NOT speed coverage up:
 *  the window quota is the binding limit, and overrunning it costs a ~15h
 *  lockout. The persistent ledger in lib/maruti.ts enforces the window.
 *
 *  Scale reality check: the cache holds ~9.7k Maruti AWBs, so at ~50 lookups per
 *  15h a full pass is measured in YEARS — Maruti coverage is effectively
 *  decorative at this volume, and the courier dots for those rows stay hollow.
 *  Only a bulk/partner endpoint would change that; tuning this knob will not.
 *  (The trickle is at least harmless: sync.ts defers over-budget Maruti rows
 *  without consuming the shared LIVE_TRACK_MAX batch, so it can't starve the
 *  couriers that do work.) */
export const MARUTI_SWEEP_PER_SYNC = Number(process.env.MARUTI_SWEEP_PER_SYNC ?? 0) || 1;

/** Severity buckets for days_past_edd. Order matters (first match wins). */
export const SEVERITY_BUCKETS = [
  { key: "1-2", label: "1–2 days", min: 1, max: 2 },
  { key: "3-5", label: "3–5 days", min: 3, max: 5 },
  { key: "6-10", label: "6–10 days", min: 6, max: 10 },
  { key: "10+", label: "10+ days", min: 11, max: Infinity },
] as const;

export type SeverityKey = (typeof SEVERITY_BUCKETS)[number]["key"];
