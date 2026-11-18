/**
 * CSV → DuckDB ingestion, independent of where DuckDB runs. The browser
 * passes a DuckDB-WASM adapter (src/lib/duckdb.ts); scripts/verify-pipeline.ts
 * passes a native Node adapter so the exact same SQL is regression-tested.
 */
import Papa from "papaparse";
import { mapFile, RAW_COLUMNS, type ColumnMapping, type MapFileResult, type NormalizedPitch } from "@/lib/schema-mapper";
import { createRawTableSql, readRawCsvSql, REBUILD_SQL } from "@/lib/sql/schema";

export type Row = Record<string, unknown>;

export interface DbAdapter {
  query<T extends object = Row>(sql: string): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Makes `text` readable by SQL under `name` (e.g. read_csv('name')). Returns the path SQL should use. */
  registerText(name: string, text: string): Promise<string>;
  dropFile?(name: string): Promise<void>;
}

export interface FileReport {
  fileName: string;
  format: MapFileResult["mapping"]["format"];
  totalRecords: number;
  mappedRows: number;
  skipped: number;
  skipReasons: Record<string, number>;
  mapping: ColumnMapping;
  sideConvention: MapFileResult["sideConvention"];
  units: MapFileResult["units"];
  error?: string;
}

export interface IngestResult {
  files: FileReport[];
  insertedRows: number;
}

const BATCH = 15000;

export function parseCsvText(text: string): { records: Record<string, string>[]; headers: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return { records: parsed.data, headers: (parsed.meta.fields ?? []).filter(Boolean) };
}

export async function ensureRawTable(db: DbAdapter): Promise<void> {
  await db.exec(createRawTableSql());
}

export async function rebuildDerived(db: DbAdapter): Promise<void> {
  for (const sql of REBUILD_SQL) await db.exec(sql);
}

/** NULL marker for the staging CSV (distinct from an empty string). */
export const CSV_NULL = "\\N";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return CSV_NULL;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  return /[",\r\n]|^\s|\s$|^\\N$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializes normalized rows to the staging CSV layout (header = RAW_COLUMNS). */
export function toStagingCsv(rows: NormalizedPitch[]): string {
  const cols = RAW_COLUMNS.map(([c]) => c);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n");
}

/**
 * Loads rows through DuckDB's CORE CSV reader. JSON and Parquet are NOT used:
 * in DuckDB-WASM they are runtime-downloaded extensions (external requests,
 * and they break offline / behind proxies).
 */
async function insertRows(db: DbAdapter, rows: NormalizedPitch[], seq: number): Promise<void> {
  const cols = RAW_COLUMNS.map(([c]) => c);
  for (let i = 0; i < rows.length; i += BATCH) {
    const name = `ingest_${seq}_${i}.csv`;
    const path = await db.registerText(name, toStagingCsv(rows.slice(i, i + BATCH)));
    await db.exec(`INSERT INTO pitches_raw (${cols.join(", ")}, ingest_seq) SELECT ${cols.join(", ")}, ${seq} FROM ${readRawCsvSql(path)}`);
    await db.dropFile?.(name);
  }
}

/**
 * Parses, maps and loads CSV files, then rebuilds pitches/enriched tables.
 * Re-uploading a file that overlaps existing data is safe: pitches dedupe on pitch_uid.
 */
export async function ingestCsvFiles(
  db: DbAdapter,
  files: { name: string; text: string }[],
  onProgress?: (msg: string) => void,
): Promise<IngestResult> {
  await ensureRawTable(db);
  const seqRow = await db.query<{ seq: number }>("SELECT coalesce(max(ingest_seq), 0) + 1 AS seq FROM pitches_raw");
  const seq = Number(seqRow[0]?.seq ?? 1);
  const reports: FileReport[] = [];
  let inserted = 0;

  for (const [i, file] of files.entries()) {
    onProgress?.(`Parsing ${file.name} (${i + 1}/${files.length})`);
    const report: FileReport = {
      fileName: file.name,
      format: "Generic",
      totalRecords: 0,
      mappedRows: 0,
      skipped: 0,
      skipReasons: {},
      mapping: { mapped: {}, unmapped: [], format: "Generic" },
      sideConvention: "as-is",
      units: "feet",
    };
    reports.push(report);
    try {
      const { records, headers } = parseCsvText(file.text);
      const result = mapFile(records, headers, { fileName: file.name });
      Object.assign(report, {
        format: result.mapping.format,
        totalRecords: records.length,
        mappedRows: result.rows.length,
        skipped: result.skipped,
        skipReasons: result.skipReasons,
        mapping: result.mapping,
        sideConvention: result.sideConvention,
        units: result.units,
      });
      if (result.rows.length > 0) {
        onProgress?.(`Loading ${result.rows.length.toLocaleString()} pitches from ${file.name}`);
        await insertRows(db, result.rows, seq * 1000 + i);
        inserted += result.rows.length;
      }
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
      report.mappedRows = 0;
    }
  }

  onProgress?.("Building sequence windows (LAG/LEAD per plate appearance)");
  await rebuildDerived(db);
  return { files: reports, insertedRows: inserted };
}

export interface DatasetSummary {
  pitches: number;
  pas: number;
  games: number;
  hitters: number;
  ourHitters: number;
  minDate: string | null;
  maxDate: string | null;
  files: { source_file: string; source_format: string; pitches: number }[];
  teams: { batter_team: string | null; pitches: number }[];
}

export async function getDatasetSummary(db: DbAdapter, ourTeam: string): Promise<DatasetSummary | null> {
  const exists = await db.query<{ n: number }>(
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'enriched_pitches'",
  );
  if (!Number(exists[0]?.n)) return null;
  const [s] = await db.query<Row>(`
    SELECT count(*) AS pitches, count(DISTINCT pa_uid) AS pas, count(DISTINCT game_id) AS games,
           count(DISTINCT batter_name) AS hitters,
           count(DISTINCT batter_name) FILTER (WHERE batter_team = '${ourTeam.replace(/'/g, "''")}') AS our_hitters,
           CAST(min(game_date) AS VARCHAR) AS min_date, CAST(max(game_date) AS VARCHAR) AS max_date
    FROM enriched_pitches`);
  const files = await db.query<{ source_file: string; source_format: string; pitches: number }>(
    "SELECT source_file, any_value(source_format) AS source_format, count(*) AS pitches FROM enriched_pitches GROUP BY 1 ORDER BY 1",
  );
  const teams = await db.query<{ batter_team: string | null; pitches: number }>(
    "SELECT batter_team, count(*) AS pitches FROM enriched_pitches GROUP BY 1 ORDER BY 2 DESC",
  );
  return {
    pitches: Number(s.pitches),
    pas: Number(s.pas),
    games: Number(s.games),
    hitters: Number(s.hitters),
    ourHitters: Number(s.our_hitters),
    minDate: (s.min_date as string) ?? null,
    maxDate: (s.max_date as string) ?? null,
    files: files.map((f) => ({ ...f, pitches: Number(f.pitches) })),
    teams: teams.map((t) => ({ ...t, pitches: Number(t.pitches) })),
  };
}
