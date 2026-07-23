// Ekart Logistics live tracking.
// Unofficial: this is the backend behind the public ekartlogistics.com/shipmenttrack
// widget — there is no partner/developer API or API key. Undocumented, may change
// or rate-limit without notice. Normalized to the same { found, status, last_status }
// envelope the drawer uses for every courier.
//
// Contract (read off the widget's own main.bundle.js):
//   POST {V2_URL}  body {"tracking_ids": "<awb>"}          <- snake_case, string
//   headers: csrf-token: <meta[name=csrf-token] from the tracker page>
//            X-User-Agent: "<ua> EKCL/website/1"
//            Cookie: session + session.sig from that same page load
// The csrf-token/session pair is minted per page load and must match; a mismatch
// returns HTTP 205 with an empty body (not an error status), and a wrong body
// shape returns HTTP 500. An unknown AWB is a 200 with "{}".

import { COURIER_HTTP_TIMEOUT_MS } from "./config";

export type EkartScan = {
  /** Epoch millis. */
  date?: number;
  city?: string;
  statusDetails?: string;
  [key: string]: unknown;
};

export type EkartShipment = {
  /** Epoch millis; Ekart's own EDD (becomes the actual delivery time once delivered). */
  expectedDeliveryDate?: number | null;
  faShipment?: boolean;
  reachedNearestHub?: boolean;
  receiverName?: string | null;
  merchantName?: string | null;
  sourceCity?: string | null;
  destinationCity?: string | null;
  shipmentTrackingDetails?: EkartScan[] | null;
  [key: string]: unknown;
};

export type EkartTrackingResponse = {
  found: boolean;
  awb?: string;
  status?: string | null;
  last_status?: string | null;
  /** Clean lifecycle status derived from the last scan (Delivered/NDR/RTO/…). */
  normalized_status?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  receiver?: string | null;
  expected_delivery?: string | null;
  reached_nearest_hub?: boolean | null;
  /** Sorted newest-first — Ekart returns these unordered. */
  scans?: EkartScan[];
  [key: string]: unknown;
};

const V2_URL =
  "https://ekartlogistics.com/ekartlogistics-web-routes-api/ekartlogistics-web-proxy/trackings/v2";
const TRACK_PAGE = "https://ekartlogistics.com/ekartlogistics-web/shipmenttrack";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** The public tracker needs no account, so Ekart is always available. Kept for
 *  symmetry with the other couriers' *Configured() gates in courier-tracking. */
export function ekartConfigured(): boolean {
  return true;
}

/** Scan text → normalized lifecycle status. Ekart has no status code field, only
 *  free-text statusDetails, and the vocabulary differs per merchant/lane: the DBT
 *  lane emits prose ("Received at Motherhub_RJK_Flex"), the DBL lane emits event
 *  names ("PickupReceived - PHH_SY_RJK"). Match on substrings covering both.
 *  Ordered: first hit wins, so terminal states precede in-transit ones. */
const EKART_STATUS_RULES: Array<[RegExp, string]> = [
  [/\brto\b|return\s*to\s*origin|returned\s*to\s*(seller|origin)/i, "RTO"],
  [/delivered/i, "Delivered"],
  [/out\s*for\s*delivery|outfordelivery/i, "Out for Delivery"],
  [/undelivered|not\s*delivered|delivery\s*attempt(ed)?\s*fail|nondelivery|ndr/i, "NDR"],
  [/notpicked|pickup\s*fail|not\s*picked/i, "Pickup Failed"],
  [/out\s*for\s*pickup|outforpickup/i, "Out for Pickup"],
  [/pickup\s*from\s*seller|pickupreceived|picked\s*up/i, "Pickup"],
  [/shipment\s*created|manifest/i, "Booked"],
  [/lost|damaged/i, "Held"],
];

function normalizeEkartStatus(raw: string | null): string | null {
  if (!raw) return null;
  for (const [re, status] of EKART_STATUS_RULES) {
    if (re.test(raw)) return status;
  }
  // Received at / Dispatched to / Expected - / InscannedAtDH - → still moving.
  return "In Transit";
}

