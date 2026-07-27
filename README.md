# ShipWatch — TAT Breach & NDR Monitor

ShipWatch is an internal logistics dashboard that syncs order data from the Ship
MCP service into a local SQLite cache. It helps operations teams identify:

1. **TAT breaches** — orders whose EDD has passed and that are still undelivered.
2. **NDR orders** — orders whose current status is NDR.

The dashboard provides KPI cards, filters, courier-level summaries, sortable and
paginated tables, Excel exports, and live courier-status comparisons. All date
calculations use IST (`Asia/Kolkata`) calendar dates.

## Requirements

- Node.js 20 or newer
- npm
- A Ship MCP endpoint and token
- Courier credentials for direct live tracking (optional)

## Setup

```bash
npm install
cp .env.example .env.local
npm run smoke
npm run dev
```

Add the real `SHIP_MCP_URL` and credentials to `.env.local`, then open
[http://localhost:3000](http://localhost:3000).

The SQLite cache is stored at `data/shipwatch.db` and is excluded from Git.
Courier credentials can be supplied through environment variables or through
`shipping_courier_credentials.csv`; environment variables take precedence.

## Commands

```bash
npm run dev          # Start the development server
npm run build        # Create a production build
npm start            # Start the production server
npm run smoke        # Verify Ship MCP connectivity
npm run dtdc:health  # Check DTDC tracking credentials
```

## Automatic sync

The server-side scheduler in `lib/scheduler.ts` is the sole sync driver. By
default, it starts shortly after the server boots and begins another sync about
five minutes after the previous run finishes. The UI displays sync progress and
automatically refreshes after a completed run.

Each cycle:

1. Pulls recently created or changed orders with an overlap window.
2. Backfills older dates, one day at a time, until the rolling window is full.
3. Removes rows that have moved outside the rolling window.
4. Refreshes live courier statuses within the configured limits.
5. Refreshes cached KPI aggregates.

Orders are upserted page by page, so a failed sync leaves the existing cache
available instead of replacing it with an incomplete result. The default rolling
window is 180 days. A cold cache fills across multiple cycles, newest dates first.

Important tuning options are documented in `.env.example`, including:

- `WINDOW_DAYS`
- `BACKFILL_BUDGET_MS`
- `INCREMENTAL_OVERLAP_DAYS`
- `MCP_CONCURRENCY`
- `BACKGROUND_SYNC_GAP_MS`
- `LIVE_TRACK_MAX`
- `LIVE_TRACK_BUDGET_MS`
- `LIVE_TRACK_CONCURRENCY`

Run only one application process unless duplicate sync loops are intentional; the
single-sync guard applies per process.

## Business definitions

`lib/definitions.ts` is the source of truth.

- **TAT breach:** EDD is set, EDD is before today in IST, and the order is not
  delivered, cancelled, or in an RTO status.
- **Days past EDD:** calendar days between the EDD and today in IST.
- **Severity:** 1–2 days amber, 3–5 orange, 6–10 red, and more than 10 deep red.
- An NDR order that is past its EDD may appear in both lists.

## Filters and exports

The dashboard supports courier, search, payment, state, status, pincode, date,
severity, NDR reason, and minimum-attempt filters where applicable.

**Export Excel** includes all matching rows, not only the visible page, and
preserves the active filters and sorting:

- Both lists: `ShipWatch_TAT+NDR_YYYY-MM-DD.xlsx`
- TAT breaches: `ShipWatch_TAT_Breach_YYYY-MM-DD.xlsx`
- NDR orders: `ShipWatch_NDR_YYYY-MM-DD.xlsx`

## Live courier tracking

Opening an order shows a comparison between the status reported by the courier
and the status stored in the shipping panel. A mismatch indicator appears when
the two sources disagree.

Direct integrations currently exist for:

- Amazon ATS
- Blue Dart
- Delhivery
- DTDC
- Ekart
- Shiprocket
- Shree Anjani
- Shree Maruti
- Trackon

When a direct integration is unavailable or cannot resolve an AWB, ShipWatch
falls back to the shipping-panel MCP status. Live results are retained across
syncs, and rate limits, request spacing, timeouts, and courier-specific quotas
are controlled through `.env.local`.

## Project structure

```text
app/          Next.js pages and API routes
components/   Dashboard UI
lib/          Sync, database, queries, exports, and courier clients
scripts/      Connectivity and health-check scripts
tests/        Automated tests
design/       Design reference files
data/         Local SQLite data
```

## Security notes

- The Ship MCP integration is read-only; ShipWatch does not modify panel data.
- Never commit `.env.local`, the SQLite database, or courier credential files.
- Treat `shipping_courier_credentials.csv` as sensitive plaintext.
