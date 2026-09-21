/**
 * P0 #769 — the agent loop's bounded final-answer retry + the pure salvage
 * helpers that keep a serialization failure from discarding an entire
 * investigation.
 *
 * These drive the REAL `runAgentLoop` against a provider stub that keeps
 * emitting tool calls until the cap (exactly what the live 40k-token run did) —
 * the mocked-well-formed-JSON providers in the existing suites never exercised
 * this, which is why the bug shipped.
 */
import { describe, expect, it } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  FINAL_ANSWER_INSTRUCTION,
  buildDegradedAgentOutput,
  isJsonFinalAnswer,
  salvageFindings,
} from "./agentic-degradation.js";

const reply = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  model: "stub",
  provider: "offline-stub",
});

const TOOL_CALL = JSON.stringify({ tool: "search_code_graph", args: { query: "auth" } });

const findingsJson = (title = "code title") =>
  JSON.stringify({
    agentKey: "code",
    summary: "code summary",
    findings: [
      {
        category: "architecture",
        severity: "medium",
        title,
        body: "body",
        tags: [],
        citations: [],
      },
    ],
    notes: [],
  });

const searchTool: AgentTool = {
  name: "search_code_graph",
  description: "search the code graph",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  async execute() {
    return { content: "symbol: createSession at server/src/auth/session.ts:10-42" };
  },
} as unknown as AgentTool;

/**
 * Provider stub that ALWAYS answers with a tool call — so the loop can only end
 * by exhausting its turn cap — unless the turn carries the tool-free
 * final-answer instruction, in which case it answers with `finalAnswer`.
 */
function makeLoopProvider(finalAnswer: string | null): AIProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const provider = {
    key: "offline-stub" as const,
    model: "stub",
    offline: true,
    calls,
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      calls.push([...messages]);
      const asked = messages.some(
        (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
      );
      if (asked) return reply(finalAnswer ?? "I could not finish. Sorry.");
      return reply(TOOL_CALL);
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  };
  return provider as unknown as AIProvider & { calls: ChatMessage[][] };
}

const loopInput = {
  systemMessage: "You are Winston.",
  userMessage: "Investigate REQ-001.",
  tools: [searchTool],
  toolContext: { projectId: "proj-1" },
} as Parameters<typeof runAgentLoop>[1];

describe("#769 agent loop — final-answer retry", () => {
  it("salvages the investigation when the TURN CAP is hit mid-tool-call (fails on main)", async () => {
    const provider = makeLoopProvider(findingsJson());
    const result = await runAgentLoop(provider, loopInput, {
      maxTurns: 3,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isJsonFinalAnswer,
      },
    });

    // The loop ran out of turns while still calling tools...
    expect(result.turnsUsed).toBe(3);
    expect(result.turnsExhausted).toBe(true);
    expect(result.budgetExhausted).toBe(false);
    // ...and the bounded retry rescued a usable JSON answer instead of prose.
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(result.hasFinalAnswer).toBe(true);
    expect(isJsonFinalAnswer(result.finalResponse)).toBe(true);
    // Exactly ONE extra call — the bounded-iteration guarantee holds.
    expect(provider.calls).toHaveLength(4);
    // The retry carried the whole investigation forward AND offered no tools.
    const retryCall = provider.calls[3]!;
    expect(
      retryCall.some((m) => typeof m.content === "string" && m.content.includes("Tool result for")),
    ).toBe(true);
    // Its tokens are accounted for (4 calls × 15).
    expect(result.usage.totalTokens).toBe(60);
  });

  it("retries once when the model answers with PROSE instead of JSON", async () => {
    const calls: string[] = [];
    const provider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(messages: ChatMessage[]): Promise<ChatResponse> {
        const asked = messages.some(
          (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
        );
        calls.push(asked ? "retry" : "turn");
        return reply(asked ? findingsJson() : "Here is a summary of what I found, in prose.");
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;

    const result = await runAgentLoop(provider, loopInput, {
      maxTurns: 5,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isJsonFinalAnswer,
      },
    });
    // Prose is a "final answer" to the loop (not a tool call), so it exits after
    // one turn — the retry is what converts it into a usable JSON answer.
    expect(calls).toEqual(["turn", "retry"]);
    expect(result.turnsExhausted).toBe(false);
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(result.hasFinalAnswer).toBe(true);
  });

  it("degrades (never throws) when the retry ALSO fails to produce JSON", async () => {
    const provider = makeLoopProvider(null); // retry answers prose too
    const result = await runAgentLoop(provider, loopInput, {
      maxTurns: 2,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isJsonFinalAnswer,
      },
    });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: false });
    expect(result.hasFinalAnswer).toBe(false);
    expect(result.turnsExhausted).toBe(true);
    // The tool calls it DID make survive for the caller to salvage/report.
    expect(result.toolCalls).toHaveLength(2);
  });

  it("degrades gracefully when the retry CALL throws (provider error)", async () => {
    let n = 0;
    const provider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        n += 1;
        if (n > 1) throw new Error("gateway 500");
        return reply(TOOL_CALL);
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as AIProvider;
    const result = await runAgentLoop(provider, loopInput, {
      maxTurns: 1,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isJsonFinalAnswer,
      },
    });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: false });
    expect(result.hasFinalAnswer).toBe(false);
    // The loop still returns — a failed salvage never becomes a hard failure.
    expect(result.finalResponse).toContain("tool-call limit");
  });

  it("makes NO extra call when the loop already produced a JSON answer", async () => {
    let n = 0;
    const provider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        n += 1;
        return reply(findingsJson());
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;
    const result = await runAgentLoop(provider, loopInput, {
      maxTurns: 5,
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isJsonFinalAnswer,
      },
    });
    expect(n).toBe(1);
    expect(result.finalAnswerRetry).toBeUndefined();
    expect(result.hasFinalAnswer).toBe(true);
  });

  it("leaves the #713 chat path untouched (no finalAnswerRetry ⇒ no extra call)", async () => {
    const provider = makeLoopProvider(findingsJson());
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 2 });
    expect(provider.calls).toHaveLength(2);
    expect(result.finalAnswerRetry).toBeUndefined();
    // Prose fallback still substituted for the pending tool call (#718).
    expect(result.finalResponse).toContain("tool-call limit");
    // `hasFinalAnswer` is evaluated on the PRE-substitution text, so it honestly
    // reports that the loop never answered — chat ignores it, analysis degrades.
    expect(result.hasFinalAnswer).toBe(false);
    expect(result.turnsExhausted).toBe(true);
  });

  it("stops the loop on TOKEN budget exhaustion and still retries", async () => {
    const provider = makeLoopProvider(findingsJson());
    const result = await runAgentLoop(provider, loopInput, {
      maxTurns: 10,
      maxTokens: 20, // one 15-token turn blows it
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isJsonFinalAnswer,
      },
    });
    expect(result.budgetExhausted).toBe(true);
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(result.hasFinalAnswer).toBe(true);
  });
});

