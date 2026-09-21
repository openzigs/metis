/**
 * Issue #733 — the degraded-mode capability banner renders actionable copy for
 * a degraded run and nothing for a fully-capable run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AnalysisCapability } from "@metis/shared";
import { AnalysisCapabilityBanner } from "@/components/analysis/analysis-capability-banner";

const base: AnalysisCapability = {
  codeAnalysisRequested: true,
  databaseAnalysisRequested: false,
  codeGraphPresent: false,
  agentMode: "single-shot",
  repoSourceIngested: false,
  fusedCodeRetrievalEnabled: false,
  schemaContextEnabled: false,
  quarantineFallbackUsed: false,
  skippedRepos: [],
  reasons: ["no-code-graph", "source-not-ingested", "agentic-unavailable-no-requirements"],
};

afterEach(cleanup);

describe("AnalysisCapabilityBanner", () => {
  it("renders nothing when capability is null", () => {
    const { container } = render(<AnalysisCapabilityBanner capability={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a fully-capable run (no reasons)", () => {
    const { container } = render(
      <AnalysisCapabilityBanner capability={{ ...base, reasons: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains each degradation reason in plain, actionable language", () => {
    render(<AnalysisCapabilityBanner capability={base} />);
    expect(screen.getByTestId("analysis-capability-banner")).toBeInTheDocument();
    expect(screen.getByText(/no code graph has been built for this project/i)).toBeInTheDocument();
    expect(screen.getByText(/Repository source code has not been ingested/i)).toBeInTheDocument();
    expect(screen.getByText(/no requirements were extracted/i)).toBeInTheDocument();
    // Actionable next step is present.
    expect(screen.getByText(/Build the code graph/i)).toBeInTheDocument();
  });

  it("names the skipped repositories in the budget reason", () => {
    render(
      <AnalysisCapabilityBanner
        capability={{
          ...base,
          reasons: ["repos-skipped-budget"],
          skippedRepos: [{ connectorId: "c3", label: "worker" }],
        }}
      />,
    );
    expect(screen.getByTestId("capability-reason-repos-skipped-budget")).toHaveTextContent(
      "worker",
    );
  });
});
