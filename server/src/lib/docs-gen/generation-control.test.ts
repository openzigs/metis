/**
 * #855 — the stop switch and cost ceiling of one documentation generation, and
 * the provider wrapper that carries its AbortSignal into every model call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordUsage = vi.hoisted(() => vi.fn());
vi.mock("../finops/index.js", () => ({ recordUsage }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { ConfigService } from "../config/config-service.js";
import {
  ABORTED_CALL_AGENT_STEP,
  DEFAULT_MAX_RUN_COST_CENTS,
  DEFAULT_MAX_RUN_TOKENS,
  GenerationControl,
  MAX_RUN_COST_CENTS_KEY,
  MAX_RUN_TOKENS_KEY,
  releaseGenerationControl,
  resolveRunCeiling,
  scopedToGeneration,
  startGenerationControl,
  stopGeneration,
} from "./generation-control.js";
import {
  currentGenerationScope,
  isGenerationStop,
  throwIfGenerationStopped,
  withGenerationScope,
} from "./generation-scope.js";
import { UnpublishableGenerationError } from "./generation-checkpoint.js";
import { noteRunUsage } from "./run-cost.js";

const config = (values: Record<string, number>): ConfigService =>
  ({ getNumber: (key: string, d?: number) => values[key] ?? d }) as unknown as ConfigService;

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "s".repeat(350) },
  { role: "user", content: "u".repeat(350) },
];

/** A provider whose stream yields `parts` and then waits on the abort signal. */
function hangingProvider(parts: ChatChunk[] = []): AIProvider & {
  streamOpts: Array<ChatOptions | undefined>;
  chatOpts: Array<ChatOptions | undefined>;
} {
  const streamOpts: Array<ChatOptions | undefined> = [];
  const chatOpts: Array<ChatOptions | undefined> = [];
  const waitForAbort = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort);
    });
  return {
    key: "anthropic",
    model: "claude-sonnet-4",
    offline: false,
    streamOpts,
    chatOpts,
    async *stream(_messages: ChatMessage[], opts?: ChatOptions) {
      streamOpts.push(opts);
      for (const part of parts) yield part;
      await waitForAbort(opts?.signal);
    },
    async chat(_messages: ChatMessage[], opts?: ChatOptions) {
      chatOpts.push(opts);
      return waitForAbort(opts?.signal);
    },
    embed: vi.fn(),
    models: vi.fn(async function (this: unknown) {
      return [String((this as { model?: string }).model)];
    }),
  } as unknown as AIProvider & {
    streamOpts: Array<ChatOptions | undefined>;
    chatOpts: Array<ChatOptions | undefined>;
  };
}

beforeEach(() => {
  recordUsage.mockClear();
});

describe("resolveRunCeiling", () => {
  it("defaults to a $25 / 20M-token ceiling", () => {
    expect(resolveRunCeiling(config({}))).toEqual({
      maxCostCents: DEFAULT_MAX_RUN_COST_CENTS,
      maxTokens: DEFAULT_MAX_RUN_TOKENS,
    });
    expect(DEFAULT_MAX_RUN_COST_CENTS).toBe(2_500);
  });

  it("treats 0 as no ceiling and a negative value as the default", () => {
    expect(
      resolveRunCeiling(config({ [MAX_RUN_COST_CENTS_KEY]: 0, [MAX_RUN_TOKENS_KEY]: -5 })),
    ).toEqual({ maxCostCents: null, maxTokens: DEFAULT_MAX_RUN_TOKENS });
  });

  it("reads both registry keys", () => {
    expect(
      resolveRunCeiling(config({ [MAX_RUN_COST_CENTS_KEY]: 100, [MAX_RUN_TOKENS_KEY]: 5_000 })),
    ).toEqual({ maxCostCents: 100, maxTokens: 5_000 });
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(resolveRunCeiling(config({ [MAX_RUN_COST_CENTS_KEY]: Number.NaN })).maxCostCents).toBe(
      DEFAULT_MAX_RUN_COST_CENTS,
    );
  });
});