describe("#769 salvage helpers", () => {
  it("isJsonFinalAnswer rejects tool calls, prose and empties", () => {
    expect(isJsonFinalAnswer(TOOL_CALL)).toBe(false);
    expect(isJsonFinalAnswer("I ran out of steps.")).toBe(false);
    expect(isJsonFinalAnswer("")).toBe(false);
    expect(isJsonFinalAnswer(findingsJson())).toBe(true);
    expect(isJsonFinalAnswer("```json\n" + findingsJson() + "\n```")).toBe(true);
  });

  it("salvageFindings recovers the VALID findings from a schema-invalid answer", () => {
    const raw = JSON.stringify({
      agentKey: "code",
      // `summary` missing ⇒ agentOutputSchema.parse would throw and, before
      // #769, the whole run's findings would be discarded.
      findings: [
        { category: "security", severity: "high", title: "ok", body: "b", citations: [], tags: [] },
        // #1222 — this used to be `category: "not-a-category"`, which was a
        // CONFOUNDED fixture: an out-of-enum category is no longer a validation
        // failure (it coerces to `other`), so that finding would now be
        // salvaged and this test would have been asserting the coercion rather
        // than #769's property. A missing `title` is unambiguously malformed.
        { category: "security", severity: "high", body: "b" },
      ],
    });
    const salvaged = salvageFindings(raw);
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0]!.title).toBe("ok");
  });

  it("#1222 salvages a finding whose only defect is an out-of-enum category", () => {
    // The salvage path safeParses findings ONE AT A TIME, so before #1222 an
    // unrecognised category silently deleted that finding from the salvage set
    // — a second, quieter copy of the defect that failed whole agents.
    const salvaged = salvageFindings(
      JSON.stringify({
        agentKey: "code",
        findings: [{ category: "migration", severity: "high", title: "kept", body: "b" }],
      }),
    );
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0]!.category).toBe("other");
    expect(salvaged[0]!.title).toBe("kept");
  });

  it("salvageFindings returns [] for prose and for JSON without findings", () => {
    expect(salvageFindings("no json here")).toEqual([]);
    expect(salvageFindings('{"summary":"x"}')).toEqual([]);
    expect(salvageFindings('{"findings":"not-an-array"}')).toEqual([]);
  });

  it("buildDegradedAgentOutput names the reason, the tools run, and the salvage", () => {
    const out = buildDegradedAgentOutput({
      agentKey: "code",
      reason: "turn-limit",
      toolCalls: [{ tool: "search_code_graph" }, { tool: "search_code_graph" }],
      salvaged: salvageFindings(findingsJson()),
    });
    expect(out.agentKey).toBe("code");
    expect(out.findings).toHaveLength(1);
    expect(out.summary).toContain("Code analysis degraded");
    expect(out.summary).toContain("turn limit");
    expect(out.summary).toContain("search_code_graph");
    expect(out.notes.join(" ")).toContain("#769");
  });

  it("buildDegradedAgentOutput is valid with no tool calls and no findings", () => {
    const out = buildDegradedAgentOutput({
      agentKey: "code",
      reason: "non-json-response",
      toolCalls: [],
      salvaged: [],
    });
    expect(out.findings).toEqual([]);
    expect(out.summary).toContain("no tool calls completed");
  });
});
