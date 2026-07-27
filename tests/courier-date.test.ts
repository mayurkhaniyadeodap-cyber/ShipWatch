import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fmtCourierDate } from "../frontend/client";

// One case per shape a real integration sends, so adding a courier that reuses
// any of them is covered, and a courier that doesn't fails loudly here first.
describe("fmtCourierDate — the shapes our couriers actually send", () => {
  it("Trackon: compact DDMMYYYY with a separate clock", () => {
    // The drawer bug: "25072026 08:39" sat unformatted next to the panel's "25 Jul 2026".
    assert.equal(fmtCourierDate("25072026 08:39"), "25 Jul 2026 08:39");
    assert.equal(fmtCourierDate("25072026"), "25 Jul 2026");
    assert.equal(fmtCourierDate("01012026"), "1 Jan 2026");
  });

  it("BlueDart: month name with a compact HHMM clock", () => {
    assert.equal(fmtCourierDate("25-Jul-2026 0839"), "25 Jul 2026 08:39");
    assert.equal(fmtCourierDate("25 July 2026"), "25 Jul 2026");
  });

  it("Delhivery: ISO with an explicit offset", () => {
    assert.equal(fmtCourierDate("2026-07-25T08:39:12.000+05:30"), "25 Jul 2026 08:39");
  });

  it("Maruti / Ekart / Amazon ATS: dd/mm/yyyy hh:mm", () => {
    assert.equal(fmtCourierDate("25/07/2026 08:39"), "25 Jul 2026 08:39");
  });

  it("SQL-ish and bare ISO dates", () => {
    assert.equal(fmtCourierDate("2026-07-25 08:39:12"), "25 Jul 2026 08:39");
    assert.equal(fmtCourierDate("2026-07-25"), "25 Jul 2026");
  });
});

describe("fmtCourierDate — format detection", () => {
  it("normalises a UTC instant to IST rather than printing the UTC clock", () => {
    // 03:09Z is 08:39 IST — the panel column is IST, so both sides must be.
    assert.equal(fmtCourierDate("2026-07-25T03:09:00Z"), "25 Jul 2026 08:39");
  });

  it("reads epoch seconds and millis as IST", () => {
    assert.equal(fmtCourierDate("1784948940"), "25 Jul 2026 08:39");
    assert.equal(fmtCourierDate("1784948940000"), "25 Jul 2026 08:39");
  });

  it("tells DDMMYYYY from YYYYMMDD by which end holds a real year", () => {
    assert.equal(fmtCourierDate("20260725"), "25 Jul 2026");
    assert.equal(fmtCourierDate("25072026"), "25 Jul 2026");
    assert.equal(fmtCourierDate("202607250839"), "25 Jul 2026 08:39");
  });

  it("flips to month-first only when the numbers force it", () => {
    // 25 can't be a month, so this is mm/dd/yyyy.
    assert.equal(fmtCourierDate("07/25/2026"), "25 Jul 2026");
    // Genuinely ambiguous — Indian couriers are day-first.
    assert.equal(fmtCourierDate("05/07/2026"), "5 Jul 2026");
  });

  it("accepts assorted separators and 2-digit years", () => {
    assert.equal(fmtCourierDate("25.07.2026"), "25 Jul 2026");
    assert.equal(fmtCourierDate("25-7-26"), "25 Jul 2026");
    assert.equal(fmtCourierDate("Jul 25, 2026"), "25 Jul 2026");
  });
});

describe("fmtCourierDate — refuses to invent a date", () => {
  it("shows an unrecognised string verbatim instead of guessing", () => {
    // A wrong date in the mismatch table is worse than an unformatted one.
    assert.equal(fmtCourierDate("Reached At Destination"), "Reached At Destination");
    assert.equal(fmtCourierDate("sometime tuesday"), "sometime tuesday");
  });

  it("rejects impossible dates rather than rolling them over", () => {
    // 32 July and month 13 must not silently become 1 Aug / Jan next year.
    assert.equal(fmtCourierDate("32072026"), "32072026");
    assert.equal(fmtCourierDate("13/13/2026"), "13/13/2026");
    assert.equal(fmtCourierDate("31/02/2026"), "31/02/2026");
    assert.equal(fmtCourierDate("25:99"), "25:99");
  });

  it("treats courier placeholder text as absence", () => {
    for (const empty of [null, undefined, "", "   ", "NULL", "null", "N/A", "-", "0"]) {
      assert.equal(fmtCourierDate(empty), "—", `expected em-dash for ${JSON.stringify(empty)}`);
    }
  });
});
