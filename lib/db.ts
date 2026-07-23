import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "shipwatch.db");

const ORDER_COLUMNS = `
  id INTEGER PRIMARY KEY, order_no TEXT, marketplace_order_id TEXT, awb TEXT, status TEXT,
  order_date TEXT, dispatched_at TEXT, pickup_date TEXT, edd TEXT, delivered_date TEXT,
  last_status_updated_at TEXT, courier_slug TEXT, shipping_company TEXT, shipping_method TEXT,
  warehouse TEXT, warehouse_id INTEGER, seller_name TEXT, dropshipper_name TEXT,
  customer_name TEXT, customer_contact TEXT, customer_city TEXT, customer_state TEXT,
  pincode TEXT, payment_type TEXT, order_total REAL, cod_total REAL,
  is_ndr INTEGER, ndr_reason TEXT, attempt_count INTEGER, synced_at TEXT,
  courier_live_status TEXT, courier_live_checked_at TEXT
`;

// Columns added after the initial release — ALTERed onto existing caches so a
// pre-existing shipwatch.db doesn't need to be deleted. Keep in sync with the
// tail of ORDER_COLUMNS / ORDER_FIELD_NAMES.
const ADDED_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "courier_live_status", type: "TEXT" },
  { name: "courier_live_checked_at", type: "TEXT" },
];

function ensureColumns(db: Database.Database, table: string): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  );
  for (const col of ADDED_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __shipwatchDb: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (${ORDER_COLUMNS});
    CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(shipping_company);
    CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_edd     ON orders(edd);
    -- order_date drives both the rolling-window prune and the backfill slices.
    CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
    -- The live-track sweep picks the least-recently-checked rows every sync.
    CREATE INDEX IF NOT EXISTS idx_orders_checked ON orders(courier_live_checked_at);
    -- PARTIAL index over just the still-in-flight rows (~44k of ~957k). The
    -- sweep's batch query filters on exactly this predicate, so without it the
    -- planner walks ~810k rows via idx_orders_company and sorts them, every sync.
    -- Must stay in step with UNDELIVERED_SQL in definitions.ts.
    CREATE INDEX IF NOT EXISTS idx_orders_live_active
      ON orders(courier_live_checked_at, id)
      WHERE status NOT IN ('Delivered','Cancelled') AND status NOT LIKE 'RTO%';
    -- Once served the Mismatch tab's delivered-tail sweep (feature removed);
    -- dropped so existing DBs stop paying its write cost.
    DROP INDEX IF EXISTS idx_orders_delivered_date;
    -- Durable sync watermarks (backfill cursor, incremental high-water day).
    -- Must survive restarts or the backfill would restart from scratch forever.
    CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS kpi_cache (key TEXT PRIMARY KEY, json TEXT, updated_at TEXT);
    -- Per-courier rate-limit ledger, for couriers whose quota spans far longer
    -- than one sync (Shree Maruti: ~50 requests per ~15h). Persisted so the
    -- budget survives process restarts — an in-memory counter would reset on
    -- every boot and burn the window. See lib/maruti.ts.
    CREATE TABLE IF NOT EXISTS courier_quota (
      courier TEXT PRIMARY KEY,
      window_start TEXT,   -- ISO; first call of the current window
      used INTEGER,        -- calls made since window_start
      blocked_until TEXT   -- ISO; set from a 429's retry-after
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT, finished_at TEXT, state TEXT, pages INTEGER, rows INTEGER, error TEXT
    );
  `);
  ensureColumns(db, "orders");
  // The staging table belonged to the old fetch-everything-then-swap sync. The
  // sync now upserts into `orders` in place, so staging is dead weight — and at
  // full-window scale it was a second ~1GB copy of the cache. Dropping it is
  // safe: it never held anything that wasn't a scratch copy of a portal pull.
  db.exec("DROP TABLE IF EXISTS orders_staging");
  return db;
}

// Persisted per-courier circuit breaker, sharing the courier_quota table (its
// `blocked_until` column already means exactly this for Maruti's 429s). Keys are
// prefixed so they can't collide with Maruti's own quota row.
//
// This has to be durable, not a per-sync Set: the sweep's response to a courier
// that keeps failing is to stop SELECTING its rows, and that decision must
// outlive the sync that made it. The alternative — marking the rows checked so
// the rotation moves past them — silently retires rows the courier was never
// actually asked about, which is indistinguishable from "the courier has no data".
const breakerKey = (courier: string) => `breaker:${courier.toLowerCase()}`;

/** Epoch ms until which this courier is benched, or 0 if it's available. */
export function courierBlockedUntil(courier: string): number {
  const row = getDb()
    .prepare("SELECT blocked_until FROM courier_quota WHERE courier = ?")
    .get(breakerKey(courier)) as { blocked_until: string | null } | undefined;
  const t = row?.blocked_until ? Date.parse(row.blocked_until) : 0;
  return Number.isFinite(t) ? t : 0;
}

/** Bench a courier until `untilMs`. */
export function blockCourier(courier: string, untilMs: number): void {
  getDb()
    .prepare(
      "INSERT INTO courier_quota (courier, window_start, used, blocked_until) VALUES (?, NULL, 0, ?) " +
        "ON CONFLICT(courier) DO UPDATE SET blocked_until=excluded.blocked_until"
    )
    .run(breakerKey(courier), new Date(untilMs).toISOString());
}

/** Read a durable sync watermark. */
export function getSyncState(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Write a durable sync watermark. */
export function setSyncState(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(key, value);
}

/** Singleton connection (survives Next.js dev hot-reload via globalThis). */
export function getDb(): Database.Database {
  if (!globalThis.__shipwatchDb) globalThis.__shipwatchDb = open();
  return globalThis.__shipwatchDb;
}

export const ORDER_FIELD_NAMES = [
  "id", "order_no", "marketplace_order_id", "awb", "status",
  "order_date", "dispatched_at", "pickup_date", "edd", "delivered_date",
  "last_status_updated_at", "courier_slug", "shipping_company", "shipping_method",
  "warehouse", "warehouse_id", "seller_name", "dropshipper_name",
  "customer_name", "customer_contact", "customer_city", "customer_state",
  "pincode", "payment_type", "order_total", "cod_total",
  "is_ndr", "ndr_reason", "attempt_count", "synced_at",
  "courier_live_status", "courier_live_checked_at",
] as const;

/** Columns the PORTAL owns — refreshed from every pull, safe to overwrite.
 *  Excludes `id` (the conflict key) and the courier_live_* pair, which this app
 *  owns: the portal knows nothing about them, so a row upserted from a portal
 *  page carries NULLs there and must NOT clobber a real courier result. This is
 *  what makes courier coverage survive a sync without the old
 *  carry-forward-then-swap dance. */
export const PORTAL_OWNED_COLUMNS = ORDER_FIELD_NAMES.filter(
  (c) => c !== "id" && c !== "courier_live_status" && c !== "courier_live_checked_at"
);

/** Upsert one portal row into `orders`, preserving this app's courier columns. */
export const UPSERT_ORDER_SQL = `
  INSERT INTO orders (${ORDER_FIELD_NAMES.join(", ")})
  VALUES (${ORDER_FIELD_NAMES.map((c) => `@${c}`).join(", ")})
  ON CONFLICT(id) DO UPDATE SET
    ${PORTAL_OWNED_COLUMNS.map((c) => `${c}=excluded.${c}`).join(",\n    ")}
`;

export type OrderRow = {
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
};
