"use client";

import { useEffect, useState } from "react";
import { useData } from "@/components/providers/DataProvider";
import type { Row } from "@/lib/ingest";

interface Result<T> {
  key: string | null;
  data: T[] | null;
  error: string | null;
}

/**
 * Runs `sql` against the in-browser DuckDB whenever it (or the dataset) changes.
 * Pass null to skip. Loading is derived (requested key ≠ resolved key), so no
 * state is set synchronously inside the effect.
 */
export function useDuckQuery<T extends object = Row>(sql: string | null) {
  const { status, version, query } = useData();
  const key = status === "ready" && sql ? `${version}::${sql}` : null;
  const [res, setRes] = useState<Result<T>>({ key: null, data: null, error: null });

  useEffect(() => {
    if (!key || !sql) return;
    let cancelled = false;
    query<T>(sql).then(
      (data) => {
        if (!cancelled) setRes({ key, data, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setRes({ key, data: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, sql, query]);

  const fresh = res.key === key;
  return {
    data: fresh ? res.data : null,
    error: fresh ? res.error : null,
    loading: key !== null && !fresh,
  };
}
