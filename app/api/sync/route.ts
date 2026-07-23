import { NextResponse } from "next/server";
import { startSync, getSyncStatus } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function POST() {
  const started = startSync();
  if (!started) {
    return NextResponse.json(
      { error: "Sync already running", status: getSyncStatus() },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, status: getSyncStatus() }, { status: 202 });
}
