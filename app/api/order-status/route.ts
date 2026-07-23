// Live "latest courier scan" for the drawer (design adaptation — the server
// exposes a single last_status line, not a scan timeline).
import { NextRequest, NextResponse } from "next/server";
import { fetchCourierStatus } from "@/lib/courier-tracking";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get("identifier")?.trim();
  const courier = req.nextUrl.searchParams.get("courier")?.trim() ?? null;
  if (!identifier) {
    return NextResponse.json({ error: "identifier is required" }, { status: 400 });
  }

  try {
    const res = await fetchCourierStatus(courier, identifier);
    return NextResponse.json(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
