// Shared plumbing for the read-only JSON routes.

import { NextRequest, NextResponse } from "next/server";
import { listRows, parseFilters, type Tab } from "./queries";

/** Run a route body, turning any unexpected throw into a plain JSON 500.
 *  Without this, Next serves its default error page — which in `next dev`
 *  includes the stack trace and the failing SQL text. */
export async function jsonOr500<T>(label: string, body: () => T | Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await body());
  } catch (err) {
    console.error(`[api:${label}]`, err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** The list tabs differ only by their `tab` key, so they share one handler. */
export function listRoute(tab: Tab) {
  return (req: NextRequest) =>
    jsonOr500(tab, () => {
      const f = parseFilters(req.nextUrl.searchParams);
      const { rows, total, byCourier } = listRows(tab, f);
      return { rows, total, byCourier, appliedFilters: f };
    });
}
