/**
 * Issue #1063 — the code agent ended a run with 0 findings.
 *
 * #706 run 7, analysis started from five imported items, `deepseek-flash`: the
 * tool loop stopped on its token budget after 64 tool calls; the final-answer
 * retry was billed 16,384 output tokens (its whole cap) and returned 0
 * characters with finish reason `max_tokens`; the evidence-only salvage did
 * exactly the same. Both calls only write up an investigation already made, and
 * the model spent the cap reasoning.
 *
 * Covered here, with no model: the two recovery calls carry a reasoning bound,
 * the loop's own turns do not, and a total loss now says what the recovery
 * calls returned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentOutputSchema } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const configValues = new Map<string, string>();
vi.mock("../config/config-service.js", () => ({
  getConfigService: () => ({
    get: (key: string) => configValues.get(key),
    getNumber: (_key: string, fallback: number) => fallback,
    getBool: (_key: string, fallback: boolean) => fallback,
  }),
}));

const { runAgentLoop } = await import("./agent-loop.js");
const { salvageFromEvidence } = await import("./agentic-evidence.js");
const {
  buildDegradedAgentOutput,
  collectRecoveryAttempts,
  describeRecoveryAttempts,
  spentOutputCapWithoutText,
  FINAL_ANSWER_INSTRUCTION,
  isSchemaValidFinalAnswer,
} = await import("./agentic-degradation.js");
const { resolveRecoveryReasoning, RECOVERY_REASONING_KEY } =
  await import("./agentic-pass-context.js");

const CAP = 16_384;

const readTool: AgentTool = {
  name: "read_file_slice",
  description: "read a file",
  parameters: { type: "object", properties: { filePath: { type: "string" } } },
  async execute() {
    return { content: "func FlushAllSessions() {}" };
  },
} as unknown as AgentTool;

const TOOL_CALL = JSON.stringify({ tool: "read_file_slice", args: { filePath: "session.go" } });

/** A model that calls a tool every turn and, asked to answer, spends its cap reasoning. */
function reasoningModel(retryReply: Partial<ChatResponse> = {}) {
  const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const provider = {
    calls,
    async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
      calls.push({ messages, options });
      const answering = messages.some(
        (m) => typeof m.content === "string" && m.content.includes(FINAL_ANSWER_INSTRUCTION),
      );
      if (!answering) {
        return {
          content: TOOL_CALL,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: "deepseek-flash",
          provider: "anthropic",
        } as ChatResponse;
      }
      return {
        content: "",
        finishReason: "max_tokens",
        usage: { promptTokens: 44_799, completionTokens: CAP, totalTokens: 44_799 + CAP },
        model: "deepseek-flash",
        provider: "anthropic",
        ...retryReply,
      } as ChatResponse;
    },
  };
  return provider as unknown as AIProvider & { calls: typeof calls };
}

const loopInput = {
  systemMessage: "You are Winston.",
  userMessage: "Investigate NR-4: Add a button to terminate all sessions.",
  tools: [readTool],
  toolContext: { projectId: "p1" },
} as Parameters<typeof runAgentLoop>[1];

afterEach(() => configValues.clear());

