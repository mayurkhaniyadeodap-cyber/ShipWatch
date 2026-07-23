// Filtered / sorted / paginated reads over the local `orders` cache (spec §7).

import { getDb, type OrderRow } from "./db";
import {
  DAYS_PAST_EDD_SQL,
  DAYS_SINCE_UPDATE_SQL,
  TAT_BREACH_SQL,
  todayIST,
} from "./definitions";
import { SEVERITY_BUCKETS, PAGE_SIZES } from "./config";

export type Tab = "tat" | "ndr";

export type Filters = {
  couriers: string[]; // shipping_company display names
  search: string | null;
  payment: "COD" | "Prepaid" | null;
  state: string | null;
  status: string | null;
  pincode: string | null;
  severity: string | null; // TAT only: "1-2" | "3-5" | "6-10" | "10+"
  reason: string | null; // NDR only
  minAttempts: number | null; // NDR only
  dateFrom: string | null; // inclusive order_date lower bound, "YYYY-MM-DD"
  dateTo: string | null; // inclusive order_date upper bound, "YYYY-MM-DD"
  sort: string | null;
  dir: "asc" | "desc" | null;
  page: number;
  pageSize: number;
};

/** Accept only "YYYY-MM-DD"; anything else becomes null (guards the SQL). */
function parseDate(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Highest page we'll honour. Beyond this the OFFSET arithmetic overflows what
 *  SQLite accepts as an integer bind ("datatype mismatch"), so clamp instead. */
const MAX_PAGE = 1_000_000;

function parsePage(v: string | null): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}

function parseMinAttempts(v: string | null): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseFilters(sp: URLSearchParams): Filters {
  const pageSize = Number(sp.get("pageSize")) || 50;
  return {
    couriers: (sp.get("couriers") ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    search: sp.get("search")?.trim() || null,
    payment: sp.get("payment") === "COD" ? "COD" : sp.get("payment") === "Prepaid" ? "Prepaid" : null,
    state: sp.get("state")?.trim() || null,
    status: sp.get("status")?.trim() || null,
    pincode: sp.get("pincode")?.trim() || null,
    severity: sp.get("severity") || null,
    reason: sp.get("reason") || null,
    minAttempts: parseMinAttempts(sp.get("minAttempts")),
    dateFrom: parseDate(sp.get("dateFrom")),
    dateTo: parseDate(sp.get("dateTo")),
    sort: sp.get("sort") || null,
    dir: sp.get("dir") === "asc" ? "asc" : sp.get("dir") === "desc" ? "desc" : null,
    page: parsePage(sp.get("page")),
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 50,
  };
}

/** Neutralise LIKE metacharacters so a user typing "%" searches for a literal
 *  "%" instead of matching every row. Pairs with an ESCAPE '\' clause. */
function likeLiteral(v: string): string {
  return v.replace(/[\\%_]/g, "\\$&");
}

const SORTABLE: Record<string, string> = {
  days_past_edd: DAYS_PAST_EDD_SQL,
  days_since_update: DAYS_SINCE_UPDATE_SQL,
  order_no: "order_no",
  awb: "awb",
  order_date: "order_date",
  edd: "edd",
  status: "status",
  courier: "shipping_company",
  customer: "customer_name",
  city: "customer_city",
  state: "customer_state",
  pincode: "pincode",
  payment: "payment_type",
  value: "order_total",
  reason: "ndr_reason",
  attempts: "attempt_count",
  contact: "customer_contact",
  courier_status: "courier_live_status",
  checked_at: "courier_live_checked_at",
};

function baseWhere(tab: Tab): string {
  if (tab === "tat") return `(${TAT_BREACH_SQL})`;
  return `status = 'NDR'`;
}

/** Builds WHERE + params. `skipCouriers` lets the chip strip count all couriers. */
function buildWhere(tab: Tab, f: Filters, skipCouriers = false): { where: string; params: Record<string, unknown> } {
  const clauses = [baseWhere(tab)];
  const params: Record<string, unknown> = { today: todayIST() };

  if (!skipCouriers && f.couriers.length) {
    const keys = f.couriers.map((_, i) => `:courier${i}`);
    clauses.push(`shipping_company IN (${keys.join(",")})`);
    f.couriers.forEach((c, i) => (params[`courier${i}`] = c));
  }
  if (f.search) {
    clauses.push(
      `(order_no LIKE :search ESCAPE '\\' OR awb LIKE :search ESCAPE '\\'
        OR marketplace_order_id LIKE :search ESCAPE '\\'
        OR customer_name LIKE :search ESCAPE '\\' OR customer_contact LIKE :search ESCAPE '\\')`
    );
    params.search = `%${likeLiteral(f.search)}%`;
  }
  if (f.payment) {
    clauses.push(`payment_type = :payment`);
    params.payment = f.payment;
  }
  if (f.state) {
    clauses.push(`customer_state = :state`);
    params.state = f.state;
  }
  if (tab === "tat" && f.status) {
    // NDR tab is pinned to status='NDR', so this only refines TAT.
    clauses.push(`status = :status`);
    params.status = f.status;
  }
  if (f.pincode) {
    // Prefix match so "411" narrows to a region and "411001" to one pincode.
    clauses.push(`pincode LIKE :pincode ESCAPE '\\'`);
    params.pincode = `${likeLiteral(f.pincode)}%`;
  }
  if (tab === "tat" && f.severity) {
    const b = SEVERITY_BUCKETS.find((x) => x.key === f.severity);
    if (b) {
      clauses.push(`${DAYS_PAST_EDD_SQL} >= :sevMin`);
      params.sevMin = b.min;
      if (Number.isFinite(b.max)) {
        clauses.push(`${DAYS_PAST_EDD_SQL} <= :sevMax`);
        params.sevMax = b.max;
      }
    }
  }
  if (tab === "ndr" && f.reason) {
    clauses.push(`ndr_reason = :reason`);
    params.reason = f.reason;
  }
  if (tab === "ndr" && f.minAttempts != null && f.minAttempts > 0) {
    clauses.push(`attempt_count >= :minAttempts`);
    params.minAttempts = f.minAttempts;
  }
  // Inclusive order-date range. order_date is a datetime string; date() strips the time.
  if (f.dateFrom) {
    clauses.push(`date(order_date) >= :dateFrom`);
    params.dateFrom = f.dateFrom;
  }
  if (f.dateTo) {
    clauses.push(`date(order_date) <= :dateTo`);
    params.dateTo = f.dateTo;
  }
  return { where: clauses.join(" AND "), params };
}

/** better-sqlite3 throws on unused named params — bind only keys the SQL references. */
function bind(sql: string, params: Record<string, unknown>): Record<string, unknown> {
  const used: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (sql.includes(`:${k}`)) used[k] = v;
  }
  return used;
}

