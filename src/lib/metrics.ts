/**
 * Metric vocabulary (CLAUDE.md §A.3) as SQL fragments + formatting helpers.
 * Every rate is a numerator/denominator pair so the UI can always print
 * `78.6% (11/14)`.
 */

export type MetricKey =
  | "swing"
  | "take"
  | "zswing"
  | "freeze"
  | "heartFreeze"
  | "chase"
  | "whiff"
  | "contact"
  | "foul"
  | "calledStrike"
  | "hardHit"
  | "weakContact"
  | "inPlay"
  | "kRate"
  | "kLooking"
  | "bbRate"
  | "weakOrK";

export interface MetricDef {
  key: MetricKey;
  label: string;
  short: string;
  /** SQL boolean: which pitches count in the denominator */
  den: string;
  /** SQL boolean: which denominator pitches count in the numerator */
  num: string;
  /** Plain-English verb phrase for headlines, e.g. "takes", "chases" */
  verb: string;
  /** PA-level metrics are evaluated on PA-terminal pitches only */
  paLevel?: boolean;
  /** true when a higher value is good for the hitter (for coloring "strength" vs "vulnerability") */
  higherIsGood?: boolean;
}

export const METRICS: Record<MetricKey, MetricDef> = {
  swing: { key: "swing", label: "Swing%", short: "Swing", den: "TRUE", num: "is_swing", verb: "swings at" },
  take: { key: "take", label: "Take%", short: "Take", den: "TRUE", num: "is_take", verb: "takes" },
  zswing: { key: "zswing", label: "Z-Swing%", short: "Z-Swing", den: "in_zone", num: "is_swing", verb: "swings at in-zone", higherIsGood: true },
  freeze: { key: "freeze", label: "Freeze%", short: "Freeze", den: "in_zone", num: "is_take", verb: "freezes on (takes) in-zone", higherIsGood: false },
  heartFreeze: { key: "heartFreeze", label: "Heart Freeze%", short: "Heart Frz", den: "attack_zone = 'Heart'", num: "is_take", verb: "takes Heart-zone", higherIsGood: false },
  chase: { key: "chase", label: "Chase%", short: "Chase", den: "in_zone = FALSE", num: "is_swing", verb: "chases", higherIsGood: false },
  whiff: { key: "whiff", label: "Whiff%", short: "Whiff", den: "is_swing", num: "is_whiff", verb: "whiffs on", higherIsGood: false },
  contact: { key: "contact", label: "Contact%", short: "Contact", den: "is_swing", num: "is_contact", verb: "makes contact on", higherIsGood: true },
  foul: { key: "foul", label: "Foul%", short: "Foul", den: "is_swing", num: "is_foul", verb: "fouls off" },
  calledStrike: { key: "calledStrike", label: "Called Strike%", short: "CS", den: "is_take", num: "is_called_strike", verb: "takes for a strike", higherIsGood: false },
  hardHit: { key: "hardHit", label: "Hard-Hit%", short: "HardHit", den: "is_in_play AND exit_speed IS NOT NULL", num: "exit_speed >= 95", verb: "hits hard", higherIsGood: true },
  weakContact: { key: "weakContact", label: "Weak Contact%", short: "Weak", den: "is_in_play AND exit_speed IS NOT NULL", num: "is_weak_contact", verb: "makes weak contact on", higherIsGood: false },
  inPlay: { key: "inPlay", label: "In-Play%", short: "InPlay", den: "is_swing", num: "is_in_play", verb: "puts in play" },
  kRate: { key: "kRate", label: "K%", short: "K", den: "is_pa_terminal_pitch", num: "pa_is_k", verb: "strikes out in", paLevel: true, higherIsGood: false },
  kLooking: { key: "kLooking", label: "Looking K%", short: "K-L", den: "is_pa_terminal_pitch", num: "pa_is_k_looking", verb: "strikes out looking in", paLevel: true, higherIsGood: false },
  bbRate: { key: "bbRate", label: "BB%", short: "BB", den: "is_pa_terminal_pitch", num: "pa_is_bb", verb: "walks in", paLevel: true, higherIsGood: true },
  weakOrK: { key: "weakOrK", label: "K or Weak%", short: "K/Weak", den: "is_pa_terminal_pitch", num: "(pa_is_k OR pa_is_weak_contact)", verb: "ends in a K or weak contact in", paLevel: true, higherIsGood: false },
};

