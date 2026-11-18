/**
 * Offline checks for the AI providers behind /api/analyze — no keys, no network.
 *   1. Pure Gemini translation (thought signatures, ids, errors, finish reasons).
 *   2. The real @google/genai SDK + the real POST handler, with fetch stubbed:
 *      asserts the exact request sent to Google and the shape returned to the browser.
 * Run: npm run verify:ai   (uses --conditions=react-server so `server-only` imports resolve)
 */
import assert from "node:assert/strict";
import { fromGeminiResponse, toGeminiContents, type Block, type ConvMessage } from "../src/lib/ai/gemini-translate";
import type { GenerateContentResponse } from "@google/genai";

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${label}`);
  } catch (e) {
    console.log(`FAIL ${label}: ${(e as Error).message}`);
    failures.push(label);
  }
}

const SIG = "c2lnbmF0dXJlLTE=";
const rawModelParts = [
  { text: "thinking summary", thought: true },
  { functionCall: { id: "call-native-1", name: "run_sql", args: { sql: "SELECT 1", purpose: "test" } }, thoughtSignature: SIG },
];

async function main() {
  // ---------------------------------------------------------------- translation
  await check("fromGeminiResponse: function call → tool_use, thought hidden, raw parts kept", () => {
    const r = fromGeminiResponse({ candidates: [{ content: { role: "model", parts: rawModelParts }, finishReason: "STOP" }], modelVersion: "gemini-3.8-flash" } as unknown as GenerateContentResponse, "m", () => "gen-id");
    assert.equal(r.stop_reason, "tool_use");
    const tu = r.content.find((b) => b.type === "tool_use")!;
    assert.equal(tu.id, "call-native-1");
    assert.equal(tu.gemini_call_id, "call-native-1");
    assert.deepEqual(tu.input, { sql: "SELECT 1", purpose: "test" });
    assert.ok(!r.content.some((b) => b.type === "text" && b.text === "thinking summary"), "thought text must not surface");
    const raw = r.content.find((b) => b.type === "gemini_parts")!;
    assert.equal((raw.parts as { thoughtSignature?: string }[])[1].thoughtSignature, SIG);
    assert.equal(r.model, "gemini-3.8-flash");
  });

  await check("fromGeminiResponse: call without native id gets a generated id", () => {
    const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "present_answer", args: {} } }] }, finishReason: "STOP" }] } as unknown as GenerateContentResponse, "m", () => "gen-7");
    const tu = r.content.find((b) => b.type === "tool_use")!;
    assert.equal(tu.id, "gen-7");
    assert.equal(tu.gemini_call_id, undefined);
  });

  await check("fromGeminiResponse: finish reasons + prompt block", () => {
    const mk = (finishReason: string, parts: unknown[] = [{ text: "x" }]) =>
      fromGeminiResponse({ candidates: [{ content: { parts }, finishReason }] } as unknown as GenerateContentResponse, "m", () => "id").stop_reason;
    assert.equal(mk("SAFETY"), "refusal");
    assert.equal(mk("PROHIBITED_CONTENT", []), "refusal");
    assert.equal(mk("MAX_TOKENS"), "max_tokens");
    assert.equal(mk("MALFORMED_FUNCTION_CALL", []), "malformed_tool_call");
    assert.equal(mk("STOP"), "end_turn");
    const blocked = fromGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } } as unknown as GenerateContentResponse, "m", () => "id");
    assert.equal(blocked.stop_reason, "refusal");
  });

  await check("toGeminiContents: replays raw parts verbatim and maps tool results", () => {
    const assistant: Block[] = [
      { type: "tool_use", id: "call-native-1", gemini_call_id: "call-native-1", name: "run_sql", input: { sql: "SELECT 1" } },
      { type: "tool_use", id: "gen-2", name: "run_sql", input: { sql: "SELECT 2" } },
      { type: "gemini_parts", parts: rawModelParts },
    ];
    const conv: ConvMessage[] = [
      { role: "user", content: [{ type: "text", text: "Question?" }] },
      { role: "assistant", content: assistant },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-native-1", content: JSON.stringify({ columns: ["x"], row_count: 1, rows: [{ x: 1 }] }) },
          { type: "tool_result", tool_use_id: "gen-2", content: "Error: Only read-only SELECT", is_error: true },
          { type: "text", text: "follow-up question" },
        ],
      },
    ];
    const c = toGeminiContents(conv);
    assert.deepEqual(c.map((x) => x.role), ["user", "model", "user"]);
    assert.equal(c[1].parts, rawModelParts, "raw parts must be the same object (signatures untouched)");
    const fr = c[2].parts!.map((p) => p.functionResponse).filter(Boolean);
    assert.equal(fr[0]!.id, "call-native-1");
    assert.equal(fr[0]!.name, "run_sql");
    assert.deepEqual(fr[0]!.response, { output: { columns: ["x"], row_count: 1, rows: [{ x: 1 }] } });
    assert.equal(fr[1]!.id, undefined, "generated ids are never sent to Gemini");
    assert.deepEqual(fr[1]!.response, { error: "Error: Only read-only SELECT" });
    assert.equal(c[2].parts![2].text, "follow-up question");
  });

  await check("toGeminiContents: assistant turn without raw parts is rebuilt from blocks", () => {
    const c = toGeminiContents([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "note" }, { type: "tool_use", id: "a", name: "run_sql", input: { sql: "SELECT 1" } }] },
    ]);
    assert.deepEqual(c[1].parts, [{ text: "note" }, { functionCall: { name: "run_sql", args: { sql: "SELECT 1" } } }]);
  });

  // ---------------------------------------------------------------- SDK + route, fetch stubbed
  type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
  const captured: Captured[] = [];
  const queue: { status: number; json: unknown; delayMs?: number }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    const bodyText = init?.body ? String(init.body) : input instanceof Request ? await input.text() : "{}";
    captured.push({ url, headers, body: JSON.parse(bodyText || "{}") });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    if (next.delayMs) {
      // A stuck request: resolves late unless the SDK aborts it first (its per-request timeout).
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, next.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }
    return new Response(JSON.stringify(next.json), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  delete process.env.ANTHROPIC_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.ABWIZARD_ACCESS_CODE;
  const { POST } = await import("../src/app/api/analyze/route");
  const post = (messages: unknown) => POST(new Request("http://localhost/api/analyze", { method: "POST", body: JSON.stringify({ messages }) }));

  let firstTurn: Record<string, unknown> | null = null;
  await check("route → Gemini turn 1: request shape (key header, tools, forced ANY, system prompt)", async () => {
    queue.push({ status: 200, json: { candidates: [{ content: { role: "model", parts: rawModelParts }, finishReason: "STOP" }], modelVersion: "gemini-3.8-flash", usageMetadata: { totalTokenCount: 10 } } });
    const res = await post([{ role: "user", content: [{ type: "text", text: "<dataset_context>…</dataset_context>\n\nQuestion: Take% on 2-0 breaking balls?" }] }]);
    assert.equal(res.status, 200);
    firstTurn = (await res.json()) as Record<string, unknown>;
    const req = captured.at(-1)!;
    assert.match(req.url, /generativelanguage\.googleapis\.com\/.*models\/gemini-3\.8-flash:generateContent/);
    assert.equal(req.headers["x-goog-api-key"], "test-gemini-key");
    const body = req.body as { contents: unknown[]; tools: { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[]; toolConfig: { functionCallingConfig: { mode: string } }; systemInstruction: { parts: { text: string }[] }; generationConfig?: unknown };
    assert.deepEqual(body.tools[0].functionDeclarations.map((d) => d.name), ["run_sql", "present_answer"]);
    assert.ok(body.tools[0].functionDeclarations[0].parametersJsonSchema, "uses JSON Schema declarations");
    assert.equal(body.toolConfig.functionCallingConfig.mode, "ANY");
    assert.match(body.systemInstruction.parts[0].text, /You are ABWizard/);
    const gen = (req.body as { generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } }).generationConfig;
    assert.equal(gen?.thinkingConfig?.thinkingLevel, "LOW", "low thinking level keeps Gemini fast");
    assert.equal((firstTurn.provider as string), "gemini");
    assert.equal(firstTurn.stop_reason, "tool_use");
  });

  await check("route → Gemini turn 2: signature replayed, tool result sent, present_answer parsed", async () => {
    assert.ok(firstTurn, "turn 1 must succeed first");
    const tu = (firstTurn!.content as Block[]).find((b) => b.type === "tool_use")!;
    const conv = [
      { role: "user", content: [{ type: "text", text: "Question: Take% on 2-0 breaking balls?" }] },
      { role: "assistant", content: firstTurn!.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ columns: ["num", "den"], row_count: 1, rows: [{ num: 11, den: 12 }] }) }] },
    ];
    queue.push({
      status: 200,
      json: {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { id: "call-2", name: "present_answer", args: { headline: "Takes 91.7% (11/12).", answer: "-", key_numbers: [{ label: "Take%", num: 11, den: 12 }], visualization: "table", viz_sql: "SELECT 1", logic: "x" } }, thoughtSignature: "c2ln" }] },
            finishReason: "STOP",
          },
        ],
      },
    });
    const res = await post(conv);
    assert.equal(res.status, 200);
    const out = (await res.json()) as { content: Block[] };
    const req = captured.at(-1)!.body as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    const modelTurn = req.contents.find((c) => c.role === "model")!;
    assert.equal(modelTurn.parts.find((p) => p.functionCall)!.thoughtSignature, SIG, "thought signature must be replayed");
    const fr = req.contents.at(-1)!.parts[0].functionResponse as { id: string; name: string; response: { output: { rows: unknown[] } } };
    assert.equal(fr.id, "call-native-1");
    assert.equal(fr.name, "run_sql");
    assert.equal(fr.response.output.rows.length, 1);
    const answer = out.content.find((b) => b.type === "tool_use" && b.name === "present_answer")!;
    assert.equal((answer.input as { headline: string }).headline, "Takes 91.7% (11/12).");
  });

  await check("route → Gemini malformed call is retried once server-side", async () => {
    queue.push({ status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] } });
    queue.push({ status: 200, json: { candidates: [{ content: { parts: [{ functionCall: { name: "run_sql", args: { sql: "SELECT 1", purpose: "p" } } }] }, finishReason: "STOP" }] } });
    const before = captured.length;
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    assert.equal(captured.length - before, 2);
  });

  const errCase = async (status: number, message: string, expectStatus: number, expectText: RegExp, times = 1) => {
    for (let i = 0; i < times; i++) queue.push({ status, json: { error: { code: status, message, status: "X" } } });
    const res = await post([{ role: "user", content: "q" }]);
    const j = (await res.json()) as { error: string };
    assert.equal(res.status, expectStatus, j.error);
    assert.match(j.error, expectText);
  };
  await check("route → invalid Gemini key maps to a clear 502", () => errCase(400, "API key not valid. Please pass a valid API key.", 502, /Gemini API key was rejected/));
  await check("route → unknown model maps to a clear 400", () => errCase(404, "models/nope is not found", 400, /GEMINI_MODEL/));
  // ---- overload handling: retries, fallback models, conversation pinning
  process.env.GEMINI_RETRY_BASE_MS = "5";
  const ok = (name = "run_sql") => ({ status: 200, json: { candidates: [{ content: { parts: [{ functionCall: { name, args: { sql: "SELECT 1", purpose: "p" } }, thoughtSignature: "c2ln" }] }, finishReason: "STOP" }] } });
  const busy = { status: 503, json: { error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } } };
  const urlsSince = (n: number) => captured.slice(n).map((c) => c.url.match(/models\/([^:]+):/)?.[1]);

  await check("Gemini 503 is retried on the same model, then succeeds", async () => {
    const n = captured.length;
    queue.push(busy, ok());
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    assert.deepEqual(urlsSince(n), ["gemini-3.8-flash", "gemini-3.8-flash"]);
  });

  let fallbackTurn: Record<string, unknown> | null = null;
  await check("Gemini overloaded on the main model → falls back to gemini-3.7-flash and pins it", async () => {
    const n = captured.length;
    queue.push(busy, busy, busy, ok());
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    assert.deepEqual(urlsSince(n), ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.7-flash"]);
    fallbackTurn = (await res.json()) as Record<string, unknown>;
    const raw = (fallbackTurn.content as Block[]).find((b) => b.type === "gemini_parts")!;
    assert.equal(raw.model, "gemini-3.7-flash");
  });

  await check("Follow-up turns stay on the model that started the conversation", async () => {
    const tu = (fallbackTurn!.content as Block[]).find((b) => b.type === "tool_use")!;
    const n = captured.length;
    queue.push(ok("present_answer"));
    const res = await post([
      { role: "user", content: "q" },
      { role: "assistant", content: fallbackTurn!.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "{}" }] },
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(urlsSince(n), ["gemini-3.7-flash"]);
  });

  await check("A retired/missing fallback (404) is skipped", async () => {
    const n = captured.length;
    queue.push(busy, busy, busy, { status: 404, json: { error: { code: 404, message: "models/gemini-3.7-flash is not found", status: "NOT_FOUND" } } }, ok());
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    assert.equal(urlsSince(n).at(-1), "gemini-flash-lite-latest");
  });

  await check("Rate limit on the main model moves straight to the next model", async () => {
    const n = captured.length;
    queue.push({ status: 429, json: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } } }, ok());
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    assert.deepEqual(urlsSince(n), ["gemini-3.8-flash", "gemini-3.7-flash"]);
  });

  await check("Everything overloaded → readable 503 (no raw JSON)", async () => {
    queue.push(busy, busy, busy, busy, busy, busy, busy);
    const res = await post([{ role: "user", content: "q" }]);
    const j = (await res.json()) as { error: string };
    assert.equal(res.status, 503);
    assert.match(j.error, /^Gemini is overloaded right now/);
    assert.ok(!j.error.includes("{"), j.error);
    queue.length = 0;
  });

  await check("route → rate limit on every model maps to 429", () => errCase(429, "Resource exhausted", 429, /rate limit reached/, 3));

  // ---- slow models: per-attempt timeout, then the next model; never a bare platform 504
  process.env.GEMINI_ATTEMPT_TIMEOUT_MS = "150";
  await check("A model that hangs is abandoned after its timeout → next model answers", async () => {
    const n = captured.length;
    queue.push({ ...ok(), delayMs: 2_000 }, ok());
    const t0 = Date.now();
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    assert.deepEqual(urlsSince(n), ["gemini-3.8-flash", "gemini-3.7-flash"]);
    assert.ok(Date.now() - t0 < 1_500, `took ${Date.now() - t0}ms`);
  });

  await check("Every model hangs → readable 504 from the app, inside the budget", async () => {
    queue.push({ ...ok(), delayMs: 2_000 }, { ...ok(), delayMs: 2_000 }, { ...ok(), delayMs: 2_000 });
    const res = await post([{ role: "user", content: "q" }]);
    const j = (await res.json()) as { error: string };
    assert.equal(res.status, 504);
    assert.match(j.error, /didn't reply in time/);
  });
  delete process.env.GEMINI_ATTEMPT_TIMEOUT_MS;

  await check("A model that rejects the thinking level is retried without it", async () => {
    const n = captured.length;
    queue.push({ status: 400, json: { error: { code: 400, message: "Thinking level is not supported for this model.", status: "INVALID_ARGUMENT" } } }, ok());
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 200);
    const bodies = captured.slice(n).map((c) => (c.body as { generationConfig?: { thinkingConfig?: unknown } }).generationConfig?.thinkingConfig);
    assert.ok(bodies[0], "first try sends thinkingConfig");
    assert.equal(bodies[1], undefined, "retry omits it");
  });

  await check("route → access code enforced when set", async () => {
    process.env.ABWIZARD_ACCESS_CODE = "tide";
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 401);
    delete process.env.ABWIZARD_ACCESS_CODE;
  });

  await check("route → Claude path still works (stubbed Messages API, strict tools)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    queue.push({
      status: 200,
      json: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "tool_use", id: "toolu_1", name: "run_sql", input: { sql: "SELECT 1", purpose: "p" } }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const res = await post([{ role: "user", content: "q" }]);
    const j = (await res.json()) as { provider: string; stop_reason: string; content: Block[] };
    assert.equal(res.status, 200);
    assert.equal(j.provider, "anthropic");
    assert.equal(j.stop_reason, "tool_use");
    const req = captured.at(-1)!;
    assert.match(req.url, /api\.anthropic\.com\/v1\/messages/);
    const tools = (req.body as { tools: { name: string; strict: boolean }[] }).tools;
    assert.deepEqual(tools.map((t) => [t.name, t.strict]), [["run_sql", true], ["present_answer", true]]);
  });

  await check("route → AI_PROVIDER=gemini wins when both keys are set", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.AI_PROVIDER = "gemini";
    queue.push({ status: 200, json: { candidates: [{ content: { parts: [{ functionCall: { name: "run_sql", args: { sql: "SELECT 1", purpose: "p" } } }] }, finishReason: "STOP" }] } });
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(((await res.json()) as { provider: string }).provider, "gemini");
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
  });

  await check("route → no key configured returns 501 (browser falls back to local parser)", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const res = await post([{ role: "user", content: "q" }]);
    assert.equal(res.status, 501);
  });

  globalThis.fetch = realFetch;
  if (failures.length) {
    console.error(`\n${failures.length} AI check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll AI provider checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
