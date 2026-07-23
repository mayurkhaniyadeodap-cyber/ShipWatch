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
