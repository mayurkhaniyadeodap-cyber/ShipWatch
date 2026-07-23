# PROMPT 2 — Claude Code MASTER PROMPT (tool build karne ke liye)

**How to use:** Design ready hone ke baad — ek naya empty project folder banao, usme `design/` folder me Claude Design ka export (screenshots / HTML) daalo, phir Claude Code kholo aur neeche ka pura prompt paste karo. Agar Ship MCP ko token chahiye hoga to Claude Code aapse poochhega (`SHIP_MCP_TOKEN`).

---

You are building an internal logistics web tool from scratch in this empty folder. Work step by step, verify against the live data source early (§11), and match the attached design.

## 1. Goal

Build **"ShipWatch — TAT Breach & NDR Monitor"** — a local web portal that syncs order data from our "Ship" MCP server and shows TWO separate lists with courier-wise filtering and Excel export:

1. **TAT Breach list** — orders whose EDD (promised delivery date) has already passed but which are still NOT delivered (pending orders only — do NOT include orders that were delivered late).
2. **NDR list** — orders whose **current** status is `NDR`.

Window: last **90 days**. A **Sync Now** button pulls the latest data into a local cache. Every order row must show **how many days the TAT is breached** (days past EDD). All "today"/date math in **IST (Asia/Kolkata)**.

A design reference from Claude Design is in `./design/` — match it faithfully (layout, colors, states, components). If the folder is missing, follow §8.

## 2. Tech stack

- Next.js (latest, App Router, TypeScript), single app on `localhost:3000`
- SQLite cache via `better-sqlite3`, DB file `./data/shipwatch.db` (gitignored)
- MCP client: `@modelcontextprotocol/sdk` with the Streamable HTTP transport — check the SDK's current README/docs for the exact client API; do not guess method names
- `exceljs` for Excel export; `@tanstack/react-table` + `@tanstack/react-query`; Tailwind CSS; `date-fns` + `date-fns-tz`
- `.env.local`: `SHIP_MCP_URL=https://ship.deodap.in/mcp` and `SHIP_MCP_TOKEN=` (optional bearer token). Also create `.env.example` and a short README (setup, sync, export).

## 3. Data source — Ship MCP server (verified contracts)

Endpoint: `https://ship.deodap.in/mcp` (MCP over Streamable HTTP). Before building on it, call `tools/list` and confirm these tools exist — note the server tool names have **no "Ship:" prefix** (that prefix is only a client-side connector namespace):

- `list_orders`, `sla_performance`, `ndr_analysis`, `courier_performance`

If auth fails (401/403), stop and ask me for the token; never hardcode secrets. If the SDK misbehaves, fall back to raw JSON-RPC 2.0 POSTs (`initialize` → `notifications/initialized` → `tools/call`) with headers `Content-Type: application/json` and `Accept: application/json, text/event-stream`, preserving any `Mcp-Session-Id` response header on subsequent calls; responses may arrive as SSE — parse the `data:` lines.

### 3.1 `list_orders` (row-level, paginated) — the main tool

Params (all optional):
- `from` ("YYYY-MM-DD", default 7 days ago) · `to` (inclusive, default today)
- `date_field` — which date column `from`/`to` filters and sorts on: `order_date` (default), `delivered_date`, `dispatched_at`, `pickup_date`, `edd`, `ship_order_requested_at`, `last_status_updated_at`, `reconciliation_at`, `created_at`, `updated_at`
- `status` (exact, e.g. `"Delivered"`, `"RTO"`, `"InTransit"`, `"NDR"`, `"Cancelled"`) · `is_ndr` (bool)
- `courier_slug` (e.g. `"bluedart"`, `"dtdc"`) · `shipping_company_id` · `payment_type` (`"COD"`|`"Prepaid"`) · `customer_state` (partial) · `warehouse_id` · `seller_name`
- `search` (free text over order_no, order_ref_id, marketplace_order_id, customer_name, customer_contact)
- `limit` (1–500, default 50) · `offset` (default 0)

Response envelope:

```json
{ "range": {"from":"...","to":"..."}, "date_field": "order_date",
  "total_matched": 38318, "returned": 500, "limit": 500, "offset": 0,
  "has_more": true, "orders": [ ... ] }
```

Each order — real sample values shown. Keep ONLY these fields; the response also contains a huge `rate_summary` object — DROP it, do not store it:

```json
{ "id": 3919162, "order_no": "262467787", "order_ref_id": null,
  "marketplace_order_id": "7486453055798", "awb": "26022370040451", "rt_awb": null,
  "status": "ReadyToShip",
  "order_date": "2026-07-07 23:59:20", "pickup_date": "", "dispatched_at": "",
  "edd": "", "delivered_date": "", "last_status_updated_at": "",
  "courier_slug": "maruti", "shipping_company": "Shree Maruti",
  "shipping_method": "Maruti Surface",
  "warehouse": "Dabster International Pvt. Ltd.", "warehouse_id": 8,
  "seller_name": "DeoDap.in", "dropshipper_name": null,
  "customer_name": "Mihir amin", "customer_contact": "9104062402",
  "customer_city": "AHMEDABAD", "customer_state": "Gujarat", "pincode": "380024",
  "payment_type": "Prepaid", "order_total": 213, "cod_total": 0,
  "is_ndr": false, "ndr_reason": null, "attempt_count": 0 }
```

