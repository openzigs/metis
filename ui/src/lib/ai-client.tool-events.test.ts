/**
 * #142/#143 — tool events on the chat stream: parsed only when well-formed; an
 * approval prompt holds the stall guard open until the approval itself lapses
 * (the server sends nothing while a person decides); the transcript's tool
 * calls come back with how each was decided.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TranscriptMessageDto } from "@metis/shared";

const streamFetch = vi.fn();
const apiFetch = vi.fn();

vi.mock("./api-client", () => ({
  streamFetch: (...args: unknown[]) => streamFetch(...args),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {},
}));

const { streamChat, parseSseFrame, parseToolEvent, transcriptToDisplay, decideToolApproval } =
  await import("./ai-client");

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const EVENT = {
  type: "tool_event",
  phase: "awaiting_approval",
  sessionId: "s1",
  callId: "c1",
  name: "query_database",
  risk: "high",
  source: "metis",
  approvalId: "apr_1",
  ts: 1,
};

beforeEach(() => {
  streamFetch.mockReset();
  apiFetch.mockReset();
});

describe("tool_event parsing", () => {
  it("parses a well-formed tool_event frame", () => {
    expect(parseSseFrame(`event: tool_event\ndata: ${JSON.stringify(EVENT)}`)).toEqual(EVENT);
  });

  it.each([
    ["no phase", { ...EVENT, phase: undefined }],
    ["unknown phase", { ...EVENT, phase: "executed_anyway" }],
    ["no call id", { ...EVENT, callId: 3 }],
    ["wrong type", { ...EVENT, type: "delta" }],
    ["not an object", "approved"],
  ])("drops a malformed one (%s)", (_l, payload) => {
    expect(parseToolEvent(payload)).toBeNull();
  });
});

describe("streamChat holds the stall guard open during an approval", () => {
  it("does not time out while the approval is still open", async () => {
    vi.useFakeTimers();
    try {
      const expiresAt = new Date(Date.now() + 10_000).toISOString();
      const chunks = [frame("tool_event", { ...EVENT, expiresAt })];
      let i = 0;
      let release!: () => void;
      const later = new Promise<void>((r) => (release = r));
      streamFetch.mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (i < chunks.length) return { value: chunks[i++], done: false };
              if (i === chunks.length) {
                i++;
                await later; // the person takes a while to decide
                return { value: frame("delta", { content: "approved result" }), done: false };
              }
              return { value: undefined, done: true };
            },
            cancel: vi.fn(async () => {}),
          }),
        },
      });
      const seen: string[] = [];
      const run = (async () => {
        for await (const ev of streamChat("s1", "go", undefined, 1_000)) seen.push(ev.type);
      })();
      await vi.advanceTimersByTimeAsync(5_000); // past the 1s idle budget, inside the approval
      release();
      await vi.runAllTimersAsync();
      await run;
      expect(seen).toEqual(["tool_event", "delta"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("transcriptToDisplay tool calls", () => {
  it("returns each call with its decision; a refused call is marked not executed", () => {
    const rows = [
      {
        id: "m1",
        ordinal: 2,
        role: "assistant",
        kind: "message",
        compactedAt: null,
        parts: [
          { type: "tool_call", id: "c1", name: "count_rows", args: {} },
          {
            type: "tool_result",
            toolCallId: "c1",
            name: "count_rows",
            text: "x".repeat(1000),
            decision: "approve",
          },
          { type: "tool_call", id: "c2", name: "drop_table", args: {} },
          {
            type: "tool_result",
            toolCallId: "c2",
            name: "drop_table",
            text: "Error: denied",
            isError: true,
            decision: "deny",
            errorCode: "TOOL_DENIED",
            executed: false,
          },
          { type: "text", text: "Done." },
        ],
      },
    ] as unknown as TranscriptMessageDto[];
    const [turn] = transcriptToDisplay(rows);
    expect(turn!.tools).toEqual(["count_rows", "drop_table"]);
    expect(turn!.toolCalls).toEqual([
      expect.objectContaining({ id: "c1", decision: "approve", executed: true, isError: false }),
      expect.objectContaining({
        id: "c2",
        decision: "deny",
        executed: false,
        errorCode: "TOOL_DENIED",
      }),
    ]);
    expect(turn!.toolCalls![0]!.resultPreview.length).toBeLessThan(420);
  });
});

describe("decideToolApproval", () => {
  it("posts the owner's answer to the session's approval route", async () => {
    apiFetch.mockResolvedValue({ approvalId: "apr_1", decision: "deny" });
    await decideToolApproval("s 1", "apr_1", "deny");
    expect(apiFetch).toHaveBeenCalledWith("/ai/sessions/s%201/approvals/apr_1", {
      method: "POST",
      body: { decision: "deny" },
    });
  });
});
