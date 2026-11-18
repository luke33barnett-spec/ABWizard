"use client";

import Link from "next/link";
import { Eye } from "lucide-react";
import { useInspector } from "@/components/providers/InspectorProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CATEGORY_META, type Insight } from "@/lib/tendency-scanner";
import { METRICS, displayName, pct, sqlStr, type Rate } from "@/lib/metrics";
import { cn } from "@/lib/utils";

/** Swing-low reads as "takes", freeze-low reads as "swings": show the rate in the direction of the headline. */
function shownDirection(ins: Insight): boolean {
  return (ins.metric === "swing" || ins.metric === "freeze" || ins.metric === "heartFreeze") && ins.delta < 0;
}

function flip(r: Rate | null, inv: boolean): Rate | null {
  if (!r) return null;
  return inv ? { num: r.den - r.num, den: r.den } : r;
}

export function InsightCard({ ins, globalWhere, showHitter }: { ins: Insight; globalWhere: string; showHitter?: boolean }) {
  const { openSet } = useInspector();
  const m = METRICS[ins.metric];
  const inv = shownDirection(ins);
  const value = flip(ins.value, inv)!;
  const base = flip(ins.primary === "peer" ? ins.peer : ins.self, inv);
  const v = value.num / value.den;
  const b = base && base.den ? base.num / base.den : null;
  const delta = b !== null ? v - b : null;
  const hitterSql = `batter_name = ${sqlStr(ins.hitter)}`;

  const inspect = () => {
    if (m.paLevel) {
      openSet({
        title: ins.headline,
        subtitle: `${displayName(ins.hitter)} — every pitch of the PAs in this finding; highlighted = PA-ending pitch where the outcome occurred`,
        where: `${globalWhere} AND ${hitterSql} AND pa_uid IN (SELECT pa_uid FROM enriched_pitches WHERE ${globalWhere} AND ${hitterSql} AND ${ins.cellSql})`,
        highlightSql: `is_pa_terminal_pitch AND (${m.num})`,
        highlightLabel: m.label.replace("%", ""),
      });
    } else {
      const hl = inv ? (ins.metric === "swing" ? "is_take" : "is_swing") : m.num;
      openSet({
        title: ins.headline,
        subtitle: `${displayName(ins.hitter)} — the ${value.den} pitches behind this finding; highlighted = ${inv ? (ins.metric === "swing" ? "takes" : "swings") : m.label.replace("%", "").toLowerCase()}`,
        where: `${globalWhere} AND ${hitterSql} AND ${ins.cellSql} AND (${m.den})`,
        highlightSql: hl,
        highlightLabel: inv ? (ins.metric === "swing" ? "Takes" : "Swings") : m.label.replace("%", ""),
      });
    }
  };

  const toneBadge =
    ins.tone === "vulnerability" ? <Badge tone="critical">Vulnerability</Badge> : ins.tone === "strength" ? <Badge tone="good">Strength</Badge> : <Badge tone="info">Predictable habit</Badge>;

  return (
    <article className="flex flex-col rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{CATEGORY_META[ins.category].label}</span>
        <span className="ml-auto flex gap-1">
          {toneBadge}
          <Badge tone={ins.confidence === "High" ? "crimson" : "neutral"} title={`z = ${ins.z.toFixed(1)}`}>
            {ins.confidence} confidence
          </Badge>
        </span>
      </div>
      {showHitter ? (
        <Link href={`/hitters/${encodeURIComponent(ins.hitter)}`} className="mt-2 text-xs font-semibold text-crimson-text hover:underline">
          {displayName(ins.hitter)}
        </Link>
      ) : null}
      <h3 className="mt-1.5 text-sm font-medium leading-snug text-ink">{ins.headline}</h3>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="num text-2xl font-semibold leading-none text-ink">{pct(v)}</div>
          <div className="num mt-1 text-[11px] text-ink-3">
            ({value.num}/{value.den}) vs {pct(b)} {base ? `(${base.num}/${base.den})` : ""}
          </div>
        </div>
        {delta !== null ? (
          <div className={cn("num rounded px-2 py-1 text-sm font-semibold", delta >= 0 ? "bg-div-hi/25 text-[#f5a3a3]" : "bg-div-lo/25 text-[#9cc5f5]")}>
            {delta >= 0 ? "+" : ""}
            {Math.round(delta * 100)} pts
          </div>
        ) : null}
      </div>
      {/* mini comparison bars: this situation vs baseline */}
      <div className="mt-2 space-y-1" aria-hidden>
        <div className="h-1.5 rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-crimson-hi" style={{ width: `${Math.max(2, v * 100)}%` }} />
        </div>
        {b !== null ? (
          <div className="h-1.5 rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-capstone" style={{ width: `${Math.max(2, b * 100)}%` }} />
          </div>
        ) : null}
      </div>
      <dl className="mt-2 space-y-0.5 text-[11px] text-ink-3">
        {ins.peer ? (
          <div className="flex justify-between gap-2">
            <dt>Teammates, same spot{ins.primary === "peer" ? " (baseline)" : ""}</dt>
            <dd className="num text-ink-2">
              {pct(flip(ins.peer, inv)!.num / ins.peer.den)} ({flip(ins.peer, inv)!.num}/{ins.peer.den})
            </dd>
          </div>
        ) : null}
        {ins.self ? (
          <div className="flex justify-between gap-2">
            <dt>His other comparable pitches{ins.primary === "self" ? " (baseline)" : ""}</dt>
            <dd className="num text-ink-2">
              {pct(flip(ins.self, inv)!.num / ins.self.den)} ({flip(ins.self, inv)!.num}/{ins.self.den})
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <Badge tone="neutral" className="num">
          n = {m.paLevel ? `${value.den} PAs` : `${value.den} pitches across ${ins.pas} PAs`}
        </Badge>
        <Button size="sm" variant="outline" onClick={inspect}>
          <Eye aria-hidden /> Visualize &amp; Inspect PAs
        </Button>
      </div>
    </article>
  );
}
