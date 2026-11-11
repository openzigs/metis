/**
 * Issue #2233 — the run says what its limits left out: "analyzed 24 of 41
 * requirements", naming each one, and the findings an agent's answer lost.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  deriveCapabilityReasons,
  type AnalysisCapability,
  type FindingsLeftOutNotice,
  type RequirementsLeftOutNotice,
} from "@metis/shared";
import { AnalysisLimitsPanel } from "./analysis-limits-panel";
import { AnalysisCapabilityBanner } from "./analysis-capability-banner";

function capability(extra: {
  requirementsLeftOut?: RequirementsLeftOutNotice[];
  findingsLeftOut?: FindingsLeftOutNotice[];
}): AnalysisCapability {
  const base = {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    agentMode: "agentic" as const,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: [] as AnalysisCapability["skippedRepos"],
    ...extra,
  };
  return { ...base, reasons: deriveCapabilityReasons(base) };
}

const CODE_LEFT_OUT: RequirementsLeftOutNotice = {
  stage: "requirement-grounded-code",
  analysedCount: 24,
  totalCount: 26,
  leftOut: [
    { id: "REQ-025", excerpt: "Export the audit log as CSV." },
    { id: "REQ-026", excerpt: "Archive closed orders after a year." },
  ],
};

describe("AnalysisLimitsPanel (#2233)", () => {
  it("renders nothing when no limit left anything out", () => {
    const { container } = render(<AnalysisLimitsPanel capability={capability({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a null capability", () => {
    const { container } = render(<AnalysisLimitsPanel capability={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says how many of the requirements a step analyzed and names every one left out", () => {
    render(
      <AnalysisLimitsPanel capability={capability({ requirementsLeftOut: [CODE_LEFT_OUT] })} />,
    );
    const block = screen.getByTestId("requirements-left-out-requirement-grounded-code");
    expect(block).toHaveTextContent("Analyzed 24 of 26 requirements");
    expect(block).toHaveTextContent("2 requirements were left out");
    expect(block).toHaveTextContent("REQ-025");
    expect(block).toHaveTextContent("Export the audit log as CSV.");
    expect(block).toHaveTextContent("REQ-026");
  });

  it("names the governing-rule step separately", () => {
    render(
      <AnalysisLimitsPanel
        capability={capability({
          requirementsLeftOut: [
            {
              stage: "governing-applicability",
              analysedCount: 24,
              totalCount: 25,
              leftOut: [{ id: "REQ-025", excerpt: "x" }],
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("requirements-left-out-governing-applicability")).toHaveTextContent(
      "checked against the governing rules",
    );
  });

  it("names the agent, the counts and each finding that was not saved", () => {
    render(
      <AnalysisLimitsPanel
        capability={capability({
          findingsLeftOut: [
            {
              agentKey: "document",
              producedCount: 52,
              keptCount: 50,
              leftOutTitles: ["Retention period is undefined", "No owner for the export"],
            },
          ],
        })}
      />,
    );
    const block = screen.getByTestId("findings-left-out-document");
    expect(block).toHaveTextContent(
      "wrote 52 findings; the first 50 were kept and 2 were not saved",
    );
    expect(block).toHaveTextContent("Retention period is undefined");
    expect(block).toHaveTextContent("No owner for the export");
  });

  it("raises the capability banner for each limit", () => {
    render(
      <AnalysisCapabilityBanner
        capability={capability({
          requirementsLeftOut: [CODE_LEFT_OUT],
          findingsLeftOut: [
            { agentKey: "document", producedCount: 51, keptCount: 50, leftOutTitles: ["a"] },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("capability-reason-requirements-left-out")).toHaveTextContent(
      "some requirements were not analyzed",
    );
    expect(screen.getByTestId("capability-reason-findings-left-out")).toHaveTextContent(
      "the rest were not saved",
    );
  });
});
