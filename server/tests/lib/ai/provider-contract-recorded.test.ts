/**
 * #197 — the #132/#133 contract scenarios against RECORDED live traffic.
 *
 * `provider-contract-matrix.test.ts` runs the #131 suite against wire shapes
 * hand-written from vendor references. This file runs the same kinds of
 * scenario — native tool calls (two in one turn, chat and stream), a follow-up
 * turn carrying tool results by id, structured output, plain chat and plain
 * streaming — against bytes captured from the real runtimes, replayed through
 * the real adapters built by the real factory. See `provider-contract/recorded.ts`.
 *
 * Offline by default: every scenario replays from
 * `tests/fixtures/llm/provider-contract/<runtime>/<scenario>.json`, and a
 * request the recording did not see throws instead of reaching the network.
 *
 * Re-record (a maintainer, with credentials; costs real API spend):
 *
 *   AI_RECORD=1 [AI_RECORD_OVERWRITE=1] \
 *   ANTHROPIC_API_KEY=… ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
 *   LOCAL_GEMMA_BASE_URL=http://<ollama-host>:11434/v1 \
 *   pnpm --filter @metis/server exec vitest run tests/lib/ai/provider-contract-recorded.test.ts
 *
 * Without `AI_RECORD_OVERWRITE` a record run only fills missing fixtures, as
 * the #234 harness does.
 *
 * OpenAI and Azure OpenAI are not recorded yet — no credentials were available
 * when these were captured — and stay `todo` here and open on #132 / #197.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildProvider } from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig } from "../../../src/lib/ai/config.js";
import { isDeepSeekEndpoint } from "../../../src/lib/ai/providers/anthropic-endpoint.js";
import { resetLocalConcurrencyLimitersForTests } from "../../../src/lib/ai/providers/local-concurrency-limiter.js";
import { __resetCacheHitAggregatorSingleton } from "../../../src/lib/ai/cache-hit-telemetry.js";
import { supportsResponseFormat } from "../../../src/lib/ai/capabilities.js";
import type {
  AIProvider,
  ChatChunk,
  ChatOptions,
  JsonSchemaResponseFormat,
} from "../../../src/lib/ai/types.js";
import { CONTRACT_TOOLS, TWO_CALLS } from "./provider-contract/suite.js";
import {
  FORBIDDEN_FIXTURE_PATTERNS,
  ReplayDivergenceError,
  installReplayFetch,
  listFixtureFiles,
  normalize,
  readFixture,
  recordResponseBody,
  runScenario,
  scenarioRequest,
  scrubText,
  teeFetch,
  viewRecordedContent,
  viewRecordedRequest,
  writeFixture,
  type RecordedFixture,
  type RecordedResult,
  type RecordedScenario,
  type WireFormat,
} from "./provider-contract/recorded.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLocalConcurrencyLimitersForTests();
  __resetCacheHitAggregatorSingleton();
});

const truthy = (v: string | undefined): boolean => v === "1" || v?.toLowerCase() === "true";

// ── Runtimes ──────────────────────────────────────────────────────────────

interface RecordedRuntime {
  name: string;
  wire: WireFormat;
  model: string;
  /** Per-runtime options merged into every scenario (part of the fixture key). */
  extraOpts: Partial<ChatOptions>;
  /** Env the adapter is built from on replay — placeholder hosts, fake key. */
  replayEnv: NodeJS.ProcessEnv;
  /** Env for a live record run, or `null` when this machine cannot record it. */
  liveEnv(): NodeJS.ProcessEnv | null;
  /** Literal values that must never reach a fixture. */
  secrets(): string[];
}

const DEEPSEEK_URL = "https://api.deepseek.com/anthropic";

/**
 * The LAN base URL AND its host / hostname: a runtime can echo the host without
 * the `/v1` path, and a hostname (`gpu-box.lan`, `*.local`, an IPv6 ULA) is not
 * caught by the private-IPv4 scrub.
 */
function hostSecrets(base: string | undefined): string[] {
  if (!base) return [];
  try {
    const u = new URL(base);
    return [base, u.host, u.hostname.replace(/^\[|\]$/g, "")];
  } catch {
    return [base];
  }
}

