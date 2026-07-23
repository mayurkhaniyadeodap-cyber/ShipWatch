// Shree Anjani Courier live tracking (third-party "tpapi" endpoint).
// Contract: GET {base}/{barcode_number}, auth via `api-key` / `api-secret`
// headers. Normalized to the same { found, status, last_status } envelope the
// drawer uses for every courier.

import { COURIER_HTTP_TIMEOUT_MS } from "./config";

export type AnjaniTrackingScan = {
  status_name?: string;
  status_date?: string;
  center_name?: string;
  reason_name?: string;
  [key: string]: unknown;
};

export type AnjaniTrackingResponse = {
  found: boolean;
  barcode_number?: string;
  status?: string | null;
  last_status?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  scans?: AnjaniTrackingScan[];
  [key: string]: unknown;
};

const DEFAULT_BASE_URL = "https://api-customer.shreeanjani.co.in/tpapi/tracking";

function baseUrl(): string {
  return (process.env.ANJANI_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function credentials(): { key: string; secret: string } {
  const key = process.env.ANJANI_API_KEY?.trim();
  const secret = process.env.ANJANI_API_SECRET?.trim();
  if (!key || !secret) {
    throw new Error("ANJANI_API_KEY / ANJANI_API_SECRET are not set. Configure them in .env.local.");
  }
  return { key, secret };
}

export function anjaniConfigured(): boolean {
  return Boolean(process.env.ANJANI_API_KEY?.trim() && process.env.ANJANI_API_SECRET?.trim());
}

type AnjaniBooking = {
  barcode_number?: string;
  booking_date?: string | null;
  status_name?: string;
  reason_name?: string;
  status_date?: string;
};

type AnjaniEnvelope = {
  success?: boolean;
  data?: {
    booking?: AnjaniBooking;
    booking_tracking?: AnjaniTrackingScan[];
    last_center_details?: { center_name?: string; mobile?: string; owner_name?: string };
    drs_list?: unknown[];
  };
};

export async function fetchAnjaniTracking(barcode: string): Promise<AnjaniTrackingResponse> {
  const { key, secret } = credentials();
  const url = `${baseUrl()}/${encodeURIComponent(barcode)}`;
  const res = await fetch(url, {
    headers: {
      "api-key": key,
      "api-secret": secret,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();

  // The API returns 400 with an empty body for malformed/invalid barcodes.
  if (res.status === 400) {
    return { found: false, barcode_number: barcode };
  }
  if (!res.ok) {
    throw new Error(`Anjani tracking request failed with ${res.status} ${res.statusText}: ${raw}`);
  }

  let body: AnjaniEnvelope;
  try {
    body = JSON.parse(raw) as AnjaniEnvelope;
  } catch {
    return { found: false, barcode_number: barcode };
  }

  const booking = body.data?.booking ?? {};
  const scans = Array.isArray(body.data?.booking_tracking) ? body.data.booking_tracking : [];
  const lastScan = scans.length > 0 ? scans[scans.length - 1] : undefined;

  const status = booking.status_name?.trim() || null;
  const lastStatus = lastScan?.status_name?.trim() || status;

  // A valid but non-existent barcode still returns success:true with empty
  // fields — treat as "not found" so the UI shows the right message.
  const hasData = Boolean(status || scans.length > 0 || booking.booking_date);

  return {
    found: body.success === true && hasData,
    barcode_number: booking.barcode_number || barcode,
    status,
    last_status: lastStatus,
    reason: booking.reason_name?.trim() || null,
    current_timestamp: booking.status_date?.trim() || null,
    last_center: body.data?.last_center_details?.center_name?.trim() || null,
    scans,
  };
}
