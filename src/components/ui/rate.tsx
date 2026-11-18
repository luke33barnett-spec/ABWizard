import type { Rate } from "@/lib/metrics";
import { cn } from "@/lib/utils";

/** House style: every percentage paired with its raw fraction — `78.6% (11/14)`. */
export function RateText({
  r,
  digits = 1,
  className,
  stacked,
  invert,
}: {
  r: Rate | null | undefined;
  digits?: number;
  className?: string;
  /** fraction on its own line (dense tables) */
  stacked?: boolean;
  /** show 1 - rate (e.g. take% from swing counts) */
  invert?: boolean;
}) {
  if (!r || !r.den) return <span className={cn("num text-ink-3", className)}>—</span>;
  const num = invert ? r.den - r.num : r.num;
  const pct = ((num / r.den) * 100).toFixed(digits);
  return (
    <span className={cn("num whitespace-nowrap", stacked && "inline-flex flex-col items-end leading-tight", className)}>
      <span className="text-ink">{pct}%</span>
      <span className={cn(stacked ? "text-[10px] text-ink/70" : "ml-1 text-[0.85em] text-ink/65")}>
        ({num}/{r.den})
      </span>
    </span>
  );
}