⚠ Date fields are strings `"YYYY-MM-DD HH:mm:ss"` or `""` (empty string = null). Parse defensively; store empty strings as NULL.

Known statuses seen in real data: `ReadyToShip`, `InTransit`, `OutForDelivery`, `NDR`, `Delivered`, `RTO`, `RTO-Delivered`, `Cancelled` — there may be more, so keep the undelivered-status list configurable (§5).

Known couriers (slug → display via `shipping_company`): blue_dart/bluedart → Bluedart, dtdc → DTDC, trackon → Trackon, maruti → Shree Maruti, amazon_ats → Amazon ATS, ekart → Ekart, ship_rocket → ShipRocket, delhivery → Delhivery. Use `shipping_company` for display and filtering.

### 3.2 Aggregate tools (for KPI cache)

- `sla_performance {from, to, date_field?, warehouse_id?}` → `{ delivered, on_time, late, on_time_pct, avg_delay_days, overdue_in_transit }`
- `ndr_analysis {from, to, ...}` → `{ ndr_orders, avg_attempts, by_reason:[{value,count}], by_courier:[{value,count}], resolution:[{value,count}] }`
- `courier_performance {from, to, ...}` → per-courier delivery rate / RTO rate / NDR count / avg delivery days (verify exact field names with one live call and adapt)

## 4. Business definitions (single source of truth — implement in `lib/definitions.ts`)

- `todayIST` = current calendar date in Asia/Kolkata.
- **TAT Breach row** = `edd` is non-null AND `date(edd) < todayIST` AND `status NOT IN ('Delivered','Cancelled')` AND `status NOT LIKE 'RTO%'`.
- `days_past_edd = differenceInCalendarDays(todayIST, date(edd))` — integer ≥ 1, always computed at query time (never stored stale).
- Severity buckets for `days_past_edd`: **1–2 amber · 3–5 orange · 6–10 red · 10+ deep red**.
- **NDR row** = `status = 'NDR'` (current status only). Extra computed columns: `days_since_last_update` (from `last_status_updated_at`) and `days_past_edd` when EDD present.
- An order CAN appear in both lists (an NDR order past its EDD) — that is correct behaviour.
- 90-day scope rule (deliberate): TAT list covers orders whose EDD falls within the last 90 days; NDR list covers NDR orders with `order_date` in the last 90 days.

## 5. Sync engine

`POST /api/sync` starts a background job (in-process singleton; reject with 409 if already running). `GET /api/sync/status` → `{ state:'idle'|'running'|'error', phase, page, rows_done, started_at, last_synced_at, error }`. Frontend polls every 2s while running.

Job phases (each paginates `limit:500`, `offset += 500` while `has_more === true`):

1. **TAT candidates** — for each `status` in `UNDELIVERED_STATUSES = ['InTransit','OutForDelivery','NDR']` (config array in `lib/config.ts`; extend if new undelivered statuses are discovered): call `list_orders({ status, date_field:'edd', from: todayIST−90d, to: todayIST−1d, limit:500, offset })`. Using `date_field:'edd'` makes the range apply to the EDD column, so the server directly returns the "EDD already passed" set — cheap and exact.
2. **Current NDR** — `list_orders({ status:'NDR', date_field:'order_date', from: todayIST−90d, to: todayIST, limit:500, offset })`.
3. **KPI cache** — call `sla_performance`, `ndr_analysis`, `courier_performance` with `{ from: todayIST−90d, to: todayIST }` and store the raw JSON in `kpi_cache`.

Rules:
- Dedupe by `id` (NDR orders will arrive in both phases).
- Write everything to `orders_staging`, then in ONE transaction swap into `orders` (delete + insert), so the UI never sees half-synced data. On any final failure: abort, keep old data, set `state:'error'` with a human-readable message.
- Max 2 concurrent MCP calls with ~250ms spacing; retry each failed page 3× with exponential backoff; 30s timeout per call.
- Log every run in `sync_log`. Auto-trigger a sync on first run when `orders` is empty. Safety cap 400 pages/phase (warn if hit). `total_matched` may drift during pagination (live data) — just loop on `has_more`.

## 6. SQLite schema

```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY, order_no TEXT, marketplace_order_id TEXT, awb TEXT, status TEXT,
  order_date TEXT, dispatched_at TEXT, pickup_date TEXT, edd TEXT, delivered_date TEXT,
  last_status_updated_at TEXT, courier_slug TEXT, shipping_company TEXT, shipping_method TEXT,
  warehouse TEXT, warehouse_id INTEGER, seller_name TEXT, dropshipper_name TEXT,
  customer_name TEXT, customer_contact TEXT, customer_city TEXT, customer_state TEXT,
  pincode TEXT, payment_type TEXT, order_total REAL, cod_total REAL,
  is_ndr INTEGER, ndr_reason TEXT, attempt_count INTEGER, synced_at TEXT
);
CREATE INDEX idx_orders_company ON orders(shipping_company);
CREATE INDEX idx_orders_status  ON orders(status);
CREATE INDEX idx_orders_edd     ON orders(edd);
-- plus: orders_staging (same shape), kpi_cache(key TEXT PRIMARY KEY, json TEXT, updated_at TEXT),
-- sync_log(id, started_at, finished_at, state, pages, rows, error)
```

