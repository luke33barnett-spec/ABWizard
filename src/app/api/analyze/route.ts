import { connection } from "next/server";
import { z } from "zod";
import { callAnthropic, callGemini, ProviderError, resolveProvider } from "@/lib/ai/providers";
import type { ConvMessage } from "@/lib/ai/gemini-translate";

/**
 * Ask ABWizard relay. The browser runs the tool loop: it sends the
 * conversation (question + small SQL result summaries — never raw CSVs), we
 * call the configured AI provider (Claude or Gemini) with a fixed system prompt
 * + tools, and return the assistant turn. run_sql calls execute client-side in
 * DuckDB-WASM.
 */
export const maxDuration = 60;

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
  const cfg = resolveProvider();
  return Response.json({
    enabled: cfg.provider !== null,
    provider: cfg.provider,
    label: cfg.label,
    model: cfg.model,
    requiresAccessCode: Boolean(process.env.ABWIZARD_ACCESS_CODE),
  });
}

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const cfg = resolveProvider();
  if (!cfg.provider) return error(501, "No AI key is configured on the server (ANTHROPIC_API_KEY or GEMINI_API_KEY). Using the local query parser instead.");
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

  try {
    const messages = body.messages as ConvMessage[];
    const out = cfg.provider === "gemini" ? await callGemini(messages, cfg.model) : await callAnthropic(messages, cfg.model);
    return Response.json({ ...out, provider: cfg.provider, label: cfg.label });
  } catch (err) {
    if (err instanceof ProviderError) return error(err.status, err.message);
    return error(500, err instanceof Error ? err.message : "Unknown error");
  }
}
