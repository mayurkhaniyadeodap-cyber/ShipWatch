# ShipWatch — TAT Breach & NDR Monitor

Internal logistics portal that syncs order data from the Ship MCP server into a
local SQLite cache and shows three lists over the last **6 months**
(`WINDOW_DAYS`, 180d ≈ 957k orders ≈ 1.2GB):

1. **TAT Breach** — orders whose EDD has passed but are still NOT delivered
   (pending only; delivered-late orders are excluded).
2. **NDR Orders** — orders whose *current* status is `NDR`.
3. **Delivered Late** — orders delivered *after* their EDD.

Every order in the window is cached regardless of status, so all three lists are
just queries over the same rows — there is no per-list fetch to keep in step.

All date math is done on IST (Asia/Kolkata) calendar dates.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in the real SHIP_MCP_URL (with mcp_token)
npm run smoke                # verifies live MCP connectivity
npm run dev                  # http://localhost:3000
```

The SQLite cache lives at `data/shipwatch.db` (gitignored).

## Sync

- Sync is **fully automatic**: a server-side scheduler ([lib/scheduler.ts](lib/scheduler.ts))
  is the sole driver, re-syncing ~5 min (`BACKGROUND_SYNC_GAP_MS`) after each run
  finishes. There are no manual sync controls in the UI — the header just shows
  the last-synced time and a live "Updating…" indicator. The dashboard's data
  auto-refreshes when a sync completes.
- Only one sync runs at a time — but note the guard is per-process, so two dev
  servers means two sync loops hitting the portal. Run one.
- Sync is **incremental**. Each cycle:
  1. **Incremental** — orders whose `updated_at` changed in the last
     `INCREMENTAL_OVERLAP_DAYS` (~33k/day). This is the steady state.
  2. **Backfill** — walks history backwards one day at a time toward the window
     edge, bounded by `BACKFILL_BUDGET_MS`. A no-op once the window is full.
  3. **Prune** — drops orders that rolled out of the window.
  4. **Live track** / 5. **KPI aggregates** — as before, each on its own budget.
- Rows are **upserted by id** as each page arrives. There's no staging table and
  no whole-window snapshot in memory (~957k rows would need ~1-2GB of heap), and
  a failed sync can't wipe the cache — it just leaves rows stale. `courier_live_*`
  columns are owned by this app and are never touched by a portal upsert.
- The backfill slices **by day**, not by offset: the portal returns newest-first,
  so paging deep into one huge query would drift as new orders arrive at the front.
  The cursor only advances when a day completes, so it resumes cleanly.
- A **cold start takes ~18 cycles** (~a few hours) to fill 180 days. The most
  recent days land first, so the lists are useful immediately and history fills in
  behind them. Raise `BACKFILL_BUDGET_MS` to go faster.

## Export

**Export Excel** (header) — three options, all respecting the current filters
and sort, including ALL matching rows (not just the visible page):

- Both lists → `ShipWatch_TAT+NDR_YYYY-MM-DD.xlsx` (2 sheets)
- TAT Breach only → `ShipWatch_TAT_Breach_YYYY-MM-DD.xlsx`
- NDR only → `ShipWatch_NDR_YYYY-MM-DD.xlsx`

## Business definitions

See [lib/definitions.ts](lib/definitions.ts) — single source of truth:

- **TAT breach** = `edd` set AND `date(edd) < today(IST)` AND status not in
  `Delivered/Cancelled/RTO*`.
- `days_past_edd` = calendar days past EDD (computed at query time).
- Severity: 1–2 amber · 3–5 orange · 6–10 red · 10+ deep red.
- An order can appear in both lists (NDR order past its EDD) — intentional.

## Live courier tracking

Clicking an order opens a drawer with a **Courier site vs Shipping panel**
comparison table — the left column is fetched live from the courier's own
tracking API, the right column is the synced panel record. A **Mismatch** badge
appears when the two disagree on status.

**On Sync**, after the panel pull, the sync also fetches live status directly
from the courier sites for every synced order with an AWB and a supported
courier, storing it in the `courier_live_status` column shown as **Courier
status** in the table (amber when it disagrees with the panel status). This is a
call-per-order phase and makes sync take much longer — tune or disable it via
`LIVE_TRACK_ON_SYNC` / `LIVE_TRACK_MAX` / `LIVE_TRACK_CONCURRENCY` (see
`.env.example`). Progress shows as a "Courier live status — N/total" phase in the
Sync button.

Credentials come from `shipping_courier_credentials.csv` in the project root
(gitignored — plaintext secrets). Each courier client reads its env vars first,
then falls back to the CSV, so the CSV alone is enough to enable tracking:

- **DTDC / Delhivery** — every account's key is tried until the AWB resolves.
- **Trackon** — uses the CSV's Trackon login.
- **Shiprocket** — the CSV's email/password are exchanged for a bearer token
  (cached 24h); a static `SHIPROCKET_API_TOKEN` still takes precedence.
- **Anjani** — env-only (not in the CSV).

Couriers without a direct integration yet — **BlueDart, Amazon ATS, Ekart,
Shree Maruti, Rapid Miles** — fall back to the shipping panel for both columns.
Each needs provider-specific auth (SOAP/JWT, SP-API OAuth, …) to add.

## Notes

- The Ship MCP server is read-only reporting; this tool never writes to it.
- Design reference: `design/` (Claude Design export + extracted HTML).
