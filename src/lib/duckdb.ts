/**
 * Browser-only DuckDB-WASM singleton. Runs DuckDB inside a Web Worker using
 * the bundles that scripts/copy-duckdb-assets.mjs places in /public/duckdb.
 *
 * `client-only` makes any accidental import from a Server Component or route
 * handler a build error, and `@duckdb/duckdb-wasm` itself is imported lazily
 * so it never lands in a server bundle.
 */
import "client-only";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { DbAdapter, FileReport, Row } from "@/lib/ingest";
import { ensureRawTable, rebuildDerived } from "@/lib/ingest";
import { readRawCsvSql } from "@/lib/sql/schema";
import { idbDelete, idbGet, idbPut } from "@/lib/persistence";

export interface BrowserDb extends DbAdapter {
  saveSnapshot(reports: FileReport[]): Promise<void>;
  restoreSnapshot(): Promise<{ restored: boolean; reports: FileReport[]; savedAt: string | null }>;
  reset(): Promise<void>;
}

let instance: Promise<BrowserDb> | null = null;

export function getDuckDb(): Promise<BrowserDb> {
  if (typeof window === "undefined") return Promise.reject(new Error("DuckDB-WASM is browser-only"));
  instance ??= create().catch((err) => {
    instance = null;
    throw err;
  });
  return instance;
}

async function create(): Promise<BrowserDb> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const base = new URL("/duckdb/", window.location.origin).toString();
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: `${base}duckdb-mvp.wasm`, mainWorker: `${base}duckdb-browser-mvp.worker.js` },
    eh: { mainModule: `${base}duckdb-eh.wasm`, mainWorker: `${base}duckdb-browser-eh.worker.js` },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
  const conn = await db.connect();
  // JSON/Parquet etc. are runtime-downloaded extensions in DuckDB-WASM. ABWizard
  // only uses core features (CSV, window functions), so never fetch extensions:
  // no third-party requests, works offline and behind proxies.
  await conn.query("SET autoinstall_known_extensions = false");
  await conn.query("SET autoload_known_extensions = false");
  return wrap(db, conn);
}

/** Arrow → plain JS rows: dates to YYYY-MM-DD, bigint to number, Arrow vectors to arrays. */
function toRows(table: { schema: { fields: { name: string; type: unknown }[] }; toArray(): { toJSON(): Row }[] }): Row[] {
  const dateCols = new Set(table.schema.fields.filter((f) => /^Date/i.test(String(f.type))).map((f) => f.name));
  return table.toArray().map((r) => {
    const o = r.toJSON();
    for (const k of Object.keys(o)) {
      const v = o[k] as unknown;
      if (typeof v === "bigint") o[k] = Number(v);
      else if (v instanceof Date) o[k] = v.toISOString().slice(0, 10);
      else if (dateCols.has(k) && typeof v === "number") o[k] = new Date(v).toISOString().slice(0, 10);
      else if (v && typeof v === "object" && typeof (v as { toArray?: unknown }).toArray === "function")
        o[k] = Array.from((v as { toArray(): ArrayLike<unknown> }).toArray());
    }
    return o;
  });
}

const SNAPSHOT_KEY = "dataset-snapshot-v2";

/** gzip via the browser's CompressionStream (falls back to raw bytes). */
async function gzip(bytes: Uint8Array): Promise<{ data: Uint8Array; gz: boolean }> {
  if (typeof CompressionStream === "undefined") return { data: bytes, gz: false };
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return { data: new Uint8Array(await new Response(stream).arrayBuffer()), gz: true };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Snapshot {
  csv: Uint8Array;
  gz: boolean;
  reports: FileReport[];
  savedAt: string;
}

function wrap(db: AsyncDuckDB, conn: AsyncDuckDBConnection): BrowserDb {
  const adapter: BrowserDb = {
    async query<T extends object = Row>(sql: string): Promise<T[]> {
      const t = await conn.query(sql);
      return toRows(t as unknown as Parameters<typeof toRows>[0]) as T[];
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
    async registerText(name: string, text: string) {
      await db.registerFileText(name, text);
      return name;
    },
    async dropFile(name: string) {
      await db.dropFile(name);
    },
    async saveSnapshot(reports: FileReport[]) {
      // Core CSV writer (Parquet would need a downloaded extension), gzipped for IndexedDB.
      const name = "abw_snapshot.csv";
      await db.registerEmptyFileBuffer(name);
      await conn.query(`COPY pitches_raw TO '${name}' (FORMAT CSV, HEADER true, NULLSTR '\\N', QUOTE '"', ESCAPE '"')`);
      const buf = await db.copyFileToBuffer(name);
      await db.dropFile(name);
      const { data, gz } = await gzip(buf);
      const snap: Snapshot = { csv: data, gz, reports, savedAt: new Date().toISOString() };
      await idbPut(SNAPSHOT_KEY, snap);
    },
    async restoreSnapshot() {
      const snap = await idbGet<Snapshot>(SNAPSHOT_KEY);
      if (!snap?.csv?.byteLength) return { restored: false, reports: [], savedAt: null };
      const bytes = snap.gz ? await gunzip(new Uint8Array(snap.csv)) : new Uint8Array(snap.csv);
      const name = "abw_restore.csv";
      await db.registerFileBuffer(name, bytes);
      await conn.query("DROP TABLE IF EXISTS pitches_raw");
      await ensureRawTable(adapter);
      await conn.query(`INSERT INTO pitches_raw SELECT * FROM ${readRawCsvSql(name, true)}`);
      await db.dropFile(name);
      await rebuildDerived(adapter);
      return { restored: true, reports: snap.reports ?? [], savedAt: snap.savedAt ?? null };
    },
    async reset() {
      for (const t of ["enriched_pitches", "pitches", "pitches_raw"]) await conn.query(`DROP TABLE IF EXISTS ${t}`);
      await conn.query("DROP VIEW IF EXISTS enriched_pitches_view");
      await idbDelete(SNAPSHOT_KEY);
    },
  };
  return adapter;
}