describe("#1063 — the final-answer retry", () => {
  it("sends the reasoning bound on the retry only, never on a loop turn", async () => {
    const p = reasoningModel();
    await runAgentLoop(p, loopInput, {
      maxTurns: 2,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isSchemaValidFinalAnswer,
        maxOutputTokens: CAP,
        reasoning: { reasoningEffort: "low" },
      },
    });
    const turns = p.calls.slice(0, -1);
    const retry = p.calls.at(-1)!;
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.options.reasoningEffort).toBeUndefined();
      expect(t.options.disableThinking).toBeUndefined();
    }
    expect(retry.options.reasoningEffort).toBe("low");
    expect(retry.options.maxTokens).toBe(CAP);
  });

  it("can turn thinking off for the retry", async () => {
    const p = reasoningModel();
    await runAgentLoop(p, loopInput, {
      maxTurns: 1,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        reasoning: { disableThinking: true },
      },
    });
    expect(p.calls.at(-1)!.options.disableThinking).toBe(true);
  });

  it("sends no reasoning option when none is configured (the request is unchanged)", async () => {
    const p = reasoningModel();
    await runAgentLoop(p, loopInput, {
      maxTurns: 1,
      finalAnswerRetry: { instruction: FINAL_ANSWER_INSTRUCTION },
    });
    const options = p.calls.at(-1)!.options;
    expect("reasoningEffort" in options).toBe(false);
    expect("disableThinking" in options).toBe(false);
  });

  it("lets an explicit caller option win over the retry's own", async () => {
    const p = reasoningModel();
    await runAgentLoop(p, loopInput, {
      maxTurns: 1,
      providerChatOptions: { reasoningEffort: "high" },
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        reasoning: { reasoningEffort: "low" },
      },
    });
    expect(p.calls.at(-1)!.options.reasoningEffort).toBe("high");
  });

  it("reports what an empty retry returned: outcome, finish reason, tokens and cap", async () => {
    const p = reasoningModel();
    const result = await runAgentLoop(p, loopInput, {
      maxTurns: 2,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isSchemaValidFinalAnswer,
        maxOutputTokens: CAP,
      },
    });
    expect(result.hasFinalAnswer).toBe(false);
    expect(result.finalAnswerRetry).toEqual({
      attempted: true,
      succeeded: false,
      outcome: "empty",
      finishReason: "max_tokens",
      responseLength: 0,
      outputTokens: CAP,
      maxOutputTokens: CAP,
    });
  });

  it("reports nothing about a reply when the retry call throws", async () => {
    const p = reasoningModel();
    const chat = p.chat.bind(p);
    p.chat = async (messages: ChatMessage[], options?: ChatOptions) => {
      const answering = messages.some(
        (m) => typeof m.content === "string" && m.content.includes(FINAL_ANSWER_INSTRUCTION),
      );
      if (answering) throw new Error("upstream 529");
      return chat(messages, options);
    };
    const result = await runAgentLoop(p, loopInput, {
      maxTurns: 1,
      finalAnswerRetry: { instruction: FINAL_ANSWER_INSTRUCTION },
    });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: false });
  });
});

describe("#1063 — the evidence-only salvage", () => {
  const toolCalls = [
    {
      tool: "read_file_slice",
      args: { filePath: "internal/storage/web_session.go" },
      result: "func (s *Storage) FlushAllSessions() error { return nil }",
    },
  ] as unknown as Parameters<typeof salvageFromEvidence>[1]["toolCalls"];

  const base = {
    agentKey: "code" as const,
    systemMessage: "You are Winston.",
    userMessage: "Investigate NR-4.",
    toolCalls,
    maxOutputTokens: CAP,
  };

  it("passes the reasoning bound to its one call", async () => {
    const p = reasoningModel();
    await salvageFromEvidence(p, { ...base, reasoning: { reasoningEffort: "low" } });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.options.reasoningEffort).toBe("low");
    expect(p.calls[0]!.options.maxTokens).toBe(CAP);
  });

  it("can turn thinking off for its call", async () => {
    const p = reasoningModel();
    await salvageFromEvidence(p, { ...base, reasoning: { disableThinking: true } });
    expect(p.calls[0]!.options.disableThinking).toBe(true);
  });

  it("sends no reasoning option when none is given", async () => {
    const p = reasoningModel();
    await salvageFromEvidence(p, base);
    expect(p.calls[0]!.options.reasoningEffort).toBeUndefined();
    expect("disableThinking" in p.calls[0]!.options).toBe(false);
  });

  it("reports an empty reply at the output cap instead of an unexplained zero", async () => {
    const result = await salvageFromEvidence(reasoningModel(), base);
    expect(result.attempted).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.reply).toEqual({
      finishReason: "max_tokens",
      responseLength: 0,
      outputTokens: CAP,
    });
  });

  it("reports the reply of a call that did recover findings", async () => {
    const answer = JSON.stringify({
      agentKey: "code",
      summary: "s",
      findings: [
        {
          category: "architecture",
          severity: "info",
          title: "FlushAllSessions exists",
          body: "The storage layer already removes every session.",
          citations: [],
          tags: [],
        },
      ],
      notes: [],
    });
    const result = await salvageFromEvidence(
      reasoningModel({ content: answer, finishReason: "end_turn" }),
      base,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.reply).toMatchObject({ finishReason: "end_turn", responseLength: answer.length });
  });

  it("has no reply to report when there was no evidence to send", async () => {
    const p = reasoningModel();
    const result = await salvageFromEvidence(p, { ...base, toolCalls: [] });
    expect(result.attempted).toBe(false);
    expect(result.reply).toBeUndefined();
    expect(p.calls).toHaveLength(0);
  });
});

