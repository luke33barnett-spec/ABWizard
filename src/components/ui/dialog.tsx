"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  side,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** "right" renders as a full-height drawer (Sheet). */
  side?: "right";
} & Omit<ComponentProps<typeof D.Content>, "title">) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          "fixed z-50 flex flex-col border border-line-strong bg-surface shadow-2xl outline-none",
          side === "right"
            ? "inset-y-0 right-0 w-full max-w-[min(100vw,880px)] border-y-0 border-r-0"
            : "left-1/2 top-1/2 max-h-[88vh] w-[min(96vw,980px)] -translate-x-1/2 -translate-y-1/2 rounded-lg",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
            {description ? <D.Description className="mt-0.5 text-xs text-ink-3">{description}</D.Description> : <D.Description className="sr-only">Details</D.Description>}
          </div>
          <D.Close className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </D.Content>
    </D.Portal>
  );
}
