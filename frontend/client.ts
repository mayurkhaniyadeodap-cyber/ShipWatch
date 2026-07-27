// Client-side types, fetch helpers and formatters.
// (Types mirror the API routes; keep in sync with lib/queries.ts.)

export type Tab = "tat" | "ndr";

export type OrderApiRow = {
  id: number;
  order_no: string | null;
  marketplace_order_id: string | null;
  awb: string | null;
  status: string | null;
  order_date: string | null;
  dispatched_at: string | null;
  pickup_date: string | null;
  edd: string | null;
  delivered_date: string | null;
  last_status_updated_at: string | null;
  courier_slug: string | null;
  shipping_company: string | null;
  shipping_method: string | null;
  warehouse: string | null;
  warehouse_id: number | null;
  seller_name: string | null;
  dropshipper_name: string | null;
  customer_name: string | null;
  customer_contact: string | null;
  customer_city: string | null;
  customer_state: string | null;
  pincode: string | null;
  payment_type: string | null;
  order_total: number | null;
  cod_total: number | null;
  is_ndr: number;
  ndr_reason: string | null;
  attempt_count: number;
  synced_at: string;
  courier_live_status: string | null;
  courier_live_checked_at: string | null;
  /** Failed delivery attempts counted from the courier's own scans on the last
   *  sweep; null when the courier has no direct integration / scan history, or
   *  hasn't been swept yet. The panel's attempt_count is unreliable (overflows
   *  at 127), so this is the trustworthy figure to compare against. */
  courier_attempts: number | null;
  days_past_edd: number | null;
  days_since_update: number | null;
};

export type ListResponse = {
  rows: OrderApiRow[];
  total: number;
  byCourier: { courier: string; count: number }[];
};

export type SyncStatusResponse = {
  state: "idle" | "running" | "error";
  phase: string | null;
  page: number;
  total_pages: number | null;
  rows_done: number;
  started_at: string | null;
  last_synced_at: string | null;
  error: string | null;
  orders: number;
};

export type MetaResponse = {
  tatByCourier: { courier: string; count: number }[];
  ndrByCourier: { courier: string; count: number }[];
  states: string[];
  statuses: string[];
  reasons: { reason: string; count: number }[];
  counts: { tat: number; ndr: number; total: number };
  last_synced_at: string | null;
};

export type TatKpis = {
  tab: "tat";
  breached: number;
  stuck_value: number;
  avg_days: number;
  worst_courier: { courier: string; count: number } | null;
};

export type NdrKpis = {
  tab: "ndr";
  ndr_count: number;
  avg_attempts: number;
  cod_count: number;
  top_reason: { reason: string; count: number } | null;
};

export type OrderStatusResponse = {
  found: boolean;
  /** "courier" = the courier's own API answered; "panel" = shipping-panel fallback. */
  source?: "courier" | "panel";
  last_status?: string | null;
  status?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  /** Failed delivery attempts counted live from the courier's scans (courier
   *  source only; null/absent for the panel fallback). */
  attempts?: number | null;
  [k: string]: unknown;
};

export type FilterState = {
  couriers: string[];
  search: string;
  payment: "COD" | "Prepaid" | null;
  state: string | null;
  status: string | null;
  pincode: string;
  severity: string | null;
  reason: string | null;
  minAttempts: number;
  /** Inclusive order-date range, "YYYY-MM-DD" or null for open-ended. */
  dateFrom: string | null;
  dateTo: string | null;
};

export const EMPTY_FILTERS: FilterState = {
  couriers: [],
  search: "",
  payment: null,
  state: null,
  status: null,
  pincode: "",
  severity: null,
  reason: null,
  minAttempts: 0,
  dateFrom: null,
  dateTo: null,
};

export function filterParams(tab: Tab, f: FilterState): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.couriers.length) sp.set("couriers", f.couriers.join(","));
  if (f.search.trim()) sp.set("search", f.search.trim());
  if (f.payment) sp.set("payment", f.payment);
  if (f.state) sp.set("state", f.state);
  if (tab === "tat" && f.status) sp.set("status", f.status);
  if (f.pincode.trim()) sp.set("pincode", f.pincode.trim());
  if (tab === "tat" && f.severity) sp.set("severity", f.severity);
  if (tab === "ndr" && f.reason) sp.set("reason", f.reason);
  if (tab === "ndr" && f.minAttempts > 0) sp.set("minAttempts", String(f.minAttempts));
  if (f.dateFrom) sp.set("dateFrom", f.dateFrom);
  if (f.dateTo) sp.set("dateTo", f.dateTo);
  return sp;
}

