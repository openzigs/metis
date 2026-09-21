/**
 * A module's symbol count is unbounded — a large SQL-heavy directory can carry
 * thousands of symbols — and `extractModuleFacts` looked up rationale findings
 * with `symbolId: { in: moduleSymbolIds } }`, one bind parameter per id. Past
 * the driver's bound-parameter limit that throws "query parameter limit ...
 * exceeded" and the whole module's facts are dropped (real-world repro against
 * a deep-ingested repo, 2026-09-03). This suite pins the batched-query fix.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";

const findManyMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("../prisma.js", () => ({
  prisma: {
    finding: { findMany: (...a: unknown[]) => findManyMock(...a) },
    docsGenFactCache: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => path.resolve(p)),
  readFile: vi.fn().mockResolvedValue("export function handler() { return 1; }\n"),
  readdir: vi.fn().mockResolvedValue([]),
}));

import { extractModuleFacts, type ModuleGroup } from "./holistic-synthesizer.js";
import type { AIProvider } from "../ai/types.js";

function offlineProvider(): AIProvider {
  return {
    key: "offline-stub",
    model: "mock",
    offline: true,
    chat: vi.fn(),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

/** A module with `count` method symbols, one per synthesized `sym-N` id. */
function largeModule(count: number): ModuleGroup {
  return {
    dir: "src/big",
    syms: Array.from({ length: count }, (_, i) => ({
      id: `sym-${i}`,
      codeGraphId: "graph-a",
      qualifiedName: `big.ts::fn${i}`,
      kind: "function",
      language: "ts",
      filePath: "src/big/big.ts",
      startLine: 1,
      endLine: 2,
    })),
  };
}

describe("extractModuleFacts — rationale lookup is chunked", () => {
  beforeEach(() => {
    findManyMock.mockClear();
    findManyMock.mockResolvedValue([]);
  });

  it("splits a module with >500 symbols into multiple bounded IN(...) queries", async () => {
    await extractModuleFacts(largeModule(1200), offlineProvider(), false, "p1", "/clone");

    expect(findManyMock).toHaveBeenCalledTimes(3); // 500 + 500 + 200
    for (const [call] of findManyMock.mock.calls as Array<
      [{ where: { symbolId: { in: string[] } } }]
    >) {
      expect(call.where.symbolId.in.length).toBeLessThanOrEqual(500);
    }
  });

  it("stops issuing further chunks once 8 rationale rows are found", async () => {
    findManyMock.mockResolvedValueOnce(
      Array.from({ length: 8 }, (_, i) => ({ body: `rationale ${i}` })),
    );

    await extractModuleFacts(largeModule(1200), offlineProvider(), false, "p1", "/clone");

    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it("does not chunk a module with fewer than 500 symbols (single query, unchanged)", async () => {
    await extractModuleFacts(largeModule(3), offlineProvider(), false, "p1", "/clone");

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const [[call]] = findManyMock.mock.calls as Array<[{ where: { symbolId: { in: string[] } } }]>;
    expect(call.where.symbolId.in).toHaveLength(3);
  });
});
