import { sqlStr } from "@/lib/metrics";

export const OUR_TEAM_CODE = "ALA_CRI";

export interface GlobalFilters {
  /** Team code to restrict batters to, or "ALL" for every batter in the files. */
  team: string;
  pitcherHand: "ALL" | "R" | "L";
  dateFrom: string | null;
  dateTo: string | null;
  /** Minimum denominator before a rate is shown/considered (Feature A "Min N Pitches"). */
  minN: number;
}

export const DEFAULT_FILTERS: GlobalFilters = {
  team: OUR_TEAM_CODE,
  pitcherHand: "ALL",
  dateFrom: null,
  dateTo: null,
  minN: 5,
};

/** WHERE clause (without the WHERE keyword) for the global filter bar, optionally narrowed to one hitter. */
export function buildWhere(f: GlobalFilters, hitter?: string | null): string {
  const parts: string[] = ["TRUE"];
  if (f.team !== "ALL") parts.push(`batter_team = ${sqlStr(f.team)}`);
  if (f.pitcherHand !== "ALL") parts.push(`pitcher_throws = ${sqlStr(f.pitcherHand)}`);
  if (f.dateFrom) parts.push(`game_date >= DATE ${sqlStr(f.dateFrom)}`);
  if (f.dateTo) parts.push(`game_date <= DATE ${sqlStr(f.dateTo)}`);
  if (hitter) parts.push(`batter_name = ${sqlStr(hitter)}`);
  return parts.join(" AND ");
}

export function describeFilters(f: GlobalFilters): string {
  const bits: string[] = [];
  bits.push(f.team === "ALL" ? "All batters" : f.team === OUR_TEAM_CODE ? "Alabama hitters" : f.team);
  if (f.pitcherHand !== "ALL") bits.push(`vs ${f.pitcherHand}HP`);
  if (f.dateFrom || f.dateTo) bits.push(`${f.dateFrom ?? "start"} → ${f.dateTo ?? "end"}`);
  bits.push(`min ${f.minN}`);
  return bits.join(" · ");
}
