/**
 * #25 — Phase-1 fact extraction runs up to a configurable number of modules
 * concurrently, as a pool rather than batches gated on their slowest member.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { ConfigService as RealConfigService } from "../config/config-service.js";
import {
  DEFAULT_PHASE1_CONCURRENCY,
  MAX_PHASE1_CONCURRENCY,
  mapSettledWithConcurrency,
  resolvePhase1Concurrency,
} from "./phase1-concurrency.js";

function stubConfig(values: Record<string, number> = {}): ConfigService {
  return {
    getNumber: (key: string, d?: number) => values[key] ?? d,
  } as unknown as ConfigService;
}

/** A deferred promise the test resolves by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("resolvePhase1Concurrency (#25)", () => {
  it("defaults to 3", () => {
    expect(resolvePhase1Concurrency(stubConfig())).toBe(DEFAULT_PHASE1_CONCURRENCY);
    expect(DEFAULT_PHASE1_CONCURRENCY).toBe(3);
  });

  it("honours a configured limit and clamps it to 1..64", () => {
    const k = "DOCS_GEN_PHASE1_CONCURRENCY";
    expect(resolvePhase1Concurrency(stubConfig({ [k]: 12 }))).toBe(12);
    expect(resolvePhase1Concurrency(stubConfig({ [k]: 1000 }))).toBe(MAX_PHASE1_CONCURRENCY);
    expect(resolvePhase1Concurrency(stubConfig({ [k]: 0 }))).toBe(DEFAULT_PHASE1_CONCURRENCY);
    expect(resolvePhase1Concurrency(stubConfig({ [k]: -4 }))).toBe(DEFAULT_PHASE1_CONCURRENCY);
  });

  it("is a registered key readable from the environment (db → env)", () => {
    const config = new RealConfigService({
      env: { DOCS_GEN_PHASE1_CONCURRENCY: "8" },
      vault: {} as never,
    });
    expect(resolvePhase1Concurrency(config)).toBe(8);
  });
});

describe("mapSettledWithConcurrency (#25)", () => {
  it("never has more than `limit` calls in flight, and uses all of them", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapSettledWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
        return i * 2;
      },
    );
    expect(peak).toBe(4);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(
      Array.from({ length: 20 }, (_, i) => i * 2),
    );
  });

  it("starts the next item as soon as ANY call settles (no slowest-in-batch wait)", async () => {
    const slow = deferred<string>();
    const started: number[] = [];
    const run = mapSettledWithConcurrency([0, 1, 2, 3], 2, async (i) => {
      started.push(i);
      if (i === 0) return slow.promise; // item 0 stays in flight
      return `done-${i}`;
    });
    // Item 0 is still pending, yet items 1, 2 and 3 have all run through the
    // second slot. A fixed batch of 2 would have held item 2 until 0 finished.
    for (let k = 0; k < 5; k++) await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    slow.resolve("done-0");
    const out = await run;
    expect(out.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("keeps going past a failed item and reports it in place", async () => {
    const out = await mapSettledWithConcurrency(["a", "b", "c"], 2, async (x) => {
      if (x === "b") throw new Error("boom");
      return x.toUpperCase();
    });
    expect(out[0]).toEqual({ status: "fulfilled", value: "A" });
    expect(out[1].status).toBe("rejected");
    expect((out[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(out[2]).toEqual({ status: "fulfilled", value: "C" });
  });

  it("reports progress after every settled item", async () => {
    const seen: Array<[number, number]> = [];
    await mapSettledWithConcurrency(
      [1, 2, 3],
      3,
      async (x) => x,
      (c, t) => seen.push([c, t]),
    );
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("handles an empty list and a nonsensical limit", async () => {
    expect(await mapSettledWithConcurrency([], 5, async (x) => x)).toEqual([]);
    const out = await mapSettledWithConcurrency([1, 2], 0, async (x) => x + 1);
    expect(out).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 3 },
    ]);
  });
});
