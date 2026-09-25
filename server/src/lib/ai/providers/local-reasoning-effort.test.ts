/**
 * The local provider must actually switch a thinking model's reasoning OFF.
 *
 * Measured on Ollama 0.34.2's OpenAI-compatible `/v1/chat/completions` with
 * laguna-s-2.1: `think: false` is IGNORED (800/800 completion tokens of
 * reasoning, `finish_reason: "length"`), while `reasoning_effort: "none"` gives
 * a complete answer with no reasoning. gemma3:12b (no thinking support) accepts
 * `"none"` but answers `400 "gemma3:12b" does not support thinking` for any
 * other effort — so an explicit effort needs a single graceful fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

const {
  OpenAICompatibleProvider,
  LOCAL_REASONING_EFFORT_ENV,
  isReasoningEffortUnsupportedBody,
  resolveLocalReasoningEffortMode,
  resetLocalConcurrencyLimitersForTests,
} = await import("./openai-compatible-provider.js");

type Opts = ConstructorParameters<typeof OpenAICompatibleProvider>[0];
type ChatOpts = Parameters<InstanceType<typeof OpenAICompatibleProvider>["chat"]>[1];

const originalFetch = globalThis.fetch;
let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env[LOCAL_REASONING_EFFORT_ENV];
  delete process.env[LOCAL_REASONING_EFFORT_ENV];
  resetLocalConcurrencyLimitersForTests();
  logWarn.mockReset();
});

afterEach(() => {
  if (savedMode === undefined) delete process.env[LOCAL_REASONING_EFFORT_ENV];
  else process.env[LOCAL_REASONING_EFFORT_ENV] = savedMode;
  globalThis.fetch = originalFetch;
});

function provider(over: Partial<Opts> = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "laguna-s-2.1",
    providerKey: "local-gemma",
    maxAttempts: 1,
    sleepFn: async () => undefined,
    ...over,
  });
}

function okJson(content = "Red, Blue, Yellow"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function okSse(content = "Red"): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Ollama 0.34.2's exact rejection for an effort on a non-thinking model. */
function rejectsThinking(model = "gemma3:12b"): Response {
  return new Response(
    JSON.stringify({
      error: { message: `"${model}" does not support thinking`, type: "invalid_request_error" },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/** Install a fetch mock answering from `responses` in order; returns parsed bodies. */
function mockFetch(...responses: Array<() => Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const make = responses[Math.min(i++, responses.length - 1)];
    return make();
  }) as unknown as typeof fetch;
  return bodies;
}

async function chatBody(p: InstanceType<typeof OpenAICompatibleProvider>, opts?: ChatOpts) {
  const bodies = mockFetch(() => okJson());
  await p.chat([{ role: "user", content: "hi" }], opts);
  return bodies[0];
}

async function drain(p: InstanceType<typeof OpenAICompatibleProvider>, opts?: ChatOpts) {
  let text = "";
  for await (const c of p.stream([{ role: "user", content: "hi" }], opts)) {
    if (c.type === "delta") text += c.content;
  }
  return text;
}

describe("thinking off on local-gemma sends reasoning_effort: none", () => {
  it("adds reasoning_effort none alongside think:false when the provider disables thinking (chat)", async () => {
    const body = await chatBody(provider({ disableThinking: true }));
    expect(body.think).toBe(false);
    expect(body.reasoning_effort).toBe("none");
  });

  it("does the same on stream()", async () => {
    const bodies = mockFetch(() => okSse());
    await drain(provider({ disableThinking: true }));
    expect(bodies[0].think).toBe(false);
    expect(bodies[0].reasoning_effort).toBe("none");
  });

  it("honours a per-call disableThinking (docs-gen DOCS_GEN_PHASE1_REASONING=off)", async () => {
    const body = await chatBody(provider(), { disableThinking: true });
    expect(body.think).toBe(false);
    expect(body.reasoning_effort).toBe("none");
  });

  it("sends neither field when nothing asks for thinking to change (model default)", async () => {
    const body = await chatBody(provider());
    expect(body).not.toHaveProperty("think");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("explicit reasoning efforts reach the local runtime", () => {
  it("forwards a per-call reasoningEffort as reasoning_effort (previously dropped)", async () => {
    const body = await chatBody(provider(), { reasoningEffort: "low" });
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("think");
  });

  it("an explicit effort overrides the provider-level disableThinking", async () => {
    const body = await chatBody(provider({ disableThinking: true }), { reasoningEffort: "high" });
    expect(body.reasoning_effort).toBe("high");
    expect(body).not.toHaveProperty("think");
  });

  it("per-call disableThinking beats a per-call effort", async () => {
    const body = await chatBody(provider(), { disableThinking: true, reasoningEffort: "high" });
    expect(body.think).toBe(false);
    expect(body.reasoning_effort).toBe("none");
  });

  it("forwards the effort on stream() too", async () => {
    const bodies = mockFetch(() => okSse());
    await drain(provider(), { reasoningEffort: "medium" });
    expect(bodies[0].reasoning_effort).toBe("medium");
  });
});

describe("non-local providers are unchanged", () => {
  it("never sends reasoning_effort to the Bedrock gateway (it would enable Claude thinking)", async () => {
    const p = provider({ providerKey: "bedrock-gateway" });
    const body = await chatBody(p, { reasoningEffort: "high", disableThinking: true });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("think");
  });

  it("keeps think:false-only for a non-local provider built with disableThinking", async () => {
    const body = await chatBody(
      provider({ providerKey: "bedrock-gateway", disableThinking: true }),
    );
    expect(body.think).toBe(false);
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("fallback when a model rejects reasoning_effort", () => {
  it("chat(): retries once without the field, then remembers the model", async () => {
    const p = provider({ model: "gemma3:12b" });
    const bodies = mockFetch(
      () => rejectsThinking(),
      () => okJson("A"),
      () => okJson("B"),
    );
    const first = await p.chat([{ role: "user", content: "hi" }], { reasoningEffort: "low" });
    expect(first.content).toBe("A");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(logWarn).toHaveBeenCalledWith(
      "Runtime rejected reasoning_effort; retrying once without it",
      expect.objectContaining({ model: "gemma3:12b", status: 400 }),
    );

    const second = await p.chat([{ role: "user", content: "hi" }], { reasoningEffort: "low" });
    expect(second.content).toBe("B");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it("stream(): retries once without the field and keeps think:false", async () => {
    const p = provider({ model: "gemma3:12b", disableThinking: true });
    const bodies = mockFetch(
      () => rejectsThinking(),
      () => okSse("ok"),
    );
    expect(await drain(p)).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].reasoning_effort).toBe("none");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1].think).toBe(false);
  });

  it("does not retry an unrelated 400", async () => {
    const bodies = mockFetch(
      () => new Response('{"error":{"message":"model \\"x\\" not found"}}', { status: 400 }),
    );
    await expect(
      provider().chat([{ role: "user", content: "hi" }], { reasoningEffort: "low" }),
    ).rejects.toThrow(/400/);
    expect(bodies).toHaveLength(1);
  });

  it("LOCAL_GEMMA_SEND_REASONING_EFFORT=always surfaces the rejection instead of retrying", async () => {
    process.env[LOCAL_REASONING_EFFORT_ENV] = "always";
    const bodies = mockFetch(() => rejectsThinking());
    await expect(
      provider({ model: "gemma3:12b" }).chat([{ role: "user", content: "hi" }], {
        reasoningEffort: "low",
      }),
    ).rejects.toThrow(/does not support thinking/);
    expect(bodies).toHaveLength(1);
  });

  it("LOCAL_GEMMA_SEND_REASONING_EFFORT=never sends think:false only and drops efforts", async () => {
    process.env[LOCAL_REASONING_EFFORT_ENV] = "never";
    const off = await chatBody(provider({ disableThinking: true }));
    expect(off.think).toBe(false);
    expect(off).not.toHaveProperty("reasoning_effort");
    const effort = await chatBody(provider(), { reasoningEffort: "low" });
    expect(effort).not.toHaveProperty("reasoning_effort");
  });
});

describe("helpers", () => {
  it("classifies Ollama's reasoning rejections and nothing else", () => {
    expect(isReasoningEffortUnsupportedBody(400, '"gemma3:12b" does not support thinking')).toBe(
      true,
    );
    expect(isReasoningEffortUnsupportedBody(400, 'invalid reasoning value: "bogus"')).toBe(true);
    expect(isReasoningEffortUnsupportedBody(422, "reasoning_effort not allowed")).toBe(true);
    expect(isReasoningEffortUnsupportedBody(500, "does not support thinking")).toBe(false);
    expect(isReasoningEffortUnsupportedBody(400, "model not found")).toBe(false);
  });

  // PR #187 review M2 — a bare /reasoning|think/ matched MODEL NAMES that Ollama
  // echoes into unrelated errors, and the model was then remembered as rejecting
  // reasoning_effort for the life of the provider.
  it.each([
    '"phi4-reasoning:14b" does not support tools',
    'model "qwen3:4b-thinking-2507" not found',
    '{"error":{"message":"\\"phi4-reasoning:14b\\" does not support tools"}}',
    '{"error":"model \\"deepseek-reasoning_effort:7b\\" not found, try pulling it first"}',
  ])("does NOT classify an unrelated 400 that quotes a keyword-bearing model name: %s", (body) => {
    expect(isReasoningEffortUnsupportedBody(400, body)).toBe(false);
  });

  it.each([
    '"qwen3:4b-thinking-2507" does not support thinking',
    '{"error":{"message":"\\"gemma3:12b\\" does not support thinking","type":"invalid_request_error"}}',
    'invalid reasoning value: "extreme"',
    "invalid reasoning effort: must be one of none, low, medium, high",
    "Unrecognized request argument supplied: reasoning_effort",
    "unknown field `reasoning_effort`",
  ])("classifies a genuine reasoning rejection: %s", (body) => {
    expect(isReasoningEffortUnsupportedBody(400, body)).toBe(true);
  });

  it("an unrelated 400 naming a thinking model is surfaced and NOT remembered", async () => {
    const tools = () =>
      new Response(
        JSON.stringify({ error: { message: '"phi4-reasoning:14b" does not support tools' } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    const p = provider({ model: "phi4-reasoning:14b", disableThinking: true });
    const bodies = mockFetch(tools, () => okJson());
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /does not support tools/,
    );
    await p.chat([{ role: "user", content: "hi" }]);
    // One attempt for the failing call (no reasoning retry), and the next call
    // still turns thinking off with reasoning_effort.
    expect(bodies).toHaveLength(2);
    expect(bodies[1].reasoning_effort).toBe("none");
  });

  it("parses the mode env, defaulting unknown values to auto with a warning", () => {
    expect(resolveLocalReasoningEffortMode(undefined)).toBe("auto");
    expect(resolveLocalReasoningEffortMode("  ")).toBe("auto");
    expect(resolveLocalReasoningEffortMode("ALWAYS")).toBe("always");
    expect(resolveLocalReasoningEffortMode("never")).toBe("never");
    expect(logWarn).not.toHaveBeenCalled();
    expect(resolveLocalReasoningEffortMode("sometimes")).toBe("auto");
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
