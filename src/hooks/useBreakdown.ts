"use client";

import { useMemo } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { breakdownSql, numify, paBreakdownSql, type PaAgg, type PitchAgg } from "@/lib/queries";

export interface Split<T> {
  me: T | null;
  team: T | null;
}

function toMap<T>(rows: Record<string, unknown>[] | null): Map<string, Split<T>> {
  const m = new Map<string, Split<T>>();
  for (const raw of rows ?? []) {
    const r = numify<T & { dim: string; me: boolean }>(raw);
    const cur = m.get(r.dim) ?? { me: null, team: null };
    if (r.me) cur.me = r;
    else cur.team = r;
    m.set(r.dim, cur);
  }
  return m;
}

/** Hitter vs. teammates, split by an arbitrary SQL dimension (pitch-level counts). */
export function useBreakdown(hitter: string, dimSql: string, extraWhere = "TRUE") {
  const { where, status } = useData();
  const q = useDuckQuery(status === "ready" ? breakdownSql(where, hitter, dimSql, extraWhere) : null);
  const map = useMemo(() => toMap<PitchAgg>(q.data), [q.data]);
  return { map, loading: q.loading, error: q.error };
}

/** Same, PA-level (terminal pitch of each PA). */
export function usePaBreakdown(hitter: string, dimSql: string, extraWhere = "TRUE") {
  const { where, status } = useData();
  const q = useDuckQuery(status === "ready" ? paBreakdownSql(where, hitter, dimSql, extraWhere) : null);
  const map = useMemo(() => toMap<PaAgg>(q.data), [q.data]);
  return { map, loading: q.loading, error: q.error };
}
