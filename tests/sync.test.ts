import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBackfillPhase, interleaveByCourier, isoDayMinus, mapOrder } from "../lib/sync";

describe("isoDayMinus", () => {
  it("walks back across month, year and leap-day boundaries", () => {
    assert.equal(isoDayMinus("2026-07-15", 1), "2026-07-14");
    assert.equal(isoDayMinus("2026-07-15", 180), "2026-01-16");
    // Month boundary — the backfill crosses one of these every ~30 slices.
    assert.equal(isoDayMinus("2026-03-01", 1), "2026-02-28");
    // Year boundary.
    assert.equal(isoDayMinus("2026-01-01", 1), "2025-12-31");
    // Leap day: 2024 was a leap year, so Mar 1 - 1 = Feb 29.
    assert.equal(isoDayMinus("2024-03-01", 1), "2024-02-29");
    assert.equal(isoDayMinus("2026-07-15", 0), "2026-07-15");
  });
});

describe("buildBackfillPhase", () => {
  it("fetches exactly one day, filtered on order_date", () => {
    const phase = buildBackfillPhase("2026-04-02");

    // A backfill slice must be a single closed day: the portal returns
    // newest-first, so slicing by day (rather than paging deep by offset over
    // the whole window) is what keeps the cursor from drifting as new orders
    // arrive at the front.
    assert.equal(phase.params.from, "2026-04-02");
    assert.equal(phase.params.to, "2026-04-02");
    assert.equal(phase.params.date_field, "order_date");
    assert.ok(phase.label.includes("2026-04-02"));
    // No status filter — the window caches every order, not just the list tabs.
    assert.equal(phase.params.status, undefined);
  });
});

describe("interleaveByCourier", () => {
  const rows = (spec: string): Record<string, unknown>[] =>
    spec.split(",").map((shipping_company, i) => ({ id: i, shipping_company }));
  const names = (rs: Record<string, unknown>[]) => rs.map((r) => r.shipping_company).join(",");
  const ids = (rs: Record<string, unknown>[]) => rs.map((r) => r.id as number);

  it("round-robins couriers so their rate gates overlap", () => {
    // A batch that is mostly one courier — the realistic shape once the sweep is
    // priority-ordered, since TAT breaches skew to the highest-volume courier.
    assert.equal(names(interleaveByCourier(rows("DTDC,DTDC,DTDC,Trackon"))), "DTDC,Trackon,DTDC,DTDC");
  });

  it("keeps every row exactly once on ragged groups", () => {
    // The uneven case is where an interleave usually drops or duplicates rows.
    const input = rows("A,A,A,A,A,B,C,C");
    const out = interleaveByCourier(input);
    assert.equal(out.length, input.length);
    assert.deepEqual(ids(out).sort((x, y) => x - y), ids(input));
    assert.equal(names(out), "A,B,C,A,C,A,A,A");
  });

  it("handles an empty batch and a single courier", () => {
    assert.deepEqual(interleaveByCourier([]), []);
    assert.equal(names(interleaveByCourier(rows("A,A,A"))), "A,A,A");
  });
});

describe("mapOrder", () => {
  it("accepts numeric-string ids and alternate portal AWB/order fields", () => {
    const row = mapOrder({
      id: "98765",
      order_id: "ORD-9001",
      awb_no: "AWB-9001",
      status: "InTransit",
      order_date: "2026-01-01",
    });

    assert.ok(row);
    assert.equal(row?.id, 98765);
    assert.equal(row?.order_no, "ORD-9001");
    assert.equal(row?.awb, "AWB-9001");
  });
});
