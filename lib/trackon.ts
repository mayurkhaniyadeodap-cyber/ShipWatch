// Trackon Couriers live tracking (Customer Shipment Tracking API).
// Contract: GET {base}?AWBNo={awb}&AppKey={key}&userID={id}&Password={pwd}
// returns JSON { summaryTrack, lstDetails[], ResponseStatus }. Normalized to the
// same { found, status, last_status } envelope the drawer uses for every courier.

export type TrackonScan = {
  CURRENT_CITY?: string;
  CURRENT_STATUS?: string;
  EVENTDATE?: string;
  EVENTTIME?: string;
  TRACKING_CODE?: string;
  [key: string]: unknown;
};

export type TrackonSummary = {
  AWBNO?: string;
  REF_NO?: string;
  BOOKING_DATE?: string;
  EDD?: string;
  ORIGIN?: string;
  NO_OF_PIECES?: string;
  PINCODE?: string;
  DESTINATION?: string;
  PRODUCT?: string;
  SERVICE_TYPE?: string;
  CURRENT_STATUS?: string;
  CURRENT_CITY?: string;
  EVENTDATE?: string;
  EVENTTIME?: string;
  TRACKING_CODE?: string;
  NDR_REASON?: string;
  PODUrl?: string;
  [key: string]: unknown;
};

export type TrackonTrackingResponse = {
  found: boolean;
  awb?: string;
  status?: string | null;
  last_status?: string | null;
  /** Clean lifecycle status derived from TRACKING_CODE (Delivered/NDR/RTO/…). */
  normalized_status?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  pincode?: string | null;
  tracking_code?: string | null;
  /** Courier's own estimated delivery date (dd/mm/yyyy), when provided. */
  expected_delivery?: string | null;
  scans?: TrackonScan[];
  [key: string]: unknown;
};

import { firstAccount } from "./credentials";
import { COURIER_HTTP_TIMEOUT_MS } from "./config";

// Latest host per the Customer Tracking API doc (LatestCustomerTrackingAPI.pdf).
// The older host was http://trackoncourier.com:5455 — override via
// TRACKON_API_BASE_URL if this account is still provisioned on the old endpoint.
const DEFAULT_BASE_URL = "https://api.trackon.in/CrmApi/t1/AWBTrackingCustomer";

/** TRACKING_CODE → normalized lifecycle status, from the doc's "Track Code"
 *  table. Lets the dashboard render a clean pill and the sync detect delivery,
 *  instead of the verbose free-text CURRENT_STATUS. Unmapped in-network scans
 *  fall back to "In Transit". */
const TRACKON_CODE_STATUS: Record<string, string> = {
  DDUB: "Delivered", DDUF: "Delivered", DDUA: "Delivered", RHOD: "Delivered",
  DRSG: "Out for Delivery", DRSF: "Out for Delivery", RHOB: "Out for Delivery",
  DNUB: "NDR", DNUF: "NDR", DNUA: "NDR", RHON: "NDR",
  RSET: "RTO", RMFT: "RTO", RIST: "RTO", RISR: "RTO", RITE: "RTO", RIRE: "RTO",
  BOKN: "Booked", BOKD: "Booked",
  RPRU: "Pickup", PRSG: "Pickup", PRSS: "Pickup", RPRS: "Pickup", RPSS: "Pickup",
  PRSN: "Pickup Failed", RPSN: "Pickup Failed",
  HELD: "Held",
};

function normalizeTrackonStatus(code: string | null, raw: string | null): string | null {
  if (code) {
    const mapped = TRACKON_CODE_STATUS[code.toUpperCase()];
    if (mapped) return mapped;
  }
  return raw ? "In Transit" : null;
}

