/**
 * Issue #1143 — one malformed citation discarded a whole agent's findings, and
 * a run whose agents failed read as a clean `completed`.
 */
import { describe, expect, it } from "vitest";
import {
  agentOutputSchema,
  analysisFailedAgents,
  analysisStatusLabel,
  COMPLETED_WITH_ERRORS_LABEL,
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

  it("passes a non-array through for the schema to judge", () => {
    expect(salvageCitations(undefined)).toBeUndefined();
    expect(salvageCitations("nope")).toBe("nope");
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

  it("still rejects a citations value that is not a list", () => {
    expect(agentOutputSchema.safeParse(output([finding("one", "src/app.ts")])).success).toBe(false);
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

  it("names each failed agent once, in order, and not a cancelled one", () => {
    expect(analysisFailedAgents(agents)).toEqual(["document", "code"]);
    expect(analysisFailedAgents(null)).toEqual([]);
  });

  it("labels a completed run with failed agents as completed with errors", () => {
    expect(analysisStatusLabel("completed", ["code"])).toBe(COMPLETED_WITH_ERRORS_LABEL);
    expect(COMPLETED_WITH_ERRORS_LABEL).toBe("completed with errors");
  });

  it("leaves a clean completion and every other status as stored", () => {
    expect(analysisStatusLabel("completed", [])).toBe("completed");
    expect(analysisStatusLabel("failed", ["code"])).toBe("failed");
    expect(analysisStatusLabel("running", ["code"])).toBe("running");
  });
});
