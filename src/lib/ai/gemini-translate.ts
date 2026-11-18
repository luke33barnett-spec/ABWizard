/**
 * Translation between ABWizard's provider-neutral conversation format (the
 * browser loop speaks Anthropic-style content blocks: text / tool_use /
 * tool_result) and the Gemini API's `contents` + function calling.
 *
 * Gemini models return opaque `thoughtSignature`s on parts and require them
 * back, unchanged, on later turns of a function-calling conversation. So every
 * model turn is also carried as one `{ type: "gemini_parts", parts }` block
 * holding the raw parts; when present it is replayed verbatim. The browser
 * ignores that block type (it only acts on tool_use).
 *
 * Pure functions — no network, no server-only imports — so they are unit-tested
 * in scripts/verify-ai.ts.
 */
import type { Content, GenerateContentResponse, Part } from "@google/genai";

export type Block = { type: string; [key: string]: unknown };
export interface ConvMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface NeutralResponse {
  content: Block[];
  stop_reason: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "malformed_tool_call";
  stop_details: { reason: string } | null;
  model: string;
  usage: unknown;
}

const REFUSAL_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION", "IMAGE_SAFETY", "LANGUAGE"]);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return content === undefined ? "" : JSON.stringify(content);
}

function parseMaybeJson(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

/** Conversation → Gemini `contents`. */
export function toGeminiContents(messages: ConvMessage[]): Content[] {
  const calls = new Map<string, { name: string; nativeId?: string }>();
  const contents: Content[] = [];

  for (const m of messages) {
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;

    if (m.role === "assistant") {
      for (const b of blocks) {
        if (b.type === "tool_use") {
          calls.set(String(b.id), { name: String(b.name), nativeId: typeof b.gemini_call_id === "string" ? b.gemini_call_id : undefined });
        }
      }
      const raw = blocks.find((b) => b.type === "gemini_parts");
      const parts: Part[] =
        raw && Array.isArray(raw.parts)
          ? (raw.parts as Part[])
          : blocks.flatMap((b): Part[] => {
              if (b.type === "text" && typeof b.text === "string" && b.text) return [{ text: b.text }];
              if (b.type === "tool_use") return [{ functionCall: { name: String(b.name), args: (b.input ?? {}) as Record<string, unknown> } }];
              return [];
            });
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    const parts: Part[] = [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text) parts.push({ text: b.text });
      else if (b.type === "tool_result") {
        const call = calls.get(String(b.tool_use_id));
        const text = toolResultText(b.content);
        parts.push({
          functionResponse: {
            ...(call?.nativeId ? { id: call.nativeId } : {}),
            name: call?.name ?? "run_sql",
            response: b.is_error ? { error: text } : { output: parseMaybeJson(text) },
          },
        });
      }
    }
    if (parts.length) contents.push({ role: "user", parts });
  }
  return contents;
}

/** Gemini response → provider-neutral assistant turn. */
export function fromGeminiResponse(resp: GenerateContentResponse, model: string, newId: () => string): NeutralResponse {
  const cand = resp.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const finish = String(cand?.finishReason ?? "");
  const blocked = resp.promptFeedback?.blockReason ? String(resp.promptFeedback.blockReason) : "";
  const base = { model: resp.modelVersion ?? model, usage: resp.usageMetadata ?? null };

  if (!parts.length) {
    const reason = blocked || finish || "EMPTY";
    return {
      ...base,
      content: [],
      stop_reason: blocked || REFUSAL_REASONS.has(finish) ? "refusal" : finish === "MAX_TOKENS" ? "max_tokens" : finish === "MALFORMED_FUNCTION_CALL" ? "malformed_tool_call" : "end_turn",
      stop_details: { reason },
    };
  }

  const content: Block[] = [];
  let hasCall = false;
  for (const p of parts) {
    if (p.thought) continue; // reasoning summaries stay in the raw parts only
    if (p.functionCall) {
      hasCall = true;
      content.push({
        type: "tool_use",
        id: p.functionCall.id ?? newId(),
        name: p.functionCall.name ?? "",
        input: p.functionCall.args ?? {},
        ...(p.functionCall.id ? { gemini_call_id: p.functionCall.id } : {}),
      });
    } else if (typeof p.text === "string" && p.text) {
      content.push({ type: "text", text: p.text });
    }
  }
  content.push({ type: "gemini_parts", parts });

  let stop: NeutralResponse["stop_reason"] = hasCall ? "tool_use" : "end_turn";
  if (finish === "MAX_TOKENS") stop = "max_tokens";
  else if (REFUSAL_REASONS.has(finish)) stop = "refusal";
  else if (finish === "MALFORMED_FUNCTION_CALL") stop = "malformed_tool_call";
  return { ...base, content, stop_reason: stop, stop_details: finish && finish !== "STOP" ? { reason: finish } : null };
}
