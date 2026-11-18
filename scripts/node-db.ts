/**
 * Native DuckDB (same engine version as the browser's DuckDB-WASM) wrapped in
 * the DbAdapter interface, so scripts can run the exact browser SQL in Node.
 * Dev/CI only — never imported by the app.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbAdapter, Row } from "../src/lib/ingest";

export async function createNodeDb(): Promise<DbAdapter & { close(): void }> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const dir = mkdtempSync(join(tmpdir(), "abwizard-"));
  return {
    async query<T extends object = Row>(sql: string): Promise<T[]> {
      const reader = await conn.runAndReadAll(sql);
      return reader.getRowObjectsJS() as T[];
    },
    async exec(sql: string) {
      await conn.run(sql);
    },
    async registerText(name: string, text: string) {
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    },
    async dropFile(name: string) {
      rmSync(join(dir, name), { force: true });
    },
    close() {
      conn.closeSync();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
