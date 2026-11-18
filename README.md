# ABWizard — Alabama Baseball hitter sequence, count & freeze intelligence

ABWizard turns pitch-by-pitch TrackMan / TruMedia CSV exports into a profile for every Alabama hitter, focused on **what each hitter does in specific counts and situations**: when he swings, when he **freezes** on hittable strikes, what pulls him out of the zone, and which two-pitch tunnels and velocity changes beat him.

All pitch data stays in the browser. CSVs are parsed and queried locally with **DuckDB-WASM** and saved in IndexedDB. The only thing that ever reaches a server is the optional AI route, and it only receives the schema, the question, and small result summaries.

> Architectural source of truth: [`CLAUDE.md`](./CLAUDE.md) (original spec + owner addenda + implementation decisions).

## What's in it

| Page | What it answers |
|---|---|
| **Team** | Roster table (PA, slash line, K%, looking K%, BB%, Swing%, **Freeze%**, Heart Freeze%, Chase%, Whiff%, 1st-pitch swing%, 2-strike whiff%, Hard-Hit%), each cell tinted vs the roster average. |
| **Hitter profile** (`/hitters/[name]`) | **Counts**: 12-count matrix (swing/take/freeze/chase/whiff/foul/hard-hit, any pitch type) vs teammates in the same count, count × pitch-type grid, and a count-flow diagram of how his PAs move and end. **Freeze Report**: freeze% by count, pitch type, previous pitch, two-strike location, zone, plus every called third strike. **Sequencing & Tunnels**: previous → current pitch matrix, reaction after whiffs, freezes and takes, velo-gap traps, Hard/Soft archetypes. **Situational**: vs RHP/LHP, outs, runners, PA # in game, repeat looks, innings. **Auto-Scout**, **Zone**, and **PA Log** tabs. |
| **Auto-Scout** | One click runs 31 parameterized SQL probes and ranks hitter-specific findings with significance tests. Findings are grouped into count locks, freeze alerts, chase triggers, 2-pitch tunnels, velo/sightline traps, sequence archetypes, first-pitch, two-strike, situational, and damage. Every card shows `pct (num/den)`, the sample, the delta vs its baseline, and **Visualize & Inspect PAs**. |
| **Ask ABWizard** | Ask a question in plain English and get the DuckDB SQL behind the answer, run in the browser: an executive answer, a strike zone / count matrix / bar visual, and the generated SQL drawer. It uses Claude if `ANTHROPIC_API_KEY` is set and an offline **Local Smart Query Parser** otherwise. It also has a **SQL Playground**. |
| **Data** | CSV drop zone (1–50+ files), dataset health and schema-mapping report, column dictionary, clear data. |

Clicking any pitch, count cell, bar or row opens the **PA Sequence Inspector**: a numbered pitch-by-pitch replay on the strike zone with velo, location, call, and result.

## Getting started

```bash
npm install          # also copies the DuckDB-WASM bundles into public/duckdb
npm run dev          # http://localhost:3000
```

Click **Load Demo Alabama Hitter Dataset**, a seeded, simulated 40-game season with fictional hitters and planted tendencies, or drop real exports.

Optional, in `.env.local` (see `.env.example`):

```bash
ANTHROPIC_API_KEY=...          # enables Claude in Ask ABWizard
ABWIZARD_ACCESS_CODE=...       # recommended on any public URL
# ANTHROPIC_MODEL=claude-sonnet-5-5
```

## Checks

```bash
npm run lint
npm run typecheck
npm run verify:data   # demo CSVs → mapper → DuckDB (native 1.4.3, same engine as the browser) → every derived column,
                      # every panel query, the Auto-Scout re-finding each planted tendency, the offline parser, SQL guard
npm run build
```

## Deploying to Vercel

1. Import `luke33barnett-spec/ABWizard` in Vercel (framework preset: Next.js, default build command).
2. Optionally set `ANTHROPIC_API_KEY` and `ABWIZARD_ACCESS_CODE` under **Settings → Environment Variables**.
3. Deploy. The DuckDB-WASM bundles are copied from `node_modules` during `postinstall`/`prebuild`, so nothing large is committed.

## Data notes

- **TrackMan v3** exports contain both teams. By default only Alabama batters (`BatterTeam = ALA_CRI`) appear; switch **Batters → All** to scout opponents.
- **PlateLocSide** in Alabama's TrackMan exports is positive toward **third base**. The mapper detects this per file from `RelSide` and normalizes everything to the catcher's view (+ = first-base side). Inside and away are always computed relative to the hitter.
- **TruMedia** exports without PA or pitch counters are reconstructed from batter changes and count resets. "First Last" names merge with TrackMan's "Last, First".
- Re-uploading overlapping files is safe: pitches are de-duplicated by `PitchUID` (or a synthesized key).
- Runner and base-state splits only appear for exports that include runner columns.

## Stack

Next.js 16 (App Router, Turbopack, Cache Components) · TypeScript strict · Tailwind CSS 4 · shadcn-style components on Radix · Lucide · DuckDB-WASM 1.32 (core features only, no runtime extension downloads) · PapaParse · Anthropic SDK (tool use, strict tools).
