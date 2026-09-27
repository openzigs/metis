/**
 * #203 (follow-up to #137) — the pre-send token estimate against REAL
 * provider-reported usage, not a synthetic tokenizer.
 *
 * Ground truth is the usage two real runtimes reported on the wire, recorded by
 * #197 under `tests/fixtures/llm/provider-contract/`:
 *
 *   • `ollama`   — `laguna-s-2.1` on Ollama's OpenAI-compatible `/v1` (local);
 *   • `deepseek` — `deepseek-v4-pro` on DeepSeek's Anthropic Messages endpoint.
 *
 * Each recorded response is served back from a loopback HTTP server to the
 * REAL adapter the factory builds (`buildProvider(loadAIConfig(env))`), so the
 * usage the test reads is what the adapter itself parsed — nothing is re-typed
 * from the fixture. Offline: no live call is ever made. Re-recording is the
 * #197 procedure (fixtures README).
 *
 * Stated tolerances (the #137 acceptance criterion), after ONE calibrated turn:
 *
 *   1. Per-provider context accounting is EXACT: the same prompt occupies the
 *      same context whether or not the provider served part of it from cache.
 *   2. A text prompt: never under-counts by more than 5%, and apart from the
 *      deliberate per-message framing allowance ({@link MESSAGE_OVERHEAD_TOKENS}
 *      per message) the estimate is within ±15% of the recorded input tokens.
 *      These recordings are ~30-token prompts, where that allowance is ~25% of
 *      the whole; on a real conversation it is noise.
 *   3. A prompt with NATIVE tools on the OpenAI-compatible wire: within ±15%,
 *      because the tool specs are counted (#137 fix — they ride in the request's
 *      `tools` field, not in any message, and were invisible to the estimate).
 *
 * Known residual, deliberately NOT asserted as a tolerance: on the Anthropic
 * wire the runtime adds its own tool-use system prompt to any request that
 * carries tools (≈230 tokens in the DeepSeek recording: 367 reported for ~135
 * estimated). It is a fixed per-request cost, absorbed by calibration once a
 * tool-offering turn reports usage, and small against any window where overflow
 * matters. Likewise NOT a tolerance: a multi-turn tool transcript (`tool-results`)
 * is under-counted by ~30% — a shape the chat pre-send estimate never sees, since
 * past tool activity is not replayed; pinned below as a characterisation.
 * See the #203 decision on `messages.countTokens` in
 * `server/src/lib/ai/conversation/token-estimator.ts`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildProvider } from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig } from "../../../src/lib/ai/config.js";
import { resetLocalConcurrencyLimitersForTests } from "../../../src/lib/ai/providers/local-concurrency-limiter.js";
import { __resetCacheHitAggregatorSingleton } from "../../../src/lib/ai/cache-hit-telemetry.js";
import {
  MESSAGE_OVERHEAD_TOKENS,
  contextInputTokens,
  estimateCharTokens,
  estimateMessagesTokens,
  promptChars,
  resolveTokenRatio,
} from "../../../src/lib/ai/conversation/token-estimator.js";
import { nativeToolChars } from "../../../src/lib/ai/conversation/turn.js";
import type {
  AIProvider,
  ChatMessage,
  ChatToolSpec,
  TokenUsage,
} from "../../../src/lib/ai/types.js";
import { readFixture, type RecordedFixture } from "./provider-contract/recorded.js";

type Body = Record<string, unknown>;

// ── Loopback replay ────────────────────────────────────────────────────────

let server: http.Server;
let origin = "";
let queue: RecordedFixture["exchanges"] = [];
const received: Body[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      received.push(raw ? (JSON.parse(raw) as Body) : {});
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unrecorded request" } }));
        return;
      }
      const r = next.response;
      res.writeHead(r.status, { "content-type": r.contentType });
      if (r.sse) res.end(r.sse.map((e) => `${e}\n\n`).join(""));
      else res.end(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ""));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  queue = [];
  received.length = 0;
  resetLocalConcurrencyLimitersForTests();
  __resetCacheHitAggregatorSingleton();
});

// ── Runtimes ───────────────────────────────────────────────────────────────

interface Runtime {
  name: "ollama" | "deepseek";
  provider: string;
  env: () => NodeJS.ProcessEnv;
}

const RUNTIMES: Runtime[] = [
  {
    name: "ollama",
    provider: "local-gemma",
    env: () => ({
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: `${origin}/v1`,
      LOCAL_GEMMA_MODEL: "laguna-s-2.1",
      AI_MAX_RETRIES: "1",
    }),
  },
  {
    name: "deepseek",
    provider: "anthropic",
    env: () => ({
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "replay-no-key",
      ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    }),
  },
];

const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (typeof (b as Body).text === "string" ? (b as Body).text : "")).join("")
      : "";

/** The recorded request as the `ChatMessage[]` + tools the app would send. */
function recordedPrompt(f: RecordedFixture): { messages: ChatMessage[]; tools: ChatToolSpec[] } {
  const body = f.exchanges[0].request.body ?? {};
  const messages: ChatMessage[] = [];
  if (body.system !== undefined) messages.push({ role: "system", content: text(body.system) });
  // OpenAI-compatible transcripts carry tool calls / results as fields beside
  // the content; they are rebuilt so the adapter re-sends the same turns.
  const toolNames = new Map<string, string>();
  for (const m of body.messages as Array<Body & { role: ChatMessage["role"] }>) {
    const calls = (m.tool_calls as Array<{ id: string; function: Body }> | undefined) ?? [];
    if (calls.length > 0) {
      messages.push({
        role: m.role,
        content: text(m.content),
        toolCalls: calls.map((c) => {
          toolNames.set(c.id, String(c.function.name));
          return {
            id: c.id,
            name: String(c.function.name),
            args: JSON.parse(String(c.function.arguments)) as Record<string, unknown>,
          };
        }),
      });
    } else if (m.role === "tool") {
      const id = String(m.tool_call_id);
      messages.push({
        role: "tool",
        content: text(m.content),
        toolCallId: id,
        name: toolNames.get(id) ?? "",
      });
    } else {
      messages.push({ role: m.role, content: text(m.content) });
    }
  }
  const tools = ((body.tools as Body[] | undefined) ?? []).map((t) => {
    const fn = (t.function as Body | undefined) ?? t;
    return {
      name: String(fn.name),
      description: String(fn.description),
      parameters: (fn.parameters ?? fn.input_schema) as ChatToolSpec["parameters"],
    };
  });
  return { messages, tools };
}

