"use client";

import { useMemo, useState } from "react";
import { Loader2, Radar } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { useScan } from "@/hooks/useScan";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InsightCard } from "@/components/scout/InsightCard";
import { CsvDropzone } from "@/components/data/CsvDropzone";
import { CATEGORY_META, PROBE_COUNT, type Insight, type InsightCategory } from "@/lib/tendency-scanner";
import { describeFilters } from "@/lib/filters";
import { displayName } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const CATEGORIES = Object.keys(CATEGORY_META) as InsightCategory[];

export function ScoutResults({ hitter, autoRun = false }: { hitter: string | null; autoRun?: boolean }) {
  const { where, filters, status } = useData();
  const scan = useScan(hitter, autoRun);
  const [cats, setCats] = useState<Set<InsightCategory>>(new Set());
  const [conf, setConf] = useState<Set<Insight["confidence"]>>(new Set(["High", "Medium"]));

  const filtered = useMemo(
    () => (scan.insights ?? []).filter((i) => (cats.size === 0 || cats.has(i.category)) && conf.has(i.confidence)),
    [scan.insights, cats, conf],
  );
  const byCat = useMemo(() => {
    const m = new Map<InsightCategory, Insight[]>();
    for (const i of filtered) m.set(i.category, [...(m.get(i.category) ?? []), i]);
    return CATEGORIES.filter((c) => m.has(c)).map((c) => [c, m.get(c)!] as const);
  }, [filtered]);
  const counts = useMemo(() => {
    const m = new Map<InsightCategory, number>();
    for (const i of scan.insights ?? []) if (conf.has(i.confidence)) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return m;
  }, [scan.insights, conf]);

  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={scan.run} disabled={status !== "ready" || scan.loading}>
          {scan.loading ? <Loader2 className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
          {scan.started ? "Re-run Sequence Scan" : "Run Sequence Scan"}
        </Button>
        <span className="text-xs text-ink-3">
          {PROBE_COUNT} parameterized SQL probes over enriched_pitches · {describeFilters(filters)}
          {scan.insights ? ` · ${scan.insights.length} findings in ${(scan.ms / 1000).toFixed(1)}s` : ""}
        </span>
      </div>
      {scan.error ? <p className="text-sm text-[#f08080]">{scan.error}</p> : null}

      {scan.insights ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCats((s) => toggle(s, c))}
                aria-pressed={cats.has(c)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                  cats.has(c) ? "border-crimson-text bg-crimson/20 text-ink" : "border-line-strong text-ink-2 hover:text-ink",
                )}
              >
                {CATEGORY_META[c].label}
                <span className="num text-ink-3">{counts.get(c) ?? 0}</span>
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-line-strong" />
            {(["High", "Medium", "Low"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setConf((s) => toggle(s, c))}
                aria-pressed={conf.has(c)}
                className={cn("inline-flex h-7 items-center rounded-full border px-2.5 text-xs", conf.has(c) ? "border-ink-2 text-ink" : "border-line-strong text-ink-3")}
              >
                {c}
              </button>
            ))}
          </div>
          {byCat.map(([cat, list]) => (
            <section key={cat}>
              <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-ink">
                {CATEGORY_META[cat].label}
                <span className="text-xs font-normal text-ink-3">{CATEGORY_META[cat].blurb}</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((ins) => (
                  <InsightCard key={ins.id} ins={ins} globalWhere={where} showHitter={!hitter} />
                ))}
              </div>
            </section>
          ))}
          {filtered.length === 0 ? <p className="text-sm text-ink-3">No findings pass the current confidence/category filters. Try including Low confidence or lowering the min sample.</p> : null}
        </>
      ) : scan.loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton h-48" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ScoutBoard() {
  const { status, hitters } = useData();
  const [hitter, setHitter] = useState<string>("");
  if (status === "empty") {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-4 text-xl font-semibold">Auto-Scout</h1>
        <CsvDropzone />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Auto-Scout · Sequence Scan</h1>
          <p className="mt-1 max-w-3xl text-xs text-ink-3">
            Scans every hitter (or one) for count &amp; pitch-type locks, freezes, chase triggers, 2-pitch tunnels, velo traps and sequence archetypes. Count habits are
            compared with teammates in the same count; sequence effects with the hitter&apos;s own pitches otherwise — and must also separate him from teammates.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-3">
          Scope
          <select value={hitter} onChange={(e) => setHitter(e.target.value)} className="h-8 rounded-md border border-line-strong bg-surface-2 px-2 text-sm text-ink">
            <option value="">Whole roster ({hitters.length})</option>
            {hitters.map((h) => (
              <option key={h.batter_name} value={h.batter_name}>
                {displayName(h.batter_name)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {hitter ? <Badge tone="crimson">Scoped to {displayName(hitter)}</Badge> : null}
      <ScoutResults key={hitter || "all"} hitter={hitter || null} />
    </div>
  );
}
