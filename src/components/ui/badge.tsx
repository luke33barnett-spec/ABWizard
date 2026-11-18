import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-surface-3 text-ink-2 border border-line-strong",
      crimson: "bg-crimson/20 text-crimson-text border border-crimson/50",
      good: "bg-good/15 text-[#5fd35f] border border-good/40",
      warn: "bg-warn/10 text-warn border border-warn/40",
      critical: "bg-critical/15 text-[#f08080] border border-critical/40",
      info: "bg-fb/15 text-[#8fbcf2] border border-fb/40",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
