/**
 * #1969 — a project can connect several repositories, and the same path can
 * exist in more than one. The engine's file count and the seed evidence it
 * records name a file by (repository, path), never by path alone.
 */
import { describe, expect, it } from "vitest";
import type { ImpactSeedEvidence } from "@metis/shared";
import type { GraphSymbol } from "../code-graph/query-service.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import { computeProjectImpact, InMemoryCodeGraphDataSource } from "./impact-analysis-engine.js";

const SHARED = "src/types/order.ts";

function sym(id: string, filePath: string, repoConnectionId?: string): GraphSymbol {
  return {
    id,
    qualifiedName: `${filePath}::${id}`,
    kind: "interface",
    filePath,
    language: "ts",
    startLine: 1,
    endLine: 10,
    ...(repoConnectionId ? { repoConnectionId } : {}),
  };
}

const match = (s: GraphSymbol, confidence = 0.9): RequirementCodeMatch => ({
  codeSymbolId: s.id,
  filePath: s.filePath,
  qualifiedName: s.qualifiedName,
  startLine: s.startLine,
  endLine: s.endLine,
  confidence,
});

const change = {
  requirementId: null,
  title: "Add a currency to the order",
  body: "b",
  changeType: "added" as const,
  bodyDelta: 1,
};

const ordersOrder = sym("orders-order", SHARED, "repo-orders");
const billingOrder = sym("billing-order", SHARED, "repo-billing");
const billingInvoice = sym("billing-invoice", "src/invoice.ts", "repo-billing");

describe("computeProjectImpact — files keyed by (repository, path) (#1969)", () => {
  it("counts one path held by two repositories as two affected files", async () => {
    const graph = new InMemoryCodeGraphDataSource([ordersOrder, billingOrder], []);
    const result = await computeProjectImpact(change, "p1", {
      mapRequirement: async () => [match(ordersOrder), match(billingOrder)],
      dataSourceFor: () => graph,
    });
    expect(result.affectedSymbolCount).toBe(2);
    expect(result.affectedFileCount).toBe(2);
  });

  it("still counts by path when the graph does not say which repository a symbol is in", async () => {
    const a = sym("a", SHARED);
    const b = sym("b", SHARED);
    const result = await computeProjectImpact(change, "p1", {
      mapRequirement: async () => [match(a), match(b)],
      dataSourceFor: () => new InMemoryCodeGraphDataSource([a, b], []),
    });
    expect(result.affectedFileCount).toBe(1);
  });
});

describe("computeProjectImpact — seed evidence names each file's repository (#1969)", () => {
  const evidence: ImpactSeedEvidence = {
    editCandidates: [
      {
        filePath: SHARED,
        channels: ["hybrid", "edit-verifier"],
        verdict: { kind: "doubtful", reason: "only a type" },
      },
      { filePath: "src/invoice.ts", channels: ["hybrid"] },
    ],
  };
  const run = (editCandidates: RequirementCodeMatch[]) =>
    computeProjectImpact(change, "p1", {
      mapRequirement: async () => [],
      seedChange: async () => ({ editCandidates, related: [], schemaSeeds: [], evidence }),
      dataSourceFor: () =>
        new InMemoryCodeGraphDataSource([ordersOrder, billingOrder, billingInvoice], []),
    });

  it("records the repository of an entry whose seeds are all in one repository", async () => {
    const result = await run([match(ordersOrder), match(billingInvoice)]);
    expect(result.seedEvidence?.editCandidates).toEqual([
      { ...evidence.editCandidates[0], repoConnectionId: "repo-orders" },
      { ...evidence.editCandidates[1], repoConnectionId: "repo-billing" },
    ]);
  });

  it("names no repository on an entry seeded from the path in two repositories", async () => {
    const result = await run([match(ordersOrder), match(billingOrder), match(billingInvoice)]);
    const [shared, invoice] = result.seedEvidence!.editCandidates;
    expect(shared).toEqual(evidence.editCandidates[0]);
    expect(invoice.repoConnectionId).toBe("repo-billing");
  });
});
