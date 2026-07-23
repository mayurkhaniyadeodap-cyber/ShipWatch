export type ShiprocketTrackingScan = {
  date?: string;
  status?: string;
  activity?: string;
  location?: string;
  [key: string]: unknown;
};

export type ShiprocketTrackingResponse = {
  found: boolean;
  awb?: string;
  courier_name?: string | null;
  status?: string | null;
  last_status?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  scans?: ShiprocketTrackingScan[];
  [key: string]: unknown;
};

import { firstAccount } from "./credentials";
import { COURIER_HTTP_TIMEOUT_MS } from "./config";

const DEFAULT_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

function baseUrl(): string {
  return (process.env.SHIPROCKET_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function loginCreds(): { email: string; password: string } | null {
  const acc = firstAccount("shiprocket");
  const email = acc?.fields.email?.trim();
  const password = acc?.fields.password?.trim();
  if (email && password) return { email, password };
  return null;
}

/** Configured if we either have a static token or an email/password to log in. */
export function shiprocketTokenConfigured(): boolean {
  return Boolean(process.env.SHIPROCKET_API_TOKEN?.trim()) || loginCreds() !== null;
}

// Shiprocket tokens are long-lived (~10 days); cache the one we mint from the
// CSV login so we don't re-authenticate on every drawer open.
let cachedToken: { value: string; expires: number } | null = null;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Shiprocket login failed with ${res.status} ${res.statusText}: ${raw}`);
  }
  const body = JSON.parse(raw) as { token?: string };
  if (!body.token) throw new Error("Shiprocket login returned no token.");
  return body.token;
}

/** Resolve a bearer token: env override first, else log in with the CSV account
 *  (cached for 24h). */
async function resolveToken(): Promise<string> {
  const envToken = process.env.SHIPROCKET_API_TOKEN?.trim();
  if (envToken) return envToken;
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const creds = loginCreds();
  if (!creds) {
    throw new Error("No Shiprocket token or login (env or credentials CSV).");
  }
  const token = await login(creds.email, creds.password);
  cachedToken = { value: token, expires: Date.now() + 24 * 60 * 60 * 1000 };
  return token;
}

/** Does this non-2xx body describe the AWB itself rather than a courier fault?
 *  Matched on the message text because Shiprocket reuses HTTP 500 for both. */
function isTerminalAwbAnswer(raw: string): boolean {
  let message = "";
  try {
    message = String((JSON.parse(raw) as { message?: unknown }).message ?? "");
  } catch {
    message = raw;
  }
  const m = message.toLowerCase();
  return (
    m.includes("has been cancelled") ||
    m.includes("has been canceled") ||
    m.includes("awb not found") ||
    m.includes("invalid awb") ||
    m.includes("no data found")
  );
}

export async function fetchShiprocketTracking(awb: string): Promise<ShiprocketTrackingResponse> {
  const token = await resolveToken();
  // Correct AWB tracking endpoint is /courier/track/awb/{awb} (path param).
  const url = `${baseUrl()}/courier/track/awb/${encodeURIComponent(awb)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    // Shiprocket answers some PER-SHIPMENT conditions with HTTP 500 and a
    // human message rather than a 2xx/404 — e.g. {"message":"Ohh! This AWB has
    // been cancelled."}. That is a definitive answer about one AWB, not a
    // courier fault, so it must be `found: false` and NOT a throw: thrown errors
    // feed the live-track circuit breaker, and a run of cancelled AWBs would
    // otherwise bench Shiprocket entirely (observed — 15 in a row did exactly
    // that, taking every working Shiprocket order down with them).
    if (isTerminalAwbAnswer(raw)) return { found: false, awb };
    throw new Error(`Shiprocket tracking request failed with ${res.status} ${res.statusText}: ${raw}`);
  }

  // Response shape: { tracking_data: { shipment_track: [ { current_status,
  // destination, courier_name, ... } ], shipment_track_activities: [ { date,
  // activity, location, "sr-status-label" } ], etd } }. Activities are newest-
  // first, so index 0 is the latest scan.
  let td: Record<string, unknown> = {};
  try {
    td = ((JSON.parse(raw) as { tracking_data?: Record<string, unknown> }).tracking_data ?? {}) as Record<string, unknown>;
  } catch {
    return { found: false, awb };
  }

  const track = (td.shipment_track as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const activities = (td.shipment_track_activities as ShiprocketTrackingScan[] | undefined) ?? [];
  const latest = activities[0];

  const status = (track.current_status as string | undefined)?.trim() || null;
  const lastStatus =
    (latest?.activity as string | undefined)?.trim() ||
    (latest?.["sr-status-label"] as string | undefined) ||
    status;
  const found = Boolean(td.track_status || status || activities.length > 0);

  return {
    found,
    awb: (track.awb_code as string | undefined) ?? awb,
    courier_name: (track.courier_name as string | undefined) ?? null,
    status,
    last_status: lastStatus,
    current_timestamp: (latest?.date as string | undefined) ?? (td.etd as string | undefined) ?? null,
    last_center: (latest?.location as string | undefined) ?? null,
    destination: (track.destination as string | undefined) ?? null,
    scans: activities,
  } as ShiprocketTrackingResponse;
}
