// TEMP diagnostic — delete after use.
try {
  process.loadEnvFile(".env.local");
} catch {}

import Database from "better-sqlite3";

async function main() {
  const { fetchShiprocketTracking } = await import("./interface/couriers/shiprocket");

  const db = new Database("data/shipwatch.db", { readonly: true });
  const UND = "status NOT IN ('Delivered','Cancelled') AND status NOT LIKE 'RTO%'";
  const rows = db
    .prepare(
      `select order_no, awb, status, edd, courier_live_status from orders
       where courier_slug='ship_rocket' and awb is not null and awb<>'' and ${UND}
       order by edd asc limit 20`
    )
    .all() as any[];

  console.log(`timing ${rows.length} ACTIVE ShipRocket AWBs (sequential, same as one sweep worker)\n`);
  let ok = 0;
  let totalMs = 0;
  for (const r of rows) {
    const t0 = Date.now();
    let out = "";
    try {
      const res = await fetchShiprocketTracking(r.awb);
      const ms = Date.now() - t0;
      totalMs += ms;
      if (res.found) ok++;
      out = `${String(ms).padStart(6)}ms  found=${res.found}  status=${res.last_status ?? res.status ?? "—"}  scans=${res.scans?.length ?? 0}`;
    } catch (e: any) {
      const ms = Date.now() - t0;
      totalMs += ms;
      out = `${String(ms).padStart(6)}ms  THREW: ${e?.message?.slice(0, 90)}`;
    }
    console.log(`${r.awb.padEnd(18)} ${String(r.status).padEnd(12)} ${out}`);
  }
  console.log(`\nfound ${ok}/${rows.length}   avg ${Math.round(totalMs / rows.length)}ms/awb   total ${Math.round(totalMs / 1000)}s`);
}

main().catch((e) => {
  console.error("DIAG FAILED:", e?.message ?? e);
  process.exit(1);
});

export {};
