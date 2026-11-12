/**
 * #2329 — `search_code_context`: whole symbols for a question, adjacent hits
 * merged, read from a real clone on disk. The searcher's ranking and the line
 * lookup are scripted; the ACL rows are a mocked Prisma read.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { symbolRows } = vi.hoisted(() => ({ symbolRows: vi.fn(async () => [] as unknown[]) }));
vi.mock("../../prisma.js", () => ({
  prisma: { codeSymbol: { findMany: symbolRows }, codeGraph: { findMany: async () => [] } },
}));

import {
  createSearchCodeContextTool,
  DEFAULT_SPANS,
  planSpanLines,
  SEARCH_CODE_CONTEXT_TOOL,
  SEARCH_DEPTH,
  type SearchCodeContextDeps,
} from "./search-code-context.js";
import { DEFAULT_LIMIT } from "./search-symbols.js";
import { codeAccessFilterOf } from "./code-access.js";
import { codeVersionIndexOf } from "../../code-graph/code-version.js";
import { getChatCodeTools, CHAT_CODE_TOOL_NAMES } from "./index.js";
import type { RawCodeSymbolHit } from "../../rag/fused-code-context.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MOVED = "fedcba9876543210fedcba9876543210fedcba98";
const CTX = { projectId: "p1" };

let clone: string;
beforeEach(async () => {
  clone = await mkdtemp(path.join(os.tmpdir(), "code-context-"));
  symbolRows.mockReset();
  symbolRows.mockResolvedValue([]);
});
afterEach(async () => {
  await rm(clone, { recursive: true, force: true });
});

async function file(rel: string, lines: number, mark: (n: number) => string = (n) => `L${n}`) {
  await mkdir(path.dirname(path.join(clone, rel)), { recursive: true });
  await writeFile(
    path.join(clone, rel),
    Array.from({ length: lines }, (_, i) => mark(i + 1)).join("\n"),
  );
}

interface Sym {
  id: string;
  path: string;
  start: number;
  end: number;
  repo?: string;
  matchedBy?: Array<"dense" | "lexical">;
}

function deps(ranked: Sym[], over: Partial<SearchCodeContextDeps> = {}) {
  const search = vi.fn(async (): Promise<RawCodeSymbolHit[]> =>
    ranked.map((s, i) => ({
      symbolId: s.id,
      filePath: s.path,
      name: s.id,
      kind: "function",
      score: 1 - i / 100,
      ...(s.matchedBy ? { matchedBy: s.matchedBy } : {}),
    })),
  );
  const resolve = vi.fn(
    async (ids: string[]) =>
      new Map(
        ranked
          .filter((s) => ids.includes(s.id))
          .map((s) => [
            s.id,
            {
              filePath: s.path,
              startLine: s.start,
              endLine: s.end,
              repoConnectionId: s.repo ?? "r1",
            },
          ]),
      ),
  );
  return {
    search,
    resolve,
    deps: {
      searcher: { search },
      lineLookup: { resolve },
      loadVersions: async () =>
        codeVersionIndexOf([
          {
            repoConnectionId: "r1",
            commitSha: SHA,
            repo: { provider: "github", ownerOrOrg: "acme", repoName: "app", apiBaseUrl: null },
          },
        ]),
      resolveCloneDir: async () => clone,
      readHead: async () => SHA,
      ...over,
    } satisfies Partial<SearchCodeContextDeps>,
  };
}

/** The line numbers a result printed, per `N| ` prefix. */
function printedLines(text: string): number[] {
  return [...text.matchAll(/^(\d+)\| /gm)].map((m) => Number(m[1]));
}