## 7. API routes (JSON)

- `GET /api/tat` and `GET /api/ndr` — shared params: `couriers` (comma list of shipping_company), `search`, `payment`, `state`, `sort`, `dir`, `page`, `pageSize` (50/100/200). TAT extra: `severity` (`1-2|3-5|6-10|10+`). NDR extra: `reason`, `minAttempts`. Response: `{ rows, total, byCourier:[{courier,count}], appliedFilters }`. Default sort: TAT → `days_past_edd DESC`; NDR → `attempt_count DESC, order_date ASC`.
- `GET /api/kpis?tab=tat|ndr` — TAT: breached count, stuck value ₹ (sum order_total), avg days_past_edd, worst courier. NDR: count, avg attempts, top reason, COD share %. Compute from cached rows; use `kpi_cache` for extra context.
- `GET /api/meta` — courier options with counts per tab, states, NDR reasons, `last_synced_at`.
- `POST /api/sync`, `GET /api/sync/status` (§5).
- `GET /api/export?scope=both|tat|ndr` + the SAME filter params as above → streams the `.xlsx`.

## 8. Frontend (match `./design/`)

Header: app title; "Last synced X min ago · N orders"; **Sync Now** (shows live phase/page while running); **Export Excel** split-button with exactly 3 options: "Both lists (1 file, 2 sheets)", "TAT Breach only", "NDR only". KPI card row (4 cards per active tab). Tabs with live counts. Filter bar: courier multi-select with counts, debounced search, severity chips (TAT) / NDR-reason dropdown + min-attempts (NDR), COD/Prepaid toggle, state dropdown, clear-all. Clickable courier chip strip (chip click = filter). Dense sortable table with sticky header, tabular numerals, `days_past_edd` as a colored badge per §4, `ndr_reason` truncated with tooltip. Row click → right-side drawer with all fields + "Copy AWB". Pagination footer. States: loading skeleton, syncing (dimmed table + progress), error banner with retry, empty state. Desktop-first; must stay usable at 1280px.

## 9. Excel export (exceljs)

- `scope=both` → one workbook with two sheets: **"TAT Breach"** and **"NDR Orders"**. `scope=tat|ndr` → single-sheet file.
- Must respect the CURRENT filters and sort, and include ALL matching rows (not just the visible page).
- Formatting: bold white-on-dark header row, freeze row 1, autoFilter on, sensible column widths, dates `dd-mm-yyyy`, order value `₹ #,##0`, `Days Past EDD` cells conditionally filled per §4 severity colors, and an info row above the header: `Generated 08-Jul-2026 14:32 IST · Filters: Courier=Bluedart, Severity=6-10`.
- Filenames: `ShipWatch_TAT+NDR_YYYY-MM-DD.xlsx`, `ShipWatch_TAT_Breach_YYYY-MM-DD.xlsx`, `ShipWatch_NDR_YYYY-MM-DD.xlsx`.
- Columns — TAT sheet: Sr, Order No, AWB, Order Date, Dispatched At, EDD, Days Past EDD, Status, Courier, Shipping Method, Customer, Contact, City, State, Pincode, Payment, Order Value, NDR Reason, Attempts, Warehouse, Seller. NDR sheet: Sr, Order No, AWB, Order Date, NDR Reason, Attempts, Days Since Last Update, EDD, Days Past EDD, Courier, Customer, Contact, City, State, Pincode, Payment, Order Value, Warehouse, Seller.

## 10. Edge cases

- `""` dates → NULL everywhere; NULL-EDD rows can never be TAT rows; never crash on missing dates.
- All day-diff math on IST calendar dates, not raw timestamps.
- If the live server's tool names or params differ from §3, adapt from `tools/list` output and tell me what changed.
- The MCP is read-only reporting — this tool must never attempt writes.

## 11. Build order + verification

1. Scaffold app, env, DB module, MCP client module.
2. Write `scripts/smoke.ts`: connect → `tools/list` → `list_orders {limit:2}` → print result. **Run it and show me the output before building further** (ask me for `SHIP_MCP_TOKEN` if you get 401/403).
3. Sync engine + status polling. 4. API routes. 5. UI per design. 6. Excel export.
7. Acceptance checklist — verify each item and show evidence:
   - First run auto-syncs with visible progress; "Last synced" updates after
   - TAT tab shows only EDD-passed & undelivered orders; hand-check `days_past_edd` on 3 rows
   - NDR tab shows only current status `NDR`
   - Courier filter + search + severity/reason filters work on both tabs AND in exports
   - All 3 Excel options download and open cleanly (colors, ₹ format, dates, filters respected)
   - Re-sync drops orders that got delivered in the meantime
   - Wrong/missing token → clear error UI, no crash
   - `npm run build` passes

Out of scope for v1: login/auth, order actions or edits, mobile app.
