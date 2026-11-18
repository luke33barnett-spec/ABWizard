"use client";

import { useMemo } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useInspector, ResultBadge } from "@/components/providers/InspectorProvider";
import { useBreakdown } from "@/hooks/useBreakdown";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { RateBars, RateBarsLegend, type RateBarRow } from "@/components/viz/RateBars";
import { ZoneGrid, type ZoneCellValue } from "@/components/viz/ZoneGrid";
import { buildWhere } from "@/lib/filters";
import { aggRate, type PitchAgg } from "@/lib/queries";
import { COUNTS, PITCH_GROUP_SINGULAR, PITCH_TYPE_NAME, displayName, pct, sqlStr } from "@/lib/metrics";
import type { Split } from "@/hooks/useBreakdown";

const BUCKET_ORDER = ["First Pitch", "Hitter Ahead", "Even", "Pitcher Ahead", "Full"];

function rowsFrom(map: Map<string, Split<PitchAgg>>, order: string[] | null, label: (k: string) => string, onClick?: (k: string) => void): RateBarRow[] {
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()].sort((a, b) => (map.get(b)?.me?.iz ?? 0) - (map.get(a)?.me?.iz ?? 0));
  return keys
    .filter((k) => (map.get(k)?.me?.iz ?? 0) > 0)
    .map((k) => ({
      key: k,
      label: label(k),
      me: aggRate(map.get(k)?.me, "freeze"),
      team: map.get(k)?.team ? aggRate(map.get(k)!.team, "freeze") : null,
      onClick: onClick ? () => onClick(k) : undefined,
    }));
}

interface LookingK {
  pa_uid: string;
  game_date: string;
  pitcher_name: string | null;
  pitcher_throws: string | null;
  pitch_type: string | null;
  rel_speed: number | null;
  location_label: string | null;
  attack_zone: string | null;
  in_zone: boolean | null;
  prev_pitch_type: string | null;
  pa_sequence_full: string | null;
}

