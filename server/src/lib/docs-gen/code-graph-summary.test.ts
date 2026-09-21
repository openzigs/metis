/**
 * Unit tests for the code-graph edge summariser (#271, items 1 & 2).
 *
 * Proves DATA_LINEAGE (SAS dataset input/output) and the cross-module
 * dependency/call summary are derived correctly from CodeSymbol + CodeEdge
 * data — the SAME DB source the synthesizer already uses (no graphify CLI).
 */
import { describe, expect, it } from "vitest";
import {
  buildCodeGraphSummary,
  renderCrossModuleDeps,
  renderDatasetLineageChain,
  renderModuleLineage,
  type GraphEdge,
  type GraphSymbol,
} from "./code-graph-summary.js";

const sym = (id: string, filePath: string, name = id, kind = "function"): GraphSymbol => ({
  id,
  qualifiedName: `${filePath}::${name}`,
  kind,
  filePath,
  language: "sas",
});

const ref = (fromSymbolId: string, dataset: string, lineage: "input" | "output"): GraphEdge => ({
  kind: "references",
  fromSymbolId,
  toSymbolId: null,
  toQualifiedName: dataset,
  metadata: JSON.stringify({ lineage, dataset }),
});

describe("buildCodeGraphSummary — SAS dataset lineage", () => {
  it("surfaces per-module input/output datasets from references metadata", () => {
    const symbols = [sym("s1", "sas/etl/load.sas", "load")];
    const edges = [ref("s1", "raw.exposures", "input"), ref("s1", "work.flagged", "output")];
    const summary = buildCodeGraphSummary(symbols, edges);
    const block = renderModuleLineage(summary, "sas/etl");
    expect(block).toBeTruthy();
    expect(block).toContain("INPUT datasets (read): raw.exposures");
    expect(block).toContain("OUTPUT datasets (written): work.flagged");
  });

  it("builds a project-level dataset lineage chain: producer module → consumer module", () => {
    const symbols = [
      sym("s1", "sas/etl/load.sas", "load"),
      sym("s2", "sas/report/risk.sas", "risk"),
    ];
    const edges = [
      ref("s1", "work.flagged", "output"), // load writes work.flagged
      ref("s2", "work.flagged", "input"), // risk reads work.flagged
    ];
    const summary = buildCodeGraphSummary(symbols, edges);
    const chain = renderDatasetLineageChain(summary);
    expect(chain).toContain("DATASET LINEAGE");
    expect(chain).toContain("work.flagged");
    expect(chain).toMatch(/produced by \[.*etl.*\]/);
    expect(chain).toMatch(/consumed by \[.*report.*\]/);

    const lineage = summary.datasetLineage.find((d) => d.dataset === "work.flagged");
    expect(lineage?.producers).toContain("sas/etl");
    expect(lineage?.consumers).toContain("sas/report");
  });

  it("tolerates already-parsed metadata objects (not just JSON strings)", () => {
    const symbols = [sym("s1", "sas/etl/load.sas", "load")];
    const edges: GraphEdge[] = [
      {
        kind: "references",
        fromSymbolId: "s1",
        toSymbolId: null,
        toQualifiedName: "raw.in",
        metadata: { lineage: "input", dataset: "raw.in" },
      },
    ];
    const summary = buildCodeGraphSummary(symbols, edges);
    expect(renderModuleLineage(summary, "sas/etl")).toContain("raw.in");
  });

  it("ignores malformed metadata without throwing", () => {
    const symbols = [sym("s1", "sas/etl/load.sas")];
    const edges: GraphEdge[] = [
      {
        kind: "references",
        fromSymbolId: "s1",
        toSymbolId: null,
        toQualifiedName: "x",
        metadata: "{bad json",
      },
    ];
    const summary = buildCodeGraphSummary(symbols, edges);
    expect(summary.perModuleLineage.size).toBe(0);
  });

  it("restricts lineage to the supplied documentable module dirs", () => {
    const symbols = [sym("s1", "sas/etl/load.sas"), sym("s2", "sas/scratch/tmp.sas")];
    const edges = [ref("s1", "raw.in", "input"), ref("s2", "raw.in", "input")];
    const summary = buildCodeGraphSummary(symbols, edges, new Set(["sas/etl"]));
    expect(summary.perModuleLineage.has("sas/etl")).toBe(true);
    expect(summary.perModuleLineage.has("sas/scratch")).toBe(false);
  });
});

