/**
 * #726 — the final-answer retry re-sends a COMPACTED transcript, so evidence the
 * agent read early in the run reaches the answer as a 600-character head. The
 * caller may now hand the retry the untruncated evidence (`finalAnswerRetry.evidence`).
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runAgentLoop } = await import("./agent-loop.js");

const BODY = "func ValidateFeedCreation() {\n  if store.FeedURLExists(userID, url) {}\n}";

const readTool: AgentTool = {
  name: "read_file_slice",
  description: "read a file",
  parameters: { type: "object", properties: { filePath: { type: "string" } } },
  async execute() {
    return { content: BODY };
  },
} as unknown as AgentTool;

const reply = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  model: "stub",
  provider: "offline-stub",
});

const TOOL_CALL = JSON.stringify({ tool: "read_file_slice", args: { filePath: "feed.go" } });

function provider(): AIProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async chat(messages: ChatMessage[], _o: ChatOptions = {}) {
      calls.push(messages.map((m) => ({ ...m })));
      const asked = messages.some(
        (m) => typeof m.content === "string" && m.content.includes("ANSWER NOW"),
      );
      return reply(asked ? '{"findings":[]}' : TOOL_CALL);
    },
  } as unknown as AIProvider & { calls: ChatMessage[][] };
}

const input = {
  systemMessage: "You are Winston.",
  userMessage: "Investigate REQ-1.",
  tools: [readTool],
  toolContext: { projectId: "p1" },
} as Parameters<typeof runAgentLoop>[1];

describe("final-answer retry evidence (#726)", () => {
  it("puts the caller's evidence block ahead of the instruction, built from the full tool results", async () => {
    const p = provider();
    const evidence = vi.fn((calls: ReadonlyArray<{ tool: string; result?: string }>) =>
      calls.length > 0 ? `EVIDENCE:\n${calls[0].result}` : "",
    );
    const result = await runAgentLoop(p, input, {
      maxTurns: 2,
      finalAnswerRetry: { instruction: "ANSWER NOW", evidence },
    });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(evidence.mock.calls[0][0]).toHaveLength(2);
    const retry = p.calls[p.calls.length - 1];
    const last = String(retry[retry.length - 1].content);
    expect(last).toContain(`EVIDENCE:\n${BODY}`);
    expect(last.indexOf("EVIDENCE:")).toBeLessThan(last.indexOf("ANSWER NOW"));
  });

  it("sends the bare instruction when the evidence builder returns nothing", async () => {
    const p = provider();
    await runAgentLoop(p, input, {
      maxTurns: 1,
      finalAnswerRetry: { instruction: "ANSWER NOW", evidence: () => "" },
    });
    const retry = p.calls[p.calls.length - 1];
    const last = String(retry[retry.length - 1].content);
    expect(last.endsWith("ANSWER NOW")).toBe(true);
    expect(last).not.toContain("EVIDENCE");
  });

  it("never lets a throwing evidence builder cost the retry", async () => {
    const p = provider();
    const result = await runAgentLoop(p, input, {
      maxTurns: 1,
      finalAnswerRetry: {
        instruction: "ANSWER NOW",
        evidence: () => {
          throw new Error("boom");
        },
      },
    });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
  });
});
