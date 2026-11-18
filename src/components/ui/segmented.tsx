"use client";

import { cn } from "@/lib/utils";

/** Compact single-select button group (filters, metric toggles). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "sm",
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; title?: string }[];
  size?: "sm" | "xs";
  label?: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-md border border-line-strong bg-surface-2 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2 font-medium transition-colors",
            size === "sm" ? "h-6 text-xs" : "h-5 text-[11px]",
            value === o.value ? "bg-crimson text-white" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
