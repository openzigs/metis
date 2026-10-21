/**
 * #921 — deriving the files an imported requirement likely affects, and the
 * Related code section that lists them.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  MemoizingBm25CodeSymbolSearcher,
  type RequirementCodeMatch,
} from "../traceability/requirement-code-mapping.js";
import { HybridCodeSymbolSearcher } from "../traceability/requirement-code-searcher.js";
import {
  MAX_DERIVED_FILES,
  MAX_DERIVED_REQUIREMENTS,
  deriveDraftImpactFiles,
  filesOf,
} from "./draft-impact-files.js";
import {
  IMPACT_FILES_UNAVAILABLE_NOTES,
  codeLinkSectionRecord,
  renderCodeLinksSection,
  renderImpactFilesUnavailable,
} from "./draft-code-links.js";

const match = (
  filePath: string,
  qualifiedName: string,
  confidence: number,
  startLine: number | null = 1,
): RequirementCodeMatch => ({
  codeSymbolId: qualifiedName,
  filePath,
  qualifiedName,
  startLine,
  endLine: startLine === null ? null : startLine + 5,
  confidence,
});

describe("filesOf", () => {
  it("keeps one row per file, its most confident symbol, most confident file first", () => {
    const rows = filesOf([
      match("a.go", "a.go::low", 0.1, 3),
      match("b.go", "b.go::Type::method", 0.4, 7),
      match("a.go", "a.go::high", 0.3, 9),
      match("c.go", "c.go", 0.2, null),
    ]);
    expect(rows).toEqual([
      { filePath: "b.go", startLine: 7, endLine: 12, symbolName: "Type::method", symbolKind: null },
      { filePath: "a.go", startLine: 9, endLine: 14, symbolName: "high", symbolKind: null },
      // A file's own row has no symbol name; its path is the location.
      { filePath: "c.go", startLine: null, endLine: null, symbolName: null, symbolKind: null },
    ]);
  });

  it("keeps a schema symbol's name whole, and lists at most MAX_DERIVED_FILES files", () => {
    expect(filesOf([match("schema.sql", "feeds.checked_at", 0.5)])[0]!.symbolName).toBe(
      "feeds.checked_at",
    );
    const many = Array.from({ length: MAX_DERIVED_FILES + 3 }, (_, i) =>
      match(`f${i}.go`, `f${i}.go::x`, 1 - i / 100),
    );
    expect(filesOf(many)).toHaveLength(MAX_DERIVED_FILES);
  });
});

describe("deriveDraftImpactFiles", () => {
  const rows = [
    { name: "markAllAsRead", filePath: "internal/ui/unread_mark_all_read.go" },
    { name: "flushSessions", filePath: "internal/cli/flush_sessions.go" },
  ].map((r, i) => ({
    id: `s${i}`,
    name: r.name,
    qualifiedName: `${r.filePath}::${r.name}`,
    kind: "function",
    filePath: r.filePath,
    startLine: 10,
    endLine: 20,
  }));
  const prismaOf = (symbols: typeof rows | Error) => {
    const findMany = vi.fn(async () => {
      if (symbols instanceof Error) throw symbols;
      return symbols;
    });
    return {
      prisma: { codeSymbol: { findMany } } as unknown as Pick<PrismaClient, "codeSymbol">,
      findMany,
    };
  };
  const req = (id: string, title: string) => ({ id, title, body: "" });

  it("says `no-code-graph` for every requirement when the project has no symbols", async () => {
    const { prisma } = prismaOf([]);
    const out = await deriveDraftImpactFiles("p", [req("a", "x"), req("b", "y")], { prisma });
    expect([...out.byRequirement.values()]).toEqual([
      { status: "no-code-graph" },
      { status: "no-code-graph" },
    ]);
  });

  it("reads an unreadable code graph as none, and never throws", async () => {
    const { prisma } = prismaOf(new Error("db down"));
    const out = await deriveDraftImpactFiles("p", [req("a", "x")], { prisma });
    expect(out.byRequirement.get("a")).toEqual({ status: "no-code-graph" });
  });

  it("maps each requirement to its files with the analysis link rules, saying which ranking ran", async () => {
    const { prisma, findMany } = prismaOf(rows);
    const out = await deriveDraftImpactFiles(
      "p",
      [req("a", "Mark all as read before a date"), req("b", "Flush all sessions")],
      { prisma },
    );
    expect(out.byRequirement.get("a")).toEqual({
      status: "derived",
      retrievalMode: "bm25-only",
      links: [expect.objectContaining({ filePath: "internal/ui/unread_mark_all_read.go" })],
    });
    expect(out.byRequirement.get("b")).toMatchObject({
      status: "derived",
      links: [expect.objectContaining({ symbolName: "flushSessions" })],
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("maps no more than MAX_DERIVED_REQUIREMENTS, and marks the rest `over-limit`", async () => {
    const { prisma } = prismaOf(rows);
    const many = Array.from({ length: MAX_DERIVED_REQUIREMENTS + 1 }, (_, i) =>
      req(`r${i}`, "Flush all sessions"),
    );
    const out = await deriveDraftImpactFiles("p", many, { prisma });
    expect(out.byRequirement.get(`r${MAX_DERIVED_REQUIREMENTS - 1}`)?.status).toBe("derived");
    expect(out.byRequirement.get(`r${MAX_DERIVED_REQUIREMENTS}`)).toEqual({ status: "over-limit" });
  });

  it("records `failed` for one requirement whose mapping escapes, and goes on", async () => {
    const { prisma } = prismaOf(rows);
    const real = new HybridCodeSymbolSearcher({
      bm25: new MemoizingBm25CodeSymbolSearcher(prisma),
      hybrid: { search: async () => [] },
      semanticModel: () => null,
    }).withOptions({});
    // A candidate the mapper cannot read: the failure escapes `mapRequirementToCode`.
    const unreadable = {
      get confidence(): number {
        throw new Error("boom");
      },
    };
    const fake = {
      withOptions: () => fake,
      loadsCodeGraph: async () => true,
      search: async (query: string, projectId: string) =>
        query.startsWith("bad") ? [unreadable] : real.search(query, projectId),
    } as unknown as HybridCodeSymbolSearcher;
    const out = await deriveDraftImpactFiles(
      "p",
      [req("bad", "bad requirement"), req("ok", "Flush all sessions")],
      { prisma, searcher: fake },
    );
    expect(out.byRequirement.get("bad")).toEqual({ status: "failed" });
    expect(out.byRequirement.get("ok")?.status).toBe("derived");
  });

  it("asks for nothing when there is nothing to map", async () => {
    const { prisma, findMany } = prismaOf(rows);
    const out = await deriveDraftImpactFiles("p", [], { prisma });
    expect(out.byRequirement.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the Related code section of a derived draft", () => {
  const repo = { origin: "https://github.com", owner: "acme", repo: "app", ref: "abc1234" };
  const link = {
    filePath: "internal/ui/x.go",
    startLine: 3,
    endLine: 9,
    symbolName: "markAllAsRead",
    symbolKind: null,
  };

  it("says the files were derived, and how they were ranked", () => {
    expect(renderCodeLinksSection([link], null, undefined, { retrievalMode: "hybrid" })[2]).toBe(
      "_Files METIS's code search ranks by meaning and keywords as the most likely affected by this requirement, derived when this draft was generated. Not verified by an analysis: a starting point, not a complete list of what to change._",
    );
    expect(
      renderCodeLinksSection([link], null, undefined, { retrievalMode: "bm25-only" })[2],
    ).toContain("by keywords only");
    expect(renderCodeLinksSection([link], null, undefined, { retrievalMode: null })[2]).toContain(
      "_Files METIS's code search ranks as the most likely affected",
    );
  });

  it("says in words that the search found nothing", () => {
    expect(renderCodeLinksSection([], null, undefined, { retrievalMode: "hybrid" })).toEqual([
      "## Related code",
      "",
      "_METIS's code search found no file this requirement likely affects: nothing in the project's code is close enough to it._",
    ]);
  });

  it("links a derived file into the repository, and records the plain form for Jira", () => {
    const record = codeLinkSectionRecord([link], repo, undefined, { retrievalMode: "hybrid" });
    expect(record?.linked).toContain(
      "https://github.com/acme/app/blob/abc1234/internal/ui/x.go#L3-L9",
    );
    expect(record?.plain).toContain("- `internal/ui/x.go:3-9` — `markAllAsRead`");
    expect(record?.plain).toContain("derived when this draft was generated");
  });

  it("says why no file could be derived, for each reason", () => {
    for (const reason of ["no-code-graph", "over-limit", "failed"] as const) {
      expect(renderImpactFilesUnavailable(reason)).toEqual([
        "## Related code",
        "",
        IMPACT_FILES_UNAVAILABLE_NOTES[reason],
      ]);
    }
    expect(IMPACT_FILES_UNAVAILABLE_NOTES["over-limit"]).toContain(`${MAX_DERIVED_REQUIREMENTS}`);
  });
});
