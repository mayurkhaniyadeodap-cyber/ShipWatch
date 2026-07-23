"use client";

import { useMemo } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  canonStatus,
  fmtDay,
  fmtInt,
  fmtMoney,
  fmtStatus,
  SEVERITY_STYLES,
  severityKey,
  type OrderApiRow,
  type Tab,
} from "@/lib/client";

export type SortState = { key: string; dir: "asc" | "desc" };

const col = createColumnHelper<OrderApiRow>();

/** Semantic tone for an order status pill. */
function statusTone(status: string | null): "good" | "crit" | "warn" | "info" {
  const s = (status ?? "").toLowerCase();
  if (s.includes("deliver") && !s.includes("out")) return "good";
  if (s.includes("ndr") || s.includes("rto") || s.includes("lost") || s.includes("cancel")) return "crit";
  if (s.includes("out for")) return "warn";
  return "info";
}

const PILL_CLASS: Record<string, string> = {
  good: "bg-status-good-bg text-status-good-fg",
  crit: "bg-sev-red-bg text-sev-red-fg",
  warn: "bg-sev-amber-bg text-sev-amber-fg",
  info: "bg-status-info-bg text-status-info-fg",
};

/** Status as a pill, with a source dot: filled ● = courier-verified this sync,
 *  hollow ○ = shipping-panel value. The hybrid data model, made visible. */
function statusCell(status: string | null, courierLive: string | null): React.ReactNode {
  if (!status) return <span className="text-muted">—</span>;
  const tone = statusTone(status);
  const verified = !!courierLive;
  // Compare canonically: panel "InTransit" vs courier "In Transit" are the same.
  const mismatch = verified && canonStatus(courierLive!) !== canonStatus(status);
  return (
    <span className="inline-flex items-center gap-[6px]">
      <span className={`inline-flex items-center rounded-[6px] px-[7px] py-[2px] text-[11px] font-semibold ${PILL_CLASS[tone]}`}>
        {fmtStatus(status)}
      </span>
      <span
        title={
          verified
            ? `Courier-verified: ${courierLive}${mismatch ? ` (panel says ${status})` : ""}`
            : "From shipping panel (no courier confirmation yet)"
        }
        className={`h-[7px] w-[7px] shrink-0 rounded-full ${
          verified ? (mismatch ? "bg-sev-amber-fg" : "bg-brand") : "border-[1.5px] border-sub"
        }`}
      />
    </span>
  );
}

/** Colour for the leading severity stripe: by days-past-EDD. */
function stripeColor(row: OrderApiRow): string {
  const sev = severityKey(row.days_past_edd);
  return sev ? SEVERITY_STYLES[sev].dot : "var(--color-stripe-info)";
}

function daysBadge(days: number | null): React.ReactNode {
  if (days === null || days < 1) return <span className="text-muted">—</span>;
  const sev = severityKey(days)!;
  const s = SEVERITY_STYLES[sev];
  return (
    <span
      className="inline-flex rounded-full px-[9px] py-[2px] text-[11.5px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      {days} {days === 1 ? "day" : "days"}
    </span>
  );
}

/** Live courier-site status. Amber when it disagrees with the panel status. */
function courierStatusCell(live: string | null, panel: string | null): React.ReactNode {
  if (!live) return <span className="text-muted">—</span>;
  const mismatch = !!panel && canonStatus(live) !== canonStatus(panel);
  return (
    <span
      title={mismatch ? `Courier: ${live} · Panel: ${panel}` : live}
      className={`inline-block max-w-[160px] truncate rounded-[5px] px-[7px] py-[2px] align-middle text-[11px] font-medium ${
        mismatch ? "bg-sev-amber-bg text-sev-amber-fg" : "border border-line bg-chipbg text-ink-2"
      }`}
    >
      {live}
    </span>
  );
}