export function FreezePanel({ hitter }: { hitter: string }) {
  const { filters, where, status } = useData();
  const { openSet, openPa } = useInspector();
  const hw = buildWhere(filters, hitter);
  const byCount = useBreakdown(hitter, "count_str");
  const byBucket = useBreakdown(hitter, "count_bucket");
  const byType = useBreakdown(hitter, "pitch_type");
  const byPrev = useBreakdown(hitter, "prev_pitch_group");
  const byLoc2k = useBreakdown(hitter, "location_label", "two_strikes");
  const byCell = useBreakdown(hitter, "zone_cell", "in_zone");
  const fpHeart = useBreakdown(hitter, "pitch_group", "is_first_pitch_of_pa");
  const twoK = useBreakdown(hitter, "CASE WHEN two_strikes THEN 'two strikes' END");
  const overall = useBreakdown(hitter, "'all'");
  const kl = useDuckQuery<LookingK>(
    status === "ready"
      ? `SELECT pa_uid, CAST(game_date AS VARCHAR) AS game_date, pitcher_name, pitcher_throws, pitch_type, rel_speed, location_label, attack_zone, in_zone, prev_pitch_type, pa_sequence_full
         FROM enriched_pitches WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND is_called_strike_three ORDER BY game_date DESC`
      : null,
  );
  const ks = useDuckQuery<{ k: number; kl: number }>(
    status === "ready"
      ? `SELECT count(*) FILTER (WHERE pa_is_k) AS k, count(*) FILTER (WHERE pa_is_k_looking) AS kl FROM enriched_pitches WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND is_pa_terminal_pitch`
      : null,
  );

  const inspect = (title: string, extra: string) =>
    openSet({ title, subtitle: `${displayName(hitter)} — in-zone pitches; highlighted = taken (froze)`, where: `${hw} AND in_zone AND (${extra})`, highlightSql: "is_take", highlightLabel: "Froze (took)" });

  const cellMap = useMemo(() => {
    const m = new Map<number, ZoneCellValue>();
    for (const [k, v] of byCell.map) m.set(Number(k), { me: aggRate(v.me, "freeze"), team: v.team ? aggRate(v.team, "freeze") : null });
    return m;
  }, [byCell.map]);

  const all = overall.map.get("all");
  const tk = twoK.map.get("two strikes");
  const fpFb = fpHeart.map.get("Fastball");
  const kRow = ks.data?.[0];
  const klTypes = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of kl.data ?? []) m.set(r.pitch_type ?? "??", (m.get(r.pitch_type ?? "??") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [kl.data]);

  const statFor = (s: Split<PitchAgg> | undefined, metric: "freeze" | "heartFreeze") => {
    const me = aggRate(s?.me, metric);
    const t = s?.team ? aggRate(s.team, metric) : null;
    return { value: pct(me.den ? me.num / me.den : null), sub: `${me.num}/${me.den}${t && t.den ? ` · tm ${pct(t.num / t.den, 0)}` : ""}` };
  };
  const s1 = statFor(all, "freeze");
  const s2 = statFor(all, "heartFreeze");
  const s3 = statFor(fpFb, "heartFreeze");
  const s4 = statFor(tk, "freeze");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Freeze% (in-zone takes)" value={s1.value} sub={s1.sub} />
        <Stat label="Heart Freeze%" value={s2.value} sub={s2.sub} />
        <Stat label="1st-pitch Heart FB taken" value={s3.value} sub={s3.sub} />
        <Stat label="2-strike Freeze%" value={s4.value} sub={s4.sub} />
        <Stat
          label="Looking strikeouts"
          value={kRow ? `${Number(kRow.kl)} of ${Number(kRow.k)} K` : "—"}
          sub={kRow && Number(kRow.k) ? `${pct(Number(kRow.kl) / Number(kRow.k))} of his Ks` : undefined}
        />
      </div>
      <RateBarsLegend />

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Freeze% by count" subtitle="Share of in-zone pitches he took, in each count. Click a row for those pitches." />
          <CardBody>
            <RateBars rows={rowsFrom(byCount.map, [...COUNTS], (k) => k, (k) => inspect(`Freezes in ${k}`, `count_str = ${sqlStr(k)}`))} minN={filters.minN} />
          </CardBody>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Freeze% by count situation" />
            <CardBody>
              <RateBars rows={rowsFrom(byBucket.map, BUCKET_ORDER, (k) => k, (k) => inspect(`Freezes — ${k}`, `count_bucket = ${sqlStr(k)}`))} minN={filters.minN} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Freeze% by pitch type" />
            <CardBody>
              <RateBars rows={rowsFrom(byType.map, null, (k) => `${PITCH_TYPE_NAME[k] ?? k} (${k})`, (k) => inspect(`Freezes on ${PITCH_TYPE_NAME[k] ?? k}`, `pitch_type = ${sqlStr(k)}`))} minN={filters.minN} />
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        <Card>
          <CardHeader title="After the previous pitch" subtitle="Freeze% on this pitch, by what he saw last" />
          <CardBody>
            <RateBars
              rows={rowsFrom(byPrev.map, ["Fastball", "Breaking", "Offspeed"], (k) => `after ${k === "Offspeed" ? "an" : "a"} ${PITCH_GROUP_SINGULAR[k] ?? k}`, (k) => inspect(`Freezes after a ${k}`, `prev_pitch_group = ${sqlStr(k)}`))}
              minN={filters.minN}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Two-strike freezes by location" subtitle="Where he gets caught looking (in-zone only)" />
          <CardBody>
            <RateBars
              rows={rowsFrom(new Map([...byLoc2k.map].filter(([, v]) => (v.me?.iz ?? 0) > 0)), null, (k) => k, (k) => inspect(`2-strike freezes ${k}`, `two_strikes AND location_label = ${sqlStr(k)}`))}
              minN={filters.minN}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Freeze% by zone" subtitle="In-zone 3×3, catcher's view. Tint vs team." />
          <CardBody className="flex justify-center">
            <ZoneGrid cells={cellMap} includeOuter={false} minN={filters.minN} label="Freeze rate by zone cell" onCellClick={(c) => inspect(`Freezes in zone ${c}`, `zone_cell = ${c}`)} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Called third strikes"
          subtitle={klTypes.length ? `By pitch: ${klTypes.map(([t, n]) => `${PITCH_TYPE_NAME[t] ?? t} ${n}`).join(" · ")}` : "Every PA that ended on a called strike three"}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="bg-surface-2 text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Pitcher</th>
                <th className="px-3 py-2 font-medium">Pitch</th>
                <th className="px-3 py-2 text-right font-medium">Velo</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Previous</th>
                <th className="px-3 py-2 font-medium">Sequence</th>
              </tr>
            </thead>
            <tbody>
              {(kl.data ?? []).map((r) => (
                <tr key={r.pa_uid} className="cursor-pointer border-t border-line hover:bg-surface-2" onClick={() => openPa(r.pa_uid)}>
                  <td className="num px-3 py-1.5 text-ink-2">{r.game_date}</td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {displayName(r.pitcher_name)} <span className="text-ink-3">{r.pitcher_throws}HP</span>
                  </td>
                  <td className="px-3 py-1.5 text-ink">{r.pitch_type ? PITCH_TYPE_NAME[r.pitch_type] ?? r.pitch_type : "—"}</td>
                  <td className="num px-3 py-1.5 text-right text-ink-2">{r.rel_speed?.toFixed(1) ?? "—"}</td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {r.location_label ?? "—"} <span className="text-ink-3">{r.attack_zone}{r.in_zone === false ? " (off plate)" : ""}</span>
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">{r.prev_pitch_type ? PITCH_TYPE_NAME[r.prev_pitch_type] ?? r.prev_pitch_type : "—"}</td>
                  <td className="num max-w-[22rem] truncate px-3 py-1.5 text-ink-3" title={r.pa_sequence_full ?? ""}>
                    {r.pa_sequence_full}
                  </td>
                </tr>
              ))}
              {!kl.loading && (kl.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-ink-3">
                    No called third strikes in this filter. <ResultBadge result={null} />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
