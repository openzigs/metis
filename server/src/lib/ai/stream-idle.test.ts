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
