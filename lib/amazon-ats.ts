// Amazon ATS (Amazon Transportation Services / Amazon Shipping) live tracking.
//
// Unlike the public-tracker couriers (Ekart, Maruti), Amazon ATS is an OFFICIAL
// integration: it authenticates with the SP-API "Login With Amazon" (LWA)
// refresh-token flow using the credentials already in the CSV
//   Amazon ATS,refresh_token=Atzr|…; client_id=amzn1.application-oa2-client.…;
//              client_secret=amzn1.oa2-cs.v1.…
// and calls the Amazon Shipping API v2 getTracking operation. Normalized to the
// same { found, status, last_status } envelope the drawer uses for every courier.
//
// Auth flow (two hops, both stable/documented):
//   1. POST https://api.amazon.com/auth/o2/token   grant_type=refresh_token
//        → { access_token, expires_in: 3600 }   (cached ~55m below)
//   2. GET  {SP_API_HOST}/shipping/v2/tracking?trackingId={awb}&carrierId={id}
//        header: x-amz-access-token: <access_token>
//   Modern SP-API no longer requires AWS SigV4 request signing (dropped Oct 2023)
//   — the LWA access token in x-amz-access-token is the only auth needed.
//
// Verified live on 2026-07-21 against two real ATS AWBs:
//   • carrierId MUST be "ATS" (the default below). AMZN / AMZL / AMAZON / *_IN
//     are all rejected with 400 InvalidInput. Override via AMAZON_ATS_CARRIER_ID
//     only if Amazon changes it; host/path are env-overridable too
//     (AMAZON_ATS_SP_API_HOST, AMAZON_ATS_TRACKING_PATH).
//   • Response shape confirmed: { payload?, summary.status, promisedDeliveryDate,
//     eventHistory:[{ eventCode, eventTime, location:{city,stateOrRegion,…}|null }] }.
//     The parser stays defensive so a shape drift degrades to `found:false`
//     instead of throwing into the live-track circuit breaker.

import { accountsFor } from "./credentials";
import { COURIER_HTTP_TIMEOUT_MS } from "./config";

