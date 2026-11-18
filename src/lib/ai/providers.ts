import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT, TOOL_SPECS } from "@/lib/ai/prompt";
import { fromGeminiResponse, toGeminiContents, type ConvMessage, type NeutralResponse } from "@/lib/ai/gemini-translate";

/**
 * AI providers behind /api/analyze. Both receive the same system prompt and
 * tools and return the same provider-neutral assistant turn, so the browser's
 * tool loop (src/lib/ai/client.ts) doesn't care which one answered.
 *
 * Selection (server env, read per request):
 *   AI_PROVIDER = "anthropic" | "gemini"  (optional; wins when its key is set)
 *   otherwise ANTHROPIC_API_KEY → Claude, else GEMINI_API_KEY / GOOGLE_API_KEY → Gemini.
 */
export type ProviderId = "anthropic" | "gemini";

export interface ProviderConfig {
  provider: ProviderId | null;
  model: string;
  label: string;
}

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

export function resolveProvider(): ProviderConfig {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(geminiKey());
  let provider: ProviderId | null = null;
  if (explicit === "gemini" && hasGemini) provider = "gemini";
  else if (explicit === "anthropic" && hasAnthropic) provider = "anthropic";
  else if (hasAnthropic) provider = "anthropic";
  else if (hasGemini) provider = "gemini";

  if (provider === "gemini") return { provider, model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, label: "Gemini" };
  if (provider === "anthropic") return { provider, model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, label: "Claude" };
  return { provider: null, model: "", label: "" };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
const ANTHROPIC_TOOLS: Anthropic.Beta.BetaTool[] = TOOL_SPECS.map((t) => ({
  name: t.name,
  description: t.description,
  strict: true,
  input_schema: t.schema as Anthropic.Beta.BetaTool["input_schema"],
}));

export async function callAnthropic(messages: ConvMessage[], model: string): Promise<NeutralResponse> {
  // Server-side refusal fallback ("default" routing) exists only on the 5.x generation.
  const supportsFallback = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5(-[12])?)$/.test(model);
  const supportsEffort = /^claude-(sonnet-5|sonnet-5-5|opus-5|opus-5-5|opus-4-[5-8]|fable-5|haiku-5-5)/.test(model);
  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: ANTHROPIC_TOOLS,
      tool_choice: { type: "auto" },
      messages: messages as Anthropic.Beta.BetaMessageParam[],
      ...(supportsEffort ? { output_config: { effort: "medium" as const } } : {}),
      ...(supportsFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    return {
      content: response.content as unknown as NeutralResponse["content"],
      stop_reason: response.stop_reason === "refusal" ? "refusal" : response.stop_reason === "max_tokens" ? "max_tokens" : response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      stop_details: response.stop_details ? { reason: String(response.stop_details.category ?? "refusal") } : null,
      model: response.model,
      usage: response.usage,
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new ProviderError(502, "The server's Anthropic API key was rejected.");
    if (err instanceof Anthropic.RateLimitError) throw new ProviderError(429, "Rate limited by the Anthropic API — try again in a moment.");
    if (err instanceof Anthropic.BadRequestError) throw new ProviderError(400, `Claude rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new ProviderError(503, "Could not reach the Anthropic API.");
    if (err instanceof Anthropic.APIError) throw new ProviderError(err.status ?? 502, `Anthropic API error: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
const GEMINI_DECLARATIONS = TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema }));

/** Tried in order when the main model is overloaded or rate limited (first turn of a conversation only). */
const DEFAULT_GEMINI_FALLBACKS = "gemini-3.7-flash,gemini-flash-lite-latest";
/** Stay well under the route's 60 s maxDuration, including the model's own time. */
const GEMINI_BUDGET_MS = 45_000;
const OVERLOADED = new Set([500, 502, 503, 504]);

function geminiFallbacks(primary: string): string[] {
  const raw = process.env.GEMINI_FALLBACK_MODELS ?? DEFAULT_GEMINI_FALLBACKS;
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== primary);
}