describe("GenerationControl", () => {
  it("aborts its signal with the first stop reason only", () => {
    const control = new GenerationControl("d", "p");
    expect(control.reason).toBeNull();
    control.stop("aborted");
    control.stop("budget");
    expect(control.reason).toBe("aborted");
    expect(control.signal.aborted).toBe(true);
    expect(control.signal.reason).toBeInstanceOf(UnpublishableGenerationError);
    expect(control.stopError()?.reason).toBe("aborted");
  });

  it("stops the run at the token ceiling", () => {
    const control = new GenerationControl("d", "p", { maxCostCents: null, maxTokens: 1_000 });
    control.noteSpend({ provider: "x", model: "unpriced", inputTokens: 600, outputTokens: 300 });
    expect(control.reason).toBeNull();
    control.noteSpend({ provider: "x", model: "unpriced", inputTokens: 50, outputTokens: 50 });
    expect(control.reason).toBe("budget");
    expect(control.spend().tokens).toBe(1_000);
    // An unpriced model has no cost: only the token ceiling can bound it.
    expect(control.spend().costCents).toBeNull();
  });

  it("stops the run at the cost ceiling", () => {
    const control = new GenerationControl("d", "p", { maxCostCents: 100, maxTokens: null });
    // Sonnet 4 at $15 / M output: 50k output tokens is 75 cents.
    control.noteSpend({
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 0,
      outputTokens: 50_000,
    });
    expect(control.reason).toBeNull();
    control.noteSpend({
      provider: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 0,
      outputTokens: 50_000,
    });
    expect(control.reason).toBe("budget");
    expect(control.spend().costCents).toBeCloseTo(150, 5);
  });

  it("does nothing without a ceiling, and keeps counting after a stop", () => {
    const control = new GenerationControl("d", "p");
    control.noteSpend({ provider: "x", model: "m", inputTokens: 10 ** 9, outputTokens: 0 });
    expect(control.reason).toBeNull();
    control.stop("aborted");
    control.noteSpend({ provider: "x", model: "m", inputTokens: 1, outputTokens: 0 });
    expect(control.spend().tokens).toBe(10 ** 9 + 1);
  });
});

describe("the live-run registry", () => {
  it("stops every registered run of a document, and none once released", () => {
    const a = startGenerationControl("doc-1", "p", { maxCostCents: null, maxTokens: null });
    const b = startGenerationControl("doc-1", "p", { maxCostCents: null, maxTokens: null });
    const other = startGenerationControl("doc-2", "p", { maxCostCents: null, maxTokens: null });
    expect(stopGeneration("doc-1", "aborted")).toBe(2);
    expect(a.reason).toBe("aborted");
    expect(b.reason).toBe("aborted");
    expect(other.reason).toBeNull();
    releaseGenerationControl(a);
    releaseGenerationControl(b);
    releaseGenerationControl(b);
    expect(stopGeneration("doc-1", "aborted")).toBe(0);
    releaseGenerationControl(other);
    expect(stopGeneration("doc-2", "superseded")).toBe(0);
    expect(other.reason).toBeNull();
  });

  it("uses the configured ceiling by default", () => {
    const control = startGenerationControl("doc-3", "p");
    expect(control.ceiling.maxTokens).toBe(DEFAULT_MAX_RUN_TOKENS);
    releaseGenerationControl(control);
  });
});

describe("generation scope helpers", () => {
  it("report the stop of the current run, and nothing outside one", async () => {
    expect(currentGenerationScope()).toBeUndefined();
    expect(() => throwIfGenerationStopped()).not.toThrow();
    expect(isGenerationStop(new Error("x"))).toBe(false);
    const control = new GenerationControl("d", "p");
    await withGenerationScope(control, async () => {
      expect(currentGenerationScope()).toBe(control);
      expect(() => throwIfGenerationStopped()).not.toThrow();
      control.stop("aborted");
      expect(() => throwIfGenerationStopped()).toThrow(UnpublishableGenerationError);
      // Any error after the stop ends the run, e.g. the provider's AbortError.
      expect(isGenerationStop(new Error("AbortError"))).toBe(true);
    });
    expect(isGenerationStop(new UnpublishableGenerationError("inputs-changed", "x"))).toBe(true);
  });

  it("noteRunUsage reports each recorded call to the current generation", async () => {
    const control = new GenerationControl("d", "p", { maxCostCents: null, maxTokens: 10 });
    await withGenerationScope(control, async () => {
      noteRunUsage({ provider: "x", model: "m", inputTokens: 6, outputTokens: 6 });
    });
    expect(control.reason).toBe("budget");
    // Outside a generation it is a no-op.
    expect(() =>
      noteRunUsage({ provider: "x", model: "m", inputTokens: 1, outputTokens: 1 }),
    ).not.toThrow();
  });
});

