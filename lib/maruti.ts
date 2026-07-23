// Shree Maruti (Smile / innofulfill hubops) live tracking.
// Unofficial: same backend their public track-shipment page calls — no partner
// API or key exists. Normalized to the same { found, status, last_status }
// envelope the drawer uses for every courier.
//
// Contract: GET {BASE}/{awb}  (no auth, no headers beyond Accept)
//   200 + []                          -> the tracker does not know this AWB
//   200 + { orderInformation, statuses[] } -> found
//   429 + { statusCode, message }     -> throttled (see the rate limit below)
//
// ⚠️ RATE LIMIT — the single most important fact about this courier.
// Measured 2026-07-15: ~50 requests exhausted the quota, after which the endpoint
// returns 429 with `retry-after: 54491` — a ~15 HOUR lockout, not a short backoff.
// ShipWatch has ~62 Maruti orders cached (~12.5k per 30d in the panel), so an
// unpaced sweep burns the whole window in seconds and blinds this integration for
// the rest of the day.
//
// Maruti IS tracked automatically, but PACED by the persistent quota ledger below
// (courier_quota table): every call — sweep or drawer — is debited from one
// budget, capped at MARUTI_QUOTA_PER_WINDOW per MARUTI_WINDOW_MS, and a 429 hard-
// stops all calls until retry-after elapses. The ledger is in SQLite, not memory,
// so a process restart can't reset the counter and re-burn the window.
// Do not remove the pacing to "speed Maruti up" — it will make coverage WORSE.

import { getDb } from "./db";
import { COURIER_HTTP_TIMEOUT_MS } from "./config";

export type MarutiScan = {
  status?: string;
  event?: string;
  location?: string;
  /** Epoch millis. */
  statusTimestamp?: number;
  deliveryPartnerName?: string;
  category?: string;
  subcategory?: string;
  [key: string]: unknown;
};

export type MarutiOrderInformation = {
  trackingId?: string;
  sourceLocation?: { city?: string; state?: string; pincode?: string };
  destinationLocation?: { city?: string; state?: string; pincode?: string };
  receiverDetails?: { receiver_name?: string; receiver_mobile?: string };
  senderDetails?: { sender_name?: string; sender_mobile?: string };
  currentShipmentPhase?: string;
  currentShipmentPhaseUpdatedAt?: string;
  movement_type?: string;
  [key: string]: unknown;
};

export type MarutiTrackingResponse = {
  found: boolean;
  awb?: string;
  status?: string | null;
  last_status?: string | null;
  /** Clean lifecycle status derived from the latest scan's `status` code. */
  normalized_status?: string | null;
  /** Free-text `event` on an undelivered/RTO scan — the NDR reason the panel lacks. */
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  receiver?: string | null;
  /** Maruti's tracker exposes NO EDD field, so this is always null. */
  expected_delivery?: string | null;
  shipment_phase?: string | null;
  scans?: MarutiScan[];
  [key: string]: unknown;
};

const BASE = "https://apis-hubops.innofulfill.com/tracking/v2";

/** Thrown on HTTP 429. `retryAfterSeconds` has been observed at ~54,000 (≈15h),
 *  so callers should treat this as "stop asking today", not "retry shortly". */
export class MarutiThrottled extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super(
      `Shree Maruti tracking is rate-limited (429)` +
        (retryAfterSeconds ? `; retry-after ${retryAfterSeconds}s (~${(retryAfterSeconds / 3600).toFixed(1)}h)` : "")
    );
  }
}

/** The public tracker needs no account, so Maruti is always reachable. */
export function marutiConfigured(): boolean {
  return true;
}

// ---- quota ledger -------------------------------------------------------
// Observed limit ≈50 per window; we budget 40 to leave headroom for drawer
// lookups and for the fact that the exact limit is inferred, not documented.
const MARUTI_QUOTA_PER_WINDOW = Number(process.env.MARUTI_QUOTA_PER_WINDOW) || 40;
// Observed retry-after 54,491s (~15.1h) — the true TTL is slightly longer than
// that (retry-after counts down from the window's first call). We assume 16h so
// the counter resets LATER than the server's, i.e. we under-use rather than
// over-run. Erring the other way costs a 15h lockout.
const MARUTI_WINDOW_MS = Number(process.env.MARUTI_WINDOW_MS) || 16 * 60 * 60 * 1000;

