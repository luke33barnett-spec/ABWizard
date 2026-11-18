/**
 * Auto-Scout: a deterministic suite of parameterized SQL probes over
 * `enriched_pitches`. Each probe splits pitches into cells (e.g. count ×
 * pitch group), measures one metric per hitter per cell, and compares it to
 *   - PEERS: every other hitter in the filtered data, same cell. This removes
 *     universal behavior ("everyone takes 3-0") so only hitter-specific habits
 *     surface; and
 *   - SELF:  the same hitter's rate in a broader context (e.g. vs that pitch
 *     in all counts), which isolates the effect of the count/sequence.
 * Each probe declares which comparison is primary. A one-sample binomial
 * z-score against that baseline ranks findings.
 */
import { METRICS, PITCH_GROUP_PLURAL, PITCH_GROUP_SINGULAR, PITCH_TYPE_GROUP, PITCH_TYPE_PLURAL, PITCH_TYPE_SINGULAR, displayName, pct, sqlStr, type MetricKey, type Rate } from "@/lib/metrics";
import type { Row } from "@/lib/ingest";

export type InsightCategory =
  | "count"
  | "freeze"
  | "chase"
  | "tunnel"
  | "velo"
  | "archetype"
  | "first-pitch"
  | "two-strike"
  | "situational"
  | "damage";

export const CATEGORY_META: Record<InsightCategory, { label: string; blurb: string }> = {
  count: { label: "Count & Pitch-Type Locks", blurb: "Swing/take habits by count and pitch type, vs teammates in the same spot" },
  freeze: { label: "Freeze Alerts", blurb: "When he takes hittable strikes" },
  chase: { label: "Chase Triggers", blurb: "Situations that pull him out of the zone" },
  tunnel: { label: "2-Pitch Tunnel Traps", blurb: "Previous pitch → current pitch effects vs his baseline on that pitch" },
  velo: { label: "Velo & Sightline Traps", blurb: "Big speed changes and location shifts between pitches" },
  archetype: { label: "Sequence Archetypes", blurb: "Hard/Soft progressions that end PAs in Ks or weak contact" },
  "first-pitch": { label: "First-Pitch Approach", blurb: "What he does on pitch 1 and what follows" },
  "two-strike": { label: "Two-Strike Approach", blurb: "Putaway vulnerabilities" },
  situational: { label: "Situational", blurb: "Runners, outs, and repeated looks at a pitcher" },
  damage: { label: "Damage Zones", blurb: "Where he hits the ball hard" },
};

interface Dim {
  sql: string;
  /** Render a dim value into a phrase fragment */
  phrase?: (v: string) => string;
}

interface Probe {
  id: string;
  category: InsightCategory;
  metric: MetricKey;
  dims: Dim[];
  /** extra population restriction for the cell query */
  scope?: string;
  /** which dims (by index) define the self baseline */
  selfDims?: number[];
  /** population restriction for the self baseline (defaults to scope) */
  selfScope?: string;
  primary: "peer" | "self";
  minDen?: number;
  minDelta?: number;
  /** "Takes breaking balls in 2-0 counts" style subject phrase */
  subject: (d: string[]) => string;
  /** which counts toward de-duplication across overlapping probes */
  family?: (d: string[]) => string;
  /** Flip the delta sign for family de-dupe (freeze-high ≡ swing-low: both "passive"). */
  familyFlip?: boolean;
}

const group = (v: string) => PITCH_GROUP_PLURAL[v] ?? v.toLowerCase();
const ptype = (v: string) => PITCH_TYPE_PLURAL[v] ?? v;
const group1 = (v: string) => PITCH_GROUP_SINGULAR[v] ?? v.toLowerCase();
const ptype1 = (v: string) => PITCH_TYPE_SINGULAR[v] ?? v;
const loc = (v: string) =>
  v
    .toLowerCase()
    .replace("up-in", "up-and-in")
    .replace("up-away", "up-and-away")
    .replace("down-in", "down-and-in")
    .replace("down-away", "down-and-away")
    .replace("middle-middle", "middle-middle")
    .replace("middle-in", "middle-in")
    .replace("middle-away", "middle-away");
