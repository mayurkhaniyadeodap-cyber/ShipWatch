// Shared courier dispatch — one place that maps a courier name to its live
// tracking client. Used by the order-status route (drawer, on demand) and by
// the sync engine (bulk, on "Sync now").

import { callTool } from "@/interface/mcp";
import { fetchDelhiveryTracking, delhiveryTokenConfigured } from "@/interface/couriers/delhivery";
import { fetchShiprocketTracking, shiprocketTokenConfigured } from "@/interface/couriers/shiprocket";
import { fetchAnjaniTracking, anjaniConfigured } from "@/interface/couriers/anjani";
import { fetchTrackonTracking, trackonConfigured } from "@/interface/couriers/trackon";
import { fetchDtdcTracking, dtdcConfigured } from "@/interface/couriers/dtdc";
import { fetchBluedartTracking, bluedartConfigured } from "@/interface/couriers/bluedart";
import { fetchEkartTracking, ekartConfigured } from "@/interface/couriers/ekart";
import { fetchAmazonAtsTracking, amazonAtsConfigured } from "@/interface/couriers/amazon-ats";
import { fetchMarutiTracking, marutiConfigured, marutiSweepBudget } from "@/interface/couriers/maruti";
import { MARUTI_SWEEP_PER_SYNC } from "@/backend/config";
import {
  dtdcAttempts,
  trackonAttempts,
  marutiAttempts,
  ekartAttempts,
  amazonAtsAttempts,
  bluedartAttempts,
  anjaniAttempts,
  shiprocketAttempts,
} from "@/interface/courier-attempts";

export type CourierStatus = {
  found: boolean;
  /** "courier" = the courier's own API answered; "panel" = MCP fallback. */
  source: "courier" | "panel";
  status?: string | null;
  last_status?: string | null;
  reason?: string | null;
  current_timestamp?: string | null;
  last_center?: string | null;
  destination?: string | null;
  /** Failed delivery attempts counted from the courier's own scans (null when
   *  the source is the panel or the courier returned no scan history). */
  attempts?: number | null;
  [k: string]: unknown;
};

function norm(courier: string | null): string {
  return (courier ?? "").trim().toLowerCase();
}

type DirectCourier = {
  fetch: (identifier: string) => Promise<Record<string, unknown> & { found?: boolean }>;
  /** Max orders the live-track sweep may look up for this courier in ONE sync.
   *  Omitted = unmetered (the shared rate gate is protection enough). Set only for
   *  couriers whose quota spans far longer than a sync — Shree Maruti allows ~50
   *  requests per ~15h, so it trickles a few per sync and is paced by a persistent
   *  ledger instead of being swept. Evaluated per sync, so it reflects the quota
   *  actually left in the current window. */
  sweepBudget?: () => number;
  /** Count failed delivery attempts from this courier's scan history. Omitted for
   *  couriers whose tracking API returns no scan list (e.g. Delhivery). Returns a
   *  number (possibly 0) when scans are present, or null when they aren't. */
  countAttempts?: (res: Record<string, unknown>) => number | null;
};

/** Return the direct courier client for this courier name, or null if none is
 *  configured (caller then falls back to the panel, or skips it in bulk sync). */
