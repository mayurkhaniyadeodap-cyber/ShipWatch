import { NextRequest } from "next/server";
import { jsonOr500 } from "@/lib/api";
import { ndrKpis, tatKpis } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("tab");
  return jsonOr500("kpis", () => {
    if (raw === "ndr") return { tab: "ndr", ...ndrKpis() };
    return { tab: "tat", ...tatKpis() };
  });
}