const RUNTIMES: RecordedRuntime[] = [
  {
    name: "deepseek",
    wire: "anthropic-messages",
    model: "deepseek-v4-pro",
    // Thinking off keeps the recording small and cheap; the thinking-mode tool
    // loop is pinned separately by #198's scenario in the matrix test.
    extraOpts: { maxTokens: 512, disableThinking: true },
    replayEnv: {
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "replay-no-key",
      ANTHROPIC_BASE_URL: DEEPSEEK_URL,
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    },
    liveEnv: () => {
      const key = process.env.ANTHROPIC_API_KEY;
      const base = process.env.ANTHROPIC_BASE_URL;
      // Only ever record THIS runtime from DeepSeek's endpoint, never api.anthropic.com.
      if (!key || !isDeepSeekEndpoint(base)) return null;
      return {
        AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: key,
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_MODEL: "deepseek-v4-pro",
      };
    },
    secrets: () => [process.env.ANTHROPIC_API_KEY ?? ""],
  },
  {
    name: "ollama",
    wire: "openai-chat-completions",
    model: "laguna-s-2.1",
    extraOpts: { maxTokens: 512 },
    replayEnv: {
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: "http://127.0.0.1:11434/v1",
      LOCAL_GEMMA_MODEL: "laguna-s-2.1",
    },
    liveEnv: () => {
      const base = process.env.LOCAL_GEMMA_BASE_URL;
      if (!base) return null;
      return {
        AI_PROVIDER: "local-gemma",
        LOCAL_GEMMA_BASE_URL: base,
        LOCAL_GEMMA_MODEL: "laguna-s-2.1",
      };
    },
    secrets: () => hostSecrets(process.env.LOCAL_GEMMA_BASE_URL),
  },
];

/** The client-level retry budget of a built adapter (see {@link buildAdapter}). */
function clientRetries(provider: AIProvider): { sdkMaxRetries?: number; maxAttempts?: number } {
  const p = provider as unknown as { client?: { maxRetries?: number }; maxAttempts?: number };
  return {
    ...(p.client?.maxRetries !== undefined ? { sdkMaxRetries: p.client.maxRetries } : {}),
    ...(p.maxAttempts !== undefined ? { maxAttempts: p.maxAttempts } : {}),
  };
}

/**
 * Build through the real factory WITHOUT the #234 `chat()`-level recorder in
 * front: under `AI_RECORD=1` `buildProvider` would wrap the adapter, and this
 * suite's subject is the adapter itself.
 *
 * `record: true` also turns off every client-level retry, because a retry in
 * a record run is a second paid call and would tee a failed exchange into the
 * fixture. vitest's `retry: 0` only stops the TEST re-running; the adapters
 * retry on their own: the Anthropic SDK (`maxRetries`, default 2; the adapter
 * exposes no option for it, so it is set on the built client) and the
 * OpenAI-compatible client (`AI_MAX_RETRIES`, read at construction; `1` = one
 * attempt, no retry).
 */
