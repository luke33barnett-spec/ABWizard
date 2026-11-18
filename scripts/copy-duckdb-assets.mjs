// Copies the DuckDB-WASM bundles (WASM + Web Worker scripts) out of
// node_modules into public/duckdb so the browser can load them same-origin.
// Runs on postinstall and prebuild (Vercel runs both). The copied files are
// gitignored — node_modules is the single source of truth for their version.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@duckdb", "duckdb-wasm", "dist");
const dest = join(root, "public", "duckdb");

// EH (WASM exceptions) covers every current browser; MVP is the fallback.
const FILES = [
  "duckdb-eh.wasm",
  "duckdb-browser-eh.worker.js",
  "duckdb-mvp.wasm",
  "duckdb-browser-mvp.worker.js",
];

if (!existsSync(src)) {
  console.warn("[copy-duckdb-assets] @duckdb/duckdb-wasm not installed yet; skipping.");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
for (const file of FILES) {
  const from = join(src, file);
  const to = join(dest, file);
  if (existsSync(to) && statSync(to).size === statSync(from).size && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
  copyFileSync(from, to);
}
console.log(`[copy-duckdb-assets] ${FILES.length} DuckDB-WASM assets ready in public/duckdb`);
