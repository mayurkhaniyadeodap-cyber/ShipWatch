import { jsonOr500 } from "@/interface/api";
import { meta } from "@/backend/queries";
import { getSyncStatus, ensureFirstSync } from "@/backend/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonOr500("meta", () => {
    ensureFirstSync();
    return { ...meta(), last_synced_at: getSyncStatus().last_synced_at };
  });
}
