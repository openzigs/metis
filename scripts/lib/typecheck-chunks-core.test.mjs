import { describe, expect, it } from "vitest";

import {
  assertCovers,
  chunkCount,
  chunkRoots,
  isTestFile,
  mergeDiagnostics,
  planChunks,
} from "./typecheck-chunks-core.mjs";

/** #2503 — the pure half of the chunked test typecheck. */

describe("isTestFile", () => {
  it("matches test and spec files with TypeScript extensions only", () => {
    expect(isTestFile("/p/src/a.test.ts")).toBe(true);
    expect(isTestFile("/p/tests/a.sqlite.test.ts")).toBe(true);
    expect(isTestFile("/p/tests/a.spec.tsx")).toBe(true);
    expect(isTestFile("/p/tests/a.test.mts")).toBe(true);
    expect(isTestFile("/p/src/a.ts")).toBe(false);
    expect(isTestFile("/p/src/types.d.ts")).toBe(false);
    expect(isTestFile("/p/tests/helpers/test-db.ts")).toBe(false);
    expect(isTestFile("/p/tests/a.test.ts.snap")).toBe(false);
    expect(isTestFile("/p/src/latest.ts")).toBe(false);
  });
});

describe("chunkCount", () => {
  it("is ceil(tests / chunkSize), at least 1", () => {
    expect(chunkCount(0, 400)).toBe(1);
    expect(chunkCount(1, 400)).toBe(1);
    expect(chunkCount(400, 400)).toBe(1);
    expect(chunkCount(401, 400)).toBe(2);
    expect(chunkCount(2326, 400)).toBe(6);
  });

  it("refuses a chunk size that is not a positive integer", () => {
    expect(() => chunkCount(10, 0)).toThrow(/positive integer/);
    expect(() => chunkCount(10, -1)).toThrow(/positive integer/);
    expect(() => chunkCount(10, 1.5)).toThrow(/positive integer/);
    expect(() => chunkCount(10, Number.NaN)).toThrow(/positive integer/);
  });
});

describe("planChunks", () => {
  const roots = [
    "/p/src/index.ts",
    "/p/src/types.d.ts",
    "/p/src/a.test.ts",
    "/p/src/b.test.ts",
    "/p/tests/helpers/db.ts",
    "/p/tests/c.test.ts",
    "/p/tests/d.sqlite.test.ts",
    "/p/vitest.config.ts",
  ];

  it("puts every non-test root in the shared set, which every chunk carries", () => {
    const plan = planChunks(roots, 2);
    expect(plan.shared).toEqual([
      "/p/src/index.ts",
      "/p/src/types.d.ts",
      "/p/tests/helpers/db.ts",
      "/p/vitest.config.ts",
    ]);
    for (let i = 0; i < plan.chunks.length; i++) {
      expect(chunkRoots(plan, i).slice(0, plan.shared.length)).toEqual(plan.shared);
    }
  });

  it("deals test files round-robin in sorted order, each into exactly one chunk", () => {
    const plan = planChunks(roots, 2);
    expect(plan.chunks).toEqual([
      ["/p/src/a.test.ts", "/p/tests/c.test.ts"],
      ["/p/src/b.test.ts", "/p/tests/d.sqlite.test.ts"],
    ]);
  });

  it("does not depend on the input order", () => {
    expect(planChunks([...roots].reverse(), 3)).toEqual(planChunks(roots, 3));
  });

  it("adds a chunk when the test count passes a multiple of chunkSize", () => {
    expect(planChunks(roots, 4).chunks).toHaveLength(1);
    expect(planChunks(roots, 3).chunks).toHaveLength(2);
    expect(planChunks(roots, 1).chunks).toHaveLength(4);
  });

  it("keeps one chunk of shared files when there are no tests", () => {
    const plan = planChunks(["/p/src/index.ts"], 400);
    expect(plan.chunks).toEqual([[]]);
    expect(chunkRoots(plan, 0)).toEqual(["/p/src/index.ts"]);
  });

  it("the union of all chunks' roots is exactly the input", () => {
    const plan = planChunks(roots, 1);
    const union = new Set(plan.chunks.flatMap((_, i) => chunkRoots(plan, i)));
    expect([...union].sort()).toEqual([...roots].sort());
  });

  it("collapses a duplicated root instead of checking it twice", () => {
    const plan = planChunks([...roots, "/p/tests/c.test.ts"], 1);
    expect(plan.chunks.flat().filter((f) => f === "/p/tests/c.test.ts")).toHaveLength(1);
  });
});

describe("chunkRoots", () => {
  it("throws on an index outside the plan", () => {
    const plan = planChunks(["/p/a.test.ts"], 1);
    expect(() => chunkRoots(plan, 1)).toThrow(/no chunk 1; the plan has 1/);
  });
});

describe("assertCovers", () => {
  const ok = { shared: ["/p/a.ts"], chunks: [["/p/a.test.ts"], ["/p/b.test.ts"]] };
  const roots = ["/p/a.ts", "/p/a.test.ts", "/p/b.test.ts"];

  it("accepts an exact cover", () => {
    expect(() => assertCovers(roots, ok)).not.toThrow();
  });

  it("rejects a dropped file", () => {
    expect(() => assertCovers(roots, { ...ok, chunks: [["/p/a.test.ts"], []] })).toThrow(
      /missing \["\/p\/b.test.ts"\]/,
    );
  });

  it("rejects a file the project does not have", () => {
    expect(() => assertCovers(roots, { ...ok, chunks: [...ok.chunks, ["/p/x.test.ts"]] })).toThrow(
      /extra \["\/p\/x.test.ts"\]/,
    );
  });

  it("rejects a test file in two chunks", () => {
    expect(() =>
      assertCovers(roots, { ...ok, chunks: [["/p/a.test.ts", "/p/b.test.ts"], ["/p/b.test.ts"]] }),
    ).toThrow(/duplicated \["\/p\/b.test.ts"\]/);
  });
});

describe("mergeDiagnostics", () => {
  it("prints a diagnostic reported by several chunks once, keeping first-seen order", () => {
    const shared = { key: "src/a.ts:10:2322:x", text: "a", error: true };
    const onlyOne = { key: "tests/b.test.ts:5:2339:y", text: "b", error: true };
    const warn = { key: "w", text: "w", error: false };
    expect(mergeDiagnostics([[shared, onlyOne], [shared], [warn, shared]])).toEqual([
      shared,
      onlyOne,
      warn,
    ]);
  });

  it("is empty when no chunk reported anything", () => {
    expect(mergeDiagnostics([[], []])).toEqual([]);
  });
});
