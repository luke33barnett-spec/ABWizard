/**
 * End-to-end data check: demo CSVs → schema mapper → DuckDB → enriched view,
 * then sanity checks on the derived columns. Run: npm run verify:data
 * Exits non-zero on any failed check.
 */
import { generateDemoFiles } from "../src/lib/mock-data";
import { ingestCsvFiles, getDatasetSummary } from "../src/lib/ingest";
import { createNodeDb } from "./node-db";
import { runTendencyScan, type Insight } from "../src/lib/tendency-scanner";
import { buildWhere, DEFAULT_FILTERS } from "../src/lib/filters";
import * as Q from "../src/lib/queries";
import { readRawCsvSql } from "../src/lib/sql/schema";
import { planLocalQuery, summarizeLocal, STARTER_QUESTIONS } from "../src/lib/local-query-parser";
import { checkReadOnly, scopeSql } from "../src/lib/sql-guard";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const db = await createNodeDb();
  const t0 = Date.now();
  const files = generateDemoFiles();
  const res = await ingestCsvFiles(db, files);
  console.log(`ingest: ${res.insertedRows} rows in ${Date.now() - t0}ms`);
  for (const f of res.files) {
    console.log(`  ${f.fileName}: ${f.format}, ${f.mappedRows}/${f.totalRecords} rows, skipped=${f.skipped}, side=${f.sideConvention}, units=${f.units}${f.error ? " ERROR " + f.error : ""}`);
    if (f.mapping.unmapped.length) console.log(`    unmapped: ${f.mapping.unmapped.join(", ")}`);
  }
  console.log(await getDatasetSummary(db, "ALA_CRI"));

  const failures: string[] = [];
  const check = async (label: string, sql: string, ok: (r: Record<string, unknown>) => boolean) => {
    const [r] = await db.query(sql);
    const pass = ok(r);
    console.log(`${pass ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(r, (_, v) => (typeof v === "bigint" ? Number(v) : v))}`);
    if (!pass) failures.push(label);
  };

  await check("re-ingest dedupes", "SELECT count(*) n, count(DISTINCT pitch_uid) u FROM enriched_pitches", (r) => Number(r.n) === Number(r.u));
  await check("every PA has 1 terminal pitch", "SELECT count(*) bad FROM (SELECT pa_uid, sum(is_pa_terminal_pitch::INT) t FROM enriched_pitches GROUP BY 1 HAVING t <> 1)", (r) => Number(r.bad) === 0);
  await check("pa_pitch_seq contiguous", "SELECT count(*) bad FROM (SELECT pa_uid, max(pa_pitch_seq) m, count(*) c FROM enriched_pitches GROUP BY 1 HAVING m <> c)", (r) => Number(r.bad) === 0);
  await check("first pitch is 0-0", "SELECT count(*) FILTER (WHERE count_str <> '0-0') bad, count(*) n FROM enriched_pitches WHERE is_first_pitch_of_pa", (r) => Number(r.bad) / Number(r.n) < 0.002);
  await check("pa_result resolved", "SELECT count(*) FILTER (WHERE pa_result = 'Incomplete') inc, count(*) n FROM enriched_pitches WHERE is_pa_terminal_pitch", (r) => Number(r.inc) / Number(r.n) < 0.01);
  await check("sequence str ordered", "SELECT count(*) FILTER (WHERE len(string_split(pitch_sequence_str, ' -> ')) <> pa_pitch_seq OR NOT starts_with(string_split(pitch_sequence_str, ' -> ')[pa_pitch_seq], coalesce(pitch_type, '??'))) bad FROM enriched_pitches", (r) => Number(r.bad) === 0);
  await check("prev pitch matches LAG", "SELECT count(*) bad FROM enriched_pitches a JOIN enriched_pitches b ON a.pa_uid = b.pa_uid AND b.pa_pitch_seq = a.pa_pitch_seq - 1 WHERE a.prev_pitch_type IS DISTINCT FROM b.pitch_type", (r) => Number(r.bad) === 0);
  await check("zone% plausible", "SELECT round(avg(in_zone::INT), 3) z, round(avg(is_swing::INT), 3) sw, round(sum(is_chase::INT)/sum((NOT in_zone)::INT), 3) chase FROM enriched_pitches", (r) => Number(r.z) > 0.4 && Number(r.z) < 0.55 && Number(r.chase) > 0.2 && Number(r.chase) < 0.36);
  await check("RHH inside is 3B side (neg)", "SELECT round(avg(plate_loc_side) FILTER (WHERE loc_horizontal_rel='In' AND batter_side='R'), 2) rin, round(avg(plate_loc_side) FILTER (WHERE loc_horizontal_rel='In' AND batter_side='L'), 2) lin FROM enriched_pitches", (r) => Number(r.rin) < 0 && Number(r.lin) > 0);
  await check("breaking down-away is away from RHH", "SELECT round(avg(inside_offset) FILTER (WHERE pitch_group='Breaking' AND plate_loc_height < 1.6), 2) away_off FROM enriched_pitches", (r) => Number(r.away_off) < -0.3);
  await check("TruMedia names merged", "SELECT count(DISTINCT source_format) fmts FROM enriched_pitches WHERE batter_name = 'Tidwell, Jace'", (r) => Number(r.fmts) === 2);
  await check("switch hitter both sides", "SELECT count(DISTINCT batter_side) sides FROM enriched_pitches WHERE batter_name = 'Vance, Eli'", (r) => Number(r.sides) === 2);
  await check("base state only from TruMedia", "SELECT count(*) FILTER (WHERE base_state IS NOT NULL AND source_format='TrackMan') bad, count(*) FILTER (WHERE base_state IS NOT NULL) has FROM enriched_pitches", (r) => Number(r.bad) === 0 && Number(r.has) > 0);
  await check("K looking derived", "SELECT count(*) FILTER (WHERE is_called_strike_three) kl, count(*) FILTER (WHERE pa_is_k AND is_pa_terminal_pitch) k FROM enriched_pitches", (r) => Number(r.kl) > 0 && Number(r.kl) < Number(r.k));
  await check("breaking streak", "SELECT max(consecutive_breaking) m, count(DISTINCT pa_uid) FILTER (WHERE pa_max_breaking_streak >= 3) pas FROM enriched_pitches", (r) => Number(r.m) >= 3 && Number(r.pas) > 0);

  // Auto-Scout must rediscover every tendency planted in src/lib/mock-data.ts.
  const insights = await runTendencyScan((s) => db.query(s), { globalWhere: buildWhere(DEFAULT_FILTERS), hitter: null, minN: 5, maxPerCategory: 50 });
  const found = (label: string, pred: (i: Insight) => boolean) => {
    const hit = insights.find(pred);
    console.log(`${hit ? "PASS" : "FAIL"} scanner finds ${label}${hit ? `: ${hit.headline}` : ""}`);
    if (!hit) failures.push(`scanner: ${label}`);
  };
  const passive = (i: Insight) => (i.metric === "swing" ? i.delta < 0 : i.delta > 0);
  found("Tidwell takes breaking balls in hitter's counts", (i) => i.hitter === "Tidwell, Jace" && ["count", "freeze"].includes(i.category) && i.dims.includes("Breaking") && i.dims.some((d) => ["Hitter Ahead", "1-0", "2-0", "2-1", "3-1"].includes(d)) && passive(i));
  found("Tidwell freezes on 2-strike breaking balls", (i) => i.hitter === "Tidwell, Jace" && i.category === "freeze" && (i.probeId.startsWith("two-strike") || i.dims.includes("0-2") || i.dims.includes("1-2")) && i.delta > 0);
  found("Mercer chases putaway sliders after elevated FF", (i) => i.hitter === "Mercer, Cole" && i.probeId.startsWith("tunnel") && i.dims[0] === "FF" && i.dims[1] === "Up" && i.delta > 0);
  found("Ruffin ambushes first-pitch fastballs", (i) => i.hitter === "Ruffin, Dax" && i.dims.includes("Fastball") && (i.dims.includes("0-0") || i.dims.includes("First Pitch") || i.probeId === "first-pitch-swing") && i.delta > 0);
  found("Okafor chases LHP breaking balls", (i) => i.hitter === "Okafor, Miles" && i.probeId === "hand-group-chase" && i.dims[0] === "L" && i.dims[1] === "Breaking");
  found("Okafor freezes on 2-strike curveballs", (i) => i.hitter === "Okafor, Miles" && i.probeId === "two-strike-type-freeze" && i.dims[0] === "CU");
  found("Bledsoe chases after a whiff", (i) => i.hitter === "Bledsoe, Tanner" && i.probeId === "after-prev-result-chase" && i.dims[0] === "a whiff");
  found("Vance whiffs on Hard-Hard-Soft", (i) => i.hitter === "Vance, Eli" && i.probeId === "hs3-whiff" && i.dims[0] === "HHS");
  found("Vance takes the first pitch", (i) => i.hitter === "Vance, Eli" && (i.dims.includes("0-0") || i.dims.includes("First Pitch")) && passive(i));

  // Every panel SQL builder must run and return rows.
  const W = buildWhere(DEFAULT_FILTERS);
  const H = "Tidwell, Jace";
  const firstPa = String((await db.query(`SELECT pa_uid FROM enriched_pitches WHERE batter_name = '${H}' LIMIT 1`))[0].pa_uid);
  const panels: [string, string][] = [
    ["roster", Q.rosterSql(W)],
    ["hitterList", Q.hitterListSql(W)],
    ["hitterHeader", Q.hitterHeaderSql(W, H)],
    ["hitterPa", Q.hitterPaSql(W, H)],
    ["countMatrix", Q.countMatrixSql(W, H, "pitch_group = 'Breaking'")],
    ["countType", Q.countTypeSql(W, H)],
    ["countFlow", Q.countFlowSql(W, H)],
    ["breakdown", Q.breakdownSql(W, H, "count_bucket")],
    ["paBreakdown", Q.paBreakdownSql(W, H, "pa_first3_hs", "pa_pitch_count >= 3")],
    ["transition", Q.transitionSql(W, H)],
    ["pitchPoints", Q.pitchPointsSql(`${W} AND batter_name = '${H}'`)],
    ["paLog", Q.paLogSql(W, H, "count_str = '2-0'")],
    ["paDetail", Q.paDetailSql(firstPa)],
  ];
  for (const [name, sql] of panels) {
    try {
      const rows = await db.query(sql);
      const ok = rows.length > 0;
      console.log(`${ok ? "PASS" : "FAIL"} panel sql ${name}: ${rows.length} rows`);
      if (!ok) failures.push(`panel ${name} empty`);
    } catch (e) {
      console.log(`FAIL panel sql ${name}: ${(e as Error).message.split("\n")[0]}`);
      failures.push(`panel ${name}`);
    }
  }

  // Ask ABWizard offline parser: every starter question must produce SQL that passes the guard and runs.
  const hitters = (await db.query<{ batter_name: string }>("SELECT DISTINCT batter_name FROM enriched_pitches WHERE batter_team = 'ALA_CRI'")).map((r) => r.batter_name);
  for (const q of [...STARTER_QUESTIONS, "Does Mercer chase sliders down and away with two strikes after an elevated fastball?", "Who freezes the most on first pitch fastballs?"]) {
    const plan = planLocalQuery(q, { hitters, focusHitter: q.includes("Mercer") || q.startsWith("Who") ? null : "Tidwell, Jace" });
    const results: Record<string, Record<string, unknown>[]> = {};
    let err = "";
    for (const lq of [...plan.queries, { key: "viz", sql: plan.vizSql, purpose: "viz" }]) {
      const g = checkReadOnly(lq.sql);
      if (!g.ok) { err = `guard: ${g.error}`; break; }
      try { results[lq.key] = await db.query(scopeSql(g.sql, W)); } catch (e) { err = (e as Error).message.split("\n")[0]; break; }
    }
    const s = err ? null : summarizeLocal(plan, results);
    const ok = !err && (results.main?.length ?? 0) > 0;
    console.log(`${ok ? "PASS" : "FAIL"} local parser [${plan.kind}/${plan.metric}/${plan.visualization}] "${q}"\n     → ${err || s?.headline}`);
    if (!ok) failures.push(`local parser: ${q}`);
  }
  // Parser regressions from real coach questions.
  const planCase = async (q: string, focus: string | null, expect: (p: ReturnType<typeof planLocalQuery>, headline: string) => boolean) => {
    const plan = planLocalQuery(q, { hitters, focusHitter: focus });
    const results: Record<string, Record<string, unknown>[]> = {};
    for (const lq of plan.queries) results[lq.key] = await db.query(scopeSql(checkReadOnly(lq.sql).ok ? lq.sql : "SELECT 1", W));
    const head = summarizeLocal(plan, results).headline;
    const ok = expect(plan, head);
    console.log(`${ok ? "PASS" : "FAIL"} parser case "${q}"\n     → ${head}`);
    if (!ok) failures.push(`parser case: ${q}`);
  };
  await planCase("What pitch makes Jace freeze up the most in two strike counts", null, (p, h) =>
    p.hitter === "Tidwell, Jace" && p.groupBy === "pitch_type" && p.rank === "desc" && p.metric === "freeze" && !p.queries[0].sql.includes("loc_vertical") && /highest Freeze% .*by pitch type is/.test(h));
  await planCase("Who chases the most with two strikes?", "Tidwell, Jace", (p, h) => p.hitter === null && p.groupBy === "batter_name" && p.metric === "chase" && /by hitter is/.test(h));
  await planCase("Where does Mercer chase the most?", null, (p) => p.hitter === "Mercer, Cole" && p.groupBy === "location_label");
  await planCase("Which count does Okafor freeze the least in?", null, (p) => p.hitter === "Okafor, Miles" && p.groupBy === "count_str" && p.rank === "asc");

  for (const bad of ["DROP TABLE pitches", "SELECT 1; SELECT 2", "SELECT * FROM read_csv('x')", "COPY pitches TO 'x.csv'"]) {
    const g = checkReadOnly(bad);
    console.log(`${g.ok ? "FAIL" : "PASS"} guard rejects: ${bad}`);
    if (g.ok) failures.push(`guard allowed: ${bad}`);
  }

  // Snapshot round-trip (what the browser stores in IndexedDB): COPY TO CSV → read_csv back.
  const snap = join(tmpdir(), `abw-snap-${process.pid}.csv`);
  await db.exec(`COPY pitches_raw TO '${snap}' (FORMAT CSV, HEADER true, NULLSTR '\\N', QUOTE '"', ESCAPE '"')`);
  await check(
    "snapshot CSV round-trip is lossless",
    `SELECT (SELECT count(*) FROM pitches_raw) n, (SELECT count(*) FROM (SELECT * FROM pitches_raw EXCEPT SELECT * FROM ${readRawCsvSql(snap, true)})) diff`,
    (r) => Number(r.n) > 0 && Number(r.diff) === 0,
  );

  // Re-ingesting the same files must not duplicate pitches.
  await ingestCsvFiles(db, files.slice(0, 1));
  await check("dedupe after re-upload", "SELECT count(*) n, count(DISTINCT pitch_uid) u FROM enriched_pitches", (r) => Number(r.n) === Number(r.u));

  db.close();
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nAll pipeline checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
