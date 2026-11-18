@AGENTS.md

# ABWizard — Architectural Source of Truth

This file is the permanent architectural source of truth for ABWizard. Section A
records owner addenda and implementation decisions made since the original spec;
Section B is the original specification, preserved verbatim. Where A and B
disagree, **A wins**.

---

## A. Owner Addenda & Implementation Decisions (read first)

### A.1 Owner addenda (from the project owner, after the original spec)

1. **This is a tool for University of Alabama hitters.** CSVs contain at-bat data
   for many different hitters, so the app is organized around **hitter profiles**
   (roster → profile), like the sister app `luke33barnett-spec/Bama-Baseball-Stats`.
   TrackMan v3 exports contain both teams; by default only Alabama hitters
   (`BatterTeam = 'ALA_CRI'`, the same code the sister app uses) populate the roster.
   The team filter can be switched to "All batters" for opponent scouting.
2. **The point is count- and situation-specific behavior, not heat maps.** What do
   our hitters tend to do, and *when*? When do they **freeze** (take hittable
   strikes)? Count is critical, pitch type is critical. Heat maps are fine but
   secondary. Every profile leads with count/pitch-type/sequence analysis.
3. **Add graphics wherever they make the data clearer.**

### A.2 Implementation decisions (deviations from Section B, with reasons)

