"use client";

import { Fragment, useMemo, useState } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useInspector } from "@/components/providers/InspectorProvider";
import { useBreakdown, usePaBreakdown } from "@/hooks/useBreakdown";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { RateText } from "@/components/ui/rate";
import { RateBars, RateBarsLegend } from "@/components/viz/RateBars";
import { buildWhere } from "@/lib/filters";
import { aggRate, EMPTY_PITCH_AGG, numify, transitionSql, type PaAgg, type PitchAgg } from "@/lib/queries";
import { METRICS, PITCH_TYPE_NAME, PITCH_TYPES, displayName, fmtAvg, pct, sqlStr, type MetricKey } from "@/lib/metrics";
import { divergingFill } from "@/lib/color";
import { cn } from "@/lib/utils";

const T_METRICS = [
  { value: "whiff", label: "Whiff%" },
  { value: "chase", label: "Chase%" },
  { value: "swing", label: "Swing%" },
  { value: "freeze", label: "Freeze%" },
] as const satisfies readonly { value: MetricKey; label: string }[];
type TMetric = (typeof T_METRICS)[number]["value"];

const REACTION_SQL = `CASE
  WHEN prev_is_whiff THEN '1 · after a whiff'
  WHEN prev_is_freeze THEN '2 · after freezing on a strike'
  WHEN prev_pitch_call = 'StrikeCalled' THEN '3 · after a called strike (edge)'
  WHEN prev_pitch_call = 'BallCalled' THEN '4 · after taking a ball'
  WHEN prev_pitch_call = 'FoulBall' THEN '5 · after a foul'
END`;

const VELO_SQL = `CASE
  WHEN velo_delta_from_prev <= -8 THEN '1 · 8+ mph slower'
  WHEN velo_delta_from_prev <= -3 THEN '2 · 3-8 mph slower'
  WHEN velo_delta_from_prev < 3 THEN '3 · within 3 mph'
  WHEN velo_delta_from_prev < 8 THEN '4 · 3-8 mph faster'
  ELSE '5 · 8+ mph faster' END`;

const hs = (s: string) => s.split("").map((c) => (c === "H" ? "Hard" : c === "S" ? "Soft" : "?")).join(" → ");