function reasonCell(reason: string | null, chip = false): React.ReactNode {
  if (!reason) return <span className="text-muted">—</span>;
  if (chip) {
    return (
      <span
        title={reason}
        className="inline-block max-w-[170px] truncate rounded-[5px] border border-line bg-chipbg px-[7px] py-[2px] align-middle text-[11px] font-medium text-ink-2"
      >
        {reason}
      </span>
    );
  }
  return (
    <span title={reason} className="block max-w-[150px] truncate text-[11.5px] text-sub">
      {reason}
    </span>
  );
}

/** Column metadata: sortKey (API sort param) + alignment. */
type Meta = { sortKey?: string; align?: "right"; stripe?: boolean };

export default function DataTable({
  tab,
  rows,
  total,
  page,
  pageSize,
  sort,
  onSort,
  onPage,
  onPageSize,
  onRowClick,
  syncing,
  loading,
  hasFilters,
  onClearFilters,
}: {
  tab: Tab;
  rows: OrderApiRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: SortState;
  onSort: (s: SortState) => void;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  onRowClick: (r: OrderApiRow) => void;
  syncing: boolean;
  loading: boolean;
  hasFilters: boolean;
  onClearFilters: () => void;
}) {
  const offset = (page - 1) * pageSize;

  const columns = useMemo<ColumnDef<OrderApiRow, unknown>[]>(() => {
    const stripe = col.display({
      id: "stripe",
      header: () => null,
      meta: { stripe: true } as Meta,
      cell: (info) => (
        <div className="h-[34px] w-[3px]" style={{ background: stripeColor(info.row.original) }} />
      ),
    });
    const sr = col.display({
      id: "sr",
      header: "Sr",
      cell: (info) => <span className="text-muted">{offset + info.row.index + 1}</span>,
    });
    const orderNo = col.accessor("order_no", {
      header: "Order no",
      meta: { sortKey: "order_no" } as Meta,
      cell: (info) => <span className="font-mono text-[12px] font-semibold text-brand">{info.getValue() ?? "—"}</span>,
    });
    const awb = col.accessor("awb", {
      header: "AWB",
      meta: { sortKey: "awb" } as Meta,
      cell: (info) => <span className="font-mono text-[12px] text-ink">{info.getValue() ?? "—"}</span>,
    });
    const orderDate = col.accessor("order_date", {
      header: "Order date",
      meta: { sortKey: "order_date" } as Meta,
      cell: (info) => fmtDay(info.getValue()),
    });
    const daysPast = col.accessor("days_past_edd", {
      id: "days_past_edd",
      header: "Days past EDD",
      meta: { sortKey: "days_past_edd" } as Meta,
      cell: (info) => daysBadge(info.getValue()),
    });
    const courier = col.accessor("shipping_company", {
      header: "Courier",
      meta: { sortKey: "courier" } as Meta,
      cell: (info) => <span className="font-medium">{info.getValue() ?? "—"}</span>,
    });
    const customer = col.accessor("customer_name", {
      header: "Customer",
      meta: { sortKey: "customer" } as Meta,
      cell: (info) => info.getValue() ?? "—",
    });
    const city = col.accessor("customer_city", {
      header: "City",
      meta: { sortKey: "city" } as Meta,
      cell: (info) => info.getValue() ?? "—",
    });
    const stateCol = col.accessor("customer_state", {
      header: "State",
      meta: { sortKey: "state" } as Meta,
      cell: (info) => info.getValue() ?? "—",
    });
    const pincode = col.accessor("pincode", {
      header: "Pincode",
      meta: { sortKey: "pincode" } as Meta,
      cell: (info) => <span className="tabular-nums text-ink-2">{info.getValue() ?? "—"}</span>,
    });
    const payment = col.accessor("payment_type", {
      header: "Payment",
      meta: { sortKey: "payment" } as Meta,
      cell: (info) => info.getValue() ?? "—",
    });
    const value = col.accessor("order_total", {
      header: "Order value",
      meta: { sortKey: "value", align: "right" } as Meta,
      cell: (info) => <span className="font-medium">{fmtMoney(info.getValue())}</span>,
    });
    const attempts = col.accessor("attempt_count", {
      header: "Attempts",
      meta: { sortKey: "attempts", align: "right" } as Meta,
      cell: (info) => info.getValue(),
    });
    // Live status pulled straight from the courier site on the last sync.
    const courierStatus = col.display({
      id: "courier_live_status",
      header: "Courier status",
      cell: (info) =>
        courierStatusCell(info.row.original.courier_live_status, info.row.original.status),
    });

    if (tab === "tat") {
      return [
        stripe,
        sr,
        orderNo,
        awb,
        orderDate,
        col.accessor("edd", {
          header: "EDD",
          meta: { sortKey: "edd" } as Meta,
          cell: (info) => fmtDay(info.getValue()),
        }),
        daysPast,
        col.accessor("status", {
          header: "Status",
          meta: { sortKey: "status" } as Meta,
          cell: (info) => statusCell(info.getValue(), info.row.original.courier_live_status),
        }),
        courierStatus,
        courier,
        customer,
        pincode,
        city,
        stateCol,
        payment,
        value,
        col.accessor("ndr_reason", {
          id: "reason",
          header: "NDR reason",
          meta: { sortKey: "reason" } as Meta,
          cell: (info) => reasonCell(info.getValue()),
        }),
        attempts,
      ] as ColumnDef<OrderApiRow, unknown>[];
    }
    return [
      stripe,
      sr,
      orderNo,
      orderDate,
      awb,
      col.accessor("status", {
        id: "ndr_status",
        header: "Status",
        cell: (info) => statusCell(info.getValue(), info.row.original.courier_live_status),
      }),
      col.accessor("ndr_reason", {
        id: "reason",
        header: "NDR reason",
        meta: { sortKey: "reason" } as Meta,
        cell: (info) => reasonCell(info.getValue(), true),
      }),
      attempts,
      col.accessor("days_since_update", {
        header: "Days since update",
        meta: { sortKey: "days_since_update", align: "right" } as Meta,
        cell: (info) => info.getValue() ?? "—",
      }),
      daysPast,
      courier,
      courierStatus,
      customer,
      col.accessor("customer_contact", {
        header: "Contact",
        meta: { sortKey: "contact" } as Meta,
        cell: (info) => <span className="text-ink-2">{info.getValue() ?? "—"}</span>,
      }),
      pincode,
      city,
      stateCol,
      payment,
      value,
    ] as ColumnDef<OrderApiRow, unknown>[];
  }, [tab, offset]);

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const colCount = columns.length;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div
      className="overflow-hidden rounded-[10px] border border-line bg-white transition-opacity"
      style={{ opacity: syncing ? 0.65 : 1 }}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px] tabular-nums">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = (h.column.columnDef.meta ?? {}) as Meta;
                  const sortable = !!meta.sortKey;
                  const isSorted = sortable && sort.key === meta.sortKey;
                  return (
                    <th
                      key={h.id}
                      onClick={
                        sortable
                          ? () =>
                              onSort({
                                key: meta.sortKey!,
                                dir: isSorted && sort.dir === "desc" ? "asc" : "desc",
                              })
                          : undefined
                      }
                      className={`sticky top-0 z-[5] whitespace-nowrap border-b border-line bg-thead text-[10.5px] font-semibold uppercase tracking-[0.04em] ${
                        meta.stripe ? "w-[3px] p-0" : "px-[10px] py-[7px]"
                      } ${meta.align === "right" ? "text-right" : "text-left"} ${
                        isSorted ? "text-brand" : "text-sub"
                      } ${sortable ? "cursor-pointer select-none hover:text-ink" : ""}`}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {isSorted ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              SKELETON_WIDTHS.map((w, i) => (
                <tr key={i}>
                  <td colSpan={colCount} className="border-b border-line-3 px-[14px] py-[13px]">
                    <div
                      className="h-[13px] rounded"
                      style={{
                        width: w,
                        background: "linear-gradient(90deg,#EEF1F4 25%,#E3E8EE 37%,#EEF1F4 63%)",
                        backgroundSize: "1000px 100%",
                        animation: "swShimmer 1.4s infinite linear",
                      }}
                    />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-5 py-[72px] text-center">
                  <div className="mx-auto mb-[14px] flex h-[46px] w-[46px] items-center justify-center rounded-full bg-line-3 text-xl text-muted">
                    ⌀
                  </div>
                  <div className="text-sm font-semibold text-ink">
                    {tab === "tat"
                      ? "No breached orders for this filter."
                      : "No NDR orders for this filter."}
                  </div>
                  <div className="mt-[5px] text-[12.5px] text-sub">
                    {hasFilters
                      ? "The current filter combination returned 0 orders."
                      : "Nothing in the last 6 months — nice."}
                  </div>
                  {hasFilters && (
                    <button
                      onClick={onClearFilters}
                      className="mt-4 h-8 cursor-pointer rounded-[7px] border border-brand-border bg-white px-4 text-[12.5px] font-semibold text-brand hover:bg-brand-tint"
                    >
                      Clear all filters
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((r, i) => (
                <tr
                  key={r.original.id}
                  onClick={() => onRowClick(r.original)}
                  className={`cursor-pointer hover:bg-brand-tint/50 ${i % 2 ? "bg-zebra" : "bg-white"}`}
                >
                  {r.getVisibleCells().map((c) => {
                    const meta = (c.column.columnDef.meta ?? {}) as Meta;
                    return (
                      <td
                        key={c.id}
                        className={`whitespace-nowrap border-b border-line-3 ${
                          meta.stripe ? "w-[3px] p-0" : "h-[34px] px-[10px]"
                        } ${meta.align === "right" ? "text-right" : ""}`}
                      >
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center gap-[14px] border-t border-line px-[14px] py-[10px] text-xs text-sub">
        <span>Rows per page</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="h-7 cursor-pointer rounded-md border border-line-2 bg-white px-2 font-semibold text-ink-2 outline-none"
        >
          {[50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="tabular-nums">
          {total === 0
            ? "0 results"
            : `${fmtInt(offset + 1)}–${fmtInt(Math.min(offset + pageSize, total))} of ${fmtInt(total)}`}
        </span>
        <div className="ml-auto flex items-center gap-1 tabular-nums">
          <PagerBtn label="‹" disabled={page <= 1} onClick={() => onPage(page - 1)} />
          {pageNumbers(page, lastPage).map((p, i) =>
            p === -1 ? (
              <span key={`e${i}`} className="flex h-7 w-7 items-center justify-center text-muted">
                …
              </span>
            ) : (
              <PagerBtn key={p} label={String(p)} active={p === page} onClick={() => onPage(p)} />
            )
          )}
          <PagerBtn label="›" disabled={page >= lastPage} onClick={() => onPage(page + 1)} />
        </div>
      </div>
    </div>
  );
}

const SKELETON_WIDTHS = ["96%", "88%", "93%", "82%", "90%", "86%", "94%", "78%"];

function pageNumbers(page: number, last: number): number[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const pages = new Set<number>([1, 2, page - 1, page, page + 1, last]);
  const list = [...pages].filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && list[i] - list[i - 1] > 1) out.push(-1);
    out.push(list[i]);
  }
  return out;
}

function PagerBtn({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled || active}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs ${
        active
          ? "border-brand bg-brand font-semibold text-white"
          : disabled
            ? "border-line-2 bg-white text-muted"
            : "cursor-pointer border-line-2 bg-white text-ink-2 hover:border-brand"
      }`}
    >
      {label}
    </button>
  );
}