export type MarutiQuota = {
  used: number;
  remaining: number;
  windowStart: string | null;
  blockedUntil: string | null;
  blocked: boolean;
};

type QuotaRow = {
  window_start: string | null;
  used: number | null;
  blocked_until: string | null;
};

function readQuotaRow(): QuotaRow | null {
  try {
    return (
      (getDb()
        .prepare("SELECT window_start, used, blocked_until FROM courier_quota WHERE courier='maruti'")
        .get() as QuotaRow | undefined) ?? null
    );
  } catch {
    return null; // no DB (e.g. a bare script) — treat as full quota
  }
}

function writeQuotaRow(row: QuotaRow): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO courier_quota (courier, window_start, used, blocked_until) VALUES ('maruti', @window_start, @used, @blocked_until) " +
          "ON CONFLICT(courier) DO UPDATE SET window_start=excluded.window_start, used=excluded.used, blocked_until=excluded.blocked_until"
      )
      .run(row);
  } catch {
    /* no DB — pacing degrades to per-call 429 handling, which still hard-stops */
  }
}

/** Current quota standing. Rolls the window over once MARUTI_WINDOW_MS has passed
 *  since its first call, and clears an expired 429 block. */
export function marutiQuota(): MarutiQuota {
  const row = readQuotaRow();
  const now = Date.now();

  const blockedUntil = row?.blocked_until ?? null;
  const blocked = blockedUntil !== null && Date.parse(blockedUntil) > now;

  let windowStart = row?.window_start ?? null;
  let used = row?.used ?? 0;
  if (windowStart && now - Date.parse(windowStart) >= MARUTI_WINDOW_MS) {
    windowStart = null; // window elapsed — next call starts a fresh one
    used = 0;
  }

  return {
    used,
    remaining: blocked ? 0 : Math.max(0, MARUTI_QUOTA_PER_WINDOW - used),
    windowStart,
    blockedUntil: blocked ? blockedUntil : null,
    blocked,
  };
}

/** Debit one call from the window (opening a new window if needed). */
function recordCall(): void {
  const q = marutiQuota();
  writeQuotaRow({
    window_start: q.windowStart ?? new Date().toISOString(),
    used: q.used + 1,
    blocked_until: q.blockedUntil,
  });
}

/** A 429 came back — stop every Maruti call until retry-after elapses. */
function recordThrottle(retryAfterSeconds: number | null): void {
  const until = new Date(Date.now() + (retryAfterSeconds ?? 15 * 3600) * 1000).toISOString();
  const q = marutiQuota();
  writeQuotaRow({
    window_start: q.windowStart ?? new Date().toISOString(),
    used: MARUTI_QUOTA_PER_WINDOW, // treat the window as spent
    blocked_until: until,
  });
}

/** How many Maruti orders the sweep may look up in THIS sync: the smaller of the
 *  remaining window quota and the per-sync trickle. The trickle is what makes
 *  automatic tracking safe — it spreads the window's budget across the day
 *  instead of spending it in the first sync. */
export function marutiSweepBudget(perSync: number): number {
  return Math.max(0, Math.min(marutiQuota().remaining, perSync));
}

/** Raised when the local ledger says the quota is spent — we refuse to call
 *  rather than spend a request learning it's a 429. */
export class MarutiQuotaExhausted extends Error {
  constructor(readonly quota: MarutiQuota) {
    super(
      `Shree Maruti quota spent (${quota.used}/${MARUTI_QUOTA_PER_WINDOW} this window)` +
        (quota.blockedUntil ? `; blocked until ${quota.blockedUntil}` : "")
    );
  }
}

/** `status` code → normalized lifecycle status. Unlike Ekart, Maruti exposes a
 *  machine code (plus free-text `event`), so this maps codes, not prose. Codes
 *  are lowercased first: the vocabulary is snake_case except READY_FOR_DISPATCH.
 *  Observed across 673 scan events on 49 real shipments (2026-07-15). */
const MARUTI_CODE_STATUS: Record<string, string> = {
  delivered: "Delivered", // inferred, NOT observed — see the note below
  undelivered: "NDR",
  rto: "RTO",
  out_for_delivery: "Out for Delivery",
  order_confirmed: "Booked",
  ready_for_dispatch: "Booked",
  inscan_at_hub: "In Transit",
  outscan_at_hub: "In Transit",
  inscanned_at_cp: "In Transit",
  outscan_to_cp: "In Transit",
  outscanned_by_cp: "In Transit",
};

