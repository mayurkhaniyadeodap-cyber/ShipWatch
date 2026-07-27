// On-demand, filter-scoped courier fill.
//
// The background sweep (backend/sync.ts `trackLive`) is priority-ordered and
// bounded per sync, so normal in-transit rows and the NDR tail can stay blank for
// a long rotation. This module is the interactive counterpart: given a tab +
// filter set, it live-tracks the next chunk of BLANK/STALE matching rows straight
// from the courier sites and writes the result back to `orders`, exactly like the
// sweep. The dashboard calls it in a loop (a chunk per request) until nothing
// stale remains, so the column fills in progressively while the user watches.
//
// Deliberately courier-DIRECT only (no panel fallback): a full-view fill can touch
// thousands of rows, and the portal MCP is the sync's bottleneck, so unbounded
// panel calls here would be dangerous. Rows the courier can't see are marked
// checked (they drop out of the stale set so the loop converges) and left for the
// sweep's own bounded panel fallback to resolve.

import { courierBlockedUntil, getDb } from "@/backend/db";
import { fillCandidates, type Filters, type Tab } from "@/backend/queries";
import {
  LIVE_FILL_CHUNK,
  LIVE_FILL_CONCURRENCY,
  LIVE_FILL_MAX_AGE_MS,
  LIVE_FILL_MAX_CHUNK,
  LIVE_FILL_MAX_INFLIGHT,
  LIVE_TRACK_COURIER_SPACING_MS,
  LIVE_TRACK_SPACING_MS,
} from "@/backend/config";
import {
  courierIsSweepable,
  courierSweepBudget,
  resolveDirectCourier,
  statusText,
} from "@/interface/courier-tracking";

export type FilledRow = {
  id: number;
  courier_live_status: string | null;
  courier_attempts: number | null;
  courier_live_checked_at: string;
};

export type FillResult = { filled: FilledRow[]; remaining: number; busy?: boolean };

// PROCESS-GLOBAL courier rate gate. This is the load-bearing hardening for going
// live: the throttle state lives at module scope, so EVERY fill request — no
// matter which user or browser tab triggered it — draws from the SAME global +
// per-courier budget. Without this, each request built its own gate and N
// concurrent users would hit each courier at N× the intended rate, tripping
// rate-limits / IP-blocks and cascading through the breaker until live status died
// for everyone. Single self-hosted instance, so module scope IS the process gate.
let gNextSlot = 0;
const gNextSlotFor = new Map<string, number>();
async function courierThrottle(key: string): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, gNextSlot, gNextSlotFor.get(key) ?? 0);
  gNextSlot = start + LIVE_TRACK_SPACING_MS;
  gNextSlotFor.set(key, start + LIVE_TRACK_COURIER_SPACING_MS);
  const wait = start - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// How many fill requests are executing right now (across all users). Bounds how
// much work can queue behind the global gate at once; excess requests are shed.
let inflight = 0;

/** Distinct couriers in the cache the fill may call. A courier qualifies when it:
 *   1. has a direct integration (courierIsSweepable), and
 *   2. is UNMETERED — courierSweepBudget === Infinity. This excludes quota-bound
 *      couriers (Shree Maruti, ~50 lookups per 15h): a bulk fill would blow the
 *      window and earn a ~15h lockout, so those rows are left to the sweep's
 *      trickle and stay blank here, and
 *   3. isn't currently benched by the sweep's circuit breaker, so a courier the
 *      sweep already gave up on this window isn't hammered by an interactive fill. */
function fillableCouriers(): string[] {
  const db = getDb();
  const all = (
    db
      .prepare("SELECT DISTINCT shipping_company AS c FROM orders WHERE shipping_company IS NOT NULL")
      .all() as { c: string }[]
  ).map((r) => r.c);
  const now = Date.now();
  return all.filter(
    (c) =>
      courierIsSweepable(c) &&
      courierSweepBudget(c) === Infinity &&
      courierBlockedUntil(c) <= now
  );
}

