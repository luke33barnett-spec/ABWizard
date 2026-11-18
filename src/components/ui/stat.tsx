import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-md border border-line bg-surface-2 px-3 py-2", className)}>
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold leading-tight text-ink">{value}</div>
      {sub ? <div className="num mt-0.5 text-[11px] leading-snug text-ink-3">{sub}</div> : null}
    </div>
  );
}
