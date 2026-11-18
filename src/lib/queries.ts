/**
 * SQL builders for the profile/team panels. Every builder takes a WHERE
 * clause from src/lib/filters.ts so panels always honor the global filter bar.
 * Aggregates come back as raw counts (never pre-computed percentages) so the
 * UI can print `pct (num/den)` everywhere.
 */
import { sqlStr, type MetricKey, type Rate } from "@/lib/metrics";

/** Pitch-level count columns shared by every aggregate panel. */
export const PITCH_AGG = `
  count(*) AS n,
  count(*) FILTER (WHERE is_swing) AS sw,
  count(*) FILTER (WHERE in_zone) AS iz,
  count(*) FILTER (WHERE in_zone AND is_take) AS frz,
  count(*) FILTER (WHERE attack_zone = 'Heart') AS hz,
  count(*) FILTER (WHERE attack_zone = 'Heart' AND is_take) AS hfrz,
  count(*) FILTER (WHERE in_zone = FALSE) AS oz,
  count(*) FILTER (WHERE in_zone = FALSE AND is_swing) AS ch,
  count(*) FILTER (WHERE is_whiff) AS wh,
  count(*) FILTER (WHERE is_foul) AS fl,
  count(*) FILTER (WHERE is_in_play) AS ip,
  count(*) FILTER (WHERE is_called_strike) AS cs,
  count(*) FILTER (WHERE is_in_play AND exit_speed IS NOT NULL) AS bip,
  count(*) FILTER (WHERE is_in_play AND exit_speed >= 95) AS hh,
  count(DISTINCT pa_uid) AS pas`;

/** PA-level count columns; apply to rows WHERE is_pa_terminal_pitch. */
export const PA_AGG = `
  count(*) AS pa,
  count(*) FILTER (WHERE pa_is_ab) AS ab,
  count(*) FILTER (WHERE pa_is_hit) AS h,
  CAST(coalesce(sum(pa_total_bases), 0) AS BIGINT) AS tb,
  count(*) FILTER (WHERE pa_result = 'HomeRun') AS hr,
  count(*) FILTER (WHERE pa_is_k) AS k,
  count(*) FILTER (WHERE pa_is_k_looking) AS kl,
  count(*) FILTER (WHERE pa_is_bb) AS bb,
  count(*) FILTER (WHERE pa_result = 'HitByPitch') AS hbp,
  count(*) FILTER (WHERE pa_result = 'Sacrifice') AS sac,
  count(*) FILTER (WHERE pa_is_weak_contact) AS weak`;

export interface PitchAgg {
  n: number;
  sw: number;
  iz: number;
  frz: number;
  hz: number;
  hfrz: number;
  oz: number;
  ch: number;
  wh: number;
  fl: number;
  ip: number;
  cs: number;
  bip: number;
  hh: number;
  pas: number;
}

export interface PaAgg {
  pa: number;
  ab: number;
  h: number;
  tb: number;
  hr: number;
  k: number;
  kl: number;
  bb: number;
  hbp: number;
  sac: number;
  weak: number;
}

export const EMPTY_PITCH_AGG: PitchAgg = { n: 0, sw: 0, iz: 0, frz: 0, hz: 0, hfrz: 0, oz: 0, ch: 0, wh: 0, fl: 0, ip: 0, cs: 0, bip: 0, hh: 0, pas: 0 };

/** Extract a metric's numerator/denominator from a pitch aggregate. */
export function aggRate(a: PitchAgg | null | undefined, metric: MetricKey): Rate {
  if (!a) return { num: 0, den: 0 };
  switch (metric) {
    case "swing":
      return { num: a.sw, den: a.n };
    case "take":
      return { num: a.n - a.sw, den: a.n };
    case "zswing":
      return { num: a.iz - a.frz, den: a.iz };
    case "freeze":
      return { num: a.frz, den: a.iz };
    case "heartFreeze":
      return { num: a.hfrz, den: a.hz };
    case "chase":
      return { num: a.ch, den: a.oz };
    case "whiff":
      return { num: a.wh, den: a.sw };
    case "contact":
      return { num: a.sw - a.wh, den: a.sw };
    case "foul":
      return { num: a.fl, den: a.sw };
    case "inPlay":
      return { num: a.ip, den: a.sw };
    case "calledStrike":
      return { num: a.cs, den: a.n - a.sw };
    case "hardHit":
      return { num: a.hh, den: a.bip };
    default:
      return { num: 0, den: 0 };
  }
}

export function slash(p: PaAgg | null | undefined) {
  if (!p) return { avg: null, obp: null, slg: null, ops: null };
  const avg = p.ab ? p.h / p.ab : null;
  const obpDen = p.ab + p.bb + p.hbp + p.sac;
  const obp = obpDen ? (p.h + p.bb + p.hbp) / obpDen : null;
  const slg = p.ab ? p.tb / p.ab : null;
  return { avg, obp, slg, ops: obp !== null && slg !== null ? obp + slg : null };
}

export function numify<T>(row: Record<string, unknown>): T {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) o[k] = typeof v === "number" || typeof v === "bigint" ? Number(v) : v;
  return o as T;
}

