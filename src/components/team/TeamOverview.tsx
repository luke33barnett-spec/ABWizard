"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDownWideNarrow, Radar } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { CsvDropzone } from "@/components/data/CsvDropzone";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/ui/stat";
import { RateText } from "@/components/ui/rate";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { aggRate, numify, PA_AGG, PITCH_AGG, rosterSql, slash, type PaAgg, type PitchAgg } from "@/lib/queries";
import { displayName, fmtAvg, pct, type Rate } from "@/lib/metrics";
import { divergingFill } from "@/lib/color";
import { describeFilters } from "@/lib/filters";
import { cn } from "@/lib/utils";

type RosterRow = PitchAgg &
  PaAgg & { batter_name: string; bats: string | null; team: string | null; fp_n: number; fp_sw: number; ts_sw: number; ts_wh: number };

interface Col {
  key: string;
  label: string;
  title: string;
  get: (r: RosterRow) => Rate | number | null;
  kind: "rate" | "avg" | "int";
  /** +1 if higher is better for the hitter, -1 if lower is better, 0 neutral (still tinted vs team) */
  good?: 1 | -1 | 0;
}

const COLS: Col[] = [
  { key: "pa", label: "PA", title: "Plate appearances", get: (r) => r.pa, kind: "int" },
  { key: "avg", label: "AVG", title: "Batting average", get: (r) => slash(r).avg, kind: "avg" },
  { key: "obp", label: "OBP", title: "On-base percentage", get: (r) => slash(r).obp, kind: "avg" },
  { key: "slg", label: "SLG", title: "Slugging", get: (r) => slash(r).slg, kind: "avg" },
  { key: "k", label: "K%", title: "Strikeouts / PA", get: (r) => ({ num: r.k, den: r.pa }), kind: "rate", good: -1 },
  { key: "kl", label: "Look K%", title: "Called strike three / strikeouts", get: (r) => ({ num: r.kl, den: r.k }), kind: "rate", good: -1 },
  { key: "bb", label: "BB%", title: "Walks / PA", get: (r) => ({ num: r.bb, den: r.pa }), kind: "rate", good: 1 },
  { key: "swing", label: "Swing%", title: "Swings / pitches", get: (r) => aggRate(r, "swing"), kind: "rate", good: 0 },
  { key: "freeze", label: "Freeze%", title: "Takes on in-zone pitches / in-zone pitches", get: (r) => aggRate(r, "freeze"), kind: "rate", good: -1 },
  { key: "hfreeze", label: "Heart Frz%", title: "Takes on Heart-zone pitches", get: (r) => aggRate(r, "heartFreeze"), kind: "rate", good: -1 },
  { key: "chase", label: "Chase%", title: "Swings at out-of-zone pitches", get: (r) => aggRate(r, "chase"), kind: "rate", good: -1 },
  { key: "whiff", label: "Whiff%", title: "Misses / swings", get: (r) => aggRate(r, "whiff"), kind: "rate", good: -1 },
  { key: "fp", label: "1st-P Sw%", title: "First-pitch swing rate", get: (r) => ({ num: r.fp_sw, den: r.fp_n }), kind: "rate", good: 0 },
  { key: "ts", label: "2K Whiff%", title: "Whiff rate on two-strike swings", get: (r) => ({ num: r.ts_wh, den: r.ts_sw }), kind: "rate", good: -1 },
  { key: "hh", label: "Hard-Hit%", title: "EV ≥ 95 mph on balls in play", get: (r) => aggRate(r, "hardHit"), kind: "rate", good: 1 },
];

function valueOf(v: Rate | number | null): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  return v.den ? v.num / v.den : null;
}

