// Edge middleware: HTTP Basic Auth gate + a light per-IP rate limit on /api/*.
// This is the app-level defense-in-depth for internet exposure — even behind a
// Cloudflare tunnel, ShipWatch is never open. Credentials come from BASIC_AUTH_USER
// / BASIC_AUTH_PASS in .env.local (inlined at build time — changing them needs a
// rebuild). Fails CLOSED (503) if they are not set, so a misconfig can't expose PII.
import { NextRequest, NextResponse } from "next/server";

const USER = process.env.BASIC_AUTH_USER || "";
const PASS = process.env.BASIC_AUTH_PASS || "";

// Constant-time-ish string compare (avoids trivial timing leaks on the password).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function needAuth(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ShipWatch", charset="UTF-8"' },
  });
}

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
  if (!USER || !PASS) {
    return new NextResponse(
      "Auth not configured — set BASIC_AUTH_USER / BASIC_AUTH_PASS and rebuild.",
      { status: 503 }
    );
  }

  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return needAuth();
  let decoded = "";
  try {
    decoded = atob(encoded);
  } catch {
    return needAuth();
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return needAuth();
  const u = decoded.slice(0, sep);
  const p = decoded.slice(sep + 1);
  // Evaluate both compares regardless of the first result (no early-out on user).
  const ok = safeEqual(u, USER) && safeEqual(p, PASS);
  if (!ok) return needAuth();

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
