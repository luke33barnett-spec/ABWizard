/**
 * Single source of truth for every SQL definition in ABWizard:
 *   pitches_raw  → loaded straight from the schema mapper (one row per pitch per file)
 *   pitches      → deduped by pitch_uid + derived flags (swing/take/zone/count buckets)
 *   enriched_pitches_view → windowed sequencing columns per plate appearance
 *   enriched_pitches      → materialized snapshot of the view (query this one)
 *
 * The metric vocabulary is documented in CLAUDE.md §A.3 and in ENRICHED_COLUMNS
 * below (which is also what the LLM sees).
 */
import { RAW_COLUMNS } from "@/lib/schema-mapper";

export const ZONE = { halfWidth: 0.83, bottom: 1.5, top: 3.5 } as const;

const SWING_CALLS = "('StrikeSwinging','FoulBall','InPlay')";

export function createRawTableSql(): string {
  const cols = RAW_COLUMNS.map(([name, type]) => `  ${name} ${type}`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS pitches_raw (\n${cols},\n  ingest_seq INTEGER\n);`;
}

/** Column spec for read_csv(..., columns = {...}) matching RAW_COLUMNS. */
export function rawColumnsSpec(extra: [string, string][] = []): string {
  return `{${[...RAW_COLUMNS, ...extra].map(([name, type]) => `'${name}': '${type}'`).join(", ")}}`;
}

/**
 * read_csv() over a staging/snapshot CSV written by toStagingCsv() or COPY TO.
 * Core DuckDB only — no extension downloads. `\\N` marks NULL.
 */
export function readRawCsvSql(path: string, withSeq = false): string {
  return `read_csv('${path}', header = true, auto_detect = false, delim = ',', quote = '"', escape = '"', nullstr = '\\N',
    columns = ${rawColumnsSpec(withSeq ? [["ingest_seq", "INTEGER"]] : [])})`;
}

export const BUILD_PITCHES_SQL = `
CREATE OR REPLACE TABLE pitches AS
WITH dedup AS (
  SELECT * FROM pitches_raw
  QUALIFY ROW_NUMBER() OVER (PARTITION BY pitch_uid ORDER BY ingest_seq DESC, row_idx) = 1
),
base AS (
  SELECT
    d.*,
    CASE WHEN plate_loc_side IS NULL OR plate_loc_height IS NULL THEN NULL
         ELSE abs(plate_loc_side) <= ${ZONE.halfWidth} AND plate_loc_height BETWEEN ${ZONE.bottom} AND ${ZONE.top} END AS in_zone_,
    greatest(abs(plate_loc_side) / ${ZONE.halfWidth}, abs(plate_loc_height - ${(ZONE.top + ZONE.bottom) / 2}) / ${(ZONE.top - ZONE.bottom) / 2}) AS zone_dist_,
    plate_loc_side * CASE batter_side WHEN 'R' THEN -1 WHEN 'L' THEN 1 END AS inside_offset_
  FROM dedup d
)
SELECT
  pitch_uid, source_file, source_format, game_id, game_date, pitch_no,
  pitcher_name, pitcher_id, pitcher_throws, pitcher_team,
  batter_name, batter_id, batter_side, batter_team,
  inning, top_bottom, pa_of_inning, pitch_of_pa,
  concat_ws('_', coalesce(CAST(game_date AS VARCHAR), 'nodate'), game_id, coalesce(CAST(inning AS VARCHAR), '?'),
            coalesce(top_bottom, '?'), coalesce(CAST(pa_of_inning AS VARCHAR), '?'), batter_name) AS pa_uid,
  balls, strikes,
  CASE WHEN balls IS NOT NULL AND strikes IS NOT NULL THEN CAST(balls AS VARCHAR) || '-' || CAST(strikes AS VARCHAR) END AS count_str,
  CASE
    WHEN balls IS NULL OR strikes IS NULL THEN NULL
    WHEN balls = 0 AND strikes = 0 THEN 'First Pitch'
    WHEN balls = 3 AND strikes = 2 THEN 'Full'
    WHEN balls > strikes THEN 'Hitter Ahead'
    WHEN strikes > balls THEN 'Pitcher Ahead'
    ELSE 'Even'
  END AS count_bucket,
  strikes = 2 AS two_strikes,
  outs,
  on_1b, on_2b, on_3b,
  CASE WHEN on_1b IS NULL THEN NULL
       ELSE (CASE WHEN on_1b THEN '1' ELSE '-' END) || (CASE WHEN on_2b THEN '2' ELSE '-' END) || (CASE WHEN on_3b THEN '3' ELSE '-' END) END AS base_state,
  CASE WHEN on_1b IS NULL THEN NULL ELSE CAST(on_1b AS INTEGER) + CAST(on_2b AS INTEGER) + CAST(on_3b AS INTEGER) END AS runners_on,
  CASE WHEN on_1b IS NULL THEN NULL ELSE on_2b OR on_3b END AS risp,
  pitch_type, pitch_type_raw,
  CASE WHEN pitch_type IN ('FF','SI','FC') THEN 'Fastball'
       WHEN pitch_type IN ('SL','ST','CU') THEN 'Breaking'
       WHEN pitch_type IN ('CH','FS','KN') THEN 'Offspeed'
       WHEN pitch_type IS NULL THEN NULL ELSE 'Other' END AS pitch_group,
  CASE WHEN pitch_type IN ('FF','SI','FC') THEN 'H' WHEN pitch_type IS NULL THEN NULL ELSE 'S' END AS hard_soft,
  pitch_call, pitch_call_raw,
  pitch_call IN ${SWING_CALLS} AS is_swing,
  pitch_call = 'StrikeSwinging' AS is_whiff,
  pitch_call NOT IN ${SWING_CALLS} AS is_take,
  pitch_call IN ('FoulBall','InPlay') AS is_contact,
  pitch_call = 'FoulBall' AS is_foul,
  pitch_call = 'InPlay' AS is_in_play,
  pitch_call = 'StrikeCalled' AS is_called_strike,
  pitch_call = 'BallCalled' AS is_ball,
  pitch_call IN ('StrikeCalled','StrikeSwinging','FoulBall','InPlay') AS is_strike,
  in_zone_ AS in_zone,
  CASE WHEN in_zone_ IS NULL THEN NULL ELSE pitch_call IN ${SWING_CALLS} AND NOT in_zone_ END AS is_chase,
  CASE WHEN in_zone_ IS NULL THEN NULL ELSE pitch_call NOT IN ${SWING_CALLS} AND in_zone_ END AS is_freeze,
  CASE WHEN zone_dist_ IS NULL THEN NULL
       WHEN zone_dist_ <= 0.67 THEN 'Heart'
       WHEN zone_dist_ <= 1.33 THEN 'Shadow'
       WHEN zone_dist_ <= 2.0 THEN 'Chase'
       ELSE 'Waste' END AS attack_zone,
  CASE WHEN in_zone_ IS NULL THEN NULL
       WHEN in_zone_ THEN
         (CASE WHEN plate_loc_height > 2.8333 THEN 0 WHEN plate_loc_height < 2.1667 THEN 2 ELSE 1 END) * 3
         + (CASE WHEN plate_loc_side < -0.2767 THEN 0 WHEN plate_loc_side > 0.2767 THEN 2 ELSE 1 END) + 1
       WHEN plate_loc_height >= 2.5 AND plate_loc_side < 0 THEN 11
       WHEN plate_loc_height >= 2.5 THEN 12
       WHEN plate_loc_side < 0 THEN 13
       ELSE 14 END AS zone_cell,
  CASE WHEN plate_loc_height IS NULL THEN NULL
       WHEN plate_loc_height >= 2.8333 THEN 'Up'
       WHEN plate_loc_height <= 2.1667 THEN 'Down'
       ELSE 'Middle' END AS loc_vertical,
  round(inside_offset_, 3) AS inside_offset,
  CASE WHEN inside_offset_ IS NULL THEN NULL
       WHEN inside_offset_ >= 0.2767 THEN 'In'
       WHEN inside_offset_ <= -0.2767 THEN 'Away'
       ELSE 'Middle' END AS loc_horizontal_rel,
  rel_speed, spin_rate, induced_vert_break, horz_break, plate_loc_side, plate_loc_height,
  exit_speed, launch_angle, distance, bearing, hit_type,
  pitch_call = 'InPlay' AND exit_speed >= 95 AS is_hard_hit,
  pitch_call = 'InPlay' AND (exit_speed < 80 OR launch_angle > 50) AS is_weak_contact,
  event_result, pa_result_hint,
  video_url
FROM base;
`;

const SEQ_LABEL = `coalesce(pitch_type, '??') || ' (' || CASE
    WHEN pitch_call = 'StrikeSwinging' THEN 'Whiff'
    WHEN pitch_call = 'FoulBall' THEN 'Foul'
    WHEN pitch_call = 'InPlay' THEN 'InPlay'
    WHEN pitch_call = 'StrikeCalled' THEN 'Take-K'
    WHEN pitch_call = 'BallCalled' THEN 'Take-B'
    WHEN pitch_call = 'HitByPitch' THEN 'HBP'
    ELSE '?' END || ')'`;

export const BUILD_ENRICHED_VIEW_SQL = `
CREATE OR REPLACE VIEW enriched_pitches_view AS
WITH seq AS (
  SELECT p.*,
    ROW_NUMBER() OVER (PARTITION BY pa_uid ORDER BY pitch_of_pa NULLS LAST, pitch_no NULLS LAST, pitch_uid) AS pa_pitch_seq,
    ${SEQ_LABEL} AS pitch_label
  FROM pitches p
),
w1 AS (
  SELECT s.*,
    LAG(pitch_type) OVER w AS prev_pitch_type,
    LAG(pitch_type, 2) OVER w AS prev_2_pitch_type,
    LAG(pitch_group) OVER w AS prev_pitch_group,
    LAG(pitch_group, 2) OVER w AS prev_2_pitch_group,
    LAG(pitch_call) OVER w AS prev_pitch_call,
    LAG(is_swing) OVER w AS prev_is_swing,
    LAG(is_take) OVER w AS prev_is_take,
    LAG(is_whiff) OVER w AS prev_is_whiff,
    LAG(is_freeze) OVER w AS prev_is_freeze,
    LAG(in_zone) OVER w AS prev_in_zone,
    LAG(plate_loc_side) OVER w AS prev_plate_loc_side,
    LAG(plate_loc_height) OVER w AS prev_plate_loc_height,
    LAG(rel_speed) OVER w AS prev_rel_speed,
    LAG(attack_zone) OVER w AS prev_attack_zone,
    LAG(loc_vertical) OVER w AS prev_loc_vertical,
    LAG(loc_horizontal_rel) OVER w AS prev_loc_horizontal_rel,
    LAG(count_str) OVER w AS prev_count_str,
    LAG(hard_soft) OVER w AS prev_hard_soft,
    LAG(hard_soft, 2) OVER w AS prev_2_hard_soft,
    LEAD(pitch_type) OVER w AS next_pitch_type,
    LEAD(pitch_call) OVER w AS next_pitch_call,
    LEAD(is_swing) OVER w AS next_is_swing,
    LEAD(count_str) OVER w AS next_count_str,
    COUNT(*) OVER (PARTITION BY pa_uid) AS pa_pitch_count,
    list(pitch_label ORDER BY pa_pitch_seq) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seq_list_,
    list(pitch_label ORDER BY pa_pitch_seq) OVER (PARTITION BY pa_uid) AS full_seq_list_,
    string_agg(coalesce(hard_soft, '?'), '' ORDER BY pa_pitch_seq) OVER (PARTITION BY pa_uid) AS pa_hs_sequence,
    SUM(CASE WHEN pitch_group = 'Breaking' THEN 0 ELSE 1 END) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS brk_run_id_
  FROM seq s
  WINDOW w AS (PARTITION BY pa_uid ORDER BY pa_pitch_seq)
),
w2 AS (
  SELECT w1.*,
    pa_pitch_seq = 1 AS is_first_pitch_of_pa,
    pa_pitch_seq = pa_pitch_count AS is_pa_terminal_pitch,
    CASE WHEN pitch_group = 'Breaking'
         THEN SUM(CASE WHEN pitch_group = 'Breaking' THEN 1 ELSE 0 END)
              OVER (PARTITION BY pa_uid, brk_run_id_ ORDER BY pa_pitch_seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
         ELSE 0 END AS consecutive_breaking,
    CASE WHEN pa_pitch_seq = pa_pitch_count THEN
      coalesce(event_result,
        CASE WHEN pitch_call IN ('StrikeCalled','StrikeSwinging') AND strikes = 2 THEN 'Strikeout'
             WHEN pitch_call = 'BallCalled' AND balls = 3 THEN 'Walk'
             WHEN pitch_call = 'HitByPitch' THEN 'HitByPitch' END)
    END AS terminal_result_
  FROM w1
),
w3 AS (
  SELECT w2.*,
    coalesce(
      MAX(terminal_result_) OVER (PARTITION BY pa_uid),
      MAX(event_result) OVER (PARTITION BY pa_uid),
      MAX(pa_result_hint) OVER (PARTITION BY pa_uid),
      'Incomplete') AS pa_result,
    MAX(consecutive_breaking) OVER (PARTITION BY pa_uid) AS pa_max_breaking_streak,
    FIRST_VALUE(pitch_type) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq) AS pa_first_pitch_type,
    FIRST_VALUE(pitch_call) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq) AS pa_first_pitch_call,
    FIRST_VALUE(outs) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq) AS pa_start_outs,
    FIRST_VALUE(base_state) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq) AS pa_start_base_state,
    LAST_VALUE(count_str) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS pa_final_count,
    LAST_VALUE(pitch_call) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS pa_final_pitch_call,
    LAST_VALUE(exit_speed) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS pa_final_exit_speed,
    LAST_VALUE(launch_angle) OVER (PARTITION BY pa_uid ORDER BY pa_pitch_seq ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS pa_final_launch_angle
  FROM w2
)
SELECT
  * EXCLUDE (seq_list_, full_seq_list_, brk_run_id_, terminal_result_, pitch_label),
  CASE WHEN is_pa_terminal_pitch THEN coalesce(event_result, terminal_result_) ELSE event_result END AS play_result,
  array_to_string(seq_list_, ' -> ') AS pitch_sequence_str,
  array_to_string(full_seq_list_, ' -> ') AS pa_sequence_full,
  CASE WHEN prev_2_hard_soft IS NOT NULL AND prev_hard_soft IS NOT NULL AND hard_soft IS NOT NULL
       THEN prev_2_hard_soft || prev_hard_soft || hard_soft END AS seq_hs_3,
  substr(pa_hs_sequence, 1, 3) AS pa_first3_hs,
  rel_speed - prev_rel_speed AS velo_delta_from_prev,
  plate_loc_height - prev_plate_loc_height AS vertical_tunnel_delta,
  plate_loc_side - prev_plate_loc_side AS horizontal_tunnel_delta,
  CASE WHEN prev_loc_vertical IS NOT NULL AND prev_loc_horizontal_rel IS NOT NULL
       THEN prev_loc_vertical || '-' || prev_loc_horizontal_rel END AS prev_location_label,
  CASE WHEN loc_vertical IS NOT NULL AND loc_horizontal_rel IS NOT NULL
       THEN loc_vertical || '-' || loc_horizontal_rel END AS location_label,
  pa_result IN ('Single','Double','Triple','HomeRun') AS pa_is_hit,
  pa_result = 'Strikeout' AS pa_is_k,
  pa_result = 'Strikeout' AND pa_final_pitch_call = 'StrikeCalled' AS pa_is_k_looking,
  pa_result = 'Walk' AS pa_is_bb,
  pa_result IN ('Single','Double','Triple','HomeRun','Out','Error','FieldersChoice','Strikeout') AS pa_is_ab,
  CASE pa_result WHEN 'Single' THEN 1 WHEN 'Double' THEN 2 WHEN 'Triple' THEN 3 WHEN 'HomeRun' THEN 4 ELSE 0 END AS pa_total_bases,
  pa_final_pitch_call = 'InPlay' AND (pa_final_exit_speed < 80 OR pa_final_launch_angle > 50) AS pa_is_weak_contact,
  is_pa_terminal_pitch AND pa_result = 'Strikeout' AND pitch_call = 'StrikeCalled' AS is_called_strike_three,
  DENSE_RANK() OVER (PARTITION BY game_id, batter_name ORDER BY inning, pa_of_inning) AS pa_num_in_game,
  DENSE_RANK() OVER (PARTITION BY game_id, batter_name, pitcher_name ORDER BY inning, pa_of_inning) AS times_faced_pitcher
