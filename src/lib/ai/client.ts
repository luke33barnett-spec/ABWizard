/**
 * Browser side of Ask ABWizard: the tool-use loop. The AI (Claude or Gemini,
 * chosen server-side) proposes SQL via
 * run_sql; we validate it (read-only, single statement), scope it to the
 * global filters, run it in DuckDB-WASM and send back a small JSON summary.
 * The loop ends when the model calls present_answer. The conversation format
 * is provider-neutral; /api/analyze translates for Gemini.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { checkReadOnly, scopeSql } from "@/lib/sql-guard";
import type { Row } from "@/lib/ingest";

export type Visualization = "strike_zone" | "count_matrix" | "bar" | "table";

export interface KeyNumber {
  label: string;
  num: number;
  den: number;
}

export interface AskStep {
  sql: string;
  purpose: string;
  rowCount?: number;
  error?: string;
}

export interface AskAnswer {
  headline: string;
  answer: string;
  keyNumbers: KeyNumber[];
  visualization: Visualization;
  vizSql: string;
  logic: string;
}

export interface AskOutcome extends AskAnswer {
  mode: "ai" | "local";
  /** Provider label ("Claude", "Gemini") for AI answers */
  provider?: string;
  model?: string;
  steps: AskStep[];
  vizRows: Row[];
  vizError?: string;
  /** Conversation so far (for follow-ups), including a tool_result placeholder for present_answer. */
  messages?: Anthropic.Beta.BetaMessageParam[];
}

type Block = Anthropic.Beta.BetaContentBlock;
type QueryFn = (sql: string) => Promise<Row[]>;

const MAX_STEPS = 8;
const RESULT_ROWS = 100;

function jsonSafe(rows: Row[]): Row[] {
  return rows.map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) o[k] = typeof v === "number" && !Number.isFinite(v) ? null : typeof v === "number" ? Math.round(v * 10000) / 10000 : v;
    return o;
  });
}

/** Validate + scope + run; returns rows or a readable error. */
export async function runGuarded(query: QueryFn, sql: string, where: string, limit = 5000): Promise<{ rows: Row[]; error?: string }> {
  const g = checkReadOnly(sql);
  if (!g.ok) return { rows: [], error: g.error };
  try {
    return { rows: await query(scopeSql(g.sql, where, limit)) };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message.split("\n").slice(0, 4).join(" ") : String(err) };
  }
}

function parseAnswer(input: unknown): AskAnswer | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const viz = ["strike_zone", "count_matrix", "bar", "table"].includes(String(i.visualization)) ? (i.visualization as Visualization) : "table";
  if (typeof i.headline !== "string" || typeof i.answer !== "string" || typeof i.viz_sql !== "string") return null;
  const kn = Array.isArray(i.key_numbers)
    ? (i.key_numbers as Record<string, unknown>[])
        .filter((k) => typeof k?.label === "string" && Number.isFinite(Number(k.num)) && Number.isFinite(Number(k.den)))
        .map((k) => ({ label: String(k.label), num: Number(k.num), den: Number(k.den) }))
    : [];
  return { headline: i.headline, answer: i.answer, keyNumbers: kn, visualization: viz, vizSql: i.viz_sql, logic: typeof i.logic === "string" ? i.logic : "" };
}

export interface AnalyzeStatus {
  enabled: boolean;
  provider: "anthropic" | "gemini" | null;
  label: string;
  model: string;
  requiresAccessCode: boolean;
}

export async function askAI(opts: {
  question: string;
  contextBlock: string;
  where: string;
  query: QueryFn;
  accessCode?: string;
  prior?: Anthropic.Beta.BetaMessageParam[];
  onStep?: (step: AskStep) => void;
}): Promise<AskOutcome> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [...(opts.prior ?? [])];
  const text = opts.prior?.length ? opts.question : `${opts.contextBlock}\n\nQuestion: ${opts.question}`;
  // A follow-up must follow the placeholder tool_result left by the previous present_answer.
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) last.content = [...last.content, { type: "text", text }];
  else messages.push({ role: "user", content: [{ type: "text", text }] });

  const steps: AskStep[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let nudged = false;

  for (let iter = 0; iter < MAX_STEPS; iter++) {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.accessCode ? { "x-abwizard-access": opts.accessCode } : {}) },
      body: JSON.stringify({ messages }),
    });
    const data = (await res.json().catch(() => ({}))) as { content?: Block[]; stop_reason?: string; model?: string; label?: string; error?: string };
    if (!res.ok || !data.content) throw new Error(data.error ?? `Analyze request failed (${res.status})`);
    model = data.model;
    provider = data.label;
    if (data.stop_reason === "refusal") throw new Error(`${provider ?? "The AI"} declined this request. Try rephrasing the question.`);
    if (data.stop_reason === "max_tokens") throw new Error("The answer ran past the output limit. Try a narrower question.");

    // Echo the assistant turn back unchanged (thinking/fallback blocks included).
    messages.push({ role: "assistant", content: data.content as Anthropic.Beta.BetaContentBlockParam[] });
    const toolUses = data.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    const answerUse = toolUses.find((t) => t.name === "present_answer");
    if (answerUse) {
      const answer = parseAnswer(answerUse.input);
      if (!answer) throw new Error(`${provider ?? "The AI"} returned an incomplete answer.`);
      const viz = await runGuarded(opts.query, answer.vizSql, opts.where, 5000);
      // Placeholder results so a follow-up question can continue this conversation.
      messages.push({
        role: "user",
        content: toolUses.map((t) => ({ type: "tool_result" as const, tool_use_id: t.id, content: t.name === "present_answer" ? "Shown to the coach." : "Skipped." })),
      });
      return { ...answer, mode: "ai", provider, model, steps, vizRows: viz.rows, vizError: viz.error, messages };
    }

    if (toolUses.length === 0) {
      if (nudged) throw new Error(`${provider ?? "The AI"} did not return a structured answer.`);
      nudged = true;
      messages.push({ role: "user", content: [{ type: "text", text: "Please finish by calling present_answer (run_sql first if you still need numbers)." }] });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const t of toolUses) {
      if (t.name !== "run_sql") {
        results.push({ type: "tool_result", tool_use_id: t.id, content: `Unknown tool ${t.name}`, is_error: true });
        continue;
      }
      const input = t.input as { sql?: string; purpose?: string };
      const step: AskStep = { sql: String(input.sql ?? ""), purpose: String(input.purpose ?? "") };
      const out = await runGuarded(opts.query, step.sql, opts.where, 5000);
      if (out.error) {
        step.error = out.error;
        results.push({ type: "tool_result", tool_use_id: t.id, content: `Error: ${out.error}`, is_error: true });
      } else {
        step.rowCount = out.rows.length;
        const columns = out.rows[0] ? Object.keys(out.rows[0]) : [];
        results.push({
          type: "tool_result",
          tool_use_id: t.id,
          content: JSON.stringify({ columns, row_count: out.rows.length, truncated: out.rows.length > RESULT_ROWS, rows: jsonSafe(out.rows.slice(0, RESULT_ROWS)) }),
        });
      }
      steps.push(step);
      opts.onStep?.(step);
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Stopped after too many query steps. Try a more specific question.");
}

export async function getAnalyzeStatus(): Promise<AnalyzeStatus> {
  try {
    const res = await fetch("/api/analyze", { method: "GET", cache: "no-store" });
    if (!res.ok) throw new Error();
    return (await res.json()) as AnalyzeStatus;
  } catch {
    return { enabled: false, provider: null, label: "", model: "", requiresAccessCode: false };
  }
}
