/**
 * #1036 — structural twins. The callee sets are Miniflux v2.3.3's, read from the
 * run-7 code graph: `showFeedEntriesPage` and `showCategoryEntriesPage` are the
 * two functions upstream changed to fix #4386, and the search finds only the first.
 */
import { describe, expect, it } from "vitest";
import type { CodeGraphDataSource, GraphSymbol } from "../code-graph/query-service.js";
import {
  findStructuralTwins,
  hasCalleeNames,
  MAX_TWINS,
  MAX_TWINS_PER_SEED,
  MIN_CALLEES,
  resolveStructuralTwins,
  TWIN_CONFIDENCE_FACTOR,
} from "./structural-twins.js";

const SHARED = [
  "UserByID",
  "UserID",
  "HTMLServerError",
  "RouteInt64Param",
  "HTMLNotFound",
  "QueryIntParam",
  "GetEntriesWithCount",
  "WithLimit",
  "WithOffset",
  "WithoutContent",
  "WithStatuses",
  "WithSorting",
  "NewEntryQueryBuilder",
  "New",
  "Set",
  "getPagination",
  "routePath",
  "GetNavMetadata",
  "HTML",
  "Render",
];
const FEED_PAGE = new Set([...SHARED, "FeedByID", "WithFeedID"]);
const CATEGORY_PAGE = new Set([...SHARED, "Category", "WithCategoryID"]);
// A handler that shares only the request plumbing.
const LOGIN_PAGE = new Set([
  "UserByID",
  "HTML",
  "Render",
  "New",
  "Set",
  "CheckPassword",
  "Redirect",
]);

const callees = new Map<string, ReadonlySet<string>>([
  ["feed", FEED_PAGE],
  ["category", CATEGORY_PAGE],
  ["login", LOGIN_PAGE],
  ["tiny", new Set(["HTML", "Render"])],
]);

describe("findStructuralTwins (#1036)", () => {
  it("finds the category page from the feed page (20 of 24 callees shared)", () => {
    expect(findStructuralTwins(["feed"], callees)).toEqual([
      { id: "category", seedId: "feed", similarity: 20 / 24 },
    ]);
  });

  it("does not call a handler a twin for sharing the request plumbing", () => {
    expect(findStructuralTwins(["feed"], callees).map((t) => t.id)).not.toContain("login");
  });

  it("never returns a seed as its own or another seed's twin", () => {
    expect(findStructuralTwins(["feed", "category"], callees)).toEqual([]);
  });

  it("ignores a seed with too few callees to compare — two shared names prove nothing", () => {
    const pair = new Map<string, ReadonlySet<string>>([
      ["a", new Set(["Open", "Close"])],
      ["b", new Set(["Open", "Close"])],
    ]);
    expect(findStructuralTwins(["a"], pair)).toEqual([]);
  });

  it("ignores a candidate with too few callees, however similar", () => {
    const names = Array.from({ length: MIN_CALLEES }, (_, i) => `f${i}`);
    const pair = new Map<string, ReadonlySet<string>>([
      ["a", new Set(names)],
      ["b", new Set(names.slice(0, MIN_CALLEES - 1))],
    ]);
    expect(findStructuralTwins(["a"], pair)).toEqual([]);
  });

  it("ignores a seed the graph has no calls for", () => {
    expect(findStructuralTwins(["unknown"], callees)).toEqual([]);
  });

  it("keeps the most similar twins per seed, and caps the total", () => {
    const base = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const many = new Map<string, ReadonlySet<string>>([["seed", new Set(base)]]);
    // Six exact twins of one seed.
    for (let i = 0; i < 6; i++) many.set(`twin${i}`, new Set(base));
    expect(findStructuralTwins(["seed"], many)).toHaveLength(MAX_TWINS_PER_SEED);

    const wide = new Map<string, ReadonlySet<string>>();
    const seedIds: string[] = [];
    for (let s = 0; s < 10; s++) {
      const own = Array.from({ length: 10 }, (_, i) => `s${s}c${i}`);
      wide.set(`seed${s}`, new Set(own));
      seedIds.push(`seed${s}`);
      for (let i = 0; i < 4; i++) wide.set(`seed${s}twin${i}`, new Set(own));
    }
    expect(findStructuralTwins(seedIds, wide)).toHaveLength(MAX_TWINS);
  });

  it("keeps a twin once, under the seed it resembles most", () => {
    const base = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const map = new Map<string, ReadonlySet<string>>([
      ["exact", new Set(base)],
      ["near", new Set([...base.slice(0, 9), "other"])],
      ["twin", new Set(base)],
    ]);
    expect(findStructuralTwins(["near", "exact"], map)).toEqual([
      { id: "twin", seedId: "exact", similarity: 1 },
    ]);
  });
});

describe("resolveStructuralTwins (#1036)", () => {
  const symbolOf = (id: string): GraphSymbol => ({
    id,
    qualifiedName: `internal/ui/${id}_entries.go::show`,
    kind: "function",
    filePath: `internal/ui/${id}_entries.go`,
    language: "go",
    startLine: 15,
    endLine: 64,
  });
  const graphWith = (names: ReadonlyMap<string, ReadonlySet<string>> | null) => {
    const base: CodeGraphDataSource = {
      getSymbol: async () => null,
      getEdgesFrom: async () => [],
      getEdgesTo: async () => [],
      getSymbolsByFile: async () => [],
      getSymbolsByIds: async (ids) => ids.filter((id) => id !== "gone").map(symbolOf),
    };
    return names ? { ...base, calleeNameSets: () => names } : base;
  };
  const retrieved = [
    {
      codeSymbolId: "feed",
      filePath: "internal/ui/feed_entries.go",
      qualifiedName: "internal/ui/feed_entries.go::show",
      startLine: 15,
      endLine: 64,
      confidence: 0.6,
    },
  ];

  it("returns the twin as a match one step out from the symbol it resembles", async () => {
    expect(await resolveStructuralTwins(graphWith(callees), retrieved)).toEqual([
      {
        codeSymbolId: "category",
        filePath: "internal/ui/category_entries.go",
        qualifiedName: "internal/ui/category_entries.go::show",
        startLine: 15,
        endLine: 64,
        confidence: 0.6 * (20 / 24) * TWIN_CONFIDENCE_FACTOR,
      },
    ]);
  });

  it("returns nothing for a graph that carries no callee names", async () => {
    const plain = graphWith(null);
    expect(hasCalleeNames(plain)).toBe(false);
    expect(await resolveStructuralTwins(plain, retrieved)).toEqual([]);
  });

  it("skips a twin whose symbol the graph can no longer resolve", async () => {
    const map = new Map<string, ReadonlySet<string>>([
      ["feed", FEED_PAGE],
      ["gone", CATEGORY_PAGE],
    ]);
    expect(await resolveStructuralTwins(graphWith(map), retrieved)).toEqual([]);
  });

  it("ignores a retrieved match with no symbol id", async () => {
    const unresolved = [{ ...retrieved[0]!, codeSymbolId: null }];
    expect(await resolveStructuralTwins(graphWith(callees), unresolved)).toEqual([]);
  });
});
