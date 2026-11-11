/**
 * #2240 — documents attached to a question go up as `documentIds`, for the
 * server to search only them; a question with none sends the body as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHED_DOCUMENTS } from "@metis/shared";

const streamFetch = vi.fn();

vi.mock("./api-client", () => ({
  streamFetch: (...args: unknown[]) => streamFetch(...args),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { streamChat } = await import("./ai-client");

const done = new TextEncoder().encode(`event: done\ndata: {}\n\n`);

function respond() {
  let sent = false;
  streamFetch.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: done };
        },
        cancel: async () => {},
      }),
    },
  });
}

async function sentBody(documentIds?: string[]): Promise<unknown> {
  respond();
  for await (const _ of streamChat("s1", "the question", undefined, 0, undefined, documentIds)) {
    // drain
  }
  return JSON.parse((streamFetch.mock.calls[0]![1] as { body: string }).body);
}

beforeEach(() => streamFetch.mockReset());

describe("streamChat attachments (#2240)", () => {
  it("sends the attached document ids alongside the question as typed", async () => {
    expect(await sentBody(["d1", "d2"])).toEqual({
      sessionId: "s1",
      message: "the question",
      documentIds: ["d1", "d2"],
    });
  });

  it("never sends more ids than the server accepts, so the question is not refused", async () => {
    const many = Array.from({ length: MAX_ATTACHED_DOCUMENTS + 5 }, (_, i) => `d${i}`);
    const body = (await sentBody(many)) as { documentIds: string[] };
    expect(body.documentIds).toEqual(many.slice(0, MAX_ATTACHED_DOCUMENTS));
  });

  it("sends no documentIds when nothing is attached", async () => {
    expect(await sentBody([])).toEqual({ sessionId: "s1", message: "the question" });
    streamFetch.mockReset();
    expect(await sentBody()).toEqual({ sessionId: "s1", message: "the question" });
  });
});