describe("#1063 — saying why nothing was recovered", () => {
  const emptyAtCap = {
    step: "final-answer" as const,
    finishReason: "max_tokens",
    responseLength: 0,
    outputTokens: CAP,
    maxOutputTokens: CAP,
  };

  it.each([
    [{ ...emptyAtCap }, true],
    // An OpenAI-format endpoint reports the same stop as `length`.
    [{ ...emptyAtCap, finishReason: "length" }, true],
    // No finish reason, but every output token was spent.
    [{ ...emptyAtCap, finishReason: undefined }, true],
    // Text came back: whatever went wrong, it was not "spent the cap reasoning".
    [{ ...emptyAtCap, responseLength: 12 }, false],
    // Empty, but it stopped early of its own accord.
    [{ ...emptyAtCap, finishReason: "end_turn", outputTokens: 40 }, false],
    // Empty and no cap known: nothing to compare the spend to.
    [
      { step: "evidence-only" as const, responseLength: 0, outputTokens: 40, finishReason: "stop" },
      false,
    ],
  ])("spentOutputCapWithoutText(%j) is %s", (attempt, expected) => {
    expect(spentOutputCapWithoutText(attempt)).toBe(expected);
  });

  it("names the output limit, the tokens used and the setting, for each call", () => {
    const notes = describeRecoveryAttempts([emptyAtCap, { ...emptyAtCap, step: "evidence-only" }]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^The final-answer call returned no text/);
    expect(notes[0]).toContain("16384 of 16384 output tokens used");
    expect(notes[0]).toContain("ANALYSIS_RECOVERY_REASONING");
    expect(notes[1]).toMatch(/^The evidence-only call returned no text/);
  });

  it("describes an unusable reply that did carry text differently", () => {
    const [note] = describeRecoveryAttempts([
      { ...emptyAtCap, responseLength: 812, finishReason: "end_turn", outputTokens: 300 },
    ]);
    expect(note).toContain("returned 812 character(s) with no usable finding");
    expect(note).toContain("finish reason end_turn");
    expect(note).not.toContain("ANALYSIS_RECOVERY_REASONING");
  });

  it("says 'unknown' when the provider gave no finish reason, and omits an unknown cap", () => {
    const [note] = describeRecoveryAttempts([
      { step: "evidence-only", responseLength: 5, outputTokens: 9 },
    ]);
    expect(note).toContain("finish reason unknown, 9 output tokens used");
  });

  it("collects the retry and the salvage, defaulting the retry's cap", () => {
    expect(
      collectRecoveryAttempts(
        {
          attempted: true,
          succeeded: false,
          finishReason: "max_tokens",
          responseLength: 0,
          outputTokens: CAP,
        },
        { reply: { finishReason: "max_tokens", responseLength: 0, outputTokens: CAP } },
        { maxOutputTokens: CAP },
      ),
    ).toEqual([emptyAtCap, { ...emptyAtCap, step: "evidence-only" }]);
  });

  it("leaves out a retry that threw, one that succeeded, and a salvage never made", () => {
    const caps = { maxOutputTokens: CAP };
    expect(collectRecoveryAttempts({ attempted: true, succeeded: false }, undefined, caps)).toEqual(
      [],
    );
    expect(
      collectRecoveryAttempts(
        { attempted: true, succeeded: true, responseLength: 40, outputTokens: 12 },
        {},
        caps,
      ),
    ).toEqual([]);
    expect(collectRecoveryAttempts(undefined, undefined, caps)).toEqual([]);
  });

  it("keeps a missing finish reason and token count out of the record", () => {
    expect(
      collectRecoveryAttempts(
        { attempted: true, succeeded: false, responseLength: 3, maxOutputTokens: 8192 },
        { reply: { responseLength: 0, outputTokens: 0 } },
        { maxOutputTokens: CAP },
      ),
    ).toEqual([
      { step: "final-answer", responseLength: 3, outputTokens: 0, maxOutputTokens: 8192 },
      { step: "evidence-only", responseLength: 0, outputTokens: 0, maxOutputTokens: CAP },
    ]);
  });

  it("puts the reason on the persisted output of a total loss (the run-7 shape)", () => {
    const output = buildDegradedAgentOutput({
      agentKey: "code",
      reason: "token-budget",
      toolCalls: Array.from({ length: 64 }, () => ({ tool: "read_file_slice" })),
      salvaged: [],
      recovery: [emptyAtCap, { ...emptyAtCap, step: "evidence-only" }],
    });
    expect(agentOutputSchema.safeParse(output).success).toBe(true);
    expect(output.notes).toHaveLength(4);
    expect(output.notes[1]).toBe("Recovered 0 finding(s) from 64 tool call(s).");
    expect(output.notes[2]).toContain("The final-answer call returned no text");
    expect(output.notes[3]).toContain("The evidence-only call returned no text");
    for (const note of output.notes) expect(note.length).toBeLessThanOrEqual(512);
  });

  it("says nothing about the recovery calls when they did recover findings", () => {
    const output = buildDegradedAgentOutput({
      agentKey: "code",
      reason: "token-budget",
      toolCalls: [{ tool: "read_file_slice" }],
      salvaged: [
        {
          category: "architecture",
          severity: "info",
          title: "t",
          body: "b",
          citations: [],
          tags: [],
        },
      ] as never,
      recovery: [emptyAtCap],
    });
    expect(output.notes).toHaveLength(2);
  });

  it("is unchanged when no recovery record is passed", () => {
    const output = buildDegradedAgentOutput({
      agentKey: "code",
      reason: "turn-limit",
      toolCalls: [],
      salvaged: [],
    });
    expect(output.notes).toHaveLength(2);
  });
});

