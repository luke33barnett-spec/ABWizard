"use client";

import { useMemo, useState } from "react";
import { Route } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { useInspector } from "@/components/providers/InspectorProvider";
import { useBreakdown } from "@/hooks/useBreakdown";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { StrikeZoneLegend, StrikeZonePlot, type ColorBy } from "@/components/StrikeZonePlot";
import { ZoneGrid, type ZoneCellValue } from "@/components/viz/ZoneGrid";
import { buildWhere } from "@/lib/filters";
import { aggRate, pitchPointsSql, type PitchPoint } from "@/lib/queries";
import { METRICS, sqlStr, type MetricKey } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const RESULT_FILTERS = {
  all: "TRUE",
  swings: "is_swing",
  takes: "is_take",
  whiffs: "is_whiff",
  freezes: "is_freeze",
  chases: "is_chase",
  inplay: "is_in_play",
} as const;
type ResultFilter = keyof typeof RESULT_FILTERS;

const GRID_METRICS = [
  { value: "swing", label: "Swing%" },
  { value: "whiff", label: "Whiff%" },
  { value: "freeze", label: "Freeze%" },
  { value: "hardHit", label: "Hard-Hit%" },
] as const satisfies readonly { value: MetricKey; label: string }[];
type GridMetric = (typeof GRID_METRICS)[number]["value"];

export function ZonePanel({ hitter }: { hitter: string }) {
  const { status, filters } = useData();
  const { openPa, openSet } = useInspector();
  const [colorBy, setColorBy] = useState<ColorBy>("group");
  const [tunnels, setTunnels] = useState(false);
  const [bucket, setBucket] = useState("ALL");
  const [group, setGroup] = useState("ALL");
  const [result, setResult] = useState<ResultFilter>("all");
  const [gm, setGm] = useState<GridMetric>("swing");
  const hw = buildWhere(filters, hitter);

  const extra = [
    bucket === "ALL" ? "TRUE" : bucket === "TWO" ? "two_strikes" : `count_bucket = ${sqlStr(bucket)}`,
    group === "ALL" ? "TRUE" : `pitch_group = ${sqlStr(group)}`,
    RESULT_FILTERS[result],
  ].join(" AND ");
  const pts = useDuckQuery<PitchPoint>(status === "ready" ? pitchPointsSql(hw, extra) : null);
  const cells = useBreakdown(hitter, "zone_cell", `${bucket === "ALL" ? "TRUE" : bucket === "TWO" ? "two_strikes" : `count_bucket = ${sqlStr(bucket)}`} AND ${group === "ALL" ? "TRUE" : `pitch_group = ${sqlStr(group)}`}`);
  const cellMap = useMemo(() => {
    const m = new Map<number, ZoneCellValue>();
    for (const [k, v] of cells.map) m.set(Number(k), { me: aggRate(v.me, gm), team: v.team ? aggRate(v.team, gm) : null });
    return m;
  }, [cells.map, gm]);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title="Pitch locations"
          subtitle={`${(pts.data ?? []).length} pitches · catcher's view. Click any pitch to replay its PA.`}
          actions={
            <button
              type="button"
              onClick={() => setTunnels((t) => !t)}
              aria-pressed={tunnels}
              className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs", tunnels ? "border-crimson-text text-ink" : "border-line-strong text-ink-2")}
            >
              <Route className="size-3.5" aria-hidden /> Show Previous Pitch Tunnel Vector
            </button>
          }
        />
        <CardBody>
          <div className="mb-3 flex flex-wrap gap-2">
            <select value={bucket} onChange={(e) => setBucket(e.target.value)} className="h-7 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink" aria-label="Count filter">
              <option value="ALL">All counts</option>
              {["First Pitch", "Hitter Ahead", "Even", "Pitcher Ahead", "Full"].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
              <option value="TWO">Two strikes</option>
            </select>
            <select value={group} onChange={(e) => setGroup(e.target.value)} className="h-7 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink" aria-label="Pitch group filter">
              <option value="ALL">All pitch groups</option>
              {["Fastball", "Breaking", "Offspeed"].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select value={result} onChange={(e) => setResult(e.target.value as ResultFilter)} className="h-7 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink" aria-label="Result filter">
              {Object.keys(RESULT_FILTERS).map((r) => (
                <option key={r} value={r}>
                  {r === "all" ? "All results" : r[0].toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
            <Segmented size="sm" value={colorBy} onChange={setColorBy} options={[{ value: "group", label: "Color: pitch group" }, { value: "outcome", label: "Color: outcome" }]} />
          </div>
          {pts.loading ? (
            <div className="skeleton aspect-[4/5] w-full max-w-[480px]" />
          ) : (
            <div className="max-w-[480px]">
              <StrikeZonePlot pitches={pts.data ?? []} colorBy={colorBy} showTunnels={tunnels} onPitchClick={(p) => openPa(p.pa_uid)} />
            </div>
          )}
          <div className="mt-3">
            <StrikeZoneLegend colorBy={colorBy} />
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Zone grid" subtitle="3×3 zone + 4 chase quadrants, same count/pitch filters. Tint vs teammates." actions={<Segmented value={gm} onChange={setGm} options={GRID_METRICS} />} />
        <CardBody className="flex flex-col items-center gap-3">
          <ZoneGrid
            cells={cellMap}
            minN={filters.minN}
            label={`${METRICS[gm].label} by zone`}
            onCellClick={(c) =>
              openSet({
                title: `Zone ${c} · ${METRICS[gm].label}`,
                subtitle: hitter,
                where: `${hw} AND zone_cell = ${c} AND (${METRICS[gm].den})`,
                highlightSql: METRICS[gm].num,
                highlightLabel: METRICS[gm].label.replace("%", ""),
              })
            }
          />
          <p className="text-center text-[11px] text-ink-3">Catcher&apos;s view: right-handed hitters stand on the left. Outer quadrants are pitches outside the rulebook zone.</p>
        </CardBody>
      </Card>
    </div>
  );
}