describe("scopedToGeneration", () => {
  it("passes calls through untouched outside a generation", async () => {
    const inner = hangingProvider([{ type: "delta", content: "hi" }]);
    const wrapped = scopedToGeneration(inner);
    const opts = { sessionId: "s" };
    const gen = wrapped.stream(MESSAGES, opts);
    await gen.next();
    expect(inner.streamOpts[0]).toBe(opts);
    await gen.return(undefined);
    void wrapped.chat(MESSAGES, opts);
    expect(inner.chatOpts[0]).toBe(opts);
    // Everything else is the provider's own, bound to it.
    expect(wrapped.key).toBe("anthropic");
    expect(await wrapped.models()).toEqual(["claude-sonnet-4"]);
  });

  it("aborts an in-flight stream on stop and records an estimate of what it spent", async () => {
    const inner = hangingProvider([{ type: "delta", content: "x".repeat(70) }]);
    const wrapped = scopedToGeneration(inner);
    const control = new GenerationControl("doc", "proj");
    await withGenerationScope(control, async () => {
      const consumed = (async () => {
        for await (const _ of wrapped.stream(MESSAGES, { sessionId: "docs-synth-1" })) {
          control.stop("aborted");
        }
      })();
      await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
    });
    expect(inner.streamOpts[0]?.signal?.aborted).toBe(true);
    expect(inner.streamOpts[0]?.sessionId).toBe("docs-synth-1");
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      projectId: "proj",
      sessionId: "docs-synth-1",
      agentStep: ABORTED_CALL_AGENT_STEP,
      provider: "anthropic",
      model: "claude-sonnet-4",
      // 700 prompt chars and 70 reply chars at 3.5 chars/token.
      inputTokens: 200,
      outputTokens: 20,
    });
  });

  it("records the provider's own usage when it arrived before the abort", async () => {
    const inner = hangingProvider([
      {
        type: "usage",
        usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940, cacheReadTokens: 5 },
      },
    ]);
    const wrapped = scopedToGeneration(inner);
    const control = new GenerationControl("doc", "proj");
    await withGenerationScope(control, async () => {
      const consumed = (async () => {
        for await (const _ of wrapped.stream(MESSAGES, { model: "claude-haiku" })) {
          control.stop("budget");
        }
      })();
      await expect(consumed).rejects.toThrow();
    });
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      sessionId: "docs-aborted-doc",
      model: "claude-haiku",
      inputTokens: 900,
      outputTokens: 40,
      cacheReadTokens: 5,
    });
  });

  it("aborts an in-flight chat call and records its prompt", async () => {
    const inner = hangingProvider();
    const wrapped = scopedToGeneration(inner);
    const control = new GenerationControl("doc", "proj");
    const caller = new AbortController();
    await withGenerationScope(control, async () => {
      const call = wrapped.chat(MESSAGES, { signal: caller.signal });
      control.stop("aborted");
      await expect(call).rejects.toMatchObject({ name: "AbortError" });
    });
    // The caller's own signal still works alongside the run's.
    expect(inner.chatOpts[0]?.signal).not.toBe(caller.signal);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({ inputTokens: 200, outputTokens: 0 });
  });

  it("does not record a chat failure that was not an abort", async () => {
    const inner = hangingProvider();
    inner.chat = vi.fn(async () => {
      throw new Error("500");
    });
    const wrapped = scopedToGeneration(inner);
    await withGenerationScope(new GenerationControl("d", "p"), async () => {
      await expect(wrapped.chat(MESSAGES)).rejects.toThrow("500");
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("refuses new calls once the run is stopped, without reaching the provider", async () => {
    const inner = hangingProvider();
    const wrapped = scopedToGeneration(inner);
    const control = new GenerationControl("d", "p");
    control.stop("superseded");
    await withGenerationScope(control, async () => {
      await expect(wrapped.chat(MESSAGES)).rejects.toBeInstanceOf(UnpublishableGenerationError);
      await expect(wrapped.stream(MESSAGES).next()).rejects.toBeInstanceOf(
        UnpublishableGenerationError,
      );
    });
    expect(inner.chatOpts).toHaveLength(0);
    expect(inner.streamOpts).toHaveLength(0);
  });

  it("never lets a usage-recording failure mask the abort", async () => {
    recordUsage.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const inner = hangingProvider();
    const wrapped = scopedToGeneration(inner);
    const control = new GenerationControl("d", "p");
    await withGenerationScope(control, async () => {
      const call = wrapped.chat([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
      control.stop("aborted");
      await expect(call).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});
