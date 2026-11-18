/**
 * Local Smart Query Parser — offline NL → DuckDB SQL for Ask ABWizard when no
 * ANTHROPIC_API_KEY is configured (or the user forces local mode).
 *
 * Deterministic and transparent: it recognizes hitters, counts, pitch types,
 * locations, previous-pitch clauses, pitcher hand and the question's intent,
 * then fills SQL templates. Every SQL statement is shown to the user.
 */
import { METRICS, PITCH_GROUP_PLURAL, PITCH_TYPE_NAME, PITCH_TYPE_PLURAL, PITCH_TYPE_SINGULAR, PITCH_GROUP_SINGULAR, displayName, pct, sqlStr, type MetricKey } from "@/lib/metrics";
import type { AskAnswer, KeyNumber, Visualization } from "@/lib/ai/client";
import type { Row } from "@/lib/ingest";

type Kind = "rate" | "outcomes" | "pairs" | "streak" | "list" | "reaction";

export interface LocalQuery {
  key: string;
  purpose: string;
  sql: string;
}

export interface LocalPlan {
  kind: Kind;
  metric: MetricKey;
  hitter: string | null;
  subject: string;
  queries: LocalQuery[];
  visualization: Visualization;
  vizSql: string;
  logic: string;
  groupBy: "count_str" | "batter_name" | "pitch_type" | "location_label" | null;
  /** "what pitch / which count / where / who … the most" — rank the groups by the metric */
  rank: "desc" | "asc" | null;
  streakN?: number;
}

interface PitchParse {
  conds: string[];
  words: string[];
}

const TYPE_PATTERNS: [RegExp, string][] = [
  [/four[- ]?seam|4[- ]?seam|\bff\b/, "FF"],
  [/two[- ]?seam|sinkers?\b/, "SI"],
  [/cutters?\b/, "FC"],
  [/sweepers?\b/, "ST"],
  [/sliders?\b/, "SL"],
  [/curve ?balls?|curves?\b|hooks?\b/, "CU"],
  [/change[- ]?ups?|changeups?|\bchanges?\b/, "CH"],
  [/splitters?|split[- ]?fingers?|\bsplits?\b/, "FS"],
];
const GROUP_PATTERNS: [RegExp, string][] = [
  [/breaking( balls?| pitches| stuff)?/, "Breaking"],
  [/off[- ]?speed/, "Offspeed"],
  [/fast ?balls?|heaters?|\bheat\b|hard stuff/, "Fastball"],
];

function parsePitch(text: string, prefix: "" | "prev_", allowZone: boolean): PitchParse {
  const conds: string[] = [];
  const words: string[] = [];
  const types = TYPE_PATTERNS.filter(([re]) => re.test(text)).map(([, t]) => t);
  const groups = GROUP_PATTERNS.filter(([re]) => re.test(text)).map(([, g]) => g).filter((g) => !(g === "Fastball" && types.some((t) => ["FF", "SI", "FC"].includes(t))));
  const parts: string[] = [];
  if (types.length) {
    parts.push(`${prefix}pitch_type IN (${types.map(sqlStr).join(", ")})`);
    words.push(types.map((t) => (prefix ? PITCH_TYPE_SINGULAR[t] : PITCH_TYPE_PLURAL[t])).join(" or "));
  }
  if (groups.length) {
    parts.push(`${prefix}pitch_group IN (${groups.map(sqlStr).join(", ")})`);
    words.push(groups.map((g) => (prefix ? PITCH_GROUP_SINGULAR[g] : PITCH_GROUP_PLURAL[g])).join(" or "));
  }
  if (parts.length) conds.push(parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0]);

  const loc: [RegExp, string, string][] = [
    [/(down|low)[- ]?(and[- ])?away/, `${prefix}location_label = 'Down-Away'`, "down-and-away"],
    [/(up|high)[- ]?(and[- ])?in\b/, `${prefix}location_label = 'Up-In'`, "up-and-in"],
    [/(up|high)[- ]?(and[- ])?away/, `${prefix}location_label = 'Up-Away'`, "up-and-away"],
    [/(down|low)[- ]?(and[- ])?in\b/, `${prefix}location_label = 'Down-In'`, "down-and-in"],
  ];
  const combo = loc.find(([re]) => re.test(text));
  if (combo) {
    conds.push(combo[1]);
    words.push(combo[2]);
  } else {
    if (/elevated|\bup\b|\bhigh\b|top of the zone|upstairs/.test(text)) {
      conds.push(`${prefix}loc_vertical = 'Up'`);
      words.unshift("elevated");
    } else if (/\bdown\b|\blow\b|below the zone|in the dirt|bottom of the zone/.test(text)) {
      conds.push(`${prefix}loc_vertical = 'Down'`);
      words.push("down");
    }
    if (/\baway\b|outside|outer half/.test(text)) {
      conds.push(`${prefix}loc_horizontal_rel = 'Away'`);
      words.push("away");
    } else if (/\binside\b|in on (him|his hands)|inner half|\bin\b(?= (off|on))/.test(text)) {
      conds.push(`${prefix}loc_horizontal_rel = 'In'`);
      words.push("inside");
    }
  }
  if (allowZone) {
    if (/out of the zone|off the plate|outside the zone|chase pitch|non[- ]?strikes?|balls? out/.test(text)) {
      conds.push(`${prefix}in_zone = FALSE`);
      words.push("out of the zone");
    } else if (/\bheart\b|middle[- ]middle|meatball/.test(text)) {
      conds.push(`${prefix}attack_zone = 'Heart'`);
      words.push("in the heart of the zone");
    } else if (/in the zone|in-zone|hittable|\bstrikes?\b(?! ?out)/.test(text)) {
      conds.push(`${prefix}in_zone`);
      words.push("in the zone");
    }
  }
  return { conds, words };
}

