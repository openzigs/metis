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
  MAX_SPANS,
  planSpanLines,
  SEARCH_CODE_CONTEXT_TOOL,
  SEARCH_DEPTH,
  type SearchCodeContextDeps,
} from "./search-code-context.js";
import { DEFAULT_LIMIT } from "./search-symbols.js";
import { codeAccessFilterOf } from "./code-access.js";
import { codeVersionIndexOf } from "../../code-graph/code-version.js";
import { collectCitationEvidence, verifyCitations } from "../../ai/citation-verification.js";
import { getChatCodeTools, CHAT_CODE_TOOL_NAMES } from "./index.js";
import { CONFIG_KEYS } from "../../config/key-registry.js";
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
  /** The graph's repository; `null`: a legacy graph that names none. Default `r1`. */
  repo?: string | null;
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
              repoConnectionId: s.repo === undefined ? "r1" : s.repo,
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

/** The `[n] …` span blocks of a result, in order (the notes before them excluded). */
function spanBlocks(text: string): string[] {
  return text.split("\n\n").filter((b) => /^\[\d+\]/.test(b));
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
        repoConnectionId: "r1",
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

  it("holds the token budget and counts the spans it left out, naming none by locator", async () => {
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
    let spent = 0;
    for (const b of spanBlocks(r.content)) spent += Math.ceil(b.length / 4);
    expect(spent).toBeLessThanOrEqual(250);
    const left = 5 - r.resultCount!;
    expect(r.content).toContain(
      `${left} span${left === 1 ? "" : "s"} left out for the token budget`,
    );
    for (let i = r.resultCount!; i < 5; i += 1) expect(r.content).not.toContain(`src/f${i}.ts`);
    expect(r.truncated).toBe(true);
  });

  // Review finding 3 — a top-ranked span bigger than the whole budget used to be
  // skipped silently while lower-ranked ones filled the result.
  it("cuts the best-ranked span down to fit the budget instead of skipping it", async () => {
    await file("src/wide.ts", 120, (n) => `W${n} ${"x".repeat(120)}`);
    await file("src/small.ts", 5);
    const { deps: d } = deps([
      { id: "wide", path: "src/wide.ts", start: 1, end: 120 },
      { id: "small", path: "src/small.ts", start: 1, end: 3 },
    ]);
    const r = await createSearchCodeContextTool({ ...d, tokenBudget: 1000 }).execute(
      { query: "q" },
      CTX,
    );
    expect(r.citations?.[0]).toMatchObject({
      path: "src/wide.ts",
      startLine: 1,
      endLine: 120,
      truncated: true,
      totalLines: 120,
      next: { startLine: expect.any(Number) },
    });
    const first = spanBlocks(r.content)[0]!;
    expect(first).toMatch(/^\[1\] src\/wide\.ts:1-\d+ /);
    expect(printedLines(first).slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(Math.ceil(first.length / 4)).toBeLessThanOrEqual(1000);
    // The cut span took what the budget had; the next one is named, not dropped.
    expect(r.content).toContain("1 span left out for the token budget");
    expect(r.content).not.toContain("src/small.ts");
    expect(r.content).not.toContain("src/wide.ts:1-120");
  });

  // Panel finding (instruction-correctness) — the #2242 verifier reads every
  // `path:a-b` in a code tool's text as lines that were read, so a note naming
  // a left-out span by locator made a citation of it pass as verified.
  it("gives the citation verifier no locator for a span it did not return", async () => {
    await file("src/wide.ts", 120, (n) => `W${n} ${"x".repeat(120)}`);
    await file("src/small.ts", 5);
    const { deps: d } = deps([
      { id: "wide", path: "src/wide.ts", start: 1, end: 120 },
      { id: "small", path: "src/small.ts", start: 1, end: 3 },
    ]);
    const r = await createSearchCodeContextTool({ ...d, tokenBudget: 1000 }).execute(
      { query: "q" },
      CTX,
    );
    expect(r.content).toContain("1 span left out for the token budget");
    const ev = collectCitationEvidence(null, [
      {
        tool: SEARCH_CODE_CONTEXT_TOOL,
        source: "code",
        executed: true,
        result: r.content,
        ...(r.citations ? { citations: r.citations } : {}),
      },
    ]);
    const statuses = verifyCitations(
      "See src/wide.ts:1-4, src/small.ts:1-3 and src/wide.ts:110-120.",
      ev,
    ).map((c) => [c.text, c.status]);
    expect(statuses).toEqual([
      ["src/wide.ts:1-4", "verified"],
      // Left out for the budget: never read, so never verified.
      ["src/small.ts:1-3", "not-read"],
      // The cut span's tail was not printed either.
      ["src/wide.ts:110-120", "span-unverified"],
    ]);
  });

  it("returns at most MAX_SPANS spans however large a limit is asked for", async () => {
    for (let i = 0; i < 15; i += 1) await file(`src/f${i}.ts`, 1);
    const ranked = Array.from({ length: 15 }, (_, i) => ({
      id: `f${i}`,
      path: `src/f${i}.ts`,
      start: 1,
      end: 1,
    }));
    const r = await createSearchCodeContextTool(deps(ranked).deps).execute(
      { query: "q", limit: 50 },
      CTX,
    );
    expect(MAX_SPANS).toBe(12);
    expect(r.resultCount).toBe(MAX_SPANS);
    expect(r.content).toContain(`${15 - MAX_SPANS} more spans not returned`);
  });

  it("says in its description what the limit allows", () => {
    const { description } = createSearchCodeContextTool(deps([]).deps);
    expect(description).toContain(`${DEFAULT_SPANS} whole functions/classes by default`);
    expect(description).toContain(`up to ${MAX_SPANS}`);
  });

  // #2325 — a code citation is identified by repository AND path.
  it("stamps each citation with the repository it was read from, in a two-repo project", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "code-context-r2-"));
    try {
      await file("src/same.ts", 10, (n) => `R1-${n}`);
      await mkdir(path.join(other, "src"), { recursive: true });
      await writeFile(
        path.join(other, "src", "same.ts"),
        Array.from({ length: 10 }, (_, i) => `R2-${i + 1}`).join("\n"),
      );
      const { deps: d } = deps(
        [
          { id: "two", path: "src/same.ts", start: 1, end: 3, repo: "r2" },
          { id: "one", path: "src/same.ts", start: 1, end: 3, repo: "r1" },
        ],
        {
          resolveCloneDir: async (id) => (id === "r2" ? other : clone),
          loadVersions: async () =>
            codeVersionIndexOf([
              {
                repoConnectionId: "r1",
                commitSha: SHA,
                repo: { provider: "github", ownerOrOrg: "acme", repoName: "app", apiBaseUrl: null },
              },
              {
                repoConnectionId: "r2",
                commitSha: MOVED,
                repo: { provider: "github", ownerOrOrg: "acme", repoName: "lib", apiBaseUrl: null },
              },
            ]),
          readHead: async (dir) => (dir === other ? MOVED : SHA),
        },
      );
      const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
      expect(r.citations?.map((c) => [c.repoConnectionId, c.path, c.commitSha])).toEqual([
        ["r2", "src/same.ts", MOVED],
        ["r1", "src/same.ts", SHA],
      ]);
      expect(r.citations?.[0]?.permalink).toContain("acme/lib");
      const [b2, b1] = spanBlocks(r.content);
      expect(b2).toContain("R2-1");
      expect(b1).toContain("R1-1");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  // Panel finding (over-blocking) — a legacy graph names no repository; its
  // hits were dropped, so a project indexed only by one found no code.
  it("reads a legacy graph's hit (no repository) from the first clone that has it", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "code-context-legacy-"));
    try {
      // The file is only in the second repository's clone.
      await mkdir(path.join(other, "src"), { recursive: true });
      await writeFile(
        path.join(other, "src", "legacy.ts"),
        Array.from({ length: 6 }, (_, i) => `LEGACY${i + 1}`).join("\n"),
      );
      const { deps: d } = deps(
        [{ id: "old", path: "src/legacy.ts", start: 2, end: 4, repo: null }],
        {
          listRepoIds: async () => ["r1", "r2"],
          resolveCloneDir: async (id) => (id === "r2" ? other : clone),
          // The project's only graph is the legacy one: forRepo(null) is its version.
          loadVersions: async () =>
            codeVersionIndexOf([{ repoConnectionId: null, commitSha: SHA, repo: null }]),
        },
      );
      const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
      expect(r.resultCount).toBe(1);
      expect(printedLines(r.content)).toEqual([2, 3, 4]);
      expect(r.content).toContain("LEGACY3");
      expect(r.citations?.[0]).toMatchObject({
        repoConnectionId: "r2",
        path: "src/legacy.ts",
        startLine: 2,
        endLine: 4,
        commitSha: SHA,
        stale: false,
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  // Panel finding (test-falsifiability) — the repository passed to the clone's
  // access check must be the one read: repo A hides a path repo B exposes.
  it("checks a clone's access under that clone's repository, in a two-repo project", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "code-context-r2-"));
    try {
      // r1: src/x.ts is restricted; src/alias.ts links to it.
      await file("src/x.ts", 5, (n) => `R1SECRET${n}`);
      await symlink("x.ts", path.join(clone, "src", "alias.ts"));
      // r2: its own src/x.ts, which the caller may see.
      await mkdir(path.join(other, "src"), { recursive: true });
      await writeFile(
        path.join(other, "src", "x.ts"),
        Array.from({ length: 5 }, (_, i) => `R2OPEN${i + 1}`).join("\n"),
      );
      symbolRows.mockResolvedValue([
        { id: "alias", filePath: "src/alias.ts", graph: { repoConnectionId: "r1" } },
        { id: "open", filePath: "src/x.ts", graph: { repoConnectionId: "r2" } },
      ]);
      const { deps: d } = deps(
        [
          { id: "alias", path: "src/alias.ts", start: 1, end: 5, repo: "r1" },
          { id: "open", path: "src/x.ts", start: 1, end: 5, repo: "r2" },
        ],
        { resolveCloneDir: async (id) => (id === "r2" ? other : clone) },
      );
      const codeAccess = codeAccessFilterOf([{ connectorId: "r1", path: "src/x.ts" }]);
      const r = await createSearchCodeContextTool(d).execute(
        { query: "q" },
        { ...CTX, codeAccess },
      );
      // r1's alias resolves to r1's hidden file: refused under r1.
      expect(r.content).not.toContain("R1SECRET");
      // r2's own file is not hidden under r2: read.
      expect(r.content).toContain("R2OPEN1");
      expect(r.citations?.map((c) => [c.repoConnectionId, c.path])).toEqual([["r2", "src/x.ts"]]);
      expect(r.content).toContain("1 matching span could not be read");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  // #2327's rule, as read_file_slice applies it: a path that resolves to a
  // credential file through an in-repo link is refused too.
  it("refuses an in-clone link to a credential file, as read_file_slice does", async () => {
    await file(".ssh/id_rsa", 3, () => "PRIVATE KEY MATERIAL");
    await mkdir(path.join(clone, "src"), { recursive: true });
    await symlink("../.ssh/id_rsa", path.join(clone, "src", "key.ts"));
    const { deps: d } = deps([{ id: "k", path: "src/key.ts", start: 1, end: 3 }]);
    const r = await createSearchCodeContextTool(d).execute({ query: "q" }, CTX);
    expect(r.content).not.toContain("PRIVATE KEY");
    expect(r.resultCount).toBe(0);
  });

  it("puts its notes before the spans, so the model cap cannot cut them", async () => {
    for (let i = 0; i < 8; i += 1) await file(`src/f${i}.ts`, 5);
    const ranked = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      path: `src/f${i}.ts`,
      start: 1,
      end: 3,
    }));
    const r = await createSearchCodeContextTool(
      deps(ranked, { readHead: async () => MOVED }).deps,
    ).execute({ query: "q" }, CTX);
    const firstSpan = r.content.indexOf("[1] ");
    expect(firstSpan).toBeGreaterThan(0);
    for (const note of ["index is behind the repository", "more spans not returned"]) {
      const at = r.content.indexOf(note);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(firstSpan);
    }
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
      "get_index_status", // #2326, on by default
      SEARCH_CODE_CONTEXT_TOOL,
    ]);
    // Nameable in an agent's allowlist, and its results are evidence for citations.
    expect(CHAT_CODE_TOOL_NAMES).toContain(SEARCH_CODE_CONTEXT_TOOL);
  });

  it("bounds the token budget an administrator can set", () => {
    const schema = CONFIG_KEYS.CHAT_CODE_CONTEXT_TOKEN_BUDGET!.schema;
    expect(schema.safeParse("32000").success).toBe(true);
    expect(schema.safeParse("32001").success).toBe(false);
    expect(schema.safeParse("0").success).toBe(false);
  });
});
