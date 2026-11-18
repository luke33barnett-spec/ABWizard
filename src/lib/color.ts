/**
 * Diverging fill for "vs team" deltas: blue (below) ↔ neutral gray ↔ red
 * (above). Two hues + a gray midpoint, never a rainbow (dataviz rules).
 * Text on these fills always uses ink tokens, never the series color.
 */
const LO = [0x2a, 0x78, 0xd6];
const MID = [0x26, 0x2d, 0x3a];
const HI = [0xc6, 0x40, 0x3f];

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** delta in rate units (0.20 = +20 pts); saturates at ±span. */
export function divergingFill(delta: number | null | undefined, span = 0.25): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return `rgb(${MID.join(", ")})`;
  const t = Math.max(-1, Math.min(1, delta / span));
  // ease so small deltas stay quiet
  // cap at 80% of the pole so ink text on the fill stays >= ~4:1
  const e = Math.sign(t) * Math.pow(Math.abs(t), 0.85) * 0.8;
  return e >= 0 ? mix(MID, HI, e) : mix(MID, LO, -e);
}

/** Single-hue sequential fill (blue) for magnitudes 0..1. */
export function sequentialFill(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return `rgb(${MID.join(", ")})`;
  return mix(MID, LO, Math.max(0, Math.min(1, v)) * 0.8);
}

export const GROUP_COLOR: Record<string, string> = {
  Fastball: "var(--color-fb)",
  Breaking: "var(--color-brk)",
  Offspeed: "var(--color-off)",
  Other: "var(--color-capstone)",
};
