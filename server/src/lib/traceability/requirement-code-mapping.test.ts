import { describe, expect, it, vi } from "vitest";
import {
  Bm25CodeSymbolSearcher,
  MemoizingBm25CodeSymbolSearcher,
  DEFAULT_MIN_CONFIDENCE,
  denoiseRequirementQuery,
  requirementQueryDenoiseEnabled,
  mapRequirementToCode,
  normalizeConfidence,
  requirementQueryText,
  REQUIREMENT_QUERY_STOPWORDS,
  type CodeSymbolCandidate,
  type CodeSymbolSearcher,
} from "./requirement-code-mapping.js";

const req = { id: "req-1", title: "Export invoices to CSV", body: "Add a CSV export endpoint." };

function searcherReturning(candidates: CodeSymbolCandidate[]): CodeSymbolSearcher {
  return { search: vi.fn().mockResolvedValue(candidates) };
}

describe("requirement-code-mapping", () => {
  describe("requirementQueryText", () => {
    it("joins title and body", () => {
      expect(requirementQueryText(req)).toContain("Export invoices to CSV");
      expect(requirementQueryText(req)).toContain("CSV export endpoint");
    });
    it("tolerates empty fields", () => {
      expect(requirementQueryText({ title: "", body: "" })).toBe("");
    });
  });

  describe("normalizeConfidence", () => {
    it("maps the top score to 1.0", () => {
      expect(normalizeConfidence(8, 8)).toBe(1);
    });
    it("scales proportionally", () => {
      expect(normalizeConfidence(4, 8)).toBe(0.5);
    });
    it("returns 0 when there is no positive signal", () => {
      expect(normalizeConfidence(5, 0)).toBe(0);
      expect(normalizeConfidence(Number.NaN, 8)).toBe(0);
    });
  });

  describe("mapRequirementToCode", () => {
    it("ranks candidates and normalizes confidence (happy path)", async () => {
      const searcher = searcherReturning([
        {
          symbolId: "s1",
          filePath: "a.ts",
          qualifiedName: "a.ts::exportCsv",
          name: "exportCsv",
          kind: "function",
          startLine: 1,
          endLine: 9,
          score: 10,
        },
        {
          symbolId: "s2",
          filePath: "b.ts",
          qualifiedName: "b.ts::other",
          name: "other",
          kind: "function",
          startLine: 2,
          endLine: 3,
          score: 5,
        },
      ]);
      const matches = await mapRequirementToCode(req, "proj-1", {}, { searcher });
      expect(matches).toHaveLength(2);
      expect(matches[0].codeSymbolId).toBe("s1");
      expect(matches[0].confidence).toBe(1);
      expect(matches[1].confidence).toBeCloseTo(0.5);
    });

    it("returns [] for an empty/un-ingested graph", async () => {
      const matches = await mapRequirementToCode(
        req,
        "proj-1",
        {},
        { searcher: searcherReturning([]) },
      );
      expect(matches).toEqual([]);
    });

    it("filters out matches below minConfidence", async () => {
      const searcher = searcherReturning([
        {
          symbolId: "s1",
          filePath: "a.ts",
          qualifiedName: "a.ts::x",
          name: "x",
          kind: "function",
          score: 10,
        },
        {
          symbolId: "s2",
          filePath: "b.ts",
          qualifiedName: "b.ts::y",
          name: "y",
          kind: "function",
          score: 1,
        },
      ]);
      const matches = await mapRequirementToCode(
        req,
        "proj-1",
        { minConfidence: 0.5 },
        { searcher },
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].codeSymbolId).toBe("s1");
      expect(DEFAULT_MIN_CONFIDENCE).toBe(0.3);
    });

    it("respects topK", async () => {
      const searcher = searcherReturning(
        Array.from({ length: 5 }, (_, i) => ({
          symbolId: `s${i}`,
          filePath: `f${i}.ts`,
          qualifiedName: `f${i}.ts::s${i}`,
          name: `s${i}`,
          kind: "function",
          score: 10 - i,
        })),
      );
      const matches = await mapRequirementToCode(
        req,
        "proj-1",
        { topK: 2, minConfidence: 0 },
        { searcher },
      );
      expect(matches).toHaveLength(2);
    });

    it("surfaces null-symbol (external) candidates", async () => {
      const searcher = searcherReturning([
        {
          symbolId: null,
          filePath: "ext.ts",
          qualifiedName: "ext.ts::thirdParty",
          name: "thirdParty",
          kind: "function",
          score: 7,
        },
      ]);
      const matches = await mapRequirementToCode(req, "proj-1", { minConfidence: 0 }, { searcher });
      expect(matches[0].codeSymbolId).toBeNull();
      expect(matches[0].filePath).toBe("ext.ts");
    });

    it("degrades to [] when the searcher throws", async () => {
      const searcher: CodeSymbolSearcher = { search: vi.fn().mockRejectedValue(new Error("boom")) };
      const matches = await mapRequirementToCode(req, "proj-1", {}, { searcher });
      expect(matches).toEqual([]);
    });

    it("persists idempotently when persist=true", async () => {
      const searcher = searcherReturning([
        {
          symbolId: "s1",
          filePath: "a.ts",
          qualifiedName: "a.ts::x",
          name: "x",
          kind: "function",
          score: 10,
        },
      ]);
      const deleteMany = vi.fn().mockReturnValue({ op: "delete" });
      const createMany = vi.fn().mockReturnValue({ op: "create" });
      const $transaction = vi.fn().mockResolvedValue([]);
      const prisma = {
        codeSymbol: {},
        requirementCodeMapping: { deleteMany, createMany },
        $transaction,
      } as never;

      await mapRequirementToCode(
        req,
        "proj-1",
        { persist: true, minConfidence: 0 },
        { searcher, prisma },
      );
      expect(deleteMany).toHaveBeenCalledWith({
        where: { requirementId: "req-1", source: "semantic" },
      });
      expect(createMany).toHaveBeenCalledOnce();
      expect($transaction).toHaveBeenCalledOnce();
    });
  });

  describe("Bm25CodeSymbolSearcher", () => {
    it("returns [] when the project has no symbols", async () => {
      const prisma = { codeSymbol: { findMany: vi.fn().mockResolvedValue([]) } };
      const searcher = new Bm25CodeSymbolSearcher(prisma as never);
      expect(await searcher.search("anything", "proj-1")).toEqual([]);
    });

    it("ranks symbols by BM25 relevance to the query", async () => {
      const prisma = {
        codeSymbol: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "s1",
              name: "exportInvoicesCsv",
              qualifiedName: "a.ts::exportInvoicesCsv",
              kind: "function",
              filePath: "a.ts",
              startLine: 1,
              endLine: 9,
            },
            {
              id: "s2",
              name: "loginUser",
              qualifiedName: "b.ts::loginUser",
              kind: "function",
              filePath: "b.ts",
              startLine: 2,
              endLine: 3,
            },
          ]),
        },
      };
      const searcher = new Bm25CodeSymbolSearcher(prisma as never);
      const hits = await searcher.search("export invoices csv", "proj-1");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].symbolId).toBe("s1");
    });

    it("the default searcher reloads + rebuilds the index on EVERY search (the cost #849/#872 avoids)", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const searcher = new Bm25CodeSymbolSearcher({ codeSymbol: { findMany } } as never);
      await searcher.search("q1", "proj-1");
      await searcher.search("q2", "proj-1");
      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });

  // ── #1003 — documentation/site artifacts excluded from the seed corpus ─────
  describe("documentation/site path filtering (#1003)", () => {
    const docRow = {
      id: "doc-1",
      name: "cancelOrder",
      qualifiedName: "src/site/es/xdoc/index.xml::cancelOrder",
      kind: "file",
      filePath: "src/site/es/xdoc/index.xml",
      startLine: null,
      endLine: null,
    };
    const mapperRow = {
      id: "mapper-1",
      name: "cancelOrder",
      qualifiedName:
        "src/main/resources/org/mybatis/jpetstore/persistence/OrderMapper.xml::cancelOrder",
      kind: "sql-statement",
      filePath: "src/main/resources/org/mybatis/jpetstore/persistence/OrderMapper.xml",
      startLine: 1,
      endLine: 5,
    };

    it("never seeds a site/doc XML symbol, even when it strongly matches the query", async () => {
      const prisma = { codeSymbol: { findMany: vi.fn().mockResolvedValue([docRow]) } };
      const searcher = new Bm25CodeSymbolSearcher(prisma as never);
      expect(await searcher.search("cancel order", "proj-1")).toEqual([]);
    });

    it("still seeds a mapper XML symbol with an identical strong match", async () => {
      const prisma = { codeSymbol: { findMany: vi.fn().mockResolvedValue([mapperRow]) } };
      const searcher = new Bm25CodeSymbolSearcher(prisma as never);
      const hits = await searcher.search("cancel order", "proj-1");
      expect(hits.map((h) => h.symbolId)).toEqual(["mapper-1"]);
    });

    it("filters the doc row out of a mixed corpus while retaining the mapper row", async () => {
      const prisma = {
        codeSymbol: { findMany: vi.fn().mockResolvedValue([docRow, mapperRow]) },
      };
      const searcher = new Bm25CodeSymbolSearcher(prisma as never);
      const hits = await searcher.search("cancel order", "proj-1");
      expect(hits.map((h) => h.symbolId)).toEqual(["mapper-1"]);
      expect(hits.some((h) => h.filePath.includes("xdoc"))).toBe(false);
    });
  });

  describe("MemoizingBm25CodeSymbolSearcher (#849/#872 perf)", () => {
    it("builds the corpus ONCE per project across many searches, then reuses it", async () => {
      const rows = [
        {
          id: "s1",
          name: "exportInvoicesCsv",
          qualifiedName: "a.ts::exportInvoicesCsv",
          kind: "function",
          filePath: "a.ts",
          startLine: 1,
          endLine: 9,
        },
      ];
      const findMany = vi.fn().mockResolvedValue(rows);
      const searcher = new MemoizingBm25CodeSymbolSearcher({ codeSymbol: { findMany } } as never);

      const a = await searcher.search("export invoices", "proj-1");
      const b = await searcher.search("something else", "proj-1");
      // ONE load for both searches (vs two for the default searcher above)…
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(a[0]?.symbolId).toBe("s1");
      expect(b).toEqual([]); // unrelated query → no positive hits, still no reload
      expect(findMany).toHaveBeenCalledTimes(1);

      // …but a DIFFERENT project builds its own corpus.
      await searcher.search("export invoices", "proj-2");
      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });

  // ── #943 — requirement query denoising ─────────────────────────────────────
  describe("denoiseRequirementQuery", () => {
    it("strips English function words so entity nouns anchor the query", () => {
      const out = denoiseRequirementQuery("Add a status flag to account");
      const tokens = out.split(/\s+/);
      expect(tokens).toContain("account");
      // function words + generic attribute/boilerplate removed
      expect(tokens).not.toContain("add");
      expect(tokens).not.toContain("to");
      expect(tokens).not.toContain("a");
      expect(tokens).not.toContain("status");
      expect(tokens).not.toContain("flag");
    });

    it("splits camelCase identically to the BM25 index before filtering", () => {
      // `addItemToCart` → add item to cart; add/to are stopwords, item/cart survive.
      expect(denoiseRequirementQuery("addItemToCart")).toBe("item cart");
    });

    it("keeps generic attribute/column nouns like 'status' and 'type' out of the query", () => {
      expect(REQUIREMENT_QUERY_STOPWORDS.has("status")).toBe(true);
      expect(REQUIREMENT_QUERY_STOPWORDS.has("type")).toBe(true);
      expect(REQUIREMENT_QUERY_STOPWORDS.has("level")).toBe(true);
      // …but real entity nouns are NOT stopwords.
      expect(REQUIREMENT_QUERY_STOPWORDS.has("account")).toBe(false);
      expect(REQUIREMENT_QUERY_STOPWORDS.has("product")).toBe(false);
      expect(REQUIREMENT_QUERY_STOPWORDS.has("inventory")).toBe(false);
    });

    it("falls back to the original query when every token is a stopword", () => {
      // No entity signal at all — denoising to empty would return zero matches, so
      // the raw query is preserved instead.
      expect(denoiseRequirementQuery("add a flag to the status")).toBe("add a flag to the status");
    });

    it("returns the original query when there are no tokens", () => {
      expect(denoiseRequirementQuery("")).toBe("");
      expect(denoiseRequirementQuery("!! ??")).toBe("!! ??");
    });

    it("IMPACT_QUERY_DENOISE=0 bypasses denoising and seeds on the raw query (#943 AC3)", () => {
      // Kill-switch off → the raw (pre-denoise) query is returned verbatim, so BM25
      // tokenizes the original prose exactly as it did before #943. Contrast with the
      // ON default, which strips "Add"/"a"/"to"/"status"/"flag" down to "account".
      const raw = "Add a status flag to account";
      try {
        vi.stubEnv("IMPACT_QUERY_DENOISE", "0");
        expect(requirementQueryDenoiseEnabled()).toBe(false);
        expect(denoiseRequirementQuery(raw)).toBe(raw);
        vi.stubEnv("IMPACT_QUERY_DENOISE", "false");
        expect(denoiseRequirementQuery(raw)).toBe(raw);
      } finally {
        vi.unstubAllEnvs();
      }
      // Default (flag unset) restores denoising.
      expect(requirementQueryDenoiseEnabled()).toBe(true);
      expect(denoiseRequirementQuery(raw)).toBe("account");
    });
  });

  describe("Bm25CodeSymbolSearcher denoising (#943 seed pollution)", () => {
    // A miniature layered corpus: the entity's mapper competes with a generic
    // `status`/`add…to` symbol that plain BM25 (corpus-IDF) would rank first.
    function layeredPrisma() {
      return {
        codeSymbol: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "acct_update",
              name: "updateAccount",
              qualifiedName: "persistence.AccountMapper.updateAccount",
              kind: "method",
              filePath: "AccountMapper.java",
              startLine: 1,
              endLine: 2,
            },
            {
              id: "cart_add",
              name: "addItemToCart",
              qualifiedName: "web.CartActionBean.addItemToCart",
              kind: "method",
              filePath: "CartActionBean.java",
              startLine: 1,
              endLine: 2,
            },
            {
              id: "inv_status",
              name: "getInventoryStatus",
              qualifiedName: "service.CatalogService.getInventoryStatus",
              kind: "method",
              filePath: "CatalogService.java",
              startLine: 1,
              endLine: 2,
            },
          ]),
        },
      };
    }

    it("seeds a 'status flag' requirement on the entity mapper, not the *.status/add symbols", async () => {
      const searcher = new Bm25CodeSymbolSearcher(layeredPrisma() as never);
      const hits = await searcher.search("Add a status flag to account", "proj-1");
      expect(hits[0].symbolId).toBe("acct_update");
      // The generic `status`/`add…to` collisions must NOT dominate the seed.
      const ids = hits.map((h) => h.symbolId);
      expect(ids[0]).not.toBe("cart_add");
      expect(ids[0]).not.toBe("inv_status");
    });

    it("collapses the requirement to its entity token so the mapper anchors the seed", () => {
      // The denoising is load-bearing: the generic `add`/`status`/`flag` tokens that
      // let `addItemToCart`/`getInventoryStatus` out-rank the account mapper are gone,
      // leaving only `account` to drive the seed.
      const denoised = denoiseRequirementQuery("Add a status flag to account");
      expect(denoised).not.toContain("status");
      expect(denoised).not.toContain("add");
      expect(denoised.split(/\s+/)).toEqual(["account"]);
    });
  });
});
