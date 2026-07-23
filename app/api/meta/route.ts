import { jsonOr500 } from "@/lib/api";
import { meta } from "@/lib/queries";
import { getSyncStatus, ensureFirstSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonOr500("meta", () => {
    ensureFirstSync();
    return { ...meta(), last_synced_at: getSyncStatus().last_synced_at };
  });
}
