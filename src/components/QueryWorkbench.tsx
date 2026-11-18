"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Code2, Cpu, Loader2, Play, Send, Sparkles } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RateText } from "@/components/ui/rate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Markdown } from "@/components/ask/Markdown";
import { ResultVisual } from "@/components/ask/ResultVisual";
import { DataTable } from "@/components/ask/DataTable";
import { CsvDropzone } from "@/components/data/CsvDropzone";
import { askClaude, getAnalyzeStatus, runGuarded, type AskOutcome, type AskStep, type Visualization } from "@/lib/ai/client";
import { planLocalQuery, STARTER_QUESTIONS, summarizeLocal } from "@/lib/local-query-parser";
import { DISTINCT_VALUE_COLUMNS } from "@/lib/sql/schema";
import { describeFilters } from "@/lib/filters";
import { displayName } from "@/lib/metrics";
import type { Row } from "@/lib/ingest";
import { cn } from "@/lib/utils";

interface Entry extends AskOutcome {
  id: number;
  question: string;
  ms: number;
  notice?: string;
}

const ACCESS_KEY = "abwizard.accessCode";

function distinctSql(where: string): string {
  return DISTINCT_VALUE_COLUMNS.map(
    (c) => `SELECT '${c}' AS col, CAST(${c} AS VARCHAR) AS v, count(*) AS n FROM enriched_pitches WHERE ${where} AND ${c} IS NOT NULL GROUP BY ALL`,
  ).join("\nUNION ALL\n");
}

const PLAYGROUND_EXAMPLES: { label: string; sql: string }[] = [
  {
    label: "Take% on breaking balls by count, per hitter",
    sql: `SELECT batter_name, count_str,
  count(*) FILTER (WHERE is_take) AS num,
  count(*) AS den
FROM enriched_pitches
WHERE pitch_group = 'Breaking'
GROUP BY ALL
ORDER BY batter_name, count_str`,
  },
  {
    label: "Freeze% by count (count matrix)",
    sql: `SELECT count_str,
  count(*) FILTER (WHERE is_take) AS num,
  count(*) AS den
FROM enriched_pitches
WHERE in_zone
GROUP BY 1`,
  },
  {
    label: "2-strike chases after an elevated FF (strike zone)",
    sql: `SELECT pitch_uid, pa_uid, batter_name, count_str, pitch_type, pitch_group, pitch_call,
  plate_loc_side, plate_loc_height, prev_pitch_type, prev_plate_loc_side, prev_plate_loc_height,
  is_swing AS highlight
FROM enriched_pitches
WHERE two_strikes AND NOT in_zone
  AND prev_pitch_type = 'FF' AND prev_loc_vertical = 'Up'`,
  },
  {
    label: "Whiff% by previous → current pitch (bar)",
    sql: `SELECT prev_pitch_type || ' → ' || pitch_type AS label,
  count(*) FILTER (WHERE is_whiff) AS num,
  count(*) FILTER (WHERE is_swing) AS den
FROM enriched_pitches
WHERE prev_pitch_type IS NOT NULL
GROUP BY 1 HAVING den >= 10
ORDER BY num::DOUBLE / den DESC`,
  },
];

function guessViz(rows: Row[]): Visualization {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  if (cols.includes("plate_loc_side") && cols.includes("plate_loc_height")) return "strike_zone";
  if (cols.includes("count_str") && cols.includes("num") && cols.includes("den") && cols.length <= 4) return "count_matrix";
  if (cols.includes("num") && cols.includes("den") && cols.length <= 4) return "bar";
  return "table";
}