| Spec said | Built with | Why |
|---|---|---|
| Next.js 15 | **Next.js 16.4** (App Router, Turbopack, `cacheComponents`) | 15 is backport-only; the sister app already runs 16 on Vercel. Read `node_modules/next/dist/docs/` before changing framework code. |
| `next.config.mjs` webpack WASM rules | DuckDB-WASM bundles **self-hosted** from `public/duckdb/` (copied from `node_modules` by `scripts/copy-duckdb-assets.mjs` on `postinstall`/`prebuild`; gitignored) | No bundler WASM handling needed, works identically under Turbopack and on Vercel, no CDN dependency. |
| Claude 3.7 / 3.5 Sonnet, or OpenAI | **Two providers, chosen by server env: Gemini** (`@google/genai`, `GEMINI_API_KEY`, default `gemini-3.8-flash`, override `GEMINI_MODEL`) **or Claude** (`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, default `claude-sonnet-5-5`, override `ANTHROPIC_MODEL`). `AI_PROVIDER` picks when both keys are set (Claude otherwise). No OpenAI. | Owner asked for Gemini support; 3.x Sonnet models are retired. Both share one system prompt + tool specs (`src/lib/ai/prompt.ts`) and return the same provider-neutral turn, so the browser loop is provider-agnostic. Without a key, the Local Smart Query Parser + SQL Playground keep the app fully functional. |
| `shadcn/ui` via CLI | shadcn-style components written in `src/components/ui/` (Radix + `cva` + `tailwind-merge`) | The shadcn registry is unreachable from the build sandbox; the components follow the same copy-in-source pattern. |
| `enriched_pitches` SQL view | View `enriched_pitches_view` + **materialized table `enriched_pitches`** rebuilt after every ingest | Window functions (incl. cumulative sequence strings) are computed once, not on every scanner/query call. Always query `enriched_pitches`. |
| PapaParse / Apache Arrow ingestion | PapaParse → schema mapper → staging CSV → DuckDB **core `read_csv`** with explicit column types | In DuckDB-WASM 1.32 the JSON and Parquet readers are *runtime-downloaded extensions* (fetched from extensions.duckdb.org): they fail offline/behind proxies and leak requests to a third party. Extension autoloading is disabled; only core DuckDB is used. |
| OPFS / IndexedDB persistence | `pitches_raw` exported with core `COPY … (FORMAT CSV)`, **gzipped** (CompressionStream) and stored in **IndexedDB**; restored with the same `read_csv` path on load | Same core-only reason as above; round-trip losslessness is regression-tested. |
| — | Auto-Scout compares count/pitch-type habits to **teammates in the same cell**; sequence effects to the hitter's **complement** (his other comparable pitches) and they must also separate him from teammates | Removes universal effects ("everyone takes 3-0", "everyone Ks more after 0-1") so cards are hitter-specific. z-score thresholds tighten for small samples. |

### A.3 Metric vocabulary (used everywhere — UI, scanner, AI prompt)

Every rate is shown as `pct (num/den)`, e.g. `78.6% (11/14)`.

| Metric | Numerator / Denominator |
|---|---|
| Swing% | swings / pitches |
| Z-Swing% | swings on in-zone pitches / in-zone pitches |
| **Freeze%** | **takes on in-zone pitches / in-zone pitches** (= 1 − Z-Swing%) |
| Heart Freeze% | takes on `attack_zone='Heart'` / Heart pitches |
| Chase% | swings on out-of-zone pitches / out-of-zone pitches |
| Whiff% | whiffs / swings |
| CSW-taken | called strikes / takes |
| Looking K | PA-ending called strike three |
| Hard-Hit% | balls in play with EV ≥ 95 mph / balls in play with EV |
| Weak contact | in play with EV < 80 mph, or LA > 50° (popup) |

Count buckets (`count_bucket`): `First Pitch` (0-0), `Hitter Ahead` (1-0, 2-0, 3-0, 2-1, 3-1),
`Even` (1-1, 2-2), `Pitcher Ahead` (0-1, 0-2, 1-2), `Full` (3-2). `two_strikes` = strikes = 2.

Strike zone: rulebook approximation `|plate_loc_side| ≤ 0.83 ft`, `1.5 ≤ plate_loc_height ≤ 3.5 ft`.
Attack zones use normalized distance from zone center (Chebyshev, in half-zone units):
Heart ≤ 0.67, Shadow ≤ 1.33, Chase ≤ 2.0, else Waste. Horizontal location is stored both
in catcher's view (`plate_loc_side`, + = catcher's right / 1B side) and batter-relative
(`loc_horizontal_rel` ∈ In/Middle/Away, `inside_offset` + = inside).

### A.4 Code map

```
scripts/copy-duckdb-assets.mjs  copies DuckDB WASM + workers into public/duckdb
src/lib/schema-mapper.ts        TrackMan/TruMedia header aliases + value normalizers → NormalizedPitch
src/lib/duckdb.ts               client-only DuckDB-WASM singleton (Web Worker), query helpers
src/lib/sql/schema.ts           pitches DDL, enriched view SQL, schema description for the LLM
src/lib/ingest.ts               CSV files → mapper → DuckDB (dedupe by pitch_uid) → persistence
src/lib/persistence.ts          IndexedDB key/value wrapper (gzipped CSV snapshot lives in duckdb.ts)
src/lib/mock-data.ts            seeded synthetic TrackMan/TruMedia CSV generator w/ planted tendencies
src/lib/filters.ts              global filters → SQL WHERE
src/lib/metrics.ts              shared SQL metric fragments + formatters
src/lib/tendency-scanner.ts     deterministic Auto-Scout query suite + ranking
src/lib/local-query-parser.ts   offline NL → SQL builder (no API key)
src/lib/sql-guard.ts            read-only single-statement check + filter-scoping CTE for untrusted SQL
src/lib/ai/prompt.ts            server-only system prompt + provider-neutral tool specs (run_sql, present_answer)
src/lib/ai/providers.ts         server-only provider selection + Claude/Gemini callers (error mapping)
src/lib/ai/gemini-translate.ts  pure conversation ↔ Gemini contents translation (thought signatures preserved)
src/lib/ai/client.ts            browser tool-use loop (runs SQL locally, sends ≤100-row summaries)
scripts/verify-pipeline.ts      end-to-end regression checks (npm run verify:data)
scripts/verify-ai.ts            provider checks through the real SDKs with fetch stubbed (npm run verify:ai)
src/app/api/analyze/route.ts    Claude tool-use text-to-SQL relay (schema + question only; never raw CSV)
src/components/...              dashboard, hitter profile panels, StrikeZonePlot, workbench, PA inspector
```

### A.5 Data conventions worth knowing

- **PlateLocSide sign.** Alabama's real TrackMan exports put + toward **third base** (verified in the sister app against RelSide: RHP +1.38 ft, LHP −2.02 ft). The mapper checks each file: if right-handed pitchers' mean `RelSide` is positive it flips side into catcher's view; without `RelSide`, TrackMan files are assumed flipped and TruMedia/Statcast-style `PlateX` is taken as-is. The health modal shows which rule each file used.
- **Missing PA counters** (some TruMedia exports): a new PA starts when the half-inning or batter changes or the count resets to 0-0.
- **Dedupe:** `pitch_uid` = TrackMan `PitchUID`, else a synthesized game|inning|half|PA|pitch|batter key. The same game exported by both TrackMan and TruMedia is *not* merged (different game ids).
- **Team filter:** default `batter_team = 'ALA_CRI'`; the filter bar's "All" shows every batter (opponent scouting).
- **Base state** exists only when the export has runner columns (TruMedia); TrackMan rows have `base_state = NULL`.

### A.6 Verification

`npm run verify:data` runs `scripts/verify-pipeline.ts` with native DuckDB **1.4.3** (the same engine version as DuckDB-WASM 1.32.0): demo CSV → mapper → SQL, integrity checks on every derived column, every panel SQL builder, the Auto-Scout rediscovering each tendency planted in `mock-data.ts`, the offline parser on all starter questions, the SQL guard, and the snapshot round-trip. Run it after touching the mapper, SQL, scanner or parser. `npm run verify:ai` checks the AI providers offline (translation unit tests + the real SDKs and POST handler with `fetch` stubbed); run it after touching anything in `src/lib/ai/` or the route.

### A.7 Guardrails

- **Never** import `@duckdb/duckdb-wasm` in a Server Component or route handler. All DuckDB access goes through `src/lib/duckdb.ts`, which only runs in the browser.
- `/api/analyze` receives schema, distinct values, the question, and small aggregated result sets — never uploaded CSV payloads.
- LLM-generated SQL is validated client-side as a single read-only `SELECT`/`WITH` statement before execution, then wrapped in a CTE that shadows `enriched_pitches` with the global filters so the filter bar always applies.
- `/api/analyze`: model + system prompt + tools are fixed server-side (clients send only messages), bodies are size/count-capped, and `ABWIZARD_ACCESS_CODE` should be set on any public deployment. Claude: forced `tool_choice` is not used (rejected by current Claude models); tools are `strict`. Gemini: function calling mode `ANY` (every turn is a tool call), JSON-Schema declarations, and each model turn's raw `parts` travel with the conversation as a `gemini_parts` block (with the `model` that produced them) so `thoughtSignature`s are replayed verbatim to the same model — never strip or rebuild them. Overload handling: 503/5xx retried with backoff, then `GEMINI_FALLBACK_MODELS` (default `gemini-3.7-flash,gemini-flash-lite-latest`) for a new question only; 429 and per-request timeouts (`GEMINI_ATTEMPT_TIMEOUT_MS`, default 40 s) move to the next model; 404 fallbacks are skipped; a model that rejects `thinkingLevel` is retried without it. Default `GEMINI_THINKING_LEVEL=low` (fast; SQL doesn't need deep thinking). The chain has a 110 s budget per turn under the route's `maxDuration = 300` (Vercel's Fluid-compute default and Hobby maximum) so the app — not the platform — always answers, with a readable error if Google is down.
- Never re-enable DuckDB extension autoloading; stick to core SQL (CSV, window functions, lists).

---

## B. Original Specification (verbatim)

# Project Specification: ABWizard (`luke33barnett-spec/ABWizard`)
**Alabama Baseball Hitter Sequence, Tunnel & Tendency Intelligence Web App**

## 1. Repository & Deployment Context
- **GitHub Repository:** `https://github.com/luke33barnett-spec/ABWizard`
- **Target Hosting:** Vercel (Next.js App Router).
- **Initial Action Required:** First, inspect the current workspace (`git status`, `git remote -v`, `ls -la`). Save this entire specification into a `CLAUDE.md` file at the root of `luke33barnett-spec/ABWizard` so it serves as our permanent architectural source of truth.

## 2. Role & Product Vision
You are a Lead Full-Stack Engineer and MLB/NCAA Baseball Quantitative Architect. We are building **ABWizard** for **Alabama Baseball**—an analytical web application that ingests multi-file pitch-by-pitch CSV exports (TruMedia and TrackMan schemas) across large sample sizes of Plate Appearances (PAs) for a hitter (or opposing scouting target).

Standard slash lines and basic heatmaps miss the sequential story of an At-Bat. ABWizard is engineered to uncover **micro-sequencing tendencies, pitch-to-pitch state transitions, tunnel vulnerabilities, and count-leverage habits** (e.g., *"Over 180 PAs, Hitter X takes a curveball 88% of the time in a 2-0 count, and chases 0-2 sliders down-and-away 64% of the time ONLY when preceded by an elevated four-seam fastball"*).

The application features three core pillars:
1. **Multi-CSV Ingestion & Sequence Enrichment Engine:** Normalizes TruMedia/TrackMan CSVs and automatically computes lag/lead pitch sequencing state within each Plate Appearance.
2. **Automated Pattern Discovery Engine ("Tendency Scanner"):** Scans the loaded sample size to automatically surface statistically notable outliers, predictable take/swing habits, and multi-pitch tunnel traps without the user needing to know what to ask first.
3. **Open-Ended Natural Language Scouting Query Interface ("Ask ABWizard"):** A conversational analytical interface where coaches or analysts can ask arbitrary, complex sequencing questions in plain English. The system translates the question into SQL against the full in-browser pitch database, executes the exact query, and renders both natural-language scouting insights and interactive visual breakdowns (Strike Zone plots, Sankey sequence flows, and filterable pitch tables).

---

## 3. Tech Stack & Vercel-Safe Architecture
Because we are deploying to **Vercel**, we must strictly avoid uploading massive CSV payloads to serverless functions or running heavy tabular aggregations on the server.
- **Framework:** Next.js 15 (App Router), TypeScript (Strict mode), Tailwind CSS, `shadcn/ui` components, Lucide icons.
- **Client-Side Analytical Database:** `@duckdb/duckdb-wasm` (`>=1.30.0`, running strictly in a client-side Web Worker—NEVER import or instantiate DuckDB in Next.js server components or API routes). Use OPFS / IndexedDB persistence so uploaded CSV datasets persist across page reloads.
- **CSV Parsing & Normalization Fallback:** PapaParse / Apache Arrow for fast ingestion into DuckDB-WASM tables.
- **Visualizations:** `recharts` or `@visx` + custom SVG **Baseball Strike Zone Plot** (from Catcher/Umpire perspective, with standard 9-zone + Shadow/Heart/Chase/Waste Statcast attack zones) and Pitch Sequence Transition tables.
- **AI / Open-Ended Query Engine:** Next.js Server Route (`/api/analyze`) using the Anthropic SDK (Claude 3.7 Sonnet / Claude 3.5 Sonnet) or OpenAI SDK with **Tool Use (Text-to-DuckDB-SQL)**.
  - *Crucial Architectural Flow:* The user submits a natural language question -> The client sends ONLY the table schema, distinct column values (e.g., unique pitch types, pitch calls), and the user's question to `/api/analyze` -> The LLM returns a parameterized DuckDB SQL query -> The client executes the SQL locally against `@duckdb/duckdb-wasm` -> The aggregated result table (small JSON summary) is sent back to `/api/analyze` (or interpreted directly) to render the final Scouting Insight Card, Strike Zone visual, and supporting PA breakdown.

---

## 4. Data Schema Normalization & Sequence Window Engineering
Baseball CSVs from **TruMedia** and **TrackMan** have varying column headers. Build a resilient schema mapper (`src/lib/schema-mapper.ts`) that maps common column variations into a unified DuckDB table named `pitches`:

### Core Normalized Columns:
- **Identifiers:** `game_id`, `game_date`, `pitcher_name`, `pitcher_throws` (`R`/`L`), `batter_name`, `batter_id`, `batter_side` (`R`/`L`), `inning`, `top_bottom`, `pa_of_inning`, `pitch_of_pa`.
  - *Synthesized Unique PA Key:* Construct `pa_uid = CONCAT(game_date, '_', game_id, '_', inning, '_', top_bottom, '_', pa_of_inning, '_', batter_name)` so every Plate Appearance is cleanly isolated even across 20+ merged CSV files.
- **Count & Base/Out State:** `balls` (0-3), `strikes` (0-2), `count_str` (e.g., `'2-0'`), `outs` (0-2), `runners_on` / `base_state`.
- **Pitch Classification & Outcome:**
  - `pitch_type` (Normalized to: `FF` [4-Seam], `SI` [Sinker/2-Seam], `FC` [Cutter], `SL` [Slider], `ST` [Sweeper], `CU` [Curveball], `CH` [Changeup], `FS` [Splitter]).
  - `pitch_group` (`Fastball`, `Breaking`, `Offspeed`).
  - `pitch_call` (Normalized from TrackMan/TruMedia: `InPlay`, `StrikeCalled`, `StrikeSwinging`, `FoulBall`, `BallCalled`, `HitByPitch`).
  - `is_swing` (Boolean: `TRUE` if `StrikeSwinging`, `FoulBall`, or `InPlay`).
  - `is_whiff` (Boolean: `TRUE` if `StrikeSwinging`).
  - `is_take` (Boolean: `NOT is_swing`).
  - `is_chase` (Boolean: `is_swing = TRUE AND in_zone = FALSE`).
  - `play_result` (`Single`, `Double`, `Triple`, `HomeRun`, `Out`, `Sacrifice`, `Error`, `Walk`, `Strikeout`).
- **Spatial & Physics Metrics:** `rel_speed` (Velo), `induced_vert_break` (IVB), `horz_break` (HB), `plate_loc_side` (Horizontal location in feet), `plate_loc_height` (Vertical location in feet), `in_zone` (Boolean: standard rulebook strike zone height `1.5` to `3.5` ft, width `-0.83` to `0.83` ft), `attack_zone` (`Heart`, `Shadow`, `Chase`, `Waste`), `exit_speed` (EV), `launch_angle` (LA).
- **Optional Video Link Column:** `video_url` or `clip_id` (if present in TruMedia export, preserve it so rows can deep-link to video clips later).

### Derived Sequential Window Columns (Pre-computed via DuckDB SQL View `enriched_pitches`):
Automatically create an enriched SQL view using `OVER (PARTITION BY pa_uid ORDER BY pitch_of_pa ASC)` that appends:
- `prev_pitch_type` (`LAG(pitch_type, 1)`), `prev_2_pitch_type` (`LAG(pitch_type, 2)`)
- `prev_pitch_group` (`LAG(pitch_group, 1)`)
- `prev_pitch_call` (`LAG(pitch_call, 1)`), `prev_is_swing` (`LAG(is_swing, 1)`)
- `prev_plate_loc_side`, `prev_plate_loc_height`, `prev_rel_speed`, `prev_attack_zone`
- `velo_delta_from_prev` (`rel_speed - LAG(rel_speed, 1)`)
- `vertical_tunnel_delta` (`plate_loc_height - LAG(plate_loc_height, 1)`)
- `horizontal_tunnel_delta` (`plate_loc_side - LAG(plate_loc_side, 1)`)
- `pitch_sequence_str` (Cumulative string of the AB up to the current pitch, e.g., `'FF (Take) -> SL (Swing) -> CU'`)
- `is_first_pitch_of_pa` (`pitch_of_pa = 1`), `is_pa_terminal_pitch` (Last pitch of the PA).

---

## 5. Core Feature Specifications

### Feature A: Multi-CSV Drag-and-Drop Ingestion & Hitter Selector
- Allow users to drag-and-drop 1 to 50+ CSV files simultaneously, or load a built-in **"Demo Alabama Hitter Dataset"** (generate a realistic 600-pitch synthetic TrackMan/TruMedia CSV generator in `src/lib/mock-data.ts` with planted sequencing tendencies so we can test immediately).
- Display an instant **Dataset Health & Schema Mapping Modal** showing total PAs, total pitches, date range, detected hitters, and mapped columns.
- Provide a global filter bar: **Select Hitter**, **Pitcher Handedness (`vs RHP` / `vs LHP` / `All`)**, **Date Range**, and **Minimum Sample Size Threshold (e.g., `Min 5 Pitches`)**.

### Feature B: Automated Tendency & Sequence Discovery Engine ("Auto-Scout")
Without typing a single prompt, clicking **"Run Sequence Scan"** executes a suite of parameterized analytical SQL queries across `enriched_pitches` and ranks the top statistically notable tendencies as **Scouting Insight Cards**, categorized into:
1. **Count & Pitch-Type Take/Swing Locks:** E.g., *"In 2-0 and 3-1 counts, takes Breaking Balls 91.7% of the time (11/12 pitches)."* or *"First-pitch Fastball in the Heart zone: 18% swing rate (Passivity Alert)."*
2. **2-Pitch Tunnel Vulnerabilities (`Prev Pitch -> Current Pitch`):** Identifies pairs where Whiff% or Chase% spikes dramatically compared to the hitter's baseline against that pitch alone (e.g., *"Chases Changeups below the zone at 58% when immediately preceded by an elevated 4-Seam Fastball, vs. 21% baseline"*).
3. **Pitch-to-Pitch Sightline & Velo Differential Traps:** Evaluates how the hitter reacts when `velo_delta_from_prev <= -8 mph` or when location shifts from `Up-and-In` to `Down-and-Away`.
4. **3-Pitch Sequence Archetypes:** Groups full AB progressions (e.g., `Hard -> Hard -> Soft` vs `Soft -> Hard`) and flags which sequence produces the highest Weak Contact / Strikeout rate.
- Every Insight Card must display: **Headline Insight**, **Confidence/Sample Badge (`n = 18 pitches across 14 PAs`)**, **Baseline Delta (`+34% vs Hitter Avg`)**, and a **"Visualize & Inspect PAs"** button that plots those exact pitches on the Strike Zone and opens the underlying pitch-by-pitch log.

### Feature C: Open-Ended Query Interface ("Ask ABWizard")
A dedicated, high-speed analytical workbench where a coach or analyst can ask arbitrary questions in plain English:
- *Example Starter Chips:*
  - *"In 2-0 or 1-0 counts, how often does he take a curveball or slider, and what happens the rest of the AB?"*
  - *"What 2-pitch sequence gets the highest whiff rate against him with 2 strikes?"*
  - *"How does he react to a fastball up after seeing a breaking ball down-and-away?"*
  - *"Show me every PA where he saw 3+ breaking balls in a row."*
- **Execution Architecture:**
  1. User submits prompt.
  2. System generates the exact DuckDB SQL query against `enriched_pitches` (show a collapsible *"View Generated SQL & Logic"* drawer for transparency and verification).
  3. DuckDB executes the query in the browser and returns the exact rows/aggregations.
  4. The UI renders:
     - **Executive Scouting Answer:** Direct, numbers-first answer citing exact fractions and percentages (e.g., `14-for-16 (87.5%)`).
     - **Dynamic Visual Panel:** Automatically switches between a **Strike Zone Location Plot** (colored by Pitch Type or Swing/Take result, with optional dashed vectors connecting `prev_plate_loc` -> `current_plate_loc` to show the 2-pitch tunnel), a **Count Matrix Heatmap**, or a **Sequence Breakdown Bar Table**.
     - **Drill-Down PA Inspector:** Clicking any row or pitch dot opens the full pitch-by-pitch sequence of that specific Plate Appearance (`Pitch 1 -> Pitch 2 -> Pitch 3...`) so the user can see the entire context of the AB.

---

## 6. UI/UX & Branding Guidelines
- **Aesthetic:** Clean, high-density institutional sports-analytics dark mode interface inspired by TruMedia, Baseball Savant, and Bloomberg Terminal, accented with **Alabama Crimson Tide** branding (`#9E1B32` Crimson, `#828A8F` Capstone Gray, crisp `#090D16` slate backgrounds, monospace tabular numbers `font-mono` for all velocities, counts, and percentages).
- **Zero Fluff:** Coaches and analysts need scannable metrics. Every percentage must always be paired with its raw numerator/denominator in parentheses, e.g., `78.6% (11/14)`.

---

## 7. Phased Implementation Plan for Claude Code
Execute this build systematically in the `luke33barnett-spec/ABWizard` repository. Complete and verify each phase before moving to the next:

- **Phase 1: Repository Setup & Architecture Foundation**
  1. Write this specification to `CLAUDE.md`.
  2. Initialize Next.js (TypeScript, Tailwind, `shadcn/ui`, Lucide) if the repo is empty, or audit existing files.
  3. Configure `next.config.mjs` with proper WebAssembly headers/webpack rules so `@duckdb/duckdb-wasm` runs cleanly in client-side Web Workers and builds without SSR errors on Vercel.
- **Phase 2: Schema Mapper, DuckDB-WASM Engine & Synthetic TrackMan/TruMedia Generator**
  1. Build `src/lib/schema-mapper.ts` and the DuckDB-WASM client singleton (`src/lib/duckdb.ts`).
  2. Build the SQL initialization script that creates `pitches` and the windowed `enriched_pitches` view (`LAG`/`LEAD` sequencing columns).
  3. Create `src/lib/mock-data.ts` that generates a realistic 800-pitch dataset for sample hitters with deliberate, discoverable sequencing tendencies (e.g., taking 2-0 curveballs 85% of the time, chasing 0-2 sliders after elevated fastballs) so the app is immediately testable out of the box.
- **Phase 3: Automated Tendency Scanner & Interactive Strike Zone UI**
  1. Build the dashboard layout: Hitter/Handedness header filters, CSV Dropzone, and KPI summary bar.
  2. Build the SVG Strike Zone Visualizer (`src/components/StrikeZonePlot.tsx`) with toggleable "Show Previous Pitch Tunnel Vector" lines.
  3. Build the deterministic SQL query suite (`src/lib/tendency-scanner.ts`) that scans `enriched_pitches` and populates the ranked Scouting Insight Cards.
- **Phase 4: Open-Ended Query Interface ("Ask ABWizard") & PA Sequence Drawer**
  1. Build the natural language query interface (`src/components/QueryWorkbench.tsx`) and `/api/analyze` route.
  2. Include a fallback "Local Smart Query Parser / SQL Builder" mode when an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is not yet set in `.env.local`, plus a Direct SQL Playground tab so the app works 100% offline or with AI keys enabled.
  3. Build the interactive **PA Sequence Inspector Drawer** that shows the pitch-by-pitch story of any clicked Plate Appearance.
- **Phase 5: Build Verification & Git Commit**
  1. Run `npm run build` and `npm run lint` to ensure zero TypeScript or Next.js SSR build errors for Vercel deployment.
  2. Commit the foundation cleanly to the repository.
