/**
 * Epic #475 (Phase 4, #486) — discussions client API tests.
 *
 * Exercises the real `apiFetch` / `streamFetch` envelope by stubbing global
 * fetch (same approach as ai-client.test.ts), so the unwrap + SSE-parse paths
 * are covered end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThread,
  listThreads,
  listMessages,
  postMessage,
  promoteMessage,
  updateThreadSettings,
  streamAiReply,
  parseDiscussionSseFrame,
  mentionsAi,
  type AiRespondEvent,
} from "@/lib/discussions-api";
import { _resetAuthRetryState } from "@/lib/api-client";

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
    headers: new Headers({ "content-type": "application/json" }),
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
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: stream,
    json: () => Promise.resolve({ error: { message: "boom" } }),
  } as unknown as Response;
}

describe("discussions-api REST", () => {
  it("listThreads hits the project-scoped list endpoint and unwraps data", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [{ id: "t1", projectId: "p1" }] }),
    );
    const threads = await listThreads("p1");
    expect(threads).toEqual([{ id: "t1", projectId: "p1" }]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/discussions/threads?projectId=p1",
      expect.any(Object),
    );
  });

  it("listThreads returns [] when the payload has no data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    expect(await listThreads("p1")).toEqual([]);
  });

  it("createThread POSTs the project + title", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "t1" } }));
    const t = await createThread({ projectId: "p1", title: "Perf" });
    expect(t.id).toBe("t1");
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/discussions/threads");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      projectId: "p1",
      title: "Perf",
    });
  });

  it("updateThreadSettings PATCHes the aiResponseMode", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { id: "t1", aiResponseMode: "auto" } }),
    );
    const t = await updateThreadSettings("t1", { aiResponseMode: "auto" });
    expect(t.aiResponseMode).toBe("auto");
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/discussions/threads/t1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("listMessages builds the query string with limit + cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    await listMessages("t1", { limit: 50, cursor: "c1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/discussions/threads/t1/messages?limit=50&cursor=c1",
      expect.any(Object),
    );
  });

  it("listMessages omits the query string when no opts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    await listMessages("t1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/discussions/threads/t1/messages",
      expect.any(Object),
    );
  });

  it("postMessage POSTs the body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { id: "m1", body: "hello", authorKind: "human" } }),
    );
    const m = await postMessage("t1", "hello");
    expect(m.id).toBe("m1");
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/discussions/threads/t1/messages");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: "hello" });
  });

  it("promoteMessage POSTs the promote payload to the message endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { requirementId: "r1", analysisId: "a1" } }),
    );
    const r = await promoteMessage("t1", "m1", { title: "New req", type: "feature" });
    expect(r.requirementId).toBe("r1");
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/discussions/threads/t1/messages/m1/promote");
  });
});

describe("streamAiReply (SSE)", () => {
  it("yields delta + done events from the SSE stream", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        'event: delta\ndata: {"content":"hi "}\n\nevent: delta\ndata: {"content":"there"}\n\nevent: done\ndata: {}\n\n',
      ),
    );
    const events: AiRespondEvent[] = [];
    for await (const ev of streamAiReply("t1", "m1")) events.push(ev);
    expect(events).toEqual([
      { type: "delta", content: "hi " },
      { type: "delta", content: "there" },
      { type: "done" },
    ]);
  });

  it("treats a non-SSE (gate-declined JSON) response as a single done event", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { responded: false } }));
    const events: AiRespondEvent[] = [];
    for await (const ev of streamAiReply("t1", "m1")) events.push(ev);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("throws an ApiError on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "rate limited", code: "DISCUSSION_AI_RATE_LIMITED" } }, 429),
    );
    await expect(async () => {
      for await (const _ of streamAiReply("t1", "m1")) void _;
    }).rejects.toMatchObject({ status: 429, code: "DISCUSSION_AI_RATE_LIMITED" });
  });

  it("yields a single done event when the SSE response has no body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: null,
    } as unknown as Response);
    const events: AiRespondEvent[] = [];
    for await (const ev of streamAiReply("t1", "m1")) events.push(ev);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("surfaces an error frame in the stream", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse('event: error\ndata: {"message":"boom","code":"AI_PROVIDER_ERROR"}\n\n'),
    );
    const events: AiRespondEvent[] = [];
    for await (const ev of streamAiReply("t1", "m1")) events.push(ev);
    expect(events).toEqual([{ type: "error", message: "boom", code: "AI_PROVIDER_ERROR" }]);
  });
});

describe("parseDiscussionSseFrame", () => {
  it("returns null for empty / data-less frames", () => {
    expect(parseDiscussionSseFrame("")).toBeNull();
    expect(parseDiscussionSseFrame("event: ping")).toBeNull();
  });
  it("returns null for malformed JSON", () => {
    expect(parseDiscussionSseFrame("event: delta\ndata: {oops")).toBeNull();
  });
  it("parses a usage frame", () => {
    expect(parseDiscussionSseFrame('event: usage\ndata: {"usage":{"totalTokens":3}}')).toEqual({
      type: "usage",
      usage: { totalTokens: 3 },
    });
  });
  it("ignores unknown event types", () => {
    expect(parseDiscussionSseFrame('event: weird\ndata: {"x":1}')).toBeNull();
  });
});

describe("mentionsAi", () => {
  it("detects an @AI mention regardless of case", () => {
    expect(mentionsAi("hey @AI what's up")).toBe(true);
    expect(mentionsAi("@ai please help")).toBe(true);
  });
  it("does not match @airport or plain text", () => {
    expect(mentionsAi("book the @airport shuttle")).toBe(false);
    expect(mentionsAi("the build is green")).toBe(false);
  });
});
