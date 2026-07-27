// On-demand courier fill for the CURRENT view. The client loops this — one chunk
// per request — until `remaining` hits 0, so the "Courier status" column fills in
// for every row matching the active tab + filters, not just the sweep's batch.
import { NextRequest, NextResponse } from "next/server";
import { parseFilters } from "@/backend/queries";
import { fillView } from "@/backend/live-fill";
import { LIVE_FILL_CHUNK } from "@/backend/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tabParam = req.nextUrl.searchParams.get("tab");
  const tab = tabParam === "ndr" || tabParam === "tat" ? tabParam : null;
  if (!tab) {
    return NextResponse.json({ error: "tab must be 'tat' or 'ndr'" }, { status: 400 });
  }
  // Same filter parsing as the list routes, so the fill set == the viewed set.
  const f = parseFilters(req.nextUrl.searchParams);
  const chunk = Number(req.nextUrl.searchParams.get("limit")) || LIVE_FILL_CHUNK;

  try {
    const { filled, remaining, busy } = await fillView(tab, f, chunk);
    return NextResponse.json({ filled, remaining, busy });
  } catch (err) {
    // Courier errors can embed account usernames / raw bodies — log server-side,
    // return a generic message (same posture as the order-status route).
    console.error("[api:live-fill]", tab, err);
    return NextResponse.json({ error: "Live fill failed" }, { status: 502 });
  }
}
