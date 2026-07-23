// Server-side 24/7 background sync loop (see BACKGROUND_SYNC in config.ts).
//
// Started once from instrumentation.ts when the Node server boots. Runs a
// self-pacing loop: sync → wait BACKGROUND_SYNC_GAP_MS → sync … forever, so the
// local cache stays fresh with no browser tab open. Because it awaits each sync
// to completion before sleeping, it can never overlap a running sync (its own or
// one a client triggered). Requires a long-lived server process; it has no
// effect in a serverless/ephemeral runtime.

import {
  BACKGROUND_SYNC,
  BACKGROUND_SYNC_GAP_MS,
  BACKGROUND_SYNC_STARTUP_DELAY_MS,
} from "./config";
import { runSyncAndWait } from "./sync";

declare global {
  // eslint-disable-next-line no-var
  var __shipwatchScheduler: boolean | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Idempotent: starts the background loop once per process. Safe to call from
 *  the instrumentation hook (and survives dev hot-reload via globalThis). */
export function startBackgroundSync(): void {
  if (!BACKGROUND_SYNC) {
    console.log("[scheduler] background sync disabled (BACKGROUND_SYNC=false).");
    return;
  }
  if (globalThis.__shipwatchScheduler) return; // already running in this process
  globalThis.__shipwatchScheduler = true;

  console.log(
    `[scheduler] background sync on — re-syncing ~${Math.round(BACKGROUND_SYNC_GAP_MS / 1000)}s after each run.`
  );
  void loop();
}

async function loop(): Promise<void> {
  await sleep(BACKGROUND_SYNC_STARTUP_DELAY_MS);
  for (;;) {
    try {
      await runSyncAndWait();
    } catch (err) {
      // runSyncAndWait already swallows sync errors; this only guards against
      // anything truly unexpected so the loop can never die.
      console.warn("[scheduler] unexpected error:", err instanceof Error ? err.message : err);
    }
    await sleep(BACKGROUND_SYNC_GAP_MS);
  }
}
