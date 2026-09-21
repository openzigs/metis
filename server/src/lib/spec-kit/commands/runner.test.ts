/**
 * #700 — spec-kit runner cache wiring.
 *
 * `runSpecKitAgent` must tag its single provider.chat() call with
 * `callType: "spec-kit"` and request `promptCaching: { system: true }` so the
 * per-project-stable constitution prefix is cacheable and the call is
 * attributable in the cache-hit telemetry endpoint. The governance chain
 * (budget, safety, audit, constitution, ledger) is mocked so the test is
 * hermetic and asserts only the provider-call options.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage } from "../../ai/types.js";

vi.mock("../../finops/index.js", () => ({
  assertWithinBudget: vi.fn().mockResolvedValue(undefined),
  recordUsage: vi.fn(),
  BudgetExceededError: class BudgetExceededError extends Error {},
}));
vi.mock("../../safety/index.js", () => ({
  applySafety: vi.fn(async (text: string) => ({ text, redacted: false })),
  SafetyDeniedError: class SafetyDeniedError extends Error {},
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../../prisma.js", () => ({ prisma: {} }));
vi.mock("../constitution.js", () => ({
  readProjectConstitution: vi.fn().mockResolvedValue(null),
}));
vi.mock("../constitution-meta.js", () => ({
  loadAsPreamble: vi.fn().mockResolvedValue("## Constitution v1.0\nBe truthful."),
}));

const { runSpecKitAgent } = await import("./runner.js");

const project = { id: "p1", name: "Proj", safetyMode: "standard" as const };

function capturingProvider(): {
  provider: AIProvider;
  calls: Array<{ messages: ChatMessage[]; opts: Record<string, unknown> }>;
} {
  const calls: Array<{ messages: ChatMessage[]; opts: Record<string, unknown> }> = [];
  const provider = {
    key: "bedrock-gateway",
    model: "sonnet-test",
    offline: false,
    async chat(messages: ChatMessage[], opts: Record<string, unknown>) {
      calls.push({ messages, opts });
      return {
        content: "ok",
        provider: "bedrock-gateway",
        model: "sonnet-test",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
  return { provider, calls };
}

describe("runSpecKitAgent cache wiring (#700)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tags the chat call with callType=spec-kit and caches the system prefix", async () => {
    const { provider, calls } = capturingProvider();

    await runSpecKitAgent({
      command: "specify",
      project,
      systemPrompt: "Base command prompt.",
      userPrompt: "Draft a spec.",
      deps: { provider },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.callType).toBe("spec-kit");
    expect(calls[0].opts.promptCaching).toEqual({ system: true });
    // The constitution leads the system prompt (constitution -> RAG -> base).
    expect(String(calls[0].opts.systemMessage)).toMatch(/^## Constitution v1\.0/);
  });

  it("does not request messages-caching (single-shot user turn is unique)", async () => {
    const { provider, calls } = capturingProvider();

    await runSpecKitAgent({
      command: "plan",
      project,
      systemPrompt: "Base.",
      userPrompt: "Plan it.",
      deps: { provider },
    });

    const caching = calls[0].opts.promptCaching as { messages?: boolean };
    expect(caching.messages).toBeUndefined();
  });

  it("keeps the constitution -> RAG -> base order while still caching the prefix", async () => {
    const { provider, calls } = capturingProvider();

    await runSpecKitAgent({
      command: "analyze",
      project,
      systemPrompt: "BASE-PROMPT",
      userPrompt: "Analyze.",
      ragContext: "RAG-BLOCK",
      ragChunksUsed: 3,
      deps: { provider },
    });

    const sys = String(calls[0].opts.systemMessage);
    // Constitution leads, then RAG, then base — the stable constitution prefix
    // is what the `promptCaching.system` flag makes cacheable.
    expect(sys.indexOf("Constitution")).toBeLessThan(sys.indexOf("RAG-BLOCK"));
    expect(sys.indexOf("RAG-BLOCK")).toBeLessThan(sys.indexOf("BASE-PROMPT"));
    expect(calls[0].opts.callType).toBe("spec-kit");
  });

  it("falls back to the raw constitution and still tags + caches", async () => {
    const meta = await import("../constitution-meta.js");
    const con = await import("../constitution.js");
    vi.mocked(meta.loadAsPreamble).mockResolvedValueOnce(null);
    vi.mocked(con.readProjectConstitution).mockResolvedValueOnce("RAW-CONSTITUTION-BODY");
    const { provider, calls } = capturingProvider();

    await runSpecKitAgent({
      command: "tasks",
      project,
      systemPrompt: "Base.",
      userPrompt: "Tasks.",
      deps: { provider },
    });

    expect(String(calls[0].opts.systemMessage)).toMatch(/^RAW-CONSTITUTION-BODY/);
    expect(calls[0].opts.promptCaching).toEqual({ system: true });
  });

  it("audits + rethrows an inbound safety denial before the provider call", async () => {
    const safety = await import("../../safety/index.js");
    const audit = (await import("../../audit/audit-service.js")).audit;
    vi.mocked(safety.applySafety).mockRejectedValueOnce(new safety.SafetyDeniedError("blocked in"));
    const { provider, calls } = capturingProvider();

    await expect(
      runSpecKitAgent({
        command: "clarify",
        project,
        systemPrompt: "Base.",
        userPrompt: "bad",
        deps: { provider },
      }),
    ).rejects.toBeInstanceOf(safety.SafetyDeniedError);
    expect(calls).toHaveLength(0);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ direction: "input" }) }),
    );
  });

  it("audits + rethrows an outbound safety denial after the provider call", async () => {
    const safety = await import("../../safety/index.js");
    const audit = (await import("../../audit/audit-service.js")).audit;
    // First call (inbound) passes; second call (outbound) is denied.
    vi.mocked(safety.applySafety)
      .mockResolvedValueOnce({ text: "ok in", redacted: false } as never)
      .mockRejectedValueOnce(new safety.SafetyDeniedError("blocked out"));
    const { provider } = capturingProvider();

    await expect(
      runSpecKitAgent({
        command: "specify",
        project,
        systemPrompt: "Base.",
        userPrompt: "ok",
        deps: { provider },
      }),
    ).rejects.toBeInstanceOf(safety.SafetyDeniedError);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ direction: "output" }) }),
    );
  });

  it("propagates a budget denial before any provider call", async () => {
    const finops = await import("../../finops/index.js");
    vi.mocked(finops.assertWithinBudget).mockRejectedValueOnce(
      new finops.BudgetExceededError("over budget"),
    );
    const { provider, calls } = capturingProvider();

    await expect(
      runSpecKitAgent({
        command: "specify",
        project,
        systemPrompt: "Base.",
        userPrompt: "Draft.",
        deps: { provider },
      }),
    ).rejects.toBeInstanceOf(finops.BudgetExceededError);
    expect(calls).toHaveLength(0);
  });
});