export type AmazonAtsScan = {
  /** ISO-8601 timestamp, e.g. "2026-07-06T10:30:00Z". */
  eventTime?: string;
  eventCode?: string;
  eventDescription?: string;
  location?: {
    city?: string;
    stateOrRegion?: string;
    countryCode?: string;
    postalCode?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type AmazonAtsTrackingResponse = {
  found: boolean;
  awb?: string;
  status?: string | null;
  last_status?: string | null;
  /** Clean lifecycle status derived from the summary/latest event (Delivered/NDR/RTO/…). */
  normalized_status?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  /** Amazon's promised delivery date (ISO), when the API returns one. */
  expected_delivery?: string | null;
  /** Sorted newest-first — Amazon returns eventHistory oldest-first. */
  scans?: AmazonAtsScan[];
  [key: string]: unknown;
};

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
// India sits in the SP-API EU region. Override for a US/FE seller account.
const DEFAULT_SP_API_HOST = "https://sellingpartnerapi-eu.amazon.com";
const DEFAULT_TRACKING_PATH = "/shipping/v2/tracking";
// Confirmed live: Amazon ATS shipments track under carrierId "ATS" (2026-07-21).
const DEFAULT_CARRIER_ID = "ATS";

function spApiHost(): string {
  return (process.env.AMAZON_ATS_SP_API_HOST?.trim() || DEFAULT_SP_API_HOST).replace(/\/$/, "");
}

function trackingPath(): string {
  const p = process.env.AMAZON_ATS_TRACKING_PATH?.trim() || DEFAULT_TRACKING_PATH;
  return p.startsWith("/") ? p : `/${p}`;
}

function carrierId(): string {
  return process.env.AMAZON_ATS_CARRIER_ID?.trim() || DEFAULT_CARRIER_ID;
}

type AtsCredentials = { refreshToken: string; clientId: string; clientSecret: string };

function credKey(c: AtsCredentials): string {
  return `${c.clientId}::${c.clientSecret}::${c.refreshToken}`;
}

/** All candidate LWA credential sets to try, most-preferred first: the env
 *  override (if fully set), then every CSV "Amazon ATS" row (most-used-first),
 *  de-duplicated.
 *
 *  Why a LIST, not one account: the CSV carries several ATS logins and — like
 *  DTDC/Delhivery — the "primary" (most-used) one can hold a stale client_secret
 *  that LWA rejects with `invalid_client`, while another row still authenticates.
 *  resolveAccessToken() below walks this list until one mints a token, so a single
 *  rotated secret no longer benches the whole integration. */
function candidateCredentials(): AtsCredentials[] {
  const out: AtsCredentials[] = [];
  const seen = new Set<string>();
  const add = (refreshToken?: string, clientId?: string, clientSecret?: string) => {
    const rt = refreshToken?.trim();
    const ci = clientId?.trim();
    const cs = clientSecret?.trim();
    if (!rt || !ci || !cs) return;
    const cred = { refreshToken: rt, clientId: ci, clientSecret: cs };
    const key = credKey(cred);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cred);
  };
  add(
    process.env.AMAZON_ATS_REFRESH_TOKEN,
    process.env.AMAZON_ATS_CLIENT_ID,
    process.env.AMAZON_ATS_CLIENT_SECRET
  );
  for (const a of accountsFor("amazon")) {
    add(a.fields.refresh_token, a.fields.client_id, a.fields.client_secret);
  }
  return out;
}

export function amazonAtsConfigured(): boolean {
  return candidateCredentials().length > 0;
}

// LWA access tokens live 1h; cache the one we mint so we don't re-exchange the
// refresh token on every drawer open. Refreshed ~5m early to dodge clock skew.
let cachedToken: { value: string; expires: number } | null = null;
// The credential set that last authenticated — tried first next refresh so we
// don't re-pay the failed `invalid_client` round-trip on every token renewal.
let lastGoodKey: string | null = null;

async function exchangeRefreshToken(creds: AtsCredentials): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Amazon LWA token exchange failed with ${res.status} ${res.statusText}: ${raw}`);
  }
  const parsed = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new Error("Amazon LWA token response had no access_token.");
  cachedToken = {
    value: parsed.access_token,
    expires: Date.now() + Math.max(60, (parsed.expires_in ?? 3600) - 300) * 1000,
  };
  return parsed.access_token;
}

async function resolveAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;

  const candidates = candidateCredentials();
  if (candidates.length === 0) {
    throw new Error(
      "No Amazon ATS credentials (AMAZON_ATS_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET or credentials CSV)."
    );
  }

  // Try the last-known-good credential set first, then the rest in preference
  // order — so a stale primary secret costs at most one extra round-trip.
  const ordered = lastGoodKey
    ? [...candidates].sort(
        (a, b) => Number(credKey(b) === lastGoodKey) - Number(credKey(a) === lastGoodKey)
      )
    : candidates;

  let lastErr: Error | null = null;
  for (const creds of ordered) {
    try {
      const token = await exchangeRefreshToken(creds);
      lastGoodKey = credKey(creds);
      return token;
    } catch (err) {
      // invalid_client / expired secret on one account — try the next one.
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error("Amazon ATS: no credential set could authenticate.");
}

/** Amazon status/event text → normalized lifecycle status. Amazon's Shipping v2
 *  status vocabulary varies in casing across regions/lanes, so match on
 *  substrings (like the Ekart normalizer) rather than an exact enum. Ordered:
 *  first hit wins, so terminal states precede in-transit ones. */
const AMAZON_STATUS_RULES: Array<[RegExp, string]> = [
  [/return\s*to\s*sender|returned|\brto\b/i, "RTO"],
  // "PickupCancelled" / "OrderCancelled" are terminal — must beat the pickup rule
  // below, else a cancelled shipment reads as successfully picked up (observed).
  [/cancell?ed|canceled/i, "Cancelled"],
  [/delivered/i, "Delivered"],
  [/out\s*for\s*delivery|outfordelivery/i, "Out for Delivery"],
  [/undeliverable|delivery\s*attempt|attempted|not\s*delivered|refused|\bndr\b/i, "NDR"],
  [/available\s*for\s*pickup/i, "Available for Pickup"],
  [/picked\s*up|pickup/i, "Pickup"],
  [/label\s*created|manifest|pre\s*-?\s*transit|shipment\s*created|order\s*placed/i, "Booked"],
  [/delayed|exception|held/i, "Held"],
  [/lost|damaged/i, "Held"],
];

function normalizeAmazonStatus(raw: string | null): string | null {
  if (!raw) return null;
  for (const [re, status] of AMAZON_STATUS_RULES) {
    if (re.test(raw)) return status;
  }
  // In-transit / arrived-at-facility / departed — still moving.
  return "In Transit";
}

/** ISO-8601 → "dd/mm/yyyy hh:mm" IST, matching the other couriers' text. */
function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
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

function locationText(loc: AmazonAtsScan["location"]): string | null {
  if (!loc) return null;
  const city = loc.city?.trim();
  const state = loc.stateOrRegion?.trim();
  return [city, state].filter(Boolean).join(", ") || null;
}

type AtsTrackingEnvelope = {
  // Shipping API v2 nests the payload under `payload`; v1 returned it flat.
  // Accept both so a host/version override still parses.
  payload?: Record<string, unknown>;
  trackingId?: string;
  summary?: { status?: string } | null;
  eventHistory?: AmazonAtsScan[] | null;
  promisedDeliveryDate?: string | null;
  [key: string]: unknown;
};

export async function fetchAmazonAtsTracking(trackingId: string): Promise<AmazonAtsTrackingResponse> {
  const token = await resolveAccessToken();
  const params = new URLSearchParams({ trackingId, carrierId: carrierId() });
  const url = `${spApiHost()}${trackingPath()}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      "x-amz-access-token": token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();

  // A definitively-unknown tracking id (404) is an answer about ONE parcel, not a
  // courier fault — return found:false so it never feeds the live-track breaker.
  if (res.status === 404) return { found: false, awb: trackingId };
  if (!res.ok) {
    throw new Error(`Amazon ATS tracking request failed with ${res.status} ${res.statusText}: ${raw}`);
  }

  let env: AtsTrackingEnvelope;
  try {
    const parsed = JSON.parse(raw) as AtsTrackingEnvelope;
    // Unwrap the v2 `payload` envelope if present.
    env = (parsed.payload as AtsTrackingEnvelope | undefined) ?? parsed;
  } catch {
    return { found: false, awb: trackingId };
  }

  // Amazon returns eventHistory oldest-first; sort newest-first so index 0 is the
  // latest scan (defensive — matches how every other courier module reads latest).
  const scans = [...(env.eventHistory ?? [])].sort(
    (a, b) => (Date.parse(b.eventTime ?? "") || 0) - (Date.parse(a.eventTime ?? "") || 0)
  );
  const latest = scans[0] ?? null;

  const summaryStatus = env.summary?.status?.trim() || null;
  const latestText =
    latest?.eventDescription?.trim() || latest?.eventCode?.trim() || null;
  // Prefer the summary status; fall back to the latest event's text.
  const status = summaryStatus || latestText;
  const normalized = normalizeAmazonStatus(status);

  const hasData = Boolean(status || scans.length > 0 || env.trackingId);

  return {
    found: hasData,
    awb: env.trackingId?.trim() || trackingId,
    status,
    last_status: normalized || status,
    normalized_status: normalized,
    reason: normalized === "NDR" || normalized === "RTO" ? latestText : null,
    current_timestamp: formatTimestamp(latest?.eventTime),
    last_center: locationText(latest?.location),
    destination: null, // Shipping v2 tracking does not echo the destination address.
    expected_delivery: env.promisedDeliveryDate?.trim() || null,
    scans,
  };
}
