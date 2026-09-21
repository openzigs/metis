/**
 * Issue #741 (Epic #727) — resume action on the capability banner.
 *
 * The banner (from #733) already lists degraded reasons; #741 adds an "Analyze
 * remaining repositories" action to the `repos-skipped-budget` reason. These
 * tests lock: the action only renders when repos were skipped AND a handler was
 * supplied, clicking invokes the handler, and it disables + relabels while a
 * resume is in flight.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { deriveCapabilityReasons, type AnalysisCapability } from "@metis/shared";
import { AnalysisCapabilityBanner } from "./analysis-capability-banner";

function capability(overrides: Partial<AnalysisCapability> = {}): AnalysisCapability {
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
    ...overrides,
  };
  return { ...base, reasons: deriveCapabilityReasons(base) };
}

const withSkipped = capability({
  skippedRepos: [
    { connectorId: "c2", label: "worker" },
    { connectorId: "c3", label: "api" },
  ],
});

describe("AnalysisCapabilityBanner resume action (#741)", () => {
  it("renders the resume action + names the skipped repos when budget dropped repos", () => {
    render(<AnalysisCapabilityBanner capability={withSkipped} onResumeRepos={() => {}} />);
    const reason = screen.getByTestId("capability-reason-repos-skipped-budget");
    expect(reason).toHaveTextContent("worker, api");
    expect(screen.getByTestId("resume-skipped-repos")).toBeEnabled();
  });

  it("invokes onResumeRepos when the action is clicked", () => {
    const onResume = vi.fn();
    render(<AnalysisCapabilityBanner capability={withSkipped} onResumeRepos={onResume} />);
    fireEvent.click(screen.getByTestId("resume-skipped-repos"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("disables + relabels the action while a resume is in flight", () => {
    render(<AnalysisCapabilityBanner capability={withSkipped} onResumeRepos={() => {}} resuming />);
    const btn = screen.getByTestId("resume-skipped-repos");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/Analyzing remaining repositories/i);
  });

  it("does not render the action when no handler is supplied (read-only viewer)", () => {
    render(<AnalysisCapabilityBanner capability={withSkipped} />);
    expect(screen.getByTestId("capability-reason-repos-skipped-budget")).toBeInTheDocument();
    expect(screen.queryByTestId("resume-skipped-repos")).not.toBeInTheDocument();
  });

  it("does not render the action when no repos were skipped", () => {
    // A different degradation (schema disabled) → banner shows, but no resume action.
    const other = capability({ databaseAnalysisRequested: true, schemaContextEnabled: false });
    render(<AnalysisCapabilityBanner capability={other} onResumeRepos={() => {}} />);
    expect(screen.queryByTestId("resume-skipped-repos")).not.toBeInTheDocument();
  });

  it("renders nothing for a fully-capable run", () => {
    const { container } = render(
      <AnalysisCapabilityBanner capability={capability()} onResumeRepos={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
