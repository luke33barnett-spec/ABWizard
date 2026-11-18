"use client";

import { useId, useMemo, useState } from "react";
import { GROUP_COLOR } from "@/lib/color";
import { PITCH_TYPE_NAME, displayName } from "@/lib/metrics";
import type { PitchPoint } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Strike zone from the CATCHER'S / UMPIRE'S view: +x (right) = 1B side.
 * A right-handed hitter stands on the left of this picture.
 * plate_loc_side is normalized to this convention by the schema mapper.
 */
const X_MIN = -2.1;
const X_MAX = 2.1;
const Y_MIN = -0.15;
const Y_MAX = 5.0;
const W = 420;
const H = Math.round((W * (Y_MAX - Y_MIN)) / (X_MAX - X_MIN));
const sx = (x: number) => ((x - X_MIN) / (X_MAX - X_MIN)) * W;
const sy = (y: number) => H - ((y - Y_MIN) / (Y_MAX - Y_MIN)) * H;
const clampX = (x: number) => Math.max(X_MIN + 0.08, Math.min(X_MAX - 0.08, x));
const clampY = (y: number) => Math.max(Y_MIN + 0.08, Math.min(Y_MAX - 0.08, y));

const ZONE = { l: -0.83, r: 0.83, b: 1.5, t: 3.5 };
const CY = 2.5;
const band = (k: number) => ({ l: -0.83 * k, r: 0.83 * k, b: CY - 1 * k, t: CY + 1 * k });

export type ColorBy = "group" | "outcome";
type Outcome = "ball" | "frozen" | "whiff" | "foul" | "inplay" | "hbp";

const OUTCOME_LABEL: Record<Outcome, string> = {
  ball: "Take — ball",
  frozen: "Take — called strike",
  whiff: "Swing & miss",
  foul: "Foul",
  inplay: "In play",
  hbp: "Hit by pitch",
};
const OUTCOME_COLOR: Record<Outcome, string> = {
  ball: "var(--color-capstone)",
  frozen: "var(--color-off)",
  whiff: "var(--color-brk)",
  foul: "var(--color-fb)",
  inplay: "var(--color-fb)",
  hbp: "var(--color-capstone)",
};

function outcomeOf(p: PitchPoint): Outcome {
  switch (p.pitch_call) {
    case "StrikeSwinging":
      return "whiff";
    case "FoulBall":
      return "foul";
    case "InPlay":
      return "inplay";
    case "StrikeCalled":
      return "frozen";
    case "HitByPitch":
      return "hbp";
    default:
      return "ball";
  }
}

function Marker({ o, x, y, r, color, dim }: { o: Outcome; x: number; y: number; r: number; color: string; dim: boolean }) {
  const common = { opacity: dim ? 0.18 : 0.95 };
  const ring = "var(--color-surface)";
  switch (o) {
    case "ball":
    case "hbp":
      return <circle cx={x} cy={y} r={r - 0.8} fill="none" stroke={color} strokeWidth={2} {...common} />;
    case "frozen":
      return <rect x={x - r + 1} y={y - r + 1} width={(r - 1) * 2} height={(r - 1) * 2} rx={1.5} fill="none" stroke={color} strokeWidth={2.2} {...common} />;
    case "whiff":
      return (
        <g stroke={color} strokeWidth={2.4} strokeLinecap="round" {...common}>
          <line x1={x - r + 1.5} y1={y - r + 1.5} x2={x + r - 1.5} y2={y + r - 1.5} />
          <line x1={x - r + 1.5} y1={y + r - 1.5} x2={x + r - 1.5} y2={y - r + 1.5} />
        </g>
      );
    case "foul":
      return <path d={`M${x} ${y - r} L${x + r} ${y + r * 0.8} L${x - r} ${y + r * 0.8} Z`} fill={color} stroke={ring} strokeWidth={1.5} {...common} />;
    case "inplay":
      return <circle cx={x} cy={y} r={r} fill={color} stroke={ring} strokeWidth={2} {...common} />;
  }
}

export interface StrikeZonePlotProps {
  pitches: PitchPoint[];
  colorBy?: ColorBy;
  showTunnels?: boolean;
  showAttackZones?: boolean;
  /** Pitches not matching are dimmed (e.g. the non-numerator pitches of an insight). */
  highlight?: (p: PitchPoint) => boolean;
  /** Number each pitch by its order in the PA and connect them (PA replay). */
  numbered?: boolean;
  onPitchClick?: (p: PitchPoint) => void;
  className?: string;
  title?: string;
}