function buildAdapter(env: NodeJS.ProcessEnv, { record = false } = {}): AIProvider {
  const saved = {
    AI_RECORD: process.env.AI_RECORD,
    AI_REPLAY: process.env.AI_REPLAY,
    AI_MAX_RETRIES: process.env.AI_MAX_RETRIES,
  };
  delete process.env.AI_RECORD;
  delete process.env.AI_REPLAY;
  if (record) process.env.AI_MAX_RETRIES = "1";
  try {
    const provider = buildProvider({ config: loadAIConfig(env) });
    if (record) {
      const client = (provider as unknown as { client?: { maxRetries?: number } }).client;
      if (client && typeof client.maxRetries === "number") client.maxRetries = 0;
      const r = clientRetries(provider);
      if ((r.sdkMaxRetries ?? 0) !== 0 || (r.maxAttempts ?? 1) !== 1) {
        throw new Error(`record run would retry a paid call: ${JSON.stringify(r)}`);
      }
    }
    return provider;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────

const SYSTEM = "You are producing a contract-test recording. Follow the instruction exactly.";
const CALL_BOTH =
  'Call BOTH tools now, in this order, in one turn: search_code with query "interest rate", ' +
  'then read_file with path "src/Loan.java". Do not write any text.';

const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
};

const SCENARIOS: RecordedScenario[] = [
  {
    name: "text-chat",
    kind: "chat",
    messages: [{ role: "user", content: "Reply with exactly: The answer is 42." }],
    opts: { systemMessage: SYSTEM },
  },
  {
    name: "text-stream",
    kind: "stream",
    messages: [{ role: "user", content: "Reply with exactly: Streamed answer." }],
    opts: { systemMessage: SYSTEM },
  },
  {
    name: "tools-chat",
    kind: "chat",
    messages: [{ role: "user", content: CALL_BOTH }],
    opts: { systemMessage: SYSTEM, tools: CONTRACT_TOOLS, toolChoice: "auto" },
  },
  {
    name: "tools-stream",
    kind: "stream",
    messages: [{ role: "user", content: CALL_BOTH }],
    opts: { systemMessage: SYSTEM, tools: CONTRACT_TOOLS },
  },
  {
    name: "tool-results",
    kind: "chat",
    messages: [
      { role: "user", content: "What is the interest rate in src/Loan.java? Use the tools." },
      { role: "assistant", content: "", toolCalls: TWO_CALLS },
      {
        role: "tool",
        content: "src/Loan.java:12 double rate = 0.05;",
        toolCallId: "call_1",
        name: "search_code",
      },
      {
        role: "tool",
        content: "class Loan { double rate = 0.05; }",
        toolCallId: "call_2",
        name: "read_file",
      },
    ],
    opts: { systemMessage: SYSTEM, tools: CONTRACT_TOOLS },
  },
  {
    name: "structured-output",
    kind: "chat",
    messages: [
      {
        role: "user",
        content:
          'Is 2 + 2 equal to 4? Reply with only a JSON object of the form {"ok": <boolean>}.',
      },
    ],
    opts: { systemMessage: SYSTEM, responseFormat: SCHEMA },
  },
];

function withRuntime(rt: RecordedRuntime, sc: RecordedScenario): RecordedScenario {
  return { ...sc, opts: { ...sc.opts, ...rt.extraOpts } };
}

// ── Contract assertions, independent of what was recorded ────────────────

const chunksOf = <T extends ChatChunk["type"]>(chunks: ChatChunk[], type: T) =>
  chunks.filter((c): c is Extract<ChatChunk, { type: T }> => c.type === type);

function assertContract(
  rt: RecordedRuntime,
  sc: RecordedScenario,
  result: RecordedResult,
  lastRequest: ReturnType<typeof viewRecordedRequest>,
  provider: AIProvider,
): void {
  expect(lastRequest.model).toBe(rt.model);
  if (result.kind === "stream") {
    const chunks = result.chunks;
    const done = chunks.findIndex((c) => c.type === "done");
    expect(done).toBe(chunks.length - 1);
    const usage = chunksOf(chunks, "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.completionTokens).toBeGreaterThan(0);
    expect(chunks.indexOf(usage[0]!)).toBeLessThan(done);
    if (sc.name === "text-stream") {
      const text = chunksOf(chunks, "delta")
        .map((c) => c.content)
        .join("");
      expect(text).toContain("Streamed answer");
      expect(chunksOf(chunks, "tool_call")).toEqual([]);
    }
    if (sc.name === "tools-stream") {
      expect(lastRequest.toolNames).toEqual(["search_code", "read_file"]);
      const calls = chunksOf(chunks, "tool_call");
      expect(calls.map((c) => [c.name, c.native])).toEqual([
        ["search_code", true],
        ["read_file", true],
      ]);
      expect(calls.map((c) => c.arguments)).toEqual([
        { query: "interest rate" },
        { path: "src/Loan.java" },
      ]);
      const ids = calls.map((c) => c.toolCallId);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(2);
      expect(chunks.findLastIndex((c) => c.type === "tool_call")).toBeLessThan(done);
    }
    return;
  }

  const res = result.response;
  expect(res.usage.promptTokens).toBeGreaterThan(0);
  expect(res.usage.completionTokens).toBeGreaterThan(0);
  switch (sc.name) {
    case "text-chat":
      expect(res.content).toContain("The answer is 42");
      expect(res.toolCalls).toBeUndefined();
      expect(lastRequest.toolNames).toEqual([]);
      break;
    case "tools-chat": {
      expect(lastRequest.toolNames).toEqual(["search_code", "read_file"]);
      expect(res.toolCalls?.map((c) => [c.name, c.args])).toEqual([
        ["search_code", { query: "interest rate" }],
        ["read_file", { path: "src/Loan.java" }],
      ]);
      const ids = (res.toolCalls ?? []).map((c) => c.id);
      expect(ids.every((id) => id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(2);
      break;
    }
    case "tool-results":
      expect(lastRequest.assistantToolCallIds).toEqual(["call_1", "call_2"]);
      expect(lastRequest.toolResultIds).toEqual(["call_1", "call_2"]);
      expect(res.content).toContain("0.05");
      break;
    case "structured-output": {
      const supported = supportsResponseFormat(provider, rt.model, "json_schema");
      expect(lastRequest.responseFormatSent).toBe(supported);
      expect(JSON.parse(res.content)).toEqual({ ok: true });
      break;
    }
  }
}

// ── Replay ────────────────────────────────────────────────────────────────

/**
 * Replay `fixture` through the adapter and check it end to end. Throws (an
 * assertion error or {@link ReplayDivergenceError}) on any divergence.
 */
async function checkReplay(
  rt: RecordedRuntime,
  sc: RecordedScenario,
  fixture: RecordedFixture,
): Promise<void> {
  const scenario = withRuntime(rt, sc);
  // Stale-fixture guard: the scenario must still send what was recorded.
  expect(fixture.key, `${rt.name}/${sc.name} is stale — re-record it`).toBe(
    scenarioRequest(scenario, rt.model).key,
  );
  expect(fixture.wire).toBe(rt.wire);
  const replay = installReplayFetch(fixture);
  const provider = buildAdapter(rt.replayEnv);
  let result: RecordedResult;
  try {
    result = await runScenario(provider, scenario, rt.model);
  } catch (err) {
    replay.assertNoDivergence(); // a divergence is the real cause; report it
    throw err;
  }
  replay.assertNoDivergence();
  expect(replay.remaining(), "recorded requests the adapter never made").toBe(0);
  expect(normalize(result)).toEqual(normalize(fixture.result));
  const last = replay.seen.filter((r) => r.body !== null).at(-1);
  assertContract(rt, sc, result, viewRecordedRequest(rt.wire, last?.body ?? null), provider);
}

async function record(rt: RecordedRuntime, sc: RecordedScenario, env: NodeJS.ProcessEnv) {
  const scenario = withRuntime(rt, sc);
  const tee = teeFetch(rt.secrets());
  let result: RecordedResult;
  try {
    result = await runScenario(buildAdapter(env, { record: true }), scenario, rt.model);
  } catch (err) {
    await tee.finish(); // always restore the real fetch
    throw err;
  }
  const recorded = await tee.finish();
  const failed = recorded.filter((ex) => ex.response.status >= 400);
  if (failed.length > 0) {
    throw new Error(
      `${rt.name}/${sc.name}: refusing to write a fixture with a failed exchange ` +
        `(${failed.map((ex) => ex.response.status).join(", ")})`,
    );
  }
  const fixture: RecordedFixture = {
    version: 1,
    runtime: rt.name,
    wire: rt.wire,
    scenario: sc.name,
    key: scenarioRequest(scenario, rt.model).key,
    model: rt.model,
    recordedAt: new Date().toISOString(),
    exchanges: recorded,
    result: normalize(result),
  };
  // The adapter's own output can echo a secret too (it never should).
  const text = scrubText(JSON.stringify(fixture), rt.secrets());
  writeFixture(JSON.parse(text) as RecordedFixture);
}

for (const rt of RUNTIMES) {
  describe(`recorded provider contract: ${rt.name} (${rt.wire}, ${rt.model})`, () => {
    for (const sc of SCENARIOS) {
      // A live record run must never re-run the test (a re-run is another paid
      // call; client-level retries are off too, see buildAdapter) and gets a
      // live-model timeout. A replay is local and keeps the default timeout.
      const opts = truthy(process.env.AI_RECORD) ? { timeout: 180_000, retry: 0 } : {};
      it(`${sc.name} replays through the real adapter`, opts, async () => {
        const live = truthy(process.env.AI_RECORD) ? rt.liveEnv() : null;
        if (live && (truthy(process.env.AI_RECORD_OVERWRITE) || !readFixture(rt.name, sc.name))) {
          await record(rt, sc, live);
        }
        const fixture = readFixture(rt.name, sc.name);
        expect(fixture, `no recording for ${rt.name}/${sc.name} — run with AI_RECORD=1`).not.toBe(
          null,
        );
        await checkReplay(rt, sc, fixture!);
      });
    }
  });
}

describe("recorded provider contract: runtimes without a recording yet (#197)", () => {
  it.todo("openai — needs OPENAI_API_KEY; OpenAI Chat Completions shape still hand-written");
  it.todo("azure — needs an Azure OpenAI deployment; still hand-written");
});

// ── The recordings can fail: contract-relevant alterations go red ─────────

const runtime = (name: string): RecordedRuntime => RUNTIMES.find((r) => r.name === name)!;
const scenario = (name: string): RecordedScenario => SCENARIOS.find((s) => s.name === name)!;
const load = (rt: string, sc: string): RecordedFixture =>
  structuredClone(readFixture(rt, sc)) as RecordedFixture;
/** Rewrite one SSE event (by predicate) of the first exchange. */
function editSse(f: RecordedFixture, match: (e: string) => boolean, edit: (e: string) => string) {
  const sse = f.exchanges[0]!.response.sse!;
  const i = sse.findIndex(match);
  expect(i, "event to alter not found").toBeGreaterThanOrEqual(0);
  sse[i] = edit(sse[i]!);
}

describe("recorded fixtures are load-bearing (#197 revert-to-red)", () => {
  it("each unaltered recording replays (control)", async () => {
    await expect(
      checkReplay(runtime("deepseek"), scenario("tools-chat"), load("deepseek", "tools-chat")),
    ).resolves.toBeUndefined();
  });

  it("deepseek: renaming a recorded tool_use block fails the replay", async () => {
    const f = load("deepseek", "tools-chat");
    const content = (f.exchanges[0]!.response.json as { content: Array<{ name?: string }> })
      .content;
    content[1]!.name = "delete_file";
    await expect(checkReplay(runtime("deepseek"), scenario("tools-chat"), f)).rejects.toThrow();
  });

  it("deepseek: a changed stop_reason in the stream fails the replay", async () => {
    const f = load("deepseek", "tools-stream");
    editSse(
      f,
      (e) => e.includes('"stop_reason":"tool_use"'),
      (e) => e.replace('"stop_reason":"tool_use"', '"stop_reason":"end_turn"'),
    );
    await expect(checkReplay(runtime("deepseek"), scenario("tools-stream"), f)).rejects.toThrow();
  });

  it("deepseek: a recorded request that carried a different tool_result id diverges", async () => {
    const f = load("deepseek", "tool-results");
    const body = f.exchanges[0]!.request.body as {
      messages: Array<{ content: unknown }>;
    };
    const results = body.messages.at(-1)!.content as Array<{ tool_use_id: string }>;
    results[1]!.tool_use_id = "call_9";
    await expect(
      checkReplay(runtime("deepseek"), scenario("tool-results"), f),
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  // #197 review: the request check must see CONTENT, not just ids. Each edit
  // below makes the recording disagree with what the adapter sends in exactly
  // one content field; before viewRecordedContent every one of them replayed green.
  it("deepseek: a recorded tool_result with different content diverges", async () => {
    const f = load("deepseek", "tool-results");
    const body = f.exchanges[0]!.request.body as { messages: Array<{ content: unknown }> };
    const results = body.messages.at(-1)!.content as Array<{ content: string }>;
    results[0]!.content = "";
    await expect(
      checkReplay(runtime("deepseek"), scenario("tool-results"), f),
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it("deepseek: a recorded request with a different system prompt diverges", async () => {
    const f = load("deepseek", "text-chat");
    (f.exchanges[0]!.request.body as { system: string }).system = "Something else.";
    await expect(checkReplay(runtime("deepseek"), scenario("text-chat"), f)).rejects.toBeInstanceOf(
      ReplayDivergenceError,
    );
  });

  it("deepseek: a recorded tool_use with different arguments diverges", async () => {
    const f = load("deepseek", "tool-results");
    const body = f.exchanges[0]!.request.body as { messages: Array<{ content: unknown }> };
    const calls = body.messages[1]!.content as Array<{ input: Record<string, unknown> }>;
    calls[0]!.input = { query: "principal" };
    await expect(
      checkReplay(runtime("deepseek"), scenario("tool-results"), f),
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it("ollama: a recorded tool message with different content diverges", async () => {
    const f = load("ollama", "tool-results");
    const body = f.exchanges[0]!.request.body as { messages: Array<Record<string, unknown>> };
    body.messages.filter((m) => m.role === "tool").at(-1)!.content = "";
    await expect(
      checkReplay(runtime("ollama"), scenario("tool-results"), f),
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it("ollama: a recorded request with a different system message or user text diverges", async () => {
    for (const edit of [
      (m: Record<string, unknown>) => m.role === "system" && (m.content = "Something else."),
      (m: Record<string, unknown>) => m.role === "user" && (m.content = "Reply with: 41."),
    ]) {
      const f = load("ollama", "text-chat");
      (
        f.exchanges[0]!.request.body as { messages: Array<Record<string, unknown>> }
      ).messages.forEach(edit);
      await expect(checkReplay(runtime("ollama"), scenario("text-chat"), f)).rejects.toBeInstanceOf(
        ReplayDivergenceError,
      );
    }
  });

  it("ollama: a recorded tool_calls entry with different arguments diverges", async () => {
    const f = load("ollama", "tool-results");
    const body = f.exchanges[0]!.request.body as {
      messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    };
    body.messages.find((m) => m.tool_calls)!.tool_calls![1]!.function.arguments =
      '{"path":"src/Other.java"}';
    await expect(
      checkReplay(runtime("ollama"), scenario("tool-results"), f),
    ).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it("ollama: dropping one streamed tool_call delta fails the replay", async () => {
    const f = load("ollama", "tools-stream");
    const sse = f.exchanges[0]!.response.sse!;
    f.exchanges[0]!.response.sse = sse.filter((e) => !e.includes('"name":"read_file"'));
    await expect(checkReplay(runtime("ollama"), scenario("tools-stream"), f)).rejects.toThrow();
  });

  it("ollama: altered usage in the recorded reply fails the replay", async () => {
    const f = load("ollama", "text-chat");
    (f.exchanges[0]!.response.json as { usage: { prompt_tokens: number } }).usage.prompt_tokens +=
      1;
    await expect(checkReplay(runtime("ollama"), scenario("text-chat"), f)).rejects.toThrow();
  });

  it("ollama: non-JSON structured output fails the contract even when wire and result agree", async () => {
    const f = load("ollama", "structured-output");
    const reply = f.exchanges[0]!.response.json as {
      choices: Array<{ message: { content: string } }>;
    };
    reply.choices[0]!.message.content = "Yes, it is.";
    (f.result as { response: { content: string } }).response.content = "Yes, it is.";
    await expect(checkReplay(runtime("ollama"), scenario("structured-output"), f)).rejects.toThrow(
      /JSON/,
    );
  });

  it("a fixture whose key no longer matches its scenario is reported stale", async () => {
    const f = load("ollama", "text-chat");
    f.key = "0".repeat(64);
    await expect(checkReplay(runtime("ollama"), scenario("text-chat"), f)).rejects.toThrow(/stale/);
  });

  it("an adapter request the recording never saw throws instead of reaching the network", async () => {
    const f = load("ollama", "text-chat");
    f.exchanges = [];
    await expect(checkReplay(runtime("ollama"), scenario("text-chat"), f)).rejects.toBeInstanceOf(
      ReplayDivergenceError,
    );
  });
});

describe("viewRecordedContent normalises only what does not change the prompt (#197)", () => {
  it("anthropic: cache_control, string vs text blocks and block extras are ignored", () => {
    const a = viewRecordedContent("anthropic-messages", {
      system: "S",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "r" }],
        },
      ],
    });
    const b = viewRecordedContent("anthropic-messages", {
      system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "r" }] },
          ],
        },
      ],
    });
    expect(b).toEqual(a);
    expect(a.turns[1]!.toolResults).toEqual([{ id: "c1", content: "r" }]);
  });

  it("openai: null vs empty content and argument key order are ignored; content is not", () => {
    const view = (content: unknown, args: string, tool = "r") =>
      viewRecordedContent("openai-chat-completions", {
        messages: [
          { role: "system", content: "S" },
          {
            role: "assistant",
            content,
            tool_calls: [{ id: "c1", function: { name: "f", arguments: args } }],
          },
          { role: "tool", tool_call_id: "c1", content: tool },
        ],
      });
    expect(view(null, '{"a":1,"b":2}')).toEqual(view("", '{ "b": 2, "a": 1 }'));
    expect(view(null, '{"a":1}')).not.toEqual(view(null, '{"a":2}'));
    expect(view(null, "{}", "r")).not.toEqual(view(null, "{}", ""));
    expect(view(null, "{}").system).toBe("S");
  });
});

// ── Record mode never retries a paid call (#197 review) ──────────────────

describe("record-mode adapters are built with client retries disabled (#197)", () => {
  it.each(RUNTIMES.map((rt) => [rt.name, rt] as const))(
    "%s: record build has no SDK/client retry; the default build does (control)",
    (_name, rt) => {
      const envBefore = process.env.AI_MAX_RETRIES;
      const recordRetries = clientRetries(buildAdapter(rt.replayEnv, { record: true }));
      const defaultRetries = clientRetries(buildAdapter(rt.replayEnv));
      if (rt.wire === "anthropic-messages") {
        expect(recordRetries).toEqual({ sdkMaxRetries: 0 });
        expect(defaultRetries.sdkMaxRetries).toBeGreaterThan(0);
      } else {
        expect(recordRetries).toEqual({ maxAttempts: 1 });
        expect(defaultRetries.maxAttempts).toBeGreaterThan(1);
      }
      // The env override is scoped to the build.
      expect(process.env.AI_MAX_RETRIES).toBe(envBefore);
    },
  );
});

// ── Recorded wire shapes vs the hand-written harnesses (#197 divergences) ──

const sseData = (f: RecordedFixture): Array<Record<string, unknown>> =>
  f.exchanges[0]!.response.sse!.filter((e) => e.includes("data: {")).map(
    (e) => JSON.parse(e.slice(e.indexOf("data: ") + 6)) as Record<string, unknown>,
  );

describe("recorded shapes vs the hand-written harness shapes (#197)", () => {
  it("ollama (0.34.2): each streamed tool call arrives whole in one delta — as hand-written", () => {
    const deltas = sseData(load("ollama", "tools-stream")).flatMap(
      (d) =>
        ((d.choices as Array<{ delta?: { tool_calls?: unknown[] } }>)[0]?.delta?.tool_calls ??
          []) as Array<{ id?: string; function: { name?: string; arguments: string } }>,
    );
    expect(deltas).toHaveLength(2);
    for (const d of deltas) {
      expect(d.id).toBeTruthy();
      expect(d.function.name).toBeTruthy();
      expect(() => JSON.parse(d.function.arguments)).not.toThrow();
    }
  });

  it("DIVERGENCE ollama: finish_reason is `tool_calls` after tool calls — the harness sends `stop`", async () => {
    const finishes = sseData(load("ollama", "tools-stream"))
      .map((d) => (d.choices as Array<{ finish_reason?: string | null }>)[0]?.finish_reason)
      .filter(Boolean);
    expect(finishes).toEqual(["tool_calls"]);
    const nonStream = load("ollama", "tools-chat").exchanges[0]!.response.json as {
      choices: Array<{ finish_reason: string; message: { content: unknown } }>;
    };
    expect(nonStream.choices[0]!.finish_reason).toBe("tool_calls");
    // DIVERGENCE: content is "" beside tool_calls, where the harness sends null.
    expect(nonStream.choices[0]!.message.content).toBe("");
    // The adapter passes the runtime's reason through; the hand-written `stop`
    // shape (still covered by the matrix test) must keep working too.
    const done = (load("ollama", "tools-stream").result as { chunks: ChatChunk[] }).chunks.at(-1);
    expect(done).toEqual({ type: "done", finishReason: "tool_calls" });
  });

  it("DIVERGENCE ollama: reasoning rides a separate `reasoning` field and never reaches content", () => {
    const f = load("ollama", "tools-stream");
    const reasoning = sseData(f)
      .map((d) => (d.choices as Array<{ delta?: { reasoning?: string } }>)[0]?.delta?.reasoning)
      .filter((r): r is string => typeof r === "string" && r.length > 0);
    expect(reasoning.length).toBeGreaterThan(0);
    const deltas = (f.result as { chunks: ChatChunk[] }).chunks.filter((c) => c.type === "delta");
    expect(deltas).toEqual([]);
  });

  it("DIVERGENCE deepseek: tool input streams as input_json_delta fragments, with ping events", () => {
    const events = sseData(load("deepseek", "tools-stream"));
    const types = events.map((e) => e.type);
    expect(types).toContain("ping");
    const fragments = events.filter(
      (e) => (e.delta as { type?: string } | undefined)?.type === "input_json_delta",
    );
    // The SDK-mocked harness never exercises fragment assembly; the recording does.
    expect(fragments.length).toBeGreaterThan(4);
  });

  it("DIVERGENCE: promptTokens excludes cache reads on DeepSeek, includes them on Ollama", () => {
    const ds = (load("deepseek", "tools-stream").result as { chunks: ChatChunk[] }).chunks.find(
      (c) => c.type === "usage",
    ) as Extract<ChatChunk, { type: "usage" }>;
    const ol = (load("ollama", "tools-stream").result as { chunks: ChatChunk[] }).chunks.find(
      (c) => c.type === "usage",
    ) as Extract<ChatChunk, { type: "usage" }>;
    // Anthropic semantics: input_tokens is the UNCACHED part (see cache-verification.ts).
    expect(ds.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(ds.usage.promptTokens).toBeGreaterThan(0);
    // OpenAI semantics: prompt_tokens already includes the cached tokens.
    expect(ol.usage.promptTokens).toBeGreaterThanOrEqual(ol.usage.cacheReadTokens ?? 0);
  });
});

// ── Hygiene ───────────────────────────────────────────────────────────────

describe("recorded fixture hygiene (#197)", () => {
  const files = listFixtureFiles();

  it("there is exactly one recording per runtime × scenario, and no orphans", () => {
    const expected = RUNTIMES.flatMap((rt) => SCENARIOS.map((sc) => `${rt.name}/${sc.name}.json`));
    expect(files.map(([name]) => name).sort()).toEqual(expected.sort());
  });

  it.each(files.map(([name, text]) => [name, text]))(
    "%s carries no key, auth header, cookie, private host or account id",
    (_name, text) => {
      for (const [label, pattern] of FORBIDDEN_FIXTURE_PATTERNS) {
        expect(pattern.test(text), label).toBe(false);
      }
    },
  );

  it("scrubText removes the leak shapes a live reply can carry", () => {
    const secret = "live-secret-value-123";
    const dirty = [
      `{"id":"msg_01AbC","x":"${secret}"}`,
      '{"id":"chatcmpl-9f8e","k":"sk-abcdefghijkl"}',
      '{"id":"140b98a0-b5cd-4da4-9992-6b3b3edf2943"}',
      "http://192.168.1.20:11434/v1 and 10.0.0.7",
    ].join("\n");
    const clean = scrubText(dirty, [secret]);
    for (const [label, pattern] of FORBIDDEN_FIXTURE_PATTERNS) {
      expect(pattern.test(clean), label).toBe(false);
    }
    expect(clean).not.toContain(secret);
    expect(clean).toContain('"id":"msg_recorded"');
    expect(clean).toContain('"id":"chatcmpl-recorded"');
    expect(clean).toContain("http://local-model-host:11434/v1");
  });

  it("a LAN hostname is scrubbed even when echoed without the base URL's path", () => {
    const secrets = hostSecrets("http://gpu-box.lan:11434/v1");
    const clean = scrubText('{"host":"gpu-box.lan:11434","h":"gpu-box.lan"}', secrets);
    expect(clean).not.toContain("gpu-box");
    const v6 = scrubText(
      '{"h":"fd12:3456:789a::1"}',
      hostSecrets("http://[fd12:3456:789a::1]:11434/v1"),
    );
    expect(v6).not.toContain("fd12:3456");
  });

  it("teeFetch records path, body and scrubbed reply — never a header — and restores fetch", async () => {
    const fake = async () =>
      new Response('data: {"id":"chatcmpl-abc","host":"http://192.168.1.20:11434"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream", "set-cookie": "s=1" },
      });
    globalThis.fetch = fake as unknown as typeof fetch;
    const tee = teeFetch(["topsecretvalue"]);
    const res = await fetch("http://192.168.1.20:11434/v1/chat/completions?x=1", {
      method: "POST",
      headers: { Authorization: "Bearer topsecretvalue" },
      body: JSON.stringify({ model: "m", note: "topsecretvalue" }),
    });
    expect(await res.text()).toContain("chatcmpl-abc"); // the adapter sees the real bytes
    const [ex] = await tee.finish();
    expect(globalThis.fetch).toBe(fake);
    expect(ex!.request).toEqual({
      method: "POST",
      path: "/v1/chat/completions?x=1",
      body: { model: "m", note: "<redacted>" },
    });
    expect(ex!.response).toEqual({
      status: 200,
      contentType: "text/event-stream",
      sse: ['data: {"id":"chatcmpl-recorded","host":"http://local-model-host:11434"}'],
    });
    const text = JSON.stringify(ex);
    for (const [label, pattern] of FORBIDDEN_FIXTURE_PATTERNS) {
      expect(pattern.test(text), label).toBe(false);
    }
  });

  it("recordResponseBody keeps SSE as events, JSON as JSON and anything else as text", () => {
    expect(recordResponseBody(200, "text/event-stream", "data: a\n\ndata: b\n\n").sse).toEqual([
      "data: a",
      "data: b",
    ]);
    expect(recordResponseBody(200, "application/json", '{"a":1}').json).toEqual({ a: 1 });
    expect(recordResponseBody(502, "application/json", "not json").text).toBe("not json");
    expect(recordResponseBody(200, "text/plain", "ok").text).toBe("ok");
  });
});
