/**
 * #1139 — a chat tool turn whose model stream drops part-way through a reply
 * (walkthrough run 8: `anthropic stream failed (Error): terminated` on agent
 * loop turn 3) is retried ONCE from the last complete tool result, instead of
 * ending the turn and throwing away the tool work before it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

import { ApprovalGateService } from "../approval-policy.js";
import { OfflineStubProvider } from "../providers/offline-stub-provider.js";
import type {
  ApprovalPolicy,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "../types.js";
import { CHAT_MODEL_CALL_ATTEMPTS, runChatToolTurn, type ModelCallRetry } from "./chat-turn.js";
import { collectStream } from "./stream-collect.js";
import { makeToolset } from "./toolset.js";
import type { RuntimeTool } from "./types.js";

const CTX = { sessionId: "s1", userId: "alice", projectId: "p1" };
const AUTO: ApprovalPolicy = { low: "auto", medium: "auto", high: "auto" };

/** The live run's error, as the Anthropic adapter wraps it (status stamped 502). */
function droppedStream(): Error {
  return Object.assign(new Error("anthropic stream failed (Error): terminated"), { status: 502 });
}

function lookupTool(): RuntimeTool {
  let n = 0;
  return {
    name: "search_code",
    wireName: "search_code",
    description: "search",
    parameters: { type: "object" },
    risk: "low",
    source: "metis",
    validate: (args) => ({ ok: true, args }),
    execute: vi.fn(async () => ({ text: `hit ${++n}` })),
  };
}

function gate(): ApprovalGateService {
  return new ApprovalGateService({
    sessionId: CTX.sessionId,
    userId: CTX.userId,
    policy: AUTO,
    persist: false,
  });
}

/** A streamed reply: `text` as deltas, then optionally a drop instead of `done`. */
async function* stream(text: string, drop: boolean): AsyncGenerator<ChatChunk> {
  for (const word of text.split(" ")) yield { type: "delta", content: `${word} ` };
  if (drop) throw droppedStream();
  yield { type: "done", finishReason: "stop" };
}

const toolCall = (id: string): ChatResponse => ({
  content: "",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  model: "m",
  provider: "anthropic",
  toolCalls: [{ id, name: "search_code", args: { q: id } }],
});

/**
 * The /stream route's shape: turns 1 and 2 call a tool; turn 3 streams part of
 * its answer and then drops, `drops` times, before streaming the whole answer.
 */
function scripted(drops: number) {
  const calls: ChatMessage[][] = [];
  const streamed: string[] = [];
  let thirdTurnTries = 0;
  const callModel = vi.fn(async (m: ChatMessage[], _o: ChatOptions): Promise<ChatResponse> => {
    calls.push(m.map((x) => ({ ...x })));
    if (calls.length === 1) return toolCall("c1");
    if (calls.length === 2) return toolCall("c2");
    thirdTurnTries++;
    const drop = thirdTurnTries <= drops;
    return collectStream(stream(drop ? "The answer is" : "The answer is 42.", drop), {
      provider: "anthropic",
      model: "m",
      onDelta: (t) => streamed.push(t),
    });
  });
  return { callModel, calls, streamed, tries: () => thirdTurnTries };
}

const noWait = vi.fn(async () => undefined);

beforeEach(() => {
  noWait.mockClear();
});

