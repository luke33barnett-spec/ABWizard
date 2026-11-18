/**
 * Schema mapper: turns any TrackMan v3 or TruMedia pitch-by-pitch CSV into
 * rows of one normalized shape (`NormalizedPitch`) that loads into the DuckDB
 * `pitches_raw` table. Derived flags (is_swing, in_zone, attack_zone, …) are
 * computed in SQL (src/lib/sql/schema.ts) so their definitions live in exactly
 * one place that both the UI and the LLM read.
 *
 * Pure TypeScript, no browser APIs — safe to unit-test or run in Node.
 */

export type Hand = "R" | "L";

export type NormalizedPitchCall =
  | "InPlay"
  | "StrikeCalled"
  | "StrikeSwinging"
  | "FoulBall"
  | "BallCalled"
  | "HitByPitch"
  | "Unknown";

export type NormalizedPitchType = "FF" | "SI" | "FC" | "SL" | "ST" | "CU" | "CH" | "FS" | "KN" | "OT";

export const PITCH_TYPE_LABELS: Record<NormalizedPitchType, string> = {
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

/** One pitch, normalized. Field names match the `pitches_raw` DuckDB columns exactly. */
export interface NormalizedPitch {
  pitch_uid: string;
  source_file: string;
  source_format: SourceFormat;
  row_idx: number;
  game_id: string;
  game_date: string | null; // YYYY-MM-DD
  pitch_no: number | null; // pitch number within the game, when exported
  pitcher_name: string | null;
  pitcher_id: string | null;
  pitcher_throws: Hand | null;
  pitcher_team: string | null;
  batter_name: string | null;
  batter_id: string | null;
  batter_side: Hand | null;
  batter_team: string | null;
  inning: number | null;
  top_bottom: "Top" | "Bottom" | null;
  pa_of_inning: number | null;
  pitch_of_pa: number | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  on_1b: boolean | null;
  on_2b: boolean | null;
  on_3b: boolean | null;
  pitch_type: NormalizedPitchType | null;
  pitch_type_raw: string | null;
  pitch_call: NormalizedPitchCall;
  pitch_call_raw: string | null;
  event_result: string | null; // result recorded on this pitch (InPlay result, K, BB, HBP)
  pa_result_hint: string | null; // PA-level result column when an export repeats it on every row
  hit_type: string | null;
  rel_speed: number | null;
  spin_rate: number | null;
  induced_vert_break: number | null;
  horz_break: number | null;
  plate_loc_side: number | null; // feet, catcher's view, + = catcher's right (1B side)
  plate_loc_height: number | null; // feet above ground
  exit_speed: number | null;
  launch_angle: number | null;
  distance: number | null;
  bearing: number | null;
  video_url: string | null;
}

export type SourceFormat = "TrackMan" | "TruMedia" | "Generic";

/** DuckDB column types for `pitches_raw`, in insertion order. Must stay in sync with NormalizedPitch. */
export const RAW_COLUMNS: ReadonlyArray<readonly [keyof NormalizedPitch, string]> = [
  ["pitch_uid", "VARCHAR"],
  ["source_file", "VARCHAR"],
  ["source_format", "VARCHAR"],
  ["row_idx", "INTEGER"],
  ["game_id", "VARCHAR"],
  ["game_date", "DATE"],
  ["pitch_no", "INTEGER"],
  ["pitcher_name", "VARCHAR"],
  ["pitcher_id", "VARCHAR"],
  ["pitcher_throws", "VARCHAR"],
  ["pitcher_team", "VARCHAR"],
  ["batter_name", "VARCHAR"],
  ["batter_id", "VARCHAR"],
  ["batter_side", "VARCHAR"],
  ["batter_team", "VARCHAR"],
  ["inning", "INTEGER"],
  ["top_bottom", "VARCHAR"],
  ["pa_of_inning", "INTEGER"],
  ["pitch_of_pa", "INTEGER"],
  ["balls", "INTEGER"],
  ["strikes", "INTEGER"],
  ["outs", "INTEGER"],
  ["on_1b", "BOOLEAN"],
  ["on_2b", "BOOLEAN"],
  ["on_3b", "BOOLEAN"],
  ["pitch_type", "VARCHAR"],
  ["pitch_type_raw", "VARCHAR"],
  ["pitch_call", "VARCHAR"],
  ["pitch_call_raw", "VARCHAR"],
  ["event_result", "VARCHAR"],
  ["pa_result_hint", "VARCHAR"],
  ["hit_type", "VARCHAR"],
  ["rel_speed", "DOUBLE"],
  ["spin_rate", "DOUBLE"],
  ["induced_vert_break", "DOUBLE"],
  ["horz_break", "DOUBLE"],
  ["plate_loc_side", "DOUBLE"],
  ["plate_loc_height", "DOUBLE"],
  ["exit_speed", "DOUBLE"],
  ["launch_angle", "DOUBLE"],
  ["distance", "DOUBLE"],
  ["bearing", "DOUBLE"],
  ["video_url", "VARCHAR"],
];

// ---------------------------------------------------------------------------
// Header aliases. Keys are canonical fields; values are header spellings after
// `headerKey()` (lowercase, alphanumerics only). First match wins, so list the
// most specific spelling first.
// ---------------------------------------------------------------------------
type AliasField =
  | "pitch_uid"
  | "game_id"
  | "game_date"
  | "pitch_no"
  | "pitch_time"
  | "pitcher_name"
  | "pitcher_id"
  | "pitcher_throws"
  | "pitcher_team"
  | "batter_name"
  | "batter_id"
  | "batter_side"
  | "batter_team"
  | "home_team"
  | "away_team"
  | "inning"
  | "top_bottom"
  | "pa_of_inning"
  | "pitch_of_pa"
  | "balls"
  | "strikes"
  | "count"
  | "outs"
  | "on_1b"
  | "on_2b"
  | "on_3b"
  | "base_state"
  | "pitch_type_tagged"
  | "pitch_type_auto"
  | "pitch_call"
  | "kor_bb"
  | "play_result"
  | "pa_result"
  | "hit_type"
  | "rel_speed"
  | "spin_rate"
  | "induced_vert_break"
  | "horz_break"
  | "rel_side"
  | "plate_loc_side"
  | "plate_loc_height"
  | "exit_speed"
  | "launch_angle"
  | "distance"
  | "bearing"
  | "video_url";

export const HEADER_ALIASES: Record<AliasField, string[]> = {
  pitch_uid: ["pitchuid", "pitchguid", "pitchid", "pitchkey"],
  game_id: ["gameid", "gameuid", "gamepk", "gamekey", "gameguid", "game"],
  game_date: ["date", "gamedate", "localdate", "utcdate", "gamedatelocal"],
  pitch_no: ["pitchno", "pitchofgame", "gamepitchnumber", "pitchnumber", "pitchnum"],
  pitch_time: ["time", "pitchtime", "localtime", "utctime"],
  pitcher_name: ["pitcher", "pitchername", "pitcherfullname", "pitchernamefull"],
  pitcher_id: ["pitcherid", "pitcherkey", "pitchermlbid", "pitcherplayerid"],
  pitcher_throws: ["pitcherthrows", "pitcherhand", "pitcherhandedness", "throws", "phand", "pthrows", "pitchhand"],
  pitcher_team: ["pitcherteam", "pitchingteam", "pitcherteamabbrev", "pitcherteamcode", "fieldingteam", "defteam"],
  batter_name: ["batter", "battername", "batterfullname", "hitter", "hittername"],
  batter_id: ["batterid", "batterkey", "hitterid", "battermlbid", "batterplayerid"],
  batter_side: ["batterside", "batterhand", "batside", "bats", "bhand", "stand", "hitterside", "batterhandedness"],
  batter_team: ["batterteam", "battingteam", "batterteamabbrev", "batterteamcode", "hitterteam", "offteam"],
  home_team: ["hometeam", "home"],
  away_team: ["awayteam", "away", "visitingteam"],
  inning: ["inning", "inn"],
  top_bottom: ["topbottom", "topbot", "inninghalf", "halfinning", "half", "istop", "topinning"],
  pa_of_inning: ["paofinning", "paininning", "painning", "panumber", "pa", "atbatnumber", "atbatnum", "abnumber", "abnum", "paofgame"],
  pitch_of_pa: ["pitchofpa", "pitchinpa", "pitchnuminpa", "pitchnumberinpa", "papitchnumber", "papitch", "pitchofab", "abpitchnumber"],
  balls: ["balls", "ballsbefore", "prepitchballs", "ballcount"],
  strikes: ["strikes", "strikesbefore", "prepitchstrikes", "strikecount"],
  count: ["count", "countstr", "prepitchcount", "ballsstrikes", "bscount"],
  outs: ["outs", "outsbefore", "prepitchouts", "outcount"],
  on_1b: ["on1b", "runneron1b", "runneron1st", "manon1b", "manonfirst", "runnerfirst", "r1"],
  on_2b: ["on2b", "runneron2b", "runneron2nd", "manon2b", "manonsecond", "runnersecond", "r2"],
  on_3b: ["on3b", "runneron3b", "runneron3rd", "manon3b", "manonthird", "runnerthird", "r3"],
  base_state: ["basestate", "runnerson", "baserunners", "basesoccupied", "runners", "bases", "menon"],
  pitch_type_tagged: ["taggedpitchtype", "pitchtype", "pitchtypeabbrev", "pitchtag", "pitchname", "pitchclass", "pitch"],
  pitch_type_auto: ["autopitchtype", "autopitchclass", "pitchtypeauto", "automatedpitchtype"],
  pitch_call: ["pitchcall", "pitchresult", "pitchoutcome", "pitchdescription", "description", "pitchevent"],
  kor_bb: ["korbb", "kbb"],
  play_result: ["playresult", "bipresult", "inplayresult", "hitresult"],
  pa_result: ["paresult", "atbatresult", "abresult", "event", "events", "outcome", "result", "pAoutcome"],
  hit_type: ["taggedhittype", "hittype", "battedballtype", "bbtype", "autohittype", "batted ball"],
  rel_speed: ["relspeed", "releasespeed", "velocity", "velo", "pitchvelo", "pitchvelocity", "startspeed", "pitchspeed", "speed", "vel"],
  spin_rate: ["spinrate", "releasespinrate", "spin"],
  induced_vert_break: ["inducedvertbreak", "inducedverticalbreak", "ivb", "indvertbrk", "vertbreakinduced", "inducedvb"],
  horz_break: ["horzbreak", "horizontalbreak", "horzbrk", "hb", "hbreak", "horbreak"],
  rel_side: ["relside", "releaseside", "releasex", "relx"],
  plate_loc_side: ["platelocside", "platelocationside", "platex", "locx", "px", "pitchlocx", "horizontallocation", "xloc", "platelocx"],
  plate_loc_height: ["platelocheight", "platelocationheight", "platez", "locz", "pz", "pitchlocz", "verticallocation", "zloc", "platelocz"],
  exit_speed: ["exitspeed", "exitvelo", "exitvelocity", "launchspeed", "hitspeed", "ev"],
  launch_angle: ["angle", "launchangle", "verticallaunchangle", "hitangle", "la"],
  distance: ["distance", "hitdistance", "projdistance", "carrydistance"],
  bearing: ["bearing", "direction", "sprayangle", "spray"],
  video_url: ["videourl", "videolink", "video", "clipurl", "cliplink", "clipid", "videoid"],
};

/** Fields whose presence identifies an export as TrackMan v3. */
const TRACKMAN_MARKERS = ["paofinning", "pitchofpa", "taggedpitchtype", "pitchcall", "platelocside", "korbb"];
const TRUMEDIA_MARKERS = ["pitchresult", "paresult", "platex", "velo", "ivb", "batterhand", "pitcherhand"];

export function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ColumnMapping {
  /** canonical field → original header text */
  mapped: Partial<Record<AliasField, string>>;
  /** original headers that matched nothing */
  unmapped: string[];
  format: SourceFormat;
}

export function detectMapping(headers: string[]): ColumnMapping {
  const byKey = new Map<string, string>();
  for (const h of headers) {
    const k = headerKey(h);
    if (k && !byKey.has(k)) byKey.set(k, h);
  }
  const mapped: Partial<Record<AliasField, string>> = {};
  const used = new Set<string>();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [AliasField, string[]][]) {
    for (const alias of aliases) {
      const k = headerKey(alias);
      if (byKey.has(k) && !used.has(k)) {
        mapped[field] = byKey.get(k)!;
        used.add(k);
        break;
      }
    }
  }
  const unmapped = headers.filter((h) => !used.has(headerKey(h)));
  const keys = new Set(byKey.keys());
  const tm = TRACKMAN_MARKERS.filter((m) => keys.has(m)).length;
  const tru = TRUMEDIA_MARKERS.filter((m) => keys.has(m)).length;
  const format: SourceFormat = tm >= 3 && tm >= tru ? "TrackMan" : tru >= 2 ? "TruMedia" : "Generic";
  return { mapped, unmapped, format };
}