describe("search_code_context (#2329)", () => {
  it("merges overlapping and nearby hits in one file into one span, no line twice", async () => {
    await file("src/a.ts", 100);
    const { deps: d } = deps([
      { id: "outer", path: "src/a.ts", start: 10, end: 30 },
      { id: "inner", path: "src/a.ts", start: 15, end: 20 }, // inside outer
      { id: "next", path: "src/a.ts", start: 33, end: 40 }, // 2 lines after: merged
    ]);
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
    expect(r.resultCount).toBe(1);
    const lines = printedLines(r.content);
    expect(lines).toEqual(Array.from({ length: 31 }, (_, i) => 10 + i));
    expect(new Set(lines).size).toBe(lines.length);
    expect(r.content).toContain(
      "[1] src/a.ts:10-40 — function outer, function inner, function next",
    );
    expect(r.citations).toEqual([
      {
        path: "src/a.ts",
        startLine: 10,
        endLine: 40,
        commitSha: SHA,
        permalink: `https://github.com/acme/app/blob/${SHA}/src/a.ts#L10-L40`,
        truncated: false,
        totalLines: null,
        stale: false,
      },
    ]);
    expect(r.content).toContain("Code version: indexed commit 0123456789ab.");
  });

  it("keeps spans further apart than the gap separate, and the gap is configurable", async () => {
    await file("src/a.ts", 100);
    const ranked = [
      { id: "a", path: "src/a.ts", start: 10, end: 20 },
      { id: "b", path: "src/a.ts", start: 30, end: 40 },
    ];
    const apart = await createSearchCodeContextTool({ ...deps(ranked).deps, mergeGap: 3 }).execute(
      { query: "q" },
      CTX,
    );
    expect(apart.resultCount).toBe(2);
    const joined = await createSearchCodeContextTool({
      ...deps(ranked).deps,
      mergeGap: 9,
    }).execute({ query: "q" }, CTX);
    expect(joined.resultCount).toBe(1);
    expect(joined.citations?.[0]).toMatchObject({ startLine: 10, endLine: 40 });
  });

  it("never merges across files, and keeps the ranking's order", async () => {
    await file("src/a.ts", 50);
    await file("src/b.ts", 50);
    const { deps: d, search } = deps([
      { id: "b1", path: "src/b.ts", start: 5, end: 9, matchedBy: ["dense"] },
      { id: "a1", path: "src/a.ts", start: 5, end: 9, matchedBy: ["lexical"] },
      { id: "b2", path: "src/b.ts", start: 10, end: 12, matchedBy: ["lexical"] },
    ]);
    const r = await createSearchCodeContextTool(d).execute({ query: "how does b work" }, CTX);
    expect(r.citations?.map((c) => [c.path, c.startLine, c.endLine, c.matchedBy])).toEqual([
      ["src/b.ts", 5, 12, ["dense", "lexical"]],
      ["src/a.ts", 5, 9, ["lexical"]],
    ]);
    // Ranking unchanged: the same search, at search_code_symbols' depth.
    expect(search).toHaveBeenCalledWith("how does b work", "p1", { limit: SEARCH_DEPTH });
    expect(SEARCH_DEPTH).toBe(DEFAULT_LIMIT);
  });

  it("returns a symbol larger than the span budget as signature + the matched window", async () => {
    await file("src/big.ts", 400);
    const { deps: d } = deps([
      { id: "Big", path: "src/big.ts", start: 1, end: 300 },
      { id: "method", path: "src/big.ts", start: 200, end: 210 },
    ]);
    const r = await createSearchCodeContextTool({ ...d, maxSpanLines: 30 }).execute(
      { query: "q" },
      CTX,
    );
    const lines = printedLines(r.content);
    expect(lines.slice(0, 4)).toEqual([1, 2, 3, 4]); // the signature
    expect(lines).toEqual(expect.arrayContaining([200, 205, 210])); // the matched method
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(r.citations?.[0]).toMatchObject({
      startLine: 1,
      endLine: 300,
      truncated: true,
      totalLines: 300,
      next: { startLine: expect.any(Number), endLine: expect.any(Number) },
    });
    expect(r.content).toContain("cut: 300 lines in all");
    // Each returned part is its own locator; the whole span is not claimed as read.
    expect(r.content).toMatch(/src\/big\.ts:1-\d+, .*src\/big\.ts:\d+-\d+/);
    expect(r.content).not.toContain("src/big.ts:1-300");
  });

  it("holds the token budget and says how many spans it left out", async () => {
    for (let i = 0; i < 5; i += 1) await file(`src/f${i}.ts`, 40);
    const ranked = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`,
      path: `src/f${i}.ts`,
      start: 1,
      end: 40,
    }));
    const r = await createSearchCodeContextTool({ ...deps(ranked).deps, tokenBudget: 250 }).execute(
      { query: "q" },
      CTX,
    );
    expect(r.resultCount).toBeGreaterThan(0);
    expect(r.resultCount).toBeLessThan(5);
    const blocks = r.content.split("\n\n").filter((b) => /^\[\d+\]/.test(b));
    expect(Math.ceil(blocks.join("\n\n").length / 4)).toBeLessThanOrEqual(250);
    expect(r.content).toContain(`${5 - r.resultCount!} more span`);
    expect(r.truncated).toBe(true);
  });

  it("returns at most `limit` spans (default 6) and counts the rest", async () => {
    for (let i = 0; i < 8; i += 1) await file(`src/f${i}.ts`, 5);
    const ranked = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      path: `src/f${i}.ts`,
      start: 1,
      end: 3,
    }));
    const r = await createSearchCodeContextTool(deps(ranked).deps).execute({ query: "q" }, CTX);
    expect(r.resultCount).toBe(DEFAULT_SPANS);
    expect(r.content).toContain("2 more spans not returned");
    const two = await createSearchCodeContextTool(deps(ranked).deps).execute(
      { query: "q", limit: 2 },
      CTX,
    );
    expect(two.resultCount).toBe(2);
  });

  it("drops a hidden file's hits before merging, so no span reaches into it (A01)", async () => {
    await file("src/secret.ts", 20, (n) => `SECRET${n}`);
    await file("src/open.ts", 20);
    symbolRows.mockResolvedValue([
      { id: "s", filePath: "src/secret.ts", graph: { repoConnectionId: "r1" } },
      { id: "o", filePath: "src/open.ts", graph: { repoConnectionId: "r1" } },
    ]);
    const { deps: d } = deps([
      { id: "s", path: "src/secret.ts", start: 1, end: 10 },
      { id: "o", path: "src/open.ts", start: 1, end: 10 },
    ]);
    const codeAccess = codeAccessFilterOf([{ connectorId: "r1", path: "src/secret.ts" }]);
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, { ...CTX, codeAccess });
    expect(r.content).not.toContain("SECRET");
    expect(r.citations?.map((c) => c.path)).toEqual(["src/open.ts"]);
    // Dropped as if it were not indexed: not even counted as a match left unread.
    expect(r.content).not.toContain("could not be read");
    expect(r.content).not.toContain("not returned");
  });

  it("refuses an in-clone symlink to a hidden file, as read_file_slice does", async () => {
    await file("src/secret.ts", 5, (n) => `SECRET${n}`);
    await symlink("secret.ts", path.join(clone, "src", "alias.ts"));
    symbolRows.mockResolvedValue([
      { id: "a", filePath: "src/alias.ts", graph: { repoConnectionId: "r1" } },
    ]);
    const { deps: d } = deps([{ id: "a", path: "src/alias.ts", start: 1, end: 5 }]);
    const codeAccess = codeAccessFilterOf([{ connectorId: "r1", path: "src/secret.ts" }]);
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, { ...CTX, codeAccess });
    expect(r.content).not.toContain("SECRET");
    expect(r.resultCount).toBe(0);
  });

  it("never reads git internals or credential files, and skips a span the file no longer has", async () => {
    await file(".env", 3, () => "TOKEN=SECRET");
    await file("src/short.ts", 3);
    const { deps: d } = deps([
      { id: "env", path: ".env", start: 1, end: 3 },
      { id: "gone", path: "src/short.ts", start: 50, end: 60 },
    ]);
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
    expect(r.content).not.toContain("SECRET");
    expect(r.resultCount).toBe(0);
  });

  it("clamps a span to the file as it is on disk", async () => {
    await file("src/a.ts", 12);
    const { deps: d } = deps([{ id: "a", path: "src/a.ts", start: 10, end: 40 }]);
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
    expect(printedLines(r.content)).toEqual([10, 11, 12]);
    expect(r.citations?.[0]).toMatchObject({ startLine: 10, endLine: 12 });
  });

  it("flags spans read from a working tree the index is behind", async () => {
    await file("src/a.ts", 20);
    const { deps: d } = deps([{ id: "a", path: "src/a.ts", start: 1, end: 5 }], {
      readHead: async () => MOVED,
    });
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
    expect(r.citations?.[0]).toMatchObject({ stale: true, workingTreeSha: MOVED });
    expect(r.content).toContain("index is behind the repository");
  });

  it("is a clean empty result with no hit, and a repairable error with no query", async () => {
    const tool = createSearchCodeContextTool(deps([]).deps);
    expect(await tool.execute({ query: "q" }, CTX)).toMatchObject({ resultCount: 0 });
    const bad = await tool.execute({}, CTX);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("query");
    expect((await tool.execute({ query: "q" }, { projectId: "" })).isError).toBe(true);
  });

  it("says so when no matching file can be read", async () => {
    const { deps: d } = deps([{ id: "a", path: "src/a.ts", start: 1, end: 5 }], {
      resolveCloneDir: async () => undefined,
    });
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
    expect(r.resultCount).toBe(0);
    expect(r.content).toContain("could not be read");
  });
});

describe("planSpanLines", () => {
  it("returns a span that fits whole", () => {
    expect(planSpanLines({ startLine: 5, endLine: 9, hits: [] }, 10)).toEqual({
      ranges: [[5, 9]],
      truncated: false,
    });
  });

  it("keeps the signature and the body after it when no hit sits inside", () => {
    const plan = planSpanLines(
      { startLine: 1, endLine: 100, hits: [{ startLine: 1, endLine: 100 }] },
      10,
    );
    expect(plan).toEqual({
      ranges: [[1, 10]],
      truncated: true,
      next: { startLine: 11, endLine: 100 },
    });
  });

  it("names the next range at most 200 lines long", () => {
    const plan = planSpanLines({ startLine: 1, endLine: 1000, hits: [] }, 10);
    expect(plan.next).toEqual({ startLine: 11, endLine: 210 });
  });
});

describe("offering it in chat", () => {
  it("is offered only when switched on, beside the other code tools", () => {
    expect(getChatCodeTools().map((t) => t.name)).not.toContain(SEARCH_CODE_CONTEXT_TOOL);
    expect(getChatCodeTools({ codeContext: true }).map((t) => t.name)).toEqual([
      "search_code_graph",
      "search_code_symbols",
      "read_file_slice",
      SEARCH_CODE_CONTEXT_TOOL,
    ]);
    // Nameable in an agent's allowlist, and its results are evidence for citations.
    expect(CHAT_CODE_TOOL_NAMES).toContain(SEARCH_CODE_CONTEXT_TOOL);
  });
});
