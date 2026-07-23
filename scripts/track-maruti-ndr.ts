// Fill in the NDR reasons the PANEL leaves blank, using Shree Maruti's tracker.
//
// Why this exists (and why it's this narrow):
// The panel already supplies ndr_reason for ~88% of Maruti NDR orders, in the
// same vocabulary the courier uses — so tracking those adds nothing. The gap is
// the ~12% where the panel's ndr_reason is BLANK but the courier's `event` still
// names the reason (e.g. "OFFICE DELIVERY PENDING").
//
// The tracker allows only ~50 requests per ~15 HOURS; exceeding it returns 429
// with retry-after ≈54,000s and blinds the integration for the rest of the day.
// So this script:
//   • only looks up orders whose panel reason is blank (the ~82 that need it),
//   • caps each run at MAX_PER_RUN (< the quota) and spaces calls by SPACING_MS,
//   • STOPS DEAD on the first 429 rather than burning the window,
//   • is RESUMABLE: results append to data/maruti-ndr-reasons.json and already
//     resolved AWBs are skipped, so it can be re-run each window until done.
//
// Run: npx tsx scripts/track-maruti-ndr.ts
try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_PER_RUN = 45; // stay clear of the ~50 quota
const SPACING_MS = 1000; // gentle; the quota is per-window, not per-second
const FROM = "2026-06-15";
const TO = "2026-07-15";
const OUT = path.join(process.cwd(), "data", "maruti-ndr-reasons.json");

type Resolved = {
  awb: string;
  order_no: string | null;
  courier_status: string | null;
  reason: string | null;
  at: string | null;
  fetched_at: string;
};

async function main() {
  const { callTool } = await import("../lib/mcp");
  const { fetchMarutiTracking, MarutiThrottled } = await import("../lib/maruti");

  const done: Record<string, Resolved> = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, "utf8"))
    : {};
  console.log(`already resolved: ${Object.keys(done).length}`);

  // Pull NDR Maruti orders straight from the panel (no rate limit there).
  type Res = { has_more: boolean; orders: Record<string, unknown>[] };
  const orders: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const res = await callTool<Res>("list_orders", {
      courier_slug: "maruti",
      is_ndr: true,
      from: FROM,
      to: TO,
      limit: 500,
      offset,
    });
    orders.push(...res.orders);
    if (!res.has_more) break;
    offset += 500;
  }

  const blank = orders.filter((o) => {
    const r = o.ndr_reason;
    return (r === null || r === undefined || String(r).trim() === "") && o.awb;
  });
  const todo = blank.filter((o) => !done[String(o.awb)]);

  console.log(`NDR orders: ${orders.length}`);
  console.log(`blank panel reason: ${blank.length}`);
  console.log(`remaining to fetch: ${todo.length}`);
  if (todo.length === 0) {
    console.log("nothing to do — every blank reason is filled.");
    return;
  }

  const batch = todo.slice(0, MAX_PER_RUN);
  console.log(`fetching ${batch.length} this run (cap ${MAX_PER_RUN}, ${SPACING_MS}ms apart)…\n`);

  let ok = 0;
  let filled = 0;
  for (const o of batch) {
    const awb = String(o.awb);
    try {
      const r = await fetchMarutiTracking(awb);
      ok++;
      const rec: Resolved = {
        awb,
        order_no: (o.order_no as string) ?? null,
        courier_status: (r.last_status as string) ?? null,
        reason: (r.reason as string) ?? null,
        at: (r.current_timestamp as string) ?? null,
        fetched_at: new Date().toISOString(),
      };
      done[awb] = rec;
      if (rec.reason) filled++;
      console.log(`  ${awb}  ${rec.courier_status ?? "-"}  reason=${rec.reason ?? "(none)"}`);
    } catch (e) {
      if (e instanceof MarutiThrottled) {
        const h = e.retryAfterSeconds ? (e.retryAfterSeconds / 3600).toFixed(1) : "?";
        console.log(`\n429 — quota exhausted. Stopping. Retry in ~${h}h.`);
        break;
      }
      console.log(`  ${awb}  ERROR: ${(e as Error).message.slice(0, 90)}`);
    }
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }

  writeFileSync(OUT, JSON.stringify(done, null, 2));
  console.log(`\n${ok} fetched, ${filled} with a reason. total resolved: ${Object.keys(done).length}`);
  console.log(`-> ${OUT}`);
  const left = blank.length - Object.keys(done).length;
  if (left > 0) console.log(`${left} still pending — re-run after the quota window resets (~15h).`);
}

main().then(() => process.exit(0));
