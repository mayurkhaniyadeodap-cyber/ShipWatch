// Live "latest courier scan" for the drawer (design adaptation — the server
// exposes a single last_status line, not a scan timeline).
import { NextRequest, NextResponse } from "next/server";
import { fetchCourierStatus } from "@/interface/courier-tracking";

export const dynamic = "force-dynamic";

// AWBs / dockets are short alphanumeric strings, optionally hyphenated. Rejecting
// anything else keeps this route from being turned into an arbitrary-identifier
// lookup / outbound-request abuse vector.
const IDENTIFIER_RE = /^[A-Za-z0-9-]{4,40}$/;

export async function GET(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get("identifier")?.trim();
  const courier = req.nextUrl.searchParams.get("courier")?.trim() ?? null;
  if (!identifier) {
    return NextResponse.json({ error: "identifier is required" }, { status: 400 });
  }
  if (!IDENTIFIER_RE.test(identifier)) {
    return NextResponse.json({ error: "invalid identifier" }, { status: 400 });
  }

  try {
    const res = await fetchCourierStatus(courier, identifier);
    return NextResponse.json(res);
  } catch (err) {
    // Log the detail server-side only. Upstream courier errors can embed account
    // usernames and raw response bodies (e.g. DTDC auth failures), so the client
    // gets a generic message instead.
    console.error("[api:order-status]", identifier, courier, err);
    return NextResponse.json({ error: "Courier lookup failed" }, { status: 502 });
  }
}