export function TeamOverview() {
  const { status, where, filters, summary } = useData();
  const roster = useDuckQuery(status === "ready" ? rosterSql(where) : null);
  const team = useDuckQuery(
    status === "ready"
      ? `SELECT ${PITCH_AGG}, count(*) FILTER (WHERE is_first_pitch_of_pa) AS fp_n FROM enriched_pitches WHERE ${where}`
      : null,
  );
  const teamPa = useDuckQuery(status === "ready" ? `SELECT ${PA_AGG} FROM enriched_pitches WHERE ${where} AND is_pa_terminal_pitch` : null);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "pa", dir: -1 });

  const rows = useMemo(() => (roster.data ?? []).map((r) => numify<RosterRow>(r)), [roster.data]);
  const teamAvg = useMemo(() => {
    const m = new Map<string, number | null>();
    if (!rows.length) return m;
    const sum = rows.reduce<RosterRow>(
      (acc, r) => {
        const o = { ...acc } as Record<string, unknown>;
        for (const [k, v] of Object.entries(r)) if (typeof v === "number") o[k] = ((acc as unknown as Record<string, number>)[k] ?? 0) + v;
        return o as unknown as RosterRow;
      },
      {} as RosterRow,
    );
    for (const c of COLS) m.set(c.key, valueOf(c.get(sum)));
    return m;
  }, [rows]);
  const sorted = useMemo(() => {
    const col = COLS.find((c) => c.key === sort.key);
    return [...rows].sort((a, b) => {
      if (!col) return a.batter_name.localeCompare(b.batter_name) * sort.dir;
      const va = valueOf(col.get(a)) ?? -Infinity;
      const vb = valueOf(col.get(b)) ?? -Infinity;
      return (va - vb) * sort.dir;
    });
  }, [rows, sort]);

  if (status === "booting") {
    return (
      <div className="space-y-4">
        <div className="skeleton h-24" />
        <div className="skeleton h-96" />
      </div>
    );
  }

  if (status === "empty" || status === "error" || !summary) {
    return (
      <div className="mx-auto max-w-3xl py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sequence, count &amp; freeze intelligence for Alabama hitters</h1>
        <p className="mt-2 text-sm text-ink-2">
          Load pitch-by-pitch TrackMan or TruMedia exports. ABWizard builds a profile for every hitter in the files, then digs into what each one does by count, pitch type and
          sequence: when they freeze on hittable strikes, what pulls them out of the zone, and which two-pitch tunnels beat them.
        </p>
        <div className="mt-6">
          <CsvDropzone />
        </div>
      </div>
    );
  }

  const tp = teamPa.data?.[0] ? numify<PaAgg>(teamPa.data[0]) : null;
  const ta = team.data?.[0] ? numify<PitchAgg>(team.data[0]) : null;
  const ts = slash(tp);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Team Overview</h1>
          <p className="text-xs text-ink-3">{describeFilters(filters)}</p>
        </div>
        <Button asChild variant="primary">
          <Link href="/scout">
            <Radar aria-hidden /> Run Sequence Scan
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="PA" value={tp?.pa.toLocaleString() ?? "—"} sub={`${ta?.n.toLocaleString() ?? "—"} pitches`} />
        <Stat label="AVG / OBP / SLG" value={<span className="text-base">{fmtAvg(ts.avg)}/{fmtAvg(ts.obp)}/{fmtAvg(ts.slg)}</span>} />
        <Stat label="K%" value={pct(tp ? tp.k / tp.pa : null)} sub={tp ? `${tp.k}/${tp.pa} · ${tp.kl} looking` : undefined} />
        <Stat label="BB%" value={pct(tp ? tp.bb / tp.pa : null)} sub={tp ? `${tp.bb}/${tp.pa}` : undefined} />
        <Stat label="Swing%" value={pct(ta ? ta.sw / ta.n : null)} sub={ta ? `${ta.sw}/${ta.n}` : undefined} />
        <Stat label="Freeze%" value={pct(ta ? ta.frz / ta.iz : null)} sub={ta ? `${ta.frz}/${ta.iz} in-zone` : undefined} />
        <Stat label="Chase%" value={pct(ta ? ta.ch / ta.oz : null)} sub={ta ? `${ta.ch}/${ta.oz}` : undefined} />
        <Stat label="Whiff%" value={pct(ta ? ta.wh / ta.sw : null)} sub={ta ? `${ta.wh}/${ta.sw}` : undefined} />
      </div>

      <Card>
        <CardHeader
          title="Roster — plate discipline & results"
          subtitle="Click a hitter for his full count, freeze and sequencing profile. Cell tint = difference from the roster average (red above, blue below)."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">
                  <button type="button" onClick={() => setSort({ key: "name", dir: sort.key === "name" ? (-sort.dir as 1 | -1) : 1 })} className="hover:text-ink">
                    Hitter
                  </button>
                </th>
                {COLS.map((c) => (
                  <th key={c.key} className="px-2 py-2 text-right font-medium" title={c.title}>
                    <button
                      type="button"
                      onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : -1 })}
                      className={cn("inline-flex items-center gap-0.5 hover:text-ink", sort.key === c.key && "text-ink")}
                    >
                      {c.label}
                      {sort.key === c.key ? <ArrowDownWideNarrow className={cn("size-3", sort.dir === 1 && "rotate-180")} aria-hidden /> : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.batter_name} className="border-t border-line hover:bg-surface-2/60">
                  <td className="px-3 py-1.5">
                    <Link href={`/hitters/${encodeURIComponent(r.batter_name)}`} className="font-medium text-ink hover:text-crimson-text hover:underline">
                      {displayName(r.batter_name)}
                    </Link>
                    <span className="ml-1.5 text-ink-3">{r.bats ?? ""}</span>
                  </td>
                  {COLS.map((c) => {
                    const v = c.get(r);
                    const val = valueOf(v);
                    const avg = teamAvg.get(c.key) ?? null;
                    const delta = val !== null && avg !== null && c.kind === "rate" ? val - avg : null;
                    return (
                      <td key={c.key} className="px-1 py-1 text-right">
                        <span className="inline-block rounded px-1.5 py-0.5" style={delta !== null && Math.abs(delta) >= 0.03 ? { background: divergingFill(delta, 0.2) } : undefined}>
                          {c.kind === "rate" ? <RateText r={v as Rate} stacked /> : c.kind === "avg" ? <span className="num text-ink">{fmtAvg(val)}</span> : <span className="num text-ink">{val ?? "—"}</span>}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {roster.loading ? (
                <tr>
                  <td colSpan={COLS.length + 1} className="px-3 py-6">
                    <div className="skeleton h-6" />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Add more data" subtitle="Drop additional CSVs any time — new pitches merge in; duplicates are ignored." />
        <CardBody>
          <CsvDropzone compact />
        </CardBody>
      </Card>
    </div>
  );
}
