/**
 * Demo dataset generator — "Demo Alabama Hitter Dataset".
 *
 * Simulates a 40-game season pitch by pitch (lineups, innings, outs, base
 * runners, opposing pitchers with real arsenals, count-aware pitch selection
 * and location) and writes it out as real-looking CSV exports:
 *   - 3 TrackMan v3 files (both teams, PlateLocSide/RelSide + toward 3B, like
 *     Alabama's real exports)
 *   - 1 TruMedia-style file (Alabama hitters only, "First Last" names, no
 *     PA/pitch counters, runner data) — exercises the schema mapper.
 *
 * All names are fictional. Seeded, so every load produces identical data.
 *
 * PLANTED TENDENCIES (what the Auto-Scout should surface):
 *   Tidwell, Jace  — takes breaking balls in 2-0/3-1/1-0 (~90%); freezes on
 *                    first-pitch Heart fastballs (~80% take); freezes on
 *                    2-strike in-zone breaking balls → looking Ks.
 *   Mercer, Cole   — chases 0-2/1-2 SL/ST down-and-away ~65% ONLY after an
 *                    elevated FF (~20% otherwise).
 *   Ruffin, Dax    — ambushes first-pitch fastballs (~80% swing, even off the
 *                    plate); whiffs on CH/FS ≥ 8 mph slower than the prior FB.
 *   Okafor, Miles  — 2-strike foul machine, but freezes on 2-strike curveballs
 *                    in the zone; chases LHP breaking balls.
 *   Bledsoe, Tanner— green light 3-0/3-1; chases far more right after a whiff.
 *   Vance, Eli     — switch hitter; almost never swings at pitch 1; whiffs on
 *                    soft stuff after two straight fastballs (HHS).
 *   Castillo / Pruitt / Hargrove / Lyle — near-baseline controls (Pruitt
 *                    chases elevated 2-strike fastballs).
 */

import type { Hand } from "@/lib/schema-mapper";

