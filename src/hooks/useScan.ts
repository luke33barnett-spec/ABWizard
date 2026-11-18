"use client";

import { useCallback, useEffect, useState } from "react";
import { useData } from "@/components/providers/DataProvider";
import { runTendencyScan, type Insight } from "@/lib/tendency-scanner";

interface ScanResult {
  key: string | null;
  insights: Insight[] | null;
  ms: number;
  error: string | null;
}

/**
 * Runs the Auto-Scout when asked (run()) and re-runs when filters/data change
 * after the first run. `autoRun` starts it immediately.
 */
export function useScan(hitter: string | null, autoRun = false) {
  const { status, where, filters, version, query } = useData();
  const [runs, setRuns] = useState(autoRun ? 1 : 0);
  const key = status === "ready" && runs > 0 ? `${version}|${where}|${filters.minN}|${hitter ?? "*"}|${runs}` : null;
  const [res, setRes] = useState<ScanResult>({ key: null, insights: null, ms: 0, error: null });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const t0 = performance.now();
    runTendencyScan(query, { globalWhere: where, hitter, minN: filters.minN }).then(
      (insights) => {
        if (!cancelled) setRes({ key, insights, ms: performance.now() - t0, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setRes({ key, insights: null, ms: 0, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, query, where, hitter, filters.minN]);

  const run = useCallback(() => setRuns((r) => r + 1), []);
  const fresh = res.key === key;
  return {
    run,
    started: runs > 0,
    loading: key !== null && !fresh,
    insights: fresh ? res.insights : null,
    ms: fresh ? res.ms : 0,
    error: fresh ? res.error : null,
  };
}