function detectMetric(q: string): MetricKey {
  if (/chase|chases|chasing|expand/.test(q)) return "chase";
  if (/whiff|swing(s|ing)? and miss|swing(s|ing)? through|\bmiss(es)?\b/.test(q)) return "whiff";
  if (/freez|froze|caught looking|take (a |the )?strike|takes strikes|looking/.test(q)) return "freeze";
  if (/hard[- ]hit|damage|exit velo|barrel|crush|hits? .* hard/.test(q)) return "hardHit";
  if (/strike ?outs?|strikes out|\bks?\b|punch/.test(q)) return "kRate";
  if (/\btakes?\b|taking|lay(s)? off|let(s)? .* go/.test(q)) return "take";
  return "swing";
}

export function planLocalQuery(question: string, ctx: { hitters: string[]; focusHitter: string | null }): LocalPlan {
  const raw = question.trim();
  let q = ` ${raw.toLowerCase().replace(/[’']/g, "'")} `;
  // Idioms whose "up" is not a location: "freeze up", "locks him up", "tied up", "set up"…
  q = q.replace(/\b(freez\w*|froze\w*|lock(?:s|ed|ing)?|tie[sd]?|tying|jam(?:s|med|ming)?|set(?:s|ting)?|give[sn]?|gave|match(?:es|ed)?|pick(?:s|ed)?|show(?:s|ed)?|eat(?:s)?|mess(?:es|ed)?)\s+(him\s+|them\s+)?up\b/g, "$1");

  // --- hitter
  let hitter: string | null = null;
  for (const h of ctx.hitters) {
    const [last, first] = h.toLowerCase().split(",").map((s) => s.trim());
    if (new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q) || (first && q.includes(`${first} ${last}`))) {
      hitter = h;
      break;
    }
  }
  if (!hitter) {
    // First name alone ("Jace") when it's unique on the roster.
    const byFirst = ctx.hitters.filter((h) => {
      const first = h.split(",")[1]?.trim().toLowerCase();
      return !!first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q);
    });
    if (byFirst.length === 1) hitter = byFirst[0];
  }
  const named = hitter !== null;
  // "Who …" / "which hitter …" compares hitters, so ignore the focus hitter.
  const askWho = /\bwho\b|\b(which|what) (hitter|player|guy|batter)s?\b/.test(q);
  if (!named && !askWho) hitter = ctx.focusHitter;

  // --- counts (strip the phrases so "strikes" in "two strikes" isn't read as a zone word)
  const countConds: string[] = [];
  const countWords: string[] = [];
  const explicit = [...q.matchAll(/\b([0-3])\s*[-–]\s*([0-2])\b/g)].map((m) => `${m[1]}-${m[2]}`);
  if (explicit.length) {
    countConds.push(`count_str IN (${[...new Set(explicit)].map(sqlStr).join(", ")})`);
    countWords.push(`in ${[...new Set(explicit)].join(" or ")} counts`);
    q = q.replace(/\b[0-3]\s*[-–]\s*[0-2]\b/g, " ");
  }
  const phrase = (re: RegExp, cond: string, words: string) => {
    if (re.test(q)) {
      countConds.push(cond);
      countWords.push(words);
      q = q.replace(re, " ");
    }
  };
  phrase(/(with )?(two|2)[- ]strikes?|two[- ]strike counts?|putaway counts?/, "two_strikes", "with two strikes");
  phrase(/first[- ]pitch(es)?|1st[- ]pitch|on pitch (one|1)/, "is_first_pitch_of_pa", "on the first pitch");
  phrase(/hitters?'?s? counts?|ahead in the count|when (he's|he is) ahead/, "count_bucket = 'Hitter Ahead'", "in hitter's counts");
  phrase(/behind in the count|pitchers?'?s? counts?|when (he's|he is) behind/, "count_bucket = 'Pitcher Ahead'", "when behind in the count");
  phrase(/full counts?/, "count_str = '3-2'", "in full counts");
  phrase(/even counts?/, "count_bucket = 'Even'", "in even counts");

  // --- pitcher hand
  let handCond: string | null = null;
  let handWord = "";
  if (/lefty|lefties|\blhp\b|left[- ]handed pitch|left[- ]handers|southpaw/.test(q)) {
    handCond = "pitcher_throws = 'L'";
    handWord = "vs LHP";
  } else if (/righty|righties|\brhp\b|right[- ]handed pitch|right[- ]handers/.test(q)) {
    handCond = "pitcher_throws = 'R'";
    handWord = "vs RHP";
  }

  // --- previous-pitch clause
  const prevMatch = q.match(/\b(?:right after|after seeing|after|preceded by|following|off of|off)\s+(?:an?\s+|the\s+)?(.+?)(?:[?.!,;]|\bwhen\b|\bin\b(?= \d)|$)/);
  let current = q;
  let prev: PitchParse = { conds: [], words: [] };
  if (prevMatch && /pitch|ball|seam|sinker|cutter|slider|sweeper|curve|change|split|heater|fastball|breaking|offspeed|whiff|take/.test(prevMatch[1])) {
    prev = parsePitch(prevMatch[1], "prev_", false);
    current = q.replace(prevMatch[0], " ");
  }
  const cur = parsePitch(current, "", true);

  // --- intent
  let kind: Kind = "rate";
  let streakN: number | undefined;
  const streak = q.match(/(\d+)\s*\+?\s*(?:or more\s+)?(?:breaking balls?|breaking pitches|sliders|curveballs|offspeed)?\s*(?:in a row|straight|consecutive)/) ?? q.match(/(three|four|five)\s*\+?\s*(?:or more\s+)?\w*\s*\w*\s*in a row/);
  if (streak || /in a row|consecutive/.test(q)) {
    kind = "streak";
    const n = streak?.[1];
    streakN = n ? ({ three: 3, four: 4, five: 5 } as Record<string, number>)[n] ?? Number(n) : 3;
  } else if (/(2|two)[- ]pitch (sequence|combo|pair)|which sequence|what sequence|best sequence|sequence .*(highest|most|best)/.test(q)) kind = "pairs";
  else if (/rest of the (ab|at[- ]bat|pa|plate appearance)|what happens (after|next|later)|how do(es)? (the|his|those) (abs?|at[- ]bats?|pas?) end|outcome/.test(q)) kind = "outcomes";
  else if (/\b(show|list|find|give)\b.*\b(every|all|each)\b|\bevery (pa|at[- ]bat|plate appearance)|which (pas|at[- ]bats)/.test(q)) kind = "list";
  else if (/react|reaction|what does he do|how does he (handle|respond)|approach/.test(q)) kind = "reaction";
  const metric = detectMetric(q);
  let rankBy: "pitch_type" | "count_str" | "location_label" | null = null;
  if (kind === "rate") {
    if (/\b(what|which)\s+(pitch(es)?|pitch types?|kinds? of pitch(es)?|types? of pitch(es)?)\b|\bby pitch( type)?\b/.test(q)) rankBy = "pitch_type";
    else if (/\b(what|which)\s+counts?\b|\bin what count|\bby count\b/.test(q)) rankBy = "count_str";
    else if (/\b(what|which)\s+(locations?|zones?|spots?|part of the zone|areas?)\b|\bby (location|zone)\b|\bwhere\b/.test(q)) rankBy = "location_label";
  }
  const rankDir: LocalPlan["rank"] = rankBy || askWho ? (/\b(least|lowest|fewest|rarely|least often)\b/.test(q) ? "asc" : "desc") : null;

  const hitterCond = hitter ? `batter_name = ${sqlStr(hitter)}` : null;
  const pitchConds = [...cur.conds, ...prev.conds];
  const allConds = [hitterCond, ...countConds, ...pitchConds, handCond].filter((c): c is string => !!c);
  const W = allConds.length ? allConds.join("\n  AND ") : "TRUE";
  const subjectBits = [cur.words.join(" ") || "pitches", countWords.join(" "), prev.words.length ? `right after ${/^[aeiou]/.test(prev.words.join(" ")) ? "an" : "a"} ${prev.words.join(" ")}` : "", handWord];
  const subject = subjectBits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const m = METRICS[metric];
  const groupBy: LocalPlan["groupBy"] = rankBy ?? (explicit.length > 1 ? "count_str" : !hitter ? "batter_name" : null);
  const pitchTypeLabel = `CASE pitch_type ${Object.entries(PITCH_TYPE_NAME)
    .map(([k, v]) => `WHEN '${k}' THEN '${v} (${k})'`)
    .join(" ")} ELSE coalesce(pitch_type, 'Unknown') END`;
  const groupExpr = groupBy === "pitch_type" ? pitchTypeLabel : groupBy;
  const pointCols = `pitch_uid, pa_uid, CAST(game_date AS VARCHAR) AS game_date, batter_name, pitcher_name, pitcher_throws, count_str, pitch_type, pitch_group, pitch_call,
    rel_speed, plate_loc_side, plate_loc_height, prev_pitch_type, prev_plate_loc_side, prev_plate_loc_height, exit_speed, launch_angle, play_result, pa_result, pa_pitch_seq, pitch_sequence_str`;

  const queries: LocalQuery[] = [];
  let visualization: Visualization = "strike_zone";
  let vizSql = "";
  let logic = "";

  const rateSql = (den: string, num: string, extraWhere = "TRUE") => {
    const gsel = groupBy ? `${groupExpr} AS label, ` : "'All' AS label, ";
    const order = rankDir
      ? `\nGROUP BY ALL\nHAVING count(*) FILTER (WHERE ${den}) > 0\nORDER BY num::DOUBLE / den ${rankDir === "asc" ? "ASC" : "DESC"}, den DESC`
      : groupBy
        ? `\nGROUP BY ALL\nORDER BY den DESC`
        : "";
    return `SELECT ${gsel}count(*) FILTER (WHERE (${den}) AND (${num})) AS num,
  count(*) FILTER (WHERE ${den}) AS den,
  count(DISTINCT pa_uid) FILTER (WHERE ${den}) AS pas
FROM enriched_pitches
WHERE ${W}
  AND (${extraWhere})${groupBy ? `\n  AND ${groupBy} IS NOT NULL` : ""}${order}`;
  };

  switch (kind) {
    case "streak": {
      const base = [hitterCond, handCond].filter(Boolean).join(" AND ") || "TRUE";
      queries.push({
        key: "main",
        purpose: `PAs with ${streakN}+ breaking balls in a row`,
        sql: `SELECT pa_uid, CAST(game_date AS VARCHAR) AS game_date, batter_name, pitcher_name, pa_max_breaking_streak AS breaking_in_a_row,
  pa_sequence_full, pa_final_count, pa_result
FROM enriched_pitches
WHERE ${base}
  AND is_pa_terminal_pitch AND pa_max_breaking_streak >= ${streakN}
ORDER BY game_date DESC`,
      });
      visualization = "table";
      vizSql = queries[0].sql;
      logic = `pa_max_breaking_streak is the longest run of consecutive breaking balls (SL/ST/CU) inside each PA; one row per PA.`;
      break;
    }
    case "pairs": {
      const pm: MetricKey = metric === "swing" || metric === "take" ? "whiff" : metric;
      const d = METRICS[pm];
      queries.push({
        key: "main",
        purpose: `${d.label} by previous pitch → current pitch`,
        sql: `SELECT prev_pitch_type || ' → ' || pitch_type AS label,
  count(*) FILTER (WHERE (${d.den}) AND (${d.num})) AS num,
  count(*) FILTER (WHERE ${d.den}) AS den
FROM enriched_pitches
WHERE ${W}
  AND prev_pitch_type IS NOT NULL AND pitch_type IS NOT NULL
GROUP BY 1
HAVING count(*) FILTER (WHERE ${d.den}) >= 3
ORDER BY num::DOUBLE / den DESC, den DESC
LIMIT 12`,
      });
      visualization = "bar";
      vizSql = queries[0].sql;
      logic = `Every pitch is paired with the previous pitch of the same PA (LAG over pa_uid). ${d.label} = ${d.num} / ${d.den}; pairs with fewer than 3 in the denominator are dropped.`;
      break;
    }
    case "outcomes": {
      queries.push({ key: "rate", purpose: `${m.label} on the matching pitches`, sql: rateSql(m.den, m.num, m.paLevel ? "is_pa_terminal_pitch" : "TRUE") });
      queries.push({
        key: "main",
        purpose: "How the PAs containing those pitches ended",
        sql: `WITH matched AS (
  SELECT DISTINCT pa_uid FROM enriched_pitches
  WHERE ${W}
)
SELECT e.pa_result AS label, count(*) AS num, (SELECT count(*) FROM matched) AS den
FROM enriched_pitches e JOIN matched USING (pa_uid)
WHERE e.is_pa_terminal_pitch
GROUP BY 1
ORDER BY num DESC`,
      });
      visualization = "bar";
      vizSql = queries[1].sql;
      logic = `First the ${m.label} on the matching pitches; then every PA that contains one of them, grouped by how the PA ended (pa_result on its last pitch).`;
      break;
    }
    case "list": {
      queries.push({
        key: "main",
        purpose: "PAs containing the matching pitch(es)",
        sql: `WITH matched AS (
  SELECT DISTINCT pa_uid FROM enriched_pitches
  WHERE ${W}
)
SELECT e.pa_uid, CAST(e.game_date AS VARCHAR) AS game_date, e.batter_name, e.pitcher_name, e.pa_sequence_full, e.pa_final_count, e.pa_result
FROM enriched_pitches e JOIN matched USING (pa_uid)
WHERE e.is_pa_terminal_pitch
ORDER BY e.game_date DESC`,
      });
      visualization = "table";
      vizSql = queries[0].sql;
      logic = "Finds every PA with at least one pitch matching the conditions and lists it once (its final pitch row).";
      break;
    }
    case "reaction": {
      queries.push({
        key: "main",
        purpose: "What he did on the matching pitches",
        sql: `SELECT CASE pitch_call WHEN 'BallCalled' THEN 'Took — ball' WHEN 'StrikeCalled' THEN 'Took — called strike (froze)'
    WHEN 'StrikeSwinging' THEN 'Swing & miss' WHEN 'FoulBall' THEN 'Fouled off' WHEN 'InPlay' THEN 'Put in play' ELSE 'Other' END AS label,
  count(*) AS num, CAST(sum(count(*)) OVER () AS BIGINT) AS den
FROM enriched_pitches
WHERE ${W}
GROUP BY 1
ORDER BY num DESC`,
      });
      queries.push({ key: "swing", purpose: "Swing% on those pitches", sql: rateSql("TRUE", "is_swing") });
      visualization = "strike_zone";
      vizSql = `SELECT ${pointCols}, is_swing AS highlight
FROM enriched_pitches
WHERE ${W}
ORDER BY game_date DESC, pa_uid, pa_pitch_seq`;
      logic = "Breaks the matching pitches down by what happened (take/whiff/foul/in play). The zone plot shows them with dashed vectors from the previous pitch; swings are highlighted.";
      break;
    }
    default: {
      const paLevel = !!m.paLevel;
      queries.push({ key: "main", purpose: `${m.label} for ${subject}`, sql: rateSql(m.den, m.num, paLevel ? "is_pa_terminal_pitch" : "TRUE") });
      if (groupBy === "count_str") {
        visualization = "count_matrix";
        vizSql = `SELECT count_str, count(*) FILTER (WHERE (${m.den}) AND (${m.num})) AS num, count(*) FILTER (WHERE ${m.den}) AS den
FROM enriched_pitches WHERE ${W} GROUP BY 1`;
      } else if (groupBy) {
        visualization = "bar";
        vizSql = queries[0].sql;
      } else {
        visualization = "strike_zone";
        vizSql = `SELECT ${pointCols}, (${m.num}) AS highlight
FROM enriched_pitches
WHERE ${W}
  AND (${m.den})
ORDER BY game_date DESC, pa_uid, pa_pitch_seq`;
      }
      logic = `${m.label} = pitches where ${m.num} ÷ pitches where ${m.den}${paLevel ? " (one row per PA)" : ""}.`;
    }
  }

  const condText = allConds.length ? `Conditions: ${allConds.join(" AND ")}.` : "No conditions recognized — this covers every pitch in scope.";
  const rankText = rankDir && groupBy ? ` Groups (${groupBy}) are ranked by ${m.label}, ${rankDir === "asc" ? "lowest" : "highest"} first.` : "";
  return { kind, metric, hitter, subject, queries, visualization, vizSql, logic: `${logic}${rankText} ${condText} Parsed locally (no AI).`, groupBy, rank: rankDir, streakN };
}