describe("buildCodeGraphSummary — cross-module dependencies", () => {
  it("records module → module edges for calls/imports (resolved targets only)", () => {
    const symbols = [
      sym("a", "svc/order/order.ts", "place", "function"),
      sym("b", "svc/pay/pay.ts", "charge", "function"),
    ];
    const edges: GraphEdge[] = [
      {
        kind: "calls",
        fromSymbolId: "a",
        toSymbolId: "b",
        toQualifiedName: "svc/pay/pay.ts::charge",
      },
    ];
    const summary = buildCodeGraphSummary(symbols, edges);
    expect(summary.crossModuleDeps.get("svc/order")?.has("svc/pay")).toBe(true);
    const rendered = renderCrossModuleDeps(summary);
    expect(rendered).toContain("CROSS-MODULE DEPENDENCIES");
    expect(rendered).toMatch(/svc\/order/);
  });

  it("does NOT record self-edges within the same module dir", () => {
    const symbols = [sym("a", "svc/order/a.ts", "a"), sym("b", "svc/order/b.ts", "b")];
    const edges: GraphEdge[] = [
      { kind: "calls", fromSymbolId: "a", toSymbolId: "b", toQualifiedName: "svc/order/b.ts::b" },
    ];
    const summary = buildCodeGraphSummary(symbols, edges);
    expect(summary.crossModuleDeps.size).toBe(0);
  });

  it("does NOT record unresolved (external) edges as cross-module deps", () => {
    const symbols = [sym("a", "svc/order/order.ts", "place")];
    const edges: GraphEdge[] = [
      { kind: "imports", fromSymbolId: "a", toSymbolId: null, toQualifiedName: "lodash" },
    ];
    const summary = buildCodeGraphSummary(symbols, edges);
    expect(summary.crossModuleDeps.size).toBe(0);
  });
});

describe("rendering budget bounds", () => {
  it("renderDatasetLineageChain returns empty string when no lineage", () => {
    const summary = buildCodeGraphSummary([], []);
    expect(renderDatasetLineageChain(summary)).toBe("");
  });

  it("renderCrossModuleDeps returns empty string when no deps", () => {
    const summary = buildCodeGraphSummary([], []);
    expect(renderCrossModuleDeps(summary)).toBe("");
  });

  it("honours maxChars / maxRows budgets in both renderers", () => {
    const symbols: GraphSymbol[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 100; i++) {
      symbols.push(sym(`s${i}`, `sas/m${i}/f.sas`));
      edges.push(ref(`s${i}`, `ds${i}`, "output"));
    }
    const summary = buildCodeGraphSummary(symbols, edges);
    const chain = renderDatasetLineageChain(summary, 300, 5);
    expect(chain.length).toBeLessThan(500);
    expect(chain).toMatch(/truncated/);
  });

  it("truncates renderCrossModuleDeps when over the char budget", () => {
    const symbols: GraphSymbol[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 50; i++) {
      symbols.push(sym(`a${i}`, `svc/mod${i}/a.ts`, "a", "function"));
      symbols.push(sym(`b${i}`, `svc/dep${i}/b.ts`, "b", "function"));
      edges.push({
        kind: "calls",
        fromSymbolId: `a${i}`,
        toSymbolId: `b${i}`,
        toQualifiedName: `svc/dep${i}/b.ts::b`,
      });
    }
    const summary = buildCodeGraphSummary(symbols, edges);
    const out = renderCrossModuleDeps(summary, 200, 100);
    expect(out).toMatch(/truncated/);
    expect(out.length).toBeLessThan(400);
  });
});