export function StrikeZonePlot({
  pitches,
  colorBy = "group",
  showTunnels = false,
  showAttackZones = true,
  highlight,
  numbered = false,
  onPitchClick,
  className,
  title = "Pitch locations, catcher's view",
}: StrikeZonePlotProps) {
  const [hover, setHover] = useState<PitchPoint | null>(null);
  const arrowId = useId().replace(/:/g, "");
  const r = numbered ? 10 : 6;

  const pts = useMemo(
    () =>
      pitches.map((p) => ({
        p,
        x: sx(clampX(p.plate_loc_side)),
        y: sy(clampY(p.plate_loc_height)),
        o: outcomeOf(p),
        color: colorBy === "group" ? (GROUP_COLOR[p.pitch_group ?? "Other"] ?? GROUP_COLOR.Other) : OUTCOME_COLOR[outcomeOf(p)],
        dim: highlight ? !highlight(p) : false,
      })),
    [pitches, colorBy, highlight],
  );
  // Draw highlighted pitches last so they sit on top.
  const ordered = useMemo(() => [...pts].sort((a, b) => Number(!a.dim) - Number(!b.dim)), [pts]);
  const hb = band(0.67);
  const sb = band(1.33);
  const cb = band(2);

  return (
    <div className={cn("relative w-full", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full select-none" role="img" aria-label={`${title}: ${pitches.length} pitches`}>
        <defs>
          <marker id={`arrow-${arrowId}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-3)" />
          </marker>
        </defs>
        <rect x={0} y={0} width={W} height={H} fill="var(--color-surface)" />
        {showAttackZones ? (
          <g>
            <rect x={sx(cb.l)} y={sy(cb.t)} width={sx(cb.r) - sx(cb.l)} height={sy(cb.b) - sy(cb.t)} fill="var(--color-surface-2)" stroke="var(--color-line)" strokeDasharray="2 4" />
            <rect x={sx(sb.l)} y={sy(sb.t)} width={sx(sb.r) - sx(sb.l)} height={sy(sb.b) - sy(sb.t)} fill="var(--color-surface-3)" opacity={0.7} />
            <rect x={sx(hb.l)} y={sy(hb.t)} width={sx(hb.r) - sx(hb.l)} height={sy(hb.b) - sy(hb.t)} fill="rgba(158,27,50,0.16)" />
            <text x={sx(cb.l) + 4} y={sy(cb.t) + 12} className="fill-ink-3" fontSize={10}>Chase</text>
            <text x={sx(sb.l) + 4} y={sy(sb.t) + 12} className="fill-ink-3" fontSize={10}>Shadow</text>
            <text x={sx(hb.l) + 4} y={sy(hb.t) + 12} className="fill-ink-3" fontSize={10}>Heart</text>
            <text x={6} y={14} className="fill-ink-3" fontSize={10}>Waste</text>
          </g>
        ) : null}
        {/* Rulebook zone + 3x3 grid */}
        <rect x={sx(ZONE.l)} y={sy(ZONE.t)} width={sx(ZONE.r) - sx(ZONE.l)} height={sy(ZONE.b) - sy(ZONE.t)} fill="none" stroke="var(--color-ink-2)" strokeWidth={1.5} />
        {[1, 2].map((i) => (
          <g key={i} stroke="var(--color-line-strong)" strokeDasharray="3 3">
            <line x1={sx(ZONE.l + ((ZONE.r - ZONE.l) * i) / 3)} x2={sx(ZONE.l + ((ZONE.r - ZONE.l) * i) / 3)} y1={sy(ZONE.t)} y2={sy(ZONE.b)} />
            <line y1={sy(ZONE.b + ((ZONE.t - ZONE.b) * i) / 3)} y2={sy(ZONE.b + ((ZONE.t - ZONE.b) * i) / 3)} x1={sx(ZONE.l)} x2={sx(ZONE.r)} />
          </g>
        ))}
        {/* Home plate, catcher's view: flat edge toward the pitcher, point toward the catcher */}
        <path
          d={`M${sx(-0.708)} ${sy(0.32)} L${sx(0.708)} ${sy(0.32)} L${sx(0.708)} ${sy(0.18)} L${sx(0)} ${sy(0.02)} L${sx(-0.708)} ${sy(0.18)} Z`}
          fill="var(--color-surface-3)"
          stroke="var(--color-ink-3)"
        />
        <text x={8} y={H - 8} className="fill-ink-3" fontSize={10}>← 3B side · RHH</text>
        <text x={W - 8} y={H - 8} textAnchor="end" className="fill-ink-3" fontSize={10}>LHH · 1B side →</text>

        {/* Tunnel vectors: previous pitch → this pitch */}
        {showTunnels
          ? ordered.map(({ p, x, y, dim }) =>
              p.prev_plate_loc_side !== null && p.prev_plate_loc_height !== null && !dim ? (
                <line
                  key={`v-${p.pitch_uid}`}
                  x1={sx(clampX(p.prev_plate_loc_side))}
                  y1={sy(clampY(p.prev_plate_loc_height))}
                  x2={x}
                  y2={y}
                  stroke="var(--color-ink-3)"
                  strokeWidth={1.25}
                  strokeDasharray="4 3"
                  opacity={0.7}
                  markerEnd={`url(#arrow-${arrowId})`}
                />
              ) : null,
            )
          : null}
        {numbered && pts.length > 1 ? (
          <polyline points={pts.map(({ x, y }) => `${x},${y}`).join(" ")} fill="none" stroke="var(--color-ink-3)" strokeWidth={1.25} strokeDasharray="4 3" />
        ) : null}

        {ordered.map(({ p, x, y, o, color, dim }) => (
          <g
            key={p.pitch_uid}
            onMouseEnter={() => setHover(p)}
            onMouseLeave={() => setHover((h) => (h === p ? null : h))}
            onClick={() => onPitchClick?.(p)}
            className={onPitchClick ? "cursor-pointer" : undefined}
          >
            {/* hit target larger than the mark */}
            <circle cx={x} cy={y} r={r + 5} fill="transparent" />
            <Marker o={o} x={x} y={y} r={r} color={color} dim={dim} />
            {numbered ? (
              <text x={x} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} className="pointer-events-none fill-ink" style={{ paintOrder: "stroke", stroke: "var(--color-surface)", strokeWidth: 3 }}>
                {p.pa_pitch_seq}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      {hover ? <PitchTooltip p={hover} x={sx(clampX(hover.plate_loc_side)) / W} y={sy(clampY(hover.plate_loc_height)) / H} /> : null}
    </div>
  );
}

function PitchTooltip({ p, x, y }: { p: PitchPoint; x: number; y: number }) {
  const left = x > 0.6;
  return (
    <div
      className="pointer-events-none absolute z-10 w-56 rounded-md border border-line-strong bg-surface-2/95 p-2 text-xs shadow-xl"
      style={{ top: `${Math.min(80, y * 100)}%`, ...(left ? { right: `${(1 - x) * 100 + 3}%` } : { left: `${x * 100 + 3}%` }) }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">
          {p.pitch_type ? `${PITCH_TYPE_NAME[p.pitch_type] ?? p.pitch_type}` : "Unknown pitch"}
          {p.rel_speed ? <span className="num ml-1 text-ink-2">{p.rel_speed.toFixed(1)} mph</span> : null}
        </span>
        <span className="num text-ink-2">{p.count_str}</span>
      </div>
      <div className="mt-1 text-ink-2">{OUTCOME_LABEL[outcomeOf(p)]}{p.play_result ? ` → ${p.play_result}` : ""}</div>
      {p.exit_speed ? (
        <div className="num text-ink-3">
          EV {p.exit_speed.toFixed(1)} · LA {p.launch_angle?.toFixed(0) ?? "—"}°
        </div>
      ) : null}
      {p.prev_pitch_type ? <div className="text-ink-3">Prev: {PITCH_TYPE_NAME[p.prev_pitch_type] ?? p.prev_pitch_type}</div> : null}
      <div className="mt-1 truncate text-ink-3">
        {p.game_date} · vs {displayName(p.pitcher_name)} ({p.pitcher_throws ?? "?"}HP)
      </div>
      <div className="mt-0.5 text-[10px] text-ink-3">Click to open the full PA</div>
    </div>
  );
}

export function StrikeZoneLegend({ colorBy }: { colorBy: ColorBy }) {
  const shapes: Outcome[] = ["ball", "frozen", "whiff", "foul", "inplay"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-2">
      {colorBy === "group"
        ? (["Fastball", "Breaking", "Offspeed"] as const).map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full" style={{ background: GROUP_COLOR[g] }} />
              {g}
            </span>
          ))
        : null}
      {shapes.map((o) => (
        <span key={o} className="inline-flex items-center gap-1">
          <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
            <Marker o={o} x={7} y={7} r={5.5} color={colorBy === "group" ? "var(--color-ink-2)" : OUTCOME_COLOR[o]} dim={false} />
          </svg>
          {OUTCOME_LABEL[o]}
        </span>
      ))}
    </div>
  );
}
