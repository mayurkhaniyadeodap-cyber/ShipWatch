// Single source of truth for business definitions (spec §4).
// All "today"/day-diff math is on IST (Asia/Kolkata) CALENDAR dates.

import { differenceInCalendarDays, parseISO, subDays, format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { SEVERITY_BUCKETS, type SeverityKey, WINDOW_DAYS } from "./config";

export const IST = "Asia/Kolkata";

/** Current calendar date in IST as "YYYY-MM-DD". */
export function todayIST(): string {
  return formatInTimeZone(new Date(), IST, "yyyy-MM-dd");
}

/** "YYYY-MM-DD" for N days before today (IST). */
export function daysAgoIST(n: number): string {
  return format(subDays(parseISO(todayIST()), n), "yyyy-MM-dd");
}

export function windowFrom(): string {
  return daysAgoIST(WINDOW_DAYS);
}

/** Server date strings are "YYYY-MM-DD HH:mm:ss" or "" (= null). */
export function normalizeDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

/** Calendar-date part of a stored datetime string. */
export function datePart(d: string): string {
  return d.slice(0, 10);
}

/** Integer days today (IST) is past the EDD calendar date. >=1 means breached. */
export function daysPastEdd(edd: string, today: string = todayIST()): number {
  return differenceInCalendarDays(parseISO(today), parseISO(datePart(edd)));
}

/** TAT breach = EDD passed AND still undelivered (spec §4).
 *  JS mirror of TAT_BREACH_SQL — the status checks are case-insensitive to match
 *  SQLite's LIKE/= semantics on ASCII, so the two can't drift apart. */
export function isTatBreach(order: { edd: string | null; status: string }, today: string = todayIST()): boolean {
  if (!order.edd) return false;
  const status = order.status.toUpperCase();
  if (status === "DELIVERED" || status === "CANCELLED") return false;
  if (status.startsWith("RTO")) return false;
  return daysPastEdd(order.edd, today) >= 1;
}

export function severityOf(days: number): SeverityKey | null {
  for (const b of SEVERITY_BUCKETS) {
    if (days >= b.min && days <= b.max) return b.key;
  }
  return null;
}

/** Still in the network — not delivered, not cancelled, not returned. */
export const UNDELIVERED_SQL = `status NOT IN ('Delivered','Cancelled') AND status NOT LIKE 'RTO%'`;

/** SQL fragment for the TAT-breach predicate against the `orders` cache.
 *  Bind :today as "YYYY-MM-DD". */
export const TAT_BREACH_SQL = `
  edd IS NOT NULL
  AND date(edd) < date(:today)
  AND ${UNDELIVERED_SQL}
`;

// Which rows are worth spending a courier call on.
//
// The cache is a 6-month window (~957k orders), but only the ~44k still in the
// network are worth asking a courier about: a delivered parcel will not change
// its status, and no tab surfaces it. Sweeping everything means a full pass
// takes ~92h (measured) and the 800 calls/sync land on old delivered history
// instead of the open TAT breaches on screen — which is exactly how the courier
// column went blank when the window widened from 45d to 180d.

/** Still in the network. The rows every tab is actually about. */
export const LIVE_TRACK_ACTIVE_SQL = UNDELIVERED_SQL;

/** Sweep order — lower runs first. TAT breaches and NDR are the
 *  portal's whole reason to exist and they're small (~8.7k / ~4.1k), so they
 *  reach full courier coverage in about an hour instead of never. Bind :today. */
export const LIVE_TRACK_ACTIVE_PRIORITY_SQL = `
  CASE
    WHEN ${TAT_BREACH_SQL} THEN 0
    WHEN status = 'NDR' THEN 1
    ELSE 2
  END
`;

/** SQL expression for days_past_edd, computed at query time (never stored). */
export const DAYS_PAST_EDD_SQL = `CAST(julianday(date(:today)) - julianday(date(edd)) AS INTEGER)`;

/** SQL expression for days_since_last_update (NDR tab). */
export const DAYS_SINCE_UPDATE_SQL = `CASE WHEN last_status_updated_at IS NULL THEN NULL
  ELSE CAST(julianday(date(:today)) - julianday(date(last_status_updated_at)) AS INTEGER) END`;

