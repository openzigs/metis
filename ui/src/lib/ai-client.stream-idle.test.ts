/**
 * #1366 — a chat stream that goes silent mid-answer must surface an error and
 * re-enable the composer, not hang forever.
 *
 * The observed failure: streaming halted after 215 characters, mid-word, and
 * stayed frozen for 13+ minutes. `Send` stayed disabled the whole time, with no
 * toast, no console error and no failed network request — because
 * `reader.read()` simply never resolved again and the `for await` loop never
 * exited, so the caller's `finally` never ran.
 *
 * Falsifiable: on `main` `streamChat` had no idle budget, so "surfaces a
 * terminal error" and "returns rather than hanging" both fail (by timing out).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const streamFetch = vi.fn();

vi.mock("./api-client", () => ({
  streamFetch: (...args: unknown[]) => streamFetch(...args),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const { streamChat, STREAM_IDLE_TIMEOUT_CODE } = await import("./ai-client");

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * A response body that emits `chunks` and then, if `stall` is true, never
 * resolves again — exactly the wedged-stream failure mode.
 */
function bodyOf(chunks: Uint8Array[], stall: boolean) {
  let i = 0;
  const cancel = vi.fn(async () => {});
  return {
    cancel,
    reader: {
      read: async () => {
        if (i < chunks.length) {
          const value = chunks[i];
          i += 1;
          return { value, done: false };
        }
        if (stall) return new Promise<never>(() => {});
        return { value: undefined, done: true };
      },
      cancel,
    },
  };
}

function mockStream(chunks: Uint8Array[], stall: boolean) {
  const b = bodyOf(chunks, stall);
  streamFetch.mockResolvedValue({
    ok: true,
    status: 200,
    body: { getReader: () => b.reader },
  });
  return b;
}

beforeEach(() => {
  streamFetch.mockReset();
});

describe("streamChat idle timeout (#1366)", () => {
  it("yields a terminal error event when the stream goes silent mid-answer", async () => {
    mockStream([frame("delta", { content: "partial " })], true);
    const events = [];
    for await (const ev of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 25)) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: "delta", content: "partial " });
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    expect(last.type === "error" && last.code).toBe(STREAM_IDLE_TIMEOUT_CODE);
  });

  it("returns instead of hanging, so the caller's finally re-enables Send", async () => {
    mockStream([frame("delta", { content: "partial" })], true);
    let finallyRan = false;
    try {
      for await (const _ of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 25)) {
        void _;
      }
    } finally {
      finallyRan = true;
    }
    expect(finallyRan).toBe(true);
  });

  it("preserves everything streamed before the stall", async () => {
    mockStream([frame("delta", { content: "one " }), frame("delta", { content: "two" })], true);
    let text = "";
    for await (const ev of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 25)) {
      if (ev.type === "delta") text += ev.content;
    }
    expect(text).toBe("one two");
  });

  it("cancels the reader so the socket is released, not leaked", async () => {
    const b = mockStream([], true);
    for await (const _ of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 20)) {
      void _;
    }
    expect(b.cancel).toHaveBeenCalled();
  });

  it("does NOT let a heartbeat comment reset the idle clock", async () => {
    // A live server writing `: ping` every tick while producing no tokens is
    // precisely the state a byte-level timer would never escape.
    let reads = 0;
    const reader = {
      read: async () => {
        reads += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { value: encoder.encode(": ping\n\n"), done: false };
      },
      cancel: vi.fn(async () => {}),
    };
    streamFetch.mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } });
    const events = [];
    for await (const ev of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 30)) {
      events.push(ev);
    }
    expect(reads).toBeGreaterThan(1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("passes a healthy stream through untouched", async () => {
    mockStream([frame("delta", { content: "all good" }), frame("done", { type: "done" })], false);
    const events = [];
    for await (const ev of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 5000)) {
      events.push(ev);
    }
    expect(events).toEqual([{ type: "delta", content: "all good" }, { type: "done" }]);
  });

  it("is disabled by a non-positive budget", async () => {
    mockStream([frame("delta", { content: "x" })], false);
    const events = [];
    for await (const ev of streamChat("s1", [{ role: "user", content: "hi" }], undefined, 0)) {
      events.push(ev);
    }
    expect(events).toEqual([{ type: "delta", content: "x" }]);
  });
});