/** Replay one recorded scenario through the real adapter; return what it parsed. */
async function replay(rt: Runtime, scenario: string) {
  const fixture = readFixture(rt.name, scenario);
  if (!fixture) throw new Error(`missing fixture ${rt.name}/${scenario}`);
  const { messages, tools } = recordedPrompt(fixture);
  queue = [...fixture.exchanges];
  const saved = { AI_RECORD: process.env.AI_RECORD, AI_REPLAY: process.env.AI_REPLAY };
  delete process.env.AI_RECORD;
  delete process.env.AI_REPLAY;
  let provider: AIProvider;
  try {
    provider = buildProvider({ config: loadAIConfig(rt.env()) });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
  const opts = {
    maxTokens: 512,
    ...(rt.name === "deepseek" ? { disableThinking: true } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
  let usage: TokenUsage | null = null;
  if (fixture.result.kind === "chat") {
    usage = (await provider.chat(messages, opts)).usage;
  } else {
    for await (const c of provider.stream(messages, opts)) if (c.type === "usage") usage = c.usage;
  }
  // The adapter sent the prompt the usage was recorded for.
  const sent = received.at(-1)!;
  const sentText = [
    text(sent.system),
    ...(sent.messages as Array<{ content: unknown }>).map((m) => text(m.content)),
  ].join("");
  expect(sentText).toBe(messages.map((m) => text(m.content)).join(""));
  const inputTokens = contextInputTokens(rt.provider, usage);
  if (inputTokens === null) throw new Error(`${rt.name}/${scenario}: adapter parsed no usage`);
  return { messages, tools, usage: usage!, inputTokens };
}

// ── 1. Per-provider accounting ─────────────────────────────────────────────

describe("#137 per-provider context accounting — recorded usage, real adapters", () => {
  it("Anthropic wire: cache reads are reported BESIDE input_tokens, so they are added back", async () => {
    const rt = RUNTIMES.find((r) => r.name === "deepseek")!;
    const cold = await replay(rt, "tools-chat");
    const warm = await replay(rt, "tools-stream");
    // Same prompt; the second call was served 256 tokens from cache.
    expect(warm.messages).toEqual(cold.messages);
    expect(cold.usage).toMatchObject({ promptTokens: 367, cacheReadTokens: 0 });
    expect(warm.usage).toMatchObject({ promptTokens: 111, cacheReadTokens: 256 });
    expect(cold.inputTokens).toBe(367);
    expect(warm.inputTokens).toBe(367);
  });

  it("OpenAI-compatible wire: prompt_tokens already includes cached tokens", async () => {
    const rt = RUNTIMES.find((r) => r.name === "ollama")!;
    const cold = await replay(rt, "tools-chat");
    const warm = await replay(rt, "tools-stream");
    expect(warm.messages).toEqual(cold.messages);
    expect(cold.usage).toMatchObject({ promptTokens: 206, cacheReadTokens: 0 });
    expect(warm.usage).toMatchObject({ promptTokens: 206, cacheReadTokens: 201 });
    expect(cold.inputTokens).toBe(206);
    expect(warm.inputTokens).toBe(206);
  });
});

// ── 2/3. The calibrated pre-send estimate ──────────────────────────────────

describe("#203 — the estimate after one calibrated turn, against recorded input tokens", () => {
  for (const rt of RUNTIMES) {
    it(`${rt.name}: a text prompt is within the stated tolerance`, async () => {
      const first = await replay(rt, "text-chat");
      const next = await replay(rt, "text-stream");
      const ratio = resolveTokenRatio({
        provider: rt.provider,
        model: "recorded",
        samples: [{ promptChars: promptChars(first.messages), inputTokens: first.inputTokens }],
        env: {},
      });
      expect(ratio.source).toBe("calibrated");

      const estimate = estimateMessagesTokens(next.messages, ratio);
      const truth = next.inputTokens;
      const framing = MESSAGE_OVERHEAD_TOKENS * next.messages.length;
      expect(estimate).toBeGreaterThanOrEqual(truth * 0.95);
      expect(Math.abs(estimate - framing - truth) / truth).toBeLessThanOrEqual(0.15);
    });
  }

  it("ollama: native tool specs are counted, so a tool-offering prompt is within ±15%", async () => {
    const rt = RUNTIMES.find((r) => r.name === "ollama")!;
    const first = await replay(rt, "text-chat");
    const withTools = await replay(rt, "tools-chat");
    const ratio = resolveTokenRatio({
      provider: rt.provider,
      model: "recorded",
      samples: [{ promptChars: promptChars(first.messages), inputTokens: first.inputTokens }],
      env: {},
    });
    expect(withTools.tools).toHaveLength(2);
    // The estimate `prepareTurn` makes for a turn sending these tools natively.
    const estimate =
      estimateMessagesTokens(withTools.messages, ratio) +
      estimateCharTokens(nativeToolChars(withTools.tools), ratio);
    const truth = withTools.inputTokens;
    expect(Math.abs(estimate - truth) / truth).toBeLessThanOrEqual(0.15);
    // Without the specs it was less than half the real prompt.
    expect(estimateMessagesTokens(withTools.messages, ratio)).toBeLessThan(truth * 0.5);
  });

  it("ollama: a held-out multi-turn tool transcript is UNDER-counted by a measured ~30%", async () => {
    // #293 review — the text-prompt case above calibrates and estimates two
    // near-identical prompts, so it mostly shows the arithmetic. This case is
    // held out: a 5-message transcript (system, user, an assistant turn with
    // two native tool calls, two tool results) plus the tool specs, 278 input
    // tokens recorded, estimated on the ratio learned from the ~38-token
    // `text-chat` prompt.
    //
    // Measured: 194 estimated vs 278 reported, a 30% UNDER-count. Tool-call
    // arguments are not message text, and the runtime's chat template frames
    // each tool call and result with tokens the estimator cannot see. This is
    // a characterisation, NOT a tolerance: the chat pre-send estimate never
    // sees a transcript like this (past tool activity is not replayed —
    // `context-builder.ts`), and a tool loop's own calls are metered from
    // provider-reported usage. Both bounds are pinned so a change to the
    // estimator that moves this residual must restate it here.
    const rt = RUNTIMES.find((r) => r.name === "ollama")!;
    const first = await replay(rt, "text-chat");
    const held = await replay(rt, "tool-results");
    const ratio = resolveTokenRatio({
      provider: rt.provider,
      model: "recorded",
      samples: [{ promptChars: promptChars(first.messages), inputTokens: first.inputTokens }],
      env: {},
    });
    expect(held.messages).toHaveLength(5);
    expect(held.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(held.tools).toHaveLength(2);
    const truth = held.inputTokens;
    expect(truth).toBe(278);
    const estimate =
      estimateMessagesTokens(held.messages, ratio) +
      estimateCharTokens(nativeToolChars(held.tools), ratio);
    const under = (truth - estimate) / truth;
    expect(under).toBeGreaterThan(0.25);
    expect(under).toBeLessThan(0.35);
  });
});
