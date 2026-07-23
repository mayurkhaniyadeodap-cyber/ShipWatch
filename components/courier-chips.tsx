"use client";

import { fmtInt } from "@/lib/client";

export default function CourierChips({
  byCourier,
  totalAll,
  selected,
  onToggle,
  onClear,
}: {
  byCourier: { courier: string; count: number }[];
  totalAll: number;
  selected: string[];
  onToggle: (courier: string) => void;
  onClear: () => void;
}) {
  const allSelected = selected.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip label="All couriers" count={totalAll} selected={allSelected} onClick={onClear} />
      {byCourier.map((c) => (
        <Chip
          key={c.courier}
          label={c.courier}
          count={c.count}
          selected={selected.includes(c.courier)}
          onClick={() => onToggle(c.courier)}
        />
      ))}
    </div>
  );
}

function Chip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-[30px] cursor-pointer items-center gap-2 rounded-full border px-[13px] text-[12.5px] transition-colors ${
        selected
          ? "border-brand bg-brand font-semibold text-white"
          : "border-line-2 bg-white font-medium text-ink-2 hover:border-brand hover:text-brand"
      }`}
    >
      {label}
      <span className={`font-bold tabular-nums ${selected ? "" : "text-ink"}`}>{fmtInt(count)}</span>
    </button>
  );
}