export function QueryWorkbench() {
  const { status, hitters, where, filters, query } = useData();
  const [ai, setAi] = useState<{ enabled: boolean; model: string; requiresAccessCode: boolean } | null>(null);
  const [forceLocal, setForceLocal] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [focus, setFocus] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AskStep[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState(false);
  const [sql, setSql] = useState(PLAYGROUND_EXAMPLES[0].sql);
  const [scoped, setScoped] = useState(true);
  const [pg, setPg] = useState<{ rows: Row[]; error?: string; ms: number } | null>(null);
  const [tab, setTab] = useState("ask");

  useEffect(() => {
    let cancelled = false;
    getAnalyzeStatus().then((s) => {
      if (cancelled) return;
      setAi(s);
      try {
        setAccessCode(localStorage.getItem(ACCESS_KEY) ?? "");
      } catch {
        /* storage blocked */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const distinct = useDuckQuery<{ col: string; v: string; n: number }>(status === "ready" ? distinctSql(where) : null);
  const contextBlock = useMemo(() => {
    const byCol = new Map<string, string[]>();
    for (const r of distinct.data ?? []) {
      const list = byCol.get(r.col) ?? [];
      list.push(`${r.v} (${Number(r.n)})`);
      byCol.set(r.col, list);
    }
    const pitches = hitters.reduce((s, h) => s + h.pitches, 0);
    const pas = hitters.reduce((s, h) => s + h.pas, 0);
    return [
      "<dataset_context>",
      `Active filters, already applied to enriched_pitches: ${describeFilters(filters)}.`,
      `In scope: ${pitches} pitches, ${pas} plate appearances, ${hitters.length} hitters.`,
      `Focus hitter: ${focus ? `${focus} (the question's "he"/"him")` : "none — answer across hitters in scope unless the question names one"}.`,
      `Hitters (PAs): ${hitters.map((h) => `${h.batter_name} (${h.pas})`).join("; ")}`,
      "Distinct values (pitches):",
      ...[...byCol.entries()].map(([c, vals]) => `- ${c}: ${vals.slice(0, 30).join(", ")}`),
      "</dataset_context>",
    ].join("\n");
  }, [distinct.data, hitters, filters, focus]);

  const useClaude = !!ai?.enabled && !forceLocal;
  const last = entries[0];
  const canFollowUp = useClaude && last?.mode === "claude" && !!last.messages;

  async function runLocal(q: string, notice?: string): Promise<Entry> {
    const t0 = performance.now();
    const plan = planLocalQuery(q, { hitters: hitters.map((h) => h.batter_name), focusHitter: focus || null });
    const results: Record<string, Row[]> = {};
    const steps: AskStep[] = [];
    for (const lq of plan.queries) {
      const out = await runGuarded(query, lq.sql, where);
      steps.push({ sql: lq.sql, purpose: lq.purpose, rowCount: out.rows.length, error: out.error });
      results[lq.key] = out.rows;
    }
    const viz = await runGuarded(query, plan.vizSql, where);
    const s = summarizeLocal(plan, results);
    return {
      id: Date.now(),
      question: q,
      ms: performance.now() - t0,
      mode: "local",
      ...s,
      visualization: plan.visualization,
      vizSql: plan.vizSql,
      vizRows: viz.rows,
      vizError: viz.error,
      logic: plan.logic,
      steps,
      notice,
    };
  }

  async function ask(qRaw: string) {
    const q = qRaw.trim();
    if (!q || busy || status !== "ready") return;
    setBusy(true);
    setError(null);
    setProgress([]);
    try {
      let entry: Entry;
      if (useClaude) {
        const t0 = performance.now();
        try {
          const out = await askClaude({
            question: q,
            contextBlock,
            where,
            query,
            accessCode: accessCode || undefined,
            prior: followUp && canFollowUp ? last.messages : undefined,
            onStep: (s) => setProgress((p) => [...p, s]),
          });
          entry = { ...out, id: Date.now(), question: q, ms: performance.now() - t0 };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          entry = await runLocal(q, `Claude was unavailable (${msg}). Answered with the local parser instead.`);
        }
      } else {
        entry = await runLocal(q);
      }
      setEntries((e) => [entry, ...e].slice(0, 20));
      setQuestion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPlayground() {
    const t0 = performance.now();
    const out = await runGuarded(query, sql, scoped ? where : "TRUE", 10000);
    setPg({ ...out, ms: performance.now() - t0 });
  }

  if (status === "empty") {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-4 text-xl font-semibold">Ask ABWizard</h1>
        <CsvDropzone />
      </div>
    );
  }

  const chips = STARTER_QUESTIONS.map((s) => (focus ? s : s.replace(/\bhe\b|\bhim\b/g, (w) => (w === "he" ? "each hitter" : "them"))));
  const pgViz = pg && !pg.error ? guessViz(pg.rows) : "table";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ask ABWizard</h1>
          <p className="mt-1 text-xs text-ink-3">
            Plain-English questions → DuckDB SQL → run in this browser on {describeFilters(filters)}. Only the schema, your question and small result summaries leave the
            browser.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {ai === null ? (
            <Badge tone="neutral">checking AI…</Badge>
          ) : useClaude ? (
            <Badge tone="crimson">
              <Bot className="size-3" aria-hidden /> Claude · {ai.model}
            </Badge>
          ) : (
            <Badge tone="info">
              <Cpu className="size-3" aria-hidden /> Local Smart Query Parser{ai?.enabled ? "" : " (no API key)"}
            </Badge>
          )}
          {ai?.enabled ? (
            <label className="inline-flex items-center gap-1.5 text-ink-3">
              <input type="checkbox" checked={forceLocal} onChange={(e) => setForceLocal(e.target.checked)} className="accent-[var(--color-crimson)]" /> Force offline parser
            </label>
          ) : null}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="ask">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-4" aria-hidden /> Ask
            </span>
          </TabsTrigger>
          <TabsTrigger value="sql">
            <span className="inline-flex items-center gap-1.5">
              <Code2 className="size-4" aria-hidden /> SQL Playground
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ask" className="space-y-4">
          <Card>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-ink-3">
                  Focus hitter (“he”)
                  <select value={focus} onChange={(e) => setFocus(e.target.value)} className="h-7 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink">
                    <option value="">None — all hitters in scope</option>
                    {hitters.map((h) => (
                      <option key={h.batter_name} value={h.batter_name}>
                        {displayName(h.batter_name)}
                      </option>
                    ))}
                  </select>
                </label>
                {ai?.requiresAccessCode && useClaude ? (
                  <label className="flex items-center gap-2 text-xs text-ink-3">
                    Access code
                    <input
                      type="password"
                      value={accessCode}
                      onChange={(e) => {
                        setAccessCode(e.target.value);
                        try {
                          localStorage.setItem(ACCESS_KEY, e.target.value);
                        } catch {
                          /* ignore */
                        }
                      }}
                      className="h-7 w-32 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink"
                    />
                  </label>
                ) : null}
                {canFollowUp ? (
                  <label className="inline-flex items-center gap-1.5 text-xs text-ink-3">
                    <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} className="accent-[var(--color-crimson)]" /> Follow-up to the last answer
                  </label>
                ) : null}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask(question);
                }}
                className="flex gap-2"
              >
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void ask(question);
                    }
                  }}
                  rows={2}
                  placeholder="e.g. In 2-0 or 1-0 counts, how often does Tidwell take a curveball or slider, and what happens the rest of the AB?"
                  className="min-h-[3.25rem] flex-1 resize-y rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-crimson-text"
                  aria-label="Question"
                />
                <Button type="submit" variant="primary" size="lg" disabled={busy || !question.trim() || status !== "ready"} className="self-stretch">
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />} Ask
                </Button>
              </form>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setQuestion(c);
                      void ask(c);
                    }}
                    className="rounded-full border border-line-strong px-2.5 py-1 text-left text-xs text-ink-2 hover:border-crimson-text hover:text-ink disabled:opacity-50"
                  >
                    {c}
                  </button>
                ))}
              </div>
              {busy ? (
                <div className="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2" role="status">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin text-crimson-text" aria-hidden /> {useClaude ? "Claude is writing and running SQL in your browser…" : "Parsing and running locally…"}
                  </div>
                  {progress.map((s, i) => (
                    <div key={i} className="num mt-1 truncate text-ink-3">
                      {i + 1}. {s.purpose || "query"} → {s.error ? "error, retrying" : `${s.rowCount} rows`}
                    </div>
                  ))}
                </div>
              ) : null}
              {error ? <p className="text-sm text-[#f08080]">{error}</p> : null}
            </CardBody>
          </Card>

          {entries.map((e) => (
            <AnswerCard
              key={e.id}
              e={e}
              minN={filters.minN}
              where={where}
              onOpenSql={(s) => {
                setSql(s);
                setTab("sql");
              }}
            />
          ))}
          {entries.length === 0 && !busy ? <p className="text-xs text-ink-3">Ask a question or tap a starter. Answers show the exact SQL that produced every number.</p> : null}
        </TabsContent>

        <TabsContent value="sql" className="space-y-4">
          <Card>
            <CardHeader
              title="Direct SQL Playground"
              subtitle="Read-only DuckDB SQL against enriched_pitches (the Data page lists every column). Return plate_loc_* for a strike zone, count_str+num+den for a count matrix, label+num+den for bars."
              actions={
                <select
                  onChange={(e) => {
                    const ex = PLAYGROUND_EXAMPLES[Number(e.target.value)];
                    if (ex) setSql(ex.sql);
                  }}
                  defaultValue=""
                  className="h-7 rounded-md border border-line-strong bg-surface-2 px-2 text-xs text-ink"
                  aria-label="Example queries"
                >
                  <option value="" disabled>
                    Examples…
                  </option>
                  {PLAYGROUND_EXAMPLES.map((ex, i) => (
                    <option key={ex.label} value={i}>
                      {ex.label}
                    </option>
                  ))}
                </select>
              }
            />
            <CardBody className="space-y-3">
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void runPlayground();
                  }
                }}
                rows={9}
                spellCheck={false}
                className="num w-full resize-y rounded-md border border-line-strong bg-bg px-3 py-2 text-xs leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-crimson-text"
                aria-label="SQL"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={() => void runPlayground()} disabled={status !== "ready"}>
                  <Play aria-hidden /> Run (⌘/Ctrl+Enter)
                </Button>
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-3">
                  <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} className="accent-[var(--color-crimson)]" /> Apply global filters ({describeFilters(filters)})
                </label>
                {pg ? (
                  <span className="num text-xs text-ink-3">
                    {pg.error ? "error" : `${pg.rows.length.toLocaleString()} rows`} · {pg.ms.toFixed(0)} ms
                  </span>
                ) : null}
              </div>
              {pg?.error ? <pre className="whitespace-pre-wrap rounded-md border border-critical/40 bg-critical/10 p-3 text-xs text-[#f5a3a3]">{pg.error}</pre> : null}
              {pg && !pg.error ? (
                <div className="space-y-3">
                  {pgViz !== "table" ? <ResultVisual kind={pgViz} rows={pg.rows} minN={filters.minN} /> : null}
                  {pgViz !== "strike_zone" ? <DataTable rows={pg.rows} /> : null}
                </div>
              ) : null}
            </CardBody>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AnswerCard({ e, minN, where, onOpenSql }: { e: Entry; minN: number; where: string; onOpenSql: (sql: string) => void }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <p className="min-w-0 flex-1 text-sm text-ink-2">“{e.question}”</p>
        <div className="flex items-center gap-1.5">
          <Badge tone={e.mode === "claude" ? "crimson" : "info"}>{e.mode === "claude" ? `Claude${e.model ? ` · ${e.model}` : ""}` : "Local parser"}</Badge>
          <span className="num text-[11px] text-ink-3">{(e.ms / 1000).toFixed(1)}s</span>
        </div>
      </div>
      <CardBody className="space-y-4">
        {e.notice ? <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">{e.notice}</p> : null}
        <div>
          <h3 className="text-base font-semibold leading-snug text-ink">{e.headline}</h3>
          {e.keyNumbers.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {e.keyNumbers.map((k, i) => (
                <span key={i} className="inline-flex items-baseline gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 py-1 text-xs">
                  <span className="text-ink-3">{k.label}</span>
                  <RateText r={{ num: k.num, den: k.den }} />
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {e.answer ? <Markdown text={e.answer} /> : null}
        <div className="rounded-md border border-line p-3">
          {e.vizError ? <p className="text-xs text-[#f08080]">Visualization query failed: {e.vizError}</p> : <ResultVisual kind={e.visualization} rows={e.vizRows} minN={minN} />}
        </div>
        <details className="rounded-md border border-line bg-surface-2/50">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-2 hover:text-ink">View Generated SQL &amp; Logic</summary>
          <div className="space-y-3 border-t border-line p-3 text-xs">
            <p className="text-ink-2">{e.logic}</p>
            <p className="num text-[11px] text-ink-3">Scope applied by the app (shadows enriched_pitches): WHERE {where}</p>
            {e.steps.map((s, i) => (
              <div key={i}>
                <div className="mb-1 flex items-center justify-between gap-2 text-ink-3">
                  <span>
                    Step {i + 1}: {s.purpose || "query"}
                  </span>
                  <span className={cn("num", s.error ? "text-[#f08080]" : "")}>{s.error ? `error: ${s.error}` : `${s.rowCount} rows`}</span>
                </div>
                <pre className="num overflow-x-auto whitespace-pre rounded border border-line bg-bg p-2 text-[11px] text-ink-2">{s.sql}</pre>
              </div>
            ))}
            <div>
              <div className="mb-1 flex items-center justify-between text-ink-3">
                <span>Visualization query ({e.visualization})</span>
                <button type="button" className="text-crimson-text hover:underline" onClick={() => onOpenSql(e.vizSql)}>
                  Open in SQL Playground
                </button>
              </div>
              <pre className="num overflow-x-auto whitespace-pre rounded border border-line bg-bg p-2 text-[11px] text-ink-2">{e.vizSql}</pre>
            </div>
          </div>
        </details>
      </CardBody>
    </Card>
  );
}