describe("runChatToolTurn — #1139 a stream that drops mid-reply", () => {
  it("retries turn 3 once from the last complete tool result and answers", async () => {
    const tool = lookupTool();
    const { callModel, calls, tries } = scripted(1);
    const retries: ModelCallRetry[] = [];
    const out = await runChatToolTurn(
      new OfflineStubProvider({ script: [] }),
      {
        messages: [{ role: "user", content: "what is the answer?" }],
        toolset: makeToolset([tool]),
        native: true,
        ctx: CTX,
        gate: gate(),
      },
      { callModel, retrySleep: noWait, onModelCallRetry: (r) => retries.push(r) },
    );

    expect(out.finalResponse).toBe("The answer is 42. ");
    expect(tries()).toBe(2);
    expect(retries).toEqual([{ attempt: 1, errorClass: "stream-terminated" }]);
    // The tool work before the drop is NOT redone: two calls, each run once.
    expect(tool.execute).toHaveBeenCalledTimes(2);
    expect(out.toolResults.map((r) => r.result)).toEqual(["hit 1", "hit 2"]);
    // The retry is the identical request: it resumes after the second tool result.
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(calls[2]);
    const last = calls[3]![calls[3]!.length - 1]!;
    expect(last.role).toBe("tool");
    expect(String(last.content)).toContain("hit 2");
    expect(noWait).toHaveBeenCalledTimes(1);
  });

  it("is retried once only: a second drop ends the turn with the drop", async () => {
    const { callModel, tries } = scripted(2);
    const retries: ModelCallRetry[] = [];
    await expect(
      runChatToolTurn(
        new OfflineStubProvider({ script: [] }),
        {
          messages: [{ role: "user", content: "q" }],
          toolset: makeToolset([lookupTool()]),
          native: true,
          ctx: CTX,
          gate: gate(),
        },
        { callModel, retrySleep: noWait, onModelCallRetry: (r) => retries.push(r) },
      ),
    ).rejects.toThrow(/terminated/);
    expect(CHAT_MODEL_CALL_ATTEMPTS).toBe(2);
    expect(tries()).toBe(2);
    expect(retries).toHaveLength(1);
  });

  it.each([
    [
      "a 4xx",
      Object.assign(new Error("anthropic chat failed (BadRequestError): 400 bad"), { status: 400 }),
    ],
    [
      "a configuration error",
      Object.assign(new Error("no key"), { name: "AIConfigError", code: "AI_CONFIG_INVALID" }),
    ],
    ["a code error", new Error("cannot read properties of undefined")],
  ])("does not retry %s", async (_label, err) => {
    const callModel = vi.fn(async () => {
      throw err;
    });
    await expect(
      runChatToolTurn(
        new OfflineStubProvider({ script: [] }),
        {
          messages: [{ role: "user", content: "q" }],
          toolset: makeToolset([lookupTool()]),
          native: true,
          ctx: CTX,
          gate: gate(),
        },
        { callModel, retrySleep: noWait },
      ),
    ).rejects.toBe(err);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("does not retry a turn the user stopped", async () => {
    const ac = new AbortController();
    const callModel = vi.fn(async () => {
      ac.abort();
      throw droppedStream();
    });
    await expect(
      runChatToolTurn(
        new OfflineStubProvider({ script: [] }),
        {
          messages: [{ role: "user", content: "q" }],
          toolset: makeToolset([lookupTool()]),
          native: true,
          ctx: CTX,
          gate: gate(),
        },
        { callModel, retrySleep: noWait, signal: ac.signal },
      ),
    ).rejects.toThrow(/terminated/);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("a throwing retry listener does not stop the retry", async () => {
    const { callModel } = scripted(1);
    const out = await runChatToolTurn(
      new OfflineStubProvider({ script: [] }),
      {
        messages: [{ role: "user", content: "q" }],
        toolset: makeToolset([lookupTool()]),
        native: true,
        ctx: CTX,
        gate: gate(),
      },
      {
        callModel,
        retrySleep: noWait,
        onModelCallRetry: () => {
          throw new Error("listener broke");
        },
      },
    );
    expect(out.finalResponse).toBe("The answer is 42. ");
  });

  // PR #1234 review — the take-back happens when the retry STARTS, not when
  // the drop is classified: a Stop during the backoff must keep the text.
  it("tells the listener only once the backoff wait is over", async () => {
    const { callModel } = scripted(1);
    const order: string[] = [];
    await runChatToolTurn(
      new OfflineStubProvider({ script: [] }),
      {
        messages: [{ role: "user", content: "q" }],
        toolset: makeToolset([lookupTool()]),
        native: true,
        ctx: CTX,
        gate: gate(),
      },
      {
        callModel,
        retrySleep: async () => {
          order.push("wait");
        },
        onModelCallStart: () => order.push("start"),
        onModelCallRetry: () => order.push("retry"),
      },
    );
    // One start per model call (three), the retry after its wait.
    expect(order).toEqual(["start", "start", "start", "wait", "retry"]);
  });

  it("a Stop during the backoff wait takes nothing back and does not retry", async () => {
    const ac = new AbortController();
    const { callModel, tries } = scripted(1);
    const retries: ModelCallRetry[] = [];
    await expect(
      runChatToolTurn(
        new OfflineStubProvider({ script: [] }),
        {
          messages: [{ role: "user", content: "q" }],
          toolset: makeToolset([lookupTool()]),
          native: true,
          ctx: CTX,
          gate: gate(),
        },
        {
          callModel,
          signal: ac.signal,
          // The user presses Stop while the retry waits.
          retrySleep: async () => {
            ac.abort();
            throw new Error("aborted");
          },
          onModelCallRetry: (r) => retries.push(r),
        },
      ),
    ).rejects.toThrow(/aborted/);
    expect(retries).toEqual([]);
    expect(tries()).toBe(1);
  });

  it("retries on the text protocol too, marking each call's start", async () => {
    let n = 0;
    const callModel = vi.fn(async (): Promise<ChatResponse> => {
      n++;
      if (n === 1) throw droppedStream();
      return {
        content: "Plain answer.",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "m",
        provider: "anthropic",
      };
    });
    const starts = vi.fn();
    const retries: ModelCallRetry[] = [];
    const out = await runChatToolTurn(
      new OfflineStubProvider({ script: [] }),
      {
        messages: [{ role: "user", content: "q" }],
        toolset: makeToolset([lookupTool()]),
        native: false,
        ctx: CTX,
        gate: gate(),
      },
      {
        callModel,
        retrySleep: noWait,
        onModelCallStart: starts,
        onModelCallRetry: (r) => retries.push(r),
      },
    );
    expect(out.finalResponse).toBe("Plain answer.");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([{ attempt: 1, errorClass: "stream-terminated" }]);
  });
});
