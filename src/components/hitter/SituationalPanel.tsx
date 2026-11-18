"use client";

import { Fragment, useMemo } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useInspector } from "@/components/providers/InspectorProvider";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardHeader } from "@/components/ui/card";
import { RateText } from "@/components/ui/rate";
import { buildWhere } from "@/lib/filters";
import { aggRate, numify, PA_AGG, PITCH_AGG, slash, type PaAgg, type PitchAgg } from "@/lib/queries";
import { displayName, fmtAvg, pct, sqlStr, type MetricKey } from "@/lib/metrics";
import { divergingFill } from "@/lib/color";
import { cn } from "@/lib/utils";

const SPLITS: { section: string; sql: string; order?: string[] }[] = [
  { section: "Pitcher hand", sql: "CASE pitcher_throws WHEN 'R' THEN 'vs RHP' WHEN 'L' THEN 'vs LHP' END", order: ["vs RHP", "vs LHP"] },
  { section: "Outs", sql: "CASE outs WHEN 0 THEN '0 outs' WHEN 1 THEN '1 out' WHEN 2 THEN '2 outs' END", order: ["0 outs", "1 out", "2 outs"] },
  { section: "Runners", sql: "CASE WHEN base_state IS NULL THEN NULL WHEN base_state = '---' THEN 'Bases empty' WHEN risp THEN 'RISP' ELSE 'Runner on 1st only' END", order: ["Bases empty", "Runner on 1st only", "RISP"] },
  { section: "PA in game", sql: "CASE WHEN pa_num_in_game = 1 THEN '1st PA' WHEN pa_num_in_game = 2 THEN '2nd PA' WHEN pa_num_in_game = 3 THEN '3rd PA' ELSE '4th+ PA' END", order: ["1st PA", "2nd PA", "3rd PA", "4th+ PA"] },
  { section: "Look at pitcher", sql: "CASE WHEN times_faced_pitcher = 1 THEN '1st look' ELSE '2nd+ look' END", order: ["1st look", "2nd+ look"] },
  { section: "Inning", sql: "CASE WHEN inning <= 3 THEN 'Innings 1-3' WHEN inning <= 6 THEN 'Innings 4-6' ELSE 'Innings 7+' END", order: ["Innings 1-3", "Innings 4-6", "Innings 7+"] },
];

const COLS: { key: MetricKey; label: string }[] = [
  { key: "swing", label: "Swing%" },
  { key: "freeze", label: "Freeze%" },
  { key: "chase", label: "Chase%" },
  { key: "whiff", label: "Whiff%" },
  { key: "hardHit", label: "Hard-Hit%" },
];

function unionSql(where: string, hitter: string, agg: string, extra: string): string {
  return SPLITS.map(
    (s, i) => `SELECT ${i} AS si, ${sqlStr(s.section)} AS section, CAST(${s.sql} AS VARCHAR) AS dim, batter_name = ${sqlStr(hitter)} AS me, ${agg}
      FROM enriched_pitches WHERE ${where} AND (${extra}) AND (${s.sql}) IS NOT NULL GROUP BY ALL`,
  ).join("\nUNION ALL\n");
}

export function SituationalPanel({ hitter }: { hitter: string }) {
  const { status, where, filters } = useData();
  const { openSet } = useInspector();
  const pitch = useDuckQuery(status === "ready" ? unionSql(where, hitter, PITCH_AGG, "TRUE") : null);
  const pa = useDuckQuery(status === "ready" ? unionSql(where, hitter, PA_AGG, "is_pa_terminal_pitch") : null);

  const data = useMemo(() => {
    const m = new Map<string, { me?: PitchAgg; team?: PitchAgg; pme?: PaAgg; pteam?: PaAgg }>();
    for (const raw of pitch.data ?? []) {
      const r = numify<PitchAgg & { section: string; dim: string; me: boolean }>(raw);
      const k = `${r.section}|${r.dim}`;
      const cur = m.get(k) ?? {};
      if (r.me) cur.me = r;
      else cur.team = r;
      m.set(k, cur);
    }
    for (const raw of pa.data ?? []) {
      const r = numify<PaAgg & { section: string; dim: string; me: boolean }>(raw);
      const k = `${r.section}|${r.dim}`;
      const cur = m.get(k) ?? {};
      if (r.me) cur.pme = r;
      else cur.pteam = r;
      m.set(k, cur);
    }
    return m;
  }, [pitch.data, pa.data]);

  const hw = buildWhere(filters, hitter);

  return (
    <Card>
      <CardHeader
        title="Situational splits"
        subtitle="Same hitter, different situations. Tint = vs teammates in the same situation. Runner splits appear only when the export includes base state (TruMedia)."
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-xs">
          <thead className="bg-surface-2 text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Situation</th>
              <th className="px-2 py-2 text-right font-medium">PA</th>
              <th className="px-2 py-2 text-right font-medium">AVG/OBP/SLG</th>
              <th className="px-2 py-2 text-right font-medium">K%</th>
              {COLS.map((c) => (
                <th key={c.key} className="px-2 py-2 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SPLITS.map((s) => {
              const dims = (s.order ?? []).filter((d) => data.get(`${s.section}|${d}`)?.me);
              if (!dims.length) return null;
              return (
                <Fragment key={s.section}>
                  <tr className="border-t border-line-strong bg-surface-2/40">
                    <td colSpan={4 + COLS.length} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      {s.section}
                    </td>
                  </tr>
                  {dims.map((d) => {
                    const v = data.get(`${s.section}|${d}`)!;
                    const sl = slash(v.pme);
                    const kme = { num: v.pme?.k ?? 0, den: v.pme?.pa ?? 0 };
                    const kt = v.pteam ? v.pteam.k / v.pteam.pa : null;
                    return (
                      <tr
                        key={d}
                        className="cursor-pointer border-t border-line/60 hover:bg-surface-2"
                        onClick={() =>
                          openSet({
                            title: `${displayName(hitter)} — ${d}`,
                            subtitle: "All pitches in this situation; highlighted = swings",
                            where: `${hw} AND (${s.sql}) = ${sqlStr(d)}`,
                            highlightSql: "is_swing",
                            highlightLabel: "Swings",
                          })
                        }
                      >
                        <td className="px-3 py-1.5 text-ink">{d}</td>
                        <td className="num px-2 py-1.5 text-right text-ink-2">{v.pme?.pa ?? 0}</td>
                        <td className="num px-2 py-1.5 text-right text-ink">
                          {fmtAvg(sl.avg)}/{fmtAvg(sl.obp)}/{fmtAvg(sl.slg)}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <RateText r={kme} stacked />
                          {kt !== null ? <div className="num text-[10px] text-ink-3">tm {pct(kt, 0)}</div> : null}
                        </td>
                        {COLS.map((c) => {
                          const r = aggRate(v.me, c.key);
                          const t = v.team ? aggRate(v.team, c.key) : null;
                          const rv = r.den ? r.num / r.den : null;
                          const tv = t && t.den ? t.num / t.den : null;
                          const delta = rv !== null && tv !== null ? rv - tv : null;
                          const small = r.den < filters.minN;
                          return (
                            <td key={c.key} className="p-0.5">
                              <div className={cn("rounded px-1.5 py-1 text-right", small && "opacity-45")} style={{ background: delta !== null && !small ? divergingFill(delta, 0.2) : undefined }}>
                                <RateText r={r} stacked />
                                {tv !== null ? <div className="num text-[10px] text-ink-3">tm {pct(tv, 0)}</div> : null}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {pitch.loading ? <div className="skeleton m-4 h-40" /> : null}
      </div>
    </Card>
  );
}
