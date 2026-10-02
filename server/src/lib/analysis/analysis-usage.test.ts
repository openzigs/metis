/**
 * Issue #724 — the analysis-family provider meter records project usage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordUsage = vi.hoisted(() => vi.fn());
vi.mock("../finops/token-tracker.js", () => ({ recordUsage }));

const { meterAnalysisProvider, runInAnalysisUsageScope, currentAnalysisUsageScope } =
  await import("./analysis-usage.js");
import type { AIProvider, ChatChunk, ChatResponse } from "../ai/types.js";

const USAGE = {
  promptTokens: 100,
  completionTokens: 40,
  totalTokens: 140,
  cacheReadTokens: 7,
  cacheWriteTokens: 3,
};

class FakeProvider implements AIProvider {
  readonly key = "anthropic" as const;
  readonly model = "default-model";
  readonly offline = false;
  readonly capabilities = { tools: true } as unknown as AIProvider["capabilities"];
  chatCalls = 0;
  async chat(): Promise<ChatResponse> {
    this.chatCalls += 1;
    return { content: "ok", usage: USAGE, model: "served-model", provider: "anthropic" };
  }
  async *stream(): AsyncGenerator<ChatChunk> {
    yield { type: "delta", content: "a" };
    yield { type: "usage", usage: USAGE };
    yield { type: "done" };
  }
  async embed() {
    return { vectors: [], model: "e", dimensions: 0 } as unknown as Awaited<
      ReturnType<AIProvider["embed"]>
    >;
  }
  async models() {
    return [this.model];
  }
  async ping() {
    // Proves `this` reaches the adapter (a `this.chat` here must not be metered).
    await this.chat();
    return true;
  }
  servesRouterModel(id: string) {
    return id === this.model;
  }
}

const SCOPE = { projectId: "proj-1", sessionId: "ana-1" };

beforeEach(() => recordUsage.mockReset());

describe("meterAnalysisProvider", () => {
  it("records a completed chat against the active scope's project", async () => {
    const metered = meterAnalysisProvider(new FakeProvider());
    const res = await runInAnalysisUsageScope(SCOPE, () => metered.chat([]));
    expect(res.content).toBe("ok");
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({
      projectId: "proj-1",
      sessionId: "ana-1",
      provider: "anthropic",
      model: "served-model",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
  });

  it("falls back to the requested model, then the provider's, when the response names none", async () => {
    const inner = new FakeProvider();
    inner.chat = async () => ({ content: "", usage: USAGE }) as unknown as ChatResponse;
    const metered = meterAnalysisProvider(inner);
    await runInAnalysisUsageScope(SCOPE, () => metered.chat([], { model: "asked" }));
    await runInAnalysisUsageScope(SCOPE, () => metered.chat([]));
    expect(recordUsage.mock.calls.map((c) => [c[0].provider, c[0].model])).toEqual([
      ["anthropic", "asked"],
      ["anthropic", "default-model"],
    ]);
  });

  it("records nothing outside a scope", async () => {
    const metered = meterAnalysisProvider(new FakeProvider());
    await metered.chat([]);
    for await (const _ of metered.stream([])) void _;
    expect(recordUsage).not.toHaveBeenCalled();
    expect(currentAnalysisUsageScope()).toBeNull();
  });

  it("records nothing when the response carries no usage", async () => {
    const inner = new FakeProvider();
    inner.chat = async () =>
      ({ content: "", model: "m", provider: "anthropic" }) as unknown as ChatResponse;
    const metered = meterAnalysisProvider(inner);
    await runInAnalysisUsageScope(SCOPE, () => metered.chat([]));
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("records a stream's usage chunk and passes every chunk through", async () => {
    const metered = meterAnalysisProvider(new FakeProvider());
    const seen: string[] = [];
    await runInAnalysisUsageScope(SCOPE, async () => {
      for await (const c of metered.stream([], { model: "streamed" })) seen.push(c.type);
    });
    expect(seen).toEqual(["delta", "usage", "done"]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1",
      model: "streamed",
      inputTokens: 100,
      outputTokens: 40,
    });
  });

  it("attributes concurrent scopes to their own project", async () => {
    const metered = meterAnalysisProvider(new FakeProvider());
    await Promise.all([
      runInAnalysisUsageScope({ projectId: "A", sessionId: "a" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        await metered.chat([]);
      }),
      runInAnalysisUsageScope({ projectId: "B", sessionId: "b" }, () => metered.chat([])),
    ]);
    expect(recordUsage.mock.calls.map((c) => c[0].projectId).sort()).toEqual(["A", "B"]);
  });

  it("never fails the call when recording throws", async () => {
    recordUsage.mockImplementationOnce(() => {
      throw new Error("ledger down");
    });
    const metered = meterAnalysisProvider(new FakeProvider());
    await expect(runInAnalysisUsageScope(SCOPE, () => metered.chat([]))).resolves.toMatchObject({
      content: "ok",
    });
  });

  it("is idempotent, so a call is never recorded twice", async () => {
    const once = meterAnalysisProvider(new FakeProvider());
    const twice = meterAnalysisProvider(once);
    expect(twice).toBe(once);
    await runInAnalysisUsageScope(SCOPE, () => twice.chat([]));
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("passes every other member through to the adapter", async () => {
    const inner = new FakeProvider();
    const metered = meterAnalysisProvider(inner);
    expect(metered).toBeInstanceOf(FakeProvider);
    expect(metered.key).toBe("anthropic");
    expect(metered.model).toBe("default-model");
    expect(metered.offline).toBe(false);
    expect(metered.capabilities).toBe(inner.capabilities);
    expect(metered.servesRouterModel?.("default-model")).toBe(true);
    expect(await metered.models()).toEqual(["default-model"]);
    // An adapter-internal `this.chat()` reaches the adapter, not the meter.
    expect(await runInAnalysisUsageScope(SCOPE, () => metered.ping())).toBe(true);
    expect(inner.chatCalls).toBe(1);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
