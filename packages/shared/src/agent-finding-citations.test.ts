/**
 * Issue #1143 — one malformed citation discarded a whole agent's findings, and
 * a run whose agents failed read as a clean `completed`.
 */
import { describe, expect, it } from "vitest";
import {
  agentOutputSchema,
  analysisFailedAgents,
  analysisStatusLabel,
  collectSalvagedCitations,
  COMPLETED_WITH_ERRORS_LABEL,
  COMPLETED_WITH_WARNINGS_LABEL,
  deriveCapabilityReasons,
  salvageCitationList,
  salvageCitations,
} from "./analysis.js";

const goodDoc = { documentId: "doc-1234567890", chunkIndex: 0, filename: "spec.md" };
const goodCode = { filePath: "src/app.ts", startLine: 3, endLine: 9 };

/** The rejected shape from the A/B: no `documentId`, `symbolId: null`, `startLine: 0`. */
const malformed = { filePath: "src/app.ts", startLine: 0, endLine: 4, symbolId: null };

function output(findings: unknown[]) {
  return { agentKey: "code", summary: "s", findings, notes: [] };
}

function finding(title: string, citations: unknown) {
  return { category: "gap", severity: "medium", title, body: "b", citations };
}

describe("salvageCitations (#1143)", () => {
  it("keeps the valid citations and drops one that matches no union branch", () => {
    expect(salvageCitations([goodDoc, malformed, goodCode])).toEqual([goodDoc, goodCode]);
  });

  it("repairs a citation whose only fault is a null optional field", () => {
    expect(salvageCitations([{ ...goodCode, symbolId: null, snippet: null }])).toEqual([goodCode]);
  });

  it("drops non-object entries and cuts the list to its cap", () => {
    expect(salvageCitations(["x", 3, null])).toEqual([]);
    expect(salvageCitations(Array.from({ length: 25 }, () => goodCode))).toHaveLength(20);
  });

  it("passes undefined through for the schema's default", () => {
    expect(salvageCitations(undefined)).toBeUndefined();
  });
});

describe("salvageCitationList counts (#1143)", () => {
  it("counts a dropped citation, and a null-field repair that lost nothing", () => {
    expect(salvageCitationList([goodDoc, malformed, { ...goodCode, symbolId: null }])).toEqual({
      citations: [goodDoc, goodCode],
      dropped: 1,
      repaired: 1,
    });
  });

  it("reads citations: null as an empty list, a repair that lost nothing", () => {
    expect(salvageCitationList(null)).toEqual({ citations: [], dropped: 0, repaired: 1 });
  });

  it("wraps a lone valid citation in a list", () => {
    expect(salvageCitationList(goodDoc)).toEqual({
      citations: [goodDoc],
      dropped: 0,
      repaired: 1,
    });
  });

  it("wraps a lone invalid citation (or a bare string) and drops it", () => {
    expect(salvageCitationList(malformed)).toEqual({ citations: [], dropped: 1, repaired: 1 });
    expect(salvageCitationList("src/app.ts")).toEqual({ citations: [], dropped: 1, repaired: 1 });
  });

  it("counts every citation past the cap as dropped", () => {
    const s = salvageCitationList(Array.from({ length: 23 }, () => goodCode));
    expect(s.dropped).toBe(3);
    expect(s.repaired).toBe(0);
  });

  it("reports nothing for a clean list or an absent one", () => {
    expect(salvageCitationList([goodDoc])).toEqual({
      citations: [goodDoc],
      dropped: 0,
      repaired: 0,
    });
    expect(salvageCitationList(undefined)).toEqual({
      citations: undefined,
      dropped: 0,
      repaired: 0,
    });
  });
});

