"use client";

import { useEffect, useRef, useState } from "react";

/** Minimal click-outside dropdown shell. */
export default function Dropdown({
  trigger,
  children,
  align = "left",
  width = 256,
}: {
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Escape too, not just click-outside: otherwise a keyboard user who tabs
    // past the last item leaves the panel floating open with focus behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex">
      <div onClick={() => setOpen((o) => !o)} className="flex">
        {trigger(open)}
      </div>
      {open && (
        <div
          className={`absolute top-[calc(100%+6px)] z-50 rounded-[9px] border border-line-2 bg-white p-[5px] shadow-[0_8px_24px_rgba(15,23,32,0.12)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
