export type DelhiveryTrackingResponse = {
  found: boolean;
  waybill?: string;
  status?: string | null;
  last_status?: string | null;
  status_type?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  [key: string]: unknown;
};

import { fieldValuesFor } from "./credentials";
import { COURIER_HTTP_TIMEOUT_MS } from "./config";

const DEFAULT_BASE_URL = "https://track.delhivery.com/api/v1/packages/json";

function baseUrl(): string {
  return (process.env.DELHIVERY_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

/** API tokens to try, in order: env override, then each distinct `api_key`
 *  from the CSV's Delhivery accounts (a waybill belongs to one account). */
export function delhiveryTokens(): string[] {
  const tokens: string[] = [];
  const env = process.env.DELHIVERY_API_TOKEN?.trim();
  if (env) tokens.push(env);
  for (const t of fieldValuesFor("delhivery", "api_key")) tokens.push(t);
  return [...new Set(tokens)];
}

export function delhiveryTokenConfigured(): boolean {
  return delhiveryTokens().length > 0;
}

// Delhivery's public tracking API responds with
// { ShipmentData: [ { Shipment: { AWB, Status: { Status, StatusType,
//   StatusDateTime, StatusLocation, Instructions }, Destination, ... } } ] }.
type DelhiveryStatus = {
  Status?: string;
  StatusType?: string;
  StatusCode?: string;
  StatusDateTime?: string;
  StatusLocation?: string;
  Instructions?: string;
};
type DelhiveryShipment = {
  AWB?: string;
  Status?: DelhiveryStatus;
  Destination?: string;
  Origin?: string;
  ReferenceNo?: string;
};
type DelhiveryEnvelope = {
  ShipmentData?: Array<{ Shipment?: DelhiveryShipment }>;
};

async function trackWithToken(waybill: string, token: string): Promise<DelhiveryTrackingResponse> {
  const url = `${baseUrl()}?waybill=${encodeURIComponent(waybill)}&ref_ids=`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Delhivery tracking request failed with ${res.status} ${res.statusText}: ${raw}`);
  }

  let body: DelhiveryEnvelope;
  try {
    body = JSON.parse(raw) as DelhiveryEnvelope;
  } catch {
    return { found: false, waybill };
  }

  const shipment = body.ShipmentData?.[0]?.Shipment;
  const st = shipment?.Status;
  const status = st?.Status?.trim() || null;
  // A blank/unknown waybill comes back with no ShipmentData or an empty Status.
  if (!shipment || !status) return { found: false, waybill };

  return {
    found: true,
    waybill: shipment.AWB?.trim() || waybill,
    status,
    last_status: status,
    status_type: st?.StatusType?.trim() || null,
    reason: st?.Instructions?.trim() || null,
    current_timestamp: st?.StatusDateTime?.trim() || null,
    last_center: st?.StatusLocation?.trim() || null,
    destination: shipment.Destination?.trim() || null,
  };
}

/** Track a waybill, trying each configured account token until one resolves it. */
export async function fetchDelhiveryTracking(waybill: string): Promise<DelhiveryTrackingResponse> {
  const tokens = delhiveryTokens();
  if (tokens.length === 0) {
    throw new Error("No Delhivery token configured (env or credentials CSV).");
  }
  let last: DelhiveryTrackingResponse | null = null;
  let lastErr: unknown = null;
  for (const token of tokens) {
    try {
      const res = await trackWithToken(waybill, token);
      if (res.found) return res;
      last = res;
    } catch (err) {
      // A rejected/expired token for one account shouldn't abort the others.
      lastErr = err;
    }
  }

  // Every token errored — surface it rather than masking a credentials/network
  // failure as a silent "not found". Callers (the live-track circuit breaker)
  // count thrown errors; folding the message into `status` instead would both
  // blind the breaker and render the error text to the user as a courier status.
  if (last === null && lastErr) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  return last ?? { found: false, waybill };
}