export function hasActiveFilters(f: FilterState): boolean {
  return (
    f.couriers.length > 0 || f.search.trim() !== "" || f.payment !== null ||
    f.state !== null || f.status !== null || f.pincode.trim() !== "" || f.severity !== null ||
    f.reason !== null || f.minAttempts > 0 || f.dateFrom !== null || f.dateTo !== null
  );
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* not json */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---- formatters ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-25 10:11:12" → "25 Jun" */
export function fmtDay(d: string | null): string {
  if (!d) return "—";
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  if (!m || !day) return "—";
  return `${day} ${MONTHS[m - 1]}`;
}

/** "2026-06-25 10:11:12" → "25 Jun 2026" */
export function fmtDate(d: string | null): string {
  if (!d) return "—";
  return `${fmtDay(d)} ${d.slice(0, 4)}`;
}

// ---- courier "last update" timestamps ----
//
// Every integration reports the last scan time in its own shape: Trackon sends
// "25072026 08:39", BlueDart "25-Jul-2026 0839", Delhivery an ISO string, and
// Maruti/Ekart/Amazon "25/07/2026 08:39". The drawer used to print whichever
// arrived, verbatim, next to a panel column formatted as "25 Jun 2026" — so the
// two sides of the comparison were not comparable by eye.
//
// Detecting the shape here (rather than normalising each adapter) keeps the next
// courier integration from reintroducing the bug: whatever it sends, it lands in
// one of these forms or is shown untouched.

const MONTH_BY_NAME: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Values couriers send to mean "nothing" — shown as "—" rather than as text. */
const PLACEHOLDERS = new Set(["", "null", "nil", "n/a", "na", "-", "--", "undefined", "0"]);

type DateParts = { y: number; mo: number; d: number; hh?: number; mi?: number };

function isPlausibleYear(y: number): boolean {
  return y >= 1990 && y <= 2100;
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** A parse only counts if it lands on a real calendar date. Guards against
 *  reading "13/13/2026" as a date, and against a compact-digit misread. */
function isRealDate(p: DateParts): boolean {
  if (!isPlausibleYear(p.y)) return false;
  if (p.mo < 1 || p.mo > 12) return false;
  if (p.d < 1 || p.d > daysInMonth(p.y, p.mo)) return false;
  if (p.hh !== undefined && (p.hh > 23 || (p.mi ?? 0) > 59)) return false;
  return true;
}

/** "08:39", "08:39:12" or BlueDart's compact "0839". */
function parseClock(s: string | undefined): { hh: number; mi: number } | null {
  if (!s) return null;
  const colon = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (colon) return { hh: Number(colon[1]), mi: Number(colon[2]) };
  const compact = /^(\d{2})(\d{2})$/.exec(s);
  if (compact) return { hh: Number(compact[1]), mi: Number(compact[2]) };
  return null;
}

function withClock(base: Omit<DateParts, "hh" | "mi">, clock: string | undefined): DateParts {
  const t = parseClock(clock);
  return t ? { ...base, hh: t.hh, mi: t.mi } : { ...base };
}

/** Epoch seconds/millis → IST parts (couriers that send a bare number mean UTC). */
function fromEpoch(ms: number): DateParts | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), hh: get("hour"), mi: get("minute") };
}

const CLOCK = String.raw`(\d{1,2}:\d{2}(?::\d{2})?|\d{4})`;

function detectDate(s: string): DateParts | null {
  // ISO / SQL: 2026-07-25, 2026-07-25T08:39:12+05:30, 2026-07-25 08:39:12
  const iso = new RegExp(
    String.raw`^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?`
  ).exec(s);
  if (iso) {
    // An explicit zone means the wall clock isn't ours — convert to IST rather
    // than printing a UTC time next to the panel's IST one.
    if (iso[6]) {
      const ms = Date.parse(s);
      if (Number.isFinite(ms)) {
        const p = fromEpoch(ms);
        if (p && isRealDate(p)) return p;
      }
    }
    const p: DateParts = { y: +iso[1], mo: +iso[2], d: +iso[3] };
    if (iso[4] !== undefined) { p.hh = +iso[4]; p.mi = +iso[5]; }
    if (isRealDate(p)) return p;
  }

  // Separated numeric: 25/07/2026, 25-7-26, 2026.07.25 — with optional time.
  const sep = new RegExp(String.raw`^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:[T ,]+${CLOCK})?$`).exec(s);
  if (sep) {
    const [a, b, c] = [Number(sep[1]), Number(sep[2]), Number(sep[3])];
    if (sep[1].length === 4) {
      const p = withClock({ y: a, mo: b, d: c }, sep[4]);
      if (isRealDate(p)) return p;
    } else {
      const y = c < 100 ? 2000 + c : c;
      // Indian couriers are day-first; only flip when the numbers force it
      // (a value above 12 can only be a day).
      const dayFirst = !(a <= 12 && b > 12);
      const p = withClock(dayFirst ? { y, mo: b, d: a } : { y, mo: a, d: b }, sep[4]);
      if (isRealDate(p)) return p;
    }
  }

  // Month name, either order: "25-Jul-2026 0839", "25 July 2026", "Jul 25, 2026".
  const dmy = new RegExp(String.raw`^(\d{1,2})[ \-/]+([A-Za-z]{3,9})\.?[ \-/]+(\d{2,4})(?:[ ,]+${CLOCK})?$`).exec(s);
  if (dmy) {
    const mo = MONTH_BY_NAME[dmy[2].slice(0, 3).toLowerCase()];
    const y = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    if (mo) {
      const p = withClock({ y, mo, d: +dmy[1] }, dmy[4]);
      if (isRealDate(p)) return p;
    }
  }
  const mdy = new RegExp(String.raw`^([A-Za-z]{3,9})\.?[ \-/]+(\d{1,2}),?[ \-/]+(\d{2,4})(?:[ ,]+${CLOCK})?$`).exec(s);
  if (mdy) {
    const mo = MONTH_BY_NAME[mdy[1].slice(0, 3).toLowerCase()];
    const y = Number(mdy[3]) < 100 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    if (mo) {
      const p = withClock({ y, mo, d: +mdy[2] }, mdy[4]);
      if (isRealDate(p)) return p;
    }
  }

  // Compact 8 digits, optional separate time: Trackon's "25072026 08:39".
  // Whichever end holds a plausible year decides the order, so DDMMYYYY and
  // YYYYMMDD are told apart without guessing.
  const packed = new RegExp(String.raw`^(\d{8})(?:[T ]+${CLOCK})?$`).exec(s);
  if (packed) {
    const g = packed[1];
    const asDMY = { y: +g.slice(4), mo: +g.slice(2, 4), d: +g.slice(0, 2) };
    const asYMD = { y: +g.slice(0, 4), mo: +g.slice(4, 6), d: +g.slice(6) };
    for (const cand of [asYMD, asDMY]) {
      if (!isPlausibleYear(cand.y)) continue;
      const p = withClock(cand, packed[2]);
      if (isRealDate(p)) return p;
    }
  }

  // Compact datetime: YYYYMMDDHHMM(SS).
  const packedDt = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:\d{2})?$/.exec(s);
  if (packedDt) {
    const p: DateParts = {
      y: +packedDt[1], mo: +packedDt[2], d: +packedDt[3], hh: +packedDt[4], mi: +packedDt[5],
    };
    if (isRealDate(p)) return p;
  }

  // Bare epoch (seconds or millis).
  if (/^\d{10}$/.test(s)) { const p = fromEpoch(Number(s) * 1000); if (p && isRealDate(p)) return p; }
  if (/^\d{13}$/.test(s)) { const p = fromEpoch(Number(s)); if (p && isRealDate(p)) return p; }

  return null;
}

