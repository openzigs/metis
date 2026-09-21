/**
 * Unit tests for the deterministic requirement→code mapping (#735, Epic #726).
 *
 * Pure render/truncation is tested in isolation; `computeAffectedCodeContext`
 * is driven with an injected mapper + in-memory graph so no DB/LLM is needed.
 */
import { describe, expect, it } from "vitest";
import type { AffectedCodeCandidate } from "@metis/shared";
import {
  computeAffectedCodeContext,
  renderAffectedCodeBlock,
  estimateAffectedCodeTokens,
  EMPTY_AFFECTED_CODE_CONTEXT,
} from "../src/lib/analysis/affected-code-context.js";
import type { RequirementCodeMatch } from "../src/lib/traceability/requirement-code-mapping.js";
import { InMemoryCodeGraphDataSource } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../src/lib/code-graph/query-service.js";

/** An empty code graph → no blast radius (mapper direct hits only). */
const emptyGraph = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => emptyGraph;

const candidate = (id: string, symbolCount: number): AffectedCodeCandidate => ({
  id,
  title: `requirement ${id}`,
  body: `body ${id}`,
  symbols: Array.from({ length: symbolCount }, (_, i) => ({
    filePath: `server/src/mod-${id}-${i}.ts`,
    qualifiedName: `Mod${id}.member${i}`,
    startLine: i + 1,
    endLine: i + 10,
    relation: i === 0 ? ("direct" as const) : ("caller" as const),
    depth: i === 0 ? 0 : 1,
    confidence: 0.9 - i * 0.1,
  })),
});

describe("renderAffectedCodeBlock", () => {
  it("returns an empty block for no candidates", () => {
    expect(renderAffectedCodeBlock([], 1000)).toEqual({ block: "", tokens: 0, truncated: false });
  });

  it("renders each symbol as a locator line and reports its token cost", () => {
    const { block, tokens, truncated } = renderAffectedCodeBlock([candidate("NR-1", 2)], 100000);
    expect(truncated).toBe(false);
    expect(block).toContain("[NR-1] requirement NR-1");
    expect(block).toContain("ModNR-1.member0"); // qualifiedName present
    expect(block).toContain("server/src/mod-NR-1-0.ts:1");
    expect(block).toContain("(direct, conf 0.90)");
    expect(block).toContain("(caller, conf 0.80)");
    expect(tokens).toBe(estimateAffectedCodeTokens(block));
  });

  it("shows a per-candidate empty state when a candidate matched no code", () => {
    const { block } = renderAffectedCodeBlock([candidate("NR-1", 1), candidate("NR-2", 0)], 100000);
    expect(block).toContain("[NR-2] requirement NR-2");
    expect(block).toContain("(no code matched — see coverage indicator)");
  });

  it("truncates deterministically at the token-budget boundary", () => {
    const cands = [candidate("NR-1", 4), candidate("NR-2", 4)];
    const full = renderAffectedCodeBlock(cands, 100000);
    expect(full.truncated).toBe(false);

    // Exactly at the full cost → identical, not truncated (inclusive boundary).
    expect(renderAffectedCodeBlock(cands, full.tokens)).toEqual(full);

    // One token below the full cost → must truncate, stay within budget, and be
    // byte-identical across repeated calls (determinism).
    const tight = renderAffectedCodeBlock(cands, full.tokens - 1);
    expect(tight.truncated).toBe(true);
    expect(tight.tokens).toBeLessThanOrEqual(full.tokens - 1);
    expect(tight.block.length).toBeLessThan(full.block.length);
    expect(renderAffectedCodeBlock(cands, full.tokens - 1)).toEqual(tight);
  });

  it("emits an empty block when not even the first line fits", () => {
    const { block, truncated } = renderAffectedCodeBlock([candidate("NR-1", 1)], 1);
    expect(block).toBe("");
    expect(truncated).toBe(true);
  });
});

describe("computeAffectedCodeContext", () => {
  const oneMatch: RequirementCodeMatch[] = [
    {
      codeSymbolId: "sym-1",
      filePath: "server/src/billing/invoice.ts",
      qualifiedName: "InvoiceService.charge",
      startLine: 20,
      endLine: 40,
      confidence: 0.92,
    },
  ];

  it("maps each parsed candidate to code and renders a fenced-ready block", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.\n\nAdd a refund endpoint.",
      enabled: true,
      tokenBudget: 100000,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    });
    expect(ctx.result.candidates).toHaveLength(2);
    expect(ctx.result.candidates[0].id).toBe("NR-1");
    expect(ctx.result.candidates[0].symbols[0]).toMatchObject({
      qualifiedName: "InvoiceService.charge",
      relation: "direct",
      depth: 0,
    });
    expect(ctx.block).toContain("InvoiceService.charge");
    expect(ctx.block).toContain("server/src/billing/invoice.ts:20");
    expect(ctx.filePaths).toContain("server/src/billing/invoice.ts");
    expect(ctx.tokens).toBeGreaterThan(0);
  });

  it("is deterministic — identical inputs yield byte-identical output across runs", async () => {
    const opts = {
      projectId: "proj-1",
      extraInstructions: "Requirement A about billing.\n\nRequirement B about auth.",
      enabled: true,
      tokenBudget: 100000,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    } as const;
    const a = await computeAffectedCodeContext(opts);
    const b = await computeAffectedCodeContext(opts);
    expect(a).toEqual(b);
  });

  it("degrades cleanly to a no-op when no code matched (no code graph)", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.\n\nAdd a refund endpoint.",
      enabled: true,
      tokenBudget: 100000,
      // No code graph ⇒ mapper returns nothing for every candidate.
      deps: { mapRequirement: async () => [], dataSourceFor: emptyGraphFor },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
    expect(ctx.block).toBe("");
  });

  it("no-ops (no throw) when extraInstructions is empty", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "   ",
      enabled: true,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });

  it("no-ops when the feature flag is disabled", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: false,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });

  it("keeps the run alive when the mapper throws for a candidate", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "First requirement.\n\nSecond requirement.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        // First candidate maps; second throws — the second is still surfaced
        // (with no symbols) and the whole computation does not reject.
        mapRequirement: async (req) =>
          req.title.startsWith("First") ? oneMatch : Promise.reject(new Error("boom")),
        dataSourceFor: emptyGraphFor,
      },
    });
    expect(ctx.result.candidates).toHaveLength(2);
    expect(ctx.result.candidates[0].symbols.length).toBeGreaterThan(0);
    expect(ctx.result.candidates[1].symbols).toEqual([]);
  });
});
