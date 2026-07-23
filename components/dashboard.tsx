"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Header from "./header";
import KpiCards, { type Kpi } from "./kpi-cards";
import FilterBar from "./filter-bar";
import CourierChips from "./courier-chips";
import DataTable, { type SortState } from "./data-table";
import Drawer from "./drawer";
import {
  EMPTY_FILTERS,
  filterParams,
  fmtInt,
  fmtMoneyCompact,
  getJson,
  hasActiveFilters,
  type FilterState,
  type ListResponse,
  type MetaResponse,
  type NdrKpis,
  type OrderApiRow,
  type SyncStatusResponse,
  type Tab,
  type TatKpis,
} from "@/lib/client";

const DEFAULT_SORT: Record<Tab, SortState> = {
  tat: { key: "days_past_edd", dir: "desc" },
  ndr: { key: "attempts", dir: "desc" },
};

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("tat");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT.tat);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [drawerRow, setDrawerRow] = useState<OrderApiRow | null>(null);

  // --- sync status (poll every 2s while running) ---
  const sync = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => getJson<SyncStatusResponse>("/api/sync/status"),
    refetchInterval: (q) => (q.state.data?.state === "running" ? 2000 : 30_000),
  });
  const syncing = sync.data?.state === "running";
  const lastSyncedAt = sync.data?.last_synced_at ?? null;

  // Refresh data queries when a sync completes (lastSyncedAt is in every key).
  const meta = useQuery({
    queryKey: ["meta", lastSyncedAt],
    queryFn: () => getJson<MetaResponse>("/api/meta"),
  });

  const listParams = useMemo(() => {
    const sp = filterParams(tab, filters);
    sp.set("sort", sort.key);
    sp.set("dir", sort.dir);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [tab, filters, sort, page, pageSize]);

  const list = useQuery({
    queryKey: ["list", tab, listParams, lastSyncedAt],
    queryFn: () => getJson<ListResponse>(`/api/${tab}?${listParams}`),
    // Keep the previous rows visible while paging/filtering WITHIN a tab, but
    // never across a tab switch: each tab has its own columns, so carrying rows
    // over renders (say) TAT orders under NDR headers with a blank reason and 0
    // attempts — and because a placeholder clears isLoading, that wrong data
    // shows as authoritative instead of as a skeleton.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === tab ? prev : undefined),
  });

  const kpis = useQuery({
    queryKey: ["kpis", tab, lastSyncedAt],
    queryFn: () => getJson<TatKpis | NdrKpis>(`/api/kpis?tab=${tab}`),
  });

  // If the current result set shrinks (e.g. a sync completes while paginated
  // deep into the list), snap back to the last valid page so the table doesn't
  // render an empty "no results" state over data that still exists.
  const total = list.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > lastPage) setPage(lastPage);
  }, [page, lastPage]);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setSort(DEFAULT_SORT[t]);
    setPage(1);
    setDrawerRow(null);
  }, []);

  const changeFilters = useCallback((f: FilterState) => {
    setFilters(f);
    setPage(1);
  }, []);

  // Sync is fully automatic: the server-side scheduler (lib/scheduler.ts) is the
  // sole driver, re-syncing on its own cadence 24/7. The dashboard no longer
  // triggers syncs — it just polls sync-status (above) and its data queries are
  // keyed on lastSyncedAt, so a completed background sync auto-refreshes the view.

  const exportHref = useCallback(
    (scope: "both" | "tat" | "ndr") => {
      // Exports carry ALL current filters; per-sheet extras (severity/reason)
      // only apply to their own list server-side.
      const sp = new URLSearchParams();
      if (filters.couriers.length) sp.set("couriers", filters.couriers.join(","));
      if (filters.search.trim()) sp.set("search", filters.search.trim());
      if (filters.payment) sp.set("payment", filters.payment);
      if (filters.state) sp.set("state", filters.state);
      if (filters.status) sp.set("status", filters.status);
      if (filters.pincode.trim()) sp.set("pincode", filters.pincode.trim());
      if (filters.severity) sp.set("severity", filters.severity);
      if (filters.reason) sp.set("reason", filters.reason);
      if (filters.minAttempts > 0) sp.set("minAttempts", String(filters.minAttempts));
      if (filters.dateFrom) sp.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) sp.set("dateTo", filters.dateTo);
      sp.set("sort", sort.key);
      sp.set("dir", sort.dir);
      sp.set("scope", scope);
      return `/api/export?${sp.toString()}`;
    },
    [filters, sort]
  );

  const kpiCards: Kpi[] = useMemo(() => {
    const d = kpis.data;
    if (!d) return [];
    if (d.tab === "tat") {
      return [
        { label: "Breached orders", value: fmtInt(d.breached), sub: "past EDD, undelivered", tone: "crit" },
        { label: "Stuck value", value: fmtMoneyCompact(d.stuck_value), sub: "across breached orders" },
        { label: "Avg days past EDD", value: d.avg_days.toFixed(1), sub: "per breached order" },
        {
          label: "Worst courier",
          value: d.worst_courier?.courier ?? "—",
          sub: d.worst_courier ? `${fmtInt(d.worst_courier.count)} breached` : "no data",
        },
      ];
    }
    return [
      { label: "NDR orders", value: fmtInt(d.ndr_count), sub: "awaiting re-attempt", tone: "crit" },
      { label: "Avg attempts", value: d.avg_attempts.toFixed(2), sub: "per NDR order" },
      {
        label: "Top reason",
        value: d.top_reason?.reason ?? "—",
        sub: d.top_reason ? `${fmtInt(d.top_reason.count)} orders` : "no data",
      },
      {
        label: "COD share",
        value: d.ndr_count ? `${Math.round((d.cod_count / d.ndr_count) * 100)}%` : "—",
        sub: `${fmtInt(d.cod_count)} of ${fmtInt(d.ndr_count)}`,
      },
    ];
  }, [kpis.data]);

  const firstLoad = list.isLoading || (syncing && (sync.data?.orders ?? 0) === 0);

  return (
    <div className="min-h-screen min-w-[1280px]">
      <Header
        tab={tab}
        onTab={switchTab}
        tatCount={meta.data?.counts.tat ?? null}
        ndrCount={meta.data?.counts.ndr ?? null}
        sync={sync.data}
        exportHref={exportHref}
      />

      <main className="flex flex-col gap-[14px] px-7 pb-7 pt-5">
        {sync.data?.state === "error" && (
          <div className="flex items-center gap-3 rounded-[10px] border border-sev-red-fg/30 bg-sev-red-bg px-4 py-3 text-[13px] font-medium text-sev-red-fg">
            <span className="font-bold">Last sync failed:</span>
            <span className="min-w-0 flex-1 truncate" title={sync.data.error ?? ""}>
              {sync.data.error}
            </span>
            <span className="shrink-0 text-xs text-sev-red-fg/80">retrying automatically…</span>
          </div>
        )}
        {list.isError && (
          <div className="rounded-[10px] border border-sev-red-fg/30 bg-sev-red-bg px-4 py-3 text-[13px] font-medium text-sev-red-fg">
            Failed to load orders: {(list.error as Error).message}
          </div>
        )}

        <KpiCards kpis={kpiCards} loading={!kpis.data} />

        <FilterBar tab={tab} filters={filters} onChange={changeFilters} meta={meta.data} />

        <CourierChips
          byCourier={list.data?.byCourier ?? []}
          totalAll={(list.data?.byCourier ?? []).reduce((a, c) => a + c.count, 0)}
          selected={filters.couriers}
          onToggle={(c) =>
            changeFilters({
              ...filters,
              couriers: filters.couriers.includes(c)
                ? filters.couriers.filter((x) => x !== c)
                : [...filters.couriers, c],
            })
          }
          onClear={() => changeFilters({ ...filters, couriers: [] })}
        />

        <DataTable
          tab={tab}
          rows={list.data?.rows ?? []}
          total={list.data?.total ?? 0}
          page={page}
          pageSize={pageSize}
          sort={sort}
          onSort={(s) => {
            setSort(s);
            setPage(1);
          }}
          onPage={setPage}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
          onRowClick={setDrawerRow}
          syncing={syncing && !firstLoad}
          loading={firstLoad}
          hasFilters={hasActiveFilters(filters)}
          onClearFilters={() => changeFilters(EMPTY_FILTERS)}
        />
      </main>

      {drawerRow && <Drawer tab={tab} row={drawerRow} onClose={() => setDrawerRow(null)} />}
    </div>
  );
}
