/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #260 (#81) — custom-agent analysis phase.
 *
 * Enabled custom agents run alongside the built-in specialists during an
 * analysis. Tested end-to-end with a MOCK provider — no real LLM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import type { CustomAgentDto } from "@metis/shared";

const enabledAgents: CustomAgentDto[] = [];
vi.mock("../src/lib/custom-agents/index.js", () => ({
  listEnabledAgentsForProject: vi.fn(async () => enabledAgents),
}));

const { runEnabledCustomAgents } = await import("../src/lib/analysis/custom-agent-phase.js");

function provider(content = "custom finding"): AIProvider {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(
      async (): Promise<ChatResponse> => ({
        content,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        model: "stub",
        provider: "offline-stub" as any,
      }),
    ),
  } as any;
}

function agent(over: Partial<CustomAgentDto> = {}): CustomAgentDto {
  return {
    id: "ag_1",
    projectId: null,
    name: "Custom",
    description: "",
    systemPrompt: "Analyse the project.",
    tools: [],
    model: null,
    reasoningEffort: null,
    isBuiltIn: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

beforeEach(() => {
  enabledAgents.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("runEnabledCustomAgents (#81)", () => {
  it("returns empty results and zero usage when no agents are enabled", async () => {
    const res = await runEnabledCustomAgents({
      provider: provider(),
      projectId: "p1",
      projectName: "Proj",
      projectDescription: "desc",
    });
    expect(res.results).toHaveLength(0);
    expect(res.usage.totalTokens).toBe(0);
  });

  it("runs each enabled custom agent and rolls up usage", async () => {
    enabledAgents.push(agent({ id: "a1", name: "One" }), agent({ id: "a2", name: "Two" }));
    const p = provider();
    const res = await runEnabledCustomAgents({
      provider: p,
      projectId: "p1",
      projectName: "Proj",
      projectDescription: "desc",
    });
    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.agentName).sort()).toEqual(["One", "Two"]);
    expect(res.results[0].content).toBe("custom finding");
    // 2 agents x 5 tokens
    expect(res.usage.totalTokens).toBe(10);
    expect((p.chat as any).mock.calls.length).toBe(2);
  });

  it("isolates a failing agent — others still run", async () => {
    enabledAgents.push(agent({ id: "a1", name: "Bad" }), agent({ id: "a2", name: "Good" }));
    const p: AIProvider = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      chat: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({
          content: "ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "stub",
          provider: "offline-stub",
        }),
    } as any;
    const res = await runEnabledCustomAgents({
      provider: p,
      projectId: "p1",
      projectName: "Proj",
      projectDescription: "desc",
    });
    expect(res.results).toHaveLength(2);
    const bad = res.results.find((r) => r.agentName === "Bad")!;
    const good = res.results.find((r) => r.agentName === "Good")!;
    expect(bad.error).toBeTruthy();
    expect(good.content).toBe("ok");
    // only the successful agent contributes usage
    expect(res.usage.totalTokens).toBe(2);
  });

  it("honours an already-aborted signal (runs nothing)", async () => {
    enabledAgents.push(agent());
    const p = provider();
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await runEnabledCustomAgents({
      provider: p,
      projectId: "p1",
      projectName: "Proj",
      projectDescription: "desc",
      signal: ctrl.signal,
    });
    expect(res.results).toHaveLength(0);
    expect((p.chat as any).mock.calls.length).toBe(0);
  });
});