function baseUrl(): string {
  return (process.env.TRACKON_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

/** Resolve credentials from the environment, falling back to the CSV's Trackon
 *  account (all Trackon rows in the CSV share one appKey/userId login). */
function resolveCredentials(): { appKey: string; userId: string; password: string } | null {
  const envKey = process.env.TRACKON_APP_KEY?.trim();
  const envUser = process.env.TRACKON_USER_ID?.trim();
  const envPass = process.env.TRACKON_PASSWORD?.trim();
  if (envKey && envUser && envPass) {
    return { appKey: envKey, userId: envUser, password: envPass };
  }
  const acc = firstAccount("trackon");
  const appKey = acc?.fields.appKey?.trim();
  const userId = acc?.fields.userId?.trim();
  const password = acc?.fields.password?.trim();
  if (appKey && userId && password) return { appKey, userId, password };
  return null;
}

function credentials(): { appKey: string; userId: string; password: string } {
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error(
      "Trackon credentials are not set (TRACKON_APP_KEY/USER_ID/PASSWORD or credentials CSV)."
    );
  }
  return creds;
}

export function trackonConfigured(): boolean {
  return resolveCredentials() !== null;
}

type TrackonEnvelope = {
  // The api.trackon.in host returns the summary under CustomersummaryTrack (and
  // leaves summaryTrack null); the older host used summaryTrack. Accept both.
  summaryTrack?: TrackonSummary | null;
  CustomersummaryTrack?: TrackonSummary | null;
  lstDetails?: TrackonScan[] | null;
  ResponseStatus?: {
    ErrorCode?: string | null;
    Message?: string | null;
    StackTrace?: string | null;
    Errors?: string | null;
  } | null;
};

/** "05/03/2019" + "03:57:00" → "05/03/2019 03:57" (or just the date/time part). */
function combineEventTimestamp(date?: string, time?: string): string | null {
  const d = date?.trim();
  const t = time?.trim();
  if (d && t) return `${d} ${t.slice(0, 5)}`;
  return d || t || null;
}

export async function fetchTrackonTracking(awb: string): Promise<TrackonTrackingResponse> {
  const { appKey, userId, password } = credentials();
  const params = new URLSearchParams({
    AWBNo: awb,
    AppKey: appKey,
    userID: userId,
    Password: password,
  });
  const url = `${baseUrl()}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Trackon tracking request failed with ${res.status} ${res.statusText}: ${raw}`);
  }

  let body: TrackonEnvelope;
  try {
    body = JSON.parse(raw) as TrackonEnvelope;
  } catch {
    return { found: false, awb };
  }

  const summary = body.CustomersummaryTrack ?? body.summaryTrack ?? {};
  const scans = Array.isArray(body.lstDetails) ? body.lstDetails : [];

  const status = summary.CURRENT_STATUS?.trim() || null;
  const trackingCode = summary.TRACKING_CODE?.trim() || null;
  // Prefer the clean lifecycle status from the tracking code; fall back to the
  // raw CURRENT_STATUS text. This is what the dashboard pill / sync override use.
  const normalized = normalizeTrackonStatus(trackingCode, status);
  const lastStatus = normalized || status || scans[0]?.CURRENT_STATUS?.trim() || null;

  // A blank AWB or unknown docket comes back with an empty summaryTrack even
  // when Message is "SUCCESS" — require real tracking data to count as found.
  const hasData = Boolean(summary.AWBNO?.trim() || status || scans.length > 0);

  return {
    found: hasData,
    awb: summary.AWBNO?.trim() || awb,
    status,
    last_status: lastStatus,
    normalized_status: normalized,
    reason: summary.NDR_REASON?.trim() || null,
    current_timestamp: combineEventTimestamp(summary.EVENTDATE, summary.EVENTTIME),
    last_center: summary.CURRENT_CITY?.trim() || null,
    destination: summary.DESTINATION?.trim() || null,
    pincode: summary.PINCODE?.trim() || null,
    tracking_code: trackingCode,
    expected_delivery: summary.EDD?.trim() || null,
    scans,
  };
}