const bucketPhrase: Record<string, string> = {
  "First Pitch": "on the first pitch",
  "Hitter Ahead": "in hitter's counts (1-0, 2-0, 3-0, 2-1, 3-1)",
  Even: "in even counts (1-1, 2-2)",
  "Pitcher Ahead": "when behind (0-1, 0-2, 1-2)",
  Full: "in full counts",
};
const COUNT_TO_BUCKET: Record<string, string> = {
  "0-0": "First Pitch", "1-0": "Hitter Ahead", "2-0": "Hitter Ahead", "3-0": "Hitter Ahead", "2-1": "Hitter Ahead", "3-1": "Hitter Ahead",
  "1-1": "Even", "2-2": "Even", "0-1": "Pitcher Ahead", "0-2": "Pitcher Ahead", "1-2": "Pitcher Ahead", "3-2": "Full",
};

const PROBES: Probe[] = [
  // ---------------- Count & pitch-type locks ----------------
  {
    id: "count-group-swing", category: "count", metric: "swing", primary: "peer",
    dims: [{ sql: "count_str" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "TRUE",
    subject: ([c, g]) => `${group(g)} in ${c} counts`,
    family: ([c, g]) => `approach|${g}|${COUNT_TO_BUCKET[c] ?? c}`,
  },
  {
    id: "bucket-group-swing", category: "count", metric: "swing", primary: "peer",
    dims: [{ sql: "count_bucket" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "TRUE",
    subject: ([b, g]) => `${group(g)} ${bucketPhrase[b] ?? b}`,
    family: ([b, g]) => `approach|${g}|${b}`,
  },
  {
    id: "count-type-swing", category: "count", metric: "swing", primary: "peer", minDen: 10,
    dims: [{ sql: "count_str" }, { sql: "pitch_type" }], selfDims: [1], selfScope: "TRUE",
    subject: ([c, t]) => `${ptype(t)} in ${c} counts`,
    family: ([c, t]) => `approach|${PITCH_TYPE_GROUP[t] ?? t}|${COUNT_TO_BUCKET[c] ?? c}`,
  },
  // ---------------- Freeze ----------------
  {
    id: "count-group-freeze", category: "freeze", metric: "freeze", primary: "peer",
    dims: [{ sql: "count_str" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "TRUE",
    subject: ([c, g]) => `in-zone ${group(g)} in ${c} counts`,
    family: ([c, g]) => `approach|${g}|${COUNT_TO_BUCKET[c] ?? c}`, familyFlip: true,
  },
  {
    id: "bucket-group-freeze", category: "freeze", metric: "freeze", primary: "peer",
    dims: [{ sql: "count_bucket" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "TRUE",
    subject: ([b, g]) => `in-zone ${group(g)} ${bucketPhrase[b] ?? b}`,
    family: ([b, g]) => `approach|${g}|${b}`, familyFlip: true,
  },
  {
    id: "first-pitch-heart", category: "freeze", metric: "heartFreeze", primary: "peer", scope: "is_first_pitch_of_pa",
    dims: [{ sql: "pitch_group" }], selfDims: [0], selfScope: "TRUE",
    subject: ([g]) => `first-pitch ${group(g)} in the Heart of the zone`,
    family: ([g]) => `approach|${g}|First Pitch`, familyFlip: true,
  },
  {
    id: "two-strike-type-freeze", category: "freeze", metric: "freeze", primary: "peer", scope: "two_strikes",
    dims: [{ sql: "pitch_type" }], selfDims: [0], selfScope: "TRUE",
    subject: ([t]) => `in-zone ${ptype(t)} with two strikes`,
    family: ([t]) => `freeze2k|${t}`,
  },
  {
    id: "two-strike-loc-freeze", category: "freeze", metric: "freeze", primary: "peer", scope: "two_strikes",
    dims: [{ sql: "location_label" }],
    subject: ([l]) => `${loc(l)} strikes with two strikes`,
    family: ([l]) => `freeze2kloc|${l}`,
  },
  {
    id: "freeze-after-prev", category: "freeze", metric: "freeze", primary: "self",
    dims: [{ sql: "prev_pitch_group" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "prev_pitch_group IS NOT NULL",
    subject: ([pg, g]) => `in-zone ${group(g)} right after ${pg === "Offspeed" ? "an" : "a"} ${group1(pg)}`,
  },
  {
    id: "k-looking", category: "freeze", metric: "kLooking", primary: "peer",
    dims: [],
    subject: () => `plate appearances (called strike three)`,
  },
  // ---------------- Chase ----------------
  {
    id: "bucket-group-chase", category: "chase", metric: "chase", primary: "peer",
    dims: [{ sql: "count_bucket" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "TRUE",
    subject: ([b, g]) => `${group(g)} out of the zone ${bucketPhrase[b] ?? b}`,
    family: ([b, g]) => `chase|${g}|${b}`,
  },
  {
    id: "hand-group-chase", category: "chase", metric: "chase", primary: "peer",
    dims: [{ sql: "pitcher_throws" }, { sql: "pitch_group" }], selfDims: [1], selfScope: "TRUE",
    subject: ([h, g]) => `${group(g)} off the plate vs ${h}HP`,
  },
  {
    id: "after-prev-result-chase", category: "chase", metric: "chase", primary: "self", scope: "prev_pitch_call IS NOT NULL",
    dims: [{ sql: "CASE WHEN prev_is_whiff THEN 'a whiff' WHEN prev_is_freeze THEN 'freezing on a strike' WHEN prev_is_take THEN 'taking a ball' WHEN prev_pitch_call = 'FoulBall' THEN 'a foul ball' END" }],
    selfScope: "prev_pitch_call IS NOT NULL",
    subject: ([r]) => `pitches out of the zone right after ${r}`,
  },
  // ---------------- Tunnels ----------------
  {
    id: "tunnel-chase", category: "tunnel", metric: "chase", primary: "self",
    dims: [{ sql: "prev_pitch_type" }, { sql: "prev_loc_vertical" }, { sql: "pitch_type" }, { sql: "loc_vertical" }], selfDims: [2, 3], selfScope: "TRUE",
    subject: ([pt, pv, t, v]) => `${v === "Middle" ? "" : `${v.toLowerCase()} `}${ptype(t)} out of the zone right after a${pv === "Up" ? "n elevated" : pv === "Down" ? " low" : ""} ${ptype1(pt)}`,
    family: ([pt, pv, t]) => `tunnel|${pt}|${pv}|${t}`,
  },
  {
    id: "tunnel-putaway-chase", category: "tunnel", metric: "chase", primary: "self", scope: "count_str IN ('0-2','1-2')", minDen: 6,
    dims: [{ sql: "prev_pitch_type" }, { sql: "prev_loc_vertical" }, { sql: "pitch_type" }, { sql: "location_label" }], selfDims: [2, 3], selfScope: "count_str IN ('0-2','1-2')",
    subject: ([pt, pv, t, l]) => `0-2/1-2 ${ptype(t)} ${loc(l)} right after a${pv === "Up" ? "n elevated" : pv === "Down" ? " low" : ""} ${ptype1(pt)}`,
    family: ([pt, pv, t]) => `tunnel|${pt}|${pv}|${t}`,
  },
  {
    id: "tunnel-whiff", category: "tunnel", metric: "whiff", primary: "self",
    dims: [{ sql: "prev_pitch_type" }, { sql: "pitch_type" }], selfDims: [1], selfScope: "TRUE",
    subject: ([pt, t]) => `${ptype(t)} right after a ${ptype1(pt)}`,
  },
  {
    id: "location-shift-chase", category: "velo", metric: "chase", primary: "self",
    dims: [{ sql: "prev_location_label" }, { sql: "location_label" }], selfDims: [1], selfScope: "TRUE",
    subject: ([a, b]) => `${loc(b)} pitches after a pitch ${loc(a)} (sightline shift)`,
  },
  // ---------------- Velo ----------------
  {
    id: "velo-drop-whiff", category: "velo", metric: "whiff", primary: "self",
    dims: [{ sql: "CASE WHEN velo_delta_from_prev <= -8 THEN '8+ mph slower' WHEN velo_delta_from_prev >= 8 THEN '8+ mph faster' END" }, { sql: "pitch_group" }],
    selfDims: [1], selfScope: "TRUE",
    subject: ([d, g]) => `${group(g)} ${d} than the previous pitch`,
  },
  {
    id: "velo-drop-chase", category: "velo", metric: "chase", primary: "self",
    dims: [{ sql: "CASE WHEN velo_delta_from_prev <= -8 THEN '8+ mph slower' WHEN velo_delta_from_prev >= 8 THEN '8+ mph faster' END" }, { sql: "pitch_group" }],
    selfDims: [1], selfScope: "TRUE",
    subject: ([d, g]) => `${group(g)} ${d} than the previous pitch (out of zone)`,
  },
  // ---------------- Archetypes ----------------
  {
    id: "hs3-whiff", category: "archetype", metric: "whiff", primary: "self",
    dims: [{ sql: "seq_hs_3" }, { sql: "hard_soft" }], selfDims: [1], selfScope: "TRUE",
    subject: ([s]) => `the 3rd pitch of a ${s.split("").map((c) => (c === "H" ? "Hard" : "Soft")).join(" → ")} sequence`,
  },
  {
    id: "pa-first3", category: "archetype", metric: "weakOrK", primary: "self", scope: "pa_pitch_count >= 3",
    dims: [{ sql: "pa_first3_hs" }], selfScope: "pa_pitch_count >= 3",
    subject: ([s]) => `PAs that open ${s.split("").map((c) => (c === "H" ? "Hard" : "Soft")).join(" → ")}`,
  },
  // ---------------- First pitch ----------------
  {
    id: "first-pitch-swing", category: "first-pitch", metric: "swing", primary: "peer", scope: "is_first_pitch_of_pa",
    dims: [{ sql: "pitch_group" }], selfDims: [0], selfScope: "TRUE",
    subject: ([g]) => `first-pitch ${group(g)}`,
    family: ([g]) => `approach|${g}|First Pitch`,
  },
  {
    id: "after-first-pitch-k", category: "first-pitch", metric: "kRate", primary: "peer",
    dims: [{ sql: "CASE pa_first_pitch_call WHEN 'StrikeCalled' THEN 'taking a first-pitch strike' WHEN 'StrikeSwinging' THEN 'whiffing on the first pitch' WHEN 'FoulBall' THEN 'fouling off the first pitch' WHEN 'BallCalled' THEN 'getting ahead 1-0' END" }],
    selfScope: "TRUE",
    subject: ([r]) => `PAs after ${r}`,
  },
  // ---------------- Two strikes ----------------
  {
    id: "two-strike-whiff", category: "two-strike", metric: "whiff", primary: "peer", scope: "two_strikes",
    dims: [{ sql: "pitch_type" }], selfDims: [0], selfScope: "TRUE",
    subject: ([t]) => `${ptype(t)} with two strikes`,
  },
  {
    id: "two-strike-chase-loc", category: "two-strike", metric: "chase", primary: "peer", scope: "two_strikes",
    dims: [{ sql: "location_label" }],
    subject: ([l]) => `${loc(l)} pitches off the plate with two strikes`,
  },
  {
    id: "two-strike-foul", category: "two-strike", metric: "foul", primary: "peer", scope: "two_strikes",
    dims: [{ sql: "pitch_group" }], selfDims: [0], selfScope: "TRUE",
    subject: ([g]) => `two-strike ${group(g)} (battling)`,
  },
  // ---------------- Situational ----------------
  {
    id: "risp-chase", category: "situational", metric: "chase", primary: "self", scope: "risp IS NOT NULL",
    dims: [{ sql: "CASE WHEN risp THEN 'with runners in scoring position' ELSE 'without RISP' END" }], selfScope: "risp IS NOT NULL",
    subject: ([s]) => `pitches out of the zone ${s}`,
  },
  {
    id: "two-outs-swing", category: "situational", metric: "swing", primary: "self",
    dims: [{ sql: "CASE WHEN outs = 2 THEN 'with two outs' END" }], selfScope: "TRUE",
    subject: ([s]) => `pitches ${s}`,
  },
  {
    id: "repeat-look-freeze", category: "situational", metric: "freeze", primary: "self",
    dims: [{ sql: "CASE WHEN times_faced_pitcher >= 2 THEN 'the 2nd+ time facing the same pitcher' END" }], selfScope: "TRUE",
    subject: ([s]) => `in-zone pitches ${s}`,
  },
  {
    id: "late-innings-chase", category: "situational", metric: "chase", primary: "self",
    dims: [{ sql: "CASE WHEN inning >= 7 THEN 'in the 7th inning or later' END" }], selfScope: "TRUE",
    subject: ([s]) => `pitches out of the zone ${s}`,
  },
  // ---------------- Damage ----------------
  {
    id: "damage-bucket-group", category: "damage", metric: "hardHit", primary: "self", minDen: 6,
    dims: [{ sql: "count_bucket" }, { sql: "pitch_group" }], selfScope: "TRUE",
    subject: ([b, g]) => `${group(g)} put in play ${bucketPhrase[b] ?? b}`,
  },
];

export interface Insight {
  id: string;
  probeId: string;
  category: InsightCategory;
  hitter: string;
  metric: MetricKey;
  headline: string;
  subline: string;
  value: Rate;
  rate: number;
  pas: number;
  self: Rate | null;
  peer: (Rate & { hitters: number }) | null;
  primary: "peer" | "self";
  baselineRate: number;
  delta: number;
  z: number;
  score: number;
  confidence: "High" | "Medium" | "Low";
  tone: "vulnerability" | "strength" | "habit";
  /** SQL boolean selecting the cell's pitches (scope + dims), excluding the metric denominator. */
  cellSql: string;
  dims: string[];
}

export interface ScanOptions {
  /** Global filter WHERE clause, WITHOUT a hitter restriction (peers are needed). */
  globalWhere: string;
  /** Restrict output to one hitter; null = all hitters in the filtered data. */
  hitter: string | null;
  minN: number;
  maxPerCategory?: number;
}

type QueryFn = (sql: string) => Promise<Row[]>;

function probeSql(p: Probe, globalWhere: string, minDen: number): string {
  const m = METRICS[p.metric];
  const paScope = m.paLevel ? "is_pa_terminal_pitch" : "TRUE";
  const cellScope = [p.scope ?? "TRUE", paScope, ...p.dims.map((d) => `(${d.sql}) IS NOT NULL`)].join(" AND ");
  const selfIdx = p.selfDims ?? [];
  const selfScope = [p.selfScope ?? p.scope ?? "TRUE", paScope, ...selfIdx.map((i) => `(${p.dims[i].sql}) IS NOT NULL`)].join(" AND ");
  const dimSel = p.dims.map((d, i) => `CAST(${d.sql} AS VARCHAR) AS d${i}`);
  const selfSel = selfIdx.map((i) => `CAST(${p.dims[i].sql} AS VARCHAR) AS d${i}`);
  const dimKeys = p.dims.map((_, i) => `d${i}`);
  const joinPeer = dimKeys.length ? dimKeys.map((k) => `p.${k} = c.${k}`).join(" AND ") : "TRUE";
  const joinSelf = ["s.batter_name = c.batter_name", ...selfIdx.map((i) => `s.d${i} = c.d${i}`)].join(" AND ");
  return `
WITH base AS (SELECT * FROM enriched_pitches WHERE ${globalWhere}),
cell AS (
  SELECT batter_name${dimSel.length ? ", " + dimSel.join(", ") : ""},
    count(*) FILTER (WHERE (${m.den}) AND (${m.num})) AS num,
    count(*) FILTER (WHERE (${m.den})) AS den,
    count(DISTINCT pa_uid) FILTER (WHERE (${m.den})) AS pas
  FROM base WHERE ${cellScope} GROUP BY ALL
),
peer AS (
  SELECT ${dimKeys.length ? dimKeys.join(", ") + ", " : ""}CAST(sum(num) AS BIGINT) AS tnum, CAST(sum(den) AS BIGINT) AS tden,
         count(*) FILTER (WHERE den > 0) AS nh
  FROM cell ${dimKeys.length ? "GROUP BY ALL" : ""}
),
self AS (
  SELECT batter_name${selfSel.length ? ", " + selfSel.join(", ") : ""},
    count(*) FILTER (WHERE (${m.den}) AND (${m.num})) AS snum,
    count(*) FILTER (WHERE (${m.den})) AS sden
  FROM base WHERE ${selfScope} GROUP BY ALL
)
SELECT c.*, p.tnum - c.num AS pnum, p.tden - c.den AS pden, p.nh - 1 AS peers, s.snum, s.sden
FROM cell c JOIN peer p ON ${joinPeer} LEFT JOIN self s ON ${joinSelf}
WHERE c.den >= ${minDen}`;
}

function zScore(num: number, den: number, p0: number): number {
  const p = Math.min(0.97, Math.max(0.03, p0));
  return (num - den * p) / Math.sqrt(den * p * (1 - p));
}

/** Phrase the finding in the metric's natural direction ("takes" when swing is low, etc.). */
function phrase(metric: MetricKey, high: boolean, subject: string, v: Rate): { head: string; shown: Rate } {
  const inv = { num: v.den - v.num, den: v.den };
  const r = (x: Rate) => `${pct(x.num / x.den)} (${x.num}/${x.den})`;
  switch (metric) {
    case "swing":
      return high ? { head: `Swings at ${subject}: ${r(v)}`, shown: v } : { head: `Takes ${subject}: ${r(inv)}`, shown: inv };
    case "freeze":
    case "heartFreeze":
      return high ? { head: `Freezes on ${subject}: takes ${r(v)}`, shown: v } : { head: `Attacks ${subject}: swings ${r(inv)}`, shown: inv };
    case "chase":
      return high ? { head: `Chases ${subject}: ${r(v)}`, shown: v } : { head: `Lays off ${subject}: chases only ${r(v)}`, shown: v };
    case "whiff":
      return high ? { head: `Whiffs on ${subject}: ${r(v)} of swings`, shown: v } : { head: `Rarely misses ${subject}: ${r(v)} whiff`, shown: v };
    case "foul":
      return high ? { head: `Fouls off ${subject}: ${r(v)} of swings`, shown: v } : { head: `Rarely fouls off ${subject}: ${r(v)}`, shown: v };
    case "hardHit":
      return high ? { head: `Does damage on ${subject}: ${r(v)} hard-hit (95+ mph)`, shown: v } : { head: `Soft contact on ${subject}: only ${r(v)} hard-hit`, shown: v };
    case "kRate":
      return high ? { head: `Strikes out in ${r(v)} of ${subject}`, shown: v } : { head: `Rarely strikes out in ${subject}: ${r(v)}`, shown: v };
    case "kLooking":
      return high ? { head: `Strikes out looking in ${r(v)} of ${subject}`, shown: v } : { head: `Rarely caught looking: ${r(v)} of ${subject}`, shown: v };
    case "weakOrK":
      return high ? { head: `${subject} end in a K or weak contact ${r(v)}`, shown: v } : { head: `${subject} rarely end in a K or weak contact: ${r(v)}`, shown: v };
    default:
      return { head: `${METRICS[metric].label} on ${subject}: ${r(v)}`, shown: v };
  }
}

export async function runTendencyScan(query: QueryFn, opts: ScanOptions): Promise<Insight[]> {
  const out: Insight[] = [];
  for (const p of PROBES) {
    const minDen = Math.max(opts.minN, p.minDen ?? 8);
    let rows: Row[];
    try {
      rows = await query(probeSql(p, opts.globalWhere, minDen));
    } catch (err) {
      console.warn(`[tendency-scanner] probe ${p.id} failed`, err);
      continue;
    }
    for (const row of rows) {
      const hitter = String(row.batter_name);
      if (opts.hitter && hitter !== opts.hitter) continue;
      const dims = p.dims.map((_, i) => String(row[`d${i}`]));
      const num = Number(row.num);
      const den = Number(row.den);
      const pden = Number(row.pden ?? 0);
      const peers = Number(row.peers ?? 0);
      // Self baseline = the hitter's OTHER pitches in the broader context (complement of the cell),
      // e.g. "chases sliders 50% after an elevated FF vs 10% otherwise".
      const sdenAll = row.sden == null ? 0 : Number(row.sden);
      const snumAll = row.snum == null ? 0 : Number(row.snum);
      const self: Rate | null = sdenAll - den >= 10 ? { num: snumAll - num, den: sdenAll - den } : null;
      const peer = pden >= 20 && peers >= 2 ? { num: Number(row.pnum), den: pden, hitters: peers } : null;
      let primary = p.primary;
      if (primary === "peer" && !peer) primary = "self";
      if (primary === "self" && !self) primary = "peer";
      const base = primary === "peer" ? peer : self;
      if (!base || base.den === 0) continue;
      const rate = num / den;
      // A within-hitter effect that every teammate shows too (e.g. "more Ks after an 0-1 start")
      // isn't a scouting edge — require it to also separate him from teammates in the same spot.
      if (primary === "self" && peer) {
        const vsPeer = rate - peer.num / peer.den;
        const vsSelf = rate - base.num / base.den;
        if (Math.sign(vsPeer) !== Math.sign(vsSelf) || Math.abs(vsPeer) < 0.08) continue;
      }
      const baselineRate = base.num / base.den;
      const delta = rate - baselineRate;
      const z = zScore(num, den, baselineRate);
      const minDelta = p.minDelta ?? 0.15;
      // Many cells are tested, so small samples need stronger evidence.
      const zMin = den >= 25 ? 2 : den >= 15 ? 2.3 : 2.6;
      if (Math.abs(delta) < minDelta || Math.abs(z) < zMin) continue;

      const m = METRICS[p.metric];
      const high = delta > 0;
      const subject = p.subject(dims);
      const { head } = phrase(p.metric, high, subject, { num, den });
      const tone: Insight["tone"] =
        m.higherIsGood === undefined ? "habit" : (m.higherIsGood ? high : !high) ? "strength" : "vulnerability";
      const cmp: string[] = [];
      const showAsInverse = (p.metric === "swing" && !high) || ((p.metric === "freeze" || p.metric === "heartFreeze") && !high);
      const fmt = (x: Rate) => {
        const shown = showAsInverse ? { num: x.den - x.num, den: x.den } : x;
        return `${pct(shown.num / shown.den)} (${shown.num}/${shown.den})`;
      };
      if (peer) cmp.push(`Teammates, same spot: ${fmt(peer)}`);
      if (self) cmp.push(`His other ${p.selfDims?.length || p.selfScope ? "comparable " : ""}pitches: ${fmt(self)}`);
      const confidence: Insight["confidence"] = den >= 25 && Math.abs(z) >= 3 ? "High" : den >= 12 && Math.abs(z) >= 2.5 ? "Medium" : "Low";
      const scope = [p.scope ?? "TRUE", m.paLevel ? "is_pa_terminal_pitch" : "TRUE", ...p.dims.map((d, i) => `CAST(${d.sql} AS VARCHAR) = ${sqlStr(dims[i])}`)].join(" AND ");
      out.push({
        id: `${p.id}|${hitter}|${dims.join("|")}`,
        probeId: p.id,
        category: p.category,
        hitter,
        metric: p.metric,
        headline: head,
        subline: cmp.join(" · "),
        value: { num, den },
        rate,
        pas: Number(row.pas),
        self,
        peer,
        primary,
        baselineRate,
        delta,
        z,
        score: Math.abs(z) * (0.5 + Math.min(Math.abs(delta), 0.5)),
        confidence,
        tone,
        cellSql: scope,
        dims,
      });
      // `family` is applied below.
      const fam = p.family?.(dims);
      (out[out.length - 1] as Insight & { family?: string }).family = fam ? `${fam}|${(p.familyFlip ? -delta : delta) > 0 ? "+" : "-"}` : undefined;
    }
  }

  // De-duplicate overlapping probes (e.g. "2-0 breaking" vs "hitter's-count breaking"): keep the best per family.
  const best = new Map<string, Insight>();
  const rest: Insight[] = [];
  for (const ins of out as (Insight & { family?: string })[]) {
    if (!ins.family) {
      rest.push(ins);
      continue;
    }
    const key = `${ins.hitter}|${ins.family}`;
    const cur = best.get(key);
    if (!cur || ins.score > cur.score) best.set(key, ins);
  }
  const merged = [...best.values(), ...rest].sort((a, b) => b.score - a.score);

  // Cap per hitter × category so one probe family can't flood the board.
  const cap = opts.maxPerCategory ?? 5;
  const seen = new Map<string, number>();
  return merged.filter((ins) => {
    const k = `${ins.hitter}|${ins.category}`;
    const n = seen.get(k) ?? 0;
    if (n >= cap) return false;
    seen.set(k, n + 1);
    return true;
  });
}

export function insightTitle(ins: Insight): string {
  return `${displayName(ins.hitter)} — ${ins.headline}`;
}

export const PROBE_COUNT = PROBES.length;