/** count(*) FILTER pair for a metric, aliased `${alias}_num` / `${alias}_den`. */
export function rateCols(metric: MetricKey, alias: string = metric, extra = "TRUE"): string {
  const m = METRICS[metric];
  return `count(*) FILTER (WHERE (${extra}) AND (${m.den}) AND (${m.num})) AS ${alias}_num, count(*) FILTER (WHERE (${extra}) AND (${m.den})) AS ${alias}_den`;
}

export interface Rate {
  num: number;
  den: number;
}

export function rate(r: Rate | null | undefined): number | null {
  if (!r || !r.den) return null;
  return r.num / r.den;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

/** "78.6% (11/14)" — the house style for every rate. */
export function fmtRate(r: Rate | null | undefined, digits = 1): string {
  if (!r || !r.den) return "— (0/0)";
  return `${pct(r.num / r.den, digits)} (${r.num}/${r.den})`;
}

export function fmtDelta(d: number | null | undefined, digits = 0): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return "—";
  const v = (d * 100).toFixed(digits);
  return `${d >= 0 ? "+" : ""}${v} pts`;
}

/** Baseball slash-line style: .312 */
export function fmtAvg(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(3).replace(/^0/, "");
}

export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export const COUNTS = ["0-0", "0-1", "0-2", "1-0", "1-1", "1-2", "2-0", "2-1", "2-2", "3-0", "3-1", "3-2"] as const;
export const COUNT_BUCKETS = ["First Pitch", "Hitter Ahead", "Even", "Pitcher Ahead", "Full"] as const;
export const PITCH_GROUPS = ["Fastball", "Breaking", "Offspeed"] as const;
export const PITCH_TYPES = ["FF", "SI", "FC", "SL", "ST", "CU", "CH", "FS", "KN", "OT"] as const;

export const PITCH_TYPE_NAME: Record<string, string> = {
  FF: "4-Seam",
  SI: "Sinker",
  FC: "Cutter",
  SL: "Slider",
  ST: "Sweeper",
  CU: "Curveball",
  CH: "Changeup",
  FS: "Splitter",
  KN: "Knuckleball",
  OT: "Other",
};

export const PITCH_TYPE_PLURAL: Record<string, string> = {
  FF: "4-seamers",
  SI: "sinkers",
  FC: "cutters",
  SL: "sliders",
  ST: "sweepers",
  CU: "curveballs",
  CH: "changeups",
  FS: "splitters",
  KN: "knuckleballs",
  OT: "other pitches",
};

export const PITCH_GROUP_PLURAL: Record<string, string> = {
  Fastball: "fastballs",
  Breaking: "breaking balls",
  Offspeed: "offspeed pitches",
  Other: "other pitches",
};

export const PITCH_GROUP_SINGULAR: Record<string, string> = {
  Fastball: "fastball",
  Breaking: "breaking ball",
  Offspeed: "offspeed pitch",
  Other: "other pitch",
};

export const PITCH_TYPE_SINGULAR: Record<string, string> = {
  FF: "4-seamer",
  SI: "sinker",
  FC: "cutter",
  SL: "slider",
  ST: "sweeper",
  CU: "curveball",
  CH: "changeup",
  FS: "splitter",
  KN: "knuckleball",
  OT: "other pitch",
};

export const PITCH_TYPE_GROUP: Record<string, string> = {
  FF: "Fastball",
  SI: "Fastball",
  FC: "Fastball",
  SL: "Breaking",
  ST: "Breaking",
  CU: "Breaking",
  CH: "Offspeed",
  FS: "Offspeed",
  KN: "Offspeed",
  OT: "Other",
};

/** Display "Last, First" as "First Last". */
export function displayName(name: string | null | undefined): string {
  if (!name) return "—";
  const [last, first] = name.split(",").map((s) => s.trim());
  return first ? `${first} ${last}` : last;
}

export function slugify(name: string): string {
  return encodeURIComponent(name);
}
