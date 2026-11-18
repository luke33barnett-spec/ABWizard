"use client";

import { useMemo, useState } from "react";
import { divergingFill } from "@/lib/color";
import { pct } from "@/lib/metrics";
import { Segmented } from "@/components/ui/segmented";

export interface CountNode {
  count: string;
  reached: number;
  k: number;
  bb: number;
  h: number;
  ab: number;
  team?: { reached: number; k: number; bb: number; h: number; ab: number } | null;
}

export interface Transition {
  src: string;
  dst: string;
  n: number;
}

const COLW = 200;
const ROWH = 122;
const PADX = 24;
const PADY = 22;
const NW = 152;
const NH = 82;
const OUTCOME_ORDER = ["K", "BB", "Hit", "Out"];

const pos = (count: string) => {
  const [b, s] = count.split("-").map(Number);
  return { x: PADX + b * COLW, y: PADY + s * ROWH };
};

type Mode = "k" | "ob";

/**
 * Count flow ("what happens the rest of the AB"): every count is a node laid
 * out balls → right, strikes → down. Edge width = how often his PAs moved
 * along that edge. Node fill = how PAs that passed through the count ended,
 * relative to teammates who reached the same count.
 */
export function CountFlow({ nodes, transitions, onNodeClick }: { nodes: CountNode[]; transitions: Transition[]; onNodeClick?: (count: string) => void }) {
  const [mode, setMode] = useState<Mode>("k");
  const byCount = useMemo(() => new Map(nodes.map((n) => [n.count, n])), [nodes]);
  const maxN = Math.max(1, ...transitions.filter((t) => /^\d-\d$/.test(t.dst)).map((t) => t.n));
  const fouls = useMemo(() => new Map(transitions.filter((t) => t.src === t.dst).map((t) => [t.src, t.n])), [transitions]);
  const ended = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const t of transitions) {
      if (/^\d-\d$/.test(t.dst)) continue;
      const cur = m.get(t.src) ?? {};
      cur[t.dst] = (cur[t.dst] ?? 0) + t.n;
      m.set(t.src, cur);
    }
    return m;
  }, [transitions]);

  const metric = (n: { reached: number; k: number; bb: number; h: number } | null | undefined) =>
    !n || !n.reached ? null : mode === "k" ? n.k / n.reached : (n.h + n.bb) / n.reached;

  const W = PADX * 2 + 3 * COLW + NW;
  const H = PADY * 2 + 2 * ROWH + NH;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-3">
        <Segmented
          size="xs"
          value={mode}
          onChange={setMode}
          options={[
            { value: "k", label: "Color: K% from here" },
            { value: "ob", label: "Color: On-base from here" },
          ]}
        />
        <span>Red = higher than teammates who reached the same count, blue = lower. “ends” = PAs that finished at that count (K, BB, H, Out). Click a count to see those PAs.</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block h-auto w-full min-w-[720px] max-w-[900px]" role="img" aria-label="Count flow diagram">
          <defs>
            <marker id="cf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-3)" />
            </marker>
          </defs>
          {transitions
            .filter((t) => /^\d-\d$/.test(t.dst) && t.src !== t.dst)
            .map((t) => {
              const a = pos(t.src);
              const b = pos(t.dst);
              const horizontal = a.y === b.y;
              const x1 = horizontal ? a.x + NW : a.x + NW / 2;
              const y1 = horizontal ? a.y + NH / 2 : a.y + NH;
              const x2 = horizontal ? b.x : b.x + NW / 2;
              const y2 = horizontal ? b.y + NH / 2 : b.y;
              const w = 1 + (t.n / maxN) * 9;
              return (
                <g key={`${t.src}-${t.dst}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-line-strong)" strokeWidth={w} strokeLinecap="round" opacity={0.9} />
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={1} markerEnd="url(#cf-arrow)" />
                  <text x={(x1 + x2) / 2 + (horizontal ? 0 : 8)} y={(y1 + y2) / 2 + (horizontal ? -6 : 4)} fontSize={10} textAnchor={horizontal ? "middle" : "start"} className="num fill-ink-3">
                    {t.n}
                  </text>
                </g>
              );
            })}
          {[...byCount.values()].map((n) => {
            const p = pos(n.count);
            const mine = metric(n);
            const team = metric(n.team ?? null);
            const fill = mine !== null && team !== null ? divergingFill(mine - team, 0.2) : "var(--color-surface-3)";
            const end = ended.get(n.count) ?? {};
            const endText = OUTCOME_ORDER.filter((k) => end[k])
              .map((k) => `${end[k]}${k === "Hit" ? "H" : k}`)
              .join(" ");
            return (
              <g key={n.count} onClick={() => onNodeClick?.(n.count)} className={onNodeClick ? "cursor-pointer" : undefined}>
                <title>{`${n.count}: ${n.reached} PAs reached this count. K ${n.k}, BB ${n.bb}, H ${n.h}/${n.ab} AB.${team !== null ? ` Teammates: ${pct(team)}` : ""}`}</title>
                <rect x={p.x} y={p.y} width={NW} height={NH} rx={6} fill={fill} stroke="var(--color-line-strong)" />
                <text x={p.x + 8} y={p.y + 17} fontSize={14} fontWeight={700} className="num fill-ink">
                  {n.count}
                </text>
                <text x={p.x + NW - 8} y={p.y + 17} fontSize={10} textAnchor="end" className="num fill-ink-2">
                  {n.reached} PA
                </text>
                <text x={p.x + 8} y={p.y + 35} fontSize={11} className="num fill-ink">
                  {mode === "k" ? `K ${pct(mine, 0)}` : `OB ${pct(mine, 0)}`}
                  <tspan className="fill-ink-2"> ({mode === "k" ? n.k : n.h + n.bb}/{n.reached})</tspan>
                </text>
                <text x={p.x + 8} y={p.y + 51} fontSize={10} className="num fill-ink-2">
                  tm {pct(team, 0)}
                  {fouls.get(n.count) ? ` · ${fouls.get(n.count)} fouls` : ""}
                </text>
                {endText ? (
                  <text x={p.x + 8} y={p.y + 69} fontSize={10} className="num fill-ink-2">
                    ends {endText}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
