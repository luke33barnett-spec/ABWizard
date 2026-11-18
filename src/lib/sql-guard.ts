/**
 * Guards for SQL that ABWizard did not write itself (Claude's run_sql calls
 * and the SQL Playground). Everything runs in the user's own browser DuckDB,
 * but we still only allow ONE read-only statement, and we always wrap it so
 * the global filter bar applies.
 */

const FORBIDDEN =
  /\b(insert|update|delete|drop|create|alter|attach|detach|copy|export|import|install|load|pragma|set|reset|call|checkpoint|vacuum|truncate|grant|revoke|begin|commit|rollback|use)\b/i;
const FORBIDDEN_FUNCS = /\b(read_csv\w*|read_json\w*|read_ndjson\w*|read_parquet|parquet_scan|read_text|read_blob|glob|sniff_csv|query_table|query)\s*\(/i;

/** Remove comments, string literal contents and quoted identifiers for keyword scanning. */
function maskSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, (m) => m) // keep comments for display
    .trim()
    .replace(/;+\s*$/, "");
}

export type GuardResult = { ok: true; sql: string } | { ok: false; error: string };

export function checkReadOnly(raw: string): GuardResult {
  const sql = normalizeSql(raw);
  if (!sql) return { ok: false, error: "Empty SQL." };
  const masked = maskSql(sql);
  if (masked.includes(";")) return { ok: false, error: "Only one SQL statement is allowed (remove the extra ';')." };
  const first = masked.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!["select", "with", "from", "values", "("].includes(first) && !first.startsWith("(")) {
    return { ok: false, error: `Only read-only SELECT / WITH queries are allowed (got "${first.toUpperCase()}").` };
  }
  const bad = masked.match(FORBIDDEN);
  if (bad) return { ok: false, error: `Read-only mode: "${bad[1].toUpperCase()}" is not allowed.` };
  const badFn = masked.match(FORBIDDEN_FUNCS);
  if (badFn) return { ok: false, error: `Reading files directly (${badFn[1]}) is not allowed; query enriched_pitches.` };
  return { ok: true, sql };
}

/**
 * Applies the global filters by shadowing `enriched_pitches` with a filtered
 * CTE (CTE names take precedence over tables), then caps the row count.
 */
export function scopeSql(sql: string, where: string, limit = 5000): string {
  return `WITH enriched_pitches AS (SELECT * FROM main.enriched_pitches WHERE ${where})
SELECT * FROM (
${sql}
) AS abw_q LIMIT ${limit}`;
}
