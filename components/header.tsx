"use client";

import Dropdown from "./dropdown";
import { fmtInt, relativeTime, type SyncStatusResponse, type Tab } from "@/lib/client";

export default function Header({
  tab,
  onTab,
  tatCount,
  ndrCount,
  sync,
  exportHref,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  tatCount: number | null;
  ndrCount: number | null;
  sync: SyncStatusResponse | undefined;
  exportHref: (scope: "both" | "tat" | "ndr") => string;
}) {
  const syncing = sync?.state === "running";
  return (
    <header className="flex h-16 items-center gap-5 border-b border-line bg-white px-7">
      <div className="flex items-center gap-[10px]">
        <div
          className="flex h-[28px] w-[28px] items-center justify-center rounded-lg text-sm font-bold text-white"
          style={{ background: "linear-gradient(150deg, var(--color-brand), var(--color-brand-dark))" }}
        >
          S
        </div>
        <div>
          <div className="text-[14px] font-bold leading-[1.2] tracking-[-0.02em]">ShipWatch</div>
          <div className="text-[10px] uppercase leading-[1.3] tracking-[0.04em] text-sub">
            TAT · NDR — courier-verified
          </div>
        </div>
      </div>

      <nav className="ml-4 flex gap-[2px] self-stretch">
        <TabButton
          label={`TAT Breach${tatCount !== null ? ` (${fmtInt(tatCount)})` : ""}`}
          active={tab === "tat"}
          onClick={() => onTab("tat")}
        />
        <TabButton
          label={`NDR Orders${ndrCount !== null ? ` (${fmtInt(ndrCount)})` : ""}`}
          active={tab === "ndr"}
          onClick={() => onTab("ndr")}
        />
      </nav>

      <div className="ml-auto flex items-center gap-3">
        {/* Sync runs automatically in the background (server-side scheduler).
            No manual controls — just a live status readout so users can see the
            data is fresh and when it's updating. */}
        {syncing ? (
          <span className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-brand tabular-nums">
            <span className="inline-block h-[12px] w-[12px] animate-spin rounded-full border-2 border-brand-border border-t-brand" />
            Updating… page {sync?.page ?? 0}
            {sync?.total_pages ? `/${sync.total_pages}` : ""}
          </span>
        ) : (
          <span className="whitespace-nowrap text-xs text-sub">
            Last synced {relativeTime(sync?.last_synced_at ?? null)}
            {sync ? ` · ${fmtInt(sync.orders)} orders` : ""}
          </span>
        )}

        <div className="flex">
          <a
            href={exportHref("both")}
            className="flex h-[34px] items-center rounded-l-[7px] border border-r-0 border-line-btn bg-white px-[14px] text-[12.5px] font-semibold text-ink-2 hover:bg-canvas"
          >
            Export Excel
          </a>
          <Dropdown
            align="right"
            width={256}
            trigger={() => (
              <button className="h-[34px] w-[30px] cursor-pointer rounded-r-[7px] border border-line-btn bg-white text-[10px] text-sub hover:bg-canvas">
                ▾
              </button>
            )}
          >
            {(close) => (
              <>
                <ExportOption
                  href={exportHref("both")}
                  title="Both lists (1 file, 2 sheets)"
                  sub="TAT Breach + NDR Orders sheets"
                  highlight
                  onClick={close}
                />
                <ExportOption
                  href={exportHref("tat")}
                  title="TAT Breach only"
                  sub={tatCount !== null ? `${fmtInt(tatCount)} rows` : "current filters"}
                  onClick={close}
                />
                <ExportOption
                  href={exportHref("ndr")}
                  title="NDR only"
                  sub={ndrCount !== null ? `${fmtInt(ndrCount)} rows` : "current filters"}
                  onClick={close}
                />
              </>
            )}
          </Dropdown>
        </div>
      </div>
    </header>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex cursor-pointer items-center border-b-2 px-4 text-[13px] ${
        active
          ? "border-brand font-semibold text-brand"
          : "border-transparent font-medium text-sub hover:text-ink-2"
      }`}
    >
      {label}
    </button>
  );
}

function ExportOption({
  href,
  title,
  sub,
  highlight,
  onClick,
}: {
  href: string;
  title: string;
  sub: string;
  highlight?: boolean;
  onClick: () => void;
}) {
  return (
    <a
      href={href}
      onClick={onClick}
      className={`block rounded-md px-[11px] py-[9px] ${highlight ? "bg-brand-tint" : "hover:bg-canvas"}`}
    >
      <div className={`text-[12.5px] font-semibold ${highlight ? "text-brand" : "text-ink-2"}`}>{title}</div>
      <div className="mt-[1px] text-[11px] text-sub">{sub}</div>
    </a>
  );
}
