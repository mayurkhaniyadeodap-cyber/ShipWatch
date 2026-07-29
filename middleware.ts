// Edge middleware: a light per-IP rate limit on /api/*.
//
// There is NO login. ShipWatch runs as a local-only tool: the server binds to
// 127.0.0.1 (see the `start` script and ops/watchdog.ps1), so the loopback bind —
// not a password — is what keeps it private. The HTTP Basic Auth gate that used
// to live here was removed on 2026-07-29 at the owner's request; it only existed
// for a period when the app was exposed to the internet through a tunnel.
//
// If this app is ever put back on a public address, the gate has to come back
// with it. The cache holds ~480k orders of customer PII (names, phone numbers,
// addresses), and a loopback bind is the ONLY thing standing in for auth now.
import { NextRequest, NextResponse } from "next/server";

// Fixed-window in-memory rate limit (single self-hosted instance → module scope is fine).
// Kept as a runaway guard: the dashboard's live-fill loop issues chunked /api/live-fill
// requests, and this bounds a misbehaving tab. It is not a security control.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 240; // per IP per minute across /api/*
const hits = new Map<string, { count: number; reset: number }>();

function overLimit(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > MAX_PER_WINDOW;
}

export function middleware(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const ip = (
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for") ||
      "local"
    )
      .split(",")[0]
      .trim();
    if (overLimit(ip)) {
      return new NextResponse("Too many requests", { status: 429 });
    }
  }

  return NextResponse.next();
}

export const config = {
  // Only /api/* needs the rate limit; pages are served without any gate.
  matcher: ["/api/:path*"],
};