describe("collectSalvagedCitations (#1143)", () => {
  it("totals the salvage across every finding of an answer", () => {
    const answer = output([
      finding("one", [malformed, goodCode]),
      finding("two", null),
      finding("three", malformed),
      "not a finding",
    ]);
    expect(collectSalvagedCitations(answer)).toEqual({ dropped: 2, repaired: 2 });
  });

  it("is total over shapes that are not an answer", () => {
    for (const v of [null, undefined, "x", [], { findings: "x" }]) {
      expect(collectSalvagedCitations(v)).toEqual({ dropped: 0, repaired: 0 });
    }
  });
});

describe("agentOutputSchema with a malformed citation (#1143)", () => {
  it("keeps every finding, the offending one without that citation", () => {
    const parsed = agentOutputSchema.parse(
      output([finding("one", [malformed, goodCode]), finding("two", [goodDoc])]),
    );
    expect(parsed.findings.map((f) => f.title)).toEqual(["one", "two"]);
    expect(parsed.findings[0].citations).toEqual([goodCode]);
    expect(parsed.findings[1].citations).toEqual([goodDoc]);
  });

  it("still defaults absent citations to an empty list", () => {
    const parsed = agentOutputSchema.parse(output([finding("one", undefined)]));
    expect(parsed.findings[0].citations).toEqual([]);
  });

  it("keeps a finding whose citations are null or a lone object, rather than failing the agent", () => {
    const parsed = agentOutputSchema.parse(
      output([finding("null", null), finding("lone", goodDoc), finding("bad lone", malformed)]),
    );
    expect(parsed.findings.map((f) => [f.title, f.citations])).toEqual([
      ["null", []],
      ["lone", [goodDoc]],
      ["bad lone", []],
    ]);
  });
});

describe("analysisFailedAgents / analysisStatusLabel (#1143)", () => {
  const agents = [
    { agentKey: "document", status: "failed" },
    { agentKey: "code", status: "completed" },
    { agentKey: "code", status: "failed" },
    { agentKey: "code", status: "failed" },
    { agentKey: "database", status: "cancelled" },
    { agentKey: "synthesis", status: "completed" },
  ];
  const dropped = [{ agentKey: "document", count: 1 }];

  it("names each failed agent once, in order, and not a cancelled one", () => {
    expect(analysisFailedAgents(agents)).toEqual(["document", "code"]);
    expect(analysisFailedAgents(null)).toEqual([]);
  });

  it("labels a completed run with failed agents as completed with errors", () => {
    expect(analysisStatusLabel("completed", ["code"])).toBe(COMPLETED_WITH_ERRORS_LABEL);
    expect(analysisStatusLabel("completed", ["code"], dropped)).toBe(COMPLETED_WITH_ERRORS_LABEL);
    expect(COMPLETED_WITH_ERRORS_LABEL).toBe("completed with errors");
  });

  it("labels a completed run whose only fault is dropped citations as completed with warnings", () => {
    expect(analysisStatusLabel("completed", [], dropped)).toBe(COMPLETED_WITH_WARNINGS_LABEL);
    expect(COMPLETED_WITH_WARNINGS_LABEL).toBe("completed with warnings");
    expect(analysisStatusLabel("completed", [], [{ agentKey: "code", count: 0 }])).toBe(
      "completed",
    );
  });

  it("leaves a clean completion and every other status as stored", () => {
    expect(analysisStatusLabel("completed", [])).toBe("completed");
    expect(analysisStatusLabel("failed", ["code"])).toBe("failed");
    expect(analysisStatusLabel("running", ["code"], dropped)).toBe("running");
  });
});

describe("deriveCapabilityReasons citations-dropped (#1143)", () => {
  const base = {
    codeAnalysisRequested: false,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
  };

  it("reports dropped citations from any agent, with no agent gate", () => {
    expect(
      deriveCapabilityReasons({ ...base, droppedCitations: [{ agentKey: "document", count: 2 }] }),
    ).toEqual(["citations-dropped"]);
  });

  it("reports nothing when none were dropped", () => {
    expect(deriveCapabilityReasons(base)).toEqual([]);
    expect(
      deriveCapabilityReasons({ ...base, droppedCitations: [{ agentKey: "document", count: 0 }] }),
    ).toEqual([]);
  });
});