FROM w3;
`;

export const MATERIALIZE_ENRICHED_SQL = `
CREATE OR REPLACE TABLE enriched_pitches AS
SELECT * FROM enriched_pitches_view
ORDER BY batter_name, game_date, pa_uid, pa_pitch_seq;
`;

/** Rebuilds pitches → enriched view → materialized table, in order. */
export const REBUILD_SQL = [BUILD_PITCHES_SQL, BUILD_ENRICHED_VIEW_SQL, MATERIALIZE_ENRICHED_SQL];

/**
 * Column documentation for `enriched_pitches` — rendered in the Schema modal
 * and sent (with distinct values) to the LLM as its only knowledge of the data.
 */
export const ENRICHED_COLUMNS: { name: string; type: string; desc: string }[] = [
  // identity
  { name: "pitch_uid", type: "VARCHAR", desc: "Unique pitch id (dedupe key)" },
  { name: "pa_uid", type: "VARCHAR", desc: "Unique plate appearance id: date_game_inning_half_paOfInning_batter" },
  { name: "game_id", type: "VARCHAR", desc: "Game identifier" },
  { name: "game_date", type: "DATE", desc: "Game date" },
  { name: "batter_name", type: "VARCHAR", desc: "Hitter, 'Last, First'" },
  { name: "batter_team", type: "VARCHAR", desc: "Hitter's team code (Alabama = 'ALA_CRI')" },
  { name: "batter_side", type: "VARCHAR", desc: "'R' or 'L' (side actually batted from on this pitch)" },
  { name: "pitcher_name", type: "VARCHAR", desc: "Pitcher, 'Last, First'" },
  { name: "pitcher_throws", type: "VARCHAR", desc: "'R' (vs RHP) or 'L' (vs LHP)" },
  { name: "pitcher_team", type: "VARCHAR", desc: "Pitcher's team code" },
  { name: "inning", type: "INTEGER", desc: "Inning" },
  { name: "top_bottom", type: "VARCHAR", desc: "'Top' or 'Bottom'" },
  { name: "pa_of_inning", type: "INTEGER", desc: "PA number within the half inning" },
  { name: "pitch_of_pa", type: "INTEGER", desc: "Pitch number within the PA as exported" },
  { name: "pa_pitch_seq", type: "BIGINT", desc: "1-based pitch order within the PA (use this for ordering)" },
  { name: "pa_num_in_game", type: "BIGINT", desc: "Hitter's Nth plate appearance of the game (1 = first AB)" },
  { name: "times_faced_pitcher", type: "BIGINT", desc: "Nth time this hitter faced this pitcher in the game" },
  // count & situation
  { name: "balls", type: "INTEGER", desc: "Balls BEFORE the pitch (0-3)" },
  { name: "strikes", type: "INTEGER", desc: "Strikes BEFORE the pitch (0-2)" },
  { name: "count_str", type: "VARCHAR", desc: "Count before the pitch, e.g. '2-0'" },
  { name: "count_bucket", type: "VARCHAR", desc: "'First Pitch' (0-0), 'Hitter Ahead' (1-0,2-0,3-0,2-1,3-1), 'Even' (1-1,2-2), 'Pitcher Ahead' (0-1,0-2,1-2), 'Full' (3-2)" },
  { name: "two_strikes", type: "BOOLEAN", desc: "strikes = 2" },
  { name: "outs", type: "INTEGER", desc: "Outs before the pitch" },
  { name: "base_state", type: "VARCHAR", desc: "Runners as '1-3' style string ('---' empty); NULL when export lacks runner data" },
  { name: "runners_on", type: "INTEGER", desc: "Number of runners on (NULL if unknown)" },
  { name: "risp", type: "BOOLEAN", desc: "Runner on 2B or 3B (NULL if unknown)" },
  { name: "next_count_str", type: "VARCHAR", desc: "Count before the NEXT pitch of the PA (NULL on the last pitch)" },
  // pitch
  { name: "pitch_type", type: "VARCHAR", desc: "FF 4-Seam, SI Sinker, FC Cutter, SL Slider, ST Sweeper, CU Curveball, CH Changeup, FS Splitter, KN Knuckleball, OT Other" },
  { name: "pitch_group", type: "VARCHAR", desc: "'Fastball' (FF/SI/FC), 'Breaking' (SL/ST/CU), 'Offspeed' (CH/FS/KN)" },
  { name: "hard_soft", type: "VARCHAR", desc: "'H' = fastball family, 'S' = breaking/offspeed" },
  { name: "rel_speed", type: "DOUBLE", desc: "Velocity, mph" },
  { name: "spin_rate", type: "DOUBLE", desc: "Spin rate, rpm" },
  { name: "induced_vert_break", type: "DOUBLE", desc: "Induced vertical break, inches" },
  { name: "horz_break", type: "DOUBLE", desc: "Horizontal break, inches" },
  // location
  { name: "plate_loc_side", type: "DOUBLE", desc: "Feet from plate center, CATCHER'S VIEW, + = catcher's right (1B side)" },
  { name: "plate_loc_height", type: "DOUBLE", desc: "Feet above ground" },
  { name: "in_zone", type: "BOOLEAN", desc: "Rulebook zone: |side| <= 0.83 and 1.5 <= height <= 3.5" },
  { name: "attack_zone", type: "VARCHAR", desc: "'Heart', 'Shadow', 'Chase', 'Waste' (Statcast-style bands)" },
  { name: "zone_cell", type: "INTEGER", desc: "1-9 = 3x3 in-zone grid (catcher's view, 1 = top-left), 11 up-left, 12 up-right, 13 down-left, 14 down-right" },
  { name: "loc_vertical", type: "VARCHAR", desc: "'Up' (>= upper third), 'Middle', 'Down' (<= lower third)" },
  { name: "loc_horizontal_rel", type: "VARCHAR", desc: "Relative to the batter: 'In', 'Middle', 'Away'" },
  { name: "location_label", type: "VARCHAR", desc: "loc_vertical || '-' || loc_horizontal_rel, e.g. 'Up-In', 'Down-Away'" },
  { name: "inside_offset", type: "DOUBLE", desc: "Feet toward the batter (+ = inside, - = away)" },
  // outcome per pitch
  { name: "pitch_call", type: "VARCHAR", desc: "'InPlay','StrikeCalled','StrikeSwinging','FoulBall','BallCalled','HitByPitch'" },
  { name: "is_swing", type: "BOOLEAN", desc: "StrikeSwinging, FoulBall or InPlay" },
  { name: "is_take", type: "BOOLEAN", desc: "NOT is_swing" },
  { name: "is_whiff", type: "BOOLEAN", desc: "StrikeSwinging" },
  { name: "is_contact", type: "BOOLEAN", desc: "FoulBall or InPlay" },
  { name: "is_foul", type: "BOOLEAN", desc: "FoulBall" },
  { name: "is_in_play", type: "BOOLEAN", desc: "InPlay" },
  { name: "is_called_strike", type: "BOOLEAN", desc: "StrikeCalled" },
  { name: "is_ball", type: "BOOLEAN", desc: "BallCalled" },
  { name: "is_strike", type: "BOOLEAN", desc: "Any strike (called, swinging, foul, in play)" },
  { name: "is_chase", type: "BOOLEAN", desc: "Swing at a pitch outside the zone" },
  { name: "is_freeze", type: "BOOLEAN", desc: "TAKE on a pitch inside the zone (the 'freeze' metric)" },
  { name: "is_called_strike_three", type: "BOOLEAN", desc: "PA-ending called strike three (looking K)" },
  { name: "exit_speed", type: "DOUBLE", desc: "Exit velocity, mph (balls in play)" },
  { name: "launch_angle", type: "DOUBLE", desc: "Launch angle, degrees" },
  { name: "is_hard_hit", type: "BOOLEAN", desc: "In play with EV >= 95" },
  { name: "is_weak_contact", type: "BOOLEAN", desc: "In play with EV < 80 or LA > 50" },
  { name: "hit_type", type: "VARCHAR", desc: "GroundBall / LineDrive / FlyBall / Popup when tagged" },
  { name: "play_result", type: "VARCHAR", desc: "Result recorded on this pitch: Single, Double, Triple, HomeRun, Out, Sacrifice, Error, FieldersChoice, Walk, Strikeout, HitByPitch (NULL mid-PA)" },
  // sequencing
  { name: "prev_pitch_type", type: "VARCHAR", desc: "Previous pitch type in this PA (NULL on first pitch)" },
  { name: "prev_2_pitch_type", type: "VARCHAR", desc: "Pitch type two pitches back" },
  { name: "prev_pitch_group", type: "VARCHAR", desc: "Previous pitch group" },
  { name: "prev_2_pitch_group", type: "VARCHAR", desc: "Pitch group two pitches back" },
  { name: "prev_pitch_call", type: "VARCHAR", desc: "Previous pitch call" },
  { name: "prev_is_swing", type: "BOOLEAN", desc: "Swung at previous pitch" },
  { name: "prev_is_take", type: "BOOLEAN", desc: "Took previous pitch" },
  { name: "prev_is_whiff", type: "BOOLEAN", desc: "Whiffed on previous pitch" },
  { name: "prev_is_freeze", type: "BOOLEAN", desc: "Froze on (took in-zone) previous pitch" },
  { name: "prev_in_zone", type: "BOOLEAN", desc: "Previous pitch was in the zone" },
  { name: "prev_plate_loc_side", type: "DOUBLE", desc: "Previous pitch side location" },
  { name: "prev_plate_loc_height", type: "DOUBLE", desc: "Previous pitch height" },
  { name: "prev_rel_speed", type: "DOUBLE", desc: "Previous pitch velocity" },
  { name: "prev_attack_zone", type: "VARCHAR", desc: "Previous pitch attack zone" },
  { name: "prev_loc_vertical", type: "VARCHAR", desc: "Previous pitch Up/Middle/Down" },
  { name: "prev_loc_horizontal_rel", type: "VARCHAR", desc: "Previous pitch In/Middle/Away" },
  { name: "prev_location_label", type: "VARCHAR", desc: "Previous pitch e.g. 'Up-In'" },
  { name: "prev_count_str", type: "VARCHAR", desc: "Count before the previous pitch" },
  { name: "prev_hard_soft", type: "VARCHAR", desc: "Previous pitch H/S" },
  { name: "next_pitch_type", type: "VARCHAR", desc: "Next pitch type in the PA" },
  { name: "next_pitch_call", type: "VARCHAR", desc: "Next pitch call in the PA" },
  { name: "next_is_swing", type: "BOOLEAN", desc: "Swung at the next pitch" },
  { name: "velo_delta_from_prev", type: "DOUBLE", desc: "rel_speed - prev_rel_speed (negative = slower than last pitch)" },
  { name: "vertical_tunnel_delta", type: "DOUBLE", desc: "plate_loc_height - prev_plate_loc_height (feet)" },
  { name: "horizontal_tunnel_delta", type: "DOUBLE", desc: "plate_loc_side - prev_plate_loc_side (feet, catcher's view)" },
  { name: "pitch_sequence_str", type: "VARCHAR", desc: "PA sequence through this pitch, e.g. 'FF (Take-B) -> SL (Whiff) -> CU (Take-K)'" },
  { name: "pa_sequence_full", type: "VARCHAR", desc: "Entire PA sequence (same on every pitch of the PA)" },
  { name: "seq_hs_3", type: "VARCHAR", desc: "Hard/soft code of prev2, prev, current, e.g. 'HHS'" },
  { name: "pa_hs_sequence", type: "VARCHAR", desc: "Hard/soft code of the whole PA, e.g. 'HSHS'" },
  { name: "pa_first3_hs", type: "VARCHAR", desc: "First 3 pitches of the PA as H/S, e.g. 'HHS'" },
  { name: "consecutive_breaking", type: "BIGINT", desc: "Breaking balls in a row ending at this pitch (0 if not breaking)" },
  { name: "pa_max_breaking_streak", type: "BIGINT", desc: "Longest run of consecutive breaking balls in the PA" },
  { name: "is_first_pitch_of_pa", type: "BOOLEAN", desc: "First pitch of the PA" },
  { name: "is_pa_terminal_pitch", type: "BOOLEAN", desc: "Last pitch of the PA" },
  // PA-level (repeated on every pitch of the PA)
  { name: "pa_pitch_count", type: "BIGINT", desc: "Pitches in the PA" },
  { name: "pa_result", type: "VARCHAR", desc: "Final PA result (same on every pitch of the PA): Single, Double, Triple, HomeRun, Out, Sacrifice, Error, FieldersChoice, Walk, Strikeout, HitByPitch, Incomplete" },
  { name: "pa_final_count", type: "VARCHAR", desc: "Count before the PA's last pitch" },
  { name: "pa_first_pitch_type", type: "VARCHAR", desc: "First pitch type of the PA" },
  { name: "pa_first_pitch_call", type: "VARCHAR", desc: "First pitch call of the PA" },
  { name: "pa_start_outs", type: "INTEGER", desc: "Outs when the PA started" },
  { name: "pa_start_base_state", type: "VARCHAR", desc: "Base state when the PA started" },
  { name: "pa_is_hit", type: "BOOLEAN", desc: "PA ended in a hit" },
  { name: "pa_is_k", type: "BOOLEAN", desc: "PA ended in a strikeout" },
  { name: "pa_is_k_looking", type: "BOOLEAN", desc: "PA ended in a called strike three" },
  { name: "pa_is_bb", type: "BOOLEAN", desc: "PA ended in a walk" },
  { name: "pa_is_ab", type: "BOOLEAN", desc: "PA counts as an official at-bat" },
  { name: "pa_total_bases", type: "INTEGER", desc: "Total bases from the PA" },
  { name: "pa_is_weak_contact", type: "BOOLEAN", desc: "PA ended on a weakly hit ball in play" },
  { name: "source_file", type: "VARCHAR", desc: "CSV the pitch came from" },
  { name: "video_url", type: "VARCHAR", desc: "Video link if exported" },
];

/** Columns whose distinct values are worth sending to the LLM. */
export const DISTINCT_VALUE_COLUMNS = [
  "pitch_type",
  "pitch_group",
  "pitch_call",
  "count_str",
  "count_bucket",
  "attack_zone",
  "location_label",
  "pa_result",
  "pitcher_throws",
  "batter_side",
  "batter_team",
  "hit_type",
];