export const DEMO_TEAM_CODE = "ALA_CRI";

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  u(): number {
    return this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  normal(mean = 0, sd = 1): number {
    const u1 = Math.max(this.next(), 1e-9);
    const u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  weighted<T extends string>(weights: Partial<Record<T, number>>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[entries.length - 1][0];
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------
type PT = "FF" | "SI" | "FC" | "SL" | "ST" | "CU" | "CH" | "FS";
type Group = "Fastball" | "Breaking" | "Offspeed";
type AttackZone = "Heart" | "Shadow" | "Chase" | "Waste";
type Call = "BallCalled" | "StrikeCalled" | "StrikeSwinging" | "FoulBall" | "InPlay" | "HitByPitch";

const GROUP: Record<PT, Group> = { FF: "Fastball", SI: "Fastball", FC: "Fastball", SL: "Breaking", ST: "Breaking", CU: "Breaking", CH: "Offspeed", FS: "Offspeed" };
const TRACKMAN_NAME: Record<PT, string> = { FF: "Fastball", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper", CU: "Curveball", CH: "ChangeUp", FS: "Splitter" };
const VELO_OFFSET: Record<PT, number> = { FF: 0, SI: -1.2, FC: -4.5, SL: -9, ST: -12, CU: -14, CH: -8.5, FS: -7.5 };
const IVB: Record<PT, [number, number]> = { FF: [16, 2.5], SI: [7, 2.5], FC: [9, 2.5], SL: [2, 3], ST: [0, 3], CU: [-10, 3], CH: [6, 3], FS: [3, 3] };
const HB_ARM: Record<PT, [number, number]> = { FF: [8, 3], SI: [15, 3], FC: [-2, 2], SL: [-5, 3], ST: [-14, 3], CU: [-8, 3], CH: [14, 3], FS: [10, 3] };
const SPIN: Record<PT, number> = { FF: 2250, SI: 2150, FC: 2350, SL: 2400, ST: 2550, CU: 2500, CH: 1750, FS: 1450 };

interface Pitcher {
  name: string;
  id: string;
  throws: Hand;
  velo: number;
  arsenal: Partial<Record<PT, number>>;
  team: string;
}

interface PitchCtx {
  balls: number;
  strikes: number;
  count: string;
  pitchType: PT;
  group: Group;
  zone: AttackZone;
  inZone: boolean;
  locV: "Up" | "Middle" | "Down";
  locH: "In" | "Middle" | "Away";
  velo: number;
  pitcherHand: Hand;
  firstPitch: boolean;
  prev?: { pitchType: PT; group: Group; locV: string; locH: string; isSwing: boolean; isWhiff: boolean; velo: number };
  prev2?: { group: Group };
}

interface HitterProfile {
  name: string; // "Last, First"
  id: string;
  bats: Hand | "S";
  power: number; // EV adjustment
  contact: number; // whiff multiplier (<1 = better contact)
  swing?: (p: number, c: PitchCtx) => number;
  whiff?: (p: number, c: PitchCtx) => number;
  foul?: (p: number, c: PitchCtx) => number;
}

const isHard = (g: Group) => g === "Fastball";

const ALABAMA: HitterProfile[] = [
  {
    name: "Tidwell, Jace",
    id: "1001",
    bats: "R",
    power: 1,
    contact: 0.95,
    swing: (p, c) => {
      if (c.group === "Breaking" && ["2-0", "3-1", "1-0", "2-1"].includes(c.count)) return p * 0.1;
      if (c.firstPitch && c.group === "Fastball" && c.zone === "Heart") return 0.2;
      if (c.strikes === 2 && c.group === "Breaking" && c.inZone) return p * 0.4;
      return p;
    },
  },
  {
    name: "Mercer, Cole",
    id: "1002",
    bats: "L",
    power: 3,
    contact: 0.9,
    swing: (p, c) => {
      const putaway = c.count === "0-2" || c.count === "1-2";
      const slider = c.pitchType === "SL" || c.pitchType === "ST";
      const downAway = c.locV === "Down" && c.locH === "Away" && !c.inZone;
      if (putaway && slider && downAway) {
        const afterElevatedFF = c.prev?.pitchType === "FF" && c.prev.locV === "Up";
        return afterElevatedFF ? 0.66 : 0.2;
      }
      return p;
    },
    whiff: (p, c) => (c.group === "Fastball" ? p * 0.75 : p),
  },
  {
    name: "Ruffin, Dax",
    id: "1003",
    bats: "R",
    power: 5,
    contact: 1.1,
    swing: (p, c) => {
      if (c.firstPitch && c.group === "Fastball") return c.zone === "Waste" ? 0.25 : c.inZone ? 0.85 : 0.55;
      return p;
    },
    whiff: (p, c) => {
      if (c.group === "Offspeed" && c.prev?.group === "Fastball" && c.velo - c.prev.velo <= -8) return 0.62;
      return p;
    },
  },
  {
    name: "Okafor, Miles",
    id: "1004",
    bats: "L",
    power: 0,
    contact: 0.8,
    swing: (p, c) => {
      if (c.strikes === 2 && c.pitchType === "CU" && c.inZone) return 0.25;
      if (c.pitcherHand === "L" && c.group === "Breaking" && !c.inZone) return Math.min(0.9, p * 1.8);
      return p;
    },
    whiff: (p, c) => (c.strikes === 2 ? p * 0.55 : p),
    foul: (p, c) => (c.strikes === 2 ? Math.min(0.85, p + 0.22) : p),
  },
  {
    name: "Bledsoe, Tanner",
    id: "1005",
    bats: "R",
    power: 4,
    contact: 1.15,
    swing: (p, c) => {
      if (c.count === "3-0" && c.group === "Fastball") return c.zone === "Waste" ? 0.15 : 0.62;
      if (c.count === "3-1") return c.zone === "Waste" ? 0.3 : 0.9;
      if (c.prev?.isWhiff && !c.inZone) return Math.min(0.85, p * 2.2);
      return p;
    },
  },
  {
    name: "Vance, Eli",
    id: "1006",
    bats: "S",
    power: -1,
    contact: 0.92,
    swing: (p, c) => (c.firstPitch ? 0.05 : p),
    whiff: (p, c) => {
      if (!isHard(c.group) && c.prev && isHard(c.prev.group) && c.prev2 && isHard(c.prev2.group)) return Math.min(0.8, p * 2.3);
      return p;
    },
  },
  { name: "Castillo, Ramon", id: "1007", bats: "R", power: 2, contact: 1 },
  {
    name: "Pruitt, Wade",
    id: "1008",
    bats: "L",
    power: 1,
    contact: 1,
    swing: (p, c) => (c.strikes === 2 && c.group === "Fastball" && c.locV === "Up" && !c.inZone ? 0.6 : p),
  },
  { name: "Hargrove, Nate", id: "1009", bats: "R", power: 0, contact: 1.05 },
  { name: "Lyle, Brooks", id: "1010", bats: "L", power: -1, contact: 1 },
];

const OPP_TEAMS = ["AUB_TIG", "LSU_TIG", "OLE_REB", "MSU_BDG", "UGA_BUL", "TEN_VOL", "ARK_RAZ", "FLA_GAT", "SAM_BUL", "TRO_TRO"];
const FIRST = ["Austin", "Blake", "Carter", "Drew", "Evan", "Grant", "Hunter", "Jake", "Kyle", "Logan", "Mason", "Noah", "Owen", "Parker", "Reid", "Sam", "Trey", "Wyatt", "Zane", "Brady", "Colt", "Dylan", "Gage", "Jett"];
const LAST = ["Abbott", "Barlow", "Crane", "Dalton", "Easley", "Fowler", "Gentry", "Holt", "Ingram", "Jessup", "Keller", "Lowry", "Maddox", "Nolan", "Oakley", "Pope", "Quarles", "Rhodes", "Sutton", "Tate", "Upton", "Voss", "Whitley", "Yates"];

function makePitcher(rng: Rng, team: string, idx: number, role: "SP" | "RP"): Pitcher {
  const throws: Hand = rng.chance(0.7) ? "R" : "L";
  const fb: PT = rng.chance(0.75) ? "FF" : "SI";
  const breaking: PT = rng.weighted<PT>({ SL: 0.5, ST: 0.2, CU: 0.3 });
  const second: PT | null = rng.chance(0.45) ? (breaking === "CU" ? "SL" : "CU") : null;
  const off: PT = rng.chance(0.8) ? "CH" : "FS";
  const arsenal: Partial<Record<PT, number>> = { [fb]: 1 };
  if (rng.chance(0.25)) arsenal.FC = 0.3;
  arsenal[breaking] = 1;
  if (second) arsenal[second] = 0.5;
  arsenal[off] = role === "SP" ? 0.9 : 0.6;
  return {
    name: `${rng.pick(LAST)}, ${rng.pick(FIRST)}`,
    id: `${team}-${idx}`,
    throws,
    velo: rng.normal(role === "SP" ? 89.5 : 91, 2),
    arsenal,
    team,
  };
}

function makeOppHitter(rng: Rng, team: string, i: number): HitterProfile {
  return { name: `${rng.pick(LAST)}, ${rng.pick(FIRST)}`, id: `${team}-H${i}`, bats: rng.chance(0.62) ? "R" : rng.chance(0.85) ? "L" : "S", power: rng.normal(0, 2), contact: rng.normal(1, 0.08) };
}

// ---------------------------------------------------------------------------
// Pitch selection & location
// ---------------------------------------------------------------------------
function choosePitch(rng: Rng, p: Pitcher, balls: number, strikes: number, prev?: PitchCtx["prev"]): PT {
  const ahead = strikes > balls;
  const behind = balls > strikes;
  const gw: Record<Group, number> = ahead
    ? { Fastball: 0.4, Breaking: 0.42, Offspeed: 0.18 }
    : behind
      ? { Fastball: 0.64, Breaking: 0.24, Offspeed: 0.12 }
      : { Fastball: 0.55, Breaking: 0.29, Offspeed: 0.16 };
  // Real sequencing: tunnel a putaway breaking ball off an elevated heater,
  // and pull the string (changeup/splitter) after a fastball.
  if (prev?.group === "Fastball") {
    gw.Offspeed *= 1.8;
    if (strikes === 2 && prev.locV === "Up") gw.Breaking *= 3;
  }
  const weights: Partial<Record<PT, number>> = {};
  for (const [pt, w] of Object.entries(p.arsenal) as [PT, number][]) weights[pt] = w * gw[GROUP[pt]];
  return rng.weighted(weights);
}

/** Returns location in catcher's view (+ = 1B side) given intent relative to the batter. */
function chooseLocation(rng: Rng, pt: PT, balls: number, strikes: number, batterSide: Hand, prev?: PitchCtx["prev"]): { side: number; height: number } {
  const g = GROUP[pt];
  const ahead = strikes > balls;
  let inside: number; // + = inside to the batter
  let height: number;
  if (g === "Fastball") {
    const r = rng.u();
    if (strikes === 2 && r < 0.5) {
      height = rng.normal(3.75, 0.3);
      inside = rng.normal(0.15, 0.55);
    } else if (ahead && r < 0.6) {
      height = rng.normal(3.3, 0.38);
      inside = rng.normal(0.1, 0.6);
    } else {
      height = rng.normal(2.5, 0.72);
      inside = rng.normal(rng.chance(0.5) ? 0.55 : -0.55, 0.55);
    }
  } else if (g === "Breaking") {
    const getMeOver = ["2-0", "3-1", "1-0", "2-1", "3-0"].includes(`${balls}-${strikes}`) ? 0.55 : strikes === 2 ? 0.12 : 0.25;
    const tunnelOffHeater = strikes === 2 && prev?.group === "Fastball" && prev.locV === "Up";
    const r = tunnelOffHeater ? 0.99 : rng.u();
    if (r < getMeOver) {
      height = rng.normal(2.35, 0.38);
      inside = rng.normal(-0.15, 0.38);
    } else if (r < getMeOver + 0.22) {
      height = rng.normal(2.05, 0.3); // backdoor / edge strike
      inside = rng.normal(-0.6, 0.22);
    } else {
      height = rng.normal(1.15, 0.38); // down and away
      inside = rng.normal(-0.95, 0.4);
    }
  } else {
    height = rng.normal(strikes === 2 ? 1.25 : 1.55, 0.45);
    inside = rng.normal(-0.4, 0.5);
  }
  const side = inside * (batterSide === "R" ? -1 : 1);
  return { side: Math.round(side * 1000) / 1000, height: Math.round(Math.max(0.2, height) * 1000) / 1000 };
}

function classify(side: number, height: number, batterSide: Hand) {
  const inZone = Math.abs(side) <= 0.83 && height >= 1.5 && height <= 3.5;
  const d = Math.max(Math.abs(side) / 0.83, Math.abs(height - 2.5) / 1.0);
  const zone: AttackZone = d <= 0.67 ? "Heart" : d <= 1.33 ? "Shadow" : d <= 2 ? "Chase" : "Waste";
  const locV = height >= 2.8333 ? "Up" : height <= 2.1667 ? "Down" : "Middle";
  const inside = side * (batterSide === "R" ? -1 : 1);
  const locH = inside >= 0.2767 ? "In" : inside <= -0.2767 ? "Away" : "Middle";
  return { inZone, zone, locV, locH, inside } as const;
}

// ---------------------------------------------------------------------------
// Hitter decision model
// ---------------------------------------------------------------------------
const clamp = (v: number, lo = 0.01, hi = 0.97) => Math.max(lo, Math.min(hi, v));

function swingProb(h: HitterProfile, c: PitchCtx): number {
  let p = c.zone === "Shadow" ? (c.inZone ? 0.6 : 0.33) : { Heart: 0.74, Shadow: 0, Chase: 0.2, Waste: 0.05 }[c.zone];
  if (c.count === "0-0") p *= 0.55;
  else if (c.count === "3-0") p *= 0.12;
  else if (c.strikes === 2) p *= c.zone === "Shadow" ? (c.inZone ? 1.48 : 1.35) : { Heart: 1.24, Shadow: 1, Chase: 1.28, Waste: 1.2 }[c.zone];
  if (c.group === "Breaking" && c.inZone) p *= 0.88;
  if (h.swing) p = h.swing(p, c);
  return clamp(p);
}

function whiffProb(h: HitterProfile, c: PitchCtx): number {
  const table: Record<Group, Record<AttackZone, number>> = {
    Fastball: { Heart: 0.09, Shadow: 0.17, Chase: 0.32, Waste: 0.5 },
    Breaking: { Heart: 0.19, Shadow: 0.3, Chase: 0.48, Waste: 0.62 },
    Offspeed: { Heart: 0.2, Shadow: 0.31, Chase: 0.47, Waste: 0.6 },
  };
  let p = table[c.group][c.zone] * h.contact;
  if (c.strikes === 2) p *= 0.92;
  if (h.whiff) p = h.whiff(p, c);
  return clamp(p, 0.01, 0.92);
}

function foulProb(h: HitterProfile, c: PitchCtx): number {
  let p = 0.42 + (c.strikes === 2 ? 0.1 : 0) + (c.zone === "Shadow" || c.zone === "Chase" ? 0.08 : 0);
  if (h.foul) p = h.foul(p, c);
  return clamp(p, 0.05, 0.9);
}

interface BattedBall {
  ev: number;
  la: number;
  result: "Single" | "Double" | "Triple" | "HomeRun" | "Out" | "Error" | "FieldersChoice";
  hitType: "GroundBall" | "LineDrive" | "FlyBall" | "Popup";
  distance: number;
  bearing: number;
}

function battedBall(rng: Rng, h: HitterProfile, c: PitchCtx, runnersOn: boolean): BattedBall {
  const zoneAdj = { Heart: 4, Shadow: 0, Chase: -7, Waste: -12 }[c.zone];
  const ev = Math.round(Math.max(45, Math.min(114, rng.normal(88.5 + h.power + zoneAdj, 10))) * 10) / 10;
  const la = Math.round(rng.normal(12, 24) * 10) / 10;
  const hitType: BattedBall["hitType"] = la > 50 ? "Popup" : la > 25 ? "FlyBall" : la >= 10 ? "LineDrive" : "GroundBall";
  let pHit: number;
  if (hitType === "Popup") pHit = 0.02;
  else if (hitType === "GroundBall") pHit = 0.24 + Math.max(0, ev - 85) * 0.013;
  else if (hitType === "LineDrive") pHit = 0.63 + (ev - 90) * 0.012;
  else pHit = 0.1 + Math.max(0, ev - 94) * 0.035;
  pHit = clamp(pHit, 0.01, 0.92);
  let result: BattedBall["result"] = "Out";
  if (rng.chance(pHit)) {
    if (hitType === "FlyBall" && ev >= 99 && la >= 22 && la <= 38 && rng.chance(0.55)) result = "HomeRun";
    else if (hitType === "LineDrive" && ev >= 101 && la >= 18 && rng.chance(0.25)) result = "HomeRun";
    else if (hitType !== "GroundBall" && ev >= 93 && rng.chance(0.38)) result = rng.chance(0.08) ? "Triple" : "Double";
    else result = "Single";
  } else if (rng.chance(0.025)) result = "Error";
  else if (runnersOn && hitType === "GroundBall" && rng.chance(0.12)) result = "FieldersChoice";
  const distance = Math.round(hitType === "GroundBall" ? rng.normal(90, 30) : hitType === "Popup" ? rng.normal(150, 30) : ev * 3.6 + la * 2 + rng.normal(0, 15));
  return { ev, la, result, hitType, distance: Math.max(5, distance), bearing: Math.round(rng.normal(0, 25)) };
}

// ---------------------------------------------------------------------------
// Game simulation
// ---------------------------------------------------------------------------
interface SimRow {
  gameNo: number;
  gameId: string;
  date: string;
  time: string;
  pitchNo: number;
  paOfInning: number;
  pitchOfPa: number;
  pitcher: Pitcher;
  batter: HitterProfile;
  batterTeam: string;
  batterSide: Hand;
  inning: number;
  half: "Top" | "Bottom";
  outs: number;
  balls: number;
  strikes: number;
  bases: [boolean, boolean, boolean];
  pitchType: PT;
  call: Call;
  korbb: "Strikeout" | "Walk" | null;
  bb: BattedBall | null;
  velo: number;
  spin: number;
  ivb: number;
  hb: number;
  relSide: number;
  relHeight: number;
  side: number;
  height: number;
  homeTeam: string;
  awayTeam: string;
}

function simulateSeason(seed = 20260214, games = 40): SimRow[] {
  const rng = new Rng(seed);
  const rows: SimRow[] = [];
  const start = Date.UTC(2026, 1, 13); // Feb 13, 2026

  for (let g = 0; g < games; g++) {
    const opp = OPP_TEAMS[g % OPP_TEAMS.length];
    const home = rng.chance(0.62);
    const homeTeam = home ? DEMO_TEAM_CODE : opp;
    const awayTeam = home ? opp : DEMO_TEAM_CODE;
    const dayOffset = Math.floor(g * 2.4) + (g % 3 === 0 ? 0 : 1);
    const date = new Date(start + dayOffset * 86400000).toISOString().slice(0, 10);
    const gameId = `${date.replace(/-/g, "")}-${homeTeam}-${awayTeam}-1`;

    // Our lineup: 8 regulars + Hargrove/Lyle platoon in the 9 spot.
    const lineup = [...ALABAMA.slice(0, 8), g % 2 === 0 ? ALABAMA[8] : ALABAMA[9]];
    const oppLineup = Array.from({ length: 9 }, (_, i) => makeOppHitter(rng, opp, i + g * 10));
    const oppStaff = [makePitcher(rng, opp, g * 10, "SP"), makePitcher(rng, opp, g * 10 + 1, "RP"), makePitcher(rng, opp, g * 10 + 2, "RP"), makePitcher(rng, opp, g * 10 + 3, "RP")];
    const ourStaff = [makePitcher(rng, DEMO_TEAM_CODE, g * 10 + 5, "SP"), makePitcher(rng, DEMO_TEAM_CODE, g * 10 + 6, "RP"), makePitcher(rng, DEMO_TEAM_CODE, g * 10 + 7, "RP")];
    const lineupIdx = { [DEMO_TEAM_CODE]: 0, [opp]: 0 } as Record<string, number>;
    let pitchNo = 0;
    let clockMin = 18 * 60 + 2;

    for (let inning = 1; inning <= 9; inning++) {
      for (const half of ["Top", "Bottom"] as const) {
        const battingTeam = half === "Top" ? awayTeam : homeTeam;
        const weBat = battingTeam === DEMO_TEAM_CODE;
        const order = weBat ? lineup : oppLineup;
        const staff = weBat ? oppStaff : ourStaff;
        const pitcher = weBat ? staff[inning <= 5 ? 0 : inning <= 7 ? 1 : inning === 8 ? 2 : 3] : staff[inning <= 6 ? 0 : inning <= 8 ? 1 : 2];
        let outs = 0;
        let bases: [boolean, boolean, boolean] = [false, false, false];
        let paOfInning = 0;

        while (outs < 3) {
          paOfInning++;
          const batter = order[lineupIdx[battingTeam] % 9];
          lineupIdx[battingTeam]++;
          const batterSide: Hand = batter.bats === "S" ? (pitcher.throws === "R" ? "L" : "R") : batter.bats;
          let balls = 0;
          let strikes = 0;
          let prev: PitchCtx["prev"];
          let prev2: PitchCtx["prev2"];
          let pitchOfPa = 0;
          let paDone = false;
          let paResult: string | null = null;

          while (!paDone) {
            pitchOfPa++;
            pitchNo++;
            clockMin += rng.chance(0.4) ? 1 : 0;
            const pt = choosePitch(rng, pitcher, balls, strikes, prev);
            const { side, height } = chooseLocation(rng, pt, balls, strikes, batterSide, prev);
            const cls = classify(side, height, batterSide);
            const velo = Math.round((pitcher.velo + VELO_OFFSET[pt] + rng.normal(0, 0.9)) * 10) / 10;
            const ctx: PitchCtx = {
              balls,
              strikes,
              count: `${balls}-${strikes}`,
              pitchType: pt,
              group: GROUP[pt],
              zone: cls.zone,
              inZone: cls.inZone,
              locV: cls.locV,
              locH: cls.locH,
              velo,
              pitcherHand: pitcher.throws,
              firstPitch: pitchOfPa === 1,
              prev,
              prev2,
            };

            let call: Call;
            let bb: BattedBall | null = null;
            const korbb: SimRow["korbb"] = null;
            const swing = rng.chance(swingProb(batter, ctx));
            if (swing) {
              if (rng.chance(whiffProb(batter, ctx))) call = "StrikeSwinging";
              else if (rng.chance(foulProb(batter, ctx))) call = "FoulBall";
              else {
                call = "InPlay";
                bb = battedBall(rng, batter, ctx, bases.some(Boolean));
              }
            } else if (cls.inside > 1.25 && rng.chance(0.35)) {
              call = "HitByPitch";
            } else {
              // Umpire: clean zone calls, noisy on the edges.
              const edge = cls.zone === "Shadow";
              const strikeProb = cls.inZone ? (edge ? 0.84 : 0.985) : edge ? 0.08 : 0.01;
              call = rng.chance(strikeProb) ? "StrikeCalled" : "BallCalled";
            }

            const relSideAbs = rng.normal(1.9, 0.25);
            const ivbBase = IVB[pt];
            const hbBase = HB_ARM[pt];
            const armSign = pitcher.throws === "R" ? 1 : -1;
            rows.push({
              gameNo: g,
              gameId,
              date,
              time: `${String(Math.floor(clockMin / 60)).padStart(2, "0")}:${String(clockMin % 60).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}`,
              pitchNo,
              paOfInning,
              pitchOfPa,
              pitcher,
              batter,
              batterTeam: battingTeam,
              batterSide,
              inning,
              half,
              outs,
              balls,
              strikes,
              bases: [...bases] as [boolean, boolean, boolean],
              pitchType: pt,
              call,
              korbb,
              bb,
              velo,
              spin: Math.round(rng.normal(SPIN[pt], 110)),
              ivb: Math.round(rng.normal(ivbBase[0], ivbBase[1]) * 10) / 10,
              hb: Math.round(rng.normal(hbBase[0], hbBase[1]) * armSign * 10) / 10,
              relSide: Math.round(relSideAbs * armSign * 100) / 100, // team convention: + = 3B side
              relHeight: Math.round(rng.normal(5.8, 0.2) * 100) / 100,
              side,
              height,
              homeTeam,
              awayTeam,
            });
            const row = rows[rows.length - 1];

            // Count / PA resolution
            if (call === "BallCalled") {
              balls++;
              if (balls === 4) {
                row.korbb = "Walk";
                paResult = "Walk";
                paDone = true;
              }
            } else if (call === "StrikeCalled" || call === "StrikeSwinging") {
              strikes++;
              if (strikes === 3) {
                row.korbb = "Strikeout";
                paResult = "Strikeout";
                paDone = true;
              }
            } else if (call === "FoulBall") {
              if (strikes < 2) strikes++;
            } else if (call === "HitByPitch") {
              paResult = "HitByPitch";
              paDone = true;
            } else if (call === "InPlay" && bb) {
              paResult = bb.result;
              paDone = true;
            }
            prev2 = prev ? { group: prev.group } : undefined;
            prev = { pitchType: pt, group: GROUP[pt], locV: cls.locV, locH: cls.locH, isSwing: swing, isWhiff: call === "StrikeSwinging", velo };
            if (pitchOfPa > 14) paDone = true; // safety
          }

          // Base/out state update (simplified but consistent).
          const [b1, b2, b3] = bases;
          switch (paResult) {
            case "Strikeout":
              outs++;
              break;
            case "Out":
              if (b1 && outs < 2 && rng.chance(0.14)) {
                outs += 2;
                bases = [false, b2, b3];
              } else {
                outs++;
                if (outs < 3 && rng.chance(0.35)) bases = [false, b1, b2];
              }
              break;
            case "FieldersChoice":
              outs++;
              bases = [true, b2, b3];
              break;
            case "Walk":
            case "HitByPitch":
              bases = [true, b1 || b2, (b1 && b2) || b3];
              break;
            case "Single":
            case "Error":
              bases = [true, b1, b2 && rng.chance(0.4)];
              break;
            case "Double":
              bases = [false, true, b1];
              break;
            case "Triple":
              bases = [false, false, true];
              break;
            case "HomeRun":
              bases = [false, false, false];
              break;
          }
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CSV writers
// ---------------------------------------------------------------------------
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

const TRACKMAN_HEADERS = [
  "PitchNo", "Date", "Time", "PAofInning", "PitchofPA", "Pitcher", "PitcherId", "PitcherThrows", "PitcherTeam",
  "Batter", "BatterId", "BatterSide", "BatterTeam", "PitcherSet", "Inning", "Top/Bottom", "Outs", "Balls", "Strikes",
  "TaggedPitchType", "AutoPitchType", "PitchCall", "KorBB", "TaggedHitType", "PlayResult", "OutsOnPlay", "RunsScored",
  "RelSpeed", "VertRelAngle", "HorzRelAngle", "SpinRate", "SpinAxis", "Tilt", "RelHeight", "RelSide", "Extension",
  "InducedVertBreak", "HorzBreak", "PlateLocHeight", "PlateLocSide", "ExitSpeed", "Angle", "Direction", "Distance", "Bearing",
  "HomeTeam", "AwayTeam", "Stadium", "Level", "League", "GameID", "PitchUID",
];

function trackmanRow(r: SimRow): unknown[] {
  const handWord = (h: Hand) => (h === "R" ? "Right" : "Left");
  // Real TrackMan exports split fouls and dirt balls into sub-calls; the mapper folds them back.
  const callWord =
    r.call === "FoulBall" ? (r.pitchNo % 3 === 0 ? "FoulBallFieldable" : "FoulBallNotFieldable") : r.call === "BallCalled" && r.height < 0.9 ? "BallinDirt" : r.call;
  return [
    r.pitchNo, r.date, r.time, r.paOfInning, r.pitchOfPa, r.pitcher.name, r.pitcher.id, handWord(r.pitcher.throws), r.pitcher.team,
    r.batter.name, r.batter.id, handWord(r.batterSide), r.batterTeam, r.bases.some(Boolean) ? "Stretch" : "Windup", r.inning, r.half, r.outs, r.balls, r.strikes,
    TRACKMAN_NAME[r.pitchType], TRACKMAN_NAME[r.pitchType], callWord, r.korbb ?? "Undefined", r.bb?.hitType ?? "Undefined", r.bb?.result ?? "Undefined",
    r.bb && r.bb.result === "Out" ? 1 : 0, 0,
    r.velo, -1.2, 1.5, r.spin, 200, "1:30", r.relHeight, r.relSide, 6.2,
    r.ivb, r.hb, r.height, -r.side /* team convention: + = 3B side */, r.bb?.ev ?? "", r.bb?.la ?? "", "", r.bb?.distance ?? "", r.bb?.bearing ?? "",
    r.homeTeam, r.awayTeam, "Sewell-Thomas Stadium", "D1", "SEC", r.gameId, `${r.gameId}-${String(r.pitchNo).padStart(4, "0")}`,
  ];
}

const TRUMEDIA_HEADERS = [
  "Date", "Home", "Away", "Inning", "Inning Half", "Outs", "Balls", "Strikes", "Runners On",
  "Batter", "Bats", "Batter Team", "Pitcher", "Throws", "Pitcher Team",
  "Pitch Type", "Pitch Result", "PA Result", "Velo", "Spin", "IVB", "HB", "PlateX", "PlateZ", "Exit Velo", "Launch Angle", "Clip ID",
];

function firstLast(name: string): string {
  const [last, first] = name.split(", ");
  return `${first} ${last}`;
}

const TRUMEDIA_CALL: Record<Call, string> = {
  BallCalled: "Ball", StrikeCalled: "Called Strike", StrikeSwinging: "Swinging Strike", FoulBall: "Foul", InPlay: "In Play", HitByPitch: "Hit By Pitch",
};
const TRUMEDIA_RESULT = (r: SimRow): string => {
  if (r.korbb === "Strikeout") return r.call === "StrikeCalled" ? "Strikeout (Looking)" : "Strikeout (Swinging)";
  if (r.korbb === "Walk") return "Walk";
  if (r.call === "HitByPitch") return "Hit By Pitch";
  if (!r.bb) return "";
  if (r.bb.result === "Out") return { GroundBall: "Groundout", LineDrive: "Lineout", FlyBall: "Flyout", Popup: "Pop Out" }[r.bb.hitType];
  if (r.bb.result === "HomeRun") return "Home Run";
  if (r.bb.result === "FieldersChoice") return "Fielder's Choice";
  if (r.bb.result === "Error") return "Field Error";
  return r.bb.result;
};

function trumediaRow(r: SimRow): unknown[] {
  const runners = r.bases.some(Boolean) ? r.bases.map((b, i) => (b ? String(i + 1) : "")).filter(Boolean).join("-") : "Empty";
  return [
    `${+r.date.slice(5, 7)}/${+r.date.slice(8, 10)}/${r.date.slice(0, 4)}`, r.homeTeam, r.awayTeam, r.inning, r.half, r.outs, r.balls, r.strikes, runners,
    firstLast(r.batter.name), r.batter.bats, r.batterTeam, firstLast(r.pitcher.name), r.pitcher.throws, r.pitcher.team,
    r.pitchType, TRUMEDIA_CALL[r.call], TRUMEDIA_RESULT(r), r.velo, r.spin, r.ivb, r.hb, r.side, r.height, r.bb?.ev ?? "", r.bb?.la ?? "",
    `CLIP-${r.gameId}-${r.pitchNo}`,
  ];
}

export interface DemoFile {
  name: string;
  text: string;
}

/** Generates the demo season as CSV files (3 TrackMan + 1 TruMedia). */
export function generateDemoFiles(seed?: number): DemoFile[] {
  const rows = simulateSeason(seed);
  const tmGames = (lo: number, hi: number) => rows.filter((r) => r.gameNo >= lo && r.gameNo < hi);
  const files: DemoFile[] = [
    { name: "demo_trackman_feb.csv", text: toCsv(TRACKMAN_HEADERS, tmGames(0, 10).map(trackmanRow)) },
    { name: "demo_trackman_mar.csv", text: toCsv(TRACKMAN_HEADERS, tmGames(10, 20).map(trackmanRow)) },
    { name: "demo_trackman_apr.csv", text: toCsv(TRACKMAN_HEADERS, tmGames(20, 30).map(trackmanRow)) },
    {
      name: "demo_trumedia_may_alabama.csv",
      text: toCsv(TRUMEDIA_HEADERS, tmGames(30, 40).filter((r) => r.batterTeam === DEMO_TEAM_CODE).map(trumediaRow)),
    },
  ];
  return files;
}

export const DEMO_HITTERS = ALABAMA.map((h) => h.name);
