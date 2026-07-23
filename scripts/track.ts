// Standalone courier status fetcher.
//
// Fetches live status straight from a courier's own API (no shipping panel, no
// DB sync) and prints the normalized { status, last_status, … } envelope.
//
// Usage:
//   npx tsx scripts/track.ts "<Courier>" <AWB>
//
// Examples:
//   npx tsx scripts/track.ts "Amazon ATS"  AZ33418875IN
//   npx tsx scripts/track.ts ShipRocket    1491234567890
//   npx tsx scripts/track.ts Ekart         FMPP1234567890
//   npx tsx scripts/track.ts Trackon       123456789
//   npx tsx scripts/track.ts "Shree Maruti" SM123456789
//   npx tsx scripts/track.ts "Shree Anjani" 987654321
//
// Credentials are read from .env.local (env vars) first, then from
// shipping_courier_credentials.csv in the project root — same resolution the app
// uses. --json prints the full raw response instead of the summary.

try {
  process.loadEnvFile(".env.local");
} catch {
  /* .env.local optional if the env vars / CSV are already in place */
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");

  // Last token is the AWB/tracking id; everything before it is the courier name
  // (so "Amazon ATS" works quoted OR unquoted).
  const awb = rest.pop();
  const courier = rest.join(" ").trim();

  if (!courier || !awb) {
    console.error('Usage: npx tsx scripts/track.ts "<Courier>" <AWB> [--json]');
    console.error("Couriers: Ekart | ShipRocket | Trackon | Amazon ATS | Shree Maruti | Shree Anjani");
    process.exit(2);
  }

  // Imported lazily so a bad argv exits before any module (DB, credentials CSV)
  // is touched.
  const { resolveDirectCourier, statusText } = await import("../lib/courier-tracking");

  const direct = resolveDirectCourier(courier);
  if (!direct) {
    console.error(
      `No direct integration is configured for "${courier}".\n` +
        `Either the name isn't recognized, or its credentials are missing ` +
        `(check .env.local / shipping_courier_credentials.csv).`
    );
    process.exit(1);
  }

  console.log(`Tracking ${courier} ${awb} …\n`);
  const res = await direct.fetch(awb);

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }

  const scans = Array.isArray(res.scans) ? res.scans : [];
  console.log(`found            ${res.found}`);
  console.log(`status           ${statusText(res) ?? "—"}`);
  console.log(`normalized       ${res.normalized_status ?? "—"}`);
  console.log(`reason           ${res.reason ?? "—"}`);
  console.log(`last update       ${res.current_timestamp ?? "—"}`);
  console.log(`last center      ${res.last_center ?? "—"}`);
  console.log(`destination      ${res.destination ?? "—"}`);
  console.log(`expected deliv.  ${res.expected_delivery ?? "—"}`);
  console.log(`scans            ${scans.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nTracking FAILED ❌:", err?.message ?? err);
  process.exit(1);
});

export {}; // isolate module scope (keeps `main` out of the shared script global)
