// Courier-side delivery-ATTEMPT counting.
//
// The shipping panel's own `attempt_count` is unreliable — it comes back capped/
// overflowed at 127 (a signed-byte max) for a couple hundred orders, so a parcel
// with one real failed delivery can read as "127 attempts". The courier's own
// scan history is the ground truth: every failed delivery leaves a distinct
// "Not Delivered" scan, so counting those scans reconstructs the real number.
//
// We count FAILED delivery attempts only (per the product decision): each scan
// the courier classifies as an NDR / not-delivered event is one failed attempt.
// This matches what the panel's "Attempts" column is meant to mean, so the two
// numbers are directly comparable. A successful final delivery is NOT counted.
//
// Each courier exposes its scans differently, so classification is per-courier.
// Where a courier client already has a status normalizer (Trackon, Maruti, Ekart,
// Amazon), we reuse it verbatim so this never drifts from the client's own view
// of what an NDR scan is. Where it doesn't (DTDC codes, BlueDart/Anjani/Shiprocket
// free text), we classify here against the courier's documented vocabulary.
//
// Returns:
//   number  — the count of failed-delivery scans (may be 0: scans exist, none failed)
//   null    — no basis to count (courier returned no scan history)

import { normalizeTrackonStatus } from "@/interface/couriers/trackon";
import { normalizeMarutiStatus } from "@/interface/couriers/maruti";
import { normalizeEkartStatus } from "@/interface/couriers/ekart";
import { normalizeAmazonStatus } from "@/interface/couriers/amazon-ats";

type Scan = Record<string, unknown>;

function scans(res: Record<string, unknown>): Scan[] | null {
  const s = res.scans;
  return Array.isArray(s) && s.length > 0 ? (s as Scan[]) : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Count scans matching a per-scan "is this a failed delivery" predicate. */
function count(res: Record<string, unknown>, isFailed: (s: Scan) => boolean): number | null {
  const list = scans(res);
  if (!list) return null;
  return list.reduce((n, s) => n + (isFailed(s) ? 1 : 0), 0);
}

// A generic free-text "failed delivery" matcher for couriers with no status code
// — deliberately narrow so in-transit / out-for-delivery / RTO scans don't count.
const FAILED_TEXT_RE = /undeliver|not\s*deliver|non[-\s]?delivery|delivery\s*(attempt|fail)|\bndr\b/i;

// ---- per-courier counters ------------------------------------------------

/** DTDC: each failed delivery is a scan with strCode "NONDLV" (Not Delivered). */
export function dtdcAttempts(res: Record<string, unknown>): number | null {
  return count(res, (s) => str(s.strCode)?.toUpperCase() === "NONDLV");
}

/** Trackon: reuse the client's TRACKING_CODE → status map; an NDR code per fail. */
export function trackonAttempts(res: Record<string, unknown>): number | null {
  return count(
    res,
    (s) => normalizeTrackonStatus(str(s.TRACKING_CODE), str(s.CURRENT_STATUS)) === "NDR"
  );
}

/** Shree Maruti: reuse the client's status-code map; "undelivered" → NDR. */
export function marutiAttempts(res: Record<string, unknown>): number | null {
  return count(res, (s) => normalizeMarutiStatus(str(s.status)) === "NDR");
}

/** Ekart: reuse the client's free-text normalizer over statusDetails. */
export function ekartAttempts(res: Record<string, unknown>): number | null {
  return count(res, (s) => normalizeEkartStatus(str(s.statusDetails)) === "NDR");
}

/** Amazon ATS: reuse the client's normalizer over eventDescription/eventCode. */
export function amazonAtsAttempts(res: Record<string, unknown>): number | null {
  return count(
    res,
    (s) => normalizeAmazonStatus(str(s.eventDescription) ?? str(s.eventCode)) === "NDR"
  );
}

/** BlueDart: scan_type "UD" is undelivered; else fall back to the scan text. */
export function bluedartAttempts(res: Record<string, unknown>): number | null {
  return count(res, (s) => {
    if (str(s.scan_type)?.toUpperCase() === "UD") return true;
    const text = str(s.scan);
    return text ? FAILED_TEXT_RE.test(text) : false;
  });
}

/** Anjani: classify each scan's status_name text. */
export function anjaniAttempts(res: Record<string, unknown>): number | null {
  return count(res, (s) => {
    const text = str(s.status_name);
    return text ? FAILED_TEXT_RE.test(text) : false;
  });
}

/** Shiprocket: classify the activity / status-label text. */
export function shiprocketAttempts(res: Record<string, unknown>): number | null {
  return count(res, (s) => {
    const text = str(s.activity) ?? str(s["sr-status-label"]) ?? str(s.status);
    return text ? FAILED_TEXT_RE.test(text) : false;
  });
}
