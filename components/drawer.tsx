"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  canonStatus,
  fmtDate,
  fmtMoney,
  getJson,
  type OrderApiRow,
  type OrderStatusResponse,
  type Tab,
} from "@/lib/client";

export default function Drawer({ tab, row, onClose }: { tab: Tab; row: OrderApiRow; onClose: () => void }) {
  // Rows are clickable, so the drawer is reachable from the keyboard — it needs
  // a keyboard way out too. Escape closes it, and focus moves to the close
  // button on open and back to the invoking row on unmount, so a keyboard user
  // isn't left tabbing through the table behind the overlay.
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  const identifier = row.awb ?? row.order_no ?? "";
  const courier = row.shipping_company ?? "";
  const scan = useQuery({
    queryKey: ["order-status", identifier, courier],
    queryFn: () =>
      getJson<OrderStatusResponse>(
        `/api/order-status?identifier=${encodeURIComponent(identifier)}&courier=${encodeURIComponent(courier)}`
      ),
    enabled: identifier !== "",
    staleTime: 60_000,
  });

  const isNdr = tab === "ndr" || row.status === "NDR";
  const breached = row.days_past_edd !== null && row.days_past_edd >= 1;

  const fields: Array<[string, string]> = [
    ["Customer", row.customer_name ?? "—"],
    ["Contact", row.customer_contact ?? "—"],
    ["City", row.customer_city ?? "—"],
    ["State", row.customer_state ?? "—"],
    ["Payment", row.payment_type ?? "—"],
    ["Order value", fmtMoney(row.order_total)],
    ["NDR reason", row.ndr_reason ?? "—"],
    ["Attempts", String(row.attempt_count)],
    ["Order date", fmtDate(row.order_date)],
    ["Dispatched at", fmtDate(row.dispatched_at)],
    ["Pickup date", fmtDate(row.pickup_date)],
    ["EDD", fmtDate(row.edd)],
    ["Last status update", fmtDate(row.last_status_updated_at)],
    ["Shipping method", row.shipping_method ?? "—"],
    ["Warehouse", row.warehouse ?? "—"],
    ["Seller", row.seller_name ?? row.dropshipper_name ?? "—"],
    ["Marketplace order", row.marketplace_order_id ?? "—"],
    ["Pincode", row.pincode ?? "—"],
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-[rgba(15,23,32,0.32)]" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${row.order_no ?? row.id}`}
        className="fixed bottom-0 right-0 top-0 z-50 flex w-[424px] max-w-full flex-col border-l border-line bg-white shadow-[-16px_0_40px_rgba(15,23,32,0.14)]"
      >
        <div className="border-b border-line px-5 pb-[14px] pt-[18px]">
          <div className="flex items-center gap-[10px]">
            <div className="text-base font-bold">Order {row.order_no ?? row.id}</div>
            <span className="rounded-full border border-line bg-chipbg px-[9px] py-[2px] text-[11px] font-semibold text-ink-2">
              {row.status ?? "—"}
            </span>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close order details"
              className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-base text-sub hover:bg-canvas"
            >
              ×
            </button>
          </div>
          <div className="mt-[3px] text-xs text-sub">
            Placed {fmtDate(row.order_date)} · {row.shipping_company ?? "—"}
            {row.shipping_method ? ` · ${row.shipping_method}` : ""}
          </div>
        </div>

        <div className="flex flex-col gap-[14px] overflow-auto px-5 py-4">
          {/* AWB + copy */}
          <div className="flex items-center gap-[10px] rounded-lg border border-line bg-thead px-3 py-[10px]">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-sub">AWB</div>
              <div className="mt-[1px] text-[13.5px] font-semibold tabular-nums">{row.awb ?? "—"}</div>
            </div>
            <CopyButton value={row.awb} label="Copy AWB" className="ml-auto" />
          </div>

          {/* Breach banner */}
          {breached && (
            <div className="rounded-lg bg-sev-red-bg px-3 py-[10px] text-[12.5px] font-semibold text-sev-red-fg">
              {row.days_past_edd} {row.days_past_edd === 1 ? "day" : "days"} past EDD · promised {fmtDate(row.edd)}
              {isNdr && row.attempt_count > 0
                ? ` · ${row.attempt_count} failed ${row.attempt_count === 1 ? "attempt" : "attempts"}`
                : ""}
            </div>
          )}

          {/* Field grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {fields.map(([label, value]) => (
              <div key={label}>
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-sub">{label}</div>
                <div className="mt-[2px] break-words text-[13px] font-medium tabular-nums">{value}</div>
              </div>
            ))}
          </div>

          {/* Delivery location */}
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-sub">Delivery location</div>
            <div className="mt-[2px] text-[13px] leading-[1.5]">
              {[row.customer_city, row.customer_state, row.pincode].filter(Boolean).join(", ") || "—"}
            </div>
          </div>

          {/* Courier site vs Shipping panel comparison */}
          <StatusComparison
            row={row}
            scan={scan.data}
            loading={scan.isLoading}
            error={scan.isError}
          />
        </div>

        <div className="mt-auto flex gap-[10px] border-t border-line px-5 py-[14px]">
          <CopyButton value={row.awb} label="Copy AWB" primary className="flex-1" />
          <CopyButton value={row.order_no} label="Copy order no" />
        </div>
      </aside>
    </>
  );
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Side-by-side comparison of the courier's own live tracking ("Courier site")
 *  against the synced shipping-panel record. */
function StatusComparison({
  row,
  scan,
  loading,
  error,
}: {
  row: OrderApiRow;
  scan: OrderStatusResponse | undefined;
  loading: boolean;
  error: boolean;
}) {
  // The courier column is only real when the courier's own API answered.
  const live = scan?.source === "courier" && scan.found ? scan : null;

  const courierStatus = live ? str(live.last_status ?? live.status) : null;
  const panelStatus = str(row.status);
  const mismatch =
    !!courierStatus && !!panelStatus && canonStatus(courierStatus) !== canonStatus(panelStatus);

  const rows: Array<[string, string | null, string | null]> = [
    ["Status", courierStatus, panelStatus],
    [
      "Last update",
      live ? str(live.current_timestamp) : null,
      str(row.last_status_updated_at ? fmtDate(row.last_status_updated_at) : null),
    ],
    ["NDR reason", live ? str(live.reason) : null, str(row.ndr_reason)],
    [
      "Location",
      live ? str(live.last_center ?? live.destination) : null,
      [row.customer_city, row.customer_state].filter(Boolean).join(", ") || null,
    ],
  ];

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-sub">
          Courier site vs Shipping panel
        </div>
        {mismatch && (
          <span className="rounded-full bg-sev-red-bg px-[7px] py-[1px] text-[10px] font-semibold text-sev-red-fg">
            Mismatch
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-thead text-left text-[10.5px] font-semibold uppercase tracking-[0.03em] text-sub">
              <th className="w-[86px] p-[8px] font-semibold">Field</th>
              <th className="p-[8px] font-semibold">Courier site</th>
              <th className="p-[8px] font-semibold">Shipping panel</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, courierVal, panelVal], i) => {
              const highlight = label === "Status" && mismatch;
              return (
                <tr key={label} className={i % 2 ? "bg-zebra" : "bg-white"}>
                  <td className="border-t border-line-3 p-[8px] align-top text-[10.5px] font-semibold uppercase tracking-[0.03em] text-sub">
                    {label}
                  </td>
                  <td
                    className={`border-t border-line-3 p-[8px] align-top break-words ${
                      highlight ? "font-semibold text-sev-red-fg" : "text-ink"
                    }`}
                  >
                    {loading && label === "Status" ? (
                      <span className="text-sub">Fetching…</span>
                    ) : (
                      courierVal ?? <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="border-t border-line-3 p-[8px] align-top break-words text-ink">
                    {panelVal ?? <span className="text-muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Provenance / fallback note */}
      <div className="mt-[6px] text-[11px] text-sub">
        {error ? (
          <span className="text-sev-red-fg">Could not reach the courier site — showing panel data only.</span>
        ) : loading ? (
          "Fetching live status from the courier…"
        ) : live ? (
          "Courier column is live from the courier's own tracking API."
        ) : scan?.source === "panel" ? (
          "No direct courier integration for this courier — both columns reflect the shipping panel."
        ) : (
          "No live status found for this AWB on the courier site."
        )}
      </div>
    </div>
  );
}

/** Copy `text`, returning whether it landed. Uses the async Clipboard API when
 *  available (HTTPS / localhost) and falls back to a hidden-textarea
 *  execCommand for plain-http LAN origins, where navigator.clipboard is absent. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or blocked — fall through to the legacy path.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({
  value,
  label,
  primary,
  className = "",
}: {
  value: string | null;
  label: string;
  primary?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      disabled={!value}
      onClick={() => {
        if (!value) return;
        // navigator.clipboard only exists in a secure context. This portal is
        // routinely opened over the LAN (http://<ip>:3000), where it's
        // undefined — an unguarded call throws inside the handler. Fall back to
        // the legacy execCommand path so Copy still works there.
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`h-[30px] cursor-pointer rounded-[7px] border px-[13px] text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
        primary
          ? "h-[34px] border-brand bg-brand text-[12.5px] text-white hover:bg-brand-dark"
          : "border-brand-border bg-white text-brand hover:bg-brand-tint"
      } ${className}`}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
