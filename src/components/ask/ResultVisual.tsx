"use client";

import { useMemo, useState } from "react";
import { Route } from "lucide-react";
import { useInspector } from "@/components/providers/InspectorProvider";
import { StrikeZoneLegend, StrikeZonePlot, type ColorBy } from "@/components/StrikeZonePlot";
import { RateBars } from "@/components/viz/RateBars";
import { Segmented } from "@/components/ui/segmented";
import { RateText } from "@/components/ui/rate";
import { DataTable } from "@/components/ask/DataTable";
import { sequentialFill } from "@/lib/color";
import { COUNTS, displayName } from "@/lib/metrics";
import type { Visualization } from "@/lib/ai/client";
import type { Row } from "@/lib/ingest";
import type { PitchPoint } from "@/lib/queries";
import { cn } from "@/lib/utils";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Picks the visual the answer asked for, falling back to whatever the columns support. */
export function ResultVisual({ kind, rows, minN = 1 }: { kind: Visualization; rows: Row[]; minN?: number }) {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const hasLoc = cols.includes("plate_loc_side") && cols.includes("plate_loc_height");
  const hasRate = cols.includes("num") && cols.includes("den");
  let effective: Visualization = kind;
  if (kind === "strike_zone" && !hasLoc) effective = hasRate ? "bar" : "table";
  if (kind === "count_matrix" && !(cols.includes("count_str") && hasRate)) effective = hasRate ? "bar" : "table";
  if (kind === "bar" && !hasRate) effective = hasLoc ? "strike_zone" : "table";
  if (!rows.length) return <p className="text-xs text-ink-3">No rows to visualize.</p>;

  if (effective === "strike_zone") return <ZoneViz rows={rows} />;
  if (effective === "count_matrix") return <CountViz rows={rows} minN={minN} />;
  if (effective === "bar") {
    const labelCol = cols.find((c) => !["num", "den", "pas"].includes(c)) ?? cols[0];
    return (
      <RateBars
        minN={minN}
        rows={rows.slice(0, 30).map((r, i) => {
          const label = String(r[labelCol] ?? "—");
          return { key: `${label}-${i}`, label: label.includes(",") ? displayName(label) : label, me: { num: num(r.num) ?? 0, den: num(r.den) ?? 0 } };
        })}
      />
    );
  }
  return <DataTable rows={rows} />;
}

function ZoneViz({ rows }: { rows: Row[] }) {
  const { openPa } = useInspector();
  const [colorBy, setColorBy] = useState<ColorBy>("outcome");
  const [tunnels, setTunnels] = useState(false);
  const pts = useMemo(
    () => rows.filter((r) => num(r.plate_loc_side) !== null && num(r.plate_loc_height) !== null).map((r, i) => ({ pitch_uid: String(r.pitch_uid ?? i), pa_pitch_seq: 0, ...r }) as unknown as PitchPoint & { highlight?: boolean }),
    [rows],
  );
  const hasHl = rows[0] && "highlight" in rows[0];
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,380px)_1fr]">
      <div>
        <div className="mb-2 flex flex-wrap gap-2">
          <Segmented size="xs" value={colorBy} onChange={setColorBy} options={[{ value: "outcome", label: "By outcome" }, { value: "group", label: "By pitch group" }]} />
          <button
            type="button"
            aria-pressed={tunnels}
            onClick={() => setTunnels((t) => !t)}
            className={cn("inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px]", tunnels ? "border-crimson-text text-ink" : "border-line-strong text-ink-2")}
          >
            <Route className="size-3" aria-hidden /> Tunnel vectors
          </button>
        </div>
        <StrikeZonePlot pitches={pts} colorBy={colorBy} showTunnels={tunnels} highlight={hasHl ? (p) => Boolean((p as PitchPoint & { highlight?: boolean }).highlight) : undefined} onPitchClick={(p) => p.pa_uid && openPa(p.pa_uid)} />
        <div className="mt-2">
          <StrikeZoneLegend colorBy={colorBy} />
        </div>
      </div>
      <div className="min-w-0">
        <p className="mb-2 text-xs text-ink-3">
          {pts.length} pitches plotted{hasHl ? `, ${pts.filter((p) => (p as { highlight?: boolean }).highlight).length} highlighted` : ""}. Click a pitch or row to replay the PA.
        </p>
        <DataTable rows={rows} max={150} />
      </div>
    </div>
  );
}

function CountViz({ rows, minN }: { rows: Row[]; minN: number }) {
  const by = new Map(rows.map((r) => [String(r.count_str), { num: num(r.num) ?? 0, den: num(r.den) ?? 0 }]));
  return (
    <div className="grid max-w-[640px] grid-cols-[3rem_repeat(4,minmax(0,1fr))] gap-1.5 text-xs">
      <div />
      {[0, 1, 2, 3].map((b) => (
        <div key={b} className="text-center text-[11px] text-ink-3">
          {b} balls
        </div>
      ))}
      {[0, 1, 2].map((s) => (
        <Row3 key={s} s={s} by={by} minN={minN} />
      ))}
      <p className="col-span-5 mt-1 text-[11px] text-ink-3">Fill = rate (darker blue = higher). Counts: {COUNTS.filter((c) => by.has(c)).length}/12 present.</p>
    </div>
  );
}

function Row3({ s, by, minN }: { s: number; by: Map<string, { num: number; den: number }>; minN: number }) {
  return (
    <>
      <div className="flex items-center text-[11px] text-ink-3">{s} str</div>
      {[0, 1, 2, 3].map((b) => {
        const c = `${b}-${s}`;
        const r = by.get(c);
        const v = r && r.den ? r.num / r.den : null;
        return (
          <div key={c} className={cn("rounded-md border border-line p-2", r && r.den < minN && "opacity-50")} style={{ background: v !== null ? sequentialFill(v) : "var(--color-surface-2)" }}>
            <div className="num font-semibold text-ink">{c}</div>
            <RateText r={r} />
          </div>
        );
      })}
    </>
  );
}
