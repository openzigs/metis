/**
 * #1388 — a tool-less reply used to end the agent loop on the spot. Reproduces
 * the measured DeepSeek pass offline: two tool turns, then a short reply that is
 * neither a call nor the answer. Without a continuation policy the loop stops at
 * three turns (the incident); with one it asks the model to go on, within the
 * turn cap, the token budget and its own nudge limit.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runAgentLoop } = await import("./agent-loop.js");

const listTool: AgentTool = {
  name: "list_files",
  description: "list files",
  parameters: { type: "object", properties: { glob: { type: "string" } } },
  async execute() {
    return { content: "internal/cli/cli.go" };
  },
} as unknown as AgentTool;

const TOOL_CALL = JSON.stringify({ tool: "list_files", args: { glob: "internal/**/*.go" } });
const ANSWER = JSON.stringify({ summary: "done", findings: [], notes: [] });
const PROSE = "I have read cli.go up to line 200; the remaining flags are registered further down.";
const NUDGE = "KEEP GOING";

const reply = (content: string, tokens = 100): ChatResponse => ({
  content,
  usage: { promptTokens: tokens - 10, completionTokens: 10, totalTokens: tokens },
  model: "stub",
  provider: "offline-stub",
});

/** Replies from `script` in order; the last entry repeats. */
function scripted(script: string[], tokens = 100) {
  const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = [];
  const provider = {
    async chat(messages: ChatMessage[], opts: ChatOptions = {}) {
      calls.push({ messages: messages.map((m) => ({ ...m })), opts });
      return reply(script[Math.min(calls.length - 1, script.length - 1)]!, tokens);
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

const input = {
  systemMessage: "You are Winston.",
  userMessage: "Investigate REQ-001..REQ-032.",
  tools: [listTool],
  toolContext: { projectId: "p1" },
} as Parameters<typeof runAgentLoop>[1];

const isJson = (t: string) => t.trim().startsWith("{") && !t.includes('"tool"');
const lastUserText = (messages: ChatMessage[]) =>
  String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");

describe("#1388 — the incident shape, without a continuation policy", () => {
  it("stops after three turns on a reply that is neither a call nor the answer", async () => {
    const { provider } = scripted([TOOL_CALL, TOOL_CALL, PROSE, TOOL_CALL, ANSWER]);
    const result = await runAgentLoop(provider, input, { maxTurns: 60, maxTokens: 100_000 });
    expect(result.turnsUsed).toBe(3);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.turnsExhausted).toBe(false);
    expect(result.budgetExhausted).toBe(false);
    expect(result.continuationNudges).toBeUndefined();
    expect(result.loopTokens).toBe(300);
  });
});

describe("#1388 — with a continuation policy", () => {
  it("sends an unusable reply back and keeps investigating until the answer", async () => {
    const { provider, calls } = scripted([TOOL_CALL, TOOL_CALL, PROSE, TOOL_CALL, ANSWER]);
    const nudge = vi.fn((text: string) => (isJson(text) ? null : NUDGE));
    const result = await runAgentLoop(provider, input, {
      maxTurns: 60,
      maxTokens: 100_000,
      continuation: { maxNudges: 2, nudge },
    });
    expect(result.turnsUsed).toBe(5);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.finalResponse).toBe(ANSWER);
    expect(result.hasFinalAnswer).toBe(true);
    expect(result.continuationNudges).toBe(1);
    // The prose stays in the transcript, followed by the instruction.
    const fourth = calls[3]!.messages;
    expect(fourth[fourth.length - 2]).toEqual({ role: "assistant", content: PROSE });
    expect(fourth[fourth.length - 1]).toEqual({ role: "user", content: NUDGE });
    // The policy is told where the loop stands.
    expect(nudge.mock.calls[0]![1]).toEqual({
      turnsUsed: 3,
      turnsLeft: 57,
      budgetUsed: 300,
      budgetTotal: 100_000,
      nudgesSent: 0,
    });
  });

  it("accepts the reply when the policy returns null", async () => {
    const { provider } = scripted([TOOL_CALL, ANSWER]);
    const result = await runAgentLoop(provider, input, {
      maxTurns: 10,
      continuation: { maxNudges: 2, nudge: () => null },
    });
    expect(result.turnsUsed).toBe(2);
    expect(result.continuationNudges).toBe(0);
    expect(result.finalResponse).toBe(ANSWER);
  });

  it("never sends more than maxNudges", async () => {
    const { provider } = scripted([PROSE]);
    const nudge = vi.fn(() => NUDGE);
    const result = await runAgentLoop(provider, input, {
      maxTurns: 10,
      continuation: { maxNudges: 2, nudge },
    });
    expect(nudge).toHaveBeenCalledTimes(2);
    expect(result.continuationNudges).toBe(2);
    expect(result.turnsUsed).toBe(3);
  });

  it("is not consulted on the last turn", async () => {
    const { provider } = scripted([TOOL_CALL, PROSE]);
    const nudge = vi.fn(() => NUDGE);
    const result = await runAgentLoop(provider, input, {
      maxTurns: 2,
      continuation: { maxNudges: 2, nudge },
    });
    expect(nudge).not.toHaveBeenCalled();
    expect(result.turnsUsed).toBe(2);
  });

  it("is not consulted once the token budget is spent", async () => {
    const { provider } = scripted([TOOL_CALL, PROSE], 100);
    const nudge = vi.fn(() => NUDGE);
    await runAgentLoop(provider, input, {
      maxTurns: 10,
      // Exactly spent after the second turn: record() does not throw, but nothing remains.
      maxTokens: 200,
      continuation: { maxNudges: 2, nudge },
    });
    expect(nudge).not.toHaveBeenCalled();
  });

  it("is not consulted on a cancelled run", async () => {
    const controller = new AbortController();
    const provider = {
      async chat() {
        controller.abort();
        return reply(PROSE);
      },
    } as unknown as AIProvider;
    const nudge = vi.fn(() => NUDGE);
    await runAgentLoop(provider, input, {
      maxTurns: 10,
      signal: controller.signal,
      continuation: { maxNudges: 2, nudge },
    });
    expect(nudge).not.toHaveBeenCalled();
  });

  it("joins the instruction to the previous user turn when the reply is empty", async () => {
    const { provider, calls } = scripted([TOOL_CALL, "", ANSWER]);
    await runAgentLoop(provider, input, {
      maxTurns: 10,
      continuation: { maxNudges: 2, nudge: (t) => (isJson(t) ? null : NUDGE) },
    });
    const third = calls[2]!.messages;
    expect(third[third.length - 1]!.role).toBe("user");
    expect(third[third.length - 2]!.role).toBe("assistant");
    expect(lastUserText(third).endsWith(NUDGE)).toBe(true);
    expect(lastUserText(third)).toContain("Tool result for list_files");
  });

  it("works on the native tool protocol too", async () => {
    let n = 0;
    const calls: ChatMessage[][] = [];
    const provider = {
      async chat(messages: ChatMessage[]) {
        calls.push(messages.map((m) => ({ ...m })));
        n += 1;
        if (n === 1) {
          return {
            ...reply(""),
            toolCalls: [{ id: "c1", name: "list_files", args: { glob: "*.go" } }],
          };
        }
        return reply(n === 2 ? PROSE : ANSWER);
      },
    } as unknown as AIProvider;
    const result = await runAgentLoop(provider, input, {
      maxTurns: 10,
      native: { tools: [{ name: "list_files", description: "d", parameters: {} }] as never },
      continuation: { maxNudges: 2, nudge: (t) => (isJson(t) ? null : NUDGE) },
    });
    expect(result.turnsUsed).toBe(3);
    expect(result.finalResponse).toBe(ANSWER);
    expect(lastUserText(calls[2]!)).toBe(NUDGE);
  });
});
