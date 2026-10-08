/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #289 — the analysis agent phase no longer discards what its agents say.
 *
 * Each agent is asked for the specialists' findings answer, its answer is
 * parsed against the same schema (#298 repair, #1230 clamp), a failing answer
 * gets ONE bounded retry (#769), and a still-failing one is reported as
 * `invalid` rather than dropped. Mock provider here; the real-provider +
 * real-database round trip is analysis-agent-phase-findings-289.sqlite.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import type { CustomAgentDto } from "@metis/shared";

const enabledAgents: CustomAgentDto[] = [];
vi.mock("../src/lib/custom-agents/index.js", () => ({
  listEnabledAgentsForProject: vi.fn(async () => enabledAgents),
}));
vi.mock("../src/lib/agent-runtime/definition.js", async (original) => ({
  ...(await original<typeof import("../src/lib/agent-runtime/definition.js")>()),
  listProjectLibraryAgents: vi.fn(async () => []),
}));
const persisted: Array<Record<string, any>> = [];
/** agentKeys whose write should throw — the per-agent isolation test. */
const failWritesFor = new Set<string>();
vi.mock("../src/lib/analysis/analysis-service.js", () => ({
  persistAgentResult: vi.fn(async (input: Record<string, any>) => {
    if (failWritesFor.has(input.agentKey)) throw new Error("db write failed");
    persisted.push(input);
    return { id: "ar", agentKey: input.agentKey, findingIds: [] };
  }),
}));

const {
  AGENT_PHASE_OUTPUT_CONTRACT,
  AGENT_PHASE_RETRY_INSTRUCTION,
  INVALID_ANSWER_EXCERPT_LABEL,
  invalidAnswerMessage,
  parseAgentFindingsAnswer,
  persistAgentPhaseResults,
  runEnabledCustomAgents,
} = await import("../src/lib/analysis/custom-agent-phase.js");

const FINDING = {
  category: "security",
  severity: "high",
  title: "Admin routes have no authorization check",
  body: "The admin surface is reachable by any signed-in user.",
  tags: ["authz"],
  citations: [],
};
const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: "One gap.", findings: [FINDING], notes: [], ...over });

function scripted(replies: string[]) {
  const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = [];
  let i = 0;
  const provider = {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions): Promise<ChatResponse> => {
      calls.push({ messages, opts });
      const content = replies[Math.min(i, replies.length - 1)]!;
      i += 1;
      return {
        content,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "stub",
        provider: "offline-stub" as any,
      };
    }),
  } as unknown as AIProvider;
  return { provider, calls };
}

