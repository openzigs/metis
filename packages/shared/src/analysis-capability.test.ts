/**
 * Issue #733 — pure capability-reason derivation shared by server + UI.
 * These assertions lock the exhaustive mapping so the two never drift.
 */
import { describe, expect, it } from "vitest";
import {
  type CapabilityReasonInput,
  deriveCapabilityReasons,
  isAnalysisDegraded,
} from "./analysis.js";

const fullyCapable: CapabilityReasonInput = {
  codeAnalysisRequested: true,
  databaseAnalysisRequested: true,
  codeGraphPresent: true,
  repoSourceIngested: true,
  fusedCodeRetrievalEnabled: true,
  schemaContextEnabled: true,
  agentMode: "agentic",
  quarantineFallbackUsed: false,
  skippedRepos: [],
};

describe("deriveCapabilityReasons", () => {
  it("returns no reasons for a fully-capable run", () => {
    expect(deriveCapabilityReasons(fullyCapable)).toEqual([]);
  });

  it("flags no-code-graph / source-not-ingested / agentic-unavailable / fused-disabled", () => {
    const reasons = deriveCapabilityReasons({
      ...fullyCapable,
      codeGraphPresent: false,
      repoSourceIngested: false,
      fusedCodeRetrievalEnabled: false,
      agentMode: "single-shot",
    });
    expect(reasons).toEqual([
      "no-code-graph",
      "source-not-ingested",
      "agentic-unavailable-no-requirements",
      "fused-code-retrieval-disabled",
      // schemaContextEnabled still true ⇒ no schema reason
    ]);
  });

  it("gates all code reasons behind codeAnalysisRequested", () => {
    const reasons = deriveCapabilityReasons({
      ...fullyCapable,
      codeAnalysisRequested: false,
      codeGraphPresent: false,
      repoSourceIngested: false,
      fusedCodeRetrievalEnabled: false,
      agentMode: "single-shot",
    });
    expect(reasons).toEqual([]);
  });

  it("does not assert agentic-unavailable pre-run (agentMode omitted)", () => {
    const reasons = deriveCapabilityReasons({
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
      codeGraphPresent: true,
      repoSourceIngested: true,
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    });
    expect(reasons).not.toContain("agentic-unavailable-no-requirements");
    expect(reasons).toEqual([]);
  });

  it("flags schema-context-disabled only when the database agent is requested", () => {
    expect(deriveCapabilityReasons({ ...fullyCapable, schemaContextEnabled: false })).toContain(
      "schema-context-disabled",
    );
    expect(
      deriveCapabilityReasons({
        ...fullyCapable,
        databaseAnalysisRequested: false,
        schemaContextEnabled: false,
      }),
    ).not.toContain("schema-context-disabled");
  });

  it("flags quarantine-fallback and repos-skipped-budget", () => {
    const reasons = deriveCapabilityReasons({
      ...fullyCapable,
      quarantineFallbackUsed: true,
      skippedRepos: [{ connectorId: "c3", label: "worker" }],
    });
    expect(reasons).toContain("quarantine-fallback-used");
    expect(reasons).toContain("repos-skipped-budget");
  });

  describe("#768 — single-shot has two very different causes", () => {
    it("reports agentic-unavailable-no-requirements when the operator supplied no new requirements", () => {
      const reasons = deriveCapabilityReasons({
        ...fullyCapable,
        agentMode: "single-shot",
        newRequirementsProvided: false,
      });
      expect(reasons).toContain("agentic-unavailable-no-requirements");
      expect(reasons).not.toContain("new-requirements-not-analyzed");
    });

    it("reports new-requirements-not-analyzed instead when the operator DID supply them", () => {
      const reasons = deriveCapabilityReasons({
        ...fullyCapable,
        agentMode: "single-shot",
        newRequirementsProvided: true,
      });
      expect(reasons).toContain("new-requirements-not-analyzed");
      // Claiming "no requirements were found" would be a lie: the user typed some.
      expect(reasons).not.toContain("agentic-unavailable-no-requirements");
    });

    it("reports neither once the new requirements actually drove a non-single-shot run", () => {
      const reasons = deriveCapabilityReasons({
        ...fullyCapable,
        agentMode: "agentic",
        newRequirementsProvided: true,
      });
      expect(reasons).toEqual([]);
    });
  });
});

describe("isAnalysisDegraded", () => {
  it("is false for null and for empty reasons", () => {
    expect(isAnalysisDegraded(null)).toBe(false);
    expect(isAnalysisDegraded({ reasons: [] })).toBe(false);
  });
  it("is true when any reason is present", () => {
    expect(isAnalysisDegraded({ reasons: ["no-code-graph"] })).toBe(true);
  });
});
