// Next.js server startup hook. `register()` runs once when the server process
// boots — we use it to start the 24/7 background sync loop so the cache stays
// fresh even with no browser tab open. Guarded to the Node.js runtime so it
// never fires during `next build` or in an edge runtime.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundSync } = await import("@/lib/scheduler");
    startBackgroundSync();
  }
}