/** Epoch millis → "dd/mm/yyyy hh:mm" in IST, matching the other couriers' text. */
function formatTimestamp(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

type EkartSession = { csrf: string; cookie: string };

/** Load the tracker page to mint a csrf-token + session cookie pair. They are
 *  bound to each other, so both must come from the same response. */
async function openSession(awb: string): Promise<EkartSession> {
  const res = await fetch(`${TRACK_PAGE}/${encodeURIComponent(awb)}`, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ekart tracker page failed with ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const csrf = html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!csrf || !cookie) {
    throw new Error("Ekart tracker page did not return a csrf-token/session pair.");
  }
  return { csrf, cookie };
}

async function postTracking(awb: string, session: EkartSession): Promise<Response> {
  return fetch(V2_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-User-Agent": `${UA} EKCL/website/1`,
      "csrf-token": session.csrf,
      Cookie: session.cookie,
      Origin: "https://ekartlogistics.com",
      Referer: `${TRACK_PAGE}/${encodeURIComponent(awb)}`,
      "User-Agent": UA,
    },
    body: JSON.stringify({ tracking_ids: awb }),
    redirect: "follow",
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
}

export async function fetchEkartTracking(awb: string): Promise<EkartTrackingResponse> {
  let session = await openSession(awb);
  let res = await postTracking(awb, session);

  // 205 = CSRF/session rejected (empty body, not an HTTP error). Sessions are
  // short-lived, so mint a fresh pair once before giving up.
  if (res.status === 205) {
    session = await openSession(awb);
    res = await postTracking(awb, session);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Ekart tracking request failed with ${res.status} ${res.statusText}: ${raw}`);
  }
  if (res.status === 205) {
    throw new Error("Ekart rejected the tracking request (csrf/session mismatch).");
  }

  let body: Record<string, EkartShipment>;
  try {
    body = JSON.parse(raw) as Record<string, EkartShipment>;
  } catch {
    return { found: false, awb };
  }

  // Response is keyed by tracking id. Unknown AWBs come back as {}.
  const shipment = body[awb] ?? Object.values(body)[0];
  if (!shipment || typeof shipment !== "object") return { found: false, awb };

  // Ekart returns scans unordered (a "Dispatched" scan can precede the earlier
  // "Received" one), so sort newest-first before reading the current status.
  const scans = [...(shipment.shipmentTrackingDetails ?? [])].sort(
    (a, b) => (b.date ?? 0) - (a.date ?? 0)
  );
  const latest = scans[0] ?? null;

  const status = latest?.statusDetails?.trim() || null;
  const normalized = normalizeEkartStatus(status);
  const delivered = normalized === "Delivered";

  // Take the delivery time from the Delivered scan, NOT expectedDeliveryDate:
  // the DBT lane overwrites that field with the actual delivery time on delivery,
  // but the DBL lane leaves it as the original EDD, so trusting it there reports
  // a future "delivered at". The scan matches the panel's delivered_date on both.
  const deliveredAt = delivered ? formatTimestamp(latest?.date) : null;

  // A booked-but-unscanned shipment has an empty scan list but real routing data
  // — still "found", just with no status yet.
  const hasData = Boolean(status || shipment.sourceCity || shipment.destinationCity);

  return {
    found: hasData,
    awb,
    status,
    last_status: normalized || status,
    normalized_status: normalized,
    reason: null, // Ekart's public tracker exposes no NDR reason field.
    current_timestamp: formatTimestamp(latest?.date),
    last_center: latest?.city?.trim() || null,
    destination: shipment.destinationCity?.trim() || null,
    receiver: shipment.receiverName?.trim() || null,
    // Suppressed once delivered: the DBT lane clobbers this field with the actual
    // delivery time, so it no longer means "expected" and can't be compared to EDD.
    expected_delivery: delivered ? null : formatTimestamp(shipment.expectedDeliveryDate),
    delivered_at: deliveredAt,
    reached_nearest_hub: shipment.reachedNearestHub ?? null,
    source_city: shipment.sourceCity?.trim() || null,
    merchant: shipment.merchantName?.trim() || null,
    scans,
  };
}
