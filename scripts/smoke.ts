// Smoke test (spec §11.2): connect → tools/list → list_orders {limit:2} → print.
// Run: npm run smoke

try {
  process.loadEnvFile(".env.local");
} catch {
  /* .env.local optional if env vars already set */
}

async function main() {
  const { listTools, callTool } = await import("../lib/mcp");

  console.log("Connecting to", (process.env.SHIP_MCP_URL ?? "").split("?")[0], "…");
  const tools = await listTools();
  console.log("tools/list →", tools.join(", "));

  const required = ["list_orders", "sla_performance", "ndr_analysis", "courier_performance"];
  const missing = required.filter((t) => !tools.includes(t));
  if (missing.length) {
    console.error("MISSING required tools:", missing.join(", "));
    process.exit(1);
  }

  const res = await callTool<{
    total_matched: number;
    has_more: boolean;
    orders: Record<string, unknown>[];
  }>("list_orders", { limit: 2 });

  console.log(`\nlist_orders {limit:2} → total_matched=${res.total_matched} has_more=${res.has_more}`);
  for (const o of res.orders) {
    console.log(
      ` - #${o.order_no} awb=${o.awb} status=${o.status} courier=${o.shipping_company}` +
        ` edd=${JSON.stringify(o.edd)} order_date=${o.order_date}`
    );
  }
  console.log("\nSmoke test OK ✅");
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke test FAILED ❌:", err.message ?? err);
  process.exit(1);
});
