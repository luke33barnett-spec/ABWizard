"use client";

import type { ReactNode } from "react";
import { RateText } from "@/components/ui/rate";
import { divergingFill } from "@/lib/color";
import { pct, type Rate } from "@/lib/metrics";
import { cn } from "@/lib/utils";

export interface RateBarRow {
  key: string;
  label: ReactNode;
  me: Rate;
  team?: Rate | null;
  onClick?: () => void;
}

/**
 * Horizontal rate bars: bar = hitter's rate (tinted by delta vs team), thin
 * tick = team rate in the same split. Rows under the min sample are muted
 * and labelled, never hidden.
 */
export function RateBars({ rows, minN, emptyText = "No pitches in this split." }: { rows: RateBarRow[]; minN: number; emptyText?: string }) {
  if (rows.length === 0) return <p className="py-3 text-xs text-ink-3">{emptyText}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const v = r.me.den ? r.me.num / r.me.den : null;
        const t = r.team && r.team.den ? r.team.num / r.team.den : null;
        const small = r.me.den < minN;
        const delta = v !== null && t !== null ? v - t : null;
        const Row = r.onClick ? "button" : "div";
        return (
          <li key={r.key}>
            <Row
              type={r.onClick ? "button" : undefined}
              onClick={r.onClick}
              className={cn(
                "grid w-full grid-cols-[minmax(6rem,11rem)_1fr_auto] items-center gap-3 rounded px-1 py-0.5 text-left text-xs",
                r.onClick && "hover:bg-surface-2",
                small && "opacity-50",
              )}
              title={t !== null ? `Team: ${pct(t)} (${r.team!.num}/${r.team!.den})` : undefined}
            >
              <span className="truncate text-ink-2">{r.label}</span>
              <span className="relative h-3 rounded-sm bg-surface-3">
                {v !== null ? (
                  <span className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${Math.max(1.5, v * 100)}%`, background: delta !== null ? divergingFill(delta, 0.2) : "var(--color-capstone)" }} />
                ) : null}
                {t !== null ? <span className="absolute -inset-y-0.5 w-0.5 rounded bg-ink" style={{ left: `calc(${t * 100}% - 1px)` }} aria-hidden /> : null}
              </span>
              <span className="flex min-w-[9.5rem] items-baseline justify-end gap-2">
                <RateText r={r.me} />
                {t !== null ? <span className="num w-12 text-right text-[10px] text-ink-3">tm {pct(t, 0)}</span> : <span className="w-12" />}
                {small ? <span className="text-[10px] text-warn">small n</span> : null}
              </span>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

export function RateBarsLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-6 rounded-sm" style={{ background: divergingFill(0.2, 0.2) }} /> above team
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-6 rounded-sm" style={{ background: divergingFill(-0.2, 0.2) }} /> below team
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-0.5 bg-ink" /> team rate, same split
      </span>
    </div>
  );
}
