/**
 * #1366 — a chat stream that goes silent mid-answer must fail, not hang.
 *
 * Falsifiable: `withIdleTimeout` did not exist on `main`, and the route consumed
 * `provider.stream(...)` directly, so a source that never yields again simply
 * never resolves. Every "times out" test here hangs to the suite timeout without
 * the guard.
 */
import { describe, it, expect, vi } from "vitest";
import {
  withIdleTimeout,
  StreamIdleTimeoutError,
  STREAM_IDLE_TIMEOUT_CODE,
} from "./stream-idle.js";

/** A source that yields `items`, then goes silent forever. */
async function* stallsAfter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
  await new Promise(() => {}); // never resolves — the observed failure mode
}

async function* yieldsAll<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("withIdleTimeout (#1366)", () => {
  it("passes a healthy stream through unchanged", async () => {
    expect(await collect(withIdleTimeout(yieldsAll([1, 2, 3]), 1000))).toEqual([1, 2, 3]);
  });

  it("throws StreamIdleTimeoutError when the stream goes silent mid-answer", async () => {
    await expect(collect(withIdleTimeout(stallsAfter(["a"]), 20))).rejects.toBeInstanceOf(
      StreamIdleTimeoutError,
    );
  });

  it("preserves everything already streamed before the silence", async () => {
    const received: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of withIdleTimeout(stallsAfter(["partial ", "answer"]), 20)) {
          received.push(chunk);
        }
      })(),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(received).toEqual(["partial ", "answer"]);
  });

  it("carries a stable code and the idle budget so the route can log it", async () => {
    const err = await collect(withIdleTimeout(stallsAfter([]), 15)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamIdleTimeoutError);
    expect((err as StreamIdleTimeoutError).code).toBe(STREAM_IDLE_TIMEOUT_CODE);
    expect((err as StreamIdleTimeoutError).code).toBe("STREAM_IDLE_TIMEOUT");
    expect((err as StreamIdleTimeoutError).idleMs).toBe(15);
  });

  it("calls onTimeout so the caller can abort the upstream provider call", async () => {
    const onTimeout = vi.fn();
    await collect(withIdleTimeout(stallsAfter([]), 15, onTimeout)).catch(() => {});
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("resets the clock on every chunk, so a slow-but-progressing stream survives", async () => {
    async function* slow(): AsyncGenerator<number> {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((r) => setTimeout(r, 15));
        yield i;
      }
    }
    // Total runtime (~60ms) far exceeds the 30ms idle budget; no single GAP does.
    expect(await collect(withIdleTimeout(slow(), 30))).toEqual([0, 1, 2, 3]);
  });

  it("is disabled by a non-positive budget, passing the source straight through", async () => {
    expect(await collect(withIdleTimeout(yieldsAll([1, 2]), 0))).toEqual([1, 2]);
    expect(await collect(withIdleTimeout(yieldsAll([1, 2]), Number.NaN))).toEqual([1, 2]);
  });

  it("propagates an upstream error unchanged rather than masking it as a timeout", async () => {
    async function* boom(): AsyncGenerator<number> {
      yield 1;
      throw new Error("provider exploded");
    }
    await expect(collect(withIdleTimeout(boom(), 1000))).rejects.toThrow("provider exploded");
  });
});

describe("withIdleTimeout — #127 start after the local slot is acquired", () => {
  it("does not count time queued before the gate opens", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    async function* slowStart(): AsyncGenerator<string> {
      await new Promise((r) => setTimeout(r, 60)); // queued behind another generation
      yield "a";
    }
    const run = collect(withIdleTimeout(slowStart(), 30, undefined, gate));
    setTimeout(() => open(), 45); // slot acquired; first token 15ms later
    expect(await run).toEqual(["a"]);
  });

  it("still times out once the gate has opened", async () => {
    await expect(
      collect(withIdleTimeout(stallsAfter<string>([]), 20, undefined, Promise.resolve())),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
  });

  it("a rejected gate arms the clock too", async () => {
    await expect(
      collect(
        withIdleTimeout(stallsAfter<string>([]), 20, undefined, Promise.reject(new Error("x"))),
      ),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
  });

  it("without the gate the same queue wait IS a stall (the behaviour the gate fixes)", async () => {
    async function* slowStart(): AsyncGenerator<string> {
      await new Promise((r) => setTimeout(r, 60));
      yield "a";
    }
    await expect(collect(withIdleTimeout(slowStart(), 30))).rejects.toBeInstanceOf(
      StreamIdleTimeoutError,
    );
  });
});

describe("withIdleTimeout passes an early stop on to the source (#128 review)", () => {
  /** A source that records whether its `finally` (the provider's slot release) ran. */
  function tracked(items: string[]): { source: AsyncGenerator<string>; closed: () => boolean } {
    let closed = false;
    async function* gen(): AsyncGenerator<string> {
      try {
        for (const item of items) yield item;
        await new Promise(() => {}); // would stall if read past the items
      } finally {
        closed = true;
      }
    }
    return { source: gen(), closed: () => closed };
  }

  it("a consumer that breaks early closes the source", async () => {
    const t = tracked(["a", "b", "c"]);
    for await (const item of withIdleTimeout(t.source, 1000)) {
      if (item === "b") break;
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(t.closed()).toBe(true);
  });

  it("a consumer that throws mid-loop closes the source", async () => {
    const t = tracked(["a", "b"]);
    await expect(
      (async () => {
        for await (const item of withIdleTimeout(t.source, 1000)) {
          if (item === "a") throw new Error("consumer failed");
        }
      })(),
    ).rejects.toThrow("consumer failed");
    await new Promise((r) => setTimeout(r, 0));
    expect(t.closed()).toBe(true);
  });

  it("a completed source is not asked to return again", async () => {
    const returned = vi.fn();
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () =>
            i < 2 ? { value: i++, done: false } : { value: undefined, done: true },
          return: async () => {
            returned();
            return { value: undefined, done: true };
          },
        };
      },
    };
    expect(await collect(withIdleTimeout(source, 1000))).toEqual([0, 1]);
    expect(returned).not.toHaveBeenCalled();
  });

  it("a source that throws is not asked to return", async () => {
    const returned = vi.fn();
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("boom");
          },
          return: async () => {
            returned();
            return { value: undefined, done: true };
          },
        };
      },
    };
    await expect(collect(withIdleTimeout(source, 1000))).rejects.toThrow("boom");
    expect(returned).not.toHaveBeenCalled();
  });
});