/** Google's errors arrive as a JSON string in err.message — pull out the human part. */
function apiErrorText(err: ApiError): string {
  try {
    const parsed = JSON.parse(err.message) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* not JSON */
  }
  return err.message ?? "";
}

/** The model that produced the conversation's earlier Gemini turns (thought signatures are tied to it). */
function pinnedGeminiModel(messages: ConvMessage[]): string | null {
  let model: string | null = null;
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "gemini_parts" && typeof b.model === "string") model = b.model;
  }
  return model;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callGemini(messages: ConvMessage[], model: string): Promise<NeutralResponse> {
  const ai = new GoogleGenAI({ apiKey: geminiKey() });
  const contents = toGeminiContents(messages);
  const started = Date.now();
  const baseDelay = Number(process.env.GEMINI_RETRY_BASE_MS ?? 900);
  const pinned = pinnedGeminiModel(messages);
  // A conversation stays on the model that started it; a new question may fall back.
  const candidates = pinned ? [pinned] : [model, ...geminiFallbacks(model)];
  const tried: string[] = [];

  const request = (m: string) =>
    ai.models.generateContent({
      model: m,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: GEMINI_DECLARATIONS }],
        // Every turn must be run_sql or present_answer — Gemini can enforce that.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
        automaticFunctionCalling: { disable: true },
        maxOutputTokens: 16000,
      },
    });

  for (const [ci, m] of candidates.entries()) {
    const attempts = ci === 0 ? 3 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        let out = fromGeminiResponse(await request(m), m, () => `gemini_call_${crypto.randomUUID()}`);
        // A malformed function call is usually transient — retry once before failing.
        if (out.stop_reason === "malformed_tool_call") out = fromGeminiResponse(await request(m), m, () => `gemini_call_${crypto.randomUUID()}`);
        if (out.stop_reason === "malformed_tool_call") throw new ProviderError(502, "Gemini returned a malformed tool call twice. Try rephrasing the question.");
        return out;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (err instanceof TypeError) throw new ProviderError(503, "Could not reach the Gemini API.");
        if (!(err instanceof ApiError)) throw err;
        const text = apiErrorText(err);
        if (/api[_ ]?key/i.test(text) && (err.status === 400 || err.status === 401 || err.status === 403)) throw new ProviderError(502, "The server's Gemini API key was rejected.");
        if (err.status === 404) {
          if (ci === 0 && !pinned) throw new ProviderError(400, `Gemini model "${m}" was not found. Check GEMINI_MODEL.`);
          break; // a fallback that doesn't exist (or was retired) — try the next one
        }
        if (err.status === 429) {
          tried.push(`${m} (rate limited)`);
          break; // quotas are per model — move on to the next model
        }
        if (OVERLOADED.has(err.status)) {
          const delay = baseDelay * 2 ** attempt * (0.75 + Math.random() * 0.5);
          if (attempt < attempts - 1 && Date.now() - started + delay < GEMINI_BUDGET_MS) {
            await sleep(delay);
            continue;
          }
          tried.push(`${m} (overloaded)`);
          break;
        }
        if (err.status === 400) throw new ProviderError(400, `Gemini rejected the request: ${text}`);
        throw new ProviderError(err.status >= 400 ? err.status : 502, `Gemini API error: ${text}`);
      }
    }
    if (Date.now() - started > GEMINI_BUDGET_MS) break;
  }
  const rateLimited = tried.length > 0 && tried.every((t) => t.endsWith("(rate limited)"));
  throw new ProviderError(
    rateLimited ? 429 : 503,
    rateLimited
      ? `Gemini rate limit reached (${tried.join(", ")}). Wait a minute and try again.`
      : `Gemini is overloaded right now — Google returned "high demand" for ${tried.join(", ") || model}. This usually clears within a minute; try again.`,
  );
}
