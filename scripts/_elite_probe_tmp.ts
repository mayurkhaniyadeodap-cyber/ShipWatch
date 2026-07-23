// TEMP scratch: pull a few real Ekart AWBs from the cache to test the Elite API.
// Delete when the Elite integration is done.
import Database from "better-sqlite3";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "shipwatch.db"), {
  readonly: true,
  fileMustExist: true,
});

const byStatus = db
  .prepare(
    `SELECT status, COUNT(*) n FROM orders
     WHERE (shipping_company LIKE '%kart%' OR courier_slug LIKE '%kart%')
     GROUP BY status ORDER BY n DESC`
  )
  .all();
console.log("EKART ORDERS BY STATUS:");
console.log(JSON.stringify(byStatus, null, 2));

// A handful of AWBs across interesting statuses — prefer NDR / undelivered.
const sample = db
  .prepare(
    `SELECT awb, status, is_ndr, ndr_reason, courier_slug, shipping_company,
            edd, delivered_date, courier_live_status
     FROM orders
     WHERE awb IS NOT NULL AND awb <> ''
       AND (shipping_company LIKE '%kart%' OR courier_slug LIKE '%kart%')
     ORDER BY (status NOT IN ('Delivered','Cancelled')) DESC, is_ndr DESC, order_date DESC
     LIMIT 12`
  )
  .all();
console.log("\nSAMPLE AWBs:");
console.log(JSON.stringify(sample, null, 2));

db.close();