/** Fill one chunk of the tab/filter's blank-or-stale rows and persist the results.
 *  Returns the rows it filled (for the client to overlay) and how many stale rows
 *  still remain AFTER this chunk (0 ⇒ the view is fully populated). `busy` ⇒ too
 *  many fills are already running; nothing was fetched and the client should back
 *  off and retry. */
export async function fillView(tab: Tab, f: Filters, chunk: number): Promise<FillResult> {
  const db = getDb();
  const limit = Math.max(1, Math.min(chunk || LIVE_FILL_CHUNK, LIVE_FILL_MAX_CHUNK));
  const staleBefore = new Date(Date.now() - LIVE_FILL_MAX_AGE_MS).toISOString();
  const couriers = fillableCouriers();

  // Shed load: too many fills already queued behind the global gate. Report what's
  // left so the client waits and retries instead of adding to the pile. Checked
  // before selecting/marking any rows so a shed request has zero side effects.
  if (inflight >= LIVE_FILL_MAX_INFLIGHT) {
    const { remaining } = fillCandidates(tab, f, couriers, staleBefore, 0);
    return { filled: [], remaining, busy: true };
  }

  inflight++;
  try {
    const { rows } = fillCandidates(tab, f, couriers, staleBefore, limit);
    if (rows.length === 0) return { filled: [], remaining: 0 };

    // Split writes like the sweep so a "checked but no status" never clobbers a
    // good status with NULL.
    const markChecked = db.prepare("UPDATE orders SET courier_live_checked_at = ? WHERE id = ?");
    const markStatus = db.prepare(
      "UPDATE orders SET courier_live_status = ?, courier_live_checked_at = ? WHERE id = ?"
    );
    const markAttempts = db.prepare("UPDATE orders SET courier_attempts = ? WHERE id = ?");
    const checkedAt = new Date().toISOString();

    const filled: FilledRow[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        const courier = row.shipping_company;
        const key = (courier ?? "?").toLowerCase();
        const direct = resolveDirectCourier(courier);
        // Process-global gate (module scope) — shared across every concurrent fill.
        await courierThrottle(key);
        try {
          // `direct` is guaranteed non-null: selection is restricted to sweepable
          // couriers. The guard is belt-and-suspenders in case the courier list and
          // the row set race a config change.
          if (!direct) throw new Error("no direct integration");
          const res = await direct.fetch(row.awb);
          const attempts = direct.countAttempts?.(res) ?? null;
          if (res.found) {
            const st = statusText(res);
            markStatus.run(st, checkedAt, row.id);
            if (attempts != null) markAttempts.run(attempts, row.id);
            filled.push({ id: row.id, courier_live_status: st, courier_attempts: attempts, courier_live_checked_at: checkedAt });
          } else {
            // Answered but no docket (brand-new label, or an account gap the sweep's
            // panel fallback still owns). Mark checked so it leaves the stale set and
            // the loop converges; the sweep refreshes it later.
            markChecked.run(checkedAt, row.id);
            filled.push({ id: row.id, courier_live_status: null, courier_attempts: attempts, courier_live_checked_at: checkedAt });
          }
        } catch {
          // Courier error: mark checked so the chunk converges (status stays blank;
          // the background sweep retries it). Without this a persistently-erroring
          // row sits at the front of the stale order and every chunk retries it, so
          // the client loop would never reach "remaining: 0".
          markChecked.run(checkedAt, row.id);
          filled.push({ id: row.id, courier_live_status: null, courier_attempts: null, courier_live_checked_at: checkedAt });
        }
      }
    };

    const pool = Array.from({ length: Math.min(LIVE_FILL_CONCURRENCY, rows.length) }, () => worker());
    await Promise.all(pool);

    // Recount stale AFTER persisting this chunk — the rows we just stamped now fail
    // the `checked_at < staleBefore` test, so this is exactly what's left to do.
    const { remaining } = fillCandidates(tab, f, couriers, staleBefore, 0);
    return { filled, remaining };
  } finally {
    inflight--;
  }
}
