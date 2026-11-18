"use client";

import { Fragment, useMemo, useState } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useInspector } from "@/components/providers/InspectorProvider";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { RateText } from "@/components/ui/rate";
import { CountFlow, type CountNode, type Transition } from "@/components/viz/CountFlow";
import { buildWhere } from "@/lib/filters";
import { aggRate, countFlowSql, countMatrixSql, countTypeSql, EMPTY_PITCH_AGG, numify, type PitchAgg } from "@/lib/queries";
import { COUNTS, METRICS, PITCH_GROUP_PLURAL, PITCH_TYPE_NAME, PITCH_TYPES, fmtAvg, pct, sqlStr, type MetricKey, type Rate } from "@/lib/metrics";
import { divergingFill } from "@/lib/color";
import { cn } from "@/lib/utils";

const MATRIX_METRICS = [
  { value: "swing", label: "Swing%" },
  { value: "take", label: "Take%" },
  { value: "freeze", label: "Freeze%" },
  { value: "chase", label: "Chase%" },
  { value: "whiff", label: "Whiff%" },
  { value: "foul", label: "Foul%" },
  { value: "hardHit", label: "Hard-Hit%" },
] as const satisfies readonly { value: MetricKey; label: string }[];
type MatrixMetric = (typeof MATRIX_METRICS)[number]["value"];

type MatrixRow = PitchAgg & { count_str: string; me: boolean; reached: number | null; k: number | null; kl: number | null; bb: number | null; ab: number | null; h: number | null; tb: number | null };

function pitchFilterSql(f: string): string {
  if (f === "ALL") return "TRUE";
  if (f.startsWith("G:")) return `pitch_group = ${sqlStr(f.slice(2))}`;
  return `pitch_type = ${sqlStr(f.slice(2))}`;
}

function pitchFilterLabel(f: string): string {
  if (f === "ALL") return "all pitches";
  if (f.startsWith("G:")) return PITCH_GROUP_PLURAL[f.slice(2)] ?? f.slice(2);
  return PITCH_TYPE_NAME[f.slice(2)] ?? f.slice(2);
}

