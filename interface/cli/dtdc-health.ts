// DTDC tracking health check — run: npm run dtdc:health (from the project root).
//
// Three checks, exit 1 if any fails (so a watcher/loop can alert on it):
//   1. TOKENS  — every token in DTDC_TRACKING_TOKENS still gets a 2xx from the
//                tracking endpoint. A cross-account "Not Authorized" (206) still
//                proves the token is ALIVE; only a 401 means expired/revoked.
//                Dead tokens can't be re-minted here (we don't hold their
//                _trk_json passwords) — DTDC has to reissue, so alert fast.
//   2. AUTH    — every _trk_json login (currently GL11336) can still MINT a
//                fresh token via the authenticate endpoint.
//   3. DATA    — DTDC courier statuses are actually landing in the cache: some
//                row got a non-null courier_live_status in the last 24h, and
//                recently-checked in-flight rows aren't mostly status-less.

try {
  process.loadEnvFile(".env.local");
} catch {
  /* .env.local optional if env vars already set */
}

import https from "node:https";
import { URL } from "node:url";

const TRACK_URL =
  process.env.DTDC_API_BASE_URL?.trim() ||
  "https://blktracksvc.dtdc.com/dtdc-api/rest/JSONCnTrk/getTrackDetails";

// Same relaxed-TLS agent as lib/dtdc.ts (DTDC serves an incomplete cert chain).
const agent = new https.Agent({ rejectUnauthorized: false });

function post(url: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        agent,
        timeout: 20_000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout after 20s")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const { dtdcTrackingKeys, dtdcAuthAccounts, dtdcAuthenticate } = await import("../couriers/dtdc");
  const { getDb } = await import("../../backend/db");
  const db = getDb();

  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.error("FAIL:", msg);
  };

  // A recent 7D-series AWB — visible to its owner token, "Not Authorized" to the
  // rest; either response proves the token is alive.
  const probe = db
    .prepare(
      `SELECT awb FROM orders
       WHERE shipping_company LIKE '%DTDC%' AND awb LIKE '7D%'
       ORDER BY order_date DESC LIMIT 1`
    )
    .get() as { awb: string } | undefined;
  // Only the REAL DTDC-issued tracking tokens ("{cust}_trk_json:{hash}"). The
  // CSV's bare tracking_api_key values are booking keys the tracking endpoint
  // has ALWAYS 401'd (see dtdcTrackingKeys() in lib/dtdc.ts — they're a
  // last-resort there); flagging them every run would drown real expiries.
  const tokens = dtdcTrackingKeys().filter((t) => t.includes(":"));
  if (!probe) {
    console.log("TOKENS: no DTDC AWB in cache to probe with — skipping token check.");
  } else {
    console.log(`TOKENS: probing ${tokens.length} token(s) against ${probe.awb}`);
    for (const token of tokens) {
      const label = token.split(":")[0];
      try {
        const res = await post(
          TRACK_URL,
          { "x-access-token": token, "Content-Type": "application/json", Accept: "application/json" },
          JSON.stringify({ trkType: "cnno", strcnno: probe.awb, addtnlDtl: "Y" })
        );
        if (res.status === 401) {
          fail(`token ${label} is DEAD (401) — ask DTDC to reissue its tracking token.`);
        } else if (res.status < 200 || res.status >= 300) {
          fail(`token ${label} got unexpected HTTP ${res.status}: ${res.text.slice(0, 120)}`);
        } else {
          console.log(`  ok  ${label} (HTTP ${res.status})`);
        }
      } catch (err) {
        fail(`token ${label} probe errored: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Mintable logins — forceRefresh so the cache can't mask a broken password.
  const mintable = dtdcAuthAccounts().filter((a) => a.username.includes("_trk_json"));
  for (const acc of mintable) {
    try {
      await dtdcAuthenticate(acc.username, acc.password, true);
      console.log(`AUTH:   ok  ${acc.username} minted a fresh token`);
    } catch (err) {
      fail(`login ${acc.username} can no longer mint: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Data freshness: the sweep (plus panel fallback) should be writing statuses.
  const fresh = db
    .prepare(
      `SELECT COUNT(*) n FROM orders
       WHERE shipping_company LIKE '%DTDC%' AND courier_live_status IS NOT NULL
         AND courier_live_checked_at >= datetime('now', '-1 day')`
    )
    .get() as { n: number };
  const recent = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN courier_live_status IS NOT NULL THEN 1 ELSE 0 END) withStatus
       FROM orders
       WHERE shipping_company LIKE '%DTDC%' AND awb IS NOT NULL AND awb <> ''
         AND courier_live_checked_at >= datetime('now', '-1 day')`
    )
    .get() as { total: number; withStatus: number | null };
  if (fresh.n === 0) {
    fail("no DTDC row received a courier status in the last 24h — sweep not running or all lookups failing.");
  } else {
    const pct = recent.total ? Math.round((100 * (recent.withStatus ?? 0)) / recent.total) : 0;
    console.log(`DATA:   ok  ${fresh.n} DTDC rows got a status in the last 24h (${pct}% of checked rows have one)`);
    if (pct < 50) {
      fail(`only ${pct}% of DTDC rows checked in the last 24h have a status — a token or account gap is likely.`);
    }
  }

  console.log(failures === 0 ? "\nDTDC health OK ✅" : `\nDTDC health: ${failures} problem(s) ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("DTDC health check crashed ❌:", err.message ?? err);
  process.exit(1);
});
