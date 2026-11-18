import Anthropic from "@anthropic-ai/sdk";
import { connection } from "next/server";
import { z } from "zod";
import { SYSTEM_PROMPT, TOOLS } from "@/lib/ai/prompt";

/**
 * Ask ABWizard relay. The browser runs the tool loop: it sends the
 * conversation (question + small SQL result summaries — never raw CSVs), we
 * call Claude with a fixed system prompt + tools, and return the assistant
 * turn. run_sql tool calls are executed client-side in DuckDB-WASM.
 */
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
// Server-side refusal fallback ("default" routing) exists only on the 5.x generation.
const SUPPORTS_FALLBACK = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5(-[12])?)$/.test(MODEL);
const SUPPORTS_EFFORT = /^claude-(sonnet-5|sonnet-5-5|opus-5|opus-5-5|opus-4-[5-8]|fable-5|haiku-5-5)/.test(MODEL);
const MAX_BODY_BYTES = 600_000;

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string().max(60_000), z.array(z.record(z.string(), z.unknown())).max(40)]),
      }),
    )
    .min(1)
    .max(40),
});

export async function GET() {
  await connection(); // evaluate env at request time, not at build
  return Response.json({
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    model: MODEL,
    requiresAccessCode: Boolean(process.env.ABWIZARD_ACCESS_CODE),
  });
}

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return error(501, "ANTHROPIC_API_KEY is not configured on the server. Using the local query parser instead.");
  const code = process.env.ABWIZARD_ACCESS_CODE;
  if (code && req.headers.get("x-abwizard-access") !== code) return error(401, "This deployment requires an ABWizard access code.");

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return error(413, "Request too large. Only send schema, questions and small result summaries.");
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(JSON.parse(raw));
  } catch {
    return error(400, "Malformed request body.");
  }
  if (body.messages[0].role !== "user") return error(400, "The conversation must start with a user message.");

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      tool_choice: { type: "auto" },
      messages: body.messages as Anthropic.Beta.BetaMessageParam[],
      ...(SUPPORTS_EFFORT ? { output_config: { effort: "medium" as const } } : {}),
      ...(SUPPORTS_FALLBACK ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    return Response.json({
      content: response.content,
      stop_reason: response.stop_reason,
      stop_details: response.stop_details ?? null,
      model: response.model,
      usage: response.usage,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return error(502, "The server's Anthropic API key was rejected.");
    if (err instanceof Anthropic.RateLimitError) return error(429, "Rate limited by the Anthropic API — try again in a moment.");
    if (err instanceof Anthropic.BadRequestError) return error(400, `Claude rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) return error(503, "Could not reach the Anthropic API.");
    if (err instanceof Anthropic.APIError) return error(err.status ?? 502, `Anthropic API error: ${err.message}`);
    return error(500, err instanceof Error ? err.message : "Unknown error");
  }
}
