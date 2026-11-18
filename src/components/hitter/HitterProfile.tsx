"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { CountPanel } from "@/components/hitter/CountPanel";
import { FreezePanel } from "@/components/hitter/FreezePanel";
import { SequencePanel } from "@/components/hitter/SequencePanel";
import { SituationalPanel } from "@/components/hitter/SituationalPanel";
import { ZonePanel } from "@/components/hitter/ZonePanel";
import { PaLogPanel } from "@/components/hitter/PaLogPanel";
import { ScoutResults } from "@/components/scout/ScoutBoard";
import { hitterHeaderSql, hitterPaSql, numify, slash, type PaAgg, type PitchAgg } from "@/lib/queries";
import { displayName, fmtAvg, pct, type Rate } from "@/lib/metrics";
import { describeFilters } from "@/lib/filters";

type HeaderRow = PitchAgg & {
  me: boolean;
  fp_n: number;
  fp_sw: number;
  ts_sw: number;
  ts_wh: number;
  ev_avg: number | null;
  ev_max: number | null;
  side_any: string | null;
  sides: number;
  first_date: string | null;
  last_date: string | null;
  games: number;
};

function vs(me: Rate, team: Rate | null) {
  const m = me.den ? me.num / me.den : null;
  const t = team && team.den ? team.num / team.den : null;
  return {
    value: pct(m),
    sub: `${me.num}/${me.den}${t !== null ? ` · tm ${pct(t, 0)}` : ""}`,
  };
}

export function HitterProfile({ hitter }: { hitter: string }) {
  const { status, where, filters } = useData();
  const head = useDuckQuery(status === "ready" ? hitterHeaderSql(where, hitter) : null);
  const pa = useDuckQuery(status === "ready" ? hitterPaSql(where, hitter) : null);

  const { me, team } = useMemo(() => {
    const rows = (head.data ?? []).map((r) => numify<HeaderRow>(r));
    return { me: rows.find((r) => r.me) ?? null, team: rows.find((r) => !r.me) ?? null };
  }, [head.data]);
  const { pme, pteam } = useMemo(() => {
    const rows = (pa.data ?? []).map((r) => numify<PaAgg & { me: boolean }>(r));
    return { pme: rows.find((r) => r.me) ?? null, pteam: rows.find((r) => !r.me) ?? null };
  }, [pa.data]);

  if (status === "booting" || head.loading) return <div className="skeleton h-96" />;
  if (status !== "ready") {
    return (
      <p className="text-sm text-ink-2">
        No dataset loaded. <Link href="/" className="text-crimson-text underline">Load CSVs or the demo dataset</Link>.
      </p>
    );
  }
  if (!me) {
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-2">
        No pitches for <span className="text-ink">{displayName(hitter)}</span> with the current filters ({describeFilters(filters)}).{" "}
        <Link href="/" className="text-crimson-text underline">Back to roster</Link>
      </div>
    );
  }

  const s = slash(pme);
  const ts = slash(pteam);
  const bats = me.sides > 1 ? "Switch" : me.side_any === "L" ? "Bats L" : me.side_any === "R" ? "Bats R" : "";
  const sw = vs({ num: me.sw, den: me.n }, team ? { num: team.sw, den: team.n } : null);
  const fr = vs({ num: me.frz, den: me.iz }, team ? { num: team.frz, den: team.iz } : null);
  const hf = vs({ num: me.hfrz, den: me.hz }, team ? { num: team.hfrz, den: team.hz } : null);
  const ch = vs({ num: me.ch, den: me.oz }, team ? { num: team.ch, den: team.oz } : null);
  const wh = vs({ num: me.wh, den: me.sw }, team ? { num: team.wh, den: team.sw } : null);
  const fp = vs({ num: me.fp_sw, den: me.fp_n }, team ? { num: team.fp_sw, den: team.fp_n } : null);
  const tw = vs({ num: me.ts_wh, den: me.ts_sw }, team ? { num: team.ts_wh, den: team.ts_sw } : null);
  const k = vs({ num: pme?.k ?? 0, den: pme?.pa ?? 0 }, pteam ? { num: pteam.k, den: pteam.pa } : null);
  const bb = vs({ num: pme?.bb ?? 0, den: pme?.pa ?? 0 }, pteam ? { num: pteam.bb, den: pteam.pa } : null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{displayName(hitter)}</h1>
            {bats ? <Badge tone="neutral">{bats}</Badge> : null}
            <Badge tone="crimson">Hitter profile</Badge>
          </div>
          <p className="num mt-1 text-xs text-ink-3">
            {me.games} games · {me.first_date} → {me.last_date} · {describeFilters(filters)} · “tm” = teammates in the same filter
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="PA" value={pme?.pa ?? "—"} sub={`${me.n} pitches`} />
        <Stat label="AVG/OBP/SLG" className="col-span-2" value={<span className="text-base">{fmtAvg(s.avg)}/{fmtAvg(s.obp)}/{fmtAvg(s.slg)}</span>} sub={`tm ${fmtAvg(ts.avg)}/${fmtAvg(ts.obp)}/${fmtAvg(ts.slg)}`} />
        <Stat label="K%" value={k.value} sub={`${k.sub}${pme ? ` · ${pme.kl} looking` : ""}`} />
        <Stat label="BB%" value={bb.value} sub={bb.sub} />
        <Stat label="Swing%" value={sw.value} sub={sw.sub} />
        <Stat label="Freeze%" value={fr.value} sub={fr.sub} />
        <Stat label="Heart Freeze%" value={hf.value} sub={hf.sub} />
        <Stat label="Chase%" value={ch.value} sub={ch.sub} />
        <Stat label="Whiff%" value={wh.value} sub={wh.sub} />
        <Stat label="1st-Pitch Swing" value={fp.value} sub={fp.sub} />
        <Stat label="2-Strike Whiff" value={tw.value} sub={tw.sub} />
      </div>

      <Tabs defaultValue="counts">
        <TabsList>
          <TabsTrigger value="counts">Counts</TabsTrigger>
          <TabsTrigger value="freeze">Freeze Report</TabsTrigger>
          <TabsTrigger value="sequencing">Sequencing &amp; Tunnels</TabsTrigger>
          <TabsTrigger value="situational">Situational</TabsTrigger>
          <TabsTrigger value="scout">Auto-Scout</TabsTrigger>
          <TabsTrigger value="zone">Zone</TabsTrigger>
          <TabsTrigger value="log">PA Log</TabsTrigger>
        </TabsList>
        <TabsContent value="counts">
          <CountPanel hitter={hitter} />
        </TabsContent>
        <TabsContent value="freeze">
          <FreezePanel hitter={hitter} />
        </TabsContent>
        <TabsContent value="sequencing">
          <SequencePanel hitter={hitter} />
        </TabsContent>
        <TabsContent value="situational">
          <SituationalPanel hitter={hitter} />
        </TabsContent>
        <TabsContent value="scout">
          <ScoutResults hitter={hitter} autoRun />
        </TabsContent>
        <TabsContent value="zone">
          <ZonePanel hitter={hitter} />
        </TabsContent>
        <TabsContent value="log">
          <PaLogPanel hitter={hitter} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