export function resolveDirectCourier(courier: string | null): DirectCourier | null {
  const n = norm(courier);
  if (n.includes("delhivery") && delhiveryTokenConfigured()) {
    // No countAttempts: Delhivery's packages/json returns only the latest status,
    // not a scan history, so failed attempts can't be counted from it.
    return { fetch: fetchDelhiveryTracking };
  }
  if ((n.includes("shiprocket") || n.includes("ship_rocket") || n === "sr") && shiprocketTokenConfigured()) {
    return { fetch: fetchShiprocketTracking, countAttempts: shiprocketAttempts };
  }
  if (n.includes("anjani") && anjaniConfigured()) {
    return { fetch: fetchAnjaniTracking, countAttempts: anjaniAttempts };
  }
  if (n.includes("trackon") && trackonConfigured()) {
    return { fetch: fetchTrackonTracking, countAttempts: trackonAttempts };
  }
  if (n.includes("dtdc") && dtdcConfigured()) {
    return { fetch: fetchDtdcTracking, countAttempts: dtdcAttempts };
  }
  // "BlueDart" in the panel; tolerate "blue dart" / "blue_dart" spellings.
  if (n.replace(/[\s_-]/g, "").includes("bluedart") && bluedartConfigured()) {
    return { fetch: fetchBluedartTracking, countAttempts: bluedartAttempts };
  }
  if (n.includes("ekart") && ekartConfigured()) {
    return { fetch: fetchEkartTracking, countAttempts: ekartAttempts };
  }
  // "Amazon ATS" in the panel; courier_slug is "amazon_ats". Match the brand or a
  // bare "ats" slug, but not couriers that merely contain the letters.
  if ((n.includes("amazon") || n === "ats" || n.includes("amazon_ats")) && amazonAtsConfigured()) {
    return { fetch: fetchAmazonAtsTracking, countAttempts: amazonAtsAttempts };
  }
  // "Shree Maruti" in the panel; courier_slug is "maruti".
  if (n.includes("maruti") && marutiConfigured()) {
    return {
      fetch: fetchMarutiTracking,
      sweepBudget: () => marutiSweepBudget(MARUTI_SWEEP_PER_SYNC),
      countAttempts: marutiAttempts,
    };
  }
  return null;
}

export function courierHasDirectIntegration(courier: string | null): boolean {
  return resolveDirectCourier(courier) !== null;
}

/** Whether the bulk live-track sweep may call this courier at all. */
export function courierIsSweepable(courier: string | null): boolean {
  return resolveDirectCourier(courier) !== null;
}

/** How many orders the sweep may look up for this courier this sync. Infinity for
 *  unmetered couriers; a small (possibly 0) number for quota-bound ones. */
export function courierSweepBudget(courier: string | null): number {
  const d = resolveDirectCourier(courier);
  if (!d) return 0;
  return d.sweepBudget ? d.sweepBudget() : Infinity;
}

/** Live status for the drawer/route: courier's own API if available, else the
 *  shipping-panel MCP fallback.
 *
 *  The panel is ALSO the fallback when the courier's API answers but can't see
 *  the docket. That happens for real, in bulk: DTDC scopes tracking visibility
 *  to the customer account a token belongs to, so an AWB booked on an account
 *  we hold no tracking token for (e.g. GL13259's I8… series) comes back "Not
 *  Authorized to view the information" from every configured token. The panel
 *  tracks every order regardless of which courier account booked it. */
export async function fetchCourierStatus(
  courier: string | null,
  identifier: string
): Promise<CourierStatus> {
  const direct = resolveDirectCourier(courier);
  if (!direct) return panelStatus(identifier);

  let courierRes: CourierStatus | null = null;
  try {
    const res = await direct.fetch(identifier);
    // Failed-attempt count from the courier's own scans, for the drawer's
    // panel-vs-courier comparison. Undefined (not null) when this courier can't
    // count, so the field simply doesn't override anything downstream.
    const attempts = direct.countAttempts?.(res) ?? undefined;
    courierRes = { source: "courier", found: false, ...res, attempts } as CourierStatus;
    if (courierRes.found) return courierRes;
  } catch (err) {
    // Direct integration down (expired tokens, host outage) — try the panel
    // before surfacing the failure; the drawer's job is showing a status.
    const panel = await panelStatus(identifier).catch(() => null);
    if (panel?.found) return panel;
    throw err;
  }
  const panel = await panelStatus(identifier).catch(() => null);
  if (panel?.found) return panel;
  // Neither source knows the docket — the direct answer (with any `reason`,
  // e.g. DTDC's "Not Authorized") is the more specific one to show.
  return courierRes;
}

async function panelStatus(identifier: string): Promise<CourierStatus> {
  const res = await callTool("get_order_status", { identifier });
  const obj = res && typeof res === "object" ? (res as Record<string, unknown>) : { last_status: res };
  return { source: "panel", found: false, ...obj } as CourierStatus;
}

/** The single status string a courier reported (last scan preferred). */
export function statusText(res: Record<string, unknown>): string | null {
  const v = res.last_status ?? res.status;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