const E = "enriched_pitches";

export function rosterSql(where: string): string {
  return `
WITH p AS (SELECT * FROM ${E} WHERE ${where}),
pitch AS (
  SELECT batter_name,
    CASE WHEN count(DISTINCT batter_side) > 1 THEN 'S' ELSE any_value(batter_side) END AS bats,
    any_value(batter_team) AS team, ${PITCH_AGG},
    count(*) FILTER (WHERE is_first_pitch_of_pa) AS fp_n,
    count(*) FILTER (WHERE is_first_pitch_of_pa AND is_swing) AS fp_sw,
    count(*) FILTER (WHERE two_strikes AND is_swing) AS ts_sw,
    count(*) FILTER (WHERE two_strikes AND is_whiff) AS ts_wh
  FROM p GROUP BY batter_name
),
pa AS (SELECT batter_name, ${PA_AGG} FROM p WHERE is_pa_terminal_pitch GROUP BY batter_name)
SELECT * FROM pitch JOIN pa USING (batter_name) ORDER BY pa DESC`;
}

export function hitterListSql(where: string): string {
  return `SELECT batter_name, any_value(batter_team) AS team,
    CASE WHEN count(DISTINCT batter_side) > 1 THEN 'S' ELSE any_value(batter_side) END AS bats,
    count(*) AS pitches, count(DISTINCT pa_uid) AS pas
  FROM ${E} WHERE ${where} GROUP BY batter_name ORDER BY pas DESC, batter_name`;
}

/** Overall line for one hitter (and the team, excluding him) for the header strip. */
export function hitterHeaderSql(where: string, hitter: string): string {
  return `
WITH p AS (SELECT *, batter_name = ${sqlStr(hitter)} AS me FROM ${E} WHERE ${where})
SELECT me, ${PITCH_AGG},
  count(*) FILTER (WHERE is_first_pitch_of_pa) AS fp_n,
  count(*) FILTER (WHERE is_first_pitch_of_pa AND is_swing) AS fp_sw,
  count(*) FILTER (WHERE two_strikes AND is_swing) AS ts_sw,
  count(*) FILTER (WHERE two_strikes AND is_whiff) AS ts_wh,
  avg(exit_speed) FILTER (WHERE is_in_play) AS ev_avg,
  max(exit_speed) AS ev_max,
  any_value(batter_side) FILTER (WHERE me) AS side_any,
  count(DISTINCT batter_side) FILTER (WHERE me) AS sides,
  CAST(min(game_date) FILTER (WHERE me) AS VARCHAR) AS first_date,
  CAST(max(game_date) FILTER (WHERE me) AS VARCHAR) AS last_date,
  count(DISTINCT game_id) FILTER (WHERE me) AS games
FROM p GROUP BY me`;
}

export function hitterPaSql(where: string, hitter: string): string {
  return `SELECT batter_name = ${sqlStr(hitter)} AS me, ${PA_AGG} FROM ${E} WHERE ${where} AND is_pa_terminal_pitch GROUP BY 1`;
}

/**
 * Count matrix: per count, the hitter's pitch aggregate, the team's (other
 * hitters) aggregate, and what happened to PAs that passed through that count.
 */
export function countMatrixSql(where: string, hitter: string, pitchFilter: string): string {
  return `
WITH p AS (SELECT *, batter_name = ${sqlStr(hitter)} AS me FROM ${E} WHERE ${where} AND count_str IS NOT NULL),
agg AS (SELECT count_str, me, ${PITCH_AGG} FROM p WHERE ${pitchFilter} GROUP BY ALL),
paths AS (
  SELECT DISTINCT count_str, pa_uid, me, pa_result, pa_is_ab, pa_is_hit, pa_total_bases, pa_is_k, pa_is_bb, pa_is_k_looking
  FROM p
),
outc AS (
  SELECT count_str, me, count(*) AS reached,
    count(*) FILTER (WHERE pa_is_k) AS k, count(*) FILTER (WHERE pa_is_k_looking) AS kl,
    count(*) FILTER (WHERE pa_is_bb) AS bb, count(*) FILTER (WHERE pa_is_ab) AS ab,
    count(*) FILTER (WHERE pa_is_hit) AS h, CAST(coalesce(sum(pa_total_bases), 0) AS BIGINT) AS tb
  FROM paths GROUP BY ALL
)
SELECT a.*, o.reached, o.k, o.kl, o.bb, o.ab, o.h, o.tb
FROM agg a LEFT JOIN outc o USING (count_str, me)`;
}

/** Count × pitch type grid for one hitter. */
export function countTypeSql(where: string, hitter: string): string {
  return `
SELECT count_str, pitch_type, ${PITCH_AGG}
FROM ${E} WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND count_str IS NOT NULL AND pitch_type IS NOT NULL
GROUP BY ALL`;
}