/** Any courier's "last update" string → "25 Jul 2026 08:39" (time dropped when
 *  the courier didn't send one), matching the panel column's style.
 *
 *  Anything unrecognised is returned VERBATIM rather than guessed at — showing a
 *  confidently wrong date in a mismatch table is worse than showing an ugly one. */
export function fmtCourierDate(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "—";
  const s = String(raw).trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return "—";

  const p = detectDate(s);
  if (!p) return s;

  const date = `${p.d} ${MONTHS[p.mo - 1]} ${p.y}`;
  if (p.hh === undefined) return date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date} ${pad(p.hh)}:${pad(p.mi ?? 0)}`;
}

export function fmtMoney(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

/** Compact lakh notation for KPI: ₹28.4L */
export function fmtMoneyCompact(v: number): string {
  if (v >= 1_00_00_000) return `₹${(v / 1_00_00_000).toFixed(2)}Cr`;
  if (v >= 1_00_000) return `₹${(v / 1_00_000).toFixed(1)}L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

export function fmtInt(v: number): string {
  return v.toLocaleString("en-IN");
}

/** "InTransit" → "In Transit", "OutForDelivery" → "Out For Delivery"; leaves "NDR". */
export function fmtStatus(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Strip case, spaces and punctuation so a panel status and a courier status can
 *  be compared for real disagreement rather than formatting: the panel's
 *  "InTransit" and a courier's "In Transit" are the same fact. Every surface that
 *  flags a panel-vs-courier conflict must go through this — a raw compare turns
 *  cosmetic wording differences into false "Mismatch" badges. */
export function canonStatus(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export const SEVERITY_STYLES: Record<string, { bg: string; fg: string; dot: string }> = {
  "1-2": { bg: "#FEF3C7", fg: "#92400E", dot: "#D97706" },
  "3-5": { bg: "#FFEDD5", fg: "#9A3412", dot: "#EA580C" },
  "6-10": { bg: "#FEE2E2", fg: "#B91C1C", dot: "#DC2626" },
  "10+": { bg: "#991B1B", fg: "#FFFFFF", dot: "#991B1B" },
};

export function severityKey(days: number | null): string | null {
  if (days === null || days < 1) return null;
  if (days <= 2) return "1-2";
  if (days <= 5) return "3-5";
  if (days <= 10) return "6-10";
  return "10+";
}

/** Panel-vs-courier attempt disagreement worth flagging. The panel's
 *  attempt_count is unreliable (it overflows at 127), so we only flag when a
 *  real courier count exists AND differs from the panel by a meaningful margin —
 *  a ±1–2 gap is just timing between the panel and the courier's latest scan. */
export const ATTEMPT_MISMATCH_MIN = 3;
export function attemptsDisagree(
  panel: number | null | undefined,
  courier: number | null | undefined
): boolean {
  if (courier == null || panel == null) return false;
  return Math.abs(panel - courier) >= ATTEMPT_MISMATCH_MIN;
}
