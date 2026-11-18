"use client";

import { useInspector } from "@/components/providers/InspectorProvider";
import type { Row } from "@/lib/ingest";

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3).replace(/\.?0+$/, "");
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Generic result table. Rows with a pa_uid open the PA inspector on click. */
const HIDDEN = new Set(["pitch_uid", "pa_uid", "highlight"]);

export function DataTable({ rows, max = 300 }: { rows: Row[]; max?: number }) {
  const { openPa } = useInspector();
  if (!rows.length) return <p className="py-3 text-xs text-ink-3">Query returned no rows.</p>;
  const all = Object.keys(rows[0]);
  const clickable = all.includes("pa_uid");
  // Internal keys stay usable (row click → PA inspector) but aren't shown when there's anything else to show.
  const visible = all.filter((c) => !HIDDEN.has(c));
  const cols = visible.length ? visible : all;
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border border-line">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface-2 text-ink-3">
          <tr>
            {cols.map((c) => (
              <th key={c} className="num whitespace-nowrap px-2.5 py-1.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr
              key={i}
              className={clickable ? "cursor-pointer border-t border-line hover:bg-surface-2" : "border-t border-line"}
              onClick={clickable ? () => openPa(String(r.pa_uid)) : undefined}
            >
              {cols.map((c) => (
                <td key={c} className="num max-w-[24rem] truncate whitespace-nowrap px-2.5 py-1 text-ink-2" title={fmt(r[c])}>
                  {fmt(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max ? <p className="border-t border-line px-2.5 py-1.5 text-[11px] text-ink-3">Showing {max} of {rows.length} rows.</p> : null}
    </div>
  );
}
