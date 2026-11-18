/** Prints the Auto-Scout board for the demo dataset. Run: npx tsx scripts/scan-demo.ts [hitter] */
import { generateDemoFiles } from "../src/lib/mock-data";
import { ingestCsvFiles } from "../src/lib/ingest";
import { runTendencyScan } from "../src/lib/tendency-scanner";
import { buildWhere, DEFAULT_FILTERS } from "../src/lib/filters";
import { createNodeDb } from "./node-db";

async function main() {
  const db = await createNodeDb();
  await ingestCsvFiles(db, generateDemoFiles());
  const t0 = Date.now();
  const insights = await runTendencyScan((s) => db.query(s), { globalWhere: buildWhere(DEFAULT_FILTERS), hitter: process.argv[2] ?? null, minN: 5 });
  console.log(`${insights.length} insights in ${Date.now() - t0}ms`);
  const byHitter = new Map<string, typeof insights>();
  for (const i of insights) byHitter.set(i.hitter, [...(byHitter.get(i.hitter) ?? []), i]);
  for (const [h, list] of byHitter) {
    console.log(`\n=== ${h} (${list.length})`);
    for (const i of list.slice(0, 9)) console.log(`  [${i.category}] ${i.headline}  | ${i.subline} | z=${i.z.toFixed(1)} ${i.confidence}`);
  }
  db.close();
}
main();
