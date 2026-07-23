import { NextRequest, NextResponse } from "next/server";
import { exportRows, parseFilters } from "@/lib/queries";
import { buildWorkbook } from "@/lib/excel";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const scopeRaw = sp.get("scope") ?? "both";
  const scope = scopeRaw === "tat" || scopeRaw === "ndr" ? scopeRaw : "both";
  const f = parseFilters(sp);

  try {
    const data: Parameters<typeof buildWorkbook>[1] = {};
    if (scope === "both" || scope === "tat") data.tat = exportRows("tat", f);
    if (scope === "both" || scope === "ndr") data.ndr = exportRows("ndr", f);

    const { buffer, filename } = await buildWorkbook(scope, data, f);
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[api:export]", err);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
