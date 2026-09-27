/**
 * #204 — while a chat turn waits for the local model (another generation holds
 * its only slot) the server sends a `queue` frame and then nothing but
 * keep-alives. The client parses the frame and holds its stall guard open for
 * the server's queue limit, instead of ending a turn that is merely queued.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const streamFetch = vi.fn();

vi.mock("./api-client", () => ({
  streamFetch: (...args: unknown[]) => streamFetch(...args),
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { streamChat, parseSseFrame } = await import("./ai-client");

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

beforeEach(() => streamFetch.mockReset());

describe("queue frames (#204)", () => {
  it("parses waiting and acquired", () => {
    expect(
      parseSseFrame(
        `event: queue\ndata: ${JSON.stringify({ type: "queue", state: "waiting", position: 2, maxWaitMs: 600000 })}`,
      ),
    ).toEqual({ type: "queue", state: "waiting", position: 2, maxWaitMs: 600000 });
    expect(
      parseSseFrame(`event: queue\ndata: ${JSON.stringify({ state: "acquired", waitedMs: 1200 })}`),
    ).toEqual({ type: "queue", state: "acquired", waitedMs: 1200 });
  });

  it("drops an unknown state and nulls malformed numbers", () => {
    expect(parseSseFrame(`event: queue\ndata: ${JSON.stringify({ state: "maybe" })}`)).toBeNull();
    expect(
      parseSseFrame(
        `event: queue\ndata: ${JSON.stringify({ state: "waiting", position: "x", maxWaitMs: -1 })}`,
      ),
    ).toEqual({ type: "queue", state: "waiting", position: null, maxWaitMs: null });
  });

  it("does not time out a turn that is waiting for the local model", async () => {
    vi.useFakeTimers();
    try {
      let i = 0;
      let release!: () => void;
      const later = new Promise<void>((r) => (release = r));
      streamFetch.mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (i === 0) {
                i++;
                return {
                  value: frame("queue", { state: "waiting", position: 1, maxWaitMs: 10_000 }),
                  done: false,
                };
              }
              if (i === 1) {
                i++;
                await later; // the other generation takes a while
                return { value: frame("delta", { content: "answer" }), done: false };
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
      await vi.advanceTimersByTimeAsync(5_000); // past the 1s idle budget, inside the queue limit
      release();
      await vi.runAllTimersAsync();
      await run;
      expect(seen).toEqual(["queue", "delta"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("once the slot is acquired the stall guard is back to the idle budget, not the queue limit", async () => {
    vi.useFakeTimers();
    try {
      let i = 0;
      const cancel = vi.fn(async () => {});
      streamFetch.mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              i++;
              if (i === 1) {
                return {
                  value: frame("queue", { state: "waiting", position: 1, maxWaitMs: 60_000 }),
                  done: false,
                };
              }
              if (i === 2) {
                return { value: frame("queue", { state: "acquired", waitedMs: 500 }), done: false };
              }
              return new Promise<never>(() => {}); // the model then goes silent
            },
            cancel,
          }),
        },
      });
      const seen: Array<{ type: string; code?: string }> = [];
      const run = (async () => {
        for await (const ev of streamChat("s1", "go", undefined, 1_000)) {
          seen.push({ type: ev.type, ...("code" in ev && ev.code ? { code: ev.code } : {}) });
        }
      })();
      // Well inside the 60s queue limit: the stall is still caught at ~1s.
      await vi.advanceTimersByTimeAsync(1_500);
      await run;
      expect(seen).toEqual([
        { type: "queue" },
        { type: "queue" },
        { type: "error", code: "STREAM_IDLE_TIMEOUT" },
      ]);
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
