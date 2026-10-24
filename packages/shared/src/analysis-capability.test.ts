/**
 * Issue #733 — pure capability-reason derivation shared by server + UI.
 * These assertions lock the exhaustive mapping so the two never drift.
 */
import { describe, expect, it } from "vitest";
import {
  type AnalysisCapabilityReason,
  type CapabilityReasonInput,
  codeInvestigationContinueOffered,
  deriveCapabilityReasons,
  MAX_CODE_INVESTIGATION_CONTINUATIONS,
  isAnalysisDegraded,
  readDroppedCitations,
} from "./analysis.js";

describe("readDroppedCitations (#1155)", () => {
  it("keeps only well-formed entries with a positive whole count", () => {
    expect(
      readDroppedCitations([
        { agentKey: "code", count: 3 },
        null,
        "document",
        { agentKey: 5, count: 1 },
        { agentKey: "business", count: "2" },
        { agentKey: "database", count: -1 },
        { agentKey: "document", count: 1.5 },
        { agentKey: "", count: 1 },
      ]),
    ).toEqual([{ agentKey: "code", count: 3 }]);
  });

  it("reads anything that is not a list as no drops", () => {
    for (const v of [undefined, null, "lots", 4, { agentKey: "code", count: 1 }]) {
      expect(readDroppedCitations(v)).toEqual([]);
    }
  });
});

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

describe("#1001 — code investigation cut short by its budget", () => {
  it("flags code-investigation-cut-short when the code pass exhausted its budget", () => {
    expect(deriveCapabilityReasons({ ...fullyCapable, codeInvestigationCutShort: true })).toEqual([
      "code-investigation-cut-short",
    ]);
  });

  it("stays silent on a pass that finished within budget", () => {
    expect(deriveCapabilityReasons({ ...fullyCapable, codeInvestigationCutShort: false })).toEqual(
      [],
    );
  });

  it("is gated behind codeAnalysisRequested", () => {
    expect(
      deriveCapabilityReasons({
        ...fullyCapable,
        codeAnalysisRequested: false,
        codeInvestigationCutShort: true,
      }),
    ).toEqual([]);
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

/**
 * #1131 — #706 run 8: Continue was offered on runs whose remaining requirements
 * all carried a "Could not verify" finding (the agent reached them; the code
 * did not settle them), and on a run in which every requirement was grounded.
 * A larger budget changes neither.
 */
describe("#1131 — unreached versus inconclusive requirements", () => {
  const cutShort = (gap: CapabilityReasonInput["codeInvestigationUnreached"]) =>
    deriveCapabilityReasons({
      ...fullyCapable,
      codeInvestigationCutShort: true,
      codeInvestigationUnreached: gap,
    });

  it("offers cut-short when the pass left requirements unreached", () => {
    expect(cutShort({ unreached: 3, inconclusive: 2, total: 19 })).toEqual([
      "code-investigation-cut-short",
    ]);
  });

  it("names a run whose only gaps are inconclusive as inconclusive, not cut short", () => {
    expect(cutShort({ unreached: 0, inconclusive: 3, total: 19 })).toEqual([
      "code-investigation-inconclusive",
    ]);
  });

  it("raises nothing when every requirement has a grounded verdict", () => {
    expect(cutShort({ unreached: 0, inconclusive: 0, total: 5 })).toEqual([]);
  });

  it("keeps the old reason for a record that carries no counts", () => {
    expect(cutShort(undefined)).toEqual(["code-investigation-cut-short"]);
  });

  it("is gated behind codeAnalysisRequested like every code reason", () => {
    expect(
      deriveCapabilityReasons({
        ...fullyCapable,
        codeAnalysisRequested: false,
        codeInvestigationCutShort: true,
        codeInvestigationUnreached: { unreached: 0, inconclusive: 3, total: 3 },
      }),
    ).toEqual([]);
  });
});

describe("#1131 — codeInvestigationContinueOffered", () => {
  const base = {
    reasons: ["code-investigation-cut-short"] as AnalysisCapabilityReason[],
    codeInvestigationContinuations: 0,
  };
  it("is offered while the run is cut short and under the limit", () => {
    expect(codeInvestigationContinueOffered(base)).toBe(true);
  });
  it("is not offered for an inconclusive-only or fully grounded run", () => {
    expect(
      codeInvestigationContinueOffered({ ...base, reasons: ["code-investigation-inconclusive"] }),
    ).toBe(false);
    expect(codeInvestigationContinueOffered({ ...base, reasons: [] })).toBe(false);
  });
  it("is not offered past the continuation limit", () => {
    expect(
      codeInvestigationContinueOffered({
        ...base,
        codeInvestigationContinuations: MAX_CODE_INVESTIGATION_CONTINUATIONS,
      }),
    ).toBe(false);
  });
  it("is not offered without a capability record", () => {
    expect(codeInvestigationContinueOffered(null)).toBe(false);
  });
});
