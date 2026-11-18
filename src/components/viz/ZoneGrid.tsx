"use client";

import { divergingFill, sequentialFill } from "@/lib/color";
import type { Rate } from "@/lib/metrics";

export interface ZoneCellValue {
  me: Rate;
  team?: Rate | null;
}

const S = 300;
const IN0 = 60;
const IN1 = 240;
const STEP = (IN1 - IN0) / 3;

/**
 * Gameday-style zone grid, catcher's view: cells 1–9 are the 3×3 rulebook
 * zone (1 = top-left), 11–14 the four out-of-zone quadrants. Fill = delta vs
 * team (diverging) when a team rate exists, else magnitude (sequential).
 */
export function ZoneGrid({
  cells,
  includeOuter = true,
  minN,
  onCellClick,
  label,
}: {
  cells: Map<number, ZoneCellValue>;
  includeOuter?: boolean;
  minN: number;
  onCellClick?: (cell: number) => void;
  label: string;
}) {
  const fillFor = (c: ZoneCellValue | undefined) => {
    if (!c || !c.me.den) return "var(--color-surface-2)";
    const v = c.me.num / c.me.den;
    if (c.team && c.team.den) return divergingFill(v - c.team.num / c.team.den, 0.25);
    return sequentialFill(v);
  };
  const text = (c: ZoneCellValue | undefined, x: number, y: number) => {
    if (!c || !c.me.den) return (
      <text x={x} y={y + 4} textAnchor="middle" fontSize={11} className="fill-ink-3">
        —
      </text>
    );
    const small = c.me.den < minN;
    return (
      <g opacity={small ? 0.55 : 1} className="pointer-events-none">
        <text x={x} y={y} textAnchor="middle" fontSize={15} fontWeight={600} className="num fill-ink">
          {Math.round((c.me.num / c.me.den) * 100)}%
        </text>
        <text x={x} y={y + 14} textAnchor="middle" fontSize={10} className="num fill-ink-2">
          {c.me.num}/{c.me.den}
        </text>
      </g>
    );
  };
  const outer = [
    { id: 11, x: 0, y: 0, tx: 28, ty: 26 },
    { id: 12, x: S / 2, y: 0, tx: S - 28, ty: 26 },
    { id: 13, x: 0, y: S / 2, tx: 28, ty: S - 26 },
    { id: 14, x: S / 2, y: S / 2, tx: S - 28, ty: S - 26 },
  ];
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="block h-auto w-full max-w-[320px]" role="img" aria-label={label}>
      {includeOuter
        ? outer.map((o) => (
            <g key={o.id} onClick={() => onCellClick?.(o.id)} className={onCellClick ? "cursor-pointer" : undefined}>
              <rect x={o.x + 1} y={o.y + 1} width={S / 2 - 2} height={S / 2 - 2} rx={4} fill={fillFor(cells.get(o.id))} stroke="var(--color-surface)" strokeWidth={2} />
              {text(cells.get(o.id), o.tx, o.ty - 4)}
            </g>
          ))
        : null}
      {Array.from({ length: 9 }, (_, i) => {
        const id = i + 1;
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = IN0 + col * STEP;
        const y = IN0 + row * STEP;
        return (
          <g key={id} onClick={() => onCellClick?.(id)} className={onCellClick ? "cursor-pointer" : undefined}>
            <rect x={x + 1} y={y + 1} width={STEP - 2} height={STEP - 2} rx={3} fill={fillFor(cells.get(id))} stroke="var(--color-surface)" strokeWidth={2} />
            {text(cells.get(id), x + STEP / 2, y + STEP / 2 - 2)}
          </g>
        );
      })}
      <rect x={IN0} y={IN0} width={IN1 - IN0} height={IN1 - IN0} fill="none" stroke="var(--color-ink-2)" strokeWidth={1.5} pointerEvents="none" />
    </svg>
  );
}
