"use client";

export type Kpi = { label: string; value: string; sub: string; tone?: "crit" | "accent" };

export default function KpiCards({ kpis, loading }: { kpis: Kpi[]; loading: boolean }) {
  return (
    <div className="grid grid-cols-4 gap-[10px]">
      {(loading ? SKELETON : kpis).map((k, i) => (
        <div
          key={i}
          className="relative overflow-hidden rounded-[10px] border border-line bg-white px-[13px] pb-[11px] pt-[10px]"
        >
          <span
            className="absolute inset-y-0 left-0 w-[3px]"
            style={{ background: k.tone === "crit" ? "var(--color-stripe-crit)" : "var(--color-brand)", opacity: 0.85 }}
          />
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-sub">{k.label}</div>
          <div
            className="mt-[3px] truncate text-[22px] font-bold leading-[1.1] tracking-[-0.02em] tabular-nums"
            title={k.value}
          >
            {loading ? <span className="text-muted">—</span> : k.value}
          </div>
          <div className="mt-[2px] truncate text-[11px] tabular-nums text-sub">{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

const SKELETON: Kpi[] = Array.from({ length: 4 }, () => ({ label: " ", value: "—", sub: " " }));
