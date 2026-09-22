/**
 * Issue #16 — the time-sliced yielder, with an injected clock so the slicing
 * rule is pinned deterministically (the wall-clock behaviour is covered by the
 * event-loop test in `ingest.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createEventLoopYielder,
  DEFAULT_YIELD_BUDGET_MS,
} from "../../../src/lib/code-graph/event-loop-yield.js";
import { SchemaGraphWriter } from "../../../src/lib/code-graph/schema-graph.js";

describe("createEventLoopYielder", () => {
  it("yields only once the budget has elapsed, then starts a new slice", async () => {
    let t = 0;
    const yieldFn = vi.fn(async () => {});
    const maybeYield = createEventLoopYielder({ budgetMs: 50, now: () => t, yieldFn });

    t = 49;
    await maybeYield();
    expect(yieldFn).not.toHaveBeenCalled();

    t = 50;
    await maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(1);

    t = 99; // 49 ms into the new slice
    await maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(1);

    t = 100;
    await maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(2);
  });

  it("defaults to a 50 ms budget and a real macrotask yield", async () => {
    expect(DEFAULT_YIELD_BUDGET_MS).toBe(50);
    const maybeYield = createEventLoopYielder({ budgetMs: 0 });
    let immediateRan = false;
    setImmediate(() => {
      immediateRan = true;
    });
    await maybeYield();
    expect(immediateRan).toBe(true);
  });
});

describe("SchemaGraphWriter yields to the event loop (#16)", () => {
  it("awaits the yield before every row it writes, and not for cache hits", async () => {
    const order: string[] = [];
    let n = 0;
    const prisma = {
      codeSymbol: {
        create: async () => {
          order.push("symbol");
          return { id: `s${++n}` };
        },
      },
      codeEdge: {
        create: async () => {
          order.push("edge");
          return undefined;
        },
      },
    };
    const writer = new SchemaGraphWriter(prisma, "g1", "p1", async () => {
      order.push("yield");
    });

    const table = await writer.ensureTable("users", "orm");
    await writer.ensureTable("users", "orm"); // cached — no write, no yield
    const column = await writer.ensureColumn("users", "email", "orm");
    const routine = await writer.ensureRoutine("refresh_users", "procedure", "live-db");
    const origin = await writer.createOriginSymbol("method", "find", "a.java::find", "a.java", 3);
    await writer.addEdge(origin, "reads", table, "orm");
    await writer.addEdge(routine, "writes", column, "live-db");

    expect(order).toEqual([
      "yield",
      "symbol",
      "yield",
      "symbol",
      "yield",
      "symbol",
      "yield",
      "symbol",
      "yield",
      "edge",
      "yield",
      "edge",
    ]);
  });
});
