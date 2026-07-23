"use client";

import { useEffect, useState } from "react";
import Dropdown from "./dropdown";
import {
  fmtInt,
  fmtStatus,
  hasActiveFilters,
  SEVERITY_STYLES,
  type FilterState,
  type MetaResponse,
  type Tab,
} from "@/lib/client";

const SEVERITIES = [
  { key: "1-2", label: "1–2 days" },
  { key: "3-5", label: "3–5 days" },
  { key: "6-10", label: "6–10 days" },
  { key: "10+", label: "10+ days" },
];

export default function FilterBar({
  tab,
  filters,
  onChange,
  meta,
}: {
  tab: Tab;
  filters: FilterState;
  onChange: (f: FilterState) => void;
  meta: MetaResponse | undefined;
}) {
  // Debounced search input.
  //
  // `filters` MUST stay in the deps: the pending timer closes over it, so
  // omitting it lets a filter changed inside the 300ms window (a courier chip,
  // the state dropdown, …) be silently reverted when the timer fires with the
  // stale object. The `searchInput !== filters.search` guard is what keeps this
  // from looping once onChange commits.
  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => setSearchInput(filters.search), [filters.search]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== filters.search) onChange({ ...filters, search: searchInput });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters, onChange]);

  // Debounced pincode input (prefix match server-side). Same deps rule as above.
  const [pincodeInput, setPincodeInput] = useState(filters.pincode);
  useEffect(() => setPincodeInput(filters.pincode), [filters.pincode]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (pincodeInput !== filters.pincode) onChange({ ...filters, pincode: pincodeInput });
    }, 300);
    return () => clearTimeout(t);
  }, [pincodeInput, filters, onChange]);

  const couriers = (tab === "tat" ? meta?.tatByCourier : meta?.ndrByCourier) ?? [];

  return (
    <div className="flex flex-wrap items-center gap-[10px] rounded-[10px] border border-line bg-white px-[14px] py-[10px]">
      {/* Courier multi-select */}
      <Dropdown
        width={280}
        trigger={() => (
          <button className="flex h-8 cursor-pointer items-center gap-[6px] rounded-[7px] border border-line-2 bg-white px-[11px] text-[12.5px] text-ink-2 hover:border-brand-border">
            Courier ·{" "}
            {filters.couriers.length === 0 ? `All (${couriers.length})` : `${filters.couriers.length} selected`}
            <span className="text-[9px] text-sub">▾</span>
          </button>
        )}
      >
        {() => (
          <div className="max-h-72 overflow-auto">
            {couriers.map((c) => {
              const checked = filters.couriers.includes(c.courier);
              return (
                <label
                  key={c.courier}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-[11px] py-[7px] text-[12.5px] hover:bg-canvas"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange({
                        ...filters,
                        couriers: checked
                          ? filters.couriers.filter((x) => x !== c.courier)
                          : [...filters.couriers, c.courier],
                      })
                    }
                    className="accent-[#0E766E]"
                  />
                  <span className="flex-1">{c.courier}</span>
                  <span className="font-semibold tabular-nums text-sub">{fmtInt(c.count)}</span>
                </label>
              );
            })}
            {couriers.length === 0 && <div className="px-3 py-2 text-xs text-sub">No data yet</div>}
          </div>
        )}
      </Dropdown>

      {/* Search */}
      <div className="box-border flex h-8 w-[250px] items-center gap-[7px] rounded-[7px] border border-line-2 bg-white px-[11px]">
        <span className="text-[13px] leading-none text-muted">⌕</span>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Order no, AWB or customer"
          className="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
        />
      </div>

      {tab === "tat" ? (
        /* Severity chips */
        <div className="flex items-center gap-[6px]">
          <span className="mr-[2px] text-[11.5px] text-sub">Days past EDD</span>
          {SEVERITIES.map((s) => {
            const selected = filters.severity === s.key;
            return (
              <button
                key={s.key}
                onClick={() => onChange({ ...filters, severity: selected ? null : s.key })}
                className={`flex h-7 cursor-pointer items-center gap-[6px] rounded-full border px-[11px] text-xs ${
                  selected
                    ? "border-brand bg-brand-tint font-semibold text-brand"
                    : "border-line-2 bg-white font-medium text-ink-2 hover:border-brand-border"
                }`}
              >
                <span
                  className="h-[7px] w-[7px] rounded-full"
                  style={{ background: SEVERITY_STYLES[s.key].dot }}
                />
                {s.label}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {/* NDR reason */}
          <Dropdown
            width={380}
            trigger={() => (
              <button className="flex h-8 max-w-[280px] cursor-pointer items-center gap-[6px] rounded-[7px] border border-line-2 bg-white px-[11px] text-[12.5px] text-ink-2 hover:border-brand-border">
                <span className="truncate">NDR reason · {filters.reason ?? "All"}</span>
                <span className="text-[9px] text-sub">▾</span>
              </button>
            )}
          >
            {(close) => (
              <div className="max-h-72 overflow-auto">
                <button
                  onClick={() => {
                    onChange({ ...filters, reason: null });
                    close();
                  }}
                  className="block w-full cursor-pointer rounded-md px-[11px] py-[7px] text-left text-[12.5px] hover:bg-canvas"
                >
                  All reasons
                </button>
                {(meta?.reasons ?? []).map((r) => (
                  <button
                    key={r.reason}
                    onClick={() => {
                      onChange({ ...filters, reason: r.reason });
                      close();
                    }}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-[11px] py-[7px] text-left text-xs hover:bg-canvas ${
                      filters.reason === r.reason ? "bg-brand-tint text-brand" : ""
                    }`}
                  >
                    <span className="flex-1 truncate" title={r.reason}>
                      {r.reason}
                    </span>
                    <span className="font-semibold tabular-nums text-sub">{fmtInt(r.count)}</span>
                  </button>
                ))}
              </div>
            )}
          </Dropdown>

          {/* Min attempts stepper */}
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-sub">Min attempts</span>
            <div className="flex items-center overflow-hidden rounded-[7px] border border-line-2 bg-white">
              <button
                onClick={() => onChange({ ...filters, minAttempts: Math.max(0, filters.minAttempts - 1) })}
                className="h-[30px] w-7 cursor-pointer text-sm text-sub hover:bg-canvas"
              >
                −
              </button>
              <span className="w-7 border-x border-line-3 text-center text-[12.5px] font-semibold leading-[30px] tabular-nums">
                {filters.minAttempts}
              </span>
              <button
                onClick={() => onChange({ ...filters, minAttempts: filters.minAttempts + 1 })}
                className="h-[30px] w-7 cursor-pointer text-sm text-sub hover:bg-canvas"
              >
                +
              </button>
            </div>
          </div>
        </>
      )}

      {/* COD / Prepaid toggle */}
      <div className="flex overflow-hidden rounded-[7px] border border-line-2">
        {(["COD", "Prepaid"] as const).map((p, i) => (
          <button
            key={p}
            onClick={() => onChange({ ...filters, payment: filters.payment === p ? null : p })}
            className={`flex h-[30px] cursor-pointer items-center px-3 text-xs font-medium ${
              i === 1 ? "border-l border-line-2" : ""
            } ${filters.payment === p ? "bg-brand font-semibold text-white" : "bg-white text-ink-2 hover:bg-canvas"}`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Status dropdown (TAT tab only — NDR tab is single-status) */}
      {tab === "tat" && (
        <Dropdown
          width={220}
          trigger={() => (
            <button className="flex h-8 cursor-pointer items-center gap-[6px] rounded-[7px] border border-line-2 bg-white px-[11px] text-[12.5px] text-ink-2 hover:border-brand-border">
              Status · {filters.status ? fmtStatus(filters.status) : "All"}
              <span className="text-[9px] text-sub">▾</span>
            </button>
          )}
        >
          {(close) => (
            <div className="max-h-72 overflow-auto">
              <button
                onClick={() => {
                  onChange({ ...filters, status: null });
                  close();
                }}
                className="block w-full cursor-pointer rounded-md px-[11px] py-[7px] text-left text-[12.5px] hover:bg-canvas"
              >
                All statuses
              </button>
              {(meta?.statuses ?? []).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    onChange({ ...filters, status: s });
                    close();
                  }}
                  className={`block w-full cursor-pointer rounded-md px-[11px] py-[7px] text-left text-[12.5px] hover:bg-canvas ${
                    filters.status === s ? "bg-brand-tint text-brand" : ""
                  }`}
                >
                  {fmtStatus(s)}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
      )}

      {/* Order date range */}
      <div className="box-border flex h-8 items-center gap-[6px] rounded-[7px] border border-line-2 bg-white px-[11px]">
        <span className="text-[11.5px] text-sub">Order date</span>
        <input
          type="date"
          value={filters.dateFrom ?? ""}
          max={filters.dateTo ?? undefined}
          onChange={(e) => onChange({ ...filters, dateFrom: e.target.value || null })}
          className="bg-transparent text-[12.5px] tabular-nums text-ink outline-none [color-scheme:light]"
        />
        <span className="text-[11px] text-muted">→</span>
        <input
          type="date"
          value={filters.dateTo ?? ""}
          min={filters.dateFrom ?? undefined}
          onChange={(e) => onChange({ ...filters, dateTo: e.target.value || null })}
          className="bg-transparent text-[12.5px] tabular-nums text-ink outline-none [color-scheme:light]"
        />
      </div>

      {/* State dropdown */}
      <Dropdown
        width={240}
        trigger={() => (
          <button className="flex h-8 cursor-pointer items-center gap-[6px] rounded-[7px] border border-line-2 bg-white px-[11px] text-[12.5px] text-ink-2 hover:border-brand-border">
            State · {filters.state ?? "All"}
            <span className="text-[9px] text-sub">▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="max-h-72 overflow-auto">
            <button
              onClick={() => {
                onChange({ ...filters, state: null });
                close();
              }}
              className="block w-full cursor-pointer rounded-md px-[11px] py-[7px] text-left text-[12.5px] hover:bg-canvas"
            >
              All states
            </button>
            {(meta?.states ?? []).map((s) => (
              <button
                key={s}
                onClick={() => {
                  onChange({ ...filters, state: s });
                  close();
                }}
                className={`block w-full cursor-pointer rounded-md px-[11px] py-[7px] text-left text-[12.5px] hover:bg-canvas ${
                  filters.state === s ? "bg-brand-tint text-brand" : ""
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </Dropdown>

      {/* Pincode */}
      <div className="box-border flex h-8 w-[140px] items-center gap-[7px] rounded-[7px] border border-line-2 bg-white px-[11px]">
        <span className="text-[11px] leading-none text-muted">◈</span>
        <input
          value={pincodeInput}
          onChange={(e) => setPincodeInput(e.target.value.replace(/[^0-9]/g, ""))}
          inputMode="numeric"
          maxLength={6}
          placeholder="Pincode"
          className="w-full bg-transparent text-[12.5px] tabular-nums text-ink outline-none placeholder:text-muted"
        />
      </div>

      <div className="flex-1" />
      {hasActiveFilters(filters) && (
        <button
          onClick={() =>
            onChange({ couriers: [], search: "", payment: null, state: null, status: null, pincode: "", severity: null, reason: null, minAttempts: 0, dateFrom: null, dateTo: null })
          }
          className="cursor-pointer text-[12.5px] font-semibold text-brand hover:text-brand-dark"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
