/**
 * Epic #596 / Issue #621 — AST Summary Cache unit tests.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  ASTSummaryCache,
  __resetASTSummaryCacheSingleton,
  getASTSummaryCache,
} from "../src/lib/analysis/ast-summary-cache.js";

describe("ASTSummaryCache", () => {
  let cache: ASTSummaryCache;

  beforeEach(() => {
    __resetASTSummaryCacheSingleton();
    cache = new ASTSummaryCache();
  });

  const TS_SOURCE = [
    "export function greet(name: string): string {",
    '  return "Hello " + name;',
    "}",
    "",
    "export class UserService {",
    "  getUser(id: string): User {",
    "    return {} as User;",
    "  }",
    "}",
  ].join("\n");

  const PY_SOURCE = [
    "def greet(name: str) -> str:",
    '    return f"Hello {name}"',
    "",
    "class Processor:",
    "    def run(self) -> None:",
    "        pass",
  ].join("\n");

  describe("indexFile", () => {
    it("indexes a TypeScript file and returns summaries", async () => {
      const summaries = await cache.indexFile("src/service.ts", TS_SOURCE);
      expect(summaries.length).toBeGreaterThanOrEqual(2);
      expect(summaries[0].filePath).toBe("src/service.ts");
      expect(summaries[0].symbol).toBe("greet");
      expect(summaries[0].kind).toBe("function");
    });

    it("indexes a Python file", async () => {
      const summaries = await cache.indexFile("main.py", PY_SOURCE);
      expect(summaries.length).toBeGreaterThanOrEqual(2);
      expect(summaries[0].symbol).toBe("greet");
    });

    it("skips unsupported file types", async () => {
      const summaries = await cache.indexFile("readme.md", "# Hello");
      expect(summaries).toHaveLength(0);
    });

    it("uses custom summarize function", async () => {
      const custom = new ASTSummaryCache({
        summarize: async (_src, sig) => `CUSTOM: ${sig}`,
      });
      const summaries = await custom.indexFile("test.ts", TS_SOURCE);
      expect(summaries[0].summary).toContain("CUSTOM:");
    });

    it("falls back to signature on summarize error", async () => {
      const failing = new ASTSummaryCache({
        summarize: async () => {
          throw new Error("LLM down");
        },
      });
      const summaries = await failing.indexFile("test.ts", TS_SOURCE);
      expect(summaries.length).toBeGreaterThan(0);
      // Should have a non-empty summary even on error
      expect(summaries[0].summary.length).toBeGreaterThan(0);
    });
  });

  describe("lookup", () => {
    it("returns miss for uncached file", async () => {
      const result = await cache.lookup("unknown.ts");
      expect(result.hit).toBe(false);
      expect(result.fallthrough).toBe(true);
      expect(result.summaries).toHaveLength(0);
    });

    it("returns hit for cached file", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const result = await cache.lookup("src/service.ts");
      expect(result.hit).toBe(true);
      expect(result.fallthrough).toBe(false);
      expect(result.summaries.length).toBeGreaterThan(0);
    });

    it("returns miss when source hash changed", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const result = await cache.lookup("src/service.ts", TS_SOURCE + "\n// modified");
      expect(result.hit).toBe(false);
      expect(result.fallthrough).toBe(true);
    });

    it("returns hit when source unchanged", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const result = await cache.lookup("src/service.ts", TS_SOURCE);
      expect(result.hit).toBe(true);
    });
  });

  describe("invalidate", () => {
    it("removes cached entries for specified files", async () => {
      await cache.indexFile("a.ts", TS_SOURCE);
      await cache.indexFile("b.ts", TS_SOURCE);
      expect(cache.size).toBe(2);

      const count = cache.invalidate(["a.ts"]);
      expect(count).toBe(1);
      expect(cache.size).toBe(1);

      const result = await cache.lookup("a.ts");
      expect(result.hit).toBe(false);
    });

    it("returns 0 for non-cached files", () => {
      expect(cache.invalidate(["nonexistent.ts"])).toBe(0);
    });
  });

  describe("search", () => {
    it("finds summaries by symbol name", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const results = cache.search("greet");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].symbol).toBe("greet");
    });

    it("finds summaries by signature content", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const results = cache.search("UserService");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("respects limit", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const results = cache.search("", 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("returns empty for no matches", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const results = cache.search("xyznonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("rebuildForFiles", () => {
    it("indexes multiple files", async () => {
      const result = await cache.rebuildForFiles([
        { path: "a.ts", content: TS_SOURCE },
        { path: "b.py", content: PY_SOURCE },
        { path: "c.md", content: "# Hello" },
      ]);
      expect(result.indexed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.totalSymbols).toBeGreaterThan(0);
      expect(cache.size).toBe(2);
    });
  });

  describe("stats and fallthroughRate", () => {
    it("tracks lookups and fallthroughs", async () => {
      await cache.indexFile("a.ts", TS_SOURCE);
      await cache.lookup("a.ts"); // hit
      await cache.lookup("b.ts"); // miss
      await cache.lookup("c.ts"); // miss

      const stats = cache.stats;
      expect(stats.lookups).toBe(3);
      expect(stats.fallthroughs).toBe(2);
      expect(stats.fallthroughRate).toBeCloseTo(2 / 3, 2);
    });

    it("returns 0 rate when no lookups", () => {
      expect(cache.fallthroughRate).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all entries and resets stats", async () => {
      await cache.indexFile("a.ts", TS_SOURCE);
      await cache.lookup("a.ts");
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.stats.lookups).toBe(0);
    });
  });

  describe("getFileSummaries", () => {
    it("returns summaries for indexed file", async () => {
      await cache.indexFile("a.ts", TS_SOURCE);
      expect(cache.getFileSummaries("a.ts").length).toBeGreaterThan(0);
    });

    it("returns empty for unknown file", () => {
      expect(cache.getFileSummaries("unknown.ts")).toHaveLength(0);
    });
  });

  describe("singleton", () => {
    it("returns same instance", () => {
      __resetASTSummaryCacheSingleton();
      const a = getASTSummaryCache();
      const b = getASTSummaryCache();
      expect(a).toBe(b);
    });
  });
});
