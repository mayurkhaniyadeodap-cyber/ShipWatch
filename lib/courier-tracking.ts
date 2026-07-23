// Shared courier dispatch — one place that maps a courier name to its live
// tracking client. Used by the order-status route (drawer, on demand) and by
// the sync engine (bulk, on "Sync now").

import { callTool } from "./mcp";
import { fetchDelhiveryTracking, delhiveryTokenConfigured } from "./delhivery";
import { fetchShiprocketTracking, shiprocketTokenConfigured } from "./shiprocket";
import { fetchAnjaniTracking, anjaniConfigured } from "./anjani";
import { fetchTrackonTracking, trackonConfigured } from "./trackon";
import { fetchDtdcTracking, dtdcConfigured } from "./dtdc";
import { fetchBluedartTracking, bluedartConfigured } from "./bluedart";
import { fetchEkartTracking, ekartConfigured } from "./ekart";
import { fetchAmazonAtsTracking, amazonAtsConfigured } from "./amazon-ats";
import { fetchMarutiTracking, marutiConfigured, marutiSweepBudget } from "./maruti";
import { MARUTI_SWEEP_PER_SYNC } from "./config";

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
};

/** Return the direct courier client for this courier name, or null if none is
 *  configured (caller then falls back to the panel, or skips it in bulk sync). */
export function resolveDirectCourier(courier: string | null): DirectCourier | null {
  const n = norm(courier);
  if (n.includes("delhivery") && delhiveryTokenConfigured()) {
    return { fetch: fetchDelhiveryTracking };
  }
  if ((n.includes("shiprocket") || n.includes("ship_rocket") || n === "sr") && shiprocketTokenConfigured()) {
    return { fetch: fetchShiprocketTracking };
  }
  if (n.includes("anjani") && anjaniConfigured()) {
    return { fetch: fetchAnjaniTracking };
  }
  if (n.includes("trackon") && trackonConfigured()) {
    return { fetch: fetchTrackonTracking };
  }
  if (n.includes("dtdc") && dtdcConfigured()) {
    return { fetch: fetchDtdcTracking };
  }
  // "BlueDart" in the panel; tolerate "blue dart" / "blue_dart" spellings.
  if (n.replace(/[\s_-]/g, "").includes("bluedart") && bluedartConfigured()) {
    return { fetch: fetchBluedartTracking };
  }
  if (n.includes("ekart") && ekartConfigured()) {
    return { fetch: fetchEkartTracking };
  }
  // "Amazon ATS" in the panel; courier_slug is "amazon_ats". Match the brand or a
  // bare "ats" slug, but not couriers that merely contain the letters.
  if ((n.includes("amazon") || n === "ats" || n.includes("amazon_ats")) && amazonAtsConfigured()) {
    return { fetch: fetchAmazonAtsTracking };
  }
  // "Shree Maruti" in the panel; courier_slug is "maruti".
  if (n.includes("maruti") && marutiConfigured()) {
    return {
      fetch: fetchMarutiTracking,
      sweepBudget: () => marutiSweepBudget(MARUTI_SWEEP_PER_SYNC),
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
 *  shipping-panel MCP fallback. */
export async function fetchCourierStatus(
  courier: string | null,
  identifier: string
): Promise<CourierStatus> {
  const direct = resolveDirectCourier(courier);
  if (direct) {
    const res = await direct.fetch(identifier);
    return { source: "courier", found: false, ...res } as CourierStatus;
  }
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