/** Normalize a Maruti status code.
 *
 *  Returns null for an unrecognized code rather than guessing "In Transit": the
 *  sample that built the map above was drawn from NDR/TAT rows and never
 *  contained a completed delivery, so the delivered code is INFERRED from the
 *  vocabulary's snake_case convention and unverified. Defaulting unknowns to
 *  "In Transit" would silently report a delivered parcel as still moving; a null
 *  keeps `last_status` on the raw code, where a wrong guess is visible instead.
 *  If an unmapped code shows up in the drawer, add it here. */
function normalizeMarutiStatus(code: string | null): string | null {
  if (!code) return null;
  return MARUTI_CODE_STATUS[code.trim().toLowerCase()] ?? null;
}

/** Epoch millis → "dd/mm/yyyy hh:mm" IST, matching the other couriers' text. */
function formatTimestamp(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

type MarutiEnvelope = {
  orderInformation?: MarutiOrderInformation | null;
  statuses?: MarutiScan[] | null;
  // 429 / error shape
  statusCode?: number;
  message?: string;
};

export async function fetchMarutiTracking(awb: string): Promise<MarutiTrackingResponse> {
  // Refuse before spending a request: if the ledger says the window is spent (or
  // a 429 block is still live), calling would only earn another 429 and, worse,
  // some throttlers extend the window on rejected calls.
  const q = marutiQuota();
  if (q.remaining <= 0) throw new MarutiQuotaExhausted(q);

  recordCall(); // debit up-front — a call in flight has already cost us a request
  const res = await fetch(`${BASE}/${encodeURIComponent(awb)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });

  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    const secs = Number.isFinite(ra) && ra > 0 ? ra : null;
    // The server disagrees with our ledger (limit lower than assumed, or a window
    // we didn't know about) — trust the server and block until it says otherwise.
    recordThrottle(secs);
    throw new MarutiThrottled(secs);
  }
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Shree Maruti tracking failed with ${res.status} ${res.statusText}: ${raw}`);
  }

  let body: MarutiEnvelope | unknown[];
  try {
    body = JSON.parse(raw);
  } catch {
    return { found: false, awb };
  }

  // An unknown AWB is a 200 whose body is [] — the ONLY case that's an array.
  // A found shipment is an object, so `Promise<any[]>` (as the public snippet
  // types it) is wrong for every successful lookup.
  if (Array.isArray(body)) return { found: false, awb };

  const env = body as MarutiEnvelope;
  const info = env.orderInformation ?? {};

  // Observed newest-first on every sampled shipment, but sort defensively — Ekart
  // returns its scans unordered and silently breaks "latest" if trusted.
  const scans = [...(env.statuses ?? [])].sort(
    (a, b) => (b.statusTimestamp ?? 0) - (a.statusTimestamp ?? 0)
  );
  const latest = scans[0] ?? null;

  const code = latest?.status?.trim() || null;
  const normalized = normalizeMarutiStatus(code);

  // `event` carries the human reason ("DOOR CLOSED", "PENDING COMPANY TIME OVER")
  // and is only meaningful on a failed delivery — on in-transit scans it just
  // echoes the code ("outscan_to_cp"), so don't surface it as a reason there.
  const reason =
    normalized === "NDR" || normalized === "RTO" ? latest?.event?.trim() || null : null;

  const hasData = Boolean(code || info.trackingId || scans.length > 0);

  return {
    found: hasData,
    awb: info.trackingId?.trim() || awb,
    status: code,
    last_status: normalized ?? code,
    normalized_status: normalized,
    reason,
    current_timestamp: formatTimestamp(latest?.statusTimestamp),
    last_center: latest?.location?.trim() || null,
    destination: info.destinationLocation?.city?.trim() || null,
    receiver: info.receiverDetails?.receiver_name?.trim() || null,
    expected_delivery: null, // Maruti's tracker has no EDD field of any kind.
    shipment_phase: info.currentShipmentPhase?.trim() || null,
    source_city: info.sourceLocation?.city?.trim() || null,
    scans,
  };
}