function orderBy(tab: Tab, f: Filters): string {
  const dir = (f.dir ?? "desc").toUpperCase();
  // hasOwnProperty, not a bare lookup: SORTABLE inherits from Object.prototype,
  // so `SORTABLE["constructor"]` would otherwise resolve and be spliced into SQL.
  if (f.sort && Object.prototype.hasOwnProperty.call(SORTABLE, f.sort)) {
    return `${SORTABLE[f.sort]} ${dir}, id ASC`;
  }
  return tab === "tat"
    ? `${DAYS_PAST_EDD_SQL} DESC, id ASC`
    : `attempt_count DESC, order_date ASC, id ASC`;
}

export type ListRow = OrderRow & {
  days_past_edd: number | null;
  days_since_update: number | null;
};

const SELECT_COLS = `*, CASE WHEN edd IS NULL THEN NULL ELSE ${DAYS_PAST_EDD_SQL} END AS days_past_edd,
  ${DAYS_SINCE_UPDATE_SQL} AS days_since_update`;

export function listRows(tab: Tab, f: Filters): { rows: ListRow[]; total: number; byCourier: { courier: string; count: number }[] } {
  const db = getDb();
  const { where, params } = buildWhere(tab, f);

  const countSql = `SELECT COUNT(*) AS n FROM orders WHERE ${where}`;
  const total = (db.prepare(countSql).get(bind(countSql, params)) as { n: number }).n;

  const rowsSql = `SELECT ${SELECT_COLS} FROM orders WHERE ${where}
       ORDER BY ${orderBy(tab, f)} LIMIT :limit OFFSET :offset`;
  const rows = db
    .prepare(rowsSql)
    .all(bind(rowsSql, { ...params, limit: f.pageSize, offset: (f.page - 1) * f.pageSize })) as ListRow[];

  const chip = buildWhere(tab, f, true);
  const chipSql = `SELECT shipping_company AS courier, COUNT(*) AS count FROM orders
       WHERE ${chip.where} AND shipping_company IS NOT NULL
       GROUP BY shipping_company ORDER BY count DESC`;
  const byCourier = db.prepare(chipSql).all(bind(chipSql, chip.params)) as { courier: string; count: number }[];

  return { rows, total, byCourier };
}