export function CountPanel({ hitter }: { hitter: string }) {
  const { status, where, filters } = useData();
  const { openSet } = useInspector();
  const [metric, setMetric] = useState<MatrixMetric>("swing");
  const [pitch, setPitch] = useState("ALL");
  const pf = pitchFilterSql(pitch);
  const ready = status === "ready";

  const types = useDuckQuery<{ pitch_type: string; n: number }>(
    ready ? `SELECT pitch_type, count(*) AS n FROM enriched_pitches WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND pitch_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC` : null,
  );
  const matrix = useDuckQuery(ready ? countMatrixSql(where, hitter, pf) : null);
  const grid = useDuckQuery(ready ? countTypeSql(where, hitter) : null);
  const flowNodes = useDuckQuery(ready ? countMatrixSql(where, hitter, "TRUE") : null);
  const flow = useDuckQuery(ready ? countFlowSql(where, hitter) : null);

  const cells = useMemo(() => {
    const m = new Map<string, { me: MatrixRow | null; team: MatrixRow | null }>();
    for (const raw of matrix.data ?? []) {
      const r = numify<MatrixRow>(raw);
      const cur = m.get(r.count_str) ?? { me: null, team: null };
      if (r.me) cur.me = r;
      else cur.team = r;
      m.set(r.count_str, cur);
    }
    return m;
  }, [matrix.data]);

  const nodes: CountNode[] = useMemo(() => {
    const m = new Map<string, CountNode>();
    for (const raw of flowNodes.data ?? []) {
      const r = numify<MatrixRow>(raw);
      const cur = m.get(r.count_str) ?? { count: r.count_str, reached: 0, k: 0, bb: 0, h: 0, ab: 0, team: null };
      const o = { reached: r.reached ?? 0, k: r.k ?? 0, bb: r.bb ?? 0, h: r.h ?? 0, ab: r.ab ?? 0 };
      if (r.me) Object.assign(cur, o);
      else cur.team = o;
      m.set(r.count_str, cur);
    }
    return [...m.values()].filter((n) => n.reached > 0);
  }, [flowNodes.data]);
  const transitions: Transition[] = useMemo(() => (flow.data ?? []).map((r) => ({ src: String(r.src), dst: String(r.dst), n: Number(r.n) })), [flow.data]);

  const typeList = (types.data ?? []).map((t) => t.pitch_type).filter((t) => (PITCH_TYPES as readonly string[]).includes(t));
  const m = METRICS[metric];

  const inspectCount = (count: string) =>
    openSet({
      title: `${count} · ${pitchFilterLabel(pitch)} · ${m.label}`,
      subtitle: `${hitter} — pitches in ${m.label} denominator (${m.den}); highlighted = numerator`,
      where: `${buildWhere(filters, hitter)} AND count_str = ${sqlStr(count)} AND (${pf}) AND (${m.den})`,
      highlightSql: m.num,
      highlightLabel: m.label.replace("%", ""),
    });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Count matrix"
          subtitle={`${m.label} by count on ${pitchFilterLabel(pitch)}. Tint = vs teammates in the same count (red above, blue below). Bottom line = how PAs that reached the count ended.`}
          actions={
            <>
              <Segmented value={metric} onChange={setMetric} options={MATRIX_METRICS} label="Matrix metric" />
              <select
                value={pitch}
                onChange={(e) => setPitch(e.target.value)}
                className="h-7 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink"
                aria-label="Pitch filter"
              >
                <option value="ALL">All pitches</option>
                <optgroup label="Pitch group">
                  {["Fastball", "Breaking", "Offspeed"].map((g) => (
                    <option key={g} value={`G:${g}`}>
                      {PITCH_GROUP_PLURAL[g]}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Pitch type">
                  {typeList.map((t) => (
                    <option key={t} value={`T:${t}`}>
                      {PITCH_TYPE_NAME[t]} ({t})
                    </option>
                  ))}
                </optgroup>
              </select>
            </>
          }
        />
        <CardBody>
          {matrix.loading ? (
            <div className="skeleton h-80" />
          ) : (
            <div className="overflow-x-auto">
              <div className="grid min-w-[720px] grid-cols-[3.5rem_repeat(4,minmax(0,1fr))] gap-1.5">
                <div />
                {[0, 1, 2, 3].map((b) => (
                  <div key={b} className="text-center text-[11px] font-medium uppercase tracking-wide text-ink-3">
                    {b} ball{b === 1 ? "" : "s"}
                  </div>
                ))}
                {[0, 1, 2].map((s) => (
                  <MatrixRowCells key={s} strikes={s} cells={cells} metric={metric} minN={filters.minN} onInspect={inspectCount} />
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Count × pitch type" subtitle={`${m.label} on each pitch type in each count. Tint = vs his own ${m.label} on that pitch in all counts (isolates the count effect).`} />
        <CardBody className="overflow-x-auto">
          {grid.loading ? <div className="skeleton h-72" /> : <CountTypeGrid rows={grid.data ?? []} types={typeList} metric={metric} minN={filters.minN} />}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Count flow — what happens the rest of the AB" subtitle="Edges show how often his PAs moved ball → right or strike → down. Each count shows how the PAs that reached it ended." />
        <CardBody>
          {flow.loading || flowNodes.loading ? (
            <div className="skeleton h-80" />
          ) : (
            <CountFlow
              nodes={nodes}
              transitions={transitions}
              onNodeClick={(c) =>
                openSet({
                  title: `PAs that reached ${c}`,
                  subtitle: `${hitter} — every pitch of every PA that passed through ${c}; highlighted = the pitches thrown in ${c}`,
                  where: `${buildWhere(filters, hitter)} AND pa_uid IN (SELECT pa_uid FROM enriched_pitches WHERE ${buildWhere(filters, hitter)} AND count_str = ${sqlStr(c)})`,
                  highlightSql: `count_str = ${sqlStr(c)}`,
                  highlightLabel: `Pitches in ${c}`,
                })
              }
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function MatrixRowCells({
  strikes,
  cells,
  metric,
  minN,
  onInspect,
}: {
  strikes: number;
  cells: Map<string, { me: MatrixRow | null; team: MatrixRow | null }>;
  metric: MetricKey;
  minN: number;
  onInspect: (count: string) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-end pr-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">
        {strikes} str
      </div>
      {[0, 1, 2, 3].map((balls) => {
        const count = `${balls}-${strikes}`;
        const c = cells.get(count);
        const me = aggRate(c?.me ?? EMPTY_PITCH_AGG, metric);
        const team = c?.team ? aggRate(c.team, metric) : null;
        const v = me.den ? me.num / me.den : null;
        const t = team && team.den ? team.num / team.den : null;
        const delta = v !== null && t !== null ? v - t : null;
        const small = me.den < minN;
        const reached = c?.me?.reached ?? 0;
        return (
          <button
            key={count}
            type="button"
            onClick={() => onInspect(count)}
            className={cn("group relative rounded-md border border-line p-2.5 text-left transition-[filter] hover:brightness-125", small && "opacity-60")}
            style={{ background: delta !== null && !small ? divergingFill(delta, 0.25) : "var(--color-surface-2)" }}
          >
            <div className="flex items-baseline justify-between">
              <span className="num text-base font-bold text-ink">{count}</span>
              <span className="num text-[10px] text-ink-2">{c?.me?.n ?? 0} pitches</span>
            </div>
            <div className="mt-1.5 text-sm">
              <RateText r={me} />
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-2">
              tm {pct(t, 0)}
              {delta !== null ? (
                <span className={cn("ml-1.5 font-semibold", Math.abs(delta) >= 0.1 ? "text-ink" : "text-ink-2")}>
                  {delta >= 0 ? "+" : ""}
                  {Math.round(delta * 100)} pts
                </span>
              ) : null}
              {small ? <span className="ml-1.5 text-warn">small n</span> : null}
            </div>
            {reached ? (
              <div className="num mt-1.5 border-t border-white/10 pt-1 text-[10px] text-ink-2">
                From here: K {pct((c?.me?.k ?? 0) / reached, 0)} · AVG {fmtAvg(c?.me?.ab ? (c.me.h ?? 0) / c.me.ab : null)} · {reached} PA
              </div>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

function CountTypeGrid({ rows, types, metric, minN }: { rows: Record<string, unknown>[]; types: string[]; metric: MetricKey; minN: number }) {
  const { byCell, byType, byCount } = useMemo(() => {
    const byCell = new Map<string, PitchAgg>();
    const byType = new Map<string, PitchAgg>();
    const byCount = new Map<string, PitchAgg>();
    const add = (m: Map<string, PitchAgg>, k: string, r: PitchAgg) => {
      const cur = m.get(k) ?? { ...EMPTY_PITCH_AGG };
      for (const key of Object.keys(EMPTY_PITCH_AGG) as (keyof PitchAgg)[]) cur[key] += r[key];
      m.set(k, cur);
    };
    for (const raw of rows) {
      const r = numify<PitchAgg & { count_str: string; pitch_type: string }>(raw);
      byCell.set(`${r.count_str}|${r.pitch_type}`, r);
      add(byType, r.pitch_type, r);
      add(byCount, r.count_str, r);
    }
    return { byCell, byType, byCount };
  }, [rows]);

  const cell = (r: Rate, base: Rate | null) => {
    const v = r.den ? r.num / r.den : null;
    const b = base && base.den ? base.num / base.den : null;
    const delta = v !== null && b !== null ? v - b : null;
    const small = r.den < minN;
    return (
      <td className="p-0.5">
        <div className={cn("rounded px-1.5 py-1 text-right", small && "opacity-45")} style={{ background: delta !== null && !small ? divergingFill(delta, 0.3) : undefined }}>
          <RateText r={r} stacked />
        </div>
      </td>
    );
  };

  return (
    <table className="w-full min-w-[640px] text-xs">
      <thead>
        <tr className="text-ink-3">
          <th className="px-2 py-1.5 text-left font-medium">Count</th>
          <th className="px-2 py-1.5 text-right font-medium">All</th>
          {types.map((t) => (
            <th key={t} className="px-2 py-1.5 text-right font-medium" title={PITCH_TYPE_NAME[t]}>
              {t}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {COUNTS.map((c) => (
          <tr key={c} className="border-t border-line/60">
            <td className="num px-2 py-1 font-semibold text-ink">{c}</td>
            {cell(aggRate(byCount.get(c), metric), null)}
            {types.map((t) => (
              <Fragment key={t}>{cell(aggRate(byCell.get(`${c}|${t}`), metric), aggRate(byType.get(t), metric))}</Fragment>
            ))}
          </tr>
        ))}
        <tr className="border-t border-line-strong">
          <td className="px-2 py-1 font-medium text-ink-2">All counts</td>
          {cell(
            aggRate(
              [...byType.values()].reduce((a, r) => {
                const o = { ...a };
                for (const k of Object.keys(EMPTY_PITCH_AGG) as (keyof PitchAgg)[]) o[k] += r[k];
                return o;
              }, { ...EMPTY_PITCH_AGG }),
              metric,
            ),
            null,
          )}
          {types.map((t) => (
            <Fragment key={t}>{cell(aggRate(byType.get(t), metric), null)}</Fragment>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
