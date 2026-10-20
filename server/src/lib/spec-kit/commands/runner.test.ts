/**
 * #700 / #1144 — spec-kit runner cache wiring.
 *
 * `runSpecKitAgent` tags every provider.chat() call with `callType: "spec-kit"`
 * so it is attributable in the cache-hit telemetry endpoint. It requests a
 * cache write only for a caller that will reuse it (`cacheSharedPrefix`, the
 * five plan calls), and then breaks the cache at the end of the shared
 * constitution + RAG prefix rather than at the end of the system (#1144). The governance chain
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

const project = {
  id: "p1",
  name: "Proj",
  description: "",
  safetyMode: "standard" as const,
  aiProviderId: null,
};

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

  it("tags the chat call with callType=spec-kit and requests no cache write by default (#1144)", async () => {
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
    // #1144 — a single-call command cannot reuse a write, so it requests none.
    // #1277 — as explicit falses: the Bedrock gateway reads an absent key as
    // its ENABLE_PROMPT_CACHING default and would write anyway.
    expect(calls[0].opts.promptCaching).toEqual({ system: false, messages: false });
    // The constitution leads the system prompt (constitution -> RAG -> base).
    expect(String(calls[0].opts.systemMessage)).toMatch(/^## Constitution v1\.0/);
  });

  it("#792 — the ledger row names the spec-kit command as its step, billed to the actor", async () => {
    const finops = await import("../../finops/index.js");
    const { provider } = capturingProvider();

    await runSpecKitAgent({
      command: "plan",
      project,
      actorId: "u-actor",
      systemPrompt: "Base.",
      userPrompt: "Plan it.",
      deps: { provider },
    });

    expect(vi.mocked(finops.recordUsage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(finops.recordUsage).mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      userId: "u-actor",
      agentStep: "spec-kit.plan",
    });
  });

  it("#1144 — a shared-prefix caller breaks the cache after constitution + RAG, not after the base prompt", async () => {
    const { provider, calls } = capturingProvider();

    for (const base of ["PLAN-PROMPT", "RESEARCH-PROMPT"]) {
      await runSpecKitAgent({
        command: "plan",
        project,
        systemPrompt: base,
        userPrompt: "Plan it.",
        ragContext: "RAG-BLOCK",
        cacheSharedPrefix: true,
        deps: { provider },
      });
    }

    const prefix = "## Constitution v1.0\nBe truthful.\n\n---\n\nRAG-BLOCK";
    for (const call of calls) {
      // The single-shot user turn is unique, so it is never messages-cached.
      expect(call.opts.promptCaching).toEqual({
        system: true,
        messages: false,
        systemPrefix: prefix,
      });
      expect(String(call.opts.systemMessage).startsWith(`${prefix}\n\n---\n\n`)).toBe(true);
    }
    // Both calls carry the same cacheable prefix, so the second reads the first's write.
    expect(calls[0].opts.systemMessage).not.toBe(calls[1].opts.systemMessage);
  });

  it("#1144 — a shared-prefix caller with no constitution and no RAG requests no cache write", async () => {
    const meta = await import("../constitution-meta.js");
    vi.mocked(meta.loadAsPreamble).mockResolvedValueOnce(null);
    const { provider, calls } = capturingProvider();

    await runSpecKitAgent({
      command: "plan",
      project,
      systemPrompt: "Base.",
      userPrompt: "Plan it.",
      ragContext: "   ",
      cacheSharedPrefix: true,
      deps: { provider },
    });

    expect(calls[0].opts.systemMessage).toBe("Base.");
    expect(calls[0].opts.promptCaching).toEqual({ system: false, messages: false });
  });

  it("keeps the constitution -> RAG -> base order", async () => {
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
    // Constitution leads, then RAG, then base (trust order, #373).
    expect(sys.indexOf("Constitution")).toBeLessThan(sys.indexOf("RAG-BLOCK"));
    expect(sys.indexOf("RAG-BLOCK")).toBeLessThan(sys.indexOf("BASE-PROMPT"));
    expect(calls[0].opts.callType).toBe("spec-kit");
  });

  it("falls back to the raw constitution and still tags the call", async () => {
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
    expect(calls[0].opts.callType).toBe("spec-kit");
  });

  it("audits + rethrows an inbound safety denial before the provider call", async () => {
    const safety = await import("../../safety/index.js");
    const audit = (await import("../../audit/audit-service.js")).audit;
    vi.mocked(safety.applySafety).mockRejectedValueOnce(new safety.SafetyDeniedError("input", []));
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
      .mockRejectedValueOnce(new safety.SafetyDeniedError("output", []));
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
      new finops.BudgetExceededError(101, 100),
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
