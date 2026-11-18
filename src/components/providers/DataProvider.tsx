"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BrowserDb } from "@/lib/duckdb";
import { getDatasetSummary, ingestCsvFiles, type DatasetSummary, type FileReport, type IngestResult, type Row } from "@/lib/ingest";
import { buildWhere, DEFAULT_FILTERS, OUR_TEAM_CODE, type GlobalFilters } from "@/lib/filters";
import { hitterListSql } from "@/lib/queries";

export type DataStatus = "booting" | "empty" | "loading" | "ready" | "error";

export interface HitterRow {
  batter_name: string;
  team: string | null;
  bats: string | null;
  pitches: number;
  pas: number;
}

interface DataContextValue {
  status: DataStatus;
  error: string | null;
  progress: string | null;
  summary: DatasetSummary | null;
  reports: FileReport[];
  savedAt: string | null;
  lastIngest: IngestResult | null;
  /** Bumps after every data change so queries re-run. */
  version: number;
  filters: GlobalFilters;
  setFilters: (patch: Partial<GlobalFilters>) => void;
  /** WHERE clause for the current filters (no hitter restriction). */
  where: string;
  hitters: HitterRow[];
  query: <T extends object = Row>(sql: string) => Promise<T[]>;
  loadFiles: (files: File[]) => Promise<void>;
  loadDemo: () => Promise<void>;
  clearData: () => Promise<void>;
  healthOpen: boolean;
  setHealthOpen: (open: boolean) => void;
}

const DataContext = createContext<DataContextValue | null>(null);

const FILTER_KEY = "abwizard.filters.v1";

function readSavedFilters(): GlobalFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<GlobalFilters>) };
  } catch {
    /* storage blocked — defaults are fine */
  }
  return DEFAULT_FILTERS;
}

async function loadDb(): Promise<BrowserDb> {
  const { getDuckDb } = await import("@/lib/duckdb");
  return getDuckDb();
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<BrowserDb | null>(null);
  const [status, setStatus] = useState<DataStatus>("booting");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>("Starting DuckDB-WASM");
  const [summary, setSummary] = useState<DatasetSummary | null>(null);
  const [reports, setReports] = useState<FileReport[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [lastIngest, setLastIngest] = useState<IngestResult | null>(null);
  const [version, setVersion] = useState(0);
  const [filters, setFiltersState] = useState<GlobalFilters>(DEFAULT_FILTERS);
  const [hitters, setHitters] = useState<HitterRow[]>([]);
  const [healthOpen, setHealthOpen] = useState(false);

  // Boot: start DuckDB in its worker, then restore the last dataset from IndexedDB.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const instance = await loadDb();
        if (cancelled) return;
        setFiltersState(readSavedFilters());
        setProgress("Restoring saved dataset");
        const restored = await instance.restoreSnapshot().catch(() => ({ restored: false, reports: [] as FileReport[], savedAt: null }));
        const s = restored.restored ? await getDatasetSummary(instance, OUR_TEAM_CODE) : null;
        if (cancelled) return;
        setDb(instance);
        setReports(restored.reports);
        setSavedAt(restored.savedAt);
        setSummary(s);
        setStatus(s && s.pitches > 0 ? "ready" : "empty");
        setProgress(null);
        setVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
        setProgress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const where = useMemo(() => buildWhere(filters), [filters]);

  // Roster for the hitter selector — re-queried when data or filters change.
  useEffect(() => {
    if (!db || status !== "ready") return;
    let cancelled = false;
    db.query<HitterRow & Row>(hitterListSql(where))
      .then((rows) => {
        if (!cancelled) setHitters(rows.map((r) => ({ ...r, pitches: Number(r.pitches), pas: Number(r.pas) })));
      })
      .catch(() => {
        if (!cancelled) setHitters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [db, status, where, version]);

  const setFilters = useCallback((patch: Partial<GlobalFilters>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(FILTER_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const query = useCallback(
    async <T extends object = Row>(sql: string): Promise<T[]> => {
      if (!db) throw new Error("Database is still starting");
      return db.query<T>(sql);
    },
    [db],
  );

  const ingest = useCallback(
    async (files: { name: string; text: string }[]) => {
      if (!db) return;
      setStatus("loading");
      setError(null);
      try {
        const result = await ingestCsvFiles(db, files, setProgress);
        const s = await getDatasetSummary(db, OUR_TEAM_CODE);
        setProgress("Saving dataset to this browser (IndexedDB)");
        const allReports = [...reports.filter((r) => !files.some((f) => f.name === r.fileName)), ...result.files];
        await db.saveSnapshot(allReports).catch((e) => console.warn("snapshot failed", e));
        setReports(allReports);
        setSavedAt(new Date().toISOString());
        setLastIngest(result);
        setSummary(s);
        setStatus(s && s.pitches > 0 ? "ready" : "empty");
        setVersion((v) => v + 1);
        setHealthOpen(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      } finally {
        setProgress(null);
      }
    },
    [db, reports],
  );

  const loadFiles = useCallback(
    async (files: File[]) => {
      const csvs = files.filter((f) => /\.(csv|txt)$/i.test(f.name));
      if (csvs.length === 0) return;
      setProgress(`Reading ${csvs.length} file${csvs.length === 1 ? "" : "s"}`);
      const texts = await Promise.all(csvs.map(async (f) => ({ name: f.name, text: await f.text() })));
      await ingest(texts);
    },
    [ingest],
  );

  const loadDemo = useCallback(async () => {
    setProgress("Simulating a 40-game demo season");
    const { generateDemoFiles } = await import("@/lib/mock-data");
    await ingest(generateDemoFiles());
  }, [ingest]);

  const clearData = useCallback(async () => {
    if (!db) return;
    await db.reset();
    setSummary(null);
    setReports([]);
    setSavedAt(null);
    setLastIngest(null);
    setHitters([]);
    setStatus("empty");
    setVersion((v) => v + 1);
  }, [db]);

  const value = useMemo<DataContextValue>(
    () => ({
      status,
      error,
      progress,
      summary,
      reports,
      savedAt,
      lastIngest,
      version,
      filters,
      setFilters,
      where,
      hitters,
      query,
      loadFiles,
      loadDemo,
      clearData,
      healthOpen,
      setHealthOpen,
    }),
    [status, error, progress, summary, reports, savedAt, lastIngest, version, filters, setFilters, where, hitters, query, loadFiles, loadDemo, clearData, healthOpen],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used inside <DataProvider>");
  return ctx;
}
