// Edge middleware: light per-IP rate limit on /api/*.
// No authentication is enforced here.
import { NextRequest, NextResponse } from "next/server";

// Fixed-window in-memory rate limit (single self-hosted instance → module scope is fine).
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
  // Gate everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
