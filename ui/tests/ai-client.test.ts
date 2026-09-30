import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type StreamEvent,
  chat,
  createSession,
  createSessionWithScope,
  getSession,
  parseSseFrame,
  resumeChatSession,
  streamChat,
  updateSession,
} from "@/lib/ai-client";
import { _resetAuthRetryState, setOnRefreshFailure } from "@/lib/api-client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  _resetAuthRetryState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetAuthRetryState();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? "OK" : "Err",
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function sseResponse(text: string, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return {
    ok: status < 400,
    status,
    body: stream,
    json: () => Promise.resolve({ error: { message: "boom" } }),
  } as unknown as Response;
}

describe("ai-client REST", () => {
  it("createSession unwraps the session", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { session: { id: "s1", title: "t", provider: "p", model: "m" } },
      }),
    );
    const s = await createSession({ title: "t" });
    expect(s.id).toBe("s1");
  });

  it("createSessionWithScope returns the session AND the scope metadata (#607)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          session: { id: "s1", title: "t", provider: "p", model: "m" },
          scope: {
            requestedProjectIds: ["a", "b"],
            appliedProjectId: null,
            degraded: true,
            reason: "multi-project-unsupported",
          },
        },
      }),
    );
    const res = await createSessionWithScope({ title: "t", projectIds: ["a", "b"] });
    expect(res.session.id).toBe("s1");
    expect(res.scope).toEqual({
      requestedProjectIds: ["a", "b"],
      appliedProjectId: null,
      degraded: true,
      reason: "multi-project-unsupported",
    });
  });

  it("createSession passes the caller's abort signal to the request (#390)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { session: { id: "s1", title: "t" } } }),
    );
    const controller = new AbortController();
    await createSession({ title: "t" }, { signal: controller.signal });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });

  it("the default-agent retry keeps the caller's abort signal (#390)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: { code: "AGENT_NOT_FOUND", message: "no" } }, 404),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { session: { id: "s2", title: "t" } } }),
      );
    const controller = new AbortController();
    const res = await createSessionWithScope(
      { title: "t", agentRef: "custom:x" },
      { signal: controller.signal },
    );
    expect(res.droppedAgentRef).toBe("custom:x");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).signal).toBe(controller.signal);
  });

  it("createSessionWithScope tolerates a response without scope metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { session: { id: "s1", title: "t", provider: "p", model: "m" } },
      }),
    );
    const res = await createSessionWithScope({ title: "t" });
    expect(res.session.id).toBe("s1");
    expect(res.scope).toBeNull();
  });

  it("getSession + updateSession + chat call the right endpoints", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { session: { id: "s1" } } }),
    );
    await getSession("s1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/ai/sessions/s1", expect.any(Object));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { session: { id: "s1" } } }),
    );
    await updateSession("s1", { title: "new" });
    const [, init1] = fetchMock.mock.calls.at(-1)!;
    expect((init1 as RequestInit).method).toBe("PATCH");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          response: {
            content: "hi",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        },
      }),
    );
    const r = await chat("s1", "hello");
    expect(r.content).toBe("hi");
    // #136 — only the new message goes up.
    const [, chatInit] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String((chatInit as RequestInit).body))).toEqual({
      sessionId: "s1",
      message: "hello",
    });
  });
});

describe("resumeChatSession — read-only sessions (#149)", () => {
  function resumeBody(readOnlyReason: string | null) {
    return {
      success: true,
      data: {
        session: { id: "s1", provider: "copilot-native", readOnlyReason },
        messages: [],
      },
    };
  }

  it("carries the server's readOnlyReason through to the page", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(resumeBody("GitHub Copilot support was removed")))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { session: { id: "s1" } } }));
    const r = await resumeChatSession("s1");
    expect(r?.readOnlyReason).toBe("GitHub Copilot support was removed");
  });

  it("reads a missing reason as writable (null), never as undefined", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { session: { id: "s1" }, messages: [] } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { session: { id: "s1" } } }));
    const r = await resumeChatSession("s1");
    expect(r?.readOnlyReason).toBeNull();
  });
});

describe("parseSseFrame", () => {
  it("returns null for empty frames", () => {
    expect(parseSseFrame("")).toBeNull();
    expect(parseSseFrame("event: ping")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseSseFrame("event: delta\ndata: {oops")).toBeNull();
  });

  it("parses delta", () => {
    expect(parseSseFrame('event: delta\ndata: {"content":"hi"}')).toEqual({
      type: "delta",
      content: "hi",
    });
  });

  it("parses tool_call defaults", () => {
    expect(parseSseFrame("event: tool_call\ndata: {}")).toEqual({
      type: "tool_call",
      name: "(unknown)",
      arguments: undefined,
      risk: "low",
    });
  });

  it("parses usage / done / error", () => {
    expect(parseSseFrame('event: usage\ndata: {"totalTokens":3}')).toMatchObject({
      type: "usage",
    });
    expect(parseSseFrame("event: done\ndata: {}")).toEqual({ type: "done" });
    expect(parseSseFrame('event: error\ndata: {"message":"x"}')).toEqual({
      type: "error",
      message: "x",
      code: undefined,
    });
  });

  it("parses error with code", () => {
    expect(
      parseSseFrame('event: error\ndata: {"message":"400 status code","code":"AI_PROVIDER_ERROR"}'),
    ).toEqual({
      type: "error",
      message: "400 status code",
      code: "AI_PROVIDER_ERROR",
    });
  });

  it("ignores unknown events", () => {
    expect(parseSseFrame("event: weird\ndata: {}")).toBeNull();
  });

  it("(#718) strips residual tool-tag markup from a delta as defense-in-depth", () => {
    expect(
      parseSseFrame(
        'event: delta\ndata: {"content":"before <tool_call>{\\"name\\":\\"bash\\"}</tool_call> after"}',
      ),
    ).toEqual({ type: "delta", content: "before  after" });
  });

  it("(#718) leaves legitimate angle brackets in delta text untouched", () => {
    expect(parseSseFrame('event: delta\ndata: {"content":"use <div> here"}')).toEqual({
      type: "delta",
      content: "use <div> here",
    });
  });
});