export function SequencePanel({ hitter }: { hitter: string }) {
  const { status, where, filters } = useData();
  const { openSet } = useInspector();
  const [metric, setMetric] = useState<TMetric>("whiff");
  const hw = buildWhere(filters, hitter);
  const trans = useDuckQuery(status === "ready" ? transitionSql(where, hitter) : null);
  const reaction = useBreakdown(hitter, REACTION_SQL, "prev_pitch_call IS NOT NULL");
  const velo = useBreakdown(hitter, VELO_SQL, "velo_delta_from_prev IS NOT NULL");
  const arche = usePaBreakdown(hitter, "pa_first3_hs", "pa_pitch_count >= 3 AND pa_first3_hs NOT LIKE '%?%'");
  const m = METRICS[metric];

  const { cells, curTotals, prevTypes, curTypes } = useMemo(() => {
    const cells = new Map<string, PitchAgg>();
    const curTotals = new Map<string, PitchAgg>();
    const prevSet = new Set<string>();
    const curSet = new Set<string>();
    for (const raw of trans.data ?? []) {
      const r = numify<PitchAgg & { prev: string; cur: string }>(raw);
      cells.set(`${r.prev}|${r.cur}`, r);
      prevSet.add(r.prev);
      curSet.add(r.cur);
      const t = curTotals.get(r.cur) ?? { ...EMPTY_PITCH_AGG };
      for (const k of Object.keys(EMPTY_PITCH_AGG) as (keyof PitchAgg)[]) t[k] += r[k];
      curTotals.set(r.cur, t);
    }
    const order = (s: Set<string>) => (PITCH_TYPES as readonly string[]).filter((t) => s.has(t));
    return { cells, curTotals, prevTypes: order(prevSet), curTypes: order(curSet) };
  }, [trans.data]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="2-pitch transitions: previous pitch → this pitch"
          subtitle={`${m.label} on the current pitch (columns) given the previous pitch (rows). Tint = vs the column total (his ${m.label} on that pitch after anything). Click a cell to see the tunnel.`}
          actions={<Segmented value={metric} onChange={setMetric} options={T_METRICS} label="Transition metric" />}
        />
        <CardBody className="overflow-x-auto">
          {trans.loading ? (
            <div className="skeleton h-64" />
          ) : (
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-ink-3">
                  <th className="px-2 py-1.5 text-left font-medium">Prev ↓ / This →</th>
                  {curTypes.map((c) => (
                    <th key={c} className="px-2 py-1.5 text-right font-medium" title={PITCH_TYPE_NAME[c]}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prevTypes.map((p) => (
                  <tr key={p} className="border-t border-line/60">
                    <td className="px-2 py-1 font-medium text-ink">
                      {PITCH_TYPE_NAME[p] ?? p} <span className="text-ink-3">({p})</span>
                    </td>
                    {curTypes.map((c) => {
                      const r = aggRate(cells.get(`${p}|${c}`), metric);
                      const base = aggRate(curTotals.get(c), metric);
                      const v = r.den ? r.num / r.den : null;
                      const b = base.den ? base.num / base.den : null;
                      const delta = v !== null && b !== null ? v - b : null;
                      const small = r.den < filters.minN;
                      return (
                        <td key={c} className="p-0.5">
                          <button
                            type="button"
                            disabled={!r.den}
                            onClick={() =>
                              openSet({
                                title: `${PITCH_TYPE_NAME[c] ?? c} after ${PITCH_TYPE_NAME[p] ?? p} · ${m.label}`,
                                subtitle: `${displayName(hitter)} — dashed vectors show the previous pitch → this pitch tunnel; highlighted = ${m.label} numerator`,
                                where: `${hw} AND prev_pitch_type = ${sqlStr(p)} AND pitch_type = ${sqlStr(c)} AND (${m.den})`,
                                highlightSql: m.num,
                                highlightLabel: m.label.replace("%", ""),
                              })
                            }
                            className={cn("w-full rounded px-1.5 py-1 text-right enabled:hover:brightness-125", small && "opacity-45")}
                            style={{ background: delta !== null && !small ? divergingFill(delta, 0.3) : undefined }}
                          >
                            <RateText r={r} stacked />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-line-strong">
                  <td className="px-2 py-1 text-ink-2">After anything</td>
                  {curTypes.map((c) => (
                    <td key={c} className="px-1.5 py-1 text-right">
                      <RateText r={aggRate(curTotals.get(c), metric)} stacked />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <RateBarsLegend />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Reaction to the previous pitch" subtitle="What he does on the very next pitch (vs teammates after the same thing)" />
          <CardBody className="space-y-4">
            {(["swing", "chase", "freeze", "whiff"] as const).map((mk) => (
              <div key={mk}>
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{METRICS[mk].label} on the next pitch</h4>
                <RateBars
                  minN={filters.minN}
                  rows={[...reaction.map.keys()].sort().map((k) => ({
                    key: k,
                    label: k.slice(4),
                    me: aggRate(reaction.map.get(k)?.me, mk),
                    team: reaction.map.get(k)?.team ? aggRate(reaction.map.get(k)!.team, mk) : null,
                    onClick: () =>
                      openSet({
                        title: `Next pitch ${k.slice(4)} · ${METRICS[mk].label}`,
                        subtitle: displayName(hitter),
                        where: `${hw} AND prev_pitch_call IS NOT NULL AND (${REACTION_SQL}) = ${sqlStr(k)} AND (${METRICS[mk].den})`,
                        highlightSql: METRICS[mk].num,
                        highlightLabel: METRICS[mk].label.replace("%", ""),
                      }),
                  }))}
                />
              </div>
            ))}
          </CardBody>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Velo differential traps" subtitle="Whiff% and chase% by speed change from the previous pitch" />
            <CardBody className="space-y-4">
              {(["whiff", "chase"] as const).map((mk) => (
                <div key={mk}>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{METRICS[mk].label}</h4>
                  <RateBars
                    minN={filters.minN}
                    rows={[...velo.map.keys()].sort().map((k) => ({
                      key: k,
                      label: k.slice(4),
                      me: aggRate(velo.map.get(k)?.me, mk),
                      team: velo.map.get(k)?.team ? aggRate(velo.map.get(k)!.team, mk) : null,
                    }))}
                  />
                </div>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Sequence archetypes (first 3 pitches)" subtitle="PAs of 3+ pitches by how they opened. Hard = FF/SI/FC, Soft = everything else." />
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-surface-2 text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Opening</th>
                    <th className="px-2 py-2 text-right font-medium">PA</th>
                    <th className="px-2 py-2 text-right font-medium">K%</th>
                    <th className="px-2 py-2 text-right font-medium">K or weak</th>
                    <th className="px-2 py-2 text-right font-medium">AVG</th>
                    <th className="px-2 py-2 text-right font-medium">Team K%</th>
                  </tr>
                </thead>
                <tbody>
                  {[...arche.map.entries()]
                    .filter(([, v]) => v.me)
                    .sort((a, b) => (b[1].me!.k + b[1].me!.weak) / b[1].me!.pa - (a[1].me!.k + a[1].me!.weak) / a[1].me!.pa)
                    .map(([k, v]) => {
                      const me = v.me as PaAgg;
                      const t = v.team;
                      return (
                        <Fragment key={k}>
                          <tr
                            className={cn("cursor-pointer border-t border-line hover:bg-surface-2", me.pa < filters.minN && "opacity-50")}
                            onClick={() =>
                              openSet({
                                title: `PAs opening ${hs(k)}`,
                                subtitle: displayName(hitter),
                                where: `${hw} AND pa_first3_hs = ${sqlStr(k)} AND pa_pitch_count >= 3`,
                                highlightSql: "pa_pitch_seq <= 3",
                                highlightLabel: "First 3 pitches",
                              })
                            }
                          >
                            <td className="num px-3 py-1.5 text-ink">{hs(k)}</td>
                            <td className="num px-2 py-1.5 text-right text-ink-2">{me.pa}</td>
                            <td className="px-2 py-1.5 text-right">
                              <RateText r={{ num: me.k, den: me.pa }} />
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <RateText r={{ num: me.k + me.weak, den: me.pa }} />
                            </td>
                            <td className="num px-2 py-1.5 text-right text-ink">{fmtAvg(me.ab ? me.h / me.ab : null)}</td>
                            <td className="num px-2 py-1.5 text-right text-ink-3">{t ? pct(t.k / t.pa, 0) : "—"}</td>
                          </tr>
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
