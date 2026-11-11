/**
 * Issue #2233 — a run whose requirement or finding limit left something out
 * carries a capability reason, so it never reads as a clean completion.
 */
import { describe, expect, it } from "vitest";
import { deriveCapabilityReasons, type CapabilityReasonInput } from "./analysis.js";

const CAPABLE_RUN: CapabilityReasonInput = {
  codeAnalysisRequested: true,
  databaseAnalysisRequested: false,
  codeGraphPresent: true,
  repoSourceIngested: true,
  fusedCodeRetrievalEnabled: true,
  schemaContextEnabled: true,
  agentMode: "agentic",
};

describe("#2233 — limit reasons", () => {
  it("a stage that left requirements out raises requirements-left-out", () => {
    expect(
      deriveCapabilityReasons({
        ...CAPABLE_RUN,
        requirementsLeftOut: [
          {
            stage: "requirement-grounded-code",
            analysedCount: 24,
            totalCount: 25,
            leftOut: [{ id: "REQ-025", excerpt: "Export the audit log." }],
          },
        ],
      }),
    ).toEqual(["requirements-left-out"]);
  });

  it("a notice with nothing left out raises nothing", () => {
    expect(
      deriveCapabilityReasons({
        ...CAPABLE_RUN,
        requirementsLeftOut: [
          {
            stage: "governing-applicability",
            analysedCount: 3,
            totalCount: 3,
            leftOut: [],
          },
        ],
        findingsLeftOut: [
          { agentKey: "document", producedCount: 50, keptCount: 50, leftOutTitles: [] },
        ],
      }),
    ).toEqual([]);
  });

  it("an agent whose findings were cut raises findings-left-out, whatever agents ran", () => {
    expect(
      deriveCapabilityReasons({
        ...CAPABLE_RUN,
        codeAnalysisRequested: false,
        findingsLeftOut: [
          { agentKey: "document", producedCount: 52, keptCount: 50, leftOutTitles: ["a", "b"] },
        ],
      }),
    ).toEqual(["findings-left-out"]);
  });
});
