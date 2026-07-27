"use client";

import { useEffect, useState } from "react";
import { filterParams, getJson, type FilterState, type Tab } from "@/frontend/client";

/** Per-row values the fill writes back, overlaid onto the table row by id. */
export type FilledPatch = {
  courier_live_status: string | null;
  courier_attempts: number | null;
  courier_live_checked_at: string;
};

type FillResponse = {
  filled: Array<{ id: number } & FilledPatch>;
  remaining: number;
  /** Server is shedding load (too many fills running) — back off and retry. */
  busy?: boolean;
};

export type LiveFill = {
  /** id → latest filled values, accumulated across the whole loop. */
  patches: Map<number, FilledPatch>;
  /** Stale rows still to fill (null before the loop starts, 0 when done). */
  remaining: number | null;
  /** The loop is running. */
  active: boolean;
};

/** How long to wait after the tab/filters settle before starting to fill — so
 *  typing in the search box doesn't fire a fill for every keystroke. */
const DEBOUNCE_MS = 500;
/** Runaway guard. The server always converges (every attempted row is marked
 *  checked), but cap iterations so a bug can't loop forever. */
const MAX_CHUNKS = 4000;
/** Wait between retries when the server is busy (load-shedding) or a request
 *  fails (e.g. the middleware's per-IP 429). */
const BACKOFF_MS = 1500;
/** Give up the loop after this many CONSECUTIVE request failures (the sweep still
 *  fills over time); a single success resets the counter. */
const MAX_FAILURES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Progressively fill live courier status for EVERY row matching the current
 *  tab + filters. Loops /api/live-fill (each call fills a small chunk server-side
 *  and persists it) until nothing stale remains, accumulating per-row patches the
 *  table overlays so cells pop in as they resolve.
 *
 *  Keyed on tab + filters only — NOT page/sort/pageSize, which change the view,
 *  not which rows match — so paging or re-sorting doesn't restart the fill.
 *  Restarts (and resets patches) whenever the matching set changes, and aborts the
 *  in-flight loop on change/unmount so a stale filter can't keep firing calls. */
export function useLiveFill(tab: Tab, filters: FilterState, enabled: boolean): LiveFill {
  const [patches, setPatches] = useState<Map<number, FilledPatch>>(new Map());
  const [remaining, setRemaining] = useState<number | null>(null);
  const [active, setActive] = useState(false);

  const key = tab + "?" + filterParams(tab, filters).toString();

  useEffect(() => {
    // Reset for the new matching set even while debouncing / disabled.
    setPatches(new Map());
    setRemaining(null);
    setActive(false);
    if (!enabled) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      setActive(true);
      void (async () => {
        const params = filterParams(tab, filters);
        params.set("tab", tab);
        let failures = 0;
        for (let i = 0; i < MAX_CHUNKS && !cancelled; i++) {
          let res: FillResponse | null = null;
          try {
            res = await getJson<FillResponse>(`/api/live-fill?${params.toString()}`);
            failures = 0;
          } catch {
            // 429 (per-IP limit) or a transient network error — back off and retry
            // a few times before giving up; the background sweep still fills slowly.
            if (++failures > MAX_FAILURES) break;
            await sleep(BACKOFF_MS);
            continue;
          }
          if (cancelled || !res) return;
          if (res.busy) {
            // Server is shedding load — reflect the count, wait, and retry (this is
            // NOT a failure and NOT progress, so don't touch the failure counter).
            setRemaining(res.remaining);
            await sleep(BACKOFF_MS);
            continue;
          }
          const { filled, remaining } = res;
          if (filled.length) {
            setPatches((prev) => {
              const next = new Map(prev);
              for (const { id, ...patch } of filled) next.set(id, patch);
              return next;
            });
          }
          setRemaining(remaining);
          if (remaining <= 0) break; // view fully populated
        }
        if (!cancelled) setActive(false);
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // filterParams(tab, filters) is captured by `key`; tab/filters are stable refs
    // per render so keying on the serialized string is the correct dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { patches, remaining, active };
}
