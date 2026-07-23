import { jsonOr500 } from "@/lib/api";
import { ensureFirstSync, getSyncStatus } from "@/lib/sync";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonOr500("sync/status", () => {
    ensureFirstSync();
    const orders = (getDb().prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
    return { ...getSyncStatus(), orders };
  });
}