describe("#1063 — ANALYSIS_RECOVERY_REASONING", () => {
  it("is the key the resolver reads", () => {
    expect(RECOVERY_REASONING_KEY).toBe("ANALYSIS_RECOVERY_REASONING");
  });

  it("auto: low effort for a model that reasons by default, nothing for Claude", () => {
    expect(resolveRecoveryReasoning("deepseek-flash")).toEqual({ reasoningEffort: "low" });
    expect(resolveRecoveryReasoning("deepseek-v4-pro")).toEqual({ reasoningEffort: "low" });
    expect(resolveRecoveryReasoning("claude-sonnet-4-6")).toEqual({});
    expect(resolveRecoveryReasoning(undefined)).toEqual({});
  });

  it.each([
    ["off", { disableThinking: true }],
    ["provider-default", {}],
    ["low", { reasoningEffort: "low" }],
    ["medium", { reasoningEffort: "medium" }],
    ["high", { reasoningEffort: "high" }],
    // An unrecognised value falls back to auto rather than sending it on.
    ["extreme", { reasoningEffort: "low" }],
  ])("%s resolves to %j on a reasoning model", (mode, expected) => {
    configValues.set("ANALYSIS_RECOVERY_REASONING", mode);
    expect(resolveRecoveryReasoning("deepseek-flash")).toEqual(expected);
  });

  it("an explicit effort applies to any model, as an operator choice", () => {
    configValues.set("ANALYSIS_RECOVERY_REASONING", "off");
    expect(resolveRecoveryReasoning("claude-sonnet-4-6")).toEqual({ disableThinking: true });
  });
});
