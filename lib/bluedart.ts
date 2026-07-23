// BlueDart live tracking (RoutingServlet "custawbquery" tracking API).
// Contract: GET {base}?handler=tnt&action=custawbquery&loginid={LoginId}&awb=awb
//   &numbers={awb}&format=xml&lickey={TrackingKey}&verno=1.3&scan=1
// Returns XML: <ShipmentData><Shipment WaybillNo=".."> .. <Status/> <StatusType/>
//   <ExpectedDeliveryDate/> <StatusDate/> <StatusTime/> <Scans><ScanDetail/>..</Scans>
// Normalized to the same { found, status, last_status } envelope every courier uses.

export type BluedartScan = {
  scan?: string;
  scan_code?: string;
  scan_type?: string;
  scan_date?: string;
  scan_time?: string;
  location?: string;
};

export type BluedartTrackingResponse = {
  found: boolean;
  awb?: string;
  status?: string | null;
  last_status?: string | null;
  status_type?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  origin?: string | null;
  /** BlueDart's own promised delivery date, when provided. */
  expected_delivery?: string | null;
  service?: string | null;
  scans?: BluedartScan[];
  [key: string]: unknown;
};

import { accountsFor } from "./credentials";
import { COURIER_HTTP_TIMEOUT_MS } from "./config";

const DEFAULT_BASE_URL = "https://api.bluedart.com/servlet/RoutingServlet";

function baseUrl(): string {
  return (process.env.BLUEDART_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

type BluedartCred = { loginId: string; licKey: string };

/** (LoginId, TrackingKey) pairs to try: env override first, then each distinct
 *  BlueDart account from the CSV (most-used first). The tracking servlet keys
 *  are per-account, so an AWB resolves under its owning login. */
export function bluedartCredentials(): BluedartCred[] {
  const out: BluedartCred[] = [];
  const envLogin = process.env.BLUEDART_LOGIN_ID?.trim();
  const envKey = process.env.BLUEDART_TRACKING_KEY?.trim();
  if (envLogin && envKey) out.push({ loginId: envLogin, licKey: envKey });
  for (const a of accountsFor("bluedart")) {
    const loginId = a.fields.LoginId?.trim();
    const licKey = a.fields.TrackingKey?.trim();
    if (loginId && licKey) out.push({ loginId, licKey });
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.loginId}|${c.licKey}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function bluedartConfigured(): boolean {
  return bluedartCredentials().length > 0;
}

// ---- tiny XML readers (payload is flat, well-formed XML — no parser dep) ----
// `<Status>` patterns are exact-tag so they never match `<StatusType>` etc.
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? m[1].trim() || null : null;
}
function attr(xml: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(xml);
  return m ? m[1].trim() || null : null;
}
function parseScans(xml: string): BluedartScan[] {
  const block = /<Scans>([\s\S]*?)<\/Scans>/i.exec(xml)?.[1] ?? "";
  const out: BluedartScan[] = [];
  for (const m of block.matchAll(/<ScanDetail>([\s\S]*?)<\/ScanDetail>/gi)) {
    const s = m[1];
    out.push({
      scan: tag(s, "Scan") ?? undefined,
      scan_code: tag(s, "ScanCode") ?? undefined,
      scan_type: tag(s, "ScanType") ?? undefined,
      scan_date: tag(s, "ScanDate") ?? undefined,
      scan_time: tag(s, "ScanTime") ?? undefined,
      location: tag(s, "ScannedLocation") ?? undefined,
    });
  }
  return out;
}

async function trackWith(awb: string, c: BluedartCred): Promise<BluedartTrackingResponse> {
  const qs = new URLSearchParams({
    handler: "tnt",
    action: "custawbquery",
    loginid: c.loginId,
    awb: "awb",
    numbers: awb,
    format: "xml",
    lickey: c.licKey,
    verno: "1.3",
    scan: "1",
  });
  const res = await fetch(`${baseUrl()}?${qs.toString()}`, {
    headers: { Accept: "application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `BlueDart tracking request failed with ${res.status} ${res.statusText}: ${raw.slice(0, 200)}`
    );
  }

  const shipment = /<Shipment\b[\s\S]*?<\/Shipment>/i.exec(raw)?.[0];
  if (!shipment) return { found: false, awb };

  // An unknown waybill / bad licence comes back as a 200 with no <Status>.
  const status = tag(shipment, "Status");
  if (!status) return { found: false, awb };

  const scans = parseScans(shipment); // newest scan first
  const date = tag(shipment, "StatusDate");
  const time = tag(shipment, "StatusTime");

  return {
    found: true,
    awb: attr(shipment, "WaybillNo") || awb,
    status,
    last_status: status,
    status_type: tag(shipment, "StatusType"),
    reason: scans[0]?.scan ?? null,
    current_timestamp: date && time ? `${date} ${time}` : date || time || null,
    last_center: scans[0]?.location ?? null,
    destination: tag(shipment, "Destination"),
    origin: tag(shipment, "Origin"),
    expected_delivery: tag(shipment, "ExpectedDeliveryDate"),
    service: tag(shipment, "Service"),
    scans,
  };
}

/** Track an AWB, trying each BlueDart account until one resolves it. If EVERY
 *  account errored (bad licence / endpoint down), surface the error rather than
 *  masking it as a silent "not found". */
export async function fetchBluedartTracking(awb: string): Promise<BluedartTrackingResponse> {
  const creds = bluedartCredentials();
  if (creds.length === 0) {
    throw new Error("No BlueDart credentials configured (env or credentials CSV).");
  }
  let last: BluedartTrackingResponse | null = null;
  let lastErr: unknown = null;
  for (const c of creds) {
    try {
      const res = await trackWith(awb, c);
      if (res.found) return res;
      last = res;
    } catch (err) {
      lastErr = err;
    }
  }
  if (last === null && lastErr) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  return last ?? { found: false, awb };
}