describe("streamChat", () => {
  it("yields parsed events from an SSE response", async () => {
    const body =
      'event: delta\ndata: {"content":"He"}\n\n' +
      'event: delta\ndata: {"content":"llo"}\n\n' +
      'event: usage\ndata: {"totalTokens":2}\n\n' +
      "event: done\ndata: {}\n\n";
    fetchMock.mockResolvedValueOnce(sseResponse(body));
    const events: StreamEvent[] = [];
    for await (const ev of streamChat("s1", "hi")) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "usage", "done"]);
    // #136 — the request carries only the new message, never history.
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      sessionId: "s1",
      message: "hi",
    });
  });

  it("#138 — parses a compaction frame", async () => {
    const body =
      'event: compaction\ndata: {"compactedMessages":6,"summaryOrdinal":13}\n\n' +
      "event: done\ndata: {}\n\n";
    fetchMock.mockResolvedValueOnce(sseResponse(body));
    const events: StreamEvent[] = [];
    for await (const ev of streamChat("s1", "hi")) events.push(ev);
    expect(events[0]).toEqual({
      type: "compaction",
      compaction: { compactedMessages: 6, summaryOrdinal: 13 },
    });
  });

  it("throws an ApiError when the response is not OK", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse("", 500));
    await expect(async () => {
      for await (const _ of streamChat("s1", "x")) {
        // exhaust
      }
    }).rejects.toThrow();
  });

  it("yields error events from the SSE stream (#234)", async () => {
    const body =
      'event: error\ndata: {"code":"AI_PROVIDER_ERROR","message":"400 400 status code (no body)"}\n\n';
    fetchMock.mockResolvedValueOnce(sseResponse(body));
    const events: StreamEvent[] = [];
    for await (const ev of streamChat("s1", "hi")) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "400 400 status code (no body)",
      code: "AI_PROVIDER_ERROR",
    });
  });
});

// #422 — "accepted" is the server's 2xx, not the first frame: the question is
// on its way to the transcript before any frame is written.
describe("streamChat — onAccepted", () => {
  it("reports acceptance once, before any frame is read", async () => {
    const order: string[] = [];
    // A body with no frames at all: accepted, then dropped.
    fetchMock.mockResolvedValueOnce(sseResponse(""));
    const onAccepted = vi.fn(() => order.push("accepted"));
    for await (const ev of streamChat("s1", "hi", undefined, 0, onAccepted)) order.push(ev.type);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["accepted"]);
  });

  it("reports acceptance before the first frame is yielded", async () => {
    const order: string[] = [];
    fetchMock.mockResolvedValueOnce(sseResponse('event: delta\ndata: {"content":"x"}\n\n'));
    for await (const ev of streamChat("s1", "hi", undefined, 0, () => order.push("accepted"))) {
      order.push(ev.type);
    }
    expect(order).toEqual(["accepted", "delta"]);
  });

  it("does not report acceptance for a refused send", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse("", 409));
    const onAccepted = vi.fn();
    await expect(async () => {
      for await (const _ of streamChat("s1", "x", undefined, 0, onAccepted)) {
        // exhaust
      }
    }).rejects.toMatchObject({ name: "ApiError", status: 409 });
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

// H1 — streamChat MUST go through the same single-flight refresh chain as
// the rest of the API client. An expired access token should trigger one
// /auth/refresh, then the original stream request should be retried once.
describe("streamChat — 401 → refresh → retry chain", () => {
  it("refreshes once on 401 and reopens the stream", async () => {
    const goodBody = 'event: delta\ndata: {"content":"ok"}\n\n' + "event: done\ndata: {}\n\n";
    fetchMock
      .mockResolvedValueOnce(sseResponse("", 401)) // initial stream → 401
      .mockResolvedValueOnce(jsonResponse({ success: true })) // refresh ok
      .mockResolvedValueOnce(sseResponse(goodBody)); // retry succeeds

    const events: StreamEvent[] = [];
    for await (const ev of streamChat("s1", "hi")) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai/stream");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/refresh");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/ai/stream");
  });

  it("surfaces 401 and fires onRefreshFailure when refresh fails", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(sseResponse("", 401)) // initial stream → 401
      .mockResolvedValueOnce(jsonResponse({ success: false }, 401)); // refresh 401

    await expect(async () => {
      for await (const _ of streamChat("s1", "x")) {
        // exhaust
      }
    }).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("surfaces 401 when the retry itself returns 401 and notifies on failure", async () => {
    const onFail = vi.fn();
    setOnRefreshFailure(onFail);
    fetchMock
      .mockResolvedValueOnce(sseResponse("", 401))
      .mockResolvedValueOnce(jsonResponse({ success: true })) // refresh ok
      .mockResolvedValueOnce(sseResponse("", 401)); // retry still 401

    await expect(async () => {
      for await (const _ of streamChat("s1", "x")) {
        // exhaust
      }
    }).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