function r(num: number, den: number) {
  return `${pct(den ? num / den : null)} (${num}/${den})`;
}

/** Builds the executive answer from the executed local queries. */
export function summarizeLocal(plan: LocalPlan, results: Record<string, Row[]>): Pick<AskAnswer, "headline" | "answer" | "keyNumbers"> {
  const who = plan.hitter ? displayName(plan.hitter) : "All hitters in scope";
  const rows = results.main ?? [];
  const n = (v: unknown) => Number(v ?? 0);
  const keyNumbers: KeyNumber[] = [];
  const m = METRICS[plan.metric];
  const verb = plan.metric === "take" ? "takes" : plan.metric === "swing" ? "swings at" : plan.metric === "chase" ? "chases" : plan.metric === "whiff" ? "whiffs on" : plan.metric === "freeze" ? "freezes on (takes)" : plan.metric === "hardHit" ? "hits hard" : "strikes out on";

  switch (plan.kind) {
    case "streak":
      return {
        headline: `${who}: ${rows.length} PA${rows.length === 1 ? "" : "s"} with ${plan.streakN}+ breaking balls in a row.`,
        answer: rows.length
          ? rows
              .slice(0, 6)
              .map((x) => `- ${x.game_date} vs ${displayName(String(x.pitcher_name))}: ${x.breaking_in_a_row} in a row → **${x.pa_result}**`)
              .join("\n")
          : "No PAs matched.",
        keyNumbers,
      };
    case "pairs": {
      const top = rows.slice(0, 5);
      if (top[0]) keyNumbers.push({ label: String(top[0].label), num: n(top[0].num), den: n(top[0].den) });
      const pm = plan.metric === "swing" || plan.metric === "take" ? METRICS.whiff : m;
      return {
        headline: top[0] ? `${who}: highest ${pm.label} 2-pitch sequence ${plan.subject ? `(${plan.subject}) ` : ""}is ${top[0].label} at ${r(n(top[0].num), n(top[0].den))}.` : "No 2-pitch sequences met the minimum sample.",
        answer: top.map((x) => `- **${x.label}**: ${r(n(x.num), n(x.den))}`).join("\n"),
        keyNumbers,
      };
    }
    case "outcomes": {
      const rate = results.rate?.[0];
      const total = rows.reduce((s, x) => s + n(x.num), 0);
      if (rate) keyNumbers.push({ label: `${m.label}`, num: n(rate.num), den: n(rate.den) });
      const parts = rows.slice(0, 6).map((x) => `- ${x.label}: ${r(n(x.num), total)}`);
      return {
        headline: rate ? `${who} ${verb} ${plan.subject}: ${r(n(rate.num), n(rate.den))}. Those ${total} PAs ended as shown below.` : `${total} PAs matched.`,
        answer: `**Rest of the AB** (PAs containing those pitches):\n${parts.join("\n")}`,
        keyNumbers,
      };
    }
    case "list":
      return {
        headline: `${who}: ${rows.length} PA${rows.length === 1 ? "" : "s"} matched ${plan.subject}.`,
        answer: rows
          .slice(0, 6)
          .map((x) => `- ${x.game_date} vs ${displayName(String(x.pitcher_name))}: ${x.pa_sequence_full} → **${x.pa_result}**`)
          .join("\n"),
        keyNumbers,
      };
    case "reaction": {
      const total = rows.reduce((s, x) => s + n(x.num), 0);
      const sw = results.swing?.[0];
      if (sw) keyNumbers.push({ label: "Swing%", num: n(sw.num), den: n(sw.den) });
      return {
        headline: `${who} on ${plan.subject}: swings ${sw ? r(n(sw.num), n(sw.den)) : "—"}.`,
        answer: rows.map((x) => `- ${x.label}: ${r(n(x.num), total)}`).join("\n"),
        keyNumbers,
      };
    }
    default: {
      const num = rows.reduce((s, x) => s + n(x.num), 0);
      const den = rows.reduce((s, x) => s + n(x.den), 0);
      if (plan.rank && plan.groupBy) {
        const groupBy = plan.groupBy;
        const MIN = 5;
        const labelOf = (x: Row) => (groupBy === "batter_name" ? displayName(String(x.label)) : String(x.label));
        const eligible = rows.filter((x) => n(x.den) >= MIN);
        const pool = eligible.length ? eligible : rows;
        const lead = pool[0];
        const dimWord = { pitch_type: "pitch type", location_label: "location", count_str: "count", batter_name: "hitter" }[groupBy];
        const dir = plan.rank === "asc" ? "Lowest" : "Highest";
        const scope = plan.subject && plan.subject !== "pitches" ? ` on ${plan.subject}` : "";
        if (lead) keyNumbers.push({ label: `${labelOf(lead)} ${m.label}`, num: n(lead.num), den: n(lead.den) });
        const lines = rows.slice(0, 8).map((x) => `- ${labelOf(x)}: ${r(n(x.num), n(x.den))}${n(x.den) < MIN ? " — small sample" : ""}`);
        return {
          headline: lead
            ? `${who}: ${dir.toLowerCase()} ${m.label}${scope} by ${dimWord} is ${labelOf(lead)} at ${r(n(lead.num), n(lead.den))}.`
            : `No pitches matched${scope}.`,
          answer: `${lines.join("\n")}${eligible.length ? `\n\nRanked among ${dimWord}s with at least ${MIN} pitches in the denominator.` : ""}`,
          keyNumbers,
        };
      }
      keyNumbers.push({ label: m.label, num, den });
      const ranked = [...rows].filter((x) => n(x.den) >= 5).sort((a, b) => n(b.num) / n(b.den) - n(a.num) / n(a.den));
      const lines =
        rows.length > 1
          ? (plan.groupBy === "batter_name" ? ranked : rows).slice(0, 8).map((x) => `- ${plan.groupBy === "batter_name" ? displayName(String(x.label)) : x.label}: ${r(n(x.num), n(x.den))}`)
          : [];
      const small = den > 0 && den < 10 ? " Small sample — treat as a lean, not a lock." : "";
      const leader = plan.groupBy === "batter_name" && ranked[0] ? ` Highest: ${displayName(String(ranked[0].label))} ${r(n(ranked[0].num), n(ranked[0].den))}.` : "";
      const lead = plan.hitter ? `${who} ${verb} ${plan.subject}` : `${who} — ${m.label} on ${plan.subject}`;
      return {
        headline: den ? `${lead}: ${r(num, den)}.${leader}` : `No pitches matched ${plan.subject}.`,
        answer: `${lines.join("\n")}${small}`.trim() || `${m.label} computed over ${den} pitches.`,
        keyNumbers,
      };
    }
  }
}

export const STARTER_QUESTIONS = [
  "In 2-0 or 1-0 counts, how often does he take a curveball or slider, and what happens the rest of the AB?",
  "What 2-pitch sequence gets the highest whiff rate against him with 2 strikes?",
  "How does he react to a fastball up after seeing a breaking ball down-and-away?",
  "Show me every PA where he saw 3+ breaking balls in a row.",
  "How often does he freeze on first-pitch fastballs in the zone?",
  "Does he chase sliders down and away with two strikes after an elevated fastball?",
];