// ---------------------------------------------------------------------------
// Value normalizers
// ---------------------------------------------------------------------------
const NULLISH = new Set(["", "undefined", "null", "na", "n/a", "nan", "none", "-", "--"]);

export function clean(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return NULLISH.has(s.toLowerCase()) ? null : s;
}

export function num(raw: unknown): number | null {
  const s = clean(raw);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function int(raw: unknown): number | null {
  const n = num(raw);
  return n === null ? null : Math.round(n);
}

export function normalizeHand(raw: unknown): Hand | "S" | null {
  const s = clean(raw);
  if (!s) return null;
  const c = s.toUpperCase();
  if (c.startsWith("L")) return "L";
  if (c.startsWith("R")) return "R";
  if (c.startsWith("S") || c.startsWith("B")) return "S"; // switch / both
  return null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Accepts ISO, M/D/YYYY, M/D/YY, M-D-YYYY, "Mar 3, 2026", and ISO timestamps. Returns YYYY-MM-DD or null. */
export function normalizeDate(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return `${y}-${pad(+m[1])}-${pad(+m[2])}`;
  }
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(+m[2])}`;
  return null;
}

/** "Last, First" stays; "First Last" → "Last, First" so TrackMan and TruMedia spellings of one hitter merge. */
export function normalizePersonName(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  const collapsed = s.replace(/\s+/g, " ");
  if (collapsed.includes(",")) {
    const [last, ...rest] = collapsed.split(",");
    const first = rest.join(",").trim();
    return first ? `${last.trim()}, ${first}` : last.trim();
  }
  const parts = collapsed.split(" ");
  if (parts.length < 2) return collapsed;
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
  let lastIdx = parts.length - 1;
  if (suffixes.has(parts[lastIdx].toLowerCase()) && parts.length > 2) lastIdx -= 1;
  const first = parts.slice(0, lastIdx).join(" ");
  const last = parts.slice(lastIdx).join(" ");
  return `${last}, ${first}`;
}

const PITCH_TYPE_MAP: Record<string, NormalizedPitchType> = {
  // 4-seam
  ff: "FF", fa: "FF", fastball: "FF", fourseam: "FF", fourseamfastball: "FF", "4seam": "FF", "4seamfastball": "FF", fourseamer: "FF",
  // sinker / 2-seam
  si: "SI", ft: "SI", sinker: "SI", twoseam: "SI", twoseamfastball: "SI", "2seam": "SI", "2seamfastball": "SI",
  // cutter
  fc: "FC", ct: "FC", cutter: "FC", cutfastball: "FC",
  // slider family
  sl: "SL", slider: "SL", sv: "SL", slurve: "SL", gyro: "SL",
  st: "ST", sweeper: "ST", sw: "ST",
  // curve family
  cu: "CU", cb: "CU", curve: "CU", curveball: "CU", kc: "CU", knucklecurve: "CU", cs: "CU", slowcurve: "CU",
  // offspeed
  ch: "CH", changeup: "CH", change: "CH", circlechange: "CH", sc: "CH", screwball: "CH",
  fs: "FS", splitter: "FS", splitfinger: "FS", fo: "FS", forkball: "FS",
  kn: "KN", knuckleball: "KN",
  // explicit "other"
  ot: "OT", other: "OT", ep: "OT", eephus: "OT", po: "OT", pitchout: "OT",
};

export function normalizePitchType(raw: unknown): NormalizedPitchType | null {
  const s = clean(raw);
  if (!s) return null;
  const k = headerKey(s);
  if (!k || k === "undefined") return null;
  return PITCH_TYPE_MAP[k] ?? "OT";
}

const PITCH_CALL_MAP: Record<string, NormalizedPitchCall> = {
  ballcalled: "BallCalled", ball: "BallCalled", ballindirt: "BallCalled", ballinthedirt: "BallCalled", ballintentional: "BallCalled",
  intentionalball: "BallCalled", automaticball: "BallCalled", blockedball: "BallCalled", pitchout: "BallCalled", balls: "BallCalled",
  strikecalled: "StrikeCalled", calledstrike: "StrikeCalled", automaticstrike: "StrikeCalled", strikelooking: "StrikeCalled", lookingstrike: "StrikeCalled",
  strikeswinging: "StrikeSwinging", swingingstrike: "StrikeSwinging", swingingstrikeblocked: "StrikeSwinging", whiff: "StrikeSwinging",
  swingandmiss: "StrikeSwinging", swingmiss: "StrikeSwinging", missedbunt: "StrikeSwinging", strikeswing: "StrikeSwinging",
  foulball: "FoulBall", foul: "FoulBall", foulballfieldable: "FoulBall", foulballnotfieldable: "FoulBall", foultip: "FoulBall",
  foulbunt: "FoulBall", foulpitchout: "FoulBall",
  inplay: "InPlay", hitintoplay: "InPlay", inplayout: "InPlay", inplayouts: "InPlay", inplaynoout: "InPlay", inplayruns: "InPlay",
  ballinplay: "InPlay", bip: "InPlay",
  hitbypitch: "HitByPitch", hbp: "HitByPitch",
};

export function normalizePitchCall(raw: unknown): NormalizedPitchCall {
  const s = clean(raw);
  if (!s) return "Unknown";
  const k = headerKey(s);
  if (PITCH_CALL_MAP[k]) return PITCH_CALL_MAP[k];
  if (k.includes("foul")) return "FoulBall";
  if (k.includes("swing") || k.includes("whiff") || k.includes("miss")) return "StrikeSwinging";
  if (k.includes("inplay") || k.includes("play")) return "InPlay";
  if (k.includes("hitby")) return "HitByPitch";
  if (k.includes("called") || k.includes("looking")) return "StrikeCalled";
  if (k.includes("ball")) return "BallCalled";
  return "Unknown";
}

/** Normalizes any result spelling (TrackMan PlayResult/KorBB or a TruMedia event) to the spec's play_result vocabulary. */
export function normalizeResult(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  const k = headerKey(s);
  if (!k || k === "undefined") return null;
  if (k.startsWith("strikeout") || k === "k" || k === "so" || k === "kl" || k === "ks") return "Strikeout";
  if (k.includes("intentwalk") || k.includes("intentionalwalk") || k === "ibb" || k === "walk" || k === "bb" || k.includes("baseonballs"))
    return "Walk";
  if (k.includes("hitbypitch") || k === "hbp") return "HitByPitch";
  if (k.includes("homerun") || k === "hr") return "HomeRun";
  if (k.includes("triple") && !k.includes("play")) return "Triple";
  if (k.includes("double") && !k.includes("play")) return "Double";
  if (k.includes("single")) return "Single";
  if (k.includes("sac")) return "Sacrifice";
  if (k.includes("fielderschoice") || k === "fc") return "FieldersChoice";
  if (k.includes("error")) return "Error";
  if (k.includes("interference")) return "Other";
  if (k.includes("out") || k.includes("doubleplay") || k.includes("tripleplay") || k === "dp" || k === "gidp") return "Out";
  return null;
}

function normalizeTopBottom(raw: unknown): "Top" | "Bottom" | null {
  const s = clean(raw);
  if (!s) return null;
  const k = headerKey(s);
  if (k.startsWith("t") || k === "1" || k === "true" || k === "away") return "Top";
  if (k.startsWith("b") || k === "0" || k === "false" || k === "home") return "Bottom";
  return null;
}

function normalizeBool(raw: unknown): boolean | null {
  const s = clean(raw);
  if (s === null) return null;
  const k = s.toLowerCase();
  if (["1", "true", "t", "yes", "y", "x"].includes(k)) return true;
  if (["0", "false", "f", "no", "n"].includes(k)) return false;
  // A runner name/ID in the cell means occupied.
  return true;
}

/** Parses "1-3", "1B 3B", "_2_", "Empty", "Loaded", "RISP", "13" into three occupancy flags. */
export function parseBaseState(raw: unknown): [boolean, boolean, boolean] | null {
  const s = clean(raw);
  if (s === null) return null;
  const k = s.toLowerCase();
  if (k.includes("empty") || k === "0" || k === "---" || k === "___") return [false, false, false];
  if (k.includes("loaded")) return [true, true, true];
  const digits = new Set(k.replace(/[^123]/g, "").split(""));
  if (digits.size === 0) return null;
  return [digits.has("1"), digits.has("2"), digits.has("3")];
}

// ---------------------------------------------------------------------------
// File mapping
// ---------------------------------------------------------------------------
export interface MapFileOptions {
  fileName: string;
  /** Default `"ALA_CRI"`; rows whose batter team is known and differs are still mapped (team filtering is a UI choice). */
  ourTeamCode?: string;
}

export interface MapFileResult {
  rows: NormalizedPitch[];
  mapping: ColumnMapping;
  skipped: number;
  skipReasons: Record<string, number>;
  /** "flip" when PlateLocSide was positive toward 3B and got sign-flipped into catcher's view. */
  sideConvention: "as-is" | "flipped" | "assumed-flipped";
  units: "feet" | "inches";
}

/**
 * TrackMan Batter/Pitcher names are "Last, First"; any row whose batter name
 * lacks letters on both sides of a comma (or a two-part "First Last") is a
 * header/title row a coach left in a hand-edited export, not a pitch.
 */
function looksLikePersonName(raw: string | null): boolean {
  if (!raw) return false;
  if (raw.includes(",")) {
    const [last, first] = raw.split(",");
    return /[a-z]/i.test(last ?? "") && /[a-z]/i.test(first ?? "");
  }
  return /[a-z]/i.test(raw) && raw.trim().split(/\s+/).length >= 2;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Maps one parsed CSV (array of header→value records) to NormalizedPitch rows.
 * Handles missing PA/pitch counters by walking rows in order.
 */
export function mapFile(records: Record<string, string>[], headers: string[], opts: MapFileOptions): MapFileResult {
  const mapping = detectMapping(headers);
  const m = mapping.mapped;
  const get = (rec: Record<string, string>, f: AliasField): string | undefined => (m[f] ? rec[m[f]!] : undefined);

  // --- Location units & horizontal sign convention (per file) ---
  const sides = records.map((r) => num(get(r, "plate_loc_side"))).filter((v): v is number => v !== null);
  const heights = records.map((r) => num(get(r, "plate_loc_height"))).filter((v): v is number => v !== null);
  const heightMed = median(heights);
  const sideAbsMed = median(sides.map(Math.abs));
  const inches = (heightMed !== null && heightMed > 10) || (sideAbsMed !== null && sideAbsMed > 4);
  const unit = inches ? 1 / 12 : 1;

  let sideConvention: MapFileResult["sideConvention"] = "assumed-flipped";
  if (m.rel_side && m.pitcher_throws) {
    const rhpRel = records
      .filter((r) => normalizeHand(get(r, "pitcher_throws")) === "R")
      .map((r) => num(get(r, "rel_side")))
      .filter((v): v is number => v !== null);
    if (rhpRel.length >= 10) {
      const mean = rhpRel.reduce((a, b) => a + b, 0) / rhpRel.length;
      // A RHP releases on the 3B side. Positive mean ⇒ + is the 3B side ⇒ flip into catcher's view (+ = 1B side).
      sideConvention = mean > 0 ? "flipped" : "as-is";
    }
  } else if (mapping.format !== "TrackMan") {
    // TruMedia/Statcast-style exports use plate_x in catcher's view already.
    sideConvention = "as-is";
  }
  const sideSign = sideConvention === "as-is" ? 1 : -1;

  const rows: NormalizedPitch[] = [];
  const skipReasons: Record<string, number> = {};
  const skip = (reason: string) => (skipReasons[reason] = (skipReasons[reason] ?? 0) + 1);

  // State for deriving PA / pitch counters when an export omits them.
  const needPa = !m.pa_of_inning;
  const needPitchOfPa = !m.pitch_of_pa;
  let lastHalfKey = "";
  let paCounter = 0;
  let pitchCounter = 0;
  let lastBatter: string | null = null;
  let lastWasTerminal = false;

  records.forEach((rec, idx) => {
    const batterName = normalizePersonName(get(rec, "batter_name"));
    if (!looksLikePersonName(batterName)) return skip("missing/invalid batter name");
    const callRaw = clean(get(rec, "pitch_call"));
    const pitchCall = normalizePitchCall(callRaw);
    if (pitchCall === "Unknown" && !callRaw) return skip("missing pitch call");

    const gameDate = normalizeDate(get(rec, "game_date"));
    const pitcherTeam = clean(get(rec, "pitcher_team"));
    const batterTeam = clean(get(rec, "batter_team"));
    const homeTeam = clean(get(rec, "home_team"));
    const awayTeam = clean(get(rec, "away_team"));
    const teams = [homeTeam ?? pitcherTeam, awayTeam ?? batterTeam].filter(Boolean).sort().join("v");
    const gameId = clean(get(rec, "game_id")) ?? `${gameDate ?? "nodate"}_${teams || opts.fileName}`;

    let topBottom = normalizeTopBottom(get(rec, "top_bottom"));
    if (!topBottom && batterTeam && homeTeam) topBottom = batterTeam === homeTeam ? "Bottom" : "Top";
    const inning = int(get(rec, "inning"));

    let balls = int(get(rec, "balls"));
    let strikes = int(get(rec, "strikes"));
    if ((balls === null || strikes === null) && m.count) {
      const c = clean(get(rec, "count"))?.match(/(\d)\s*[-–]\s*(\d)/);
      if (c) {
        balls = +c[1];
        strikes = +c[2];
      }
    }

    // Derive PA/pitch counters if missing. A new PA starts when the half
    // inning changes, the batter changes, or the count resets to 0-0 (a PA
    // never returns to 0-0 after its first pitch). Result columns are only a
    // fallback because some exports repeat the PA result on every pitch.
    const halfKey = `${gameId}|${inning}|${topBottom}`;
    const halfChanged = halfKey !== lastHalfKey;
    if (halfChanged) {
      paCounter = 0;
      lastHalfKey = halfKey;
    }
    const countReset = balls === 0 && strikes === 0 && pitchCounter > 0;
    const newPa = halfChanged || batterName !== lastBatter || countReset || (balls === null && lastWasTerminal);
    if (newPa) {
      paCounter += 1;
      pitchCounter = 0;
    }
    pitchCounter += 1;
    lastBatter = batterName;

    const korbb = normalizeResult(get(rec, "kor_bb"));
    const playRes = normalizeResult(get(rec, "play_result"));
    const paHint = normalizeResult(get(rec, "pa_result"));
    let eventResult: string | null = null;
    if (pitchCall === "InPlay") eventResult = playRes ?? (paHint && !["Strikeout", "Walk", "HitByPitch"].includes(paHint) ? paHint : "Out");
    else if (korbb === "Strikeout" || korbb === "Walk") eventResult = korbb;
    else if (pitchCall === "HitByPitch") eventResult = "HitByPitch";
    lastWasTerminal = eventResult !== null;

    const pitcherHand = normalizeHand(get(rec, "pitcher_throws"));
    let batterSide = normalizeHand(get(rec, "batter_side"));
    if (batterSide === "S") batterSide = pitcherHand === "L" ? "R" : pitcherHand === "R" ? "L" : null;

    const taggedRaw = clean(get(rec, "pitch_type_tagged"));
    const autoRaw = clean(get(rec, "pitch_type_auto"));
    const pitchType = normalizePitchType(taggedRaw) ?? normalizePitchType(autoRaw);

    let on1: boolean | null = normalizeBool(get(rec, "on_1b"));
    let on2: boolean | null = normalizeBool(get(rec, "on_2b"));
    let on3: boolean | null = normalizeBool(get(rec, "on_3b"));
    if (!m.on_1b && !m.on_2b && !m.on_3b && m.base_state) {
      const bs = parseBaseState(get(rec, "base_state"));
      if (bs) [on1, on2, on3] = bs;
    } else if (m.on_1b || m.on_2b || m.on_3b) {
      on1 = on1 ?? false;
      on2 = on2 ?? false;
      on3 = on3 ?? false;
    }

    const side = num(get(rec, "plate_loc_side"));
    const height = num(get(rec, "plate_loc_height"));
    const paOfInning = needPa ? paCounter : int(get(rec, "pa_of_inning"));
    const pitchOfPa = needPitchOfPa ? pitchCounter : int(get(rec, "pitch_of_pa"));
    const uid =
      clean(get(rec, "pitch_uid")) ??
      [gameId, inning, topBottom, paOfInning, pitchOfPa, batterName, clean(get(rec, "pitch_no")) ?? ""].join("|");

    rows.push({
      pitch_uid: uid,
      source_file: opts.fileName,
      source_format: mapping.format,
      row_idx: idx,
      game_id: gameId,
      game_date: gameDate,
      pitch_no: int(get(rec, "pitch_no")),
      pitcher_name: normalizePersonName(get(rec, "pitcher_name")),
      pitcher_id: clean(get(rec, "pitcher_id")),
      pitcher_throws: pitcherHand === "S" ? null : pitcherHand,
      pitcher_team: pitcherTeam,
      batter_name: batterName,
      batter_id: clean(get(rec, "batter_id")),
      batter_side: batterSide,
      batter_team: batterTeam,
      inning,
      top_bottom: topBottom,
      pa_of_inning: paOfInning,
      pitch_of_pa: pitchOfPa,
      balls: balls !== null && balls >= 0 && balls <= 3 ? balls : null,
      strikes: strikes !== null && strikes >= 0 && strikes <= 2 ? strikes : null,
      outs: int(get(rec, "outs")),
      on_1b: on1,
      on_2b: on2,
      on_3b: on3,
      pitch_type: pitchType,
      pitch_type_raw: taggedRaw ?? autoRaw,
      pitch_call: pitchCall,
      pitch_call_raw: callRaw,
      event_result: eventResult,
      pa_result_hint: paHint,
      hit_type: clean(get(rec, "hit_type")),
      rel_speed: num(get(rec, "rel_speed")),
      spin_rate: num(get(rec, "spin_rate")),
      induced_vert_break: num(get(rec, "induced_vert_break")),
      horz_break: num(get(rec, "horz_break")),
      plate_loc_side: side === null ? null : round3(side * unit * sideSign),
      plate_loc_height: height === null ? null : round3(height * unit),
      exit_speed: num(get(rec, "exit_speed")),
      launch_angle: num(get(rec, "launch_angle")),
      distance: num(get(rec, "distance")),
      bearing: num(get(rec, "bearing")),
      video_url: clean(get(rec, "video_url")),
    });
  });

  return {
    rows,
    mapping,
    skipped: Object.values(skipReasons).reduce((a, b) => a + b, 0),
    skipReasons,
    sideConvention,
    units: inches ? "inches" : "feet",
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Human-readable label for a canonical field (used in the schema-mapping modal). */
export const FIELD_LABELS: Partial<Record<AliasField, string>> = {
  game_id: "Game ID",
  game_date: "Date",
  pitcher_name: "Pitcher",
  pitcher_throws: "Pitcher Hand",
  batter_name: "Batter",
  batter_side: "Batter Side",
  batter_team: "Batter Team",
  inning: "Inning",
  top_bottom: "Top/Bottom",
  pa_of_inning: "PA of Inning",
  pitch_of_pa: "Pitch of PA",
  balls: "Balls",
  strikes: "Strikes",
  outs: "Outs",
  pitch_type_tagged: "Pitch Type (tagged)",
  pitch_type_auto: "Pitch Type (auto)",
  pitch_call: "Pitch Call",
  play_result: "Play Result",
  kor_bb: "K or BB",
  rel_speed: "Velocity",
  induced_vert_break: "IVB",
  horz_break: "Horz Break",
  plate_loc_side: "Plate Loc Side",
  plate_loc_height: "Plate Loc Height",
  exit_speed: "Exit Velo",
  launch_angle: "Launch Angle",
  video_url: "Video",
  base_state: "Base State",
};

export const REQUIRED_FIELDS: AliasField[] = ["batter_name", "pitch_call"];
export const KEY_FIELDS: AliasField[] = [
  "game_date",
  "pitcher_throws",
  "batter_side",
  "inning",
  "pa_of_inning",
  "pitch_of_pa",
  "balls",
  "strikes",
  "pitch_type_tagged",
  "plate_loc_side",
  "plate_loc_height",
  "rel_speed",
];
