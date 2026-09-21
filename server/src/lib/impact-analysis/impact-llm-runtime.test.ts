/**
 * Issues #1021 + #1024 — the metering / deadline / degradation decorator.
 *
 * These tests pin the two guarantees the issues ask for:
 *   - EVERY completed stage call produces a token event carrying the project it
 *     was run for and a stage-identifying `agentStep` (#1021); and
 *   - a stage that cannot reach a provider — absent, erroring, or hanging —
 *     degrades without hanging the run, and the run can say so out loud (#1024).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createImpactLlmRuntime,
  impactLlmTimeoutMs,
  DEFAULT_IMPACT_LLM_TIMEOUT_MS,
  ImpactLlmTimeoutError,
  IMPACT_LLM_AGENT_STEP,
  IMPACT_LLM_STAGES,
  type ImpactLlmRuntimeOptions,
} from "./impact-llm-runtime.js";
import { runInImpactProjectScope } from "./impact-llm-scope.js";
import type { AIProvider, ChatChunk, ChatOptions, ChatResponse, TokenUsage } from "../ai/types.js";

const USAGE: TokenUsage = { promptTokens: 900, completionTokens: 120, totalTokens: 1020 };

interface FakeProviderOptions {
  usage?: TokenUsage;
  chat?: (messages: unknown, opts?: ChatOptions) => Promise<ChatResponse>;
  streamChunks?: ChatChunk[];
}

function fakeProvider(opts: FakeProviderOptions = {}): AIProvider {
  const usage = opts.usage ?? USAGE;
  return {
    key: "anthropic",
    model: "claude-sonnet-5",
    offline: false,
    chat:
      opts.chat ??
      (async () => ({
        content: "{}",
        usage,
        model: "claude-sonnet-5",
        provider: "anthropic",
      })),
    async *stream() {
      for (const chunk of opts.streamChunks ?? []) yield chunk;
    },
    embed: async () => ({ vectors: [], model: "e", dimensions: 0 }),
    models: async () => ["claude-sonnet-5"],
    ping: async () => true,
  } as unknown as AIProvider;
}

function runtimeWith(overrides: Partial<ImpactLlmRuntimeOptions> = {}) {
  const record = vi.fn();
  const createSession = vi.fn(async () => "sess-1");
  const runtime = createImpactLlmRuntime({
    actorId: "user-1",
    projectIds: ["proj-1"],
    tracker: { record } as never,
    createSession,
    ...overrides,
  });
  return { runtime, record, createSession };
}

describe("impactLlmTimeoutMs", () => {
  it("defaults when unset, non-numeric, zero or negative — there is deliberately no 'off'", () => {
    expect(impactLlmTimeoutMs({})).toBe(DEFAULT_IMPACT_LLM_TIMEOUT_MS);
    expect(impactLlmTimeoutMs({ IMPACT_LLM_TIMEOUT_MS: "abc" })).toBe(
      DEFAULT_IMPACT_LLM_TIMEOUT_MS,
    );
    expect(impactLlmTimeoutMs({ IMPACT_LLM_TIMEOUT_MS: "0" })).toBe(DEFAULT_IMPACT_LLM_TIMEOUT_MS);
    expect(impactLlmTimeoutMs({ IMPACT_LLM_TIMEOUT_MS: "-5" })).toBe(DEFAULT_IMPACT_LLM_TIMEOUT_MS);
  });

  it("honours a positive override", () => {
    expect(impactLlmTimeoutMs({ IMPACT_LLM_TIMEOUT_MS: "2500" })).toBe(2500);
  });
});

describe("createImpactLlmRuntime — metering (#1021)", () => {
  it("records one token event per call, with the scope's project and the stage's agentStep", async () => {
    const { runtime, record } = runtimeWith();
    const provider = runtime.instrument(fakeProvider(), "table-filter");

    await runInImpactProjectScope("proj-42", () => provider.chat([]));
    await runtime.flush();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      sessionId: "sess-1",
      userId: "user-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectId: "proj-42",
      agentStep: IMPACT_LLM_AGENT_STEP["table-filter"],
    });
    expect(record.mock.calls[0][0].usage.totalTokens).toBe(1020);
  });

  it("falls back to the run's first project outside a scope (never an unattributed row)", async () => {
    const { runtime, record } = runtimeWith({ projectIds: ["proj-first", "proj-second"] });
    const provider = runtime.instrument(fakeProvider(), "summary-item");

    await provider.chat([]);
    await runtime.flush();

    expect(record.mock.calls[0][0].projectId).toBe("proj-first");
  });

  it("creates the backing session exactly once across stages and calls", async () => {
    const { runtime, record, createSession } = runtimeWith();
    const filter = runtime.instrument(fakeProvider(), "table-filter");
    const summary = runtime.instrument(fakeProvider(), "summary-item");

    await filter.chat([]);
    await summary.chat([]);
    await filter.chat([]);
    await runtime.flush();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(3);
    expect(record.mock.calls.map((c) => c[0].agentStep)).toEqual([
      IMPACT_LLM_AGENT_STEP["table-filter"],
      IMPACT_LLM_AGENT_STEP["summary-item"],
      IMPACT_LLM_AGENT_STEP["table-filter"],
    ]);
  });

  it("gives every stage a distinct agentStep so spend is attributable per stage", () => {
    const steps = IMPACT_LLM_STAGES.map((s) => IMPACT_LLM_AGENT_STEP[s]);
    expect(new Set(steps).size).toBe(IMPACT_LLM_STAGES.length);
    expect(steps.every((s) => s.startsWith("impact."))).toBe(true);
  });

  it("skips a zero-token response (offline stub / fixture replay) rather than writing an empty row", async () => {
    const { runtime, record, createSession } = runtimeWith();
    const provider = runtime.instrument(
      fakeProvider({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      "summary-item",
    );

    await provider.chat([]);
    await runtime.flush();

    expect(record).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("derives totalTokens when the provider reports only prompt/completion", async () => {
    const { runtime, record } = runtimeWith();
    const provider = runtime.instrument(
      fakeProvider({
        usage: { promptTokens: 10, completionTokens: 5 } as TokenUsage,
      }),
      "additive-ddl",
    );

    await provider.chat([]);
    await runtime.flush();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("keeps the stage's result when the session cannot be created (accounting never sinks a run)", async () => {
    const { runtime, record } = runtimeWith({
      createSession: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const provider = runtime.instrument(fakeProvider(), "clause-reconcile");

    const res = await provider.chat([]);
    await runtime.flush();

    expect(res.content).toBe("{}");
    expect(record).not.toHaveBeenCalled();
    expect(runtime.degradationNotice()).toBeNull();
  });

  it("meters a streamed usage chunk too, so a future streaming stage is not a silent hole", async () => {
    const { runtime, record } = runtimeWith();
    const provider = runtime.instrument(
      fakeProvider({
        streamChunks: [
          { type: "delta", content: "hi" },
          { type: "usage", usage: USAGE },
          { type: "done" },
        ],
      }),
      "summary-item",
    );

    const seen: string[] = [];
    await runInImpactProjectScope("proj-9", async () => {
      for await (const chunk of provider.stream([])) seen.push(chunk.type);
    });
    await runtime.flush();

    expect(seen).toEqual(["delta", "usage", "done"]);
    expect(record.mock.calls[0][0]).toMatchObject({
      projectId: "proj-9",
      agentStep: IMPACT_LLM_AGENT_STEP["summary-item"],
    });
  });

  it("passes the provider identity and the non-chat methods straight through", async () => {
    const { runtime } = runtimeWith();
    const inner = fakeProvider();
    const wrapped = runtime.instrument(inner, "seeding");

    expect(wrapped.key).toBe(inner.key);
    expect(wrapped.model).toBe(inner.model);
    expect(wrapped.offline).toBe(false);
    expect(await wrapped.models()).toEqual(["claude-sonnet-5"]);
    expect(await wrapped.ping()).toBe(true);
    expect((await wrapped.embed(["x"])).model).toBe("e");
  });
});

describe("createImpactLlmRuntime — degradation (#1024)", () => {
  it("aborts and rejects a call that blows the deadline instead of hanging the run", async () => {
    const { runtime } = runtimeWith({ timeoutMs: 20 });
    let sawAbort = false;
    const provider = runtime.instrument(
      fakeProvider({
        chat: (_messages, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("aborted"));
            });
          }),
      }),
      "table-filter",
    );

    await expect(provider.chat([])).rejects.toBeInstanceOf(ImpactLlmTimeoutError);
    expect(sawAbort).toBe(true);
    expect(runtime.snapshot()).toEqual([
      { stage: "table-filter", calls: 0, failures: 0, timeouts: 1, unavailableReason: null },
    ]);
  });

  it("still returns from the deadline when the provider ignores the abort signal", async () => {
    const { runtime } = runtimeWith({ timeoutMs: 20 });
    const provider = runtime.instrument(
      fakeProvider({ chat: () => new Promise<ChatResponse>(() => {}) }),
      "summary-item",
    );

    await expect(provider.chat([])).rejects.toBeInstanceOf(ImpactLlmTimeoutError);
    expect(runtime.degradationNotice()).toContain("the AI provider timed out");
  });

  it("propagates a provider error unchanged and counts it as a failure", async () => {
    const { runtime } = runtimeWith();
    const provider = runtime.instrument(
      fakeProvider({
        chat: async () => {
          throw new Error("401 invalid x-api-key");
        },
      }),
      "additive-ddl",
    );

    await expect(provider.chat([])).rejects.toThrow(/invalid x-api-key/);
    expect(runtime.snapshot()[0]).toMatchObject({ failures: 1, timeouts: 0, calls: 0 });
    expect(runtime.degradationNotice()).toContain("the AI provider returned an error");
  });

  it("names every unavailable stage and states the result is the deterministic baseline", () => {
    const { runtime } = runtimeWith();
    runtime.markUnavailable("table-filter", "provider-offline");
    runtime.markUnavailable("additive-ddl", "provider-offline");
    runtime.markUnavailable("summary-item", "no-provider");

    const notice = runtime.degradationNotice();
    expect(notice).toContain("no AI provider is configured");
    expect(notice).toContain("deterministic code-graph and schema baseline");
    expect(notice).toContain("table relevance filtering");
    expect(notice).toContain("additive-column proposals");
    expect(notice).toContain("narrative summaries");
  });

  it("says nothing when no stage degraded — silence must mean 'nothing to disclose'", async () => {
    const { runtime } = runtimeWith();
    const provider = runtime.instrument(fakeProvider(), "summary-item");
    await provider.chat([]);
    await runtime.flush();
    expect(runtime.degradationNotice()).toBeNull();
  });

  it("does not name a stage that produced real output, even if a later call failed", async () => {
    let calls = 0;
    const { runtime } = runtimeWith();
    const provider = runtime.instrument(
      fakeProvider({
        chat: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              content: "{}",
              usage: USAGE,
              model: "claude-sonnet-5",
              provider: "anthropic" as const,
            };
          }
          throw new Error("rate limited");
        },
      }),
      "table-filter",
    );

    await provider.chat([]);
    await expect(provider.chat([])).rejects.toThrow(/rate limited/);
    await runtime.flush();

    expect(runtime.degradationNotice()).toBeNull();
  });

  it("reports the generic reason when unavailability and live faults are mixed", async () => {
    const { runtime } = runtimeWith();
    runtime.markUnavailable("summary-item", "provider-build-failed");
    const provider = runtime.instrument(
      fakeProvider({
        chat: async () => {
          throw new Error("boom");
        },
      }),
      "table-filter",
    );
    await expect(provider.chat([])).rejects.toThrow(/boom/);

    expect(runtime.degradationNotice()).toContain("the AI provider was unavailable");
  });

  it("reports stage counters in pipeline order for operator triage", async () => {
    const { runtime } = runtimeWith();
    runtime.markUnavailable("summary-item", "provider-offline");
    runtime.markUnavailable("seeding", "provider-offline");
    expect(runtime.snapshot().map((s) => s.stage)).toEqual(["seeding", "summary-item"]);
  });
});