/** ALL matching rows for Excel export (no pagination). */
export function exportRows(tab: Tab, f: Filters): ListRow[] {
  const db = getDb();
  const { where, params } = buildWhere(tab, f);
  const sql = `SELECT ${SELECT_COLS} FROM orders WHERE ${where} ORDER BY ${orderBy(tab, f)}`;
  return db.prepare(sql).all(bind(sql, params)) as ListRow[];
}

export function tatKpis() {
  const db = getDb();
  const params = { today: todayIST() };
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS breached, COALESCE(SUM(order_total),0) AS stuck_value,
              COALESCE(AVG(${DAYS_PAST_EDD_SQL}),0) AS avg_days
       FROM orders WHERE ${TAT_BREACH_SQL}`
    )
    .get(params) as { breached: number; stuck_value: number; avg_days: number };
  const worst = db
    .prepare(
      `SELECT shipping_company AS courier, COUNT(*) AS count FROM orders
       WHERE ${TAT_BREACH_SQL} AND shipping_company IS NOT NULL
       GROUP BY shipping_company ORDER BY count DESC LIMIT 1`
    )
    .get(params) as { courier: string; count: number } | undefined;
  return { ...agg, worst_courier: worst ?? null };
}

export function ndrKpis() {
  const db = getDb();
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS ndr_count, COALESCE(AVG(attempt_count),0) AS avg_attempts,
              COALESCE(SUM(CASE WHEN payment_type='COD' THEN 1 ELSE 0 END),0) AS cod_count
       FROM orders WHERE status='NDR'`
    )
    .get() as { ndr_count: number; avg_attempts: number; cod_count: number };
  const top = db
    .prepare(
      `SELECT ndr_reason AS reason, COUNT(*) AS count FROM orders
       WHERE status='NDR' AND ndr_reason IS NOT NULL
       GROUP BY ndr_reason ORDER BY count DESC LIMIT 1`
    )
    .get() as { reason: string; count: number } | undefined;
  return { ...agg, top_reason: top ?? null };
}

export function meta() {
  const db = getDb();
  const params = { today: todayIST() };
  const tatByCourier = db
    .prepare(
      `SELECT shipping_company AS courier, COUNT(*) AS count FROM orders
       WHERE ${TAT_BREACH_SQL} AND shipping_company IS NOT NULL
       GROUP BY shipping_company ORDER BY count DESC`
    )
    .all(params) as { courier: string; count: number }[];
  const ndrByCourier = db
    .prepare(
      `SELECT shipping_company AS courier, COUNT(*) AS count FROM orders
       WHERE status='NDR' AND shipping_company IS NOT NULL
       GROUP BY shipping_company ORDER BY count DESC`
    )
    .all() as { courier: string; count: number }[];
  const states = (db
    .prepare(`SELECT DISTINCT customer_state AS s FROM orders WHERE customer_state IS NOT NULL ORDER BY s`)
    .all() as { s: string }[]).map((r) => r.s);
  const statuses = (db
    .prepare(`SELECT DISTINCT status AS s FROM orders WHERE status IS NOT NULL ORDER BY s`)
    .all() as { s: string }[]).map((r) => r.s);
  const reasons = db
    .prepare(
      `SELECT ndr_reason AS reason, COUNT(*) AS count FROM orders
       WHERE status='NDR' AND ndr_reason IS NOT NULL GROUP BY ndr_reason ORDER BY count DESC`
    )
    .all() as { reason: string; count: number }[];
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM orders WHERE ${TAT_BREACH_SQL}) AS tat,
              (SELECT COUNT(*) FROM orders WHERE status='NDR') AS ndr,
              (SELECT COUNT(*) FROM orders) AS total`
    )
    .get(params) as { tat: number; ndr: number; total: number };
  return {
    tatByCourier,
    ndrByCourier,
    states,
    statuses,
    reasons,
    counts,
  };
}