function agent(over: Partial<CustomAgentDto> = {}): CustomAgentDto {
  return {
    id: "ag_1",
    projectId: null,
    name: "Threat Modeller",
    description: "",
    systemPrompt: "You review threat models.",
    tools: [],
    model: null,
    reasoningEffort: null,
    isBuiltIn: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const run = (provider: AIProvider) =>
  runEnabledCustomAgents({ provider, projectId: "p1", projectName: "P", projectDescription: "d" });

beforeEach(() => {
  enabledAgents.length = 0;
  persisted.length = 0;
  failWritesFor.clear();
});

describe("#289 — the agent phase keeps each agent's findings", () => {
  it("asks the agent for the findings answer and returns its validated findings", async () => {
    enabledAgents.push(agent());
    const { provider, calls } = scripted([answer()]);
    const res = await run(provider);

    expect(calls).toHaveLength(1);
    // The contract rides in the SYSTEM prompt (server-authored), after the persona.
    const system = String(calls[0]!.opts.systemMessage);
    expect(system.startsWith("You review threat models.")).toBe(true);
    expect(system).toContain(AGENT_PHASE_OUTPUT_CONTRACT);
    expect(calls[0]!.opts.disableTools).toBe(true);

    const r = res.results[0]!;
    expect(r.invalid).toBeUndefined();
    expect(r.output?.findings.map((f) => [f.category, f.severity, f.title])).toEqual([
      ["security", "high", FINDING.title],
    ]);
    expect(r.finalAnswerRetry).toEqual({ attempted: false, succeeded: false });
  });

  it("retries ONCE on a prose answer, keeps the retried findings, and counts both calls' tokens", async () => {
    enabledAgents.push(agent());
    const { provider, calls } = scripted(["Here are my thoughts in prose.", answer()]);
    const res = await run(provider);

    expect(calls).toHaveLength(2);
    const retry = calls[1]!;
    expect(retry.opts.disableTools).toBe(true);
    expect(retry.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(retry.messages[1]!.content).toBe("Here are my thoughts in prose.");
    expect(retry.messages[2]!.content).toBe(AGENT_PHASE_RETRY_INSTRUCTION);

    const r = res.results[0]!;
    expect(r.output?.findings).toHaveLength(1);
    expect(r.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    // Budget accounting: the retry is paid for, so it is counted.
    expect(r.usage.totalTokens).toBe(30);
    expect(res.usage.totalTokens).toBe(30);
  });

  it("reports an answer that fails the schema after the retry as invalid — never silently dropped", async () => {
    enabledAgents.push(agent());
    const bad = answer({ findings: [{ ...FINDING, severity: "catastrophic" }] });
    const { provider, calls } = scripted([bad, bad]);
    const res = await run(provider);

    expect(calls).toHaveLength(2);
    const r = res.results[0]!;
    expect(r.output).toBeUndefined();
    expect(r.invalid?.reason).toBe("schema-invalid");
    expect(r.invalid?.issues).toEqual(["findings.0.severity: invalid_value"]);
    expect(res.usage.totalTokens).toBe(30);
    expect(invalidAnswerMessage(r)).toBe(
      "No findings recorded: its answer failed the findings schema (findings.0.severity: invalid_value) after one retry.",
    );
  });

  it("repairs an over-long note (#298) instead of rejecting the answer, and says so", async () => {
    enabledAgents.push(agent());
    const { provider, calls } = scripted([answer({ notes: ["n".repeat(900)] })]);
    const res = await run(provider);
    expect(calls).toHaveLength(1);
    const r = res.results[0]!;
    expect(r.output?.findings).toHaveLength(1);
    expect(r.output?.notes[0]!.length).toBeLessThanOrEqual(512);
    expect(r.output?.notes.some((n) => /repair/i.test(n))).toBe(true);
  });

  it("strips the fields the server owns — a model cannot claim evidence, verification or a verdict", async () => {
    enabledAgents.push(agent());
    const forged = {
      ...FINDING,
      citations: [{ filePath: "src/admin/routes.ts", startLine: 1, endLine: 9 }],
      requirementId: "REQ-001",
      verificationStatus: "confirmed",
      verdict: "gap-confirmed",
      supportPanel: null,
      confidence: 0.7,
      derivation: "ambiguous",
    };
    const { provider } = scripted([answer({ findings: [forged] })]);
    const res = await run(provider);

    const f = res.results[0]!.output!.findings[0]!;
    expect(f.citations).toEqual([]);
    for (const key of ["requirementId", "verdict", "supportPanel"]) {
      expect(f).not.toHaveProperty(key);
    }
    // #727 — the model's "confirmed" is replaced by the server's verdict: an
    // evidence-free finding is `ungrounded` (no code access, cited nothing) — not
    // `unverified`, which claims it cited code that was dropped.
    expect(f.verificationStatus).toBe("ungrounded");
    // Model-assertable fields survive — the strip is a denylist, not a reset.
    expect(f).toMatchObject({ title: FINDING.title, confidence: 0.7, derivation: "ambiguous" });
  });

  it("parses a fenced answer and rejects a non-JSON one", () => {
    expect(parseAgentFindingsAnswer("```json\n" + answer() + "\n```").ok).toBe(true);
    expect(parseAgentFindingsAnswer("no json here")).toEqual({
      ok: false,
      invalid: { reason: "non-json-response", issues: [] },
    });
    expect(parseAgentFindingsAnswer("[1,2]")).toEqual({
      ok: false,
      invalid: { reason: "non-json-response", issues: [] },
    });
  });
});

describe("#289 — persistAgentPhaseResults", () => {
  const base = {
    agentId: "a1",
    kind: "custom" as const,
    agentName: "Threat Modeller",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    startedAt: new Date(0),
    completedAt: new Date(1),
  };

  it("writes a completed row keyed by the agent ref, with its source", async () => {
    await persistAgentPhaseResults("an1", [
      {
        ...base,
        agentRef: "custom:a1",
        content: answer(),
        output: { summary: "s", findings: [FINDING as any], notes: [] },
        warnings: ["saved model not used"],
      },
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      analysisId: "an1",
      agentKey: "custom:a1",
      status: "completed",
      output: {
        summary: "s",
        notes: ["saved model not used"],
        source: { kind: "custom", ref: "custom:a1", name: "Threat Modeller" },
      },
    });
    expect(persisted[0]!.output.findings).toHaveLength(1);
  });

  it("writes a failed row with the reason for an invalid answer, keeping an excerpt", async () => {
    await persistAgentPhaseResults("an1", [
      {
        ...base,
        agentRef: "library:l1",
        kind: "library",
        content: "  just prose  ",
        invalid: { reason: "non-json-response", issues: [] },
        finalAnswerRetry: { attempted: true, succeeded: false },
      },
    ]);
    expect(persisted[0]).toMatchObject({
      agentKey: "library:l1",
      status: "failed",
      errorMessage: "No findings recorded: its answer contained no JSON object after one retry.",
      output: { summary: `${INVALID_ANSWER_EXCERPT_LABEL}just prose`, findings: [] },
    });
    expect(INVALID_ANSWER_EXCERPT_LABEL).toMatch(/unparsed answer/i);
  });

  it("keeps a failed row's labelled excerpt within the summary cap", async () => {
    await persistAgentPhaseResults("an1", [
      {
        ...base,
        agentRef: "custom:a1",
        content: "x".repeat(5000),
        invalid: { reason: "non-json-response", issues: [] },
      },
    ]);
    expect(persisted[0]!.output.summary.length).toBe(2048);
  });

  it("keeps the server's warnings when the model returns the maximum 20 notes", async () => {
    const notes = Array.from({ length: 20 }, (_, i) => `model note ${i}`);
    await persistAgentPhaseResults("an1", [
      {
        ...base,
        agentRef: "custom:a1",
        content: answer(),
        output: { summary: "s", findings: [], notes },
        warnings: ["saved model not used"],
      },
    ]);
    const kept = persisted[0]!.output.notes as string[];
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe("saved model not used");
  });

  it("still writes every later agent's row when one agent's write throws (#246)", async () => {
    failWritesFor.add("custom:a1");
    await expect(
      persistAgentPhaseResults("an1", [
        { ...base, agentRef: "custom:a1", content: "", error: "boom" },
        { ...base, agentRef: "custom:a2", content: "", error: "boom" },
      ]),
    ).resolves.toBeUndefined();
    expect(persisted.map((p) => p.agentKey)).toEqual(["custom:a2"]);
  });

  it("writes a failed row for an agent that threw, and a cancelled one on abort", async () => {
    await persistAgentPhaseResults("an1", [
      { ...base, agentRef: "custom:a1", content: "", error: "boom" },
      { ...base, agentRef: "custom:a2", content: "", error: "aborted", aborted: true },
    ]);
    expect(persisted.map((p) => [p.agentKey, p.status, p.errorMessage])).toEqual([
      ["custom:a1", "failed", "boom"],
      ["custom:a2", "cancelled", "cancelled"],
    ]);
  });
});