/** Count-to-count transitions (and terminal outcomes) for the count-flow diagram. */
export function countFlowSql(where: string, hitter: string): string {
  return `
SELECT count_str AS src,
  CASE WHEN is_pa_terminal_pitch THEN
    CASE WHEN pa_is_k THEN 'K' WHEN pa_is_bb OR pa_result = 'HitByPitch' THEN 'BB' WHEN pa_is_hit THEN 'Hit' ELSE 'Out' END
  ELSE next_count_str END AS dst,
  count(*) AS n
FROM ${E}
WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND count_str IS NOT NULL
GROUP BY ALL`;
}

/** Generic breakdown: hitter vs team by an arbitrary dimension expression. */
export function breakdownSql(where: string, hitter: string, dimSql: string, extraWhere = "TRUE"): string {
  return `
WITH p AS (SELECT *, batter_name = ${sqlStr(hitter)} AS me FROM ${E} WHERE ${where} AND (${extraWhere}))
SELECT CAST(${dimSql} AS VARCHAR) AS dim, me, ${PITCH_AGG}
FROM p WHERE (${dimSql}) IS NOT NULL GROUP BY ALL`;
}

/** PA-level breakdown (on terminal pitches). */
export function paBreakdownSql(where: string, hitter: string, dimSql: string, extraWhere = "TRUE"): string {
  return `
WITH p AS (SELECT *, batter_name = ${sqlStr(hitter)} AS me FROM ${E} WHERE ${where} AND is_pa_terminal_pitch AND (${extraWhere}))
SELECT CAST(${dimSql} AS VARCHAR) AS dim, me, ${PA_AGG}
FROM p WHERE (${dimSql}) IS NOT NULL GROUP BY ALL`;
}

/** Prev pitch type → current pitch type matrix for one hitter. */
export function transitionSql(where: string, hitter: string): string {
  return `
SELECT prev_pitch_type AS prev, pitch_type AS cur, ${PITCH_AGG}
FROM ${E} WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND prev_pitch_type IS NOT NULL AND pitch_type IS NOT NULL
GROUP BY ALL`;
}

export const PITCH_POINT_COLS = `pitch_uid, pa_uid, game_date, pitcher_name, pitcher_throws, batter_name, batter_side, inning,
  count_str, pitch_type, pitch_group, pitch_call, rel_speed, plate_loc_side, plate_loc_height, attack_zone, in_zone,
  is_swing, is_whiff, is_take, is_freeze, is_chase, exit_speed, launch_angle, play_result, pa_result,
  prev_pitch_type, prev_plate_loc_side, prev_plate_loc_height, pa_pitch_seq, pitch_sequence_str, video_url`;

export function pitchPointsSql(where: string, extra = "TRUE", limit = 4000): string {
  return `SELECT ${PITCH_POINT_COLS} FROM ${E} WHERE ${where} AND (${extra})
    AND plate_loc_side IS NOT NULL AND plate_loc_height IS NOT NULL
    ORDER BY game_date, pa_uid, pa_pitch_seq LIMIT ${limit}`;
}

export function paLogSql(where: string, hitter: string, extra = "TRUE", limit = 500): string {
  return `
SELECT pa_uid, CAST(game_date AS VARCHAR) AS game_date, game_id, inning, top_bottom, pitcher_name, pitcher_throws, batter_side,
  pa_result, pa_final_count, pa_pitch_count, pa_sequence_full, pa_start_outs, pa_start_base_state, exit_speed, launch_angle
FROM ${E}
WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND is_pa_terminal_pitch AND pa_uid IN (
  SELECT pa_uid FROM ${E} WHERE ${where} AND batter_name = ${sqlStr(hitter)} AND (${extra})
)
ORDER BY game_date DESC, inning DESC LIMIT ${limit}`;
}

export function paDetailSql(paUid: string): string {
  return `SELECT ${PITCH_POINT_COLS}, balls, strikes, outs, base_state, top_bottom, game_id, spin_rate, induced_vert_break, horz_break,
    loc_vertical, loc_horizontal_rel, velo_delta_from_prev, pa_pitch_count, is_pa_terminal_pitch
  FROM ${E} WHERE pa_uid = ${sqlStr(paUid)} ORDER BY pa_pitch_seq`;
}

export interface PitchPoint {
  pitch_uid: string;
  pa_uid: string;
  game_date: string;
  pitcher_name: string | null;
  pitcher_throws: string | null;
  batter_name: string;
  batter_side: string | null;
  inning: number | null;
  count_str: string | null;
  pitch_type: string | null;
  pitch_group: string | null;
  pitch_call: string;
  rel_speed: number | null;
  plate_loc_side: number;
  plate_loc_height: number;
  attack_zone: string | null;
  in_zone: boolean | null;
  is_swing: boolean;
  is_whiff: boolean;
  is_take: boolean;
  is_freeze: boolean | null;
  is_chase: boolean | null;
  exit_speed: number | null;
  launch_angle: number | null;
  play_result: string | null;
  pa_result: string | null;
  prev_pitch_type: string | null;
  prev_plate_loc_side: number | null;
  prev_plate_loc_height: number | null;
  pa_pitch_seq: number;
  pitch_sequence_str: string | null;
  video_url: string | null;
}
