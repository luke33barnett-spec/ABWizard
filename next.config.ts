import type { NextConfig } from "next";

/**
 * DuckDB-WASM is NOT bundled: scripts/copy-duckdb-assets.mjs copies the
 * WASM binaries + worker scripts into public/duckdb on install/prebuild, and
 * src/lib/duckdb.ts loads them by URL inside a Web Worker (client only).
 * That keeps Turbopack/webpack out of WASM handling entirely and makes the
 * server bundle DuckDB-free, so there are no SSR errors on Vercel.
 */
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/duckdb/:file*",
        headers: [
          // Filenames aren't content-hashed, so cache for a day and revalidate.
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
